//! SCRATCH PROBE (item 598) — delete after pricing. `bind::bind_params` builds a
//! `HashMap<&str, &Value>` on EVERY serving call:
//!
//! ```ignore
//! pub fn bind_params(plan: &mut Plan, params: &[(String, Value)]) -> Result<(), String> {
//!     let map: HashMap<&str, &Value> = params.iter().map(|(k, v)| (k.as_str(), v)).collect();
//!     bind_plan(plan, &map)
//! }
//! ```
//!
//! That is a heap allocation plus a SipHash-1-3 insert per parameter and a SipHash per `$name`
//! occurrence, for what a serving query typically has ONE of. There is exactly one lookup site
//! (`bind_expr`'s `Expr::Param` arm), so the alternative is to hand `bind_plan` the slice itself
//! and scan it.
//!
//! The question is not "is a scan faster at P=1" — it obviously is — but WHERE IT STOPS BEING
//! FASTER, because a scan is O(P) per lookup against the map's O(1). A query with many parameters
//! or many occurrences is the case that could regress, so this sweeps both.
//!
//! Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example bind_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

use std::collections::HashMap;

use lenke_engine::value::Value;

/// Nanoseconds per iteration, min over `reps` rounds of `iters`.
fn ns_per_op(reps: usize, iters: usize, mut f: impl FnMut()) -> f64 {
    let mut best = f64::INFINITY;

    for _ in 0..reps {
        let t0 = std::time::Instant::now();

        for _ in 0..iters {
            f();
        }

        let ns = t0.elapsed().as_nanos() as f64 / iters as f64;

        if ns < best {
            best = ns;
        }
    }

    best
}

fn params_of(n: usize) -> Vec<(String, Value)> {
    (0..n)
        .map(|i| (format!("p{i}"), Value::Num(f64::from(i as u32))))
        .collect()
}

/// The names a plan's `Expr::Param` arms would look up, in the order they appear. Spread over the
/// available parameters so a scan pays its average position, not always the first.
fn lookups(n_params: usize, occurrences: usize) -> Vec<String> {
    (0..occurrences)
        .map(|i| format!("p{}", i % n_params.max(1)))
        .collect()
}

fn main() {
    let cfg = harness::Cfg::from_env();
    let reps = cfg.heavy_reps();
    let iters = 200_000;

    harness::section("bind_params' lookup table: a HashMap build vs a slice scan");
    println!("  iters={iters} reps={reps}");
    println!(
        "\n  {:<8} {:<8} {:>12} {:>12} {:>10}",
        "params", "lookups", "hashmap ns", "scan ns", "ratio"
    );

    for &n in &[0usize, 1, 2, 3, 4, 8, 16, 32] {
        let params = params_of(n);

        for &occ in &[1usize, 4, 16] {
            if n == 0 && occ > 1 {
                continue;
            }

            let names = lookups(n, if n == 0 { 0 } else { occ });

            // THE MAP ROUTE: build the table, then do every lookup through it — exactly what
            // `bind_params` + `bind_expr` do today.
            let map_ns = ns_per_op(reps, iters, || {
                let map: HashMap<&str, &Value> =
                    params.iter().map(|(k, v)| (k.as_str(), v)).collect();
                let mut found = 0usize;

                for name in &names {
                    if map.contains_key(name.as_str()) {
                        found += 1;
                    }
                }

                std::hint::black_box(found);
            });

            // THE SCAN ROUTE: no table at all, a linear find per lookup.
            let scan_ns = ns_per_op(reps, iters, || {
                let mut found = 0usize;

                for name in &names {
                    if params.iter().any(|(k, _)| k == name) {
                        found += 1;
                    }
                }

                std::hint::black_box(found);
            });

            println!(
                "  {:<8} {:<8} {map_ns:>12.1} {scan_ns:>12.1} {:>9.2}x",
                n,
                if n == 0 { 0 } else { occ },
                map_ns / scan_ns
            );
        }
    }

    // What a REAL serving call looks like, for scale: the empty case (every param-less query, and
    // `bind_params` runs on those too) and the one-param point lookup.
    println!("\n  for scale — the two shapes that actually dominate bench:usage:");

    for (label, n, occ) in [
        ("param-less query", 0usize, 0usize),
        ("one param, used once", 1, 1),
    ] {
        let params = params_of(n);
        let names = lookups(n, occ);
        let map_ns = ns_per_op(reps, iters, || {
            let map: HashMap<&str, &Value> = params.iter().map(|(k, v)| (k.as_str(), v)).collect();

            for name in &names {
                std::hint::black_box(map.get(name.as_str()));
            }
        });
        let scan_ns = ns_per_op(reps, iters, || {
            for name in &names {
                std::hint::black_box(params.iter().find(|(k, _)| k == name));
            }
        });

        println!(
            "  {label:<26} hashmap {map_ns:>7.1}  scan {scan_ns:>7.1}  {:>5.2}x",
            map_ns / scan_ns
        );
    }
}
