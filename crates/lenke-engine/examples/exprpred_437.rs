//! Item 437: item 434's screen left one perf lead — CASE, coalesce and arithmetic predicates sat
//! at the bottom of the native/TS ratio band (2.3-5.2x where the rest ran 13-380x). Those were
//! three different query SHAPES, so the screen could not say whether native is slow on them or TS
//! is unusually fast.
//!
//! This asks the question properly: filtered `count(*)` over the SAME rows, with predicates that
//! differ only in the EXPRESSION. Every pair below is chosen to keep the selectivity identical,
//! so the row count cannot explain a gap:
//!
//!   `a.k > 5`  against  `a.k + 0 > 5`      same rows, one addition
//!   `a.k > 5`  against  `a.k * 1 > 5`      same rows, one multiplication
//!   `a.k = 1`  against  `NOT (a.k <> 1)`   same rows, a negation
//!
//! A gap between members of a pair is the evaluator, not the predicate's meaning.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(
            &["Univ"],
            &[
                ("k", Value::Num(f64::from(i % 11))),
                ("s", Value::Str(format!("c{}", i % 97).into())),
            ],
        );
    }
    b.build()
}

fn probe(q: &str, store: &Store, reps: u32) -> Result<(f64, f64), String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut rows = 0.0;
    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        if let Some(Value::Num(c)) = out.rows.iter().next().and_then(|r| r.first()) {
            rows = *c;
        }
    }
    Ok((best, rows))
}

fn main() {
    for n in [200_000u32, 1_000_000] {
        let store = fixture(n);
        println!("\n=== {n} nodes, k = i % 11 ===");
        let cases: &[(&str, &str)] = &[
            // The PAIRS. Each pair's two members select the same rows.
            ("A plain >", "MATCH (a:Univ) WHERE a.k > 5 RETURN count(*) AS c"),
            ("A plus zero >", "MATCH (a:Univ) WHERE a.k + 0 > 5 RETURN count(*) AS c"),
            ("A times one >", "MATCH (a:Univ) WHERE a.k * 1 > 5 RETURN count(*) AS c"),
            ("B plain =", "MATCH (a:Univ) WHERE a.k = 1 RETURN count(*) AS c"),
            ("B not <>", "MATCH (a:Univ) WHERE NOT (a.k <> 1) RETURN count(*) AS c"),
            // Wider expression forms, same shape, for the shape of the curve.
            ("C abs()", "MATCH (a:Univ) WHERE abs(a.k) > 5 RETURN count(*) AS c"),
            ("C coalesce", "MATCH (a:Univ) WHERE coalesce(a.k, 0) > 5 RETURN count(*) AS c"),
            (
                "C case",
                "MATCH (a:Univ) WHERE (CASE WHEN a.k > 5 THEN true ELSE false END) RETURN count(*) AS c",
            ),
            ("C two props", "MATCH (a:Univ) WHERE a.k > 5 AND a.k < 100 RETURN count(*) AS c"),
            // Item 450: the CASE family, to find out WHICH part of a CASE predicate is the
            // 14.5x — the `Expr::Case` machinery itself, or the shape of its arms. Same
            // selectivity throughout, so only the expression differs.
            (
                "E case bool no else",
                "MATCH (a:Univ) WHERE (CASE WHEN a.k > 5 THEN true END) RETURN count(*) AS c",
            ),
            (
                "E case num = lit",
                "MATCH (a:Univ) WHERE (CASE WHEN a.k > 5 THEN 1 ELSE 0 END) = 1 RETURN count(*) AS c",
            ),
            (
                "E case two whens",
                "MATCH (a:Univ) WHERE (CASE WHEN a.k > 5 THEN true WHEN a.k < 0 THEN true ELSE false END) RETURN count(*) AS c",
            ),
            (
                "E case prop arms",
                "MATCH (a:Univ) WHERE (CASE WHEN a.k > 5 THEN a.k ELSE 0 END) > 5 RETURN count(*) AS c",
            ),
            // The equivalent written WITHOUT a CASE, which is the floor any CASE rewrite could
            // reach. In a FILTER these mean the same thing: a CASE whose WHEN is UNKNOWN takes
            // the ELSE and yields false, and false and UNKNOWN both drop the row.
            (
                "E bare cond",
                "MATCH (a:Univ) WHERE a.k > 5 RETURN count(*) AS c",
            ),
            // Item 457: the three shapes item 434's gap screen still has at the BOTTOM of the
            // native/TS band after items 438, 449 and 450 — which fixed the FILTER forms. These
            // are the positions those arms do not reach: a NESTED arithmetic predicate (two
            // Arith levels, where `try_filter_keep_arith` admits one) and two AGGREGATE
            // ARGUMENTS. Same fixture, same selectivity within each pair.
            (
                "F arith nested",
                "MATCH (a:Univ) WHERE a.k * 2 + 1 > 7 RETURN count(*) AS c",
            ),
            (
                "F arith flat",
                "MATCH (a:Univ) WHERE a.k * 2 > 6 RETURN count(*) AS c",
            ),
            ("F agg plain", "MATCH (a:Univ) RETURN count(a.k) AS c"),
            (
                "F agg coalesce",
                "MATCH (a:Univ) RETURN count(coalesce(a.missing, a.k)) AS c",
            ),
            (
                "F agg case",
                "MATCH (a:Univ) RETURN count(CASE WHEN a.k > 3 THEN 1 ELSE null END) AS c",
            ),
            // Is the 77x `coalesce` or the ABSENT column it reads? Same function, present
            // column, same row count.
            (
                "F agg coal present",
                "MATCH (a:Univ) RETURN count(coalesce(a.k, 0)) AS c",
            ),
            ("F agg missing", "MATCH (a:Univ) RETURN count(a.missing) AS c"),
            // Is the cost COALESCE, or the generic scalar-call path it shares with every other
            // non-vectorized function? `power` is the same shape: two args, numeric, no
            // vectorized arm. If both land together the dispatch is the cause and the fix is
            // shared; if `coalesce` is alone, it is not.
            ("F agg power", "MATCH (a:Univ) RETURN count(power(a.k, 2)) AS c"),
            // Item 458: WHICH part of the generic path costs the ~33 ns? Same function and the
            // same dispatch, one more argument to box — the delta is the per-argument boxing,
            // and what it does not explain is the dispatch plus the boxed output.
            (
                "F agg coal 3arg",
                "MATCH (a:Univ) RETURN count(coalesce(a.k, 0, 0)) AS c",
            ),
            (
                "F agg coal 4arg",
                "MATCH (a:Univ) RETURN count(coalesce(a.k, 0, 0, 0)) AS c",
            ),
            // A ONE-argument generic function: `sqrt` is excluded from `unary_finite_num_fn`
            // because it can make a NaN from a finite input, so it takes the generic path with
            // the fewest possible arguments.
            ("F agg sqrt", "MATCH (a:Univ) RETURN count(sqrt(a.k)) AS c"),
            // Item 463: the CASE in an AGGREGATE ARGUMENT, which item 450's filter arm does not
            // reach (that one unwraps a boolean CASE used AS a predicate) and item 459's does
            // not either (a CASE is not a Call). Variants chosen to separate the `Expr::Case`
            // machinery from what its ARMS produce: a null arm forces a boxed column, two
            // literal numeric arms could in principle be a `Col::Num`.
            (
                "G case null arm",
                "MATCH (a:Univ) RETURN count(CASE WHEN a.k > 3 THEN 1 ELSE null END) AS c",
            ),
            (
                "G case num arms",
                "MATCH (a:Univ) RETURN count(CASE WHEN a.k > 3 THEN 1 ELSE 0 END) AS c",
            ),
            (
                "G case sum arms",
                "MATCH (a:Univ) RETURN sum(CASE WHEN a.k > 3 THEN 1 ELSE 0 END) AS c",
            ),
            (
                "G case prop arm",
                "MATCH (a:Univ) RETURN count(CASE WHEN a.k > 3 THEN a.k ELSE 0 END) AS c",
            ),
            ("G agg plain", "MATCH (a:Univ) RETURN count(a.k) AS c"),
            ("G sum plain", "MATCH (a:Univ) RETURN sum(a.k) AS c"),
            ("F agg round", "MATCH (a:Univ) RETURN count(round(a.k)) AS c"),
            ("F agg abs", "MATCH (a:Univ) RETURN count(abs(a.k)) AS c"),
            ("F agg arith", "MATCH (a:Univ) RETURN count(a.k + 1) AS c"),
            // CONTROLS: no predicate at all, and a string comparison.
            ("D no predicate", "MATCH (a:Univ) RETURN count(*) AS c"),
            ("D string =", "MATCH (a:Univ) WHERE a.s = 'c42' RETURN count(*) AS c"),
        ];
        for (name, q) in cases {
            match probe(q, &store, 5) {
                Ok((ms, rows)) => println!("{name:<16} {ms:>9.3} ms   {rows} rows"),
                Err(e) => println!("{name:<16}     ERROR {e}"),
            }
        }
    }
}
