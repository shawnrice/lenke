//! Item 922: does a `SET` on an UNINDEXED key get slower as the store gains indexes on OTHER keys?
//!
//! `apply_set_prop` opens with
//!
//! ```text
//!     let care = self.index_on_base(key) || self.is_range_indexed(key);
//! ```
//!
//! and both of those are LINEAR SCANS with a string compare per entry:
//!
//! ```text
//!     fn index_on_base(&self, base: &str) -> bool { self.indexes.iter().any(|i| i.base() == base) }
//!     fn is_range_indexed(&self, key: &str) -> bool { self.ranges.iter().any(|i| i.key == key) }
//! ```
//!
//! So the per-write cost of deciding "is this key indexed?" is O(indexes + ranges) — paid on every
//! `SET`, for every key, whether or not any of those indexes has anything to do with the key being
//! written. `CLOSED.md` records the actual write as "one byte compare on a cache line it writes
//! anyway", so there is no reason to expect the scans to be small beside it.
//!
//! WHY NO EXISTING BENCH CAN SEE THIS. With ZERO indexes both scans are an empty-iterator check and
//! cost nothing, and nothing in the corpus varies the index count — `bench:usage` and the write
//! rows in `bench_all` build a store with none or one. This is the repo's own "match the fixture to
//! the claim" rule in its exact form: the property that decides the answer is the one no fixture
//! varies.
//!
//! THE ARMS, and what separates a real effect from a fixture artifact:
//!
//!   - `SET unindexed`  — the target. The key written is NOT indexed, so `care` is false and NO
//!     index maintenance runs; the only thing the index count can touch is the two scans.
//!   - `SET indexed`    — the same write on an INDEXED key, which pays real bucket maintenance.
//!     Reported to keep the two costs from being confused: if someone later sees this row move they
//!     should know it is not the scan.
//!   - `add_edge`       — the CONTROL. It never calls `apply_set_prop`, so the index count cannot
//!     reach it. If this row climbs with the index count too, the fixture is measuring something
//!     else (allocation, cache pressure from the index maps) and the target row proves nothing.
//!
//! Run this before changing how `apply_set_prop` decides whether a key is indexed, and keep the
//! control: the whole claim rests on `add_edge` staying flat while `SET unindexed` does not.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

const NODES: u32 = 20_000;
const WRITES: u32 = 20_000;
/// Enough distinct keys that every index sits on its own, none of them the write target.
const SPARE_KEYS: u32 = 64;

fn fixture() -> Store {
    let mut b = Builder::default();

    for i in 0..NODES {
        // `target` is what the benchmark writes; `k0..k63` exist only to be indexed.
        let mut props: Vec<(&str, Value)> = vec![("target", Value::Num(f64::from(i % 97)))];
        let owned: Vec<String> = (0..SPARE_KEYS).map(|k| format!("k{k}")).collect();

        for (k, name) in owned.iter().enumerate() {
            props.push((name.as_str(), Value::Num(f64::from(i % (7 + k as u32)))));
        }

        let as_refs: Vec<(&str, Value)> = props
            .iter()
            .map(|(n, v)| (*n, v.clone()))
            .collect::<Vec<_>>();

        b.node(&["P"], &as_refs);
    }

    b.build()
}

/// Min of `reps` runs of `WRITES` single-property writes, in ns per write.
fn set_ns(indexes: u32, key: &'static str, reps: u32) -> f64 {
    let mut best = f64::MAX;

    for _ in 0..reps {
        let mut st = fixture();

        for k in 0..indexes {
            st.create_index(&format!("k{k}"));
        }

        if key == "k0" && indexes == 0 {
            // The "indexed" arm needs its own index even at count 0, or it is not that arm.
            st.create_index("k0");
        }

        let t = Instant::now();

        for i in 0..WRITES {
            st.set_prop(i % NODES, key, Value::Num(f64::from(i % 31)));
        }

        let ns = t.elapsed().as_secs_f64() * 1e9 / f64::from(WRITES);

        best = best.min(ns);
    }

    best
}

/// The CONTROL: `add_edge` never reaches `apply_set_prop`, so the index count cannot touch it.
fn add_edge_ns(indexes: u32, reps: u32) -> f64 {
    let mut best = f64::MAX;

    for _ in 0..reps {
        let mut st = fixture();

        for k in 0..indexes {
            st.create_index(&format!("k{k}"));
        }

        let t = Instant::now();

        for i in 0..WRITES {
            st.add_edge(i % NODES, (i * 7 + 3) % NODES, "E");
        }

        let ns = t.elapsed().as_secs_f64() * 1e9 / f64::from(WRITES);

        best = best.min(ns);
    }

    best
}

fn main() {
    println!(
        "item 922 - does the INDEX COUNT cost a SET on an UNRELATED key? {NODES} nodes, {WRITES} writes, min of 3"
    );
    println!("  indexes   SET unindexed    SET indexed      add_edge (CONTROL)");

    let mut base_set = 0.0_f64;
    let mut base_ctl = 0.0_f64;

    for (n, count) in [0_u32, 1, 4, 16, 64].iter().enumerate() {
        let unindexed = set_ns(*count, "target", 3);
        let indexed = set_ns(*count, "k0", 3);
        let control = add_edge_ns(*count, 3);

        if n == 0 {
            base_set = unindexed;
            base_ctl = control;
        }

        println!(
            "  {count:>7}   {unindexed:>8.1} ns     {indexed:>8.1} ns     {control:>8.1} ns      \
             SET {:>5.2}x  ctl {:>5.2}x",
            unindexed / base_set,
            control / base_ctl
        );
    }

    println!(
        "\n  If `SET unindexed` climbs while `add_edge` stays flat, the two linear scans in\n  \
         `apply_set_prop` are the cause. If BOTH climb, the fixture is measuring something else\n  \
         (the index maps' own memory) and this probe proves nothing."
    );
}
