//! Item 1069: what does an EDGE element render pay per row, by edge-type COUNT and name LENGTH?
//!
//! `render_edges` resolves each edge's labels per row through three separate costs, where
//! `render_nodes` (item 1068) had only the third:
//!
//!   1. `edge_labels_of_refs(eid)` allocates a `Vec<&str>` PER ROW;
//!   2. it resolves each type id through `etype_name_ref`, which is a **LINEAR SCAN** over the
//!      store's `etype_ids` — so a graph with T edge types pays O(T) per label per row;
//!   3. `Value::Str(&str)` then COPIES the name's bytes, heap-allocating past `INLINE_CAP` = 12,
//!      which is exactly the defect item 391 fixed for property keys and item 1068 for node
//!      labels.
//!
//! So this sweeps BOTH axes the corpus holds fixed. `query_bench -- perrow`'s `element r` row is
//! the engine's largest single row (1,000,000 rows, ~300 ms) and its fixture has one short edge
//! type, which prices only the flat corner of both curves.
//!
//! THE CONTROLS are a scalar projection off the same edges (no element rendered, so none of the
//! three costs applies) and the T=1 short-name row (the corner the corpus already measures).
//!
//! ```text
//! cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example edgelabel_1069
//! EL_N=200000 EL_REPS=9 ... --example edgelabel_1069
//! ```
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn type_name(i: usize, len: usize) -> String {
    let mut s = format!("T{i}");

    while s.len() < len {
        s.push('x');
    }

    s
}

/// `types` distinct edge-type names of `len` characters, with every MEASURED edge carrying the
/// first of them — so the row count, the matched type and the work per row are identical across
/// arms, and only the size of the table the resolver scans changes.
fn fixture(rows: usize, types: usize, len: usize) -> Store {
    let mut b = Builder::default();
    let src = b.node(&["P"], &[("n", Value::Num(0.0))]);
    let dst = b.node(&["P"], &[("n", Value::Num(1.0))]);

    // The OTHER types exist in the store (so the resolver's table is T long) but carry one edge
    // each, which keeps them out of the measured bucket.
    for i in 1..types {
        b.edge(src, dst, &type_name(i, len));
    }

    for i in 0..rows {
        let a = b.node(&["P"], &[("n", Value::Num(i as f64))]);

        b.edge(a, dst, &type_name(0, len));
    }

    b.build()
}

fn time_q(q: &str, store: &Store, reps: usize) -> (f64, usize) {
    let raw = lenke_engine::gql::parse(q).expect("parses");
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut rows = 0;

    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).expect("runs");

        best = best.min(t.elapsed().as_secs_f64() * 1e6);
        rows = out.rows.iter().count();
    }

    (best, rows)
}

fn main() {
    let rows = env("EL_N", 100_000);
    let reps = env("EL_REPS", 5);

    println!("=== edgelabel/1069 (edge element render by TYPE COUNT and NAME LENGTH) ===");
    println!("rows={rows} reps={reps}");
    println!("{:<36} {:>11} {:>11}", "arm", "best_us", "ns/row");

    for (types, len) in [(1, 6), (1, 20), (8, 6), (8, 20), (64, 6), (64, 20)] {
        let store = fixture(rows, types, len);
        let t0 = type_name(0, len);
        let (us, got) = time_q(
            &format!("MATCH (a:P)-[e:{t0}]->(b:P) RETURN e"),
            &store,
            reps,
        );

        println!(
            "{:<36} {:>11.1} {:>11.1}",
            format!("T={types} len={len} ({got} rows)"),
            us,
            us * 1000.0 / got.max(1) as f64
        );
    }

    for (types, len) in [(1, 6), (64, 20)] {
        let store = fixture(rows, types, len);
        let t0 = type_name(0, len);
        let (us, got) = time_q(
            &format!("MATCH (a:P)-[e:{t0}]->(b:P) RETURN a.n AS n"),
            &store,
            reps,
        );

        println!(
            "{:<36} {:>11.1} {:>11.1}   CONTROL (no element)",
            format!("T={types} len={len} scalar"),
            us,
            us * 1000.0 / got.max(1) as f64
        );
    }
}
