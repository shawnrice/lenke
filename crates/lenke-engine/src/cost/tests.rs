use super::*;
use crate::ir::{Dir, PathMode};
use crate::store::{Builder, Store};
use crate::value::Value;

const CITIES: &[&str] = &["oslo", "bergen", "troms", "moss"];

fn fixture(n: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        let city = Value::Str(CITIES[(i % 4) as usize].into());
        if i % 3 == 0 {
            b.node(&["Person", "VIP"], &[("city", city)]);
        } else {
            b.node(&["Person"], &[("city", city)]);
        }
    }
    for i in 0..n {
        for d in 0..deg {
            b.edge(i, (i * 7 + d * 13 + 1) % n, "R");
        }
    }
    b.build()
}

fn scan(label: &str) -> Plan {
    Plan::Scan {
        label: Some(label.into()),
    }
}

#[test]
fn base_scans_are_exact() {
    let st = fixture(3000, 4);
    let all = estimate(&scan("Person"), &st);
    assert!(all.exact);
    assert_eq!(all.rows as u32, 3000);
    // Every third node is a VIP.
    let vip = estimate(&scan("VIP"), &st);
    assert!(vip.exact);
    assert_eq!(vip.rows as u32, st.nodes_with_label("VIP").len() as u32);
}

#[test]
fn expand_and_varlength_scale_by_fanout() {
    let (n, deg) = (3000u32, 4u32);
    let st = fixture(n, deg);
    // avg_degree = edges/nodes = deg. A 1-hop ≈ nodes × deg.
    let one = estimate(&scan("Person").expand(0, Dir::Out, &["R".to_string()]), &st);
    assert!(!one.exact);
    assert!((one.rows - f64::from(n * deg)).abs() < 1.0, "1-hop ≈ n*deg");
    // VarLength {1,2}: n × (deg + deg²).
    let two = estimate(
        &scan("Person").var_length(0, Dir::Out, &["R".to_string()], 1, 2, PathMode::Trail),
        &st,
    );
    let expected = f64::from(n) * (f64::from(deg) + f64::from(deg * deg));
    assert!((two.rows - expected).abs() < 2.0, "varlen ≈ n*(d+d²)");
    // The deep intermediate (n×(d+d²) = 60k) routes to bounded memory under a
    // budget below it.
    let budget = Budget {
        materialize_rows: 50_000.0,
    };
    assert!(prefer_bounded_memory(
        &scan("Person").var_length(0, Dir::Out, &["R".to_string()], 1, 2, PathMode::Trail),
        &st,
        &budget
    ));
}

#[test]
fn grouped_aggregate_uses_exact_dict_distinct() {
    let st = fixture(3000, 4);
    // `city` has 4 distinct values → dict-encoded → exact group count.
    assert_eq!(st.distinct_count("city"), Some(4));
    let plan = scan("Person").aggregate(vec![("k".into(), prop(0, "city"))], vec![agg_count()]);
    let g = estimate(&plan, &st);
    assert_eq!(g.rows as u32, 4, "group count = dict distinct");
}

#[test]
fn scalar_aggregate_is_one_row() {
    let st = fixture(1000, 4);
    let plan = scan("Person").aggregate(Vec::new(), vec![agg_count()]);
    let c = estimate(&plan, &st);
    assert!(c.exact);
    assert_eq!(c.rows as u32, 1);
}

#[test]
fn limit_caps_the_estimate() {
    let st = fixture(3000, 4);
    let plan = scan("Person")
        .expand(0, Dir::Out, &["R".to_string()])
        .order_page(Vec::new(), None, Some(50));
    assert_eq!(estimate(&plan, &st).rows as u32, 50);
}

/*
 * Item 2547: `prefer_bounded_memory` is the ROUTING GATE — it picks a fold/stream operator over
 * materializing a batch. Both routes return identical bytes, so no differential test can see it,
 * which is what `perf-gate-needs-its-own-test` warned about. Before this item the gate was asserted
 * exactly ONCE, in the TRUE direction only (a 50,000 budget against a ~60,000 estimate).
 *
 * MEASURED: a mutant returning `true` unconditionally — every small query forced onto the streaming
 * path — passed the five cost tests AND the whole 1366-test default suite.
 *
 * So the gate needs its three missing pieces: the FALSE direction, the EXACT boundary, and the
 * default budget that production actually uses (the tests only ever built a Budget by hand).
 */

/// Both directions and the exact boundary of `rows > materialize_rows`.
///
/// The two budgets are derived from the MEASURED estimate rather than typed as literals, so the
/// row tests the comparison itself and cannot drift when the estimator is retuned —
/// `expand_and_varlength_scale_by_fanout` above pins the arithmetic independently, which is the
/// half that would otherwise be circular (rule xx).
#[test]
fn the_routing_gate_is_a_strict_greater_than_at_the_exact_boundary() {
    let st = fixture(3000, 4);
    let deep = scan("Person").var_length(0, Dir::Out, &["R".to_string()], 1, 2, PathMode::Trail);

    let rows = estimate(&deep, &st).rows;
    assert!(
        rows > 1.0,
        "the fixture must produce a non-trivial estimate"
    );

    let at =
        |materialize_rows: f64| prefer_bounded_memory(&deep, &st, &Budget { materialize_rows });

    assert!(
        at(rows - 1.0),
        "an estimate ABOVE the budget must route to bounded memory",
    );
    assert!(
        !at(rows),
        "the comparison is STRICTLY greater: at exactly the budget, materializing is kept",
    );
    assert!(
        !at(rows + 1.0),
        "an estimate BELOW the budget must materialize — without this row a gate that always \
         returns true passes every test in the repo",
    );
}

/// The FALSE direction on a plan that cannot be large, under the budget production uses.
///
/// A scalar aggregate is one row, so this holds on any machine whatever `default_budget` computes
/// from available RAM — which is what makes it safe to assert against the real budget rather than
/// a hand-made one.
#[test]
fn a_one_row_plan_materializes_under_the_real_default_budget() {
    let st = fixture(1000, 4);
    let tiny = scan("Person").aggregate(Vec::new(), vec![agg_count()]);

    assert_eq!(
        estimate(&tiny, &st).rows as u32,
        1,
        "a scalar aggregate is one row"
    );
    assert!(
        !prefer_bounded_memory(&tiny, &st, &Budget::default_budget()),
        "a one-row intermediate must never be pushed onto the streaming path",
    );
}

/// `default_budget` is `min(time crossover, memory ceiling)`, and the memory ceiling is read from
/// the machine's available RAM — so the ROUTE a query takes is machine-dependent (answer-identical
/// either way; this trades time only). That rules out asserting a particular number here, so what
/// is pinned is what must hold on EVERY box:
///
///   * it is finite and positive — a NaN or 0 budget would send every query one way;
///   * it never EXCEEDS the time crossover, which is what `min` is for. A `min` changed to `max`
///     reads the memory ceiling on any box with more than ~183 MiB available, and fails here.
///
/// NOT COVERED, deliberately: the `PERF_MATERIALIZE_ROWS` override. It reads a process-global env
/// var, and Rust runs these tests on parallel threads, so setting it here would leak into whatever
/// else is mid-flight — an unsound test is worse than a missing one. It stays a calibration knob
/// verified by hand.
#[test]
fn the_default_budget_is_finite_positive_and_capped_by_the_time_crossover() {
    let budget = Budget::default_budget();

    assert!(
        budget.materialize_rows.is_finite(),
        "a non-finite budget makes the gate's comparison meaningless: {}",
        budget.materialize_rows,
    );
    assert!(
        budget.materialize_rows > 0.0,
        "a zero or negative budget routes EVERY plan to bounded memory: {}",
        budget.materialize_rows,
    );
    assert!(
        budget.materialize_rows <= Budget::TIME_CROSSOVER_ROWS,
        "the default must be min(crossover, memory ceiling), so it can never exceed the \
         crossover; got {} against a crossover of {}",
        budget.materialize_rows,
        Budget::TIME_CROSSOVER_ROWS,
    );
}

// --- tiny plan-builder helpers ---
fn prop(slot: usize, key: &str) -> Expr {
    Expr::Prop {
        slot,
        key: key.into(),
    }
}
fn agg_count() -> crate::ir::Agg {
    crate::ir::Agg {
        func: crate::ir::AggFn::Count,
        arg: None,
        distinct: false,
        name: "c".into(),
        frac: None,
        null_on_empty: false,
        numeric_only: false,
    }
}
