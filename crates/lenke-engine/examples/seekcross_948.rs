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

/// `FRACS=2,3,4,5,6,8` overrides the swept percentages (item 988).
///
/// The default set answers "which way does each decade go"; it CANNOT locate a crossover that
/// falls between two of its points, and after item 982 made the bare-bool filter arm faster this
/// one does — the sweep flips between 2% and 10% with nothing in between. A constant read off a
/// gap between samples is a guess, so the instrument has to be able to sample the gap.
fn fractions() -> Vec<u32> {
    std::env::var("FRACS").ok().map_or_else(
        || FRACTIONS.to_vec(),
        |s| {
            s.split(',')
                .filter_map(|p| p.trim().parse::<u32>().ok())
                .filter(|p| *p > 0 && *p < 100)
                .collect()
        },
    )
}

fn key_of(pct: u32) -> String {
    format!("b{pct:02}")
}

/// `INDEXED=1` builds the same fixture WITH a hash index on every swept key (item 978).
///
/// Item 949 left this open in as many words: *"Whether a bool column's INDEXED seek breaks even
/// at 3% or 15% is a real question and this session has no measurement of it."* The sweep below
/// measures the NO-INDEX degraded seek; `scan_is_cheap`, the thing that would be widened, is on
/// the INDEXED path — all four of its call sites are behind an index check — so the un-indexed
/// curve cannot price it. This mode is the missing half.
fn fixture(n: u32, fracs: &[u32]) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        // Scattered rather than a prefix: `97` is coprime with 100, so each column's true rows are
        // spread across the whole id space instead of forming one contiguous block.
        let spread = (i * 97) % 100;
        let props: Vec<(String, Value)> = fracs
            .iter()
            .map(|pct| (key_of(*pct), Value::Bool(spread < *pct)))
            .collect();
        let mut borrowed: Vec<(&str, Value)> =
            props.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        // A STRING column, for `PLANTIME`'s control: the gate declines on it by type, so it
        // isolates the gate's dispatch from the column scan the bool keys pay (item 989).
        borrowed.push(("tag", Value::Str(format!("t{spread:02}").into())));
        b.node(&["P"], &borrowed);
    }
    b.build()
}

/// The ROUTE each arm actually took, not the one its spelling suggests (item 978).
///
/// This mattered the moment `INDEXED=1` existed: the `= true` column is an `IndexSeek` only
/// while the gate admits one. From 20% up the gate correctly DECLINES and the arm becomes
/// `Filter { Scan, Compare }` — so the column silently stops measuring seek-against-scan and
/// starts measuring `Compare{Eq,Bool}`-against-bare-`Prop`. A table whose column changes meaning
/// halfway down is the defect item 973 found in a stored absolute; printing the route per row is
/// what stops this one doing the same.
fn route_of(plan: &lenke_engine::ir::Plan) -> &'static str {
    let s = format!("{plan:?}");
    if s.contains("IndexSeek") {
        "seek  "
    } else {
        "filter"
    }
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

fn probe_routed(q: &str, store: &Store, reps: u32) -> Result<(f64, f64, &'static str), String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let route = route_of(&plan);
    let (us, rows) = probe(q, store, reps)?;
    Ok((us, rows, route))
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
    let fracs = fractions();
    let mut store = fixture(n, &fracs);

    if std::env::var("INDEXED").is_ok() {
        for pct in fracs.iter().copied() {
            store.create_index(&key_of(pct));
        }
        println!("# INDEXED: a hash index on every swept key\n");
    }
    let store = store;

    if std::env::var("PLAN").is_ok() {
        for pct in fracs.iter().copied() {
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

    // `PLANTIME=1`: what the no-index gate costs the OPTIMIZER (item 989).
    //
    // The sweep below optimizes once and times only execution, so it cannot see this at all. The
    // gate counts the bool column to price the seed, which is O(min(N, cap)) — bounded where the
    // predicate is unselective (it saturates) and a FULL column walk where it is selective, which
    // is the case the gate goes on to seed anyway. That cost is real and lands on a COLD plan, so
    // it needs its own number rather than an argument.
    //
    // The control is the same query shape over a STRING key: `unindexed_eq_fraction` answers
    // `None` for a non-bool column after a map lookup and a type check, so the control is the
    // gate's own dispatch minus its scan, and the difference between the columns is the scan.
    if std::env::var("PLANTIME").is_ok() {
        println!("# item 989 — what the no-index gate costs at PLAN time ({n} nodes, min of {reps} us)\n");
        println!("  key          optimize(us)   note");
        let reps = reps.max(50);
        let mut cases: Vec<(String, String)> = fracs
            .iter()
            .map(|pct| {
                (
                    format!("b{pct:02} (bool)"),
                    format!(
                        "MATCH (p:P) WHERE p.{} = true RETURN count(*) AS c",
                        key_of(*pct)
                    ),
                )
            })
            .collect();
        cases.push((
            "tag (string)".to_string(),
            "MATCH (p:P) WHERE p.tag = 'zz' RETURN count(*) AS c".to_string(),
        ));
        for (name, q) in cases {
            let raw = lenke_engine::gql::parse(&q).unwrap();
            let mut best = f64::MAX;
            for _ in 0..reps {
                let r = raw.clone();
                let t = Instant::now();
                let plan = lenke_engine::opt::optimize_indexed(r, &store);
                best = best.min(t.elapsed().as_secs_f64() * 1e6);
                std::hint::black_box(&plan);
            }
            let note = if name.ends_with("(string)") {
                "CONTROL — the gate declines on type, no scan"
            } else {
                ""
            };
            println!("  {name:12}   {best:12.1}   {note}");
        }
        return;
    }

    println!("# item 948 — degraded (no-index) SEEK against Filter(Scan), by selectivity");
    println!("# {n} nodes, min of {reps} (us). Both spellings select the SAME rows.\n");
    println!("  true%   seek(= true)   filter(bare)    seek/filter   rows   winner");

    for pct in fracs.iter().copied() {
        let k = key_of(pct);
        let seek = probe_routed(
            &format!("MATCH (p:P) WHERE p.{k} = true RETURN count(*) AS c"),
            &store,
            reps,
        );
        let filt = probe_routed(
            &format!("MATCH (p:P) WHERE p.{k} RETURN count(*) AS c"),
            &store,
            reps,
        );
        match (seek, filt) {
            (Ok((su, sr, sroute)), Ok((fu, fr, _))) => {
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
                    "  {pct:5}   {su:12.1}   {fu:12.1}   {ratio:11.2}x   {sr:>6.0}   [{sroute}] {winner}"
                );
            }
            (Err(e), _) | (_, Err(e)) => println!("  {pct:5}   ERROR {e}"),
        }
    }
}
