//! Does `collect` have a fast path at all, and if not, is that a TARGET? (item 1194)
//!
//! The `Column` census is exhausted (item 1191: six wins shipped, one refuted). This probe prices
//! a DIFFERENT enum — `AggFn`, which has ELEVEN variants — and the text census is unambiguous
//! about which of them `exec/fastpath.rs` has ever heard of:
//!
//!   Count 45   Min 41   Max 29   Sum 18   Avg 12      <- the five that got all the attention
//!   StddevPop 2   StddevSamp 3   PercentileCont 2   PercentileDisc 1
//!   Collect 0   CollectList 0                        <- ZERO
//!
//! Per items 1191 and 1192, counting text finds candidates and not facts, so the four middling
//! counts were READ rather than trusted: `fastpath.rs:5053` and `:5203` are ADMITTING gates, so
//! percentile and stddev are genuinely served. `Collect` and `CollectList` are the two variants
//! with no mention anywhere under `exec/` except `aggregation.rs` (the general path) — so the
//! census says they are the whole of the missing surface.
//!
//! ⚠️ BUT A MISSING PATH IS NOT A TARGET, and `collect` is the variant where that gap matters most,
//! because its OUTPUT is O(N). `min` over 200,000 rows returns one value, so an arm that skips the
//! boxing skips almost everything (item 1188 measured 4444x on a boolean). `collect` must produce
//! every value no matter how clever the arm is. Item 1189's rule is the one that applies: the
//! fold's SHARE predicts the win, and here a large part of the fold is irreducible.
//!
//! SO TWO FLOORS, BOTH CHOSEN BEFORE MEASURING (items 1187 and 1189 are both about a control that
//! was subject to the hole it measured):
//!
//!   count(a.k)   the SCAN floor — reads the presence mask and materializes nothing. Served for
//!                every representation since item 376, so unlike `count(*)` it still touches the
//!                column, and unlike the pair in item 1187 it cannot be unserved for the
//!                representations under test.
//!   RETURN a.k   the MATERIALIZATION floor — N rows carrying the identical N values through the
//!                projection path instead of the aggregation path. This is the floor that decides
//!                the question: `collect` cannot beat the cost of producing its own output, so
//!                whatever it spends ABOVE this floor is aggregation overhead and nothing else.
//!
//! Read the output as: `collect / materialize` near 1.0 means there is no target here however many
//! times the enum census points at it. Well above 1.0 is overhead, and the gap is the ceiling.
//!
//!   cargo run --release --example collect_agg_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// The same six-representation fixture as `minmax_coltype_probe`, so the two probes' rows are
/// comparable and the `date` column is a REAL `Value::Temporal` (item 1187 — it was numeric in
/// disguise there for fourteen items).
fn store_of(nodes: u32) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        let n = rng.next(1_000_000);
        let mixed = match i % 3 {
            0 => Value::Num(f64::from(n)),
            1 => Value::Str(format!("s{n}").into()),
            _ => Value::Bool(n.is_multiple_of(2)),
        };

        b.node(
            &["Person"],
            &[
                ("num", Value::Num(f64::from(n))),
                ("str", Value::Str(format!("u{i:08}").into())),
                ("dict", Value::Str(format!("g{}", n % 8).into())),
                ("bool", Value::Bool(n.is_multiple_of(2))),
                (
                    "date",
                    Value::Temporal(lenke_engine::temporal::Temporal::Date(
                        lenke_engine::temporal::Date::parse(&format!(
                            "{:04}-{:02}-{:02}",
                            1950 + (n % 70),
                            1 + (n % 12),
                            1 + (n % 28)
                        ))
                        .expect("a valid date"),
                    )),
                ),
                ("mixed", mixed),
            ],
        );
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = store_of(nodes);

    let ask = |q: &str| -> f64 {
        match time_query(q, false, &store, cfg.reps) {
            Ok((us, _)) => us,
            Err(_) => f64::NAN,
        }
    };

    // Assert the fixture really built the representation each row claims, so a row cannot
    // silently duplicate another one (item 1187's failure, which ran for fourteen items).
    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!("  fixture check — the first value of each column as the engine sees it:");
    for key in ["num", "str", "dict", "bool", "date", "mixed"] {
        let q = format!("MATCH (a:Person) RETURN min(a.{key}) AS c");
        let plan = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(&q).expect("parses"),
            &store,
        );
        let v = lenke_engine::exec::try_run(&plan, &store)
            .ok()
            .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
            .map_or_else(|| "<none>".to_string(), |v| format!("{v:?}"));
        println!("    {key:<8} {}", &v[..v.len().min(40)]);
    }

    println!(
        "\n  column     collect   coll_list   count(k)   materialize   collect/mat   collect/count"
    );

    for key in ["num", "str", "dict", "bool", "date", "mixed"] {
        let collect = ask(&format!("MATCH (a:Person) RETURN collect(a.{key}) AS c"));
        let clist = ask(&format!(
            "MATCH (a:Person) RETURN collect_list(a.{key}) AS c"
        ));
        let count = ask(&format!("MATCH (a:Person) RETURN count(a.{key}) AS c"));
        // THE MATERIALIZATION FLOOR: the same N values, produced through the projection path.
        let mat = ask(&format!("MATCH (a:Person) RETURN a.{key} AS c"));

        println!(
            "  {key:<8} {collect:>9.1} {clist:>11.1} {count:>10.1} {mat:>13.1} {:>13.2}x {:>14.2}x",
            collect / mat,
            collect / count
        );
    }

    println!(
        "\n  collect/mat near 1.0 => no target: the cost IS the output, and no arm can remove it."
    );
    println!("  collect/count is the unavoidable-materialization multiple, NOT a headroom figure.");
}
