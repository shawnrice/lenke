//! WHY was the corpus's single-bound count already fast when the probe's was 6.7x slow? (item 1206)
//!
//! Item 1205 fixed `WHERE a.num >= 500000 RETURN count(*)` from 618.4us to 92.4us by routing a
//! single ordering bound through the two-bound arm, and recorded one thing it could NOT explain:
//! the bench corpus's own single-bound row — `MATCH (p:Person) WHERE p.age > 50 RETURN count(*)`,
//! the identical shape — was ALREADY 90.5us before that change. Both 200,000 nodes, both
//! `Column::Num`, both about half-selective. So the slow behaviour was not universal, and the win's
//! breadth is whatever distinguishes those two fixtures.
//!
//! ⚠️ THIS PROBE ONLY MEANS ANYTHING ON THE PRE-FIX CODE. After item 1205 every single ordering
//! bound takes the vectorizing arm, so all rows read ~92us and the question is invisible. Run it at
//! `HEAD~1` (or any commit before a5910e2a), where the two fixtures still disagree.
//!
//! FOUR FIXTURES, differing one dimension at a time from the probe's toward the corpus's:
//!
//!   wide-narrow    several properties, `age` in 0..100       <- the corpus's shape
//!   wide-broad     several properties, value in 0..1,000,000
//!   lean-narrow    ONE property, value in 0..100
//!   lean-broad     ONE property, value in 0..1,000,000       <- the probe's shape
//!
//! If the fast rows are the two `wide` ones, the dimension is the node's property COUNT (how the
//! store lays out a column). If they are the two `narrow` ones, it is the VALUE RANGE (which would
//! be about the compare, not the layout). If only `wide-narrow` is fast, the two interact.
//!
//! Selectivity is held at ~50% in every fixture, with the matched count printed as the check.
//!
//!   cargo run --release --example bound_fixture_shape_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// `wide` adds the sibling properties the corpus fixture carries; `narrow` keeps the value in
/// 0..100 as an age would be.
fn store_of(nodes: u32, wide: bool, narrow: bool, periodic: bool) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        // ⚠️ THE DIMENSION THAT TURNED OUT TO MATTER. The corpus fixture writes
        // `("age", Value::Num(f64::from(i % 100)))` — a PERIODIC sequence, 0..99 over and over —
        // where this probe used random values. The slow arm is branchy
        // (`if present[i] && cmp(data[i])`), so a periodic column gives it runs of 50 false then
        // 50 true and the branch predicts almost perfectly; random values mispredict about every
        // other row. The vectorizing arm is branchless and does not care.
        let v = if periodic {
            if narrow {
                f64::from(i % 100)
            } else {
                f64::from(i % 1_000_000)
            }
        } else if narrow {
            f64::from(rng.next(100))
        } else {
            f64::from(rng.next(1_000_000))
        };

        if wide {
            b.node(
                &["Person"],
                &[
                    ("name", Value::Str(format!("name{i}").into())),
                    ("k", Value::Num(v)),
                    ("city", Value::Str(format!("c{}", i % 50).into())),
                ],
            );
        } else {
            b.node(&["Person"], &[("k", Value::Num(v))]);
        }
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!(
        "  fixture          props  range     order      single-bound   two-bound   ratio   rows"
    );

    for (label, wide, narrow, periodic) in [
        // The corpus's exact shape: several properties, 0..100, PERIODIC.
        ("corpus replica", true, true, true),
        ("periodic, lean", false, true, true),
        ("random, wide", true, true, false),
        ("random, lean", false, true, false),
        ("random, broad", false, false, false),
    ] {
        let store = store_of(nodes, wide, narrow, periodic);
        // The threshold splits each range in half, so every row counts about the same number.
        let (lo, hi) = if narrow {
            (50, 100)
        } else {
            (500_000, 1_000_000)
        };
        let one = format!("MATCH (p:Person) WHERE p.k > {lo} RETURN count(*) AS c");
        let two = format!("MATCH (p:Person) WHERE p.k > {lo} AND p.k < {hi} RETURN count(*) AS c");

        let ask = |q: &str| -> f64 {
            time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us)
        };
        let rows = {
            let plan = lenke_engine::opt::optimize_indexed(
                lenke_engine::gql::parse(&one).expect("parses"),
                &store,
            );
            lenke_engine::exec::try_run(&plan, &store)
                .ok()
                .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
                .map_or_else(|| "<none>".to_string(), |v| format!("{v:?}"))
        };

        let (a, b) = (ask(&one), ask(&two));

        println!(
            "  {label:<16} {:<6} {:<9} {:<10} {a:>12.1} {b:>11.1} {:>7.2}x   {rows}",
            if wide { "3" } else { "1" },
            if narrow { "0..100" } else { "0..1e6" },
            if periodic { "periodic" } else { "random" },
            a / b
        );
    }

    println!(
        "\n  The PERIODIC rows fast and the RANDOM rows slow => the slow arm's cost is BRANCH\n  \
         MISPREDICTION, and the corpus's `i % 100` column hid a 6.7x by being predictable.\n  \
         Property count and value range were already refuted: all-random, all four slow."
    );
}
