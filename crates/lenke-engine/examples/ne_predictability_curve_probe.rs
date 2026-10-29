//! How does the `ne` arm's cost vary with how PREDICTABLE the column is? (item 1230)
//!
//! Item 1229 priced making the exclusion closures branchless as a TRADE: the worst case (random
//! values) improves 1.93-2.38x, the best case (a perfectly periodic column) degrades 1.20-1.29x.
//! Deciding it needs more than two points, because "how often is the best case?" is not answerable
//! by guessing — and the best case is NOT merely synthetic: a column of sorted ids, or timestamps
//! inserted in order, gives a filter long predictable runs exactly as a periodic one does.
//!
//! So this sweeps the RUN LENGTH of the column's values — the number of consecutive rows whose
//! predicate outcome is the same — from a single transition (sorted) to none (random), holding the
//! value range, the selectivity and the row count fixed. Only the ORDER changes, which is the one
//! variable the branch predictor sees.
//!
//! ⚠️ THE SELECTIVITY IS HELD AT ~49% ON PURPOSE. Misprediction cost is maximal near 50/50, so this
//! is the regime where the trade is sharpest; a selective predicate would understate both sides.
//! The row counts are printed per regime so a regime that accidentally changed the question is
//! visible rather than assumed away.
//!
//!   cargo run --release --example ne_predictability_curve_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// `run` is the number of consecutive rows sharing a value block; `None` means random.
///
/// The column is a ramp in blocks: rows `0..run` get value 0, `run..2run` get 1, and so on modulo
/// 100. A `run` of `nodes/100` is a fully SORTED column (one transition per value); a `run` of 1 is
/// the periodic `i % 100` the corpus already uses.
///
/// `Option` rather than a `run == 0` sentinel, because clippy reads the latter as a manual checked
/// division — and it is right that the sentinel conflated "no blocks" with "do not divide".
fn store_of(nodes: u32, run: Option<u32>) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        let k = match run {
            None => rng.next(100),
            Some(r) => (i / r) % 100,
        };

        b.node(&["Person"], &[("k", Value::Num(f64::from(k)))]);
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!("  regime                         sum+ne(us)  proj+ne(us)   sum rows  proj rows");

    // From fully sorted down to random. `nodes / 100` puts every equal value in one block.
    for (name, run) in [
        ("sorted (one block per value)", Some(nodes / 100)),
        ("blocks of 1000", Some(1000)),
        ("blocks of 100", Some(100)),
        ("blocks of 10", Some(10)),
        ("periodic i % 100 (corpus)", Some(1)),
        ("random", None),
    ] {
        let store = store_of(nodes, run);
        let ask = |q: &str| -> (f64, usize) {
            let us = time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
            let rows = lenke_engine::exec::try_run(
                &lenke_engine::opt::optimize_indexed(
                    lenke_engine::gql::parse(q).expect("parses"),
                    &store,
                ),
                &store,
            )
            .map_or(0, |r| r.rows.len());

            (us, rows)
        };
        let (s, sr) =
            ask("MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 RETURN sum(p.k) AS s");
        let (pr, prr) =
            ask("MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 RETURN p.k AS x");

        println!("  {name:<30} {s:>10.1} {pr:>12.1} {sr:>10} {prr:>10}");
    }

    println!(
        "\n  Read the SHAPE: if only the `random` row is slow, the trade helps a case that needs\n  \
         a shuffled column. If the cost rises as soon as runs shorten, every column that is not\n  \
         sorted pays it, and the trade is worth taking."
    );
}
