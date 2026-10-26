//! Item 864: what does a sorted LIMIT pay by key representation?
//!
//! CORRECTION (item 865): this file's original header credited the result to `try_scan_top_k`.
//! That was wrong. Every query here uses a CLAUSE-position `ORDER BY` (`RETURN x ORDER BY k`),
//! which sorts above the projection — so the plan is `OrderPage{Project{Scan}}`, `try_scan_top_k`
//! requires a bare `Plan::Scan` and is NEVER ENTERED by anything below (confirmed with an
//! instrumented build). What this table actually measures is `try_late_materialize`/`order_page`.
//! The statement-position spelling, which does reach the streaming top-K, is in `topk2_864`.
//!
//! The census is the function's own bail list: `ORDER BY <numeric prop> [DESC] LIMIT k` over a
//! bare `Scan` streams in O(N) time and O(k) space, and every other key column falls back to
//! `order_page` — materialize the whole frontier, build a key column and an index array, then
//! partial-sort. That is the same shape item 854 found in DISTINCT, where only the dictionary
//! representation had a path and widening it to all of them was 30.8x.
//!
//! So: the same query over four columns of one fixture, which differ ONLY in representation.
//!   age   Num,  100 distinct over N      -> the existing fast path (the control it cannot lose)
//!   name  Str,  N distinct               -> falls back
//!   city  Str,  8 distinct               -> falls back (dictionary-encoded)
//!   dept  Str,  5 distinct               -> falls back (dictionary-encoded)
//!
//! `count(*)` is the floor (reads no property) and the unlimited `ORDER BY` is the ceiling (a full
//! sort, which is what the fallback is paying for). A representation that lands on the ceiling is
//! getting no top-k treatment at all.
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
    let store = harness::social_store(n, 0);

    println!("# item 864 — top-k by key representation, {n} nodes, min of {reps}\n");
    let cases: [(&str, &str); 12] = [
        ("floor  count(*)", "MATCH (p:Person) RETURN count(*) AS c"),
        (
            "age   LIMIT 10 [Num]",
            "MATCH (p:Person) RETURN p.age AS a ORDER BY p.age LIMIT 10",
        ),
        (
            "name  LIMIT 10 [Str]",
            "MATCH (p:Person) RETURN p.name AS a ORDER BY p.name LIMIT 10",
        ),
        (
            "city  LIMIT 10 [Dict8]",
            "MATCH (p:Person) RETURN p.city AS a ORDER BY p.city LIMIT 10",
        ),
        (
            "dept  LIMIT 10 [Dict5]",
            "MATCH (p:Person) RETURN p.dept AS a ORDER BY p.dept LIMIT 10",
        ),
        (
            "age   DESC LIMIT 10",
            "MATCH (p:Person) RETURN p.age AS a ORDER BY p.age DESC LIMIT 10",
        ),
        (
            "name  DESC LIMIT 10",
            "MATCH (p:Person) RETURN p.name AS a ORDER BY p.name DESC LIMIT 10",
        ),
        (
            "ceil  age  no LIMIT",
            "MATCH (p:Person) RETURN p.age AS a ORDER BY p.age",
        ),
        (
            "ceil  name no LIMIT",
            "MATCH (p:Person) RETURN p.name AS a ORDER BY p.name",
        ),
        (
            "ceil  city no LIMIT",
            "MATCH (p:Person) RETURN p.city AS a ORDER BY p.city",
        ),
        // The FLOOR for a dictionary early exit. "Brockway" is the lexicographically smallest of
        // the eight cities, so the top-10 by city IS the first ten rows carrying it — reachable
        // after ~80 of 200,000 rows. This asks what finding exactly those ten costs, which is the
        // best a rank-bounded top-k could possibly do.
        (
            "floor dict early-exit",
            "MATCH (p:Person) WHERE p.city = 'Brockway' RETURN p.city AS a LIMIT 10",
        ),
        (
            "floor str  early-exit",
            "MATCH (p:Person) WHERE p.name = 'name0' RETURN p.name AS a LIMIT 10",
        ),
    ];
    for (label, q) in cases {
        match probe(q, &store, reps) {
            Ok((ms, rows)) => println!("{label:24} {ms:9.3} ms  {rows:7} rows"),
            Err(e) => println!("{label:24}       n/a  {e}"),
        }
    }
}
