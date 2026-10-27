//! Item 955: does the NATIVE planner seed a dotted index for the BRACKET spelling of a path?
//!
//! Item 954 found and closed the TS half: `fieldChain` accepted `kind: 'field'` and not
//! `kind: 'index'`, so `p.meta['city']` could not lift and cost 1.18x `p.meta.city` for identical
//! rows. `opt.rs` has the same shape one level up:
//!
//! ```ignore
//! fn prop_path(e: &Expr) -> Option<String> {
//!     match e {
//!         Expr::Prop { slot: 0, key } => Some(key.clone()),
//!         Expr::Field { base, key } => Some(format!("{}.{key}", prop_path(base)?)),
//!         _ => None,
//!     }
//! }
//! ```
//!
//! `Expr::Index` is absent, and natively `prop_path` does not merely pick a cheaper per-row
//! closure — it decides whether an **IndexSeek** is seeded at all. If the two spellings disagree
//! here the gap is a seek against a full scan, which is the 100-300x bug class this engine is
//! named for rather than item 954's 1.18x.
//!
//! WHAT THIS PRINTS, and why the plan comes before the timing. The optimized plan for both
//! spellings, with a dotted hash index present, plus the answer each returns. A plan dump is the
//! real signal (CLAUDE.md: *"A plan mismatch is the real signal; the time is the backstop"*), and
//! the ANSWERS are printed beside them because a seeding question is only meaningful between two
//! spellings that agree on the rows — item 947 reached its diagnosis exactly this way.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::{make_record, Value};
use std::time::Instant;

const CITIES: [&str; 4] = ["NYC", "LDN", "TYO", "BER"];

fn fixture(n: u32, indexed: bool) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        let city = CITIES[(i as usize) % CITIES.len()];
        let meta = make_record(vec![
            ("city".into(), Value::Str(city.into())),
            ("pad".into(), Value::Str(city.into())),
        ]);
        b.node(&["P"], &[("tier", Value::Str(city.into())), ("meta", meta)]);
    }
    let mut s = b.build();
    if indexed {
        s.create_index("meta.city");
    }
    s
}

fn probe(q: &str, store: &Store, reps: u32) -> Result<(f64, f64, String), String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let shape = format!("{plan:?}");
    let mut best = f64::MAX;
    let mut got = -1.0;
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
    Ok((best, got, shape))
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

    let pairs = [
        (
            "dotted  ",
            "MATCH (p:P) WHERE p.meta.city = 'NYC' RETURN count(*) AS c",
        ),
        (
            "bracket ",
            "MATCH (p:P) WHERE p.meta['city'] = 'NYC' RETURN count(*) AS c",
        ),
    ];

    for indexed in [true, false] {
        let store = fixture(n, indexed);
        println!(
            "\n=== {} a hash index on `meta.city`, {n} nodes, min of {reps} (us)",
            if indexed { "WITH" } else { "WITHOUT" }
        );

        let mut seen: Vec<(f64, f64)> = Vec::new();
        for (name, q) in pairs {
            match probe(q, &store, reps) {
                Ok((us, rows, shape)) => {
                    // The head of the plan is what decides the route; the whole debug string is
                    // long enough to bury it, so the operator name is pulled out and the full
                    // shape printed under it for a reader who wants to check.
                    let head = shape.split_whitespace().next().unwrap_or("?").to_string();
                    println!("  {name} {us:9.1} us   rows={rows:>7.0}   plan head: {head}");
                    println!("           {}", &shape[..shape.len().min(220)]);
                    seen.push((us, rows));
                }
                Err(e) => println!("  {name} ERROR {e}"),
            }
        }

        if let [(a_us, a_rows), (b_us, b_rows)] = seen[..] {
            if (a_rows - b_rows).abs() >= 0.5 {
                println!("  ROWS DIFFER ({a_rows} vs {b_rows}) — the spellings are NOT the same question");
            } else {
                println!(
                    "  ratio bracket/dotted = {:.2}x  (same {a_rows} rows)",
                    b_us / a_us
                );
            }
        }
    }
}
