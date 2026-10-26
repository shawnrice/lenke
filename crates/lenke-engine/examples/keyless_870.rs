//! Item 870: does the NATIVE engine have item 869's keyless-LIMIT defect?
//!
//! In the TS engine a keyless statement `LIMIT` forced the whole working table and sliced, costing
//! 36.68 ms against 0.04 for the clause-position spelling of the same query — 917x, fixed at item
//! 869 by taking the window lazily. Natively there IS a `pull_capped` for keyless pages, so the
//! defect probably is not here — but "probably not" is what item 843's rule exists to refuse, and
//! the two engines have now mirrored each other on sorted-LIMIT spellings twice (865/866 vs 868).
//! So it gets measured.
//!
//! Both spellings, with and without an OFFSET, against a `count(*)` floor that reads no property
//! and an unpaged projection that is the ceiling (it must build every row). A capped keyless page
//! should sit near the floor; one that materializes first should sit near the ceiling.
use lenke_engine::store::Store;
use std::time::Instant;

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

fn probe(q: &str, store: &Store, reps: u32) -> Result<(f64, usize), String> {
    let raw = lenke_engine::gql::parse(q)?;
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
    let reps: u32 = std::env::var("REPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9);
    let store = harness::social_store(n, 2);

    println!("# item 870 — keyless LIMIT by spelling, {n} nodes, min of {reps}\n");
    let cases: [(&str, &str); 15] = [
        ("floor  count(*)", "MATCH (p:Person) RETURN count(*) AS c"),
        (
            "stmt   LIMIT 10",
            "MATCH (p:Person) LIMIT 10 RETURN p.age AS a",
        ),
        (
            "clause LIMIT 10",
            "MATCH (p:Person) RETURN p.age AS a LIMIT 10",
        ),
        (
            "stmt   OFFSET 5 LIMIT 10",
            "MATCH (p:Person) OFFSET 5 LIMIT 10 RETURN p.age AS a",
        ),
        (
            "clause SKIP 5 LIMIT 10",
            "MATCH (p:Person) RETURN p.age AS a SKIP 5 LIMIT 10",
        ),
        (
            "stmt   LIMIT 10 (str key)",
            "MATCH (p:Person) LIMIT 10 RETURN p.name AS a",
        ),
        (
            "clause LIMIT 10 (str key)",
            "MATCH (p:Person) RETURN p.name AS a LIMIT 10",
        ),
        // `pull_capped` only admits a row-PRESERVING Scan/Seek/Project chain. A FILTER or an
        // EXPAND needs more input rows than it yields, so those fall to `pull_capped_stream` —
        // a different mechanism, and the one worth asking about separately.
        (
            "stmt   WHERE + LIMIT 10",
            "MATCH (p:Person) WHERE p.age > 50 LIMIT 10 RETURN p.age AS a",
        ),
        (
            "clause WHERE + LIMIT 10",
            "MATCH (p:Person) WHERE p.age > 50 RETURN p.age AS a LIMIT 10",
        ),
        (
            "stmt   hop + LIMIT 10",
            "MATCH (p:Person)-[:KNOWS]->(q) LIMIT 10 RETURN q.age AS a",
        ),
        (
            "clause hop + LIMIT 10",
            "MATCH (p:Person)-[:KNOWS]->(q) RETURN q.age AS a LIMIT 10",
        ),
        (
            "stmt   SELECTIVE WHERE + LIMIT 10",
            "MATCH (p:Person) WHERE p.age = 7 LIMIT 10 RETURN p.age AS a",
        ),
        (
            "clause SELECTIVE WHERE + LIMIT 10",
            "MATCH (p:Person) WHERE p.age = 7 RETURN p.age AS a LIMIT 10",
        ),
        ("ceil   no LIMIT", "MATCH (p:Person) RETURN p.age AS a"),
        (
            "ceil   hop no LIMIT",
            "MATCH (p:Person)-[:KNOWS]->(q) RETURN q.age AS a",
        ),
    ];
    for (label, q) in cases {
        match probe(q, &store, reps) {
            Ok((ms, rows)) => println!("{label:28} {ms:9.4} ms  {rows:7} rows"),
            Err(e) => println!("{label:28}       n/a  {e}"),
        }
    }
}
