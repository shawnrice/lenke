//! Item 882: is native's 329 ms bare hop ENGINE time or FFI serialization?
//!
//! Item 881's new bench rows show `V().out('KNOWS')` at **native 329.61 ms** against TS's 185.4 —
//! native the slow side — and 4.5x native's own `V().out().id()` (72.81). But that bench runs
//! through `createFfiEngineBackend`, so the result crosses the FFI boundary: 1,000,000 FULL
//! ELEMENTS (labels and properties) against 1,000,000 id strings is a different amount of data,
//! and that alone could be the whole gap.
//!
//! This runs the same plans IN PROCESS through `exec::try_run`, which has no serialization at all.
//! If the bare hop is fast here, the 329 ms is the boundary and not the engine — a different
//! target, and arguably the correct cost of asking for a million elements.
//!
//! `rows` is printed for every case because the shapes return different ROW COUNTS and a
//! comparison that ignores that is meaningless.
use lenke_engine::store::{Builder, Store};
use std::time::Instant;

fn fixture(n: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(
            &["Person"],
            &[("age", lenke_engine::value::Value::Num(f64::from(i % 90)))],
        );
    }
    for k in 0..(n * deg) {
        b.edge((k * 7919) % n, (k * 104_729) % n, "KNOWS");
    }
    b.build()
}

fn probe(q: &str, store: &Store, reps: u32, gremlin: bool) -> Result<(f64, usize), String> {
    let raw = if gremlin {
        lenke_engine::gremlin::parse(q)?
    } else {
        lenke_engine::gql::parse(q)?
    };
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut rows = 0;
    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        rows = out.rows.len();
    }
    Ok((best, rows))
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
        .unwrap_or(5);
    let store = fixture(n, deg);

    println!("# item 882 — bare hop in process, {n} nodes x deg {deg}, min of {reps}\n");
    let cases: [(&str, &str, bool); 7] = [
        ("G V().out() [bare]", "g.V().out('KNOWS')", true),
        ("G V().out().id()", "g.V().out('KNOWS').id()", true),
        (
            "G V().out().values(age)",
            "g.V().out('KNOWS').values('age')",
            true,
        ),
        ("G V() [bare]", "g.V()", true),
        ("G V().out().count()", "g.V().out('KNOWS').count()", true),
        (
            "Q hop project far",
            "MATCH ()-[:KNOWS]->(b) RETURN b AS x",
            false,
        ),
        (
            "Q hop project far.age",
            "MATCH ()-[:KNOWS]->(b) RETURN b.age AS x",
            false,
        ),
    ];
    for (label, q, gremlin) in cases {
        match probe(q, &store, reps, gremlin) {
            Ok((ms, rows)) => println!("{label:26} {ms:9.3} ms  {rows:9} rows"),
            Err(e) => println!("{label:26}       n/a  {e}"),
        }
    }
}
