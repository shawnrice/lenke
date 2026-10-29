//! What does a 1-hop count with a far-end numeric filter cost? (item 1224)
//!
//! `try_fused_hop_num_count` answers `MATCH (a:P)-[:T]->(b) WHERE b.k <op> <lit> RETURN count(*)`
//! by streaming the per-type CSR. Its bound test was
//!
//! ```ignore
//! if present[j] && bounds.iter().all(|&(op, t)| num_pred(op, data[j], t)) { count += 1; }
//! ```
//!
//! which pays THREE things per EDGE that do not depend on the edge: an iterator over `bounds`, a
//! closure call, and `num_pred`'s six-way match on `op`. A single bound now matches the operator
//! ONCE and sweeps with a monomorphic comparison.
//!
//! ⚠️ TWO FIXTURES, PERIODIC AND RANDOM, BECAUSE THE CHANGE HAS TWO PARTS AND ONLY ONE OF THEM IS
//! VISIBLE ON EACH. Removing the per-edge dispatch is unconditional work either way. Making the
//! accumulation branchless is worth whatever the MISPREDICTIONS cost — and `social_store`'s
//! `age = i % 100` is periodic, which the harness's own note records as having hidden a 6.7x for as
//! long as that fixture has existed (item 1206). Measuring only the periodic one would understate
//! this; measuring only the random one would overstate it for the corpus rows that use the shared
//! generator. Both are printed.
//!
//! CONTROLS THE CHANGE CANNOT REACH, all in-process:
//!   - the TWO-BOUND spelling of the same hop count, whose arm is deliberately untouched;
//!   - the same hop count with NO filter, a different function entirely;
//!   - a SCAN filter count, which goes through `sweep_num_count` (item 1220) and never enters this.
//!
//!   cargo run --release --example hop_filter_count_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// `social_store`'s shape with the age column's ORDER as the only variable: periodic `i % 100`
/// (what the corpus measures against) or a pseudo-random draw over the same range (what prices a
/// branchy path honestly). Same node count, same degree, same edge type, same value RANGE — so the
/// two differ in value order and nothing else.
fn store_of(nodes: u32, deg: u32, periodic: bool) -> Store {
    let mut b = Builder::default();
    let mut vals = support::Lcg::seeded();

    for i in 0..nodes {
        let age = if periodic { i % 100 } else { vals.next(100) };

        b.node(&["Person"], &[("age", Value::Num(f64::from(age)))]);
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
                "hop + ONE bound  (target)",
                "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 50 RETURN count(*) AS c",
            ),
            (
                "[CTL] hop + TWO bounds (arm untouched)",
                "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 50 AND b.age < 90 RETURN count(*) AS c",
            ),
            (
                "[CTL] hop, NO filter",
                "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c",
            ),
            (
                "[CTL] scan + ONE bound (sweep_num_count)",
                "MATCH (b:Person) WHERE b.age > 50 RETURN count(*) AS c",
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

            println!("  {what:<40} {us:>8.1} {rows:>10.0}");
        }
        println!();
    }

    println!(
        "  The ONE-bound and TWO-bound rows must answer DIFFERENT counts (the second bound\n  \
         excludes ages 90-99); if they agree, the second bound is being dropped and the\n  \
         'control' is really the target."
    );
}
