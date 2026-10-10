//! SCRATCH PROBE (item 291) — delete after pricing. `bun run bench:usage` shows the native
//! engine LOSING 3-5x to pure TS on every indexed small-op row, which is the realistic serving
//! case and the opposite direction from the bulk benches. Decomposed through the FFI:
//!
//!   raw FFI boundary (vertexCount)                 7 ns
//!   TextEncoder.encode(query)                     18 ns
//!   JS decode + JSON.parse of a 30-byte carrier  145 ns
//!   prepared query, ONE row                     2018 ns
//!   prepared query, ZERO rows (seek, no render) 1865 ns   <- fixed, and the target
//!   unprepared g.query() (adds parse+plan)      2985 ns
//!
//! So the boundary is free (0.2%), parse+plan is ~925ns, the row itself is ~153ns — and **1865ns
//! is fixed per-call overhead that is neither exec nor render**. This probe asks which SIDE of
//! the FFI that lives on, by running the same optimized plan in-process with no FFI at all.
//!
//! If `try_run` on a pre-optimized plan is ~100ns, the ~1.7us is FFI plumbing (the error slot,
//! `catch_unwind`, the output buffer, the JSON writer) and the engine is not the problem.
//! If it is ~1.8us, the cost is exec and the FFI is incidental.
//!
//! Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example percall_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod harness;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

fn indexed_users(n: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(
            &["User"],
            &[
                ("name", Value::Str(format!("name{i}").into())),
                ("score", Value::Num(f64::from(i % 100))),
            ],
        );
    }
    let mut store = b.build();
    store.create_index("name");
    store
}

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

fn main() {
    let cfg = harness::Cfg::from_env();
    let n = cfg.nodes(20_000);
    let store = indexed_users(n);
    let reps = cfg.heavy_reps();
    let iters = 20_000;

    let hit = "MATCH (u:User) WHERE u.name = 'name7' RETURN u.score AS s";
    let miss = "MATCH (u:User) WHERE u.name = 'nobody' RETURN u.score AS s";

    harness::section("where the native per-call cost lives (no FFI)");
    println!("  User={n} iters={iters} reps={reps}\n");
    println!("  {:<46} {:>10}", "layer", "ns/op");

    // The plans, optimized ONCE — the prepared statement's state.
    let plan_hit =
        lenke_engine::opt::optimize_indexed(lenke_engine::gql::parse(hit).expect("parses"), &store);
    let plan_miss = lenke_engine::opt::optimize_indexed(
        lenke_engine::gql::parse(miss).expect("parses"),
        &store,
    );

    // 1. EXEC ALONE on a pre-optimized plan — the prepared statement's real work.
    let exec_hit = ns_per_op(reps, iters, || {
        let _ = lenke_engine::exec::try_run(&plan_hit, &store);
    });
    let exec_miss = ns_per_op(reps, iters, || {
        let _ = lenke_engine::exec::try_run(&plan_miss, &store);
    });

    println!("  {:<46} {exec_hit:>10.0}", "1. exec::try_run, ONE row");
    println!("  {:<46} {exec_miss:>10.0}", "2. exec::try_run, ZERO rows");

    // 3. PARSE alone, and 4. parse+optimize — the 925ns the unprepared path adds.
    let parse_only = ns_per_op(reps, iters, || {
        let _ = lenke_engine::gql::parse(hit).expect("parses");
    });
    let parse_plan = ns_per_op(reps, iters, || {
        let _ = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(hit).expect("parses"),
            &store,
        );
    });

    println!("  {:<46} {parse_only:>10.0}", "3. gql::parse alone");
    println!("  {:<46} {parse_plan:>10.0}", "4. parse + optimize_indexed");

    // 5. CLONING the plan, which the prepared FFI path does per call ("Clone the cached plan,
    //    bind params") — a suspect precisely because it scales with plan SIZE, not with rows.
    let clone_plan = ns_per_op(reps, iters, || {
        let _ = plan_hit.clone();
    });

    println!(
        "  {:<46} {clone_plan:>10.0}",
        "5. plan.clone() (prepared path does this)"
    );

    // 6. The JSON render of the result, which the carrier needs.
    let rows = lenke_engine::exec::try_run(&plan_hit, &store).expect("runs");
    let render = ns_per_op(reps, iters, || {
        let _ = lenke_engine::json::gql_rows_json(&rows);
    });

    println!("  {:<46} {render:>10.0}", "6. rows_to_json of that result");
}
