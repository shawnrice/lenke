//! Is "is column `k` present on every LIVE node?" cheap enough to ask per query? (item 1131)
//!
//! Item 1131 priced `V().outE('KNOWS').outV().values('name').count()` at 1334.4 us against 58.5 us
//! for the same traversal's `count()` — 22.8x — and established that the existing
//! `fastpath::try_frontier_count_prop` cannot help, because `frontier_counts` itself walks the
//! 1,000,000 edges that ARE the 1334 us.
//!
//! The only thing that collapses `count(k)` into the O(1) tally is knowing every live node has `k`.
//! That fact needs NO maintenance: the column already stores `present: Vec<bool>`, so it is an
//! O(nodes) SEQUENTIAL scan rather than the O(rows) RANDOM walk it would replace.
//!
//! **That "far cheaper" was an ESTIMATE**, and three items this session (852, 1123, 495) were
//! refuted by building against exactly that kind of carried estimate. So this measures it before
//! anything is built:
//!
//!   ARM A  the candidate check — one sequential pass over liveness + presence
//!   ARM B  the shape it would short-circuit, in the SAME process, as the scale reference
//!   ARM C  the control the check cannot reach — `outE.outV.count()`, already a tally
//!
//! Go/no-go: ARM A in the tens of microseconds makes the shortcut worth ~17x with a ~1.5% cost
//! when it declines. ARM A in the hundreds changes the trade and the shortcut is not worth it.
//!
//!   cargo run --release --example presence_scan_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use std::hint::black_box;
use std::time::Instant;

use support::{social_store, time_query, Cfg};

/// The candidate check, written exactly as a `Store` method would be: a live node missing the
/// column refutes it, and a dead node cannot.
fn column_all_present(store: &lenke_engine::store::Store, key: &str) -> bool {
    let Some(col) = store.column(key) else {
        return false;
    };

    for i in 0..store.node_count() {
        if store.is_alive(i as u32) && !col.has_value_at(i) {
            return false;
        }
    }

    true
}

fn min_of<T>(reps: usize, mut f: impl FnMut() -> T) -> f64 {
    let mut best = f64::INFINITY;

    for _ in 0..reps {
        let t = Instant::now();

        black_box(f());

        let us = t.elapsed().as_secs_f64() * 1e6;

        if us < best {
            best = us;
        }
    }

    best
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = social_store(nodes, 5);

    println!(
        "\n# {} nodes / degree 5 ({} live), min of {} us\n",
        nodes,
        store.live_node_count(),
        cfg.reps
    );

    let a = min_of(cfg.reps, || column_all_present(&store, "name"));
    // A key no node carries: the EARLY-EXIT arm, which is what a declining column really costs.
    let a_absent = min_of(cfg.reps, || column_all_present(&store, "no_such_key"));

    let (b, b_rows) = time_query(
        "g.V().outE('KNOWS').outV().values('name').count()",
        true,
        &store,
        cfg.reps,
    )
    .expect("target shape runs");
    let (c, _) = time_query("g.V().outE('KNOWS').outV().count()", true, &store, cfg.reps)
        .expect("control shape runs");

    println!("  ARM A  check, column IS fully present   {a:>10.1} us");
    println!("  ARM A' check, column absent (early out) {a_absent:>10.1} us");
    println!("  ARM B  values(name).count()  [target]   {b:>10.1} us  ({b_rows} rows)");
    println!("  ARM C  outE.outV.count()     [control]  {c:>10.1} us");
    println!(
        "\n  check as a fraction of the target: {:.2}%",
        100.0 * a / b
    );
    println!(
        "  projected if the check short-circuits: {:.1} us  ({:.1}x)",
        a + c,
        b / (a + c)
    );
}
