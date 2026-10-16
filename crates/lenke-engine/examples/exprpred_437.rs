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
