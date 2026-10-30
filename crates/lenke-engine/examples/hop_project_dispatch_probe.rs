//! What does the per-edge operator dispatch cost the fused hop PROJECTION? (item 1243)
//!
//! `try_fused_hop_project` answers `MATCH (a:P)-[:T]->(b) WHERE b.k <op> <lit> RETURN b.k` by
//! streaming the per-type CSR and collecting the surviving TARGET ids. Its bound test is
//!
//! ```ignore
//! if present[j] && bounds.iter().all(|&(op, t)| num_pred(op, data[j], t)) { survivors.push(nbr); }
//! ```
//!
//! which is the test item 1224 hoisted out of the COUNT twin (5.28x) and item 1227 extended to a
//! range there (5.31x) — and which this arm still pays per edge.
//!
//! ⚠️ THE COUNT RESULT DOES NOT TRANSFER, and that is the whole question. Item 1224's gain was
//! two things: removing the dispatch, and making the accumulation BRANCHLESS. Only the first is
//! available here — a `Vec::push` is data-dependent work that cannot be masked, so the branch
//! stays whatever happens to the compare. Item 1224's own ranking rule says to price the removal
//! against the loop's PER-ELEMENT cost, and this loop's per-element cost is larger than a
//! `count += 1`. That predicts a SMALLER multiple, and item 1223 (a 40-byte column, where the same
//! move measured 0.96x) is the precedent for it being none at all.
//!
//! SELECTIVITY IS SWEPT, because it sets how often the push happens and therefore how much of the
//! loop the dispatch is a share of. At `k > 98` almost nothing pushes and the dispatch is nearly
//! the whole body; at `k >= 0` everything pushes and it is a small share.
//!
//! CONTROLS THE CHANGE CANNOT REACH, all in-process:
//!   - the same hop with a COUNT, which goes to `try_fused_hop_num_count` (items 1224/1227);
//!   - a SCAN projection, which never enters this arm at all.
//!
//!   cargo run --release --example hop_project_dispatch_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// `social_store`'s shape with a RANDOM value order, which is what prices a branchy path honestly
/// (item 1224's note: the corpus's periodic `i % 100` hid a 6.7x for as long as it existed).
fn store_of(nodes: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    let mut vals = support::Lcg::seeded();

    for _ in 0..nodes {
        b.node(
            &["Person"],
            &[("age", Value::Num(f64::from(vals.next(100))))],
        );
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
    let store = store_of(nodes, deg);

    println!(
        "\n# {nodes} nodes, degree {deg}, RANDOM ages, min of {} reps\n",
        cfg.reps
    );
    println!("  shape                                            us");

    for (what, q) in [
        (
            "project, ONE bound, k > 98 (selective)",
            "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 98 RETURN b.age AS v",
        ),
        (
            "project, ONE bound, k > 50 (half)",
            "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 50 RETURN b.age AS v",
        ),
        (
            "project, ONE bound, k >= 0 (everything)",
            "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age >= 0 RETURN b.age AS v",
        ),
        (
            "project, TWO bounds, 50 < k < 90",
            "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 50 AND b.age < 90 RETURN b.age AS v",
        ),
        (
            "[CTL] hop COUNT, one bound (1224/1227, hoisted already)",
            "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 50 RETURN count(*) AS c",
        ),
        (
            "[CTL] SCAN project, one bound (never enters this arm)",
            "MATCH (b:Person) WHERE b.age > 50 RETURN b.age AS v",
        ),
    ] {
        let us = time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us);

        println!("  {what:<48} {us:>8.1}");
    }

    println!(
        "\n  The three selectivities must NOT read the same: if they do, the cost is not in this\n  \
         loop at all and the lever is priced against the wrong thing."
    );
}
