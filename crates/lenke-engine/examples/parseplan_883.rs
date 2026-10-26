//! Item 883: the native half of the parse+plan question.
//!
//! `bun run bench:usage` is FLAT between the two spellings of an append natively (446-459k ops/s)
//! and 4.4x apart in TS, which implies native's parse+plan is cheap — but implies is not measures,
//! and the TS figures are 3.0 us to parse and 4.0 to parse+plan the same statement. So this times
//! the native side of exactly that, with a FRESH text per iteration so no cache can serve it.
//!
//! `textOnly` is the control: if formatting the query string is a large share, the arms above it
//! are measuring `format!` rather than the parser.
use lenke_engine::store::{Builder, Store};
use std::time::Instant;

fn fixture(n: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(
            &["User"],
            &[
                (
                    "name",
                    lenke_engine::value::Value::Str(format!("n{i}").into()),
                ),
                ("score", lenke_engine::value::Value::Num(f64::from(i % 100))),
            ],
        );
    }
    b.build()
}

fn main() {
    let ops: u32 = std::env::var("OPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000);
    let reps: u32 = std::env::var("REPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(7);
    let store = fixture(2_000);
    let text = |i: u32| {
        format!(
            "INSERT (:Event {{name: 'ev{i}', score: {}, seq: {i}}})",
            i % 100
        )
    };

    println!("# item 883 — native parse / parse+plan, fresh text each op, min of {reps}\n");

    let mut best = [f64::MAX; 3];
    let mut sink = 0usize;
    for _ in 0..reps {
        // textOnly
        let t = Instant::now();
        for i in 0..ops {
            sink += text(i).len();
        }
        best[0] = best[0].min(t.elapsed().as_secs_f64() * 1e6 / f64::from(ops));

        // parse only
        let t = Instant::now();
        for i in 0..ops {
            if lenke_engine::gql::parse(&text(i)).is_ok() {
                sink += 1;
            }
        }
        best[1] = best[1].min(t.elapsed().as_secs_f64() * 1e6 / f64::from(ops));

        // parse + optimize
        let t = Instant::now();
        for i in 0..ops {
            if let Ok(raw) = lenke_engine::gql::parse(&text(i)) {
                let _plan = lenke_engine::opt::optimize_indexed(raw, &store);
                sink += 1;
            }
        }
        best[2] = best[2].min(t.elapsed().as_secs_f64() * 1e6 / f64::from(ops));
    }

    // ITEM 884: the same statement at THREE sizes, so the comparison is a SLOPE and not a point.
    // The TS side reads 1.573 us at 18 chars, 3.515 at 47 and 10.487 at 158 — about 64 ns a
    // character marginal with only ~0.43 us fixed, which refuted the hypothesis that its 96
    // per-call closures dominate. One size cannot say that; three can.
    let tiny = |i: u32| format!("MATCH (n) RETURN n /*{i}*/");
    let big = |i: u32| {
        format!(
            "MATCH (a:User)-[:KNOWS]->(b:User) WHERE a.score > {} AND b.name <> 'x{i}' \
             AND a.seq >= {} RETURN a.name AS an, b.name AS bn, a.score AS s ORDER BY s DESC LIMIT 10",
            i % 50,
            i % 7
        )
    };
    let mut size_best = [f64::MAX; 2];
    for _ in 0..reps {
        let t = Instant::now();
        for i in 0..ops {
            if lenke_engine::gql::parse(&tiny(i)).is_ok() {
                sink += 1;
            }
        }
        size_best[0] = size_best[0].min(t.elapsed().as_secs_f64() * 1e6 / f64::from(ops));

        let t = Instant::now();
        for i in 0..ops {
            if lenke_engine::gql::parse(&big(i)).is_ok() {
                sink += 1;
            }
        }
        size_best[1] = size_best[1].min(t.elapsed().as_secs_f64() * 1e6 / f64::from(ops));
    }

    println!("textOnly       {:9.3} us/op", best[0]);
    println!("parse          {:9.3} us/op", best[1]);
    println!("parse+optimize {:9.3} us/op", best[2]);
    println!(
        "parse tiny     {:9.3} us/op  ({} chars)",
        size_best[0],
        tiny(1).len()
    );
    println!(
        "parse big      {:9.3} us/op  ({} chars)",
        size_best[1],
        big(1).len()
    );
    println!("\n(sink {sink}, non-zero means every arm ran)");
}
