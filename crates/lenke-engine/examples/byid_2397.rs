//! Is by-id access O(1) as the graph grows, and what does it cost against the bare data
//! structure?
//!
//! A standing requirement with, until item 2397, no instrument in this corpus. `element_id`
//! appears once — `spelling_probe`'s "point lookup BY ID" group — and that group asks whether
//! two SPELLINGS cost the same, not whether either is O(1); nothing here sweeps N. The TS
//! engine's twin was verified at items 2091 and 2200. The native one never was.
//!
//! The corpus's main fixture cannot answer it. `social_store` builds through `Builder::node`,
//! which assigns no external id, so `node_by_ext` finds nothing in it — CLAUDE.md's "give edges
//! ids … omitting them skips the external-id path entirely", landing in the fixture rather than
//! in a bench. So this probe loads NDJSON (`social_ndjson`), where nodes are `v{i}` and edges
//! `e{e}`.
//!
//! The arms, every one consumed into a printed sink:
//!
//!   control       `i & 1`, the timed loop's own floor. A per-op figure near this one is a
//!                 dead-code artifact rather than a fast path — item 2200's first trap, and
//!                 rustc elides harder than a JIT does, so both ends go through `black_box`.
//!   floor         `HashMap<&str, u32>::get` over the SAME keys: the bare data structure, which
//!                 and what it actually showed is that SipHash costs more than the whole native
//!                 lookup. Expect the FNV floor ITSELF to grow with N — a lookup into a large
//!                 cold map is a cache miss — so the quantity of interest is the RATIO and
//!                 whether it widens, not the absolute nanoseconds.
//!   node_by_ext   the store's node lookup: a map get plus a tombstone check.
//!   edge_by_ext   the store's edge lookup, which LAZILY BUILDS its index on first use and then
//!                 takes an `RwLock` read per call. Measured warm, with that first O(E) call
//!                 timed separately, because amortizing it over one warm loop would hide both.
//!   node miss     a key that is not present: a different path, with no tombstone check.
//!
//! Keys are pre-built and probed in a SHUFFLED order: building them inside the loop was item
//! 2200's second trap, and probing them in insertion order would measure the cache rather than
//! the lookup.
//!
//! Native only (`std::time::Instant`). Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example byid_2397
//! Env: BYID_N (comma-separated sizes, default 25000,100000,400000,1000000), BENCH_REPS (default 5),
//!      BYID_OPS (lookups per timed loop, default 200000).

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::hint::black_box;
use std::time::Instant;

/// FNV-1a, replicated from `exec::fnv` because that module is `pub(crate)` and an example
/// cannot reach it. It exists so the floor uses the SAME hash the store's `ext_to_node` does:
/// a `std::collections::HashMap` floor is SipHash and therefore hash-bound, which makes it
/// flat in N and SLOWER than the thing being measured -- the first run of this probe read
/// `node_by_ext` at 0.71-0.89x "the floor", a ratio under 1.0 that cannot mean a lookup is
/// cheaper than a lookup. A floor has to share the measured path's hash to be a floor.
#[derive(Default)]
struct ProbeFnv(u64);

impl Hasher for ProbeFnv {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        let mut h = if self.0 == 0 {
            0xcbf2_9ce4_8422_2325
        } else {
            self.0
        };
        for &b in bytes {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        self.0 = h;
    }
}

type FnvFloor<'a> = HashMap<&'a str, u32, BuildHasherDefault<ProbeFnv>>;

/// Nanoseconds per op, min over `reps`, with the sink returned so a caller can print it and
/// no arm can be elided.
fn per_op(reps: usize, ops: usize, mut f: impl FnMut() -> u64) -> (f64, u64) {
    let mut best = f64::INFINITY;
    let mut sink = 0u64;

    for _ in 0..reps {
        let t0 = Instant::now();
        sink = sink.wrapping_add(f());
        let ns = t0.elapsed().as_nanos() as f64 / ops as f64;

        if ns < best {
            best = ns;
        }
    }

    (best, sink)
}

fn main() {
    let cfg = harness::Cfg::from_env();
    let sizes: Vec<usize> = std::env::var("BYID_N")
        .unwrap_or_else(|_| "25000,100000,400000,1000000".to_string())
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    let ops: usize = std::env::var("BYID_OPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200_000);

    harness::section(&format!(
        "byid/scaling (ns per lookup, min of {}, {ops} lookups per rep)",
        cfg.reps
    ));
    println!(
        "{:>9}{:>9}{:>9}{:>9}{:>12}{:>8}{:>12}{:>11}",
        "N", "control", "sip", "fnv", "node_by_ext", "ratio", "edge_by_ext", "node miss"
    );

    let mut first_row: Option<(f64, f64)> = None;
    let mut last_row: Option<(f64, f64)> = None;
    let mut cold_notes: Vec<String> = Vec::new();

    for &n in &sizes {
        // One edge per node, one property: the text is held resident while decoding, so a
        // bigger degree buys nothing this question needs and costs memory it does not.
        let store = lenke_engine::ndjson::from_ndjson(&harness::social_ndjson(n, 1, 1))
            .expect("the fixture must decode");

        // Pre-built, and SHUFFLED, so neither string formatting nor sequential locality lands
        // inside a timed loop.
        let mut order: Vec<usize> = (0..n).collect();
        let mut rng = harness::Lcg::seeded();
        for i in (1..n).rev() {
            order.swap(i, rng.next(i as u32 + 1) as usize);
        }
        let node_keys: Vec<String> = order.iter().map(|&i| format!("v{i}")).collect();
        let edge_keys: Vec<String> = order.iter().map(|&i| format!("e{i}")).collect();
        let miss_keys: Vec<String> = order.iter().map(|&i| format!("absent{i}")).collect();

        let mut bare: HashMap<&str, u32> = HashMap::with_capacity(n);
        let mut fnv: FnvFloor = FnvFloor::default();
        for (i, k) in node_keys.iter().enumerate() {
            bare.insert(k.as_str(), i as u32);
            fnv.insert(k.as_str(), i as u32);
        }

        let (control, s0) = per_op(cfg.reps, ops, || {
            let mut acc = 0u64;
            for i in 0..ops {
                acc = acc.wrapping_add(u64::from(black_box(i as u32) & 1));
            }
            acc
        });

        let (floor, s1) = per_op(cfg.reps, ops, || {
            let mut acc = 0u64;
            for i in 0..ops {
                let k = black_box(node_keys[i % n].as_str());
                acc = acc.wrapping_add(u64::from(bare.get(k).copied().unwrap_or(0)));
            }
            acc
        });

        let (fnv_floor, s1b) = per_op(cfg.reps, ops, || {
            let mut acc = 0u64;
            for i in 0..ops {
                let k = black_box(node_keys[i % n].as_str());
                acc = acc.wrapping_add(u64::from(fnv.get(k).copied().unwrap_or(0)));
            }
            acc
        });

        let (node_us, s2) = per_op(cfg.reps, ops, || {
            let mut acc = 0u64;
            for i in 0..ops {
                let k = black_box(node_keys[i % n].as_str());
                acc = acc.wrapping_add(u64::from(store.node_by_ext(k).unwrap_or(0)));
            }
            acc
        });

        // The COLD first call builds the edge index, so it is timed on its own before the warm
        // loop. Amortizing an O(E) build over one warm loop would understate the build and
        // overstate the lookup at the same time.
        let t_cold = Instant::now();
        let cold_hit = store.edge_by_ext(&edge_keys[0]);
        let cold_us = t_cold.elapsed().as_nanos() as f64 / 1000.0;
        cold_notes.push(format!(
            "    N={n}: the FIRST edge_by_ext call costs {cold_us:.1} us (it builds the index; hit={})",
            cold_hit.is_some()
        ));

        let (edge_us, s3) = per_op(cfg.reps, ops, || {
            let mut acc = 0u64;
            for i in 0..ops {
                let k = black_box(edge_keys[i % n].as_str());
                acc = acc.wrapping_add(u64::from(store.edge_by_ext(k).unwrap_or(0)));
            }
            acc
        });

        let (miss_us, s4) = per_op(cfg.reps, ops, || {
            let mut acc = 0u64;
            for i in 0..ops {
                let k = black_box(miss_keys[i % n].as_str());
                acc = acc.wrapping_add(u64::from(store.node_by_ext(k).unwrap_or(0)));
            }
            acc
        });

        println!(
            "{n:>9}{control:>9.2}{floor:>9.2}{fnv_floor:>9.2}{node_us:>12.2}{:>7.2}x{edge_us:>12.2}{miss_us:>11.2}",
            node_us / fnv_floor
        );

        // Printed so no arm can be optimized away unobserved; a zero sink on a hit arm means
        // the lookups did not happen.
        if s1 == 0 || s1b == 0 || s2 == 0 || s3 == 0 {
            println!("    WARNING: a hit arm's sink is zero — that arm did not run");
        }
        let _ = (s0, s4);

        if first_row.is_none() {
            first_row = Some((fnv_floor, node_us));
        }
        last_row = Some((fnv_floor, node_us));
    }

    for note in &cold_notes {
        println!("{note}");
    }

    // O(1) is a claim about the SHAPE of the curve, so the verdict is the growth of the store's
    // lookup measured against the growth of the bare map over the same span. Tracking the floor
    // means "a hash lookup plus a constant"; outgrowing it means something is scanning.
    if let (Some((f0, n0)), Some((f1, n1))) = (first_row, last_row) {
        println!(
            "\n    across the sweep: floor x{:.2}, node_by_ext x{:.2} — by-id tracks the bare map at x{:.2}",
            f1 / f0,
            n1 / n0,
            (n1 / n0) / (f1 / f0)
        );
    }
}
