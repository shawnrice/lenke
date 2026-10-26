//! Item 876: what does a VACUOUS label cost the native engine?
//!
//! `bun run bench:gremlin` shows `V().hasLabel('Person').out('KNOWS').count()` at **0.50 ms**
//! natively against **0.00** for `V().out('KNOWS').count()` — and the fixture gives EVERY vertex
//! the `Person` label, so the two are the same question. The TS engine answers both at 0.0 because
//! it has a `vacuousLabel` elision (`shortcuts.ts`); this asks whether native has one.
//!
//! Two spellings of one question differing by a constant factor is this repo's named defect class,
//! so the shape is worth pricing whichever way it comes out.
//!
//! THE SELECTIVE CASE IS THE CONTROL THAT MATTERS. An elision is only sound when the label covers
//! every live vertex; a label that does not must keep filtering. So the probe carries both a
//! vacuous label and a selective one, and prints the ROW COUNT, because an elision that fired when
//! it should not have would look like a spectacular win.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        // EVERY vertex is a `Person`; one in fifty is additionally a `Staff`, which is the
        // selective label the elision must decline.
        if i % 50 == 0 {
            b.node(
                &["Person", "Staff"],
                &[("age", Value::Num(f64::from(i % 90)))],
            );
        } else {
            b.node(&["Person"], &[("age", Value::Num(f64::from(i % 90)))]);
        }
    }
    for k in 0..(n * deg) {
        b.edge((k * 7919) % n, (k * 104_729) % n, "KNOWS");
    }
    b.build()
}

fn probe(q: &str, store: &Store, reps: u32, gremlin: bool) -> Result<(f64, f64), String> {
    let raw = if gremlin {
        lenke_engine::gremlin::parse(q)?
    } else {
        lenke_engine::gql::parse(q)?
    };
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut got = 0.0;
    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        if let Some(row) = out.rows.iter().next() {
            if let Value::Num(x) = &row[0] {
                got = *x;
            }
        }
    }
    Ok((best, got))
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

    println!("# item 876 — vacuous vs selective label, {n} nodes x deg {deg}, min of {reps}\n");

    if std::env::var("TOMB").is_ok() {
        // Does a DELETED vertex stay in its label's id list? That decides whether the
        // live-count half of `whole_graph_scan` is load-bearing or redundant.
        let mut h = fixture(100, 3);
        println!(
            "before: node_count={} live={} person_list={}",
            h.node_count(),
            h.live_node_count(),
            h.nodes_with_label("Person").len()
        );
        h.delete_node(7);
        println!(
            "after : node_count={} live={} person_list={}",
            h.node_count(),
            h.live_node_count(),
            h.nodes_with_label("Person").len()
        );
        return;
    }
    if std::env::var("PLAN").is_ok() {
        for q in [
            "MATCH ()-[:KNOWS]->() RETURN count(*) AS c",
            "MATCH (p:Person)-[:KNOWS]->() RETURN count(*) AS c",
            "MATCH (p:Staff)-[:KNOWS]->() RETURN count(*) AS c",
        ] {
            let raw = lenke_engine::gql::parse(q).unwrap();
            let plan = lenke_engine::opt::optimize_indexed(raw, &store);
            println!("Q: {q}\n   {plan:?}\n");
        }
        return;
    }

    let gremlin: [(&str, &str); 6] = [
        ("G no label    out.count", "g.V().out('KNOWS').count()"),
        (
            "G VACUOUS     out.count",
            "g.V().hasLabel('Person').out('KNOWS').count()",
        ),
        (
            "G SELECTIVE   out.count",
            "g.V().hasLabel('Staff').out('KNOWS').count()",
        ),
        ("G no label    count", "g.V().count()"),
        ("G VACUOUS     count", "g.V().hasLabel('Person').count()"),
        ("G SELECTIVE   count", "g.V().hasLabel('Staff').count()"),
    ];
    for (label, q) in gremlin {
        match probe(q, &store, reps, true) {
            Ok((ms, rows)) => println!("{label:26} {ms:9.4} ms  {rows:10.0} rows"),
            Err(e) => println!("{label:26}       n/a  {e}"),
        }
    }

    println!();
    // The GQL spelling of the same questions, because a shortcut that only one front end reaches
    // is the other half of this repo's spelling rule.
    let gql: [(&str, &str); 4] = [
        (
            "Q no label    hop count",
            "MATCH ()-[:KNOWS]->() RETURN count(*) AS c",
        ),
        (
            "Q VACUOUS     hop count",
            "MATCH (p:Person)-[:KNOWS]->() RETURN count(*) AS c",
        ),
        (
            "Q SELECTIVE   hop count",
            "MATCH (p:Staff)-[:KNOWS]->() RETURN count(*) AS c",
        ),
        (
            "Q VACUOUS     count",
            "MATCH (p:Person) RETURN count(*) AS c",
        ),
    ];
    for (label, q) in gql {
        match probe(q, &store, reps, false) {
            Ok((ms, rows)) => println!("{label:26} {ms:9.4} ms  {rows:10.0} rows"),
            Err(e) => println!("{label:26}       n/a  {e}"),
        }
    }
}
