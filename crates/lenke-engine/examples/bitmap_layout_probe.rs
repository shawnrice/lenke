//! Probe: can a predicate become BITMAP ARITHMETIC instead of value comparisons —
//! and does that finally reach the vector units?
//!
//! `scan_layout_probe` established that today's scan loses to a branch-free dense
//! pass by 6-10x, and that the losses are the byte-wide presence gate and the
//! materialized id vector rather than the gather. That probe stopped at scalar
//! code. This one goes after the layouts where the COMPARISON ITSELF disappears.
//!
//! Two structures, both from the data-lake compression literature, both of which
//! decompose a column into a stack of bitmaps:
//!
//! **Recursive Frequency Encoding (RFE).** BtrBlocks' Frequency Encoding stores a
//! column as (top value, bitmap of where it occurs, exceptions). Applied
//! RECURSIVELY to the exceptions — peel the most frequent remaining value, emit
//! its bitmap, recurse — a column becomes `k` disjoint bitmaps plus a small
//! exception tail. The paper's motivation is that real columns are shaped this
//! way: "often a column only has one dominant frequent value, with the next most
//! frequent values occurring exponentially less often."
//!
//! The consequence for QUERIES is the interesting part. `x = v` for a peeled value
//! is not a scan at all — it is a pointer to that value's bitmap, O(1), zero
//! comparisons. `x > t` is the OR of the bitmaps whose value passes, i.e. a few
//! passes of pure word arithmetic. The tree of frequencies has turned into bitmaps,
//! and bitmaps are what SIMD is actually good at.
//!
//! **Bit-Sliced Index (BSI).** The other decomposition: store bit `b` of every
//! value as its own bitmap, so a B-bit column becomes B bitmaps. A range predicate
//! becomes the standard MSB-to-LSB comparison circuit — `gt |= eq & slice`,
//! `eq &= !slice` — which is nothing but AND/OR/ANDNOT over words, for every row at
//! once. This is the in-memory cousin of the BitWeaving/ByteSlice line that the
//! BtrBlocks paper cites in related work, and unlike RFE it does not care how many
//! distinct values there are.
//!
//! Both are priced against the branch-free dense scan (the winner of the previous
//! probe), across the axis that decides between them — value cardinality — and
//! both are priced for MUTATION, because the store mutates and a structure that
//! cannot be maintained is a curiosity.
//!
//! On doubles: a BSI needs an order-preserving integer view. For non-negative
//! IEEE-754 doubles the raw bit pattern already orders correctly, and the general
//! case is the standard flip (`bits ^ (((bits as i64) >> 63) as u64 | 1 << 63)`).
//! The fixtures here use integer-valued doubles — ages, counts, scores, codes,
//! which is what the categorical and dominant cases look like in real data — so the
//! quantization is exact and the comparison is about layout, not about rounding.
//!
//! Native only. Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml \
//!     --example bitmap_layout_probe
//!
//! Env: `BENCH_REPS` (samples, min reported), `BENCH_N` (rows).
//!
//! MEASURED (1M rows, 10% absent, min of 7, release, x86-64-v3). Microseconds per
//! predicate; `dense` is the branch-free f64 scan, i.e. the best thing we had.
//!
//! ```text
//!   dominant (70% one value)      dense     RFE     BSI     f64 7812 KB
//!     = top value (629,636)       197.4     1.6    26.4     RFE 1240 KB (8 layers, 18k exc)
//!     = rare value (8)            197.5     4.6    26.3     BSI 1464 KB (12 slices)
//!     > 2   (899,706)             188.5    25.1    70.8
//!     > 1000 (13,761)             188.4    14.0    63.1
//!
//!   categorical (8 values)        dense     RFE     BSI     RFE 1098 KB (0 exceptions)
//!     = top value (113,290)       197.2     1.7    26.0
//!     > 2   (562,130)             188.0     9.2    38.7
//!
//!   high-cardinality (4096)       dense     RFE     BSI     RFE 8110 KB (897k exceptions!)
//!     = top value (273)           197.2     1.6    27.0
//!     = rare value (238)          197.1   184.4    27.1
//!     > 2   (898,985)             188.2   540.5    39.1
//!     > 1000 (679,742)            188.4  1453.0    34.3
//!
//!   BSI cost is bits x words, nothing else (high-cardinality, `> 1000`):
//!      8 slices  21.1us  8.1x dense      32 slices   83.5us  2.0x
//!     12 slices  30.5us  5.6x            48 slices  121.3us  1.4x
//!     16 slices  41.0us  4.2x            64 slices  164.3us  1.0x  <- break-even
//!     24 slices  63.4us  2.7x
//!
//!   one point write   RFE 5.5ns (move a row between layers) · BSI 30.7ns (12 bits)
//!   rebuild, 1M rows  RFE 59.3ms · BSI 8.4ms
//! ```
//!
//! **IT VECTORIZES, AND WITHOUT INTRINSICS.** Disassembling the release build:
//! `Bsi::gt` is `vandps` x11, `vorps`, `vandnps` over **ymm** registers — the
//! comparison circuit, four u64 lanes (256 rows) per instruction — and `Rfe::gt` is
//! `vorps` over ymm. Plain `for (o, s) in a.iter_mut().zip(b)` over `u64` slices is
//! all it took at the repo's `target-cpu=x86-64-v3`. So the standing "SIMD is weak
//! here" note was never about SIMD: the old loop gave the vectorizer a gather, a
//! byte-wide branch and a growing `Vec`, and it could do nothing with that. Change
//! the representation and the compiler reaches for the vector unit unprompted.
//!
//! **RFE is a bet on cardinality, and it is a big bet both ways.** Where a few
//! values dominate it is 20-123x faster than the dense scan and 6x smaller —
//! equality on a peeled value is not a scan at all, it is a pointer to that value's
//! bitmap. Where nothing is frequent it is 3-8x SLOWER than the dense scan and
//! LARGER than the raw doubles, because everything falls into the exception tail.
//! There is no middle: it has to be gated on the distribution, and the engine
//! already computes exactly that signal — `Column::Dict` exists precisely when a
//! string column's cardinality stays under a cap.
//!
//! **BSI is the safe one.** 4.2-8.1x over dense, flat in cardinality AND in
//! selectivity (the circuit does identical work whatever the answer), 5x smaller
//! than f64 — but strictly bounded by value width, hitting break-even at 64 bits.
//! That is the whole story of where it applies: it pays on NARROW values, which in
//! this engine means dictionary CODES (<=12 bits for the 4096-distinct cap) and
//! small integers, and pays nothing on raw doubles.
//!
//! **Both survive mutation**, which was the condition for caring. RFE absorbs a
//! write in 5.5ns (clear one bit, set another); BSI in 30.7ns (one bit per slice,
//! bounded by width, not by data). Neither needs a rebuild to stay CORRECT — but
//! RFE's layers go stale as a distribution drifts, and its rebuild is 59ms per
//! million rows against BSI's 8.4ms, so RFE wants a drift policy and BSI does not.
//!
//! WHAT THIS DOES NOT SAY. Standalone arrays again, not the engine: no `Gen`
//! columns, no present-null/absent distinction beyond the presence mask, and every
//! consumer here takes a mask rather than the ids the engine currently wants. The
//! RFE build is also deliberately naive (a HashMap pass per layer) — 59ms/M is the
//! cost of the obvious implementation, not a floor.

#[path = "support/harness.rs"]
#[allow(dead_code)] // the shared harness serves every bench; a probe uses part of it
mod harness;

use harness::{best_us, section, Cfg, Lcg};
use std::hint::black_box;

// ───────────────────────────────────────────────────────────────── fixtures ───

/// The axis that decides between these structures: how many distinct values the
/// column holds, and how lopsided their frequencies are.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// One value covers ~70% of rows, the rest fall away exponentially — the
    /// distribution BtrBlocks names as the common case, and RFE's best case.
    Dominant,
    /// ~8 values, roughly even. A `status`, `dept`, `stage` column: the shape that
    /// makes dictionary encoding pay, and that RFE covers completely with 8 layers.
    Categorical,
    /// Thousands of distinct values, uniform. RFE cannot peel this — no value is
    /// frequent — so it degenerates to exceptions. BSI does not care.
    HighCardinality,
}

impl Shape {
    fn name(self) -> &'static str {
        match self {
            Self::Dominant => "dominant (70% one value)",
            Self::Categorical => "categorical (8 values)",
            Self::HighCardinality => "high-cardinality (4096)",
        }
    }
}

struct Fixture {
    /// Values as the store holds them: dense `f64`, in id order.
    data: Vec<f64>,
    /// The same values as order-preserving integers, for the BSI.
    keys: Vec<u32>,
    /// Presence, one bit per row (the previous probe's finding: never a byte).
    present: Vec<u64>,
    rows: usize,
}

fn build(rows: usize, shape: Shape) -> Fixture {
    let mut rng = Lcg::seeded();
    let mut keys = Vec::with_capacity(rows);

    for _ in 0..rows {
        let k = match shape {
            Shape::Dominant => {
                let r = rng.next(100);
                // 70% one value, then an exponential tail: 15%, 7%, 4%, 2%, …
                match r {
                    0..=69 => 7,
                    70..=84 => 3,
                    85..=91 => 11,
                    92..=95 => 42,
                    96..=97 => 5,
                    _ => rng.next(4096),
                }
            }
            Shape::Categorical => rng.next(8),
            Shape::HighCardinality => rng.next(4096),
        };
        keys.push(k);
    }

    let mut present = vec![0u64; rows.div_ceil(64)];

    for i in 0..rows {
        // 10% absent, as in the previous probe.
        if rng.next(100) >= 10 {
            present[i / 64] |= 1u64 << (i % 64);
        }
    }

    Fixture {
        data: keys.iter().map(|&k| f64::from(k)).collect(),
        keys,
        present,
        rows,
    }
}

// ─────────────────────────────────────────────────────── baseline: dense scan ───

/// The previous probe's winner: branch-free dense pass over `f64`, AND the presence
/// word, emit a mask. Everything below has to beat THIS, not the engine's current
/// loop — beating a loop we already know is 6-10x off the pace proves nothing.
fn scan_dense_gt(f: &Fixture, t: f64) -> Vec<u64> {
    let mut out = vec![0u64; f.rows.div_ceil(64)];

    for (w, slot) in out.iter_mut().enumerate() {
        let base = w * 64;
        let lanes = 64.min(f.rows - base);
        let mut m = 0u64;

        for k in 0..lanes {
            m |= u64::from(f.data[base + k] > t) << k;
        }

        *slot = m & f.present[w];
    }

    out
}

fn scan_dense_eq(f: &Fixture, v: f64) -> Vec<u64> {
    let mut out = vec![0u64; f.rows.div_ceil(64)];

    for (w, slot) in out.iter_mut().enumerate() {
        let base = w * 64;
        let lanes = 64.min(f.rows - base);
        let mut m = 0u64;

        for k in 0..lanes {
            m |= u64::from(f.data[base + k] == v) << k;
        }

        *slot = m & f.present[w];
    }

    out
}

// ──────────────────────────────────────────── recursive frequency encoding ───

/// A column as a stack of disjoint bitmaps plus an exception tail.
///
/// Layer `i` is (value, bitmap) — the most frequent value among the rows no
/// earlier layer claimed. What is left after `k` peels is stored as (row, value)
/// pairs. Each bitmap is dense (one bit per row of the whole column) rather than
/// Roaring: dense is what the word loops below want, and at one bit per row per
/// layer, `k=8` layers cost 1 MB per million rows against 8 MB for the doubles.
struct Rfe {
    layers: Vec<(u32, Vec<u64>)>,
    exceptions: Vec<(u32, u32)>,
    /// Rows covered by some layer — so the exception tail can be found by mask.
    covered: Vec<u64>,
    rows: usize,
}

impl Rfe {
    fn build(f: &Fixture, k: usize) -> Self {
        let words = f.rows.div_ceil(64);
        let mut claimed = vec![0u64; words];
        let mut layers = Vec::with_capacity(k);

        for _ in 0..k {
            // Count the unclaimed, present rows by value; peel the winner.
            let mut counts: std::collections::HashMap<u32, u32> = std::collections::HashMap::new();

            for i in 0..f.rows {
                let (w, b) = (i / 64, i % 64);

                if f.present[w] >> b & 1 == 1 && claimed[w] >> b & 1 == 0 {
                    *counts.entry(f.keys[i]).or_insert(0) += 1;
                }
            }

            // Ties broken by value so the build is deterministic — a probe that
            // rebuilds differently run to run cannot be compared against itself.
            let Some((&top, _)) = counts
                .iter()
                .max_by_key(|(v, c)| (**c, std::cmp::Reverse(**v)))
            else {
                break;
            };

            let mut bitmap = vec![0u64; words];

            for i in 0..f.rows {
                let (w, b) = (i / 64, i % 64);

                if f.present[w] >> b & 1 == 1 && claimed[w] >> b & 1 == 0 && f.keys[i] == top {
                    bitmap[w] |= 1u64 << b;
                }
            }

            for w in 0..words {
                claimed[w] |= bitmap[w];
            }

            layers.push((top, bitmap));
        }

        let mut exceptions = Vec::new();

        for i in 0..f.rows {
            let (w, b) = (i / 64, i % 64);

            if f.present[w] >> b & 1 == 1 && claimed[w] >> b & 1 == 0 {
                exceptions.push((i as u32, f.keys[i]));
            }
        }

        Self {
            layers,
            exceptions,
            covered: claimed,
            rows: f.rows,
        }
    }

    /// Bytes held, for the size half of the trade.
    fn bytes(&self) -> usize {
        self.layers.len() * self.rows.div_ceil(64) * 8
            + self.covered.len() * 8
            + self.exceptions.len() * 8
    }

    /// `x == v`. If `v` is a peeled value this is a POINTER — no comparison, no
    /// scan, O(1) plus the copy. Otherwise only the exception tail is touched.
    fn eq(&self, v: u32) -> Vec<u64> {
        if let Some((_, bm)) = self.layers.iter().find(|(lv, _)| *lv == v) {
            return bm.clone();
        }

        let mut out = vec![0u64; self.rows.div_ceil(64)];

        for &(row, val) in &self.exceptions {
            if val == v {
                out[row as usize / 64] |= 1u64 << (row as usize % 64);
            }
        }

        out
    }

    /// `x > t`: OR the bitmaps whose value passes, then sweep the exception tail.
    /// The OR loop is the whole point — pure word arithmetic over dense memory.
    fn gt(&self, t: u32) -> Vec<u64> {
        let words = self.rows.div_ceil(64);
        let mut out = vec![0u64; words];

        for (v, bm) in &self.layers {
            if *v > t {
                for (o, b) in out.iter_mut().zip(bm.iter()) {
                    *o |= *b;
                }
            }
        }

        for &(row, val) in &self.exceptions {
            if val > t {
                out[row as usize / 64] |= 1u64 << (row as usize % 64);
            }
        }

        out
    }
}

// ─────────────────────────────────────────────────────── bit-sliced index ───

/// Bit `b` of every value as its own bitmap: `slices[b]` has row `i` set iff bit
/// `b` of `keys[i]` is 1. A range predicate becomes a boolean circuit evaluated
/// over whole words, so the cost depends on the BIT WIDTH, never on cardinality
/// and never on selectivity.
struct Bsi {
    slices: Vec<Vec<u64>>,
    present: Vec<u64>,
    rows: usize,
}

impl Bsi {
    fn build(f: &Fixture, bits: usize) -> Self {
        let words = f.rows.div_ceil(64);
        let mut slices = vec![vec![0u64; words]; bits];

        for i in 0..f.rows {
            let (w, b) = (i / 64, i % 64);
            let key = f.keys[i];

            for (bit, slice) in slices.iter_mut().enumerate() {
                if key >> bit & 1 == 1 {
                    slice[w] |= 1u64 << b;
                }
            }
        }

        Self {
            slices,
            present: f.present.clone(),
            rows: f.rows,
        }
    }

    fn bytes(&self) -> usize {
        self.slices.len() * self.rows.div_ceil(64) * 8
    }

    /// `x > t`, MSB to LSB. `eq` tracks rows still tied with `t` on the bits seen
    /// so far; `gt` accumulates rows that have already won. Two word ops per slice
    /// per word, and every row in the word is decided at once.
    fn gt(&self, t: u32) -> Vec<u64> {
        let words = self.rows.div_ceil(64);
        let mut gt = vec![0u64; words];
        let mut eq = vec![u64::MAX; words];

        for bit in (0..self.slices.len()).rev() {
            let slice = &self.slices[bit];

            if t >> bit & 1 == 1 {
                // `t` has a 1 here: only rows that also have a 1 stay tied, and no
                // row can pull ahead on this bit.
                for (e, s) in eq.iter_mut().zip(slice.iter()) {
                    *e &= *s;
                }
            } else {
                // `t` has a 0: a tied row with a 1 here wins outright; a tied row
                // with a 0 stays tied.
                for ((g, e), s) in gt.iter_mut().zip(eq.iter_mut()).zip(slice.iter()) {
                    *g |= *e & *s;
                    *e &= !*s;
                }
            }
        }

        for (g, p) in gt.iter_mut().zip(self.present.iter()) {
            *g &= *p;
        }

        gt
    }

    /// `x == v`: AND the slices where `v` has a 1, ANDNOT the rest. One pass, and
    /// again independent of how many distinct values exist.
    fn eq(&self, v: u32) -> Vec<u64> {
        let mut out = self.present.clone();

        for (bit, slice) in self.slices.iter().enumerate() {
            if v >> bit & 1 == 1 {
                for (o, s) in out.iter_mut().zip(slice.iter()) {
                    *o &= *s;
                }
            } else {
                for (o, s) in out.iter_mut().zip(slice.iter()) {
                    *o &= !*s;
                }
            }
        }

        out
    }
}

// ────────────────────────────────────────────────────────────── the runs ───

fn popcount(m: &[u64]) -> usize {
    m.iter().map(|w| w.count_ones() as usize).sum()
}

fn agree(a: &[u64], b: &[u64], what: &str) {
    assert_eq!(
        a, b,
        "{what}: masks disagree — the comparison would be theatre"
    );
}

fn run_shape(cfg: &Cfg, rows: usize, shape: Shape) {
    let f = build(rows, shape);
    let rfe = Rfe::build(&f, 8);
    let bsi = Bsi::build(&f, 12);

    let raw = rows * 8;
    println!(
        "\n  {rows} rows · {}\n  sizes: f64 {} KB · RFE {} KB ({} layers, {} exceptions) · BSI {} KB (12 slices)",
        shape.name(),
        raw / 1024,
        rfe.bytes() / 1024,
        rfe.layers.len(),
        rfe.exceptions.len(),
        bsi.bytes() / 1024,
    );
    println!(
        "  {:<26} {:>10} {:>10} {:>10}",
        "predicate", "dense", "RFE", "BSI"
    );

    // Equality on the MOST FREQUENT value: RFE's best case (a pointer), and the
    // case a `status = 'active'` filter actually is.
    let top = rfe.layers[0].0;
    let d = best_us(cfg.reps, || scan_dense_eq(&f, f64::from(top)));
    let r = best_us(cfg.reps, || rfe.eq(top));
    let b = best_us(cfg.reps, || bsi.eq(top));
    agree(
        &scan_dense_eq(&f, f64::from(top)),
        &rfe.eq(top),
        "eq/top RFE",
    );
    agree(
        &scan_dense_eq(&f, f64::from(top)),
        &bsi.eq(top),
        "eq/top BSI",
    );
    println!(
        "  {:<26} {:>10.1} {:>10.1} {:>10.1}",
        format!("= top value ({} rows)", popcount(&rfe.eq(top))),
        black_box(d),
        black_box(r),
        black_box(b)
    );

    // Equality on a RARE value: RFE falls to its exception tail, which is where a
    // structure tuned for the frequent case has to prove it does not collapse.
    let rare = rfe.exceptions.first().map_or(top, |&(_, v)| v);
    let d = best_us(cfg.reps, || scan_dense_eq(&f, f64::from(rare)));
    let r = best_us(cfg.reps, || rfe.eq(rare));
    let b = best_us(cfg.reps, || bsi.eq(rare));
    agree(
        &scan_dense_eq(&f, f64::from(rare)),
        &rfe.eq(rare),
        "eq/rare RFE",
    );
    agree(
        &scan_dense_eq(&f, f64::from(rare)),
        &bsi.eq(rare),
        "eq/rare BSI",
    );
    println!(
        "  {:<26} {:>10.1} {:>10.1} {:>10.1}",
        format!("= rare value ({} rows)", popcount(&rfe.eq(rare))),
        black_box(d),
        black_box(r),
        black_box(b)
    );

    // Ranges at two selectivities. RFE pays per PASSING LAYER plus its tail; BSI
    // pays a fixed circuit whatever the answer looks like.
    for t in [2u32, 1000] {
        let d = best_us(cfg.reps, || scan_dense_gt(&f, f64::from(t)));
        let r = best_us(cfg.reps, || rfe.gt(t));
        let b = best_us(cfg.reps, || bsi.gt(t));
        agree(&scan_dense_gt(&f, f64::from(t)), &rfe.gt(t), "gt RFE");
        agree(&scan_dense_gt(&f, f64::from(t)), &bsi.gt(t), "gt BSI");
        println!(
            "  {:<26} {:>10.1} {:>10.1} {:>10.1}",
            format!("> {t} ({} rows)", popcount(&rfe.gt(t))),
            black_box(d),
            black_box(r),
            black_box(b)
        );
    }
}

/// The mutation half. A structure that cannot absorb a write has to be rebuilt,
/// and a rebuild per write is a stall, not a structure.
fn maintenance(cfg: &Cfg, rows: usize) {
    let f = build(rows, Shape::Categorical);
    let rfe = Rfe::build(&f, 8);
    let bsi = Bsi::build(&f, 12);
    let mut rng = Lcg::seeded();
    let targets: Vec<usize> = (0..10_000)
        .map(|_| rng.next(rows as u32) as usize)
        .collect();

    // RFE point update: clear the bit in the old value's layer, set it in the new
    // one. Both layers are known from the values, so this is two word writes — the
    // only catch is a new value that no layer holds, which appends an exception.
    let mut layers: Vec<(u32, Vec<u64>)> = rfe.layers.clone();
    let us = best_us(cfg.reps, || {
        for (n, &i) in targets.iter().enumerate() {
            let (w, b) = (i / 64, i % 64);
            let old = f.keys[i];
            let new = (old + 1) % 8;

            if let Some(l) = layers.iter_mut().find(|(v, _)| *v == old) {
                l.1[w] &= !(1u64 << b);
            }

            if let Some(l) = layers.iter_mut().find(|(v, _)| *v == new) {
                l.1[w] |= 1u64 << b;
            }

            black_box(n);
        }
        layers[0].1[0]
    });
    println!(
        "  {:<38} {:>8.1} ns/write",
        "RFE: move a row between layers",
        us * 1e3 / 10_000.0
    );

    // BSI point update: one bit per slice. Bounded by the width, not the data.
    let mut slices = bsi.slices.clone();
    let us = best_us(cfg.reps, || {
        for (n, &i) in targets.iter().enumerate() {
            let (w, b) = (i / 64, i % 64);
            let new = (f.keys[i] + n as u32) & 0xFFF;

            for (bit, slice) in slices.iter_mut().enumerate() {
                if new >> bit & 1 == 1 {
                    slice[w] |= 1u64 << b;
                } else {
                    slice[w] &= !(1u64 << b);
                }
            }
        }
        slices[0][0]
    });
    println!(
        "  {:<38} {:>8.1} ns/write",
        "BSI: rewrite 12 slice bits",
        us * 1e3 / 10_000.0
    );

    // And the rebuild costs, because both structures drift: RFE's frequencies go
    // stale as values move, and both need a rebuild after a bulk load.
    let us = best_us(cfg.reps.min(3), || Rfe::build(&f, 8).layers.len());
    println!(
        "  {:<38} {:>8.1} ms/rebuild ({rows} rows)",
        "RFE: rebuild 8 layers",
        us / 1e3
    );

    let us = best_us(cfg.reps.min(3), || Bsi::build(&f, 12).slices.len());
    println!(
        "  {:<38} {:>8.1} ms/rebuild ({rows} rows)",
        "BSI: rebuild 12 slices",
        us / 1e3
    );
}

/// The BSI's cost is `bits x words` — nothing else. That is its strength (no
/// dependence on cardinality or selectivity) and its whole limitation, so measure
/// the slope directly and find where it stops beating a dense scan. Widths beyond
/// the data's 12 significant bits carry no information; they are here because the
/// circuit does the same work either way, which is exactly the point being priced.
fn width_sweep(cfg: &Cfg, rows: usize) {
    let f = build(rows, Shape::HighCardinality);
    let dense = best_us(cfg.reps, || scan_dense_gt(&f, 1000.0));
    println!("  dense scan over f64 (the thing to beat): {dense:.1} us\n");
    println!(
        "  {:<12} {:>10} {:>10} {:>12}",
        "BSI width", "us", "vs dense", "KB"
    );

    for bits in [8usize, 12, 16, 24, 32, 48, 64] {
        let bsi = Bsi::build(&f, bits);
        let us = best_us(cfg.reps, || bsi.gt(1000));
        println!(
            "  {:<12} {:>10.1} {:>9.1}x {:>12}",
            format!("{bits} slices"),
            black_box(us),
            dense / us,
            bsi.bytes() / 1024
        );
    }
}

fn main() {
    let cfg = Cfg::from_env();
    let rows = cfg.scale.unwrap_or(1_000_000);

    section("bitmap layouts: predicate as word arithmetic (us, min of reps)");
    println!(
        "  dense = branch-free scan over f64 (the previous probe's winner)\n  \
         RFE   = recursive frequency encoding: k disjoint bitmaps + exception tail\n  \
         BSI   = bit-sliced index: one bitmap per bit position"
    );

    for shape in [Shape::Dominant, Shape::Categorical, Shape::HighCardinality] {
        run_shape(&cfg, rows, shape);
    }

    section("BSI cost vs value width — where the circuit stops paying");
    width_sweep(&cfg, rows);

    section("maintenance: what one point write costs, and what a rebuild costs");
    maintenance(&cfg, rows);
}
