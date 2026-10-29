//! Is the single-bound filtered count REALLY 6.7x the two-bound one? (item 1205)
//!
//! Item 1204 measured `WHERE a.num >= 500000 RETURN count(*)` at 617.5us against the same question
//! with a second, vacuous bound at 92.5us — same column, same 99,835 rows, same answer. Every
//! structural explanation for that has since been REFUTED by instrumenting rather than reading:
//!
//!   - `num_conj_on_slot` returns `Some(("num", [(Ge, 500000.0)]))` for the single bound, a
//!     one-element Vec that DOES match `try_stream_num_count`'s `[(op, t)]` single-bound arm
//!     (item 451), and the column really is `Column::Num`.
//!   - Both plans are structurally identical: `Project{Aggregate{Filter{Scan}}}`.
//!   - `try_scan_count`, which runs BEFORE `try_filtered_count` in the chain, matches only
//!     `Scan`/`Expand`/`EdgeScan` — never `Filter` — so it is not claiming the shape and item
//!     375's "an arm went dead below one that claimed its shape" does not apply.
//!
//! So both spellings should take the same arm, and a 6.7x gap is not possible. That leaves the
//! INSTRUMENT, and this repo's own rule for a surprising sweep row is to re-run it ALONE, where no
//! earlier row has polluted anything, rather than to keep reasoning (items 737 and 1073).
//!
//! ONE SHAPE PER PROCESS is not available here (both shapes must be timed), so the next best thing
//! is this: nothing else in the process, the two queries ALTERNATED, and the per-rep series printed
//! so a bimodal row is visible instead of hidden behind a min.
//!
//!   cargo run --release --example bound_count_isolated_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

fn store_of(nodes: u32) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for _ in 0..nodes {
        b.node(
            &["Person"],
            &[("num", Value::Num(f64::from(rng.next(1_000_000))))],
        );
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = store_of(nodes);

    const ONE: &str = "MATCH (a:Person) WHERE a.num >= 500000 RETURN count(*) AS c";
    const TWO: &str =
        "MATCH (a:Person) WHERE a.num >= 500000 AND a.num < 1000000 RETURN count(*) AS c";

    // Both must answer the SAME number, or the comparison is of two questions. The second bound
    // is vacuous because the generator's maximum is below 1,000,000 — asserted, not assumed.
    let answer = |q: &str| -> String {
        let plan = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &store,
        );
        lenke_engine::exec::try_run(&plan, &store)
            .ok()
            .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
            .map_or_else(|| "<none>".to_string(), |v| format!("{v:?}"))
    };
    let (a1, a2) = (answer(ONE), answer(TWO));

    println!(
        "\n# {nodes} nodes, min of {} reps, NOTHING ELSE in the process\n",
        cfg.reps
    );
    println!("  one bound  answers {a1}");
    println!("  two bounds answers {a2}");
    assert_eq!(a1, a2, "the two spellings must answer the same number");

    // THREE ORDER-ALTERNATED ROUNDS, in one process, with nothing else timed.
    let mut one = Vec::new();
    let mut two = Vec::new();

    for round in 0..3 {
        if round % 2 == 0 {
            one.push(time_query(ONE, false, &store, cfg.reps).expect("runs").0);
            two.push(time_query(TWO, false, &store, cfg.reps).expect("runs").0);
        } else {
            two.push(time_query(TWO, false, &store, cfg.reps).expect("runs").0);
            one.push(time_query(ONE, false, &store, cfg.reps).expect("runs").0);
        }
    }

    let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);

    println!(
        "\n  one bound   {:?}",
        one.iter().map(|x| x.round()).collect::<Vec<_>>()
    );
    println!(
        "  two bounds  {:?}",
        two.iter().map(|x| x.round()).collect::<Vec<_>>()
    );
    println!(
        "\n  min one {:.1}us   min two {:.1}us   ratio {:.2}x",
        min(&one),
        min(&two),
        min(&one) / min(&two)
    );
    println!(
        "\n  A ratio near 1.0 here means item 1204's 6.7x was the SWEEP, not the engine — and the\n  \
         structural refutations above already said it could not be the engine."
    );
}
