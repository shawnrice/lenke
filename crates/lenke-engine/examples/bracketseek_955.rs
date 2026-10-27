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

/// `EQUIV=1`: do `x.y` and `x['y']` return the SAME value on every base kind a path segment can
/// meet (item 956)?
///
/// Item 955 made this a precondition of the `prop_path` fix and said why: item 954's TS reading
/// predicted a divergence that did not exist, so the equivalence must be MEASURED, and one record
/// base is one base kind rather than five. A seeding change folds `['y']` into the same index key
/// as `.y`, which is only sound if the two read the same cell everywhere — and where they differ,
/// seeding the bracket form would return a WRONG answer, not a slow one.
fn equivalence() {
    let mut b = Builder::default();
    let rec = make_record(vec![("y".into(), Value::Str("hit".into()))]);
    b.node(
        &["P"],
        &[
            ("rec", rec),
            ("scalar", Value::Str("plain".into())),
            ("n", Value::Num(1.0)),
            (
                "lst",
                Value::List(vec![Value::Str("a".into()), Value::Str("b".into())]),
            ),
        ],
    );
    let store = b.build();

    let read = |expr: &str| -> String {
        let q = format!("MATCH (p:P) RETURN {expr} AS v");
        match lenke_engine::gql::parse(&q) {
            Err(e) => format!("PARSE-ERR {e}"),
            Ok(raw) => {
                let plan = lenke_engine::opt::optimize_indexed(raw, &store);
                match lenke_engine::exec::try_run(&plan, &store) {
                    Err(e) => format!("THROW {e}"),
                    Ok(out) => out
                        .rows
                        .iter()
                        .next()
                        .map_or("<no row>".to_string(), |r| format!("{:?}", r[0])),
                }
            }
        }
    };

    println!("\n=== EQUIV: does `x.y` read the same cell as `x['y']`, by base kind?");
    let mut all_agree = true;
    for (label, base) in [
        ("record", "p.rec"),
        ("scalar", "p.scalar"),
        ("absent", "p.nosuch"),
        ("number", "p.n"),
        ("list", "p.lst"),
    ] {
        let a = read(&format!("{base}.y"));
        let c = read(&format!("{base}['y']"));
        let same = a == c;
        all_agree &= same;
        println!(
            "  {:7} {:14} -> {:16} {:18} -> {:16} {}",
            label,
            format!("{base}.y"),
            a,
            format!("{base}['y']"),
            c,
            if same { "agree" } else { "DIFFER" }
        );
    }
    println!(
        "  => {}",
        if all_agree {
            "every base kind agrees — folding `['y']` into the path is sound"
        } else {
            "a base kind DIFFERS — the fold would change an answer, do NOT build it"
        }
    );
}

fn main() {
    if std::env::var("EQUIV").is_ok() {
        equivalence();
        return;
    }

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
