//! Generative differential test for the AGGREGATE FAST PATHS: does the shortcut agree with the
//! rows it claims to summarize?
//!
//! `count(*)`, `count(DISTINCT …)`, `sum`/`min`/`max`/`avg` over a var-length hop or a quantified
//! group each have a shortcut that never materializes a row. Their contract is one line:
//!
//! ```text
//! for every pattern P:   <agg> over P  ≡  the same <agg> computed from the rows of P
//! ```
//!
//! # Why this did not exist, and what it cost
//!
//! Three wrong answers shipped in one day through the same gap (items 64, 65, 67), and the gap was
//! not a missing oracle — it was that no oracle ran on a fixture where the shortcut is CHOSEN:
//!
//! - `rewrite_fuzz` compares raw against optimized, which is the right question for a rewrite. Its
//!   graphs are a few dozen nodes, and the algebraic degree-sum count is gated on
//!   `est_paths > 2 * (nodes + edges)` — so that branch never ran under it. Not once.
//! - The differential fuzzer compares TS against native over a THREE-vertex fixture, for the same
//!   reason.
//! - The benches use 50,000-vertex fixtures, which do select the branch. They count rows and report
//!   times; they do not check answers. `varlen count` reported a wrong number quickly for as long
//!   as it existed, and nothing in a bench can tell.
//!
//! So the missing ingredient was a FIXTURE SIZE, not an assertion. This module sweeps sizes across
//! that threshold deliberately (see [`fixture`]) and computes the expected aggregate from the
//! materialized rows itself, in the test, so the oracle shares no code with the thing under test.
//!
//! # The three it was built from, and the mutation that proves it has teeth
//!
//! Each was re-introduced and had to be caught:
//!
//! ```text
//!   the zero-length term dropped from the degree algebra (item 64)          seed 0
//!   an unknown edge type answering 0 instead of the sources (item 65)       seed 0
//!   the degree algebra ignoring the endpoint predicate (item 67)            seed 0
//! ```
//!
//! All three fail on the very first seed, which is the point: they were never subtle, only
//! unreachable.
//!
//! # Keeping the oracle affordable
//!
//! The materialized side is the expensive one, so the generator bounds `nodes * degree ^ max` and
//! the store's trail budget is raised — a budget is a materialization guard, and this test
//! materializes on purpose.

use crate::store::{Builder, ConfigId, Store};
use crate::value::Value;

/// A dep-free deterministic PRNG, so a failing seed replays exactly.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        self.0 >> 11
    }

    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[(self.next() as usize) % xs.len()]
    }
}

/// How many seeds to sweep. Fixed so CI is deterministic; `LENKE_FASTPATH_FUZZ_SEEDS` raises it.
///
/// Each seed runs both sides of the comparison, and the MATERIALIZED side is the expensive one, so
/// seeds here cost far more than `rewrite_fuzz`'s. Measured after the fixture cache and the
/// 1,500-vertex cap: 400 seeds in 0.30s, 5,000 in 3.2s, 20,000 in 12.4s.
///
/// 5,000 is chosen from what the module actually had to catch rather than from a round number. The
/// two bugs it found needed seeds 540 and 3249, because each needs a CONJUNCTION of draws — a
/// distinct count AND a trail AND two or more hops AND a fixture where walk reachability exceeds
/// trail reachability. A 400-seed default would have found neither.
fn seed_count() -> u64 {
    std::env::var("LENKE_FASTPATH_FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5_000)
}

/// The fixture, and the reason this module exists: `nodes` CROSSES the threshold at which the
/// algebraic degree-sum count is chosen over enumeration.
///
/// The gate is `src.len() * avg_degree ^ max > 2 * (nodes + edges)`. At 40 nodes of degree 4 a
/// two-hop walk estimates 640 against 400 — already over, so small fixtures select it too — but at
/// degree 1 it estimates 40 against 160 and enumerates. Sweeping both nodes and degree therefore
/// sweeps the BRANCH, which is what no other oracle was doing.
///
/// 1,500 is the LARGEST size deliberately, not the biggest available: at degree 4 and two hops it
/// estimates 24,000 against 15,000, so it selects the algebra with room to spare, while a
/// 4,000-vertex fixture selects exactly the same branch and costs 2.7x more on the materialized
/// side. Seeds bought with that are worth more than vertices: both bugs this module found needed a
/// rare CONJUNCTION of draws (seeds 540 and 3249), and the only cure for a rare conjunction is more
/// draws.
///
/// Every node carries a unique `name`, a `num` in a small range (so a numeric aggregate has
/// repeats and a predicate is selective), and one of two labels. `label_mix` decides how: all
/// `N` (a filter that excludes nothing), alternating (half), or skewed (a handful), because a
/// filter that excludes nothing cannot show that a predicate was applied at all.
/// The five parameters that name a fixture. There are only 108 of them, so they are BUILT ONCE and
/// reused across seeds — see [`Fixtures`]. Rebuilding a 4,000-vertex store per seed was what held
/// the default seed count down to a level that covered neither of the two bugs this module was
/// written to find (seeds 540 and 3249).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Params {
    nodes: u32,
    degree: u32,
    label_mix: u8,
    self_loops: bool,
    second_type: bool,
}

fn gen_params(r: &mut Lcg) -> Params {
    Params {
        nodes: *r.pick(&[40u32, 300, 1500]),
        degree: *r.pick(&[1u32, 2, 4]),
        label_mix: *r.pick(&[0u8, 1, 2]),
        self_loops: r.next().is_multiple_of(4),
        second_type: r.next().is_multiple_of(3),
    }
}

/// Built fixtures, keyed by their parameters.
type Fixtures = std::collections::HashMap<Params, Store>;

fn fixture(p: Params) -> Store {
    let Params {
        nodes,
        degree,
        label_mix,
        self_loops,
        second_type,
    } = p;

    let mut b = Builder::default();
    for i in 0..nodes {
        let label = match label_mix {
            0 => "N",
            1 => {
                if i.is_multiple_of(2) {
                    "N"
                } else {
                    "M"
                }
            }
            _ => {
                if i.is_multiple_of(97) {
                    "M"
                } else {
                    "N"
                }
            }
        };
        // `Z` on exactly THREE nodes, as an ADDITIONAL label so no existing N/M count
        // moves. It exists to be the small right-hand side of a comma pattern (see
        // `gen_shape`): a cartesian `count(*)` is the PRODUCT of the sides' counts, and a
        // factor of 3 tells a product from a sum and from a dropped factor. A factor of 1
        // would do neither, since |P| x 1 = |P|.
        let labels: &[&str] = if i < 3 { &[label, "Z"] } else { &[label] };
        b.node(
            labels,
            &[
                ("name", Value::Str(format!("v{i}").into())),
                ("num", Value::Num(f64::from(i % 17))),
            ],
        );
    }
    for i in 0..nodes {
        if self_loops && i.is_multiple_of(5) {
            b.edge(i, i, "R");
        }
        for d in 0..degree {
            let to = (i * 7 + d * 3 + 1) % nodes;
            // A SECOND edge type on some edges, so a type-filtered walk and an unfiltered one
            // differ and `[:R|S]` has something to union.
            if second_type && (i + d).is_multiple_of(3) {
                b.edge(i, to, "S");
            } else {
                b.edge(i, to, "R");
            }
        }
    }
    let mut store = b.build();
    // This test MATERIALIZES on purpose, and the trail budget exists to stop that. Raise both.
    store.set_limit(ConfigId::LimitsTrail, 100_000_000);
    store.set_limit(ConfigId::LimitsIntermediate, 200_000_000);
    store
}

/// The generated pattern, as the two spellings the comparison needs: one ending in an aggregate and
/// one returning the rows that aggregate is over.
struct Shape {
    agg_q: String,
    rows_q: String,
    /// How to fold the row values into the expected answer.
    kind: Kind,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Count,
    DistinctCount,
    Sum,
    Min,
    Max,
}

/// A pattern plus an aggregate over it, bounded so the MATERIALIZED side stays affordable: the
/// generator caps `nodes * degree ^ max` by lowering `max` on the larger fixtures.
fn gen_shape(r: &mut Lcg, nodes: u32, degree: u32) -> Shape {
    let mode = *r.pick(&["", "WALK ", "TRAIL ", "SIMPLE ", "ACYCLIC "]);
    let dir = *r.pick(&["-[:R]->", "<-[:R]-", "-[:R]-", "-[:R|S]->", "-[:Nope]->"]);
    // Bound the row count: degree ^ max per source, times the sources.
    let max_cap = match (nodes, degree) {
        (1500, 4) => 2,
        (1500, _) | (300, 4) => 3,
        _ => 3,
    };
    let max = 1 + (r.next() as u32 % max_cap);
    let min = *r.pick(&[0u32, 1, 1, max.min(2)]);
    let quant = format!("{{{min},{max}}}");

    // The endpoint pattern / filter. A label that excludes nothing, a selective one, a property
    // compare, and a spelling that reads BOTH ends (which no endpoint-only shortcut may peel).
    let (tail, endpoint_expr) = match *r.pick(&[0u8, 1, 2, 3, 4, 5]) {
        0 => ("(y)".to_string(), "y"),
        1 => ("(y:N)".to_string(), "y"),
        2 => ("(y:M)".to_string(), "y"),
        3 => ("(y) WHERE y.num < 5".to_string(), "y"),
        4 => ("(y) WHERE y.num >= 0".to_string(), "y"),
        _ => ("(y) WHERE y.name <> x.name".to_string(), "y"),
    };

    // A second, INDEPENDENT comma pattern on a third of the shapes. This is what reaches
    // `try_join_product_count` (audit item 136): a comma list lowers to a `Join` with an
    // empty `on`, and `count(*)` over it is answered as the product of the sides' counts
    // without crossing them. Before this, nothing in this module generated a `Join` at
    // all, so the module that exists to guard aggregate fast paths did not cover that one.
    //
    // The oracle needs no change and that is the point: `rows_q` carries the SAME comma
    // pattern, so it materializes the cross and the expected aggregate is folded from
    // those rows. |Z| = 3 keeps the materialized side affordable.
    let cross = if r.next().is_multiple_of(3) {
        ", (z:Z)"
    } else {
        ""
    };
    let pattern = format!("MATCH {mode}(x){dir}{quant}{tail}{cross}");
    let kind = *r.pick(&[
        Kind::Count,
        Kind::Count,
        Kind::DistinctCount,
        Kind::Sum,
        Kind::Min,
        Kind::Max,
    ]);
    let agg = match kind {
        Kind::Count => "count(*)".to_string(),
        Kind::DistinctCount => format!("count(DISTINCT {endpoint_expr})"),
        Kind::Sum => format!("sum({endpoint_expr}.num)"),
        Kind::Min => format!("min({endpoint_expr}.num)"),
        Kind::Max => format!("max({endpoint_expr}.num)"),
    };
    Shape {
        agg_q: format!("{pattern} RETURN {agg} AS a"),
        // `name` AND `num`: the distinct count needs an identity and the numeric folds need the
        // value, and asking for both in one query keeps the two sides over the same row order.
        rows_q: format!("{pattern} RETURN {endpoint_expr}.name AS n, {endpoint_expr}.num AS v"),
        kind,
    }
}

/// Run a query, or its error code.
fn run(q: &str, store: &Store) -> Result<crate::exec::Rows, String> {
    let raw = crate::gql::parse(q)?;
    crate::exec::try_run(&crate::opt::optimize_indexed(raw, store), store)
}

/// The expected aggregate, folded from the materialized rows by this test rather than by any engine
/// aggregate path — so a bug shared between the shortcut and the general aggregate cannot hide.
///
/// The numeric folds walk the rows IN ORDER, because that is the contract the fold fast paths claim:
/// they visit endpoints in the same order the materializing path emits them, so a float sum lands
/// the same bits. Summing a sorted copy instead would make this test disagree for a reason that is
/// not a bug.
fn expected(kind: Kind, rows: &crate::exec::Rows) -> Value {
    let vals = || {
        rows.rows.iter().map(|r| match r[1] {
            Value::Num(x) => Some(x),
            _ => None,
        })
    };
    match kind {
        Kind::Count => Value::Num(rows.rows.len() as f64),
        Kind::DistinctCount => {
            let mut seen: Vec<String> = rows
                .rows
                .iter()
                .map(|r| format!("{:?}", r[0]))
                .collect::<Vec<_>>();
            seen.sort();
            seen.dedup();
            Value::Num(seen.len() as f64)
        }
        Kind::Sum => {
            // `sum` of NOTHING is 0 here, not NULL — the GQL/SQL contract, which `Agg` records
            // explicitly: `null_on_empty` exists for GREMLIN's `sum()` (no traversers, no value)
            // and is not set for a GQL query. `min`/`max`/`avg` do null on an empty set. Getting
            // this backwards was the first thing this fuzzer flagged, and it was the ORACLE that
            // was wrong, which is worth saying: a generative test encodes a policy whether or not
            // its author looked the policy up.
            let mut total = 0.0f64;
            for v in vals().flatten() {
                total += v;
            }
            Value::Num(total)
        }
        Kind::Min | Kind::Max => {
            let mut best: Option<f64> = None;
            for v in vals().flatten() {
                best = Some(match best {
                    None => v,
                    Some(b) => {
                        if (kind == Kind::Min) == (v < b) {
                            v
                        } else {
                            b
                        }
                    }
                });
            }
            best.map_or(Value::Null, Value::Num)
        }
    }
}

/// The invariant: every aggregate shortcut agrees with the rows it summarizes.
#[test]
fn an_aggregate_fast_path_agrees_with_the_rows_it_summarizes() {
    // Coverage counters. The FIXTURE SIZE ones are the whole point of the module — a sweep that
    // drifted to small graphs would pass exactly as this one does while covering nothing the
    // other oracles do not already cover.
    let mut big = 0u32;
    let mut small = 0u32;
    let mut nonempty = 0u32;
    let mut per_kind = [0u32; 5];
    let mut built: Fixtures = Fixtures::new();

    for seed in 0..seed_count() {
        let mut r = Lcg(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03);
        let params = gen_params(&mut r);
        let (nodes, degree) = (params.nodes, params.degree);
        let store = built.entry(params).or_insert_with(|| fixture(params));
        let store = &*store;
        if nodes >= 1500 {
            big += 1;
        } else {
            small += 1;
        }
        let shape = gen_shape(&mut r, nodes, degree);
        per_kind[shape.kind as usize] += 1;

        let got = run(&shape.agg_q, store);
        let rows = run(&shape.rows_q, store);
        match (got, rows) {
            (Ok(a), Ok(rs)) => {
                if !rs.rows.is_empty() {
                    nonempty += 1;
                }
                let want = expected(shape.kind, &rs);
                let have = a
                    .rows
                    .iter()
                    .next()
                    .map_or(Value::Null, |row| row[0].clone());
                assert_eq!(
                    format!("{have:?}"),
                    format!("{want:?}"),
                    "seed {seed}: the shortcut disagreed with its rows ({} rows)\n  agg:  {}\n  rows: {}",
                    rs.rows.len(),
                    shape.agg_q,
                    shape.rows_q
                );
            }
            // Both refused: the same input rejected the same way, which is agreement.
            (Err(_), Err(_)) => {}
            (a, b) => panic!(
                "seed {seed}: one spelling errored and the other did not\n  agg:  {} -> {:?}\n  rows: {} -> {:?}",
                shape.agg_q,
                a.map(|r| r.rows.len()),
                shape.rows_q,
                b.map(|r| r.rows.len())
            ),
        }
    }

    // FLOORS, at roughly half what was measured when this was written. The big-fixture floor is
    // the one that matters: below it, this module is a slower copy of tests that already exist.
    assert!(big > seed_count() as u32 / 6, "big fixtures drawn: {big}");
    assert!(small > seed_count() as u32 / 6, "small fixtures: {small}");
    assert!(
        nonempty > seed_count() as u32 / 3,
        "shapes that MATCHED something: {nonempty} — a comparison over no rows compares nothing"
    );
    for (i, n) in per_kind.iter().enumerate() {
        assert!(*n > 0, "aggregate kind {i} was never generated");
    }
}
