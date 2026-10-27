//! Item 948: where does the NO-INDEX degraded seek stop beating `Filter(Scan)`?
//!
//! Item 947 diagnosed a 3.18x: `p.bul = false` lowers to an `IndexSeek` for a value matching 98%
//! of the label, while the row-matched `NOT p.bul` gets `Filter(Scan)`. The equality seed rule
//! splits on whether a hash index exists and the NO-INDEX half seeds UNCONDITIONALLY, justified by
//! a measurement at ONE point: *"the seek degrades to a typed column scan inside `index_seek_ids`,
//! which is the FASTEST of the three shapes here — 194.7us on a 20%-selectivity key, against
//! 291.7us for the `Filter(Scan)`"* (E75).
//!
//! That is right at 2% and at 20% and wrong at 98%, so the rule needs the CURVE it was never given.
//!
//! WHY A NEW EXAMPLE RATHER THAN A ROW IN AN EXISTING ONE. `filtercensus_871` varies the column
//! REPRESENTATION at a fixed selectivity; `query_bench -- seeded` asks whether an INDEXED key seek
//! beats a scan. Neither sweeps selectivity for the no-index degraded seek, and the constant that
//! governs it cannot be borrowed: `SEEK_MAX_FRACTION = 0.154` comes from E64/E65 (scan 1.88 ns a
//! node against seek 12.2 ns a row), which is the HASH-INDEX curve — a different pair of routes.
//!
//! THE PAIR, and it is row-matched by construction. A boolean column whose TRUE fraction is dialled
//! per column gives two spellings of one question over the identical rows:
//!
//!   `WHERE p.bXX = true`   ->  IndexSeek  (no hash index, so the degraded typed-column scan)
//!   `WHERE p.bXX`          ->  Filter { Scan, Prop }
//!
//! Both select the same X% and return the same count, so the ratio is the ROUTE and nothing else.
//! `PLAN=1` prints both plans per fraction, because a sweep whose routes are assumed is a sweep of
//! nothing — item 947 reached its diagnosis only by dumping the plan.
//!
//! THE TRUE ROWS ARE SCATTERED, not a prefix. `(i * 97) % 100` spreads them across the id space, so
//! the seek materialises a scattered id list — the shape item 947 flagged as possibly load-bearing.
//! A CLUSTERED variant is a separate axis and is deliberately not measured here; saying so is the
//! point, since a crossover read off scattered ids must not be quoted for clustered ones.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

/// The true-fractions swept, as percentages.
const FRACTIONS: [u32; 7] = [2, 10, 20, 40, 60, 80, 98];

fn key_of(pct: u32) -> String {
    format!("b{pct:02}")
}

fn fixture(n: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        // Scattered rather than a prefix: `97` is coprime with 100, so each column's true rows are
        // spread across the whole id space instead of forming one contiguous block.
        let spread = (i * 97) % 100;
        let props: Vec<(String, Value)> = FRACTIONS
            .iter()
            .map(|pct| (key_of(*pct), Value::Bool(spread < *pct)))
            .collect();
        let borrowed: Vec<(&str, Value)> =
            props.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        b.node(&["P"], &borrowed);
    }
    b.build()
}

fn probe(q: &str, store: &Store, reps: u32) -> Result<(f64, f64), String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut got = 0.0;
    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e6);
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
    let reps: u32 = std::env::var("REPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9);
    let store = fixture(n);

    if std::env::var("PLAN").is_ok() {
        for pct in FRACTIONS {
            let k = key_of(pct);
            for q in [
                format!("MATCH (p:P) WHERE p.{k} = true RETURN count(*) AS c"),
                format!("MATCH (p:P) WHERE p.{k} RETURN count(*) AS c"),
            ] {
                let raw = lenke_engine::gql::parse(&q).unwrap();
                let plan = lenke_engine::opt::optimize_indexed(raw, &store);
                println!("\nQ: {q}\n{plan:?}");
            }
        }
        return;
    }

    println!("# item 948 — degraded (no-index) SEEK against Filter(Scan), by selectivity");
    println!("# {n} nodes, min of {reps} (us). Both spellings select the SAME rows.\n");
    println!("  true%   seek(= true)   filter(bare)    seek/filter   rows   winner");

    for pct in FRACTIONS {
        let k = key_of(pct);
        let seek = probe(
            &format!("MATCH (p:P) WHERE p.{k} = true RETURN count(*) AS c"),
            &store,
            reps,
        );
        let filt = probe(
            &format!("MATCH (p:P) WHERE p.{k} RETURN count(*) AS c"),
            &store,
            reps,
        );
        match (seek, filt) {
            (Ok((su, sr)), Ok((fu, fr))) => {
                // A ratio between two arms answering different questions is meaningless; the pair
                // is only row-matched if both counts agree, so this is checked rather than assumed.
                let agree = (sr - fr).abs() < 0.5;
                let ratio = su / fu;
                let winner = if !agree {
                    "ROWS DIFFER — ratio void"
                } else if ratio < 0.95 {
                    "seek"
                } else if ratio > 1.05 {
                    "FILTER"
                } else {
                    "tie"
                };
                println!(
                    "  {pct:5}   {su:12.1}   {fu:12.1}   {ratio:11.2}x   {sr:>6.0}   {winner}"
                );
            }
            (Err(e), _) | (_, Err(e)) => println!("  {pct:5}   ERROR {e}"),
        }
    }
}
