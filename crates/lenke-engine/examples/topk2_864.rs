//! Item 864, corrected instrument: the two SPELLINGS of a sorted LIMIT reach different code.
//!
//! The first probe measured `MATCH … RETURN x ORDER BY k LIMIT n` and attributed the result to
//! `try_scan_top_k`. Instrumenting the dispatch showed that function is never entered by that
//! query at all: a CLAUSE-position `ORDER BY` sorts above the projection, so the plan is
//! `OrderPage{Project{Scan}}` and `try_late_materialize` handles it. `try_scan_top_k` requires a
//! bare `Plan::Scan`, which is the STATEMENT-position spelling — `MATCH … ORDER BY k LIMIT n
//! RETURN x`.
//!
//! The two spellings mean the same thing, so by this repo's own rule they must cost the same. This
//! probe prints both, over the same four columns that differ only in representation, so the table
//! answers two questions at once: what each representation pays, and whether the spellings agree.
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

    println!("# item 864 — spelling x representation, {n} nodes, min of {reps}\n");
    println!("{:34} {:>10}  {:>8}", "shape", "ms", "rows");
    for (key, tag) in [
        ("age", "Num"),
        ("name", "Str"),
        ("city", "Dict8"),
        ("dept", "Dict5"),
    ] {
        for desc in ["", " DESC"] {
            let stmt =
                format!("MATCH (p:Person) ORDER BY p.{key}{desc} LIMIT 10 RETURN p.{key} AS a");
            let clause =
                format!("MATCH (p:Person) RETURN p.{key} AS a ORDER BY p.{key}{desc} LIMIT 10");
            for (spelling, q) in [("stmt", &stmt), ("clause", &clause)] {
                let label = format!("{key} [{tag}]{desc} {spelling}");
                match probe(q, &store, reps) {
                    Ok((ms, rows)) => println!("{label:34} {ms:10.3}  {rows:8}"),
                    Err(e) => println!("{label:34}        n/a  {e}"),
                }
            }
        }
    }
}
