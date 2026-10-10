//! SCRATCH PROBE (item 288) — delete after pricing. What is LEFT of item 282's target now
//! that item 284 removed the constant factor item 283 was blocked on?
//!
//! The arc: item 282 priced a correlated product under a `LIMIT` at ~1,400x and designed a
//! nested-loop streamer. Item 283 built it — 1,640x where the cap fills early, **1.9x WORSE on
//! `LIMIT 4`** where it does not, because `total < cap` stays true and the inner loop rescans
//! the whole right side per left row. It was retracted, and in retracting it located the
//! blocker: `hash_join(&lrow, &rb, &[])` was called per block to attach ONE left row to a right
//! block, paying the hash-join machinery for what is a broadcast. Item 283's closing line:
//!
//!   "The next attempt should build the joined block directly [...] Until that constant factor
//!    is down, the bet-on-early-exit structure cannot be judged on its merits."
//!
//! Item 284 took that factor down 6.69x, for every cross product the planner emits. So the
//! target is unblocked — and the PRIZE HAS SHRUNK BY THE SAME FACTOR, because the baseline it
//! would beat is now 6.69x cheaper. That is the whole question here, and it has to be answered
//! BEFORE building anything: 1,640x over a 9.8ms baseline is a different proposition from the
//! same absolute floor over a ~1.5ms one.
//!
//! Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml \
//!     --example limit_product_probe
//! Env: BENCH_REPS (default 7), BENCH_N (left-side rows; right side is fixed large).

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

/// `small` `S` nodes and `big` `U` nodes, both carrying `k`, so a correlated product has a
/// known answer size: exactly one `U` matches each `S` on `k`.
fn product_store(small: u32, big: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..small {
        b.node(&["S"], &[("k", Value::Num(f64::from(i)))]);
    }
    for i in 0..big {
        b.node(&["U"], &[("k", Value::Num(f64::from(i)))]);
    }
    b.build()
}

fn main() {
    let cfg = harness::Cfg::from_env();
    let small = 4;
    let big = 100_000;
    let store = product_store(small, big);

    harness::section("item 282/283's shapes, priced AFTER item 284's direct product");
    println!("  S={small} U={big}  reps={}\n", cfg.heavy_reps());
    println!("  {:<30} {:>11}  rows", "case", "us");

    let cases: &[(&str, &str)] = &[
        // THE PRIZE: the cap fills on the first left row, so a nested loop could stop almost
        // immediately where the materialized path builds the whole product first.
        (
            "eq, LIMIT 1",
            "MATCH (s:S) MATCH (u:U) WHERE u.k = s.k RETURN u.k AS x LIMIT 1",
        ),
        // THE TRAP, and the row that retracted item 283. The answer is exactly FOUR rows, one
        // per left row, so at LIMIT 4 the cap never fills early and the loop pays double.
        (
            "eq, LIMIT 4",
            "MATCH (s:S) MATCH (u:U) WHERE u.k = s.k RETURN u.k AS x LIMIT 4",
        ),
        // Between them: a cap the first left row CAN fill, but only after a full right scan.
        (
            "eq, LIMIT 2",
            "MATCH (s:S) MATCH (u:U) WHERE u.k = s.k RETURN u.k AS x LIMIT 2",
        ),
        // The IMPOSSIBLE correlation — no row survives, so early exit can never happen and the
        // loop's bet always loses. Item 283 measured this ~3x worse.
        (
            "impossible, LIMIT 1",
            "MATCH (s:S) MATCH (u:U) WHERE u.k = s.k + 1000000 RETURN u.k AS x LIMIT 1",
        ),
        // An ordering correlation, which matches far more rows than the equality.
        (
            "gt, LIMIT 1",
            "MATCH (s:S) MATCH (u:U) WHERE u.k > s.k RETURN u.k AS x LIMIT 1",
        ),
        (
            "gt, LIMIT 4",
            "MATCH (s:S) MATCH (u:U) WHERE u.k > s.k RETURN u.k AS x LIMIT 4",
        ),
        // CONTROLS the change could not reach:
        //   a ONE-SIDED predicate under the same cap — no correlation, so nothing to stream
        (
            "CONTROL one-sided, LIMIT 1",
            "MATCH (s:S) MATCH (u:U) WHERE u.k = 7 RETURN u.k AS x LIMIT 1",
        ),
        //   the UNCAPPED correlated product, which is the cost the cap is supposed to avoid
        (
            "CONTROL eq, uncapped",
            "MATCH (s:S) MATCH (u:U) WHERE u.k = s.k RETURN u.k AS x",
        ),
        //   a single pattern under a cap
        (
            "CONTROL single pattern",
            "MATCH (u:U) WHERE u.k > 5 RETURN u.k AS x LIMIT 1",
        ),
        //   THE CEILING. Any design that pulls the right side WHOLE pays at least this, so it
        //   bounds the best achievable floor for a loop that does not stream the right side.
        ("CONTROL right-side pull", "MATCH (u:U) RETURN u.k AS x"),
        ("CONTROL left-side pull", "MATCH (s:S) RETURN s.k AS x"),
    ];

    for (label, q) in cases {
        match harness::time_query(q, false, &store, cfg.heavy_reps()) {
            Ok((us, rows)) => println!("  {label:<30} {us:>11.1}  {rows}"),
            Err(e) => println!("  {label:<30} {:>11}  {e}", "ERR"),
        }
    }
}
