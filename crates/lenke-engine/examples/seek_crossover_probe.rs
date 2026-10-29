//! Where does an indexed seek actually stop beating a scan, WITH a label? (item 1218)
//!
//! `opt.rs`'s `SEEK_MAX_FRACTION = 0.154` is derived and documented: "a scan costs 1.88 ns per node
//! scanned and a seek 12.2 ns per row returned, both flat in selectivity, so a seek stops being
//! worth it at 1.88/12.2 = 15.4% of the graph."
//!
//! Item 1217 measured one point that disagrees. At 200,000 nodes with 25,756 matches — **12.9%
//! selectivity, inside the admitted band** — the indexed count took 465.5 µs against 311.2 for the
//! same query with no index at all. That is 18.1 ns per row returned, not 12.2, which would move
//! the crossover to 1.88/18.1 = **10.4%** and make the 10-15% band a planner loss.
//!
//! The suspect is the LABEL INTERSECTION: `index_seek_ids` binary-searches every candidate against
//! the sorted label bucket, so a seek over a labelled pattern pays `log(label)` per row that an
//! unlabelled one does not. One point is not a curve, so this sweeps selectivity and reads the
//! crossover off the two lines.
//!
//! ⚠️ TWO STORES PER POINT, DIFFERING ONLY IN THE INDEX, so the comparison is seek-vs-scan and not
//! fixture-vs-fixture: the same generator, the same values, the same label, `create_index` called on
//! one. The matched row count prints, because a sweep whose arms answer different numbers is
//! comparing different questions (item 1203's trap).
//!
//! CONTROL: `count(*)` with no predicate, which no index can help and no selectivity can move.
//!
//! ⚠️ THE COLUMNS ARE "NO INDEX" AND "INDEXED", NOT "SCAN" AND "SEEK", and the first version of
//! this probe labelled them the latter — which inverted the whole reading until a plan column was
//! added. The planner emits an `IndexSeek` for an equality EVEN WITH NO INDEX (the operator then
//! degrades to a label scan), and WITH an index it correctly declines to seed above ~1.6% and
//! emits `Filter+Scan`. So above that threshold this table compares a degraded seek against the
//! general filter path, and neither column is what its old name said.
//!
//!   cargo run --release --example seek_crossover_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// `buckets` distinct values of `d`, so one equality selects about `1/buckets` of the graph.
fn store_of(nodes: u32, buckets: u32, indexed: bool) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for _ in 0..nodes {
        let v = rng.next(buckets);

        b.node(
            &["Person"],
            &[
                ("d", Value::Str(format!("g{v}").into())),
                ("k", Value::Num(f64::from(v))),
            ],
        );
    }

    let mut store = b.build();

    if indexed {
        store.create_index("d");
    }

    store
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!(
        "  selectivity  NOIDX(us)    IDX(us)   idx/noidx   ns per row     rows  plan: noidx / idx"
    );

    // 1/2 down to 1/200 of the graph, bracketing the documented 15.4% crossover from both sides.
    for buckets in [2u32, 4, 8, 12, 16, 32, 64, 200] {
        let plain = store_of(nodes, buckets, false);
        let indexed = store_of(nodes, buckets, true);
        let q = "MATCH (p:Person) WHERE p.d = 'g1' RETURN count(*) AS c";

        let ask = |store: &Store| -> (f64, f64) {
            let us = time_query(q, false, store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
            let plan = lenke_engine::opt::optimize_indexed(
                lenke_engine::gql::parse(q).expect("parses"),
                store,
            );
            let rows = lenke_engine::exec::try_run(&plan, store)
                .ok()
                .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
                .and_then(|v| match v {
                    Value::Num(n) => Some(n),
                    _ => None,
                })
                .unwrap_or(f64::NAN);

            (us, rows)
        };
        let (scan, rows_a) = ask(&plain);
        let (seek, rows_b) = ask(&indexed);
        let sel = rows_b / f64::from(nodes);
        let rows = if (rows_a - rows_b).abs() < 0.5 {
            format!("{rows_b:.0}")
        } else {
            format!("{rows_a:.0} vs {rows_b:.0} DIFFER")
        };

        // ⚠️ THE PLAN SHAPE PER ROW, because a ratio without it is uninterpretable — item 1216
        // spent five hypotheses on sweeps a query never executed. "seek" here is only a seek if
        // the planner actually chose one; where it did not, the column is a second scan and the
        // ratio is noise.
        let shape = |store: &Store| -> &'static str {
            let plan = lenke_engine::opt::optimize_indexed(
                lenke_engine::gql::parse(q).expect("parses"),
                store,
            );
            let s = format!("{plan:?}");

            if s.contains("IndexSeek") {
                "IndexSeek"
            } else if s.contains("Filter") {
                "Filter+Scan"
            } else {
                "other"
            }
        };

        println!(
            "  {:>10.1}% {scan:>10.1} {seek:>10.1} {:>11.2}x {:>12.1} {rows:>7}  {} / {}",
            sel * 100.0,
            seek / scan,
            seek * 1000.0 / rows_b,
            shape(&plain),
            shape(&indexed)
        );
    }

    let plain = store_of(nodes, 8, false);
    let indexed = store_of(nodes, 8, true);
    let ctl = "MATCH (p:Person) RETURN count(*) AS c";
    let a = time_query(ctl, false, &plain, cfg.reps).map_or(f64::NAN, |(us, _)| us);
    let b = time_query(ctl, false, &indexed, cfg.reps).map_or(f64::NAN, |(us, _)| us);

    println!(
        "\n  [CTL] count(*), no predicate: {a:.1} / {b:.1}us ({:.2}x)",
        b / a
    );
    println!(
        "\n  The crossover is the row where seek/scan passes 1.00x. Below the documented 15.4%\n  \
         means SEEK_MAX_FRACTION admits a band where the planner loses; at or above it means\n  \
         item 1217's single point was the outlier and the constant stands."
    );
}
