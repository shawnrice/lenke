//! What does `ANY SHORTEST`'s BFS pay, and which of its PHASES does a change touch?
//!
//! `query_bench -- shortest` can only select a whole case GROUP, so every shortest-path row
//! runs in one process behind four others. That is fine for a regression sweep and wrong for
//! the question this probe exists for: an A/B that moves one row 1.27x and another 0.92x
//! cannot be read from a table whose rows share a process, because the rows interfere and
//! the ones that moved are not the ones being asked about.
//!
//! So: ONE SHAPE PER PROCESS, selected by `SHAPE`, over the same `social_store` fixture and
//! the same query texts as `query_bench`'s shortest tables. The shapes split the traversal
//! into phases that a change can hit separately:
//!
//!   count     the BFS alone              -- PathNeed::CountOnly, no chain walk, no lineage
//!   yname     the BFS + 47k output rows  -- the lineage-FREE control for the two below
//!   plen      + lineage, path SIZE only
//!   nodes     + lineage, every chain MATERIALIZED  -- the materialization-dominated row
//!   bothends  the endpoint-anchored early stop     -- the BFS with a target bitset
//!   control   a 2-hop count that never enters shortest_path at all
//!
//! `count`/`bothends` are ~100% BFS; `nodes` is ~7% BFS and ~93% chain materialization. A
//! change to the BFS that moves `nodes` and not `count` is therefore not a BFS effect, and
//! that is the distinction this probe is for.
//!
//! Native only (`std::time::Instant`). Run:
//!   SHAPE=count cargo run --release --manifest-path crates/lenke-engine/Cargo.toml \
//!     --example shortpath_2393
//! Env: SHAPE (default count), BENCH_N (fixture nodes, default 50k), BENCH_REPS (default 5),
//!      ROUNDS (independent timing rounds printed separately, default 1).

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

const ANCHOR: &str = "MATCH p = ANY SHORTEST (x:Person)-[:KNOWS]->*(y) WHERE x.name = 'name1' ";

fn query(shape: &str) -> Option<(&'static str, String)> {
    Some(match shape {
        "count" => ("count", format!("{ANCHOR}RETURN count(*) AS c")),
        "yname" => ("yname", format!("{ANCHOR}RETURN y.name AS n")),
        "plen" => ("plen", format!("{ANCHOR}RETURN path_length(p) AS len")),
        "nodes" => ("nodes", format!("{ANCHOR}RETURN nodes(p) AS ns")),
        "bothends" => (
            "bothends",
            format!("{ANCHOR}AND y.name = 'name4242' RETURN path_length(p) AS len"),
        ),
        "control" => (
            "control",
            "MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN count(*) AS c".to_string(),
        ),
        _ => return None,
    })
}

fn main() {
    let cfg = harness::Cfg::from_env();
    let shape = std::env::var("SHAPE").unwrap_or_else(|_| "count".to_string());
    let rounds: usize = std::env::var("ROUNDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);

    let Some((name, q)) = query(&shape) else {
        eprintln!("SHAPE must be one of: count yname plen nodes bothends control");
        std::process::exit(2);
    };

    let nodes = cfg.nodes(u32::MAX);
    let store = harness::social_store(nodes, 3);

    harness::section(&format!(
        "shortpath/{name} (N={} reps={rounds}x{})",
        nodes, cfg.reps
    ));
    println!("{:<12}{:>12}{:>12}", "round", "best_us", "rows");

    for r in 1..=rounds {
        match harness::time_query(&q, false, &store, cfg.reps) {
            // The row count is the ORACLE: two arms that disagree on it are not two
            // measurements of one question, and this family has shapes whose answer is a
            // path count rather than a vertex count, so the distinction is reachable.
            Ok((us, rows)) => println!("{r:<12}{us:>12.1}{rows:>12}"),
            Err(e) => println!("{r:<12}{:>12}  {e}", "n/a"),
        }
    }
}
