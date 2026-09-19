//! Generative differential test for the optimizer: does rewriting change the answer?
//!
//! One invariant, and it is the optimizer's entire contract:
//!
//! ```text
//! for every plan p and store s:   run(optimize_indexed(p, s), s)  ≡  run(p, s)
//! ```
//!
//! `assert_rows_preserved` in `tests.rs` has always checked exactly this. The gap it
//! leaves is COVERAGE, and it is the expensive kind: the inputs are hand-written, so
//! they only ever cover bugs someone already thought of. Three wrong-answer bugs
//! shipped through that gap in one week (see below), and each was caught by the first
//! test written AFTER the fact. This generates the inputs instead.
//!
//! # Why the existing probes could not catch these
//!
//! It is tempting to say the integration probes measure speed and the unit tests check
//! answers. That is wrong, and believing it points at the wrong fix: `simd_index_probe`
//! E66/E69/E72 all DO assert answers, against an unindexed control, which is a sound
//! oracle. Those assertions ran and passed while the engine returned wrong rows.
//!
//! The oracle was fine. The FIXTURE could not express the error, for two independent
//! reasons, and every miss needed both:
//!
//! 1. **Interchangeable nodes.** `social_store` gives every node the label `Person` and
//!    every edge the type `KNOWS`. Orientation's whole job is permuting WHICH SLOT
//!    HOLDS WHICH NODE. On a graph where nodes are label-interchangeable, a permutation
//!    is close to unobservable by construction.
//! 2. **Permutation-invariant output.** E72 asks `count(*)`. No scramble of slots can
//!    change a count unless it changes which rows MATCH — which needs per-position
//!    predicates, which needs the fixture point 1 says we do not have.
//!
//! So the two things this module does differently are those two, inverted:
//!
//! - [`fixture`] makes every node distinguishable (a unique `name`) and every POSITION
//!   distinguishable (labels with deliberately different coverage, several edge types).
//!   If two slots hold different nodes, swapping them changes the output.
//! - [`gen_plan`] emits "project every slot, in order" as its most common shape. That
//!   projection is the canary. A generator that mostly emitted `count(*)` would inherit
//!   E72's blindness exactly.
//!
//! # The three it was built from
//!
//! - renaming slots across an `Aggregate`, which turned `count(*)` into a read of a
//!   column that does not exist, and with no projection at all returned the pattern's
//!   own slots reversed (`carol, carol` for `alice, bob`);
//! - a two-hop reversal that put the MIDDLE node's label check on the far end, dropping
//!   rows — invisible where every node carries the same label;
//! - a three-hop reversal renamed with a single end-swap, leaving slots 1 and 2 crossed
//!   — wrong only when the middle nodes are distinguishable.
//!
//! # It was validated by MUTATION TESTING, and that is the only reason to trust it
//!
//! This passed on the first run. So does a test that checks nothing, and the two look
//! identical from the outside — so each historical bug was re-introduced into `opt.rs`
//! and the fuzzer had to catch it:
//!
//! ```text
//!   rename with a single end-swap instead of the full permutation   seed 21
//!   an intermediate predicate placed on the far end                 seed 16
//!   orienting when the pattern's slots ARE the output columns       seed 0
//!   a residual filter above the pattern left un-renamed             seed 9
//! ```
//!
//! Two of those needed the GENERATOR widened before they were catchable, which is the
//! useful part — both were shapes a reasonable person forgets:
//!
//! - **no projection at all.** Every realistic query has a `RETURN`, so a generator
//!   naturally wraps every pattern in one. But that is precisely the shape where the
//!   pattern's slots are the result columns, and reversing them reorders the answer.
//! - **a `Distinct` between the pattern and its consumer.** Adjacent filters are merged
//!   by the fixpoint before orientation runs, so a residual filter can only survive
//!   above the pattern with something in between. Without that shape,
//!   `orient_apply`'s rename-the-filter-above branch is UNREACHABLE — confirmed by
//!   instrumenting it across 2,000 plans and never hitting it — and a mutation of that
//!   branch passed silently.
//!
//! When adding a rewrite, mutate it and check this catches it. A generative test whose
//! teeth have never been verified is worse than no test, because it is believed.
//!
//! # Scope
//!
//! Deliberately narrow, and narrow in a way that keeps failures readable: 24 nodes,
//! degree 2-3, at most three hops. A failing seed is small enough to print and step
//! through, and even a fully unoriented three-hop cross product stays trivial. Seeds
//! are fixed so CI is deterministic; `LENKE_OPT_FUZZ_SEEDS` runs more locally.

use super::{optimize_indexed, IndexOracle};
use crate::exec::{run, Rows};
use crate::ir::{Agg, AggFn, CompareOp, Dir, Expr, Plan};
use crate::store::{Builder, Store};
use crate::value::Value;

/// A dep-free deterministic PRNG, so a failing seed replays exactly.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        // Numerical Recipes' LCG constants; adequate for choosing between a handful
        // of shapes, and the point here is reproducibility, not statistical quality.
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        self.0 >> 16
    }

    /// A value in `0..n`.
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    /// True with probability `num/den`.
    fn chance(&mut self, num: u64, den: u64) -> bool {
        self.next() % den < num
    }

    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }
}

/// Labels carried by fixture nodes, in DELIBERATELY different proportions — the point
/// is that `IsLabeled(slot i, L)` and `IsLabeled(slot j, L)` select different things,
/// so moving a label check between positions changes the answer.
const LABELS: [&str; 4] = ["Node", "Wide", "Half", "Rare"];
/// Edge types, so a hop's type is a distinguishing feature too.
const ETYPES: [&str; 3] = ["T1", "T2", "T3"];

const NODES: u32 = 24;

/// A graph where every node and every POSITION is distinguishable.
///
/// Each node gets a unique `name`, so a projection of the pattern's slots is a
/// fingerprint of which node landed where. `age` spreads over 0..20 so a range
/// predicate can be genuinely selective — orientation is gated on the far predicate
/// selecting under ~15% of the graph, so without tight bounds the rewrite under test
/// would simply decline and the fuzzer would cover nothing.
fn fixture(seed: u64) -> Store {
    let mut rng = Lcg(seed ^ 0x9E37_79B9_7F4A_7C15);
    let mut b = Builder::default();

    for i in 0..NODES {
        let mut labels: Vec<&str> = vec!["Node"];
        if i % 2 == 0 {
            labels.push("Half"); // 50%
        }
        if i % 3 == 0 {
            labels.push("Wide"); // 33%
        }
        if i % 8 == 0 {
            labels.push("Rare"); // 12%
        }
        b.node(
            &labels,
            &[
                ("name", Value::Str(format!("n{i}").into())),
                ("age", Value::Num(f64::from(i % 20))),
            ],
        );
    }

    for i in 0..NODES {
        for _ in 0..(2 + rng.below(2)) {
            let dst = rng.below(NODES as usize) as u32;
            b.edge(i, dst, ETYPES[rng.below(ETYPES.len())]);
        }
    }

    b.build()
}

/// A predicate reading exactly `slot`, of one of the forms the planner recognizes.
fn gen_pred(rng: &mut Lcg, slot: usize, selective: bool) -> Expr {
    let label_test = Expr::IsLabeled {
        slot,
        labels: vec![(*rng.pick(&LABELS)).to_string()],
    };

    // A SELECTIVE bound is what makes orientation eligible at all (under ~15% of the
    // graph). Ages run 0..20 over 24 nodes, so `> 17` is about two nodes; the loose
    // bounds are here so the "declines, correctly" path is covered too.
    let bound = if selective {
        *rng.pick(&[17.0, 18.0, 16.0])
    } else {
        *rng.pick(&[-1.0, 0.0, 5.0])
    };
    let range_test = Expr::Compare {
        op: *rng.pick(&[CompareOp::Gt, CompareOp::Ge]),
        left: Box::new(Expr::Prop {
            slot,
            key: "age".into(),
        }),
        right: Box::new(Expr::Lit(Value::Num(bound))),
    };

    match rng.below(4) {
        0 => label_test,
        1 => range_test,
        // A CONJUNCTION of both is the shape a written `(b:L) WHERE b.age > v` lowers
        // to once the filters merge, and the shape that drove both the label lift and
        // the pushdown split.
        2 => Expr::And(Box::new(label_test), Box::new(range_test)),
        _ => Expr::And(Box::new(range_test), Box::new(label_test)),
    }
}

/// A random plan: a seed scan, one to three hops, filters, and an output shape.
fn gen_plan(rng: &mut Lcg) -> Plan {
    let seed_label = if rng.chance(3, 4) {
        Some((*rng.pick(&LABELS)).to_string())
    } else {
        None
    };
    let mut plan = Plan::Scan { label: seed_label };

    let hops = 1 + rng.below(3);
    for h in 0..hops {
        let etypes: Vec<String> = if rng.chance(3, 4) {
            vec![(*rng.pick(&ETYPES)).to_string()]
        } else {
            Vec::new() // any type
        };
        plan = plan.expand(h, *rng.pick(&[Dir::Out, Dir::In, Dir::Both]), &etypes);

        // An INTERMEDIATE filter on the hop's endpoint. This is the one that has to
        // travel with its own hop through a reversal, and putting it on the wrong end
        // is exactly the two-hop bug.
        if h + 1 < hops && rng.chance(1, 2) {
            plan = plan.filter(gen_pred(rng, h + 1, false));
        }
    }

    // The far-side predicate: what orientation seeds from, when it fires.
    let selective = rng.chance(3, 4);
    plan = plan.filter(gen_pred(rng, hops, selective));

    let all_slots: Vec<(String, Expr)> = (0..=hops)
        .map(|i| {
            (
                format!("s{i}"),
                Expr::Prop {
                    slot: i,
                    key: "name".into(),
                },
            )
        })
        .collect();

    // A `Distinct` between the pattern and whatever reads it, sometimes with a further
    // filter above that. This is the only way a residual filter can SURVIVE above the
    // pattern: adjacent filters are merged by the fixpoint before orientation runs, so
    // without something in between, `orient_apply`'s rename-the-filter-above branch is
    // unreachable — verified by instrumenting it, and a mutation of that branch went
    // uncaught until this shape existed.
    if rng.chance(1, 5) {
        plan = Plan::Distinct {
            input: Box::new(plan),
        };
        if rng.chance(1, 2) {
            let slot = rng.below(hops + 1);
            plan = plan.filter(gen_pred(rng, slot, false));
        }
    }

    // THE PATTERN ITSELF, with no projection over it. Its slots ARE the query's output
    // columns, so reversing them reorders the result — which is how the first version
    // of this rewrite returned `carol, carol` where the answer was `alice, bob`. It is
    // also the shape a generator forgets, because every realistic query has a RETURN;
    // leaving it out meant a faithful mutation of that bug went uncaught.
    if rng.chance(1, 8) {
        return plan;
    }

    match rng.below(8) {
        // THE CANARY, and deliberately the most common shape: every slot projected in
        // order, by a property unique per node. Any permutation of the pattern's slots
        // shows up here as a row mismatch. A generator weighted toward `count(*)`
        // instead would reproduce E72's blindness.
        0..=3 => Plan::Project {
            input: Box::new(plan),
            items: all_slots,
        },
        // The ends only — still permutation-sensitive, and the shape most real queries
        // have.
        4 => Plan::Project {
            input: Box::new(plan),
            items: vec![all_slots[0].clone(), all_slots[hops].clone()],
        },
        // `count(*)` directly over the pattern. Permutation-INVARIANT by itself, but it
        // is the shape that exposed the `Aggregate` namespace boundary — the rename
        // must stop there, and a count that reads a column past the boundary faults.
        5 | 6 => Plan::Aggregate {
            input: Box::new(plan),
            keys: Vec::new(),
            aggs: vec![Agg {
                func: AggFn::Count,
                arg: None,
                distinct: false,
                name: "c".into(),
                frac: None,
                null_on_empty: false,
                numeric_only: false,
            }],
        },
        // GROUP BY a pattern slot: an aggregate whose KEY reads the pattern, so the
        // rename has to reach the key and stop above it.
        _ => Plan::Aggregate {
            input: Box::new(plan),
            keys: vec![all_slots[rng.below(hops + 1)].clone()],
            aggs: vec![Agg {
                func: AggFn::Count,
                arg: None,
                distinct: false,
                name: "c".into(),
                frac: None,
                null_on_empty: false,
                numeric_only: false,
            }],
        },
    }
}

/// Rows as a sorted multiset. Order is unspecified for an unordered query, so the
/// comparison must not depend on it — but MULTIPLICITY must be preserved, which is why
/// this is a sorted bag and not a set (a reversal that double-counts a path is a real
/// bug, and a set would hide it).
fn bag(rows: &Rows) -> Vec<String> {
    let mut out: Vec<String> = rows
        .rows
        .iter()
        .map(|r| r.iter().map(|v| format!("{v:?};")).collect::<String>())
        .collect();
    out.sort();
    out
}

/// Check the invariant for one seed against one store, and report richly on failure —
/// the seed alone has to be enough to reproduce and read.
fn check(seed: u64, store: &Store, indexed: bool) {
    let mut rng = Lcg(seed);
    let plan = gen_plan(&mut rng);

    let before = bag(&run(&plan, store));
    let opt = optimize_indexed(plan.clone(), store as &dyn IndexOracle);
    let after = bag(&run(&opt, store));

    assert_eq!(
        before, after,
        "\noptimizing changed the answer (seed {seed}, indexed {indexed})\
         \n  raw:       {plan:?}\
         \n  optimized: {opt:?}\n"
    );
}

/// How many seeds to sweep. Fixed by default so CI is deterministic and fast; raise it
/// locally (`LENKE_OPT_FUZZ_SEEDS=100000`) when changing a rewrite.
fn seed_count() -> u64 {
    std::env::var("LENKE_OPT_FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2_000)
}

/// The invariant, over an INDEXED store — where the seeding rules, the pushdown split
/// and orientation all actually fire.
#[test]
fn optimizing_preserves_rows_with_indexes() {
    let mut store = fixture(1);
    store.create_range_index("age");
    store.create_index("name");

    for seed in 0..seed_count() {
        check(seed, &store, true);
    }
}

/// The same invariant with NO indexes. Most index-driven rewrites decline here, which
/// makes this the control: it covers the "correctly does nothing" path, and any
/// difference between the two sweeps is itself informative.
#[test]
fn optimizing_preserves_rows_without_indexes() {
    let store = fixture(1);

    for seed in 0..seed_count() {
        check(seed, &store, false);
    }
}

/// Vary the GRAPH as well as the plan. A single fixture can hide a rewrite that is only
/// wrong at a particular density or label distribution — the two-hop bug needed a
/// middle node whose label differed from its neighbours' to be visible at all.
#[test]
fn optimizing_preserves_rows_across_fixtures() {
    for fixture_seed in 0..16 {
        let mut store = fixture(fixture_seed);
        store.create_range_index("age");
        store.create_index("name");

        for seed in 0..(seed_count() / 16).max(1) {
            check(
                seed.wrapping_mul(31).wrapping_add(fixture_seed),
                &store,
                true,
            );
        }
    }
}

/// COVERAGE, not correctness: a generative test that never triggers the rewrite it was
/// built for passes vacuously, and looks exactly like a test that works. This asserts
/// the generated corpus actually reaches the interesting shapes.
#[test]
fn the_generator_actually_reaches_the_rewrites() {
    let mut store = fixture(1);
    store.create_range_index("age");
    store.create_index("name");

    fn has<F: Fn(&Plan) -> bool + Copy>(p: &Plan, f: F) -> bool {
        if f(p) {
            return true;
        }
        match p {
            Plan::Project { input, .. }
            | Plan::Aggregate { input, .. }
            | Plan::Filter { input, .. }
            | Plan::Expand { input, .. }
            | Plan::Distinct { input } => has(input, f),
            _ => false,
        }
    }

    let (mut seeks, mut oriented, mut multi_hop, mut nonempty) = (0, 0, 0, 0);
    let n = 400;

    for seed in 0..n {
        let mut rng = Lcg(seed);
        let plan = gen_plan(&mut rng);
        let opt = optimize_indexed(plan.clone(), &store as &dyn IndexOracle);

        if has(&opt, |p| {
            matches!(p, Plan::RangeSeek { .. } | Plan::IndexSeek { .. })
        }) {
            seeks += 1;
        }
        // Orientation is observable as the hop DIRECTIONS changing.
        fn dirs(p: &Plan, out: &mut Vec<Dir>) {
            if let Plan::Expand { dir, .. } = p {
                out.push(*dir);
            }
            match p {
                Plan::Project { input, .. }
                | Plan::Aggregate { input, .. }
                | Plan::Filter { input, .. }
                | Plan::Expand { input, .. }
                | Plan::Distinct { input } => dirs(input, out),
                _ => {}
            }
        }
        let (mut a, mut b) = (Vec::new(), Vec::new());
        dirs(&plan, &mut a);
        dirs(&opt, &mut b);
        if a != b {
            oriented += 1;
        }
        if a.len() >= 2 {
            multi_hop += 1;
        }
        if !run(&plan, &store).rows.is_empty() {
            nonempty += 1;
        }
    }

    // Deliberately loose floors — this guards against the generator silently drifting
    // to trivia, not against the exact proportions.
    assert!(seeks > n / 4, "too few plans seed an index: {seeks}/{n}");
    assert!(oriented > n / 10, "too few plans orient: {oriented}/{n}");
    assert!(
        multi_hop > n / 3,
        "too few multi-hop plans: {multi_hop}/{n}"
    );
    assert!(
        nonempty > n / 2,
        "too many plans return NO ROWS — a fuzzer over empty results proves nothing: {nonempty}/{n}"
    );

    println!("seeks {seeks}/{n}  oriented {oriented}/{n}  multi-hop {multi_hop}/{n}  non-empty {nonempty}/{n}");
}
