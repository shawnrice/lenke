//! ⚠️ Did item 1190 divert the LABELLED-but-unfiltered hop extremum off the cheap frontier
//! collapse and onto the expensive fused mask? Neither existing probe covers this shape.
#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use support::{time_query, Cfg};

fn store_of(nodes: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();
    for i in 0..nodes {
        let n = rng.next(1_000_000);
        b.node(
            &["Person"],
            &[
                ("num", Value::Num(f64::from(n))),
                ("str", Value::Str(format!("u{i:08}").into())),
                ("dict", Value::Str(format!("g{}", n % 8).into())),
                ("bool", Value::Bool(n.is_multiple_of(2))),
            ],
        );
    }
    for i in 0..nodes {
        for _ in 0..deg {
            b.edge(i, rng.next(nodes), "KNOWS");
        }
    }
    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = store_of(nodes, 5);
    println!("\n  column   LABELLED hop min(us)   UNLABELLED hop min(us)   labelled ÷ unlabelled");
    for key in ["num", "str", "dict", "bool"] {
        let ask = |q: &str| -> f64 {
            time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us)
        };
        // The far LABEL compiles to `Filter{IsLabeled slot 1, Expand}` — a filtered hop.
        let lab = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b:Person) RETURN min(b.{key}) AS c"
        ));
        let unlab = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN min(b.{key}) AS c"
        ));
        println!(
            "  {key:<9} {lab:>18.1} {unlab:>24.1} {:>23.2}x",
            lab / unlab
        );
    }
}
