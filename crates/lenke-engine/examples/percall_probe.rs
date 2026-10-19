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

    // Item 319 put a parse cache in front of `lnk_query`, so `gql::parse` is no longer what a
    // serving call pays for parsing — a warm call pays a clone plus `bind_params`. Measured
    // through the shipped entry point, warmed first so this is the HIT path and not an admission.
    let params: Vec<(String, lenke_engine::value::Value)> = Vec::new();
    for _ in 0..3 {
        let _ = lenke_engine::parse_cache::parse_for_run(hit, &params, 64);
    }
    let cached_parse = ns_per_op(reps, iters, || {
        let _ = lenke_engine::parse_cache::parse_for_run(hit, &params, 64).expect("parses");
    });

    println!(
        "  {:<46} {cached_parse:>10.0}",
        "3b. parse_cache::parse_for_run, WARM (the real path)"
    );
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

    // 7-10: the PREPARED path's own per-call work, which item 291 left unattributed. It does not
    // go through `lnk_query` at all — it is routed through the generic `lnk_command` dispatcher as
    // `prepared_run` with a JSON payload `{"handle":"<ptr>","params":{…}}`, so every call parses
    // that JSON, clones the plan, binds, and RE-OPTIMIZES before running.
    let payload = r#"{"handle":"140737488355328","params":{"n":"name7"}}"#;
    let params_json = r#"{"n":"name7"}"#;

    let parse_payload = ns_per_op(reps, iters, || {
        let _ = lenke_engine::ndjson::parse_json(payload);
    });
    let parse_params = ns_per_op(reps, iters, || {
        let _ = lenke_engine::ndjson::parse_json(params_json);
    });

    println!(
        "  {:<46} {parse_payload:>10.0}",
        "7. parse_json of the prepared_run payload"
    );
    println!(
        "  {:<46} {parse_params:>10.0}",
        "8. parse_json of the params object alone"
    );

    // The bind + re-optimize the prepared path pays per call, on a plan parsed in PREPARED mode
    // (so `$n` survives as a parameter rather than being substituted at parse time).
    let prepared_plan =
        lenke_engine::gql::parse_prepared("MATCH (u:User) WHERE u.name = $n RETURN u.score AS s")
            .expect("parses in prepared mode");
    let bound = vec![("n".to_string(), Value::Str("name7".into()))];

    let bind_only = ns_per_op(reps, iters, || {
        let mut p = prepared_plan.clone();
        let _ = lenke_engine::bind::bind_params(&mut p, &bound);
    });
    let bind_and_opt = ns_per_op(reps, iters, || {
        let mut p = prepared_plan.clone();
        let _ = lenke_engine::bind::bind_params(&mut p, &bound);
        let _ = lenke_engine::opt::optimize_indexed(p, &store);
    });

    println!("  {:<46} {bind_only:>10.0}", "9. clone + bind_params");
    println!(
        "  {:<46} {bind_and_opt:>10.0}",
        "10. clone + bind + optimize_indexed"
    );

    // 11-13: inside `gql::parse`, which item 291 found dominant (1296ns for 57 bytes, 23ns a
    // byte). Two costs are visible in the source: the lexer decodes the WHOLE query into a heap
    // `Vec<char>` before it starts, and `Tok::Ident`/`Str`/`Param` each own a `String`, so a
    // 57-byte query allocates one char vector, one token vector and ~12 identifier strings.
    // `lex` is private, so these price the parts reachable from outside.
    let char_vec = ns_per_op(reps, iters, || {
        let _: Vec<char> = hit.chars().collect();
    });
    let char_vec_cap = ns_per_op(reps, iters, || {
        let mut v: Vec<char> = Vec::with_capacity(hit.len());
        v.extend(hit.chars());
    });
    let idents = ns_per_op(reps, iters, || {
        let mut v: Vec<String> = Vec::new();
        for w in hit.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '$') {
            if !w.is_empty() {
                v.push(w.to_string());
            }
        }
        let _ = v;
    });

    println!(
        "  {:<46} {char_vec:>10.0}",
        "11. s.chars().collect::<Vec<char>>()"
    );
    println!(
        "  {:<46} {char_vec_cap:>10.0}",
        "12. the same, with_capacity(s.len())"
    );
    println!(
        "  {:<46} {idents:>10.0}",
        "13. ~12 identifier Strings (lexer's shape)"
    );

    // 14-16: THE WHOLE `lnk_query` BODY, in-process (item 599). Rows 1-13 price the layers; this
    // prices their SUM through the same entry points `ffi.rs` calls, which is the only thing that
    // can say whether the residual is on the Rust side or the bun side.
    //
    // It matters because the residual has now outlived two attributions. Item 291 blamed the FFI
    // boundary; the boundary is 1.2ns at arity 0. Item 292 blamed bun:ffi's per-ARGUMENT
    // marshalling; measured by arity, that is ~0-2ns an argument and the 3-argument symbol is
    // FASTER than the 2-argument one, so there is no slope to extrapolate. `backend.queryRows`
    // for `RETURN 1 AS s` costs 815ns from JS. If these rows sum to ~800 the cost is all Rust and
    // rows 1-13 simply have to be added up; if they sum to ~250 then ~550ns is bun-side plumbing
    // that no Rust probe will ever see.
    let mut mstore = indexed_users(n);
    let trivial = "RETURN 1 AS s";

    for _ in 0..3 {
        let _ = lenke_engine::parse_cache::parse_for_run(trivial, &params, 64);
    }

    let body_trivial = ns_per_op(reps, iters, || {
        let plan = lenke_engine::parse_cache::parse_for_run(trivial, &params, 64).expect("parses");
        match lenke_engine::exec::run_query(plan, &mut mstore).expect("runs") {
            lenke_engine::exec::Executed::Rows(rows) => {
                let _ = lenke_engine::json::gql_rows_json(&rows);
            }
            lenke_engine::exec::Executed::Read(p) => {
                let _ = lenke_engine::exec::try_run_gql_json(&p, &mstore);
            }
        }
    });

    for _ in 0..3 {
        let _ = lenke_engine::parse_cache::parse_for_run(hit, &params, 64);
    }

    let body_hit = ns_per_op(reps, iters, || {
        let plan = lenke_engine::parse_cache::parse_for_run(hit, &params, 64).expect("parses");
        match lenke_engine::exec::run_query(plan, &mut mstore).expect("runs") {
            lenke_engine::exec::Executed::Rows(rows) => {
                let _ = lenke_engine::json::gql_rows_json(&rows);
            }
            lenke_engine::exec::Executed::Read(p) => {
                let _ = lenke_engine::exec::try_run_gql_json(&p, &mstore);
            }
        }
    });

    println!(
        "\n  {:<46} {body_trivial:>10.0}",
        "14. WHOLE BODY, 'RETURN 1 AS s' (JS says 815)"
    );
    println!(
        "  {:<46} {body_hit:>10.0}",
        "15. WHOLE BODY, the point lookup (JS says 1281)"
    );
    println!(
        "  {:<46} {:>10.0}",
        "16. => bun-side, trivial (614 queryJson - row 14)",
        614.0 - body_trivial
    );

    // 17-20: WHAT IS IN THE 388ns BODY of a one-operator query (item 599). `backend.queryJson` for
    // `RETURN 1 AS s` is 614ns, of which 388 is Rust and only ~67 is the JS wrapper's own
    // layering — so after item 597 the Rust side is the dominant term even for a query that
    // touches no data. `optimize_indexed` runs on EVERY call (`exec::run_query` calls it), and
    // item 293 refuted CACHING the optimized plan; it said nothing about what optimizing a
    // trivial plan should cost.
    let trivial_plan = lenke_engine::gql::parse(trivial).expect("parses");
    let opt_trivial = ns_per_op(reps, iters, || {
        let _ = lenke_engine::opt::optimize_indexed(trivial_plan.clone(), &mstore);
    });
    let clone_trivial = ns_per_op(reps, iters, || {
        let _ = trivial_plan.clone();
    });
    let opt_hit = ns_per_op(reps, iters, || {
        let _ = lenke_engine::opt::optimize_indexed(plan_hit.clone(), &mstore);
    });
    let rows_trivial = lenke_engine::exec::try_run(&trivial_plan, &mstore).expect("runs");
    let render_trivial = ns_per_op(reps, iters, || {
        let _ = lenke_engine::json::gql_rows_json(&rows_trivial);
    });

    println!(
        "  {:<46} {:>10.0}",
        "17. optimize_indexed, trivial plan (minus clone)",
        opt_trivial - clone_trivial
    );
    println!(
        "  {:<46} {clone_trivial:>10.0}",
        "18. .clone() of that trivial plan"
    );
    println!(
        "  {:<46} {:>10.0}",
        "19. optimize_indexed, the point lookup (minus clone)",
        opt_hit - clone_plan
    );
    println!(
        "  {:<46} {render_trivial:>10.0}",
        "20. gql_rows_json of one trivial row"
    );
}
