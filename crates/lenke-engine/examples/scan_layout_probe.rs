//! Probe: would a different column layout make predicate scans faster — and can
//! that layout survive mutation?
//!
//! The engine's typed numeric scan is (`exec.rs`, the `Column::Num` fast path):
//!
//! ```text
//! ids.iter().copied()
//!    .filter(|&id| present[id as usize] && num_pred(op, data[id as usize], t))
//!    .collect()
//! ```
//!
//! Three things in that line are hostile to a vectorizing compiler, and none of
//! them is the value data (`data` is already a dense `Vec<f64>`):
//!
//! 1. it GATHERS — `data[id]` walks a label bucket, not memory order;
//! 2. presence is a BYTE and a BRANCH — `present: Vec<bool>` is one byte per row,
//!    so the gate costs 8x the traffic it needs and mispredicts on mixed data;
//! 3. the output is a materialized `Vec<u32>` of ids, so there is nowhere for a
//!    comparison MASK to go even if one were produced.
//!
//! An earlier campaign concluded "SIMD is weak here". That measurement was taken
//! against this shape, on the now-deleted row engine — which makes it evidence
//! about the loop, not about SIMD. This probe re-derives the question on the
//! CURRENT columnar model by building the alternative layouts standalone and
//! pricing them against each other.
//!
//! THE BINDING CONSTRAINT IS MUTATION. A layout that only pays on immutable
//! blocks is no use to us: lenke's store is mutable (in-place `SET`, undo logs,
//! transactions), unlike the data-lake formats this idea comes from — BtrBlocks
//! and friends compress immutable blocks, and say so. So every layout here is
//! priced twice: once for the scan, and once for what a point write costs to
//! maintain it (`maintain` below). A scan win that a write cannot afford is not a
//! win; that is the whole reason bit-packing the values is NOT a candidate here.
//!
//! Native only. Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml \
//!     --example scan_layout_probe
//!
//! Env: `BENCH_REPS` (samples, min reported), `BENCH_N` (rows; swept anyway).
//!
//! MEASURED (min of 7, release, x86-64-v3; keep these next to the code, per CLAUDE.md).
//! Microseconds for one predicate scan over a numeric column, 10% of rows absent:
//!
//! ```text
//!   1,000,000 rows, uniform        A gather   A' dyn  B dense   C mask   C' ids   D +SMA
//!     1% selective                   1308.9   1446.9   1177.0    189.8    207.2    197.3
//!    10% selective                   1957.4   2157.5   1825.6    189.0    280.7    197.3
//!    50% selective                   4261.2   5024.6   4300.2    189.4    439.2    197.4
//!
//!   1,000,000 rows, clustered      A gather   A' dyn  B dense   C mask   C' ids   D +SMA
//!     1% selective                   1198.4   1381.7   1104.1    188.1    200.5      4.2
//!    10% selective                   1179.4   1391.3   1042.5    170.8    217.5     27.3
//!    50% selective                   1201.9   1862.6   1236.8    175.9    372.2     98.0
//!
//!   one point write                 byte gate 0.4ns · bitset 0.6ns · SMA widen 1.3ns
//!   one block SMA rebuild           54.3us / 65,536 rows (~0.8ns per row)
//! ```
//!
//! READ IT THIS WAY:
//!
//! - **The gather is not the problem.** B (memory order, same gate) barely beats A,
//!   and loses at 50%. Dropping the indexed read buys nothing on its own.
//! - **The gate and the output are.** C' — the FAIR comparison, since it hands back
//!   the same `Vec<u32>` A does — is 6.3x to 9.7x faster, and the margin GROWS with
//!   selectivity because A pays to grow a vector while C' sizes it once from a
//!   popcount. C alone (mask, no materialization) is flat in selectivity at ~189us,
//!   which is what a branch-free loop over dense memory costs and nothing more.
//! - **The per-row operator dispatch is real.** A' — the engine's actual shape, with
//!   `num_pred(op, ..)` resolving a runtime op per row — is 10-18% worse than A,
//!   reaching 55% at 50% selectivity. Hoisting the operator out of the loop is an
//!   independent, much cheaper win than any of the above.
//! - **Block skipping is the only ASYMPTOTIC win, and it needs clustered data.** On a
//!   column correlated with insertion order (a timestamp, an append-ordered score) D
//!   is 285x faster than today at 1% selectivity. On uniform data it cannot skip a
//!   single block and costs ~4% for asking — which is the honest price of carrying it.
//! - **All of it survives mutation**, which was the condition for caring: a bitset
//!   gate costs 0.2ns more per write than the byte it replaces, and an SMA widens in
//!   1.3ns. An SMA only ever widens, so a stale one is too PERMISSIVE — it loses
//!   selectivity, never correctness — and a full block rebuild is ~0.8ns/row if we
//!   ever want to tighten one.
//!
//! WHAT THIS DOES NOT SAY. These are standalone arrays, not the engine: integrating
//! any of it has to carry `Gen` columns (boxed `Value`, outside all of this), the
//! present-null/absent distinction, and consumers that want ids rather than masks.
//! Variant A is also the baseline's BEST case — its id list is every node in order,
//! where a real label bucket may be a scattered subset — so the measured gap is if
//! anything conservative. And no explicit SIMD appears here at all: C is plain
//! branch-free scalar code, so whether intrinsics add anything ON TOP is still open.

#[path = "support/harness.rs"]
#[allow(dead_code)] // the shared harness serves every bench; a probe uses part of it
mod harness;

use harness::{best_us, section, Cfg, Lcg};
use std::hint::black_box;

/// One column, in every layout under test. Built once per (rows, shape) fixture.
struct Fixture {
    /// The values, dense and in id order — what every layout scans.
    data: Vec<f64>,
    /// Today's gate: one BYTE per row.
    present_bytes: Vec<bool>,
    /// The same gate as a bitset: one BIT per row, 64 rows per word.
    present_bits: Vec<u64>,
    /// The id list a label scan walks. Ascending, but an INDEXED read either way.
    ids: Vec<u32>,
    /// Per-block (min, max) over present values — a small materialized aggregate.
    /// `None` for a block with no present value.
    sma: Vec<Option<(f64, f64)>>,
}

const BLOCK: usize = 64 * 1024;

/// How the values are distributed across the column. This is the difference
/// between a block skip that works and one that never fires, so it is a fixture
/// axis rather than an assumption.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// Values uniform over the whole range: a block's min/max spans everything, so
    /// no block can ever be skipped. The worst case for SMAs, and the honest
    /// default for a property with no correlation to insertion order.
    Uniform,
    /// Values correlated with insertion order (an id, a timestamp, an
    /// append-ordered score). Each block covers a narrow range, so a selective
    /// predicate touches few blocks. The case SMAs are FOR.
    Clustered,
}

fn build(rows: usize, shape: Shape, absent_pct: u32) -> Fixture {
    let mut rng = Lcg::seeded();
    let mut data = Vec::with_capacity(rows);
    let mut present_bytes = Vec::with_capacity(rows);
    let mut present_bits = vec![0u64; rows.div_ceil(64)];

    for i in 0..rows {
        let v = match shape {
            Shape::Uniform => f64::from(rng.next(1_000_000)),
            // Monotonic with a little local jitter, like a timestamp column.
            Shape::Clustered => (i as f64) + f64::from(rng.next(64)),
        };
        let present = rng.next(100) >= absent_pct;
        data.push(v);
        present_bytes.push(present);

        if present {
            present_bits[i / 64] |= 1u64 << (i % 64);
        }
    }

    let sma = data
        .chunks(BLOCK)
        .enumerate()
        .map(|(b, chunk)| {
            let base = b * BLOCK;
            chunk
                .iter()
                .enumerate()
                .filter(|(k, _)| present_bytes[base + k])
                .fold(None, |acc: Option<(f64, f64)>, (_, &v)| {
                    Some(acc.map_or((v, v), |(lo, hi)| (lo.min(v), hi.max(v))))
                })
        })
        .collect();

    Fixture {
        ids: (0..rows as u32).collect(),
        data,
        present_bytes,
        present_bits,
        sma,
    }
}

/// A: today's shape — gather through an id list, byte gate, collect ids.
fn scan_gather_bytes(f: &Fixture, t: f64) -> Vec<u32> {
    f.ids
        .iter()
        .copied()
        .filter(|&id| f.present_bytes[id as usize] && f.data[id as usize] > t)
        .collect()
}

/// The engine's comparison operator, reproduced: `exec.rs` calls `num_pred(op, x, t)`
/// with a RUNTIME `op`, i.e. a six-way match per row unless the compiler unswitches
/// the loop. Variant A hardcodes `>`, which flatters the baseline; A' keeps the
/// dispatch so the baseline is the one the engine actually runs.
#[derive(Clone, Copy)]
// The unused arms are the point: the dispatch has to have somewhere to go, or the
// compiler folds the match away and the baseline stops being the engine's.
#[allow(dead_code)]
enum Op {
    Gt,
    Ge,
    Lt,
    Le,
    Eq,
    Ne,
}

#[inline]
fn num_pred(op: Op, x: f64, t: f64) -> bool {
    match op {
        Op::Gt => x > t,
        Op::Ge => x >= t,
        Op::Lt => x < t,
        Op::Le => x <= t,
        Op::Eq => x == t,
        Op::Ne => x != t,
    }
}

/// A': A with the per-row operator dispatch the engine has. `op` is opaque to the
/// optimizer here (it arrives through a `black_box`), matching a plan whose operator
/// is known only at run time.
fn scan_gather_dyn(f: &Fixture, op: Op, t: f64) -> Vec<u32> {
    f.ids
        .iter()
        .copied()
        .filter(|&id| f.present_bytes[id as usize] && num_pred(op, f.data[id as usize], t))
        .collect()
}

/// B: drop the gather — scan in memory order, keep the byte gate and the id output.
fn scan_dense_bytes(f: &Fixture, t: f64) -> Vec<u32> {
    (0..f.data.len() as u32)
        .filter(|&i| f.present_bytes[i as usize] && f.data[i as usize] > t)
        .collect()
}

/// C: dense scan, BITSET gate, MASK output. Branch-free per row: the comparison
/// becomes a bit, 64 rows are ANDed against the presence word at once, and the
/// result is a mask a consumer can iterate or intersect — never a `Vec` of ids.
fn scan_dense_mask(f: &Fixture, t: f64) -> Vec<u64> {
    let rows = f.data.len();
    let mut out = vec![0u64; rows.div_ceil(64)];

    for (w, slot) in out.iter_mut().enumerate() {
        let base = w * 64;
        let lanes = 64.min(rows - base);
        let mut m = 0u64;

        // Branch-free: the predicate's truth becomes a shifted bit, so there is
        // nothing for the branch predictor to get wrong and nothing stopping the
        // compiler from widening this.
        for k in 0..lanes {
            m |= u64::from(f.data[base + k] > t) << k;
        }

        *slot = m & f.present_bits[w];
    }

    out
}

/// D: C, but consult the per-block SMA first and skip blocks whose range cannot
/// satisfy the predicate. The only variant that does asymptotically less work
/// rather than the same work faster.
fn scan_sma_mask(f: &Fixture, t: f64) -> Vec<u64> {
    let rows = f.data.len();
    let mut out = vec![0u64; rows.div_ceil(64)];

    for (b, sma) in f.sma.iter().enumerate() {
        // No present value, or every value at or below the bound: nothing here can
        // pass `> t`, so the block is not read at all.
        match sma {
            None => continue,
            Some((_, hi)) if *hi <= t => continue,
            _ => {}
        }

        let base = b * BLOCK;
        let end = (base + BLOCK).min(rows);

        let (first, last) = (base / 64, end.div_ceil(64));

        for (w, slot) in out[first..last].iter_mut().enumerate() {
            let wbase = (first + w) * 64;
            let lanes = 64.min(rows - wbase);
            let mut m = 0u64;

            for k in 0..lanes {
                m |= u64::from(f.data[wbase + k] > t) << k;
            }

            *slot = m & f.present_bits[first + w];
        }
    }

    out
}

/// C', the honest end-to-end comparison: build the mask, then MATERIALIZE the ids
/// from it — because today's consumer wants a `Vec<u32>`, and comparing a mask
/// against a materialized vector prices only half the work. Iterating set bits
/// with `trailing_zeros` touches only the matches, so the cost tracks the OUTPUT
/// size rather than the column size.
fn scan_dense_mask_ids(f: &Fixture, t: f64) -> Vec<u32> {
    let mask = scan_dense_mask(f, t);
    let mut out = Vec::with_capacity(popcount(&mask));

    for (w, &word) in mask.iter().enumerate() {
        let mut bits = word;

        while bits != 0 {
            let k = bits.trailing_zeros();
            out.push((w * 64) as u32 + k);
            bits &= bits - 1;
        }
    }

    out
}

fn popcount(mask: &[u64]) -> usize {
    mask.iter().map(|w| w.count_ones() as usize).sum()
}

/// What ONE point write costs each structure. This is the half that decides
/// whether any of the above is adoptable: the store mutates, so a gate or summary
/// that cannot be updated in place has to be rebuilt, and a rebuild per write is
/// not a structure, it is a stall.
fn maintenance(cfg: &Cfg, f: &Fixture) {
    let rows = f.data.len();
    let mut rng = Lcg::seeded();
    let targets: Vec<usize> = (0..10_000)
        .map(|_| rng.next(rows as u32) as usize)
        .collect();

    let mut bytes = f.present_bytes.clone();
    let us = best_us(cfg.reps, || {
        for (n, &i) in targets.iter().enumerate() {
            bytes[i] = n % 2 == 0;
        }
        bytes[0]
    });
    println!(
        "  {:<34} {:>9.1} ns/write",
        "byte gate: set present",
        us * 1e3 / 10_000.0
    );

    let mut bits = f.present_bits.clone();
    let us = best_us(cfg.reps, || {
        for (n, &i) in targets.iter().enumerate() {
            let (w, b) = (i / 64, i % 64);

            if n % 2 == 0 {
                bits[w] |= 1u64 << b;
            } else {
                bits[w] &= !(1u64 << b);
            }
        }
        bits[0]
    });
    println!(
        "  {:<34} {:>9.1} ns/write",
        "bitset gate: set/clear bit",
        us * 1e3 / 10_000.0
    );

    // An SMA only ever WIDENS on a write, which is why it survives mutation: a
    // stale one is too wide, never too narrow, so it costs selectivity and never
    // correctness. (A delete or a shrinking update leaves it conservative until
    // someone chooses to rebuild.)
    let mut sma = f.sma.clone();
    let us = best_us(cfg.reps, || {
        for (n, &i) in targets.iter().enumerate() {
            let v = f.data[i] + n as f64;
            let e = &mut sma[i / BLOCK];
            *e = Some(e.map_or((v, v), |(lo, hi)| (lo.min(v), hi.max(v))));
        }
        sma[0]
    });
    println!(
        "  {:<34} {:>9.1} ns/write",
        "SMA: widen block min/max",
        us * 1e3 / 10_000.0
    );

    // And the escape hatch, priced: recomputing ONE block's summary from scratch.
    // Amortized over a block's worth of writes this is the cost of never letting
    // an SMA drift, if we ever wanted that.
    let us = best_us(cfg.reps, || {
        let base = 0;
        let end = BLOCK.min(rows);
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;

        for i in base..end {
            if f.present_bytes[i] {
                lo = lo.min(f.data[i]);
                hi = hi.max(f.data[i]);
            }
        }

        (lo, hi)
    });
    println!(
        "  {:<34} {:>9.1} us/block ({} rows)",
        "SMA: rebuild one block", us, BLOCK
    );
}

fn run_shape(cfg: &Cfg, rows: usize, shape: Shape, name: &str) {
    // 10% of rows carry no value — a realistic sparse property, and enough for the
    // byte-vs-bit gate difference to be about more than cache lines.
    let f = build(rows, shape, 10);

    println!(
        "\n  {rows} rows, {name}, 10% absent   {:>8} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "A gather", "A' dyn", "B dense", "C mask", "C' ids", "D +SMA"
    );

    for sel_pct in [1u32, 10, 50] {
        // The bound that admits `sel_pct` percent of the value range.
        let t = match shape {
            Shape::Uniform => f64::from(1_000_000 - 1_000_000 / 100 * sel_pct),
            Shape::Clustered => (rows - rows / 100 * sel_pct as usize) as f64,
        };

        let a = best_us(cfg.reps, || scan_gather_bytes(&f, t));
        let a_dyn = best_us(cfg.reps, || scan_gather_dyn(&f, black_box(Op::Gt), t));
        let b = best_us(cfg.reps, || scan_dense_bytes(&f, t));
        let c = best_us(cfg.reps, || scan_dense_mask(&f, t));
        let c_ids = best_us(cfg.reps, || scan_dense_mask_ids(&f, t));
        let d = best_us(cfg.reps, || scan_sma_mask(&f, t));

        // Every variant must agree on the answer, or the comparison is theatre.
        let rows_a = scan_gather_bytes(&f, t).len();
        let rows_c = popcount(&scan_dense_mask(&f, t));
        let rows_d = popcount(&scan_sma_mask(&f, t));
        assert_eq!(rows_a, rows_c, "mask scan disagrees with the gather scan");
        assert_eq!(rows_a, rows_d, "SMA scan disagrees with the gather scan");
        assert_eq!(
            scan_gather_bytes(&f, t),
            scan_dense_mask_ids(&f, t),
            "materialized ids disagree with the gather scan"
        );

        println!(
            "  {:>3}% selective ({rows_a} rows){:>9.1} {:>8.1} {:>8.1} {:>8.1} {:>8.1} {:>8.1}",
            sel_pct,
            black_box(a),
            black_box(a_dyn),
            black_box(b),
            black_box(c),
            black_box(c_ids),
            black_box(d)
        );
    }
}

fn main() {
    let cfg = Cfg::from_env();

    section("scan layout: predicate over a numeric column (us, min of reps)");
    println!(
        "  A = today (gather + byte gate + id vec) · A' = A with the engine's per-row op dispatch\n  B = dense scan\n  \
         C = dense + bitset gate + mask out      · C' = C then materialize ids\n  \
         D = C + per-64k-block min/max skip"
    );

    // Sweep the cache transition CLAUDE.md calls out rather than trusting a point.
    for rows in [cfg.scale.unwrap_or(200_000), 1_000_000] {
        for (shape, name) in [
            (Shape::Uniform, "uniform (SMA cannot skip)"),
            (Shape::Clustered, "clustered (SMA can skip)"),
        ] {
            run_shape(&cfg, rows, shape, name);
        }
    }

    section("maintenance: what one point write costs each structure");
    let f = build(1_000_000, Shape::Uniform, 10);
    maintenance(&cfg, &f);
}
