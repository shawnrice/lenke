//! Item 970: does the NATIVE engine have the page-statement gap item 969 just closed in TS?
//!
//! Item 969 folded a trailing page STATEMENT onto the `RETURN` in the TS engine and took
//! `MATCH (n:P) ORDER BY n.k LIMIT 10 RETURN n.k AS c` from 38.01 ms to 10.02 — 3.79x. Grepping
//! the pattern elsewhere is the loop's own step, and item 868 recorded that the two engines had
//! this gap in OPPOSITE directions: *"native: clause slow, items 865/866; TS: statement slow"*.
//!
//! That note is about a state two hundred items ago, so it is a reason to MEASURE rather than a
//! reason to skip. The plan is dumped beside the timing, because a cost difference between two
//! spellings in this engine IS a plan difference — both lower to one `ir::Plan`.
//!
//! The arms are item 969's, transposed: the statement spelling, the clause spelling keyed on the
//! OUTPUT column, and the clause spelling keyed on the INPUT variable (what a fold would
//! produce). All three ask for the ten smallest `k` and must return the same ten rows.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        // `k` is a scattered permutation so the sort is real work, and `lo` has five values so
        // the low-cardinality arm exists here as it does in the TS probe.
        b.node(
            &["P"],
            &[
                ("k", Value::Num(f64::from((i * 7919) % n))),
                ("lo", Value::Num(f64::from(i % 5))),
            ],
        );
    }
    b.build()
}

fn main() {
    let n: u32 = std::env::var("N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000);
    let reps: u32 = std::env::var("REPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9);
    let store = fixture(n);

    let arms: [(&str, &str); 4] = [
        (
            "stmt     ",
            "MATCH (n:P) ORDER BY n.k LIMIT 10 RETURN n.k AS c",
        ),
        (
            "clause   ",
            "MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 10",
        ),
        (
            "folded   ",
            "MATCH (n:P) RETURN n.k AS c ORDER BY n.k LIMIT 10",
        ),
        (
            "stmt lowc",
            "MATCH (n:P) ORDER BY n.lo LIMIT 10 RETURN n.k AS c",
        ),
    ];

    println!("# item 970 — the page STATEMENT against the clause spelling, natively");
    println!("# {n} nodes, min of {reps} (us). The first three must return the SAME ten rows.\n");

    let mut first: Option<String> = None;

    for (name, q) in arms {
        match lenke_engine::gql::parse(q) {
            Err(e) => println!("  {name} PARSE ERROR {e}"),
            Ok(raw) => {
                let plan = lenke_engine::opt::optimize_indexed(raw, &store);
                let mut best = f64::MAX;
                let mut shape = String::new();
                for _ in 0..reps {
                    let t = Instant::now();
                    match lenke_engine::exec::try_run(&plan, &store) {
                        Err(e) => {
                            println!("  {name} RUN ERROR {e}");
                            break;
                        }
                        Ok(out) => {
                            best = best.min(t.elapsed().as_secs_f64() * 1e6);
                            shape = format!("{:?}", out.rows);
                        }
                    }
                }
                // The first three arms are one question; the fourth keys on a different column
                // and is deliberately not compared.
                let tag = if name.starts_with("stmt lowc") {
                    "(different key)"
                } else {
                    match &first {
                        None => {
                            first = Some(shape.clone());
                            "(reference rows)"
                        }
                        Some(f) if *f == shape => "rows match",
                        Some(_) => "ROWS DIFFER — comparison VOID",
                    }
                };
                println!("  {name} {best:9.1} us   {tag}");
                println!("      {:.200}", format!("{plan:?}"));
            }
        }
    }
}
