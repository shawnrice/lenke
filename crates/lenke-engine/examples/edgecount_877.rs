//! Item 877: why does `E().count()` cost 0.04 ms when it should be a stored length?
//!
//! `bun run bench:gremlin` leaves one row where native is the SLOW side after item 876:
//! `E().count()` at **0.04 ms** against the TS engine's 0.0. Item 412 says this is answered from
//! `live_edge_count` — "that length by construction" — and `try_scan_count` does carry a
//! `Plan::EdgeScan => store.live_edge_count()` arm. 40 µs is not a stored length, so either the
//! arm is not reached or the plan is not what the arm expects.
//!
//! So: print the PLAN for every spelling of "how many edges are there", in both front ends, next
//! to its time and its answer. A shape that reads 0.0003 ms is answering from a size; one that
//! reads 0.04 is walking something.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(&["Person"], &[("age", Value::Num(f64::from(i % 90)))]);
    }
    for k in 0..(n * deg) {
        // two edge types, so a type-filtered count is a different question from the total
        let ty = if k % 4 == 0 { "LIKES" } else { "KNOWS" };
        b.edge((k * 7919) % n, (k * 104_729) % n, ty);
    }
    b.build()
}

fn run_one(q: &str, store: &Store, reps: u32, gremlin: bool) -> (String, f64, f64) {
    let raw = if gremlin {
        lenke_engine::gremlin::parse(q)
    } else {
        lenke_engine::gql::parse(q)
    };
    let Ok(raw) = raw else {
        return ("PARSE-ERR".into(), f64::NAN, f64::NAN);
    };
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let shape = format!("{plan:?}");
    let mut best = f64::MAX;
    let mut got = f64::NAN;
    for _ in 0..reps {
        let t = Instant::now();
        match lenke_engine::exec::try_run(&plan, store) {
            Ok(out) => {
                best = best.min(t.elapsed().as_secs_f64() * 1e3);
                if let Some(row) = out.rows.iter().next() {
                    if let Value::Num(x) = &row[0] {
                        got = *x;
                    }
                }
            }
            Err(_) => return ("ERR".into(), f64::NAN, f64::NAN),
        }
    }
    (shape, best, got)
}

fn main() {
    let n: u32 = std::env::var("N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000);
    let deg: u32 = std::env::var("DEG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    let reps: u32 = std::env::var("REPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9);
    let store = fixture(n, deg);
    let plans = std::env::var("PLAN").is_ok();

    println!(
        "# item 877 — edge-count spellings, {n} nodes x deg {deg} ({} edges), min of {reps}\n",
        n * deg
    );

    let cases: [(&str, &str, bool); 8] = [
        ("G E().count()", "g.E().count()", true),
        ("G V().count()", "g.V().count()", true),
        (
            "G E().hasLabel.count()",
            "g.E().hasLabel('KNOWS').count()",
            true,
        ),
        (
            "Q ()-[]->() count",
            "MATCH ()-[]->() RETURN count(*) AS c",
            false,
        ),
        (
            "Q ()-[:KNOWS]->() count",
            "MATCH ()-[:KNOWS]->() RETURN count(*) AS c",
            false,
        ),
        ("Q () count", "MATCH () RETURN count(*) AS c", false),
        // IS A MULTI-LABEL `hasLabel` AN OR? 1,000,000 means OR (every edge is one of the two),
        // 0 means AND. This decides whether a label-set count can be a sum of partition lengths.
        (
            "G E().hasLabel(K,L)",
            "g.E().hasLabel('KNOWS','LIKES').count()",
            true,
        ),
        (
            "G E().hasLabel(none)",
            "g.E().hasLabel('NOPE').count()",
            true,
        ),
    ];
    for (label, q, gremlin) in cases {
        let (shape, ms, rows) = run_one(q, &store, reps, gremlin);

        println!("{label:26} {ms:9.4} ms  {rows:10.0} rows");
        if plans {
            println!("    {shape}");
        }
    }
}
