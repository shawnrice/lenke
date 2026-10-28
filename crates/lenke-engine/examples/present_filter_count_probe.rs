//! Does admitting `PropertyExists` to the count-fold frontier reach the real shapes? (item 1135)
//!
//! Item 1134 priced the prize at 33.57x by ablation and located the enabling code: `chain_width`
//! sees through `Filter{IsLabeled}` only, `frontier_counts` has the matching arm, and
//! `try_frontier_count` requires that filter as its input.
//!
//! The change admits `Expr::PropertyExists` alongside it (with `present_at`, since a
//! `PropertyExists` counts a stored present-null) and lets `try_frontier_count` see through a
//! row-preserving `Project`, which is what Gremlin's `values('k')` emits.
//!
//! **It does NOT reach `outE('KNOWS').outV()`**, and the reason is worth a row of its own:
//! `chain_width` has no `EdgeVertex` arm, so an edge-then-endpoint hop is not a "chain" for the
//! count-fold paths at all. That shape keeps the general path and is measured here as evidence
//! rather than left as an assumption.
//!
//! Targets (plain `out()` hops — a real chain):
//!   T1  `g.V().out('KNOWS').has('name').count()`            Agg / Filter / Expand / Scan
//!   T2  `g.V().out('KNOWS').values('name').count()`         Agg / Project / Filter / Expand / Scan
//!   T3  `g.V().out('KNOWS').out('KNOWS').has('name').count()`   two hops
//!
//! Controls the change cannot reach:
//!   C1  `g.V().out('KNOWS').count()`                        no filter at all
//!   C2  `g.V().out('KNOWS').hasLabel('Person').count()`          the IsLabeled arm, already fast
//!   C3  `g.V().outE('KNOWS').outV().values('name').count()` EdgeVertex, not a chain
//!
//!   cargo run --release --example present_filter_count_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use support::{social_store, time_query, Cfg};

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    // DEGREE FROM THE ENVIRONMENT. Item 1138 found the native `has`/`values` pair 12x apart at
    // degree 1 on a numeric key while item 1137 measured them EQUAL at degree 5 on a string key —
    // so the degree is part of the question, not a fixture detail, and the probe has to be able
    // to ask at both.
    let deg: u32 = std::env::var("PROBE_DEG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    let store = social_store(nodes, deg);

    println!("\n# {nodes} nodes / degree {deg}, min of {}\n", cfg.reps);
    println!("  label                                   us        answer");

    // ITEM 1153: the DIRECTION enum's three variants on a plain 1-hop count. The native
    // typed-hop shortcut gates on `*dir != Dir::Out`, so In and Both both decline — and an
    // IN-expansion from a whole-graph scan yields exactly one row per edge, the same as Out.
    for (label, q) in [
        (
            "D1 out  1-hop count",
            "MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*) AS c",
        ),
        (
            "D2 in   1-hop count",
            "MATCH (a:Person)<-[:KNOWS]-(x) RETURN count(*) AS c",
        ),
        (
            "D3 both 1-hop count",
            "MATCH (a:Person)-[:KNOWS]-(x) RETURN count(*) AS c",
        ),
    ] {
        match time_query(q, false, &store, cfg.reps) {
            Ok((us, _)) => {
                let plan = lenke_engine::opt::optimize_indexed(
                    lenke_engine::gql::parse(q).expect("parses"),
                    &store,
                );
                let answer = lenke_engine::exec::try_run(&plan, &store)
                    .ok()
                    .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
                    .map_or(f64::NAN, |v| match v {
                        lenke_engine::value::Value::Num(n) => n,
                        _ => f64::NAN,
                    });
                println!("  {label:<32} {us:>10.1}   {answer}");
            }
            Err(e) => println!("  {label:<32}      ERR   {e}"),
        }
    }

    for (label, q) in [
        // THE OTHER SPELLING OF THE SAME HOP (item 1145). `out(T)` IS `outE(T).inV()` — the
        // edge's HEAD. (`outV` is the edge's SOURCE and a DIFFERENT question; the C3 row below
        // uses it deliberately and is not comparable to these.)
        ("E1 outE.inV.count", "g.V().outE('KNOWS').inV().count()"),
        (
            "E2 outE.inV.has(age).count",
            "g.V().outE('KNOWS').inV().has('age').count()",
        ),
        (
            "E3 outE.inV.values(age).count",
            "g.V().outE('KNOWS').inV().values('age').count()",
        ),
        // The NUMERIC key, which is where item 1138 saw the pair 12x apart. `name` is a Str
        // column and `age` a Num one, so these four rows separate the KEY'S TYPE from the degree.
        (
            "A1 out.has(age).count",
            "g.V().out('KNOWS').has('age').count()",
        ),
        (
            "A2 out.values(age).count",
            "g.V().out('KNOWS').values('age').count()",
        ),
        (
            "T1 out.has(name).count",
            "g.V().out('KNOWS').has('name').count()",
        ),
        (
            "T2 out.values(name).count",
            "g.V().out('KNOWS').values('name').count()",
        ),
        (
            "T3 out.out.has(name).count",
            "g.V().out('KNOWS').out('KNOWS').has('name').count()",
        ),
        (
            "C1 out.count            [ctl]",
            "g.V().out('KNOWS').count()",
        ),
        (
            "C2 out.hasLabel.count   [ctl]",
            "g.V().out('KNOWS').hasLabel('Person').count()",
        ),
        (
            "C3 outE.outV.values.cnt [ctl]",
            "g.V().outE('KNOWS').outV().values('name').count()",
        ),
    ] {
        {
            let raw = lenke_engine::gremlin::parse(q).expect("parses");
            let plan = lenke_engine::opt::optimize_indexed(raw, &store);
            println!("  PLAN1146 {label}: {plan:?}");
        }
        match time_query(q, true, &store, cfg.reps) {
            Ok((us, _)) => {
                let answer = {
                    let raw = lenke_engine::gremlin::parse(q).expect("parses");
                    let plan = lenke_engine::opt::optimize_indexed(raw, &store);
                    let r = lenke_engine::exec::try_run(&plan, &store).expect("runs");
                    match r.rows.iter().next().and_then(|row| row.first()) {
                        Some(lenke_engine::value::Value::Num(n)) => *n,
                        _ => f64::NAN,
                    }
                };
                println!("  {label:<32} {us:>10.1}   {answer}");
            }
            Err(e) => println!("  {label:<32}      ERR   {e}"),
        }
    }
}
