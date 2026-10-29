//! WHICH other per-row paths are branchy, and how much does that cost? (item 1207)
//!
//! Item 1206 found that the bench corpus's `("age", Value::Num(f64::from(i % 100)))` is PERIODIC,
//! which makes a branchy filter's branch predict almost perfectly — and that this hid item 1205's
//! 6.7x on a single-bound filtered count for as long as the fixture has existed.
//!
//! That turns "periodic vs random, same query" into a DETECTOR: a path whose cost depends on value
//! order is branchy, and a branchy path over a 50%-selective predicate is paying ~50% mispredicts
//! that a branchless form would not. So this applies the detector across the per-row paths rather
//! than only the one item 1205 fixed — the method's "grep the pattern elsewhere" step, with the
//! grep being a measurement.
//!
//! ⚠️ READ THE RATIO, NOT THE TIMES. The two fixtures hold the same number of rows and the same
//! ~50% selectivity (printed, as the check), so a row whose PERIODIC and RANDOM timings differ is
//! branchy by construction. A row where they agree is already branchless — or its branch is not
//! where the time goes, which is the same conclusion for a would-be optimizer.
//!
//! The CONTROLS are shapes with no data-dependent branch at all: an unfiltered count (answered
//! without reading the column) and an unfiltered projection. If those move with value order, the
//! instrument is wrong rather than the engine.
//!
//!   cargo run --release --example branchy_path_census_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// `periodic` writes `i % 100` (the corpus generator's own shape); otherwise random 0..100. Both
/// carry a string and a dictionary column built the same way, so the string and dict rows below
/// vary on exactly the same axis.
fn store_of(nodes: u32, periodic: bool) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        let v = if periodic { i % 100 } else { rng.next(100) };

        b.node(
            &["Person"],
            &[
                ("k", Value::Num(f64::from(v))),
                // Zero-padded so that string ordering matches numeric ordering, which keeps the
                // string row's selectivity equal to the numeric row's.
                ("s", Value::Str(format!("u{v:04}").into())),
                ("d", Value::Str(format!("g{}", v % 8).into())),
                ("flag", Value::Bool(v >= 50)),
            ],
        );
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let periodic = store_of(nodes, true);
    let random = store_of(nodes, false);

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!("  shape                                      periodic   random    ratio   rows");

    for (label, q) in [
        // The shape item 1205 fixed, as the reference: it should now be FLAT, because the
        // vectorizing arm is branchless.
        (
            "count, single bound [1205 FIXED]",
            "MATCH (p:Person) WHERE p.k > 50 RETURN count(*) AS c",
        ),
        (
            "count, two bounds [branchless]",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 RETURN count(*) AS c",
        ),
        // THREE bounds falls past the range arm to the general `Vec`-iterating arm.
        (
            "count, THREE bounds [general arm]",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 RETURN count(*) AS c",
        ),
        // A PROJECTION, which goes through the keep-list filter rather than a counting sweep.
        (
            "projection under the same filter",
            "MATCH (p:Person) WHERE p.k > 50 RETURN p.k AS x",
        ),
        // The STRING and DICT masks, and a BOOLEAN predicate — the representations item 1203
        // found have no typed mask, now asked the question that item could not.
        (
            "count, STRING bound",
            "MATCH (p:Person) WHERE p.s > 'u0050' RETURN count(*) AS c",
        ),
        (
            "count, DICT equality",
            "MATCH (p:Person) WHERE p.d = 'g3' RETURN count(*) AS c",
        ),
        (
            "count, BOOLEAN equality",
            "MATCH (p:Person) WHERE p.flag = true RETURN count(*) AS c",
        ),
        // An aggregate over the filtered rows, which reads the column as well as testing it.
        (
            "sum under the same filter",
            "MATCH (p:Person) WHERE p.k > 50 RETURN sum(p.k) AS s",
        ),
        // ITEM 1214's CANDIDATES. Item 1210 made the SINGLE-compare keep-list branchless and item
        // 1213 canonicalized a multi-bound conjunction for the COUNT path — but the FILTER path's
        // own conjunction arm (`try_num_conjunction` in exec.rs) got neither, so a projection or
        // aggregate under two or three bounds may still walk a `Vec` of them per row.
        (
            "projection, TWO bounds",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 RETURN p.k AS x",
        ),
        (
            "projection, THREE bounds",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 RETURN p.k AS x",
        ),
        (
            "sum, THREE bounds",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 RETURN sum(p.k) AS s",
        ),
        // CONTROLS: no data-dependent branch. If these move, the instrument is wrong.
        (
            "[CTL] unfiltered count",
            "MATCH (p:Person) RETURN count(*) AS c",
        ),
        (
            "[CTL] unfiltered projection",
            "MATCH (p:Person) RETURN p.k AS x",
        ),
    ] {
        let ask = |store: &Store| -> (f64, usize) {
            let t = time_query(q, false, store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
            let plan = lenke_engine::opt::optimize_indexed(
                lenke_engine::gql::parse(q).expect("parses"),
                store,
            );
            let n = lenke_engine::exec::try_run(&plan, store).map_or(0, |r| r.rows.len());

            (t, n)
        };
        let (pt, pn) = ask(&periodic);
        let (rt, rn) = ask(&random);

        // ⚠️ A ROW WHOSE TWO FIXTURES ANSWER DIFFERENT NUMBERS OF ROWS IS NOT COMPARABLE. Printed
        // so that it cannot be read as a result by accident.
        let rows = if pn == rn {
            format!("{pn}")
        } else {
            format!("{pn} vs {rn}  ⚠️ DIFFER")
        };

        println!(
            "  {label:<40} {pt:>9.1} {rt:>8.1} {:>7.2}x   {rows}",
            rt / pt
        );
    }

    // ITEM 1216: the dict-equality row's PLAN, because five hypotheses about which sweep serves it
    // were all wrong — instrumenting the whole `try_filtered_count` chain showed 30 predicates
    // entering it and NONE on the `d` column, so the query is answered before it ever gets there.
    for (label, q) in [
        (
            "DICT equality",
            "MATCH (p:Person) WHERE p.d = 'g3' RETURN count(*) AS c",
        ),
        (
            "STRING bound",
            "MATCH (p:Person) WHERE p.s > 'u0050' RETURN count(*) AS c",
        ),
    ] {
        let plan = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &periodic,
        );

        println!("\n  PLAN [{label}]\n    {plan:?}");
    }

    println!(
        "\n  ratio > ~1.3x => that path is BRANCHY and pays ~50% mispredicts on unpredictable\n  \
         data, which the corpus fixture hides. ~1.0x => already branchless, nothing to recover.\n  \
         The two controls must be ~1.0x or the instrument, not the engine, is being measured."
    );
}
