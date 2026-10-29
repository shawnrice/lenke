//! Does the AGGREGATE-KIND enum have an uncovered variant? (item 1161)
//!
//! `AggFn` has eleven variants, and `fastpath.rs` does NOT mention them evenly:
//!
//! ```text
//!   Count  40 mentions      Sum  17      Min  36      Max  24      Avg  12
//!   StddevPop/Samp  2       PercentileCont/Disc  0    Collect/CollectList  0
//! ```
//!
//! That is the same shape items 1153-1155 found in the DIRECTION enum and 1157 in the LABEL-ARITY
//! one — a fast path covering some variants of an enum with the rest unpriced — and the method says
//! to go looking rather than wait. `Collect` is excluded on purpose: it must materialize the list,
//! so there is no O(1) answer to miss. The question is the SCALAR folds, every one of which is a
//! single pass over the same numeric column:
//!
//!   A1  count(a.n)          the covered variant, the scale reference
//!   A2  sum(a.n)
//!   A3  min(a.n)
//!   A4  max(a.n)
//!   A5  avg(a.n)
//!   A6  stddev_pop(a.n)     2 mentions
//!   A7  percentile_cont     0 mentions
//!   A8  count(*)   [ctl]    the control no column fold can reach
//!
//! Every row reads ONE property of every node, so any spread between them is the aggregate's own
//! dispatch, not the data it reads. A8 is the control: it touches no column at all, so a change to
//! the column-fold path cannot move it.
//!
//!   cargo run --release --example agg_kind_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};

use support::{time_query, Cfg};

/// One numeric property on every node, dense and finite — the shape every scalar fold reads.
fn numeric_store(nodes: u32) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for _ in 0..nodes {
        let n = f64::from(rng.next(1_000_000));

        b.node(&["Person"], &[("n", lenke_engine::value::Value::Num(n))]);
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = numeric_store(nodes);

    println!(
        "\n# {nodes} nodes, one dense numeric property, min of {}\n",
        cfg.reps
    );
    println!("  aggregate kind                          us        answer");

    for (label, q) in [
        (
            "A1 count(a.n)        covered",
            "MATCH (a:Person) RETURN count(a.n) AS c",
        ),
        ("A2 sum(a.n)", "MATCH (a:Person) RETURN sum(a.n) AS c"),
        ("A3 min(a.n)", "MATCH (a:Person) RETURN min(a.n) AS c"),
        ("A4 max(a.n)", "MATCH (a:Person) RETURN max(a.n) AS c"),
        ("A5 avg(a.n)", "MATCH (a:Person) RETURN avg(a.n) AS c"),
        (
            "A6 stddev_pop(a.n)   2 mentions",
            "MATCH (a:Person) RETURN stddev_pop(a.n) AS c",
        ),
        (
            "A7 percentile_cont   0 mentions",
            "MATCH (a:Person) RETURN percentile_cont(a.n, 0.5) AS c",
        ),
        (
            "A8 count(*)              [ctl]",
            "MATCH (a:Person) RETURN count(*) AS c",
        ),
    ] {
        match time_query(q, false, &store, cfg.reps) {
            Ok((us, _)) => {
                let plan = lenke_engine::opt::optimize_indexed(
                    lenke_engine::gql::parse(q).expect("parses"),
                    &store,
                );
                let answer = lenke_engine::exec::try_run(&plan, &store)
                    .ok()
                    .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
                    .map_or(f64::NAN, |v| match v {
                        lenke_engine::value::Value::Num(n) => n,
                        _ => f64::NAN,
                    });

                println!("  {label:<34} {us:>10.1}   {answer:.3}");
            }
            Err(e) => println!("  {label:<34}      ERR   {e}"),
        }
    }
}
