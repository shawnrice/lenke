//! Item 450: is `CASE WHEN a.k > 5 THEN true ELSE false END` really FASTER than the bare
//! `a.k > 5` it unwraps to?
//!
//! `exprpred_437` says so — 0.216 ms against 0.351 at 200,000 nodes, reproducibly and at both
//! sizes — but that probe runs every case in ONE process, and item 274 is the standing
//! correction for exactly this: its cases shared a process and the early ones warmed a path the
//! later ones then used, which nearly confirmed a 3.4x "regression" that was not there. A 1.6x
//! read off a shared-process table is not a 1.6x.
//!
//! So: one case per process, selected by argument, same fixture, min of N. `cargo run --example
//! caseinv_450 -- <bare|case|casenoelse>`.
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

fn main() {
    let which = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "bare".to_string());
    let n: u32 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(200_000);
    let reps: u32 = std::env::args()
        .nth(3)
        .and_then(|s| s.parse().ok())
        .unwrap_or(9);
    let q = match which.as_str() {
        "bare" => "MATCH (a:Univ) WHERE a.k > 5 RETURN count(*) AS c",
        "case" => {
            "MATCH (a:Univ) WHERE (CASE WHEN a.k > 5 THEN true ELSE false END) RETURN count(*) AS c"
        }
        "casenoelse" => {
            "MATCH (a:Univ) WHERE (CASE WHEN a.k > 5 THEN true END) RETURN count(*) AS c"
        }
        // A control neither spelling can reach: a string equality on the same fixture.
        "control" => "MATCH (a:Univ) WHERE a.s = 'c42' RETURN count(*) AS c",
        other => panic!("no such case: {other}"),
    };
    let store = fixture(n);
    let raw = lenke_engine::gql::parse(q).expect("parse");
    let plan = lenke_engine::opt::optimize_indexed(raw, &store);

    // PLAN=1 prints the optimized plan instead of timing. The inversion is a ROUTE question —
    // two spellings of one predicate taking different paths — and a route question is answered by
    // reading the plan, not by timing it faster (items 439/440/441: verify the shape reaches the
    // path before measuring, and from the consumer backwards).
    if std::env::var("PLAN").is_ok() {
        println!("{which}: {plan:#?}");
        return;
    }
    let mut times: Vec<f64> = Vec::new();
    let mut rows = 0.0;

    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, &store).expect("run");
        times.push(t.elapsed().as_secs_f64() * 1e3);
        if let Some(Value::Num(c)) = out.rows.iter().next().and_then(|r| r.first()) {
            rows = *c;
        }
    }

    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{:<12} n={n:<8} min {:>8.3} ms  p25 {:>8.3}  med {:>8.3}  rows {rows}",
        which,
        times[0],
        times[times.len() / 4],
        times[times.len() / 2]
    );
}
