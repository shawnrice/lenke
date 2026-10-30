//! What do the two PRESENCE-count sweeps pay for their per-element branch? (item 1260)
//!
//! Item 1259 enumerated the conditional-increment sites left in `fastpath.rs`: 13 remain, 7 are
//! already branchless, and most of the 13 are DELIBERATE — the string arms keep their short-circuit
//! because `memcmp` is not free (item 1222), the `ls`/`rs` pair is perfectly predicted (item 1225),
//! the `bounds.iter().all` arms were measured flat (item 1228). TWO match the profile that won four
//! times (items 1220 at 3.19x, 1224 at 5.28x, 1227 at 5.31x, 1231 at 8.65-17.6x): the per-element
//! cost is one or two BOOL reads with no data load, so the compare IS the cost.
//!
//!   - `try_fused_hop_present_count` — `out(T).has(k).count()`, a presence bit per NEIGHBOUR, with
//!     `present[j] || (has_nulls && nulls[j])`. `has_nulls` is LOOP-INVARIANT and tested per edge.
//!   - `try_stream_num_count`'s fallback sweep — a bare presence atom (empty bounds, which
//!     `canonical_num_conj` declines by design) reaching a loop that tests `bounds.is_empty()`
//!     INSIDE the per-element closure. That is the shape item 1220 hoisted out of a sweep.
//!
//! ⚠️ TWO FIXTURES, AND THE SECOND IS THE WHOLE QUESTION. A column with NO stored present-nulls
//! takes the cheap arm (`has_nulls` false), so the invariant test is all there is to remove. A
//! column WITH them pays the second bool read as well. Item 1206's lesson in a new place: the
//! corpus fixture has no present-nulls, so measuring only it would price half the change.
//!
//! CONTROLS THE CHANGE CANNOT REACH, in-process:
//!   - the same hop count with a BOUND (`has(k) + k > 50`), which routes to the numeric sweep
//!     items 1220/1224 already made branchless;
//!   - a bare `count(*)` over the same hop, a different function entirely.
//!
//!   cargo run --release --example presence_count_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// `social_store`'s shape, with `nulls` as the only variable: either every `age` is a real number,
/// or one node in `stride` stores an explicit NULL — which promotes the column to carry a `nulls`
/// bitmap and makes `has_nulls` true.
fn store_of(nodes: u32, deg: u32, with_nulls: bool) -> Store {
    let mut b = Builder::default();
    let mut vals = support::Lcg::seeded();

    for i in 0..nodes {
        let age = vals.next(100);

        // ⚠️ NEVER NODE 0, and that is a fixture bug this probe already made once. With the
        // FIRST value null the column has no kind to infer and is built as `Gen`, so every
        // numeric fast path declines — the bounded control read 759.5us against 28,162.9, and the
        // "37x cost of a present-null" that looked like was really "the column became Gen". A
        // `Column::Num` accepts a `Null` IN PLACE via the nulls bit (`accepts`: "no de-opt"), so
        // the kind only changes when the first value is the null one.
        if with_nulls && i % 8 == 1 {
            b.node(&["Person"], &[("age", Value::Null)]);
        } else {
            b.node(&["Person"], &[("age", Value::Num(f64::from(age)))]);
        }
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

    for with_nulls in [false, true] {
        let store = store_of(nodes, deg, with_nulls);

        // THE FIXTURE MUST BE THE REPRESENTATION IT CLAIMS. Both arms need a `Num` column —
        // a `Gen` one routes elsewhere and the measurement would be of a different function.
        let repr = match store.column("age") {
            Some(lenke_engine::store::Column::Num { nulls, .. }) => {
                if nulls.is_empty() {
                    "Num, no nulls bitmap"
                } else {
                    "Num + nulls bitmap"
                }
            }
            Some(_) => "NOT Num - the probe is measuring a different path",
            None => "missing",
        };

        println!(
            "  == {} [column: {repr}] ==",
            if with_nulls {
                "WITH stored present-nulls (has_nulls TRUE)"
            } else {
                "no present-nulls (has_nulls FALSE)"
            }
        );
        println!("  shape                                            us       rows");

        for (what, q) in [
            (
                "HOP presence count (site 337)",
                "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age IS NOT NULL RETURN count(*) AS c",
            ),
            (
                "SCAN presence count (site 2495)",
                "MATCH (b:Person) WHERE b.age IS NOT NULL RETURN count(*) AS c",
            ),
            (
                "[CTL] hop count with a BOUND (1220/1224 arm)",
                "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 50 RETURN count(*) AS c",
            ),
            (
                "[CTL] bare hop count(*), a different fn",
                "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c",
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

            println!("  {what:<44} {us:>8.1} {rows:>10.0}");
        }
        println!();
    }

    println!(
        "  The two presence rows must answer FEWER rows in the with-nulls fixture than the\n  \
         bound control does there; if they match the no-nulls run exactly, the fixture is not\n  \
         storing present-nulls and the second arm is untested."
    );
}
