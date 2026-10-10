//! SCRATCH PROBE (item 296) — delete after measuring. Does the frontier guard stop a runaway
//! BEFORE the allocation, and does it leave ordinary queries alone?
//!
//! The shape that took a 61 GB box into its swapfile (2026-10-10) was a fixed-length multi-hop
//! `count(*)` whose frontier fans out as `|V| x degree^hops`:
//!
//!   5 hops over 4,000 nodes at degree 5 = 12.5M rows at width 6  =  75M cells
//!   6 hops                              = 62.5M rows at width 7  = 437M cells
//!
//! `limits.intermediate` is 50M ROWS and checked AFTER `expand` returns, so the 6-hop case had
//! to materialize 62.5M rows x 7 slots — gathers and clones included — in order to be told it
//! was too many. The row cap never saw the width.
//!
//! RUN THIS UNDER THE CAP. It is the probe that caused the incident; the sizes below are chosen
//! to stay well inside 16 GB, and the point is that the guard now refuses rather than that the
//! machine survives:
//!
//!   timeout 600 systemd-run --user --scope -q -p MemoryMax=16G -p MemorySwapMax=0 \
//!     cargo run --release --manifest-path crates/lenke-engine/Cargo.toml \
//!     --example frontier_guard_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

use lenke_engine::store::{Builder, ConfigId, Store};
use lenke_engine::value::Value;

fn ring(n: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(&["P"], &[("k", Value::Num(f64::from(i % 50)))]);
    }
    for i in 0..n {
        for d in 0..deg {
            b.edge(i, (i * 7919 + d) % n, "E");
        }
    }
    b.build()
}

/// `MATCH (a:P)-[:E]->(x0)…-[:E]->(x{hops-1})` with a chosen tail.
///
/// `count(*)` is answered by the degree-product count shortcut and never reaches `Plan::Expand`
/// — which is exactly why the first version of this probe measured nothing. `count(x.k)` reads
/// the FAR property, which declines every count shortcut (item 290) and forces the real
/// expansion; a bare projection forces it too and materializes the output as well.
fn chain(hops: usize, tail: &str) -> String {
    let mut q = String::from("MATCH (a:P)");
    for h in 0..hops {
        q.push_str(&format!("-[:E]->(x{h})"));
    }
    q.push_str(&format!(" {tail}"));
    q
}

/// Whether the OPTIMIZED plan actually contains a `Plan::Expand` — the "verify the planner
/// reaches the shape" step, printed rather than assumed.
fn has_expand(p: &lenke_engine::ir::Plan) -> bool {
    format!("{p:?}").contains("Expand {")
}

fn run(store: &Store, q: &str) -> String {
    let plan = match lenke_engine::gql::parse(q) {
        Ok(p) => lenke_engine::opt::optimize_indexed(p, store),
        Err(e) => return format!("PARSE ERR {e}"),
    };
    match lenke_engine::exec::try_run(&plan, store) {
        Ok(rows) => {
            let cell = (!rows.rows.is_empty()).then(|| format!("{:?}", rows.rows[0][0]));
            format!("ok {}", cell.unwrap_or_else(|| "—".into()))
        }
        // The message is long; the CODE and the leading clause are what matters here.
        Err(e) => format!("ERR {}", &e[..e.len().min(72)]),
    }
}

fn main() {
    let cfg = harness::Cfg::from_env();
    let reps = cfg.heavy_reps();
    // 2,000 nodes at degree 5: 4 hops is 1.25M rows (fine), 5 hops 6.25M rows at width 6 =
    // 37.5M cells (fine), 6 hops 31.25M rows at width 7 = 219M cells (over the 200M default).
    let n = 2_000;
    let store = ring(n, 5);

    harness::section("the frontier guard: does it refuse, and does it leave the rest alone?");
    println!("  P={n} deg=5  reps={reps}\n");
    println!("  {:<34} {:>11}  {:<9} result", "query", "us", "plan");

    for (tail, name) in [
        ("RETURN count(*) AS c", "count(*)"),
        ("RETURN count(x0.k) AS c", "count(far.k)"),
        // A bare PROJECTION has no aggregate to tally, so it must materialize the frontier AND
        // the output. This is the shape the guard exists for; the two above are answered by
        // exec-level counting fast paths that never run the expansion at all.
        ("RETURN x0.k AS k", "project far.k"),
    ] {
        for hops in 1..=6 {
            let q = chain(hops, tail);
            // `x0` is the FIRST landed node; for the far property read it must be the LAST, so
            // the tail is rewritten per hop count.
            let q = q.replace("x0.k", &format!("x{}.k", hops - 1));
            let plan = lenke_engine::gql::parse(&q)
                .map(|p| lenke_engine::opt::optimize_indexed(p, &store));
            let expand = plan.as_ref().map(has_expand).unwrap_or(false);
            let label = format!("{hops} hop {name}");
            let t0 = std::time::Instant::now();
            let out = run(&store, &q);
            let us = t0.elapsed().as_micros();
            let mark = if expand { "EXPAND" } else { "shortcut" };
            println!("  {label:<34} {us:>11}  {mark:<9} {out}");
        }
    }

    // The knob: raising the ceiling must let the refused query through, and lowering it must
    // refuse one that passed. A guard whose limit does nothing is not a limit.
    harness::section("the limit is a knob, in both directions");
    let mut raised = ring(n, 5);
    raised.set_limit(ConfigId::LimitsIntermediateCells, u64::MAX);
    println!(
        "  {:<34} {}",
        "6 hop project, ceiling raised",
        run(&raised, &chain(6, "RETURN x5.k AS k"))
    );

    let mut lowered = ring(n, 5);
    lowered.set_limit(ConfigId::LimitsIntermediateCells, 1_000);
    println!(
        "  {:<34} {}",
        "2 hop project, ceiling 1000 cells",
        run(&lowered, &chain(2, "RETURN x1.k AS k"))
    );
    println!(
        "  {:<34} {}",
        "1 hop project, ceiling 1000 cells",
        run(&lowered, &chain(1, "RETURN x0.k AS k"))
    );
}
