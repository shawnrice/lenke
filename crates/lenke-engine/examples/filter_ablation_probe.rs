//! Is the `PropertyExists` filter really the 23.7x, or is it load-bearing like the `Project`?
//! (item 1134)
//!
//! Item 1133 built the plan simplification that looked certain — dropping a `Project` under a
//! keyless `count(*)`, which counts rows and cannot read it — and measured **1.12x SLOWER** across
//! three alternated rounds against a flat control. The `Project` was narrowing the batch to one
//! column before the aggregate, and the aggregate left sitting on the 4-slot chain batch paid more
//! than the projection saved.
//!
//! That item ALSO concluded the remaining 23.7x is `Filter{PropertyExists}`, on the grounds that
//! the control (`outE.outV.count()`, a tally) and the target run the same chain and differ by that
//! filter. **That is exactly the kind of reasoning item 1133 just refuted** — two plans differing
//! by one node, with the cost attributed to the node. So before building a presence-check rewrite
//! on it, ABLATE the filter and measure.
//!
//! The ablation is valid on this fixture in item 1105's sense — the removed operation has no
//! control-flow consumer, and every node here carries `name`, so the answer is identical with and
//! without it. Both arms are asserted to return the same count; a mismatch aborts.
//!
//!   ARM 1  the plan as the planner builds it         (filter present)
//!   ARM 2  the same plan with the Filter node spliced out
//!   ARM 3  `outE.outV.count()`                        the control neither arm changes
//!
//! If ARM 2 collapses toward ARM 3, the filter is the cost and the rewrite is worth building. If
//! ARM 2 stays near ARM 1, the filter is load-bearing too and item 1133's parting diagnosis is
//! refuted the same way its own rewrite was.
//!
//!   cargo run --release --example filter_ablation_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::ir::Plan;

use support::{social_store, Cfg};

/// Remove the FIRST `Filter` encountered walking down the plan. Returns `None` if there is none,
/// so a shape that does not match cannot be measured as if it had been ablated.
fn strip_first_filter(plan: Plan) -> Option<Plan> {
    match plan {
        Plan::Filter { input, .. } => Some(*input),
        Plan::Aggregate { input, keys, aggs } => {
            strip_first_filter(*input).map(|i| Plan::Aggregate {
                input: Box::new(i),
                keys,
                aggs,
            })
        }
        Plan::Project { input, items } => strip_first_filter(*input).map(|i| Plan::Project {
            input: Box::new(i),
            items,
        }),
        _ => None,
    }
}

/// Remove the FIRST `Project` encountered walking down from the aggregate.
fn strip_first_project(plan: Plan) -> Option<Plan> {
    match plan {
        Plan::Project { input, .. } => Some(*input),
        Plan::Aggregate { input, keys, aggs } => {
            strip_first_project(*input).map(|i| Plan::Aggregate {
                input: Box::new(i),
                keys,
                aggs,
            })
        }
        Plan::Filter { input, pred } => strip_first_project(*input).map(|i| Plan::Filter {
            input: Box::new(i),
            pred,
        }),
        _ => None,
    }
}

fn run_count(plan: &Plan, store: &lenke_engine::store::Store) -> f64 {
    let b = lenke_engine::exec::try_run(plan, store).expect("plan runs");
    match b.rows.iter().next().and_then(|r| r.first()) {
        Some(lenke_engine::value::Value::Num(n)) => *n,
        other => panic!("expected a count, got {other:?}"),
    }
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = social_store(nodes, 5);

    let target = "g.V().outE('KNOWS').outV().values('name').count()";
    let control = "g.V().outE('KNOWS').outV().count()";

    let kept = lenke_engine::opt::optimize_indexed(
        lenke_engine::gremlin::parse(target).expect("target parses"),
        &store,
    );
    // RE-OPTIMIZE every ablated plan. Stripping a node from an already-optimized plan is NOT
    // the same plan the planner would have produced for that shape: fastpath selection and the
    // plan annotations run in `optimize_indexed`, so a hand-stripped plan measures "unoptimized"
    // against "optimized" and the comparison is a confound, not a result. Caught by ARM 4 and
    // ARM 5 — structurally the same plan — reading 13566.9 against 594.4 before this line.
    let reopt = |p: Plan| lenke_engine::opt::optimize_indexed(p, &store);
    let no_filter = reopt(strip_first_filter(kept.clone()).expect("the target plan HAS a Filter"));
    let no_project =
        reopt(strip_first_project(kept.clone()).expect("the target plan HAS a Project"));
    let neither = reopt(
        strip_first_project(strip_first_filter(kept.clone()).expect("filter")).expect("project"),
    );
    let ctl = lenke_engine::opt::optimize_indexed(
        lenke_engine::gremlin::parse(control).expect("control parses"),
        &store,
    );

    // The ablation must not change the answer on this fixture, or it is not an ablation.
    let a_kept = run_count(&kept, &store);
    for (name, p) in [
        ("no_filter", &no_filter),
        ("no_project", &no_project),
        ("neither", &neither),
    ] {
        let got = run_count(p, &store);
        assert!(
            (a_kept - got).abs() < 0.5,
            "ablation {name} changed the answer: {a_kept} vs {got} — not a valid perf ablation"
        );
    }

    println!(
        "\n# {} nodes / degree 5, min of {}, answer {} both arms\n",
        nodes, cfg.reps, a_kept
    );

    let t1 = support::best_us(cfg.reps, || {
        std::hint::black_box(run_count(&kept, &store));
    });
    let t2 = support::best_us(cfg.reps, || {
        std::hint::black_box(run_count(&no_filter, &store));
    });
    let t2b = support::best_us(cfg.reps, || {
        std::hint::black_box(run_count(&no_project, &store));
    });
    let t2c = support::best_us(cfg.reps, || {
        std::hint::black_box(run_count(&neither, &store));
    });
    let t3 = support::best_us(cfg.reps, || {
        std::hint::black_box(run_count(&ctl, &store));
    });

    println!("  ARM 1  Agg / Project / Filter / chain  (as planned)  {t1:>10.1} us");
    println!("  ARM 2  Agg / Project / chain           (no filter)   {t2:>10.1} us");
    println!("  ARM 3  Agg / Filter / chain            (no project)  {t2b:>10.1} us");
    println!("  ARM 4  Agg / chain                     (neither)     {t2c:>10.1} us");
    println!("  ARM 5  outE.outV.count()               [control]     {t3:>10.1} us");
    println!("\n  dropping the filter alone:  {:.2}x", t1 / t2);
    println!("  dropping the project alone: {:.2}x", t1 / t2b);
    println!("  dropping BOTH:              {:.2}x", t1 / t2c);
}
