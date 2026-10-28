//! Does the edge-label ARITY enum have an uncovered variant? (item 1157)
//!
//! `typed_hop_count_from_size` matches on the hop's label list and answers two of its three
//! shapes in O(1):
//!
//! ```text
//!   []     untyped   -> live_edge_count()
//!   [ty]   one type  -> live_etype_count(t)
//!   _      MULTIPLE  -> None
//! ```
//!
//! That is the same shape items 1153-1155 found in the DIRECTION enum — a fast path covering some
//! variants of an enum, with the uncovered one unpriced — and the method says to go looking for it
//! rather than wait for it.
//!
//! A DEDICATED FIXTURE, not `social_store`: that one makes a single edge type, so it cannot ask
//! this question at all, and widening a fixture several benches share is how item 1130's
//! comparisons went bad. Two types here, single-labelled, so the multi-type answer must equal the
//! sum of the two single-type answers.
//!
//!   cargo run --release --example label_arity_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};

use support::{time_query, Cfg};

fn two_type_store(nodes: u32, deg: u32) -> Store {
    let mut b = Builder::default();

    for _ in 0..nodes {
        b.node(&["Person"], &[]);
    }

    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        for d in 0..deg {
            // Alternate the type so both partitions are large, and single-label so a multi-type
            // hop cannot double-count an edge.
            let ty = if d % 2 == 0 { "KNOWS" } else { "FOLLOWS" };

            b.edge(i, rng.next(nodes), ty);
        }
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let deg: u32 = std::env::var("ARITY_DEG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    let store = two_type_store(nodes, deg);

    println!(
        "\n# {nodes} nodes / degree {deg} over TWO edge types, min of {}\n",
        cfg.reps
    );
    println!("  label arity                             us        answer");

    for (label, q) in [
        (
            "A1 one type   [:KNOWS]",
            "MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*) AS c",
        ),
        (
            "A2 one type   [:FOLLOWS]",
            "MATCH (a:Person)-[:FOLLOWS]->(x) RETURN count(*) AS c",
        ),
        (
            "A3 TWO types  [:KNOWS|FOLLOWS]",
            "MATCH (a:Person)-[:KNOWS|FOLLOWS]->(x) RETURN count(*) AS c",
        ),
        (
            "A4 untyped    []            [ctl]",
            "MATCH (a:Person)-[]->(x) RETURN count(*) AS c",
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

                println!("  {label:<34} {us:>10.1}   {answer}");
            }
            Err(e) => println!("  {label:<34}      ERR   {e}"),
        }
    }
}
