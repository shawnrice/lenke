//! Item 426: does a SKIPPED row's projection still get EVALUATED? The engine's own rule, stated
//! on the `LIMIT 0` branch of the TS `applyProjection`, is "project exactly the rows you emit" —
//! `RETURN 1/(n.n - 7) AS x LIMIT 1` returns the first row rather than faulting on the second, in
//! BOTH engines.
//!
//! A `SKIP` does not obey it. `CAST(a.s AS INTEGER)` faults on the first node, and asking for
//! `SKIP 1 LIMIT 1` — which cannot emit that node — faults anyway, in both engines. Adding an
//! `ORDER BY` makes the SAME query succeed, because the ordered path keeps the top-k INPUT
//! bindings and projects only the survivors.
//!
//! So the two spellings of one question disagree with each other, identically on both sides:
//!
//! ```text
//!   RETURN CAST(a.s AS INTEGER) AS x                      FAULT   (correct: row 0 is emitted)
//!   RETURN CAST(a.s AS INTEGER) AS x LIMIT 1              FAULT   (correct: row 0 is emitted)
//!   RETURN CAST(a.s AS INTEGER) AS x SKIP 1 LIMIT 1       FAULT   (row 0 is NOT emitted)
//!   RETURN CAST(a.s AS INTEGER) AS x ORDER BY a.n SKIP 1 LIMIT 1   ->  1
//! ```
//!
//! The engines AGREE on all four, so this is a conformance question against the engine's own
//! stated rule and not a cross-engine divergence — which also means the differential fuzzer
//! could never find it (item 417's lesson, that a differential fuzzer is structurally blind to a
//! bug both sides share).
//!
//! It has a measured price on the TS side: `RETURN a.u AS s SKIP 199995 LIMIT 5` over 200,000
//! nodes costs 48.8-51.3 ms to return five rows, where the same query with an `ORDER BY` costs
//! 35.5 — so **adding an ORDER BY makes it 1.45x FASTER**, because only the ordered path is
//! allowed to skip the projection. Nothing is changed here: making `SKIP` project only what it
//! emits is a behaviour change in both engines and the project's call, not an optimization
//! pass's (audit item 426).

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

fn fixture() -> Store {
    let mut b = Builder::default();
    b.node(
        &["P"],
        &[("s", Value::Str("abc".into())), ("n", Value::Num(0.0))],
    );
    for i in 1..4 {
        b.node(
            &["P"],
            &[
                ("s", Value::Str(format!("{i}").into())),
                ("n", Value::Num(f64::from(i))),
            ],
        );
    }
    b.build()
}

fn main() {
    let store = fixture();
    for q in [
        "MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x",
        "MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x SKIP 1 LIMIT 1",
        "MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x LIMIT 1",
        "MATCH (a:P) RETURN CAST(a.s AS INTEGER) AS x ORDER BY a.n SKIP 1 LIMIT 1",
    ] {
        let out = lenke_engine::gql::parse(q)
            .map_err(|e| e.to_string())
            .and_then(|raw| {
                let plan = lenke_engine::opt::optimize_indexed(raw, &store);
                lenke_engine::exec::try_run(&plan, &store).map_err(|e| e.to_string())
            });
        match out {
            Ok(b) => println!("{:?}  <= {q}", b.rows.iter().next().and_then(|r| r.first())),
            Err(e) => println!("FAULT: {}  <= {q}", &e[..e.len().min(45)]),
        }
    }
}
