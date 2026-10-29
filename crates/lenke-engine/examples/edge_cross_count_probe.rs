//! What does an ENDPOINT-COMPARE hop count cost? (item 1225)
//!
//! `try_edge_cross_count` answers `MATCH (a)-[]->(b) WHERE b.k <op> a.k RETURN count(*)` by
//! streaming edges and comparing the two endpoints' numeric columns directly. `query_bench` reads
//! `cmp prop/prop` at ~11,900 us and `cmp prop/lit` at ~5,900 — among the slowest rows in the
//! corpus — and its per-edge test was
//!
//! ```ignore
//! if lp[li] && rp[ri] && num_pred(*op, ld[li], rd[ri]) { count += 1; }
//! ```
//!
//! `num_pred` is a six-way match and `op` is fixed for the whole query, so every edge paid a jump
//! table and the comparison could not inline. Item 1224 measured that exact substitution at 5.28x
//! on the single-bound hop count; this is the endpoint-compare twin.
//!
//! CONTROLS THE CHANGE CANNOT REACH, all in-process:
//!   - the same hop with a LITERAL bound, which goes to `try_fused_hop_num_count` (item 1224's
//!     function, untouched here) — the closest possible neighbour, and the one that would move if
//!     this were code layout rather than the dispatch;
//!   - the same hop with NO filter;
//!   - a SCAN filter count, through `sweep_num_count`.
//!
//! TWO FIXTURES. Item 1224 established that a dispatch win is value-INDEPENDENT (its periodic and
//! random arms agreed to 0.5%), so this should show the same; the `lp && rp && cmp` branch that
//! REMAINS is value-dependent, so printing both is what distinguishes "the dispatch went" from
//! "something about this fixture".
//!
//!   cargo run --release --example edge_cross_count_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// Two numeric columns so an endpoint compare has something to relate, and `deg` out-edges each.
fn store_of(nodes: u32, deg: u32, periodic: bool) -> Store {
    let mut b = Builder::default();
    let mut vals = support::Lcg::seeded();

    for i in 0..nodes {
        let k = if periodic { i % 100 } else { vals.next(100) };

        b.node(&["Person"], &[("k", Value::Num(f64::from(k)))]);
    }

    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        for _ in 0..deg {
            b.edge(i, rng.next(nodes), "KNOWS");
        }
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let deg = 4;

    println!(
        "\n# {nodes} nodes, degree {deg}, min of {} reps\n",
        cfg.reps
    );

    for periodic in [true, false] {
        let store = store_of(nodes, deg, periodic);
        let which = if periodic {
            "PERIODIC (i % 100)"
        } else {
            "RANDOM"
        };

        println!("  == {which} ==");
        println!("  shape                                        us       rows");

        for (what, q) in [
            (
                "endpoint compare b.k > a.k  (target)",
                "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.k > a.k RETURN count(*) AS c",
            ),
            (
                "endpoint compare b.k <= a.k (target)",
                "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.k <= a.k RETURN count(*) AS c",
            ),
            (
                "[CTL] hop + LITERAL bound (item 1224's fn)",
                "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.k > 50 RETURN count(*) AS c",
            ),
            (
                "[CTL] hop, NO filter",
                "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c",
            ),
            (
                "[CTL] scan + bound (sweep_num_count)",
                "MATCH (b:Person) WHERE b.k > 50 RETURN count(*) AS c",
            ),
        ] {
            let us = time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
            let rows = lenke_engine::exec::try_run(
                &lenke_engine::opt::optimize_indexed(
                    lenke_engine::gql::parse(q).expect("parses"),
                    &store,
                ),
                &store,
            )
            .ok()
            .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
            .and_then(|v| match v {
                Value::Num(n) => Some(n),
                _ => None,
            })
            .unwrap_or(f64::NAN);

            println!("  {what:<43} {us:>8.1} {rows:>10.0}");
        }
        println!();
    }

    println!(
        "  The two endpoint-compare rows are COMPLEMENTARY (`>` and `<=` over the same pairs),\n  \
         so their counts must sum to the number of edges whose BOTH endpoints are present —\n  \
         800,000 here, since every node has `k`. If they do not, one of them is not running\n  \
         the predicate it claims."
    );
}
