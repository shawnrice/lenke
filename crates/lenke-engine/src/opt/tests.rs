use super::*;
use crate::exec::{run, Rows};
use crate::ir::{CompareOp, Dir, Expr, PathMode, Plan};
use crate::store::{Builder, Store};
use crate::value::Value;

fn s(x: &str) -> Value {
    Value::Str(x.into())
}
fn n(x: f64) -> Value {
    Value::Num(x)
}
fn prop(slot: usize, key: &str) -> Expr {
    Expr::Prop {
        slot,
        key: key.to_string(),
    }
}
fn cmp(op: CompareOp, l: Expr, r: Expr) -> Expr {
    Expr::Compare {
        op,
        left: Box::new(l),
        right: Box::new(r),
    }
}

fn social() -> Store {
    let mut b = Builder::default();
    let a = b.node(&["Person"], &[("name", s("alice")), ("age", n(30.0))]);
    let bob = b.node(&["Person"], &[("name", s("bob")), ("age", n(25.0))]);
    let c = b.node(&["Person"], &[("name", s("carol")), ("age", n(40.0))]);
    b.edge(a, bob, "KNOWS");
    b.edge(a, c, "KNOWS");
    b.edge(bob, c, "KNOWS");
    b.build()
}

fn bag(rows: &Rows) -> Vec<String> {
    let mut out: Vec<String> = rows
        .rows
        .iter()
        .map(|r| r.iter().map(|v| format!("{v:?};")).collect::<String>())
        .collect();
    out.sort();
    out
}

/// Optimizing must never change the answer — the core invariant.
fn assert_rows_preserved(plan: &Plan, store: &Store) -> Plan {
    let before = bag(&run(plan, store));
    let opt = optimize(plan.clone());
    assert_eq!(before, bag(&run(&opt, store)), "optimize changed the rows");
    opt
}

/// `Scan(label) + Filter(prop = lit)` seeds to `IndexSeek` — for BOTH
/// spellings, which must land on the SAME seek target (the
/// equivalent-spellings-cost-the-same invariant) and preserve the rows.
#[test]
fn scan_filter_eq_seeds_index_both_spellings() {
    let store = social();
    let plan_of = |pred| {
        Plan::Scan {
            label: Some("Person".into()),
        }
        .filter(pred)
        .project(vec![("name".into(), prop(0, "name"))])
    };
    let a = plan_of(cmp(CompareOp::Eq, prop(0, "name"), Expr::Lit(s("alice"))));
    let b = plan_of(cmp(CompareOp::Eq, Expr::Lit(s("alice")), prop(0, "name")));

    let oa = assert_rows_preserved(&a, &store);
    let ob = assert_rows_preserved(&b, &store);

    // Both spellings become Project{ IndexSeek{Person, name, "alice"} }.
    let target = |p: &Plan| -> (String, String, Value) {
        let Plan::Project { input, .. } = p else {
            panic!("expected Project, got {p:?}")
        };
        let Plan::IndexSeek { label, key, value } = input.as_ref() else {
            panic!("expected IndexSeek under Project, got {input:?}")
        };
        (
            label.clone().expect("seeded with a label"),
            key.clone(),
            value.clone(),
        )
    };
    let (la, ka, va) = target(&oa);
    let (lb, kb, vb) = target(&ob);
    assert_eq!((la.as_str(), ka.as_str()), ("Person", "name"));
    assert_eq!((la, ka), (lb, kb)); // identical target for both spellings
    assert!(matches!(&va, Value::Str(x) if &**x == "alice"));
    assert!(matches!(&vb, Value::Str(x) if &**x == "alice"));
    assert_eq!(bag(&run(&oa, &store)), vec!["Str(\"alice\");"]);
}

/// A dotted record-field equality `n.meta.city = 'NYC'` seeds a dotted
/// `IndexSeek` — both spellings land the SAME target — and gives the right
/// rows both WITH an index (index_lookup) and WITHOUT (the path-resolving scan
/// fallback).
#[test]
fn dotted_field_eq_seeds_index_both_spellings() {
    use crate::value::make_record;
    let build = || {
        let mut b = Builder::default();
        b.node(
            &["Person"],
            &[
                ("name", s("alice")),
                (
                    "meta",
                    make_record(vec![(crate::gstr::GStr::from("city"), s("NYC"))]),
                ),
            ],
        );
        b.node(
            &["Person"],
            &[
                ("name", s("bob")),
                (
                    "meta",
                    make_record(vec![(crate::gstr::GStr::from("city"), s("LA"))]),
                ),
            ],
        );
        b.build()
    };
    let field = Expr::Field {
        base: Box::new(prop(0, "meta")),
        key: "city".into(),
    };
    let plan_of = |pred| {
        Plan::Scan {
            label: Some("Person".into()),
        }
        .filter(pred)
        .project(vec![("name".into(), prop(0, "name"))])
    };
    let a = plan_of(cmp(CompareOp::Eq, field.clone(), Expr::Lit(s("NYC"))));
    let b = plan_of(cmp(CompareOp::Eq, Expr::Lit(s("NYC")), field.clone()));

    let mut store = build();
    store.create_index("meta.city");
    let oa = assert_rows_preserved(&a, &store);
    let ob = assert_rows_preserved(&b, &store);

    let target = |p: &Plan| -> (String, Value) {
        let Plan::Project { input, .. } = p else {
            panic!("expected Project, got {p:?}")
        };
        let Plan::IndexSeek { key, value, .. } = input.as_ref() else {
            panic!("expected a (dotted) IndexSeek, got {input:?}")
        };
        (key.clone(), value.clone())
    };
    let (ka, va) = target(&oa);
    let (kb, _) = target(&ob);
    assert_eq!(ka, "meta.city");
    assert_eq!(ka, kb); // both spellings, same dotted target
    assert!(matches!(&va, Value::Str(x) if &**x == "NYC"));
    assert_eq!(bag(&run(&oa, &store)), vec!["Str(\"alice\");"]);

    // Same seed, NO index: the scan fallback resolves the path and matches.
    let no_index = build();
    let oc = optimize(a.clone());
    assert!(
        matches!(&oc, Plan::Project { input, .. } if matches!(input.as_ref(), Plan::IndexSeek { .. }))
    );
    assert_eq!(bag(&run(&oc, &no_index)), vec!["Str(\"alice\");"]);
}

/// A range filter is NOT seeded (that is D2); an unlabelled scan cannot seek.
/// An unlabelled scan cannot seek (IndexSeek/RangeSeek need a label), so its
/// filter is preserved. (A labelled range filter now seeds — see the range
/// seed test.)
#[test]
fn unlabelled_scan_seeds_too() {
    let store = social();
    let unlabelled = Plan::Scan { label: None }
        .filter(cmp(CompareOp::Eq, prop(0, "name"), Expr::Lit(s("alice"))))
        .project(vec![("name".into(), prop(0, "name"))]);
    let opt = assert_rows_preserved(&unlabelled, &store);

    // This test asserted the OPPOSITE until 2026-09-17, when the seeks' required
    // label became optional. Requiring one meant `MATCH (n) WHERE n.age > 98` could
    // never touch an index — 303us against 30.6us for the labelled spelling over the
    // same rows — and nothing about the index needed it: both property indexes are
    // keyed by PROPERTY, and the label was only ever a post-filter on the candidates.
    fn seeks(p: &Plan) -> bool {
        match p {
            Plan::IndexSeek { .. } | Plan::RangeSeek { .. } => true,
            Plan::Project { input, .. } | Plan::Filter { input, .. } => seeks(input),
            _ => false,
        }
    }

    assert!(seeks(&opt), "an unlabelled scan should seed: {opt:?}");
}

/// A range filter over a labelled scan seeds to a `RangeSeek`, for BOTH
/// spellings (`age > 28` and `28 < age`), which land the SAME target and
/// preserve rows (equivalent-spellings for ranges).
#[test]
fn range_filter_seeds_both_spellings() {
    // A RangeSeek is only planned when a range index can serve it (else the
    // vectorized Filter path is faster than the seek's scan-and-box fallback),
    // so this fixture builds one on `age`.
    let mut store = social();
    store.create_range_index("age");
    let plan_of = |pred| {
        Plan::Scan {
            label: Some("Person".into()),
        }
        .filter(pred)
        .project(vec![("name".into(), prop(0, "name"))])
    };
    // age > 28  and  28 < age  are the same predicate, different spelling.
    let a = plan_of(cmp(CompareOp::Gt, prop(0, "age"), Expr::Lit(n(28.0))));
    let b = plan_of(cmp(CompareOp::Lt, Expr::Lit(n(28.0)), prop(0, "age")));
    // Optimize through the indexed path (both spellings must normalize to the
    // same RangeSeek) and confirm the rows are unchanged from the raw plan.
    let oa = optimize_indexed(a.clone(), &store);
    let ob = optimize_indexed(b.clone(), &store);
    assert_eq!(bag(&run(&a, &store)), bag(&run(&oa, &store)));
    assert_eq!(bag(&run(&b, &store)), bag(&run(&ob, &store)));

    let target = |p: &Plan| -> (String, CompareOp, Value) {
        let Plan::Project { input, .. } = p else {
            panic!("expected Project, got {p:?}")
        };
        let Plan::RangeSeek { key, op, value, .. } = input.as_ref() else {
            panic!("expected RangeSeek under Project, got {input:?}")
        };
        (key.clone(), *op, value.clone())
    };
    let (ka, opa, va) = target(&oa);
    let (kb, opb, vb) = target(&ob);
    assert_eq!(ka, "age");
    assert_eq!(opa, CompareOp::Gt); // both normalize to prop > 28
    assert_eq!((ka, opa), (kb, opb));
    assert!(matches!(va, Value::Num(x) if x == 28.0));
    assert!(matches!(vb, Value::Num(x) if x == 28.0));
    // answer: alice(30), carol(40)
    let mut got = bag(&run(&oa, &store));
    got.sort();
    assert_eq!(got, vec!["Str(\"alice\");", "Str(\"carol\");"]);
}

#[test]
fn pushdown_below_expand() {
    let store = social();
    // Filter on slot 0 (the source) sits above the Expand; it should move
    // below it.
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .expand(0, Dir::Out, &["KNOWS".to_string()])
    .filter(cmp(CompareOp::Eq, prop(0, "name"), Expr::Lit(s("alice"))));
    let opt = assert_rows_preserved(&plan, &store);
    // Shape: Expand{ input: <pushed-down predicate> }. The pushed filter over
    // Scan(label) then seeds to an IndexSeek — either form proves the
    // predicate moved below the Expand.
    match opt {
        Plan::Expand { input, .. } => {
            assert!(
                matches!(*input, Plan::Filter { .. } | Plan::IndexSeek { .. }),
                "predicate now below expand (as Filter or IndexSeek)"
            );
        }
        other => panic!("expected Expand at top, got {other:?}"),
    }
}

#[test]
fn no_pushdown_when_predicate_reads_the_expanded_slot() {
    let store = social();
    // Filter on slot 1 (the expanded neighbour) cannot move below the Expand.
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .expand(0, Dir::Out, &["KNOWS".to_string()])
    .filter(cmp(CompareOp::Ge, prop(1, "age"), Expr::Lit(n(40.0))));
    let opt = assert_rows_preserved(&plan, &store);
    // Shape unchanged: Filter still on top of Expand.
    match opt {
        Plan::Filter { input, .. } => {
            assert!(
                matches!(*input, Plan::Expand { .. }),
                "filter stays above expand"
            );
        }
        other => panic!("expected Filter at top, got {other:?}"),
    }
}

#[test]
fn varlen_split_pushdown_source_below_target_above() {
    let store = social();
    // `a.name = 'alice' AND b.age >= 40` over a var-length hop: the source
    // conjunct (slot 0) pushes below the VarLength; the target conjunct (slot 1,
    // the appended endpoint) stays above. Rows must be unchanged.
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .var_length(0, Dir::Out, &["KNOWS".to_string()], 1, 2, PathMode::Trail)
    .filter(Expr::And(
        Box::new(cmp(CompareOp::Eq, prop(0, "name"), Expr::Lit(s("alice")))),
        Box::new(cmp(CompareOp::Ge, prop(1, "age"), Expr::Lit(n(40.0)))),
    ));
    let opt = assert_rows_preserved(&plan, &store);
    // Shape: Filter{target} over VarLength{ input: <pushed source> }.
    match opt {
        Plan::Filter { input, pred } => {
            assert!(!refs_below(&pred, 1), "the residual reads the target slot");
            let Plan::VarLength { input: vin, .. } = *input else {
                panic!("expected VarLength under the residual filter");
            };
            assert!(
                matches!(*vin, Plan::Filter { .. } | Plan::IndexSeek { .. }),
                "the source predicate moved below the VarLength"
            );
        }
        other => panic!("expected a residual Filter on top, got {other:?}"),
    }
}

#[test]
fn shortest_path_source_filter_pushes_down() {
    let store = social();
    // A pure source filter over ShortestPath pushes fully below it (no residual).
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .shortest_path(
        0,
        Dir::Out,
        &["KNOWS".to_string()],
        1,
        None,
        crate::ir::ShortestSelector::Any,
        None,
    )
    .filter(cmp(CompareOp::Eq, prop(0, "name"), Expr::Lit(s("alice"))));
    let opt = assert_rows_preserved(&plan, &store);
    match opt {
        Plan::ShortestPath { input, .. } => assert!(
            matches!(*input, Plan::Filter { .. } | Plan::IndexSeek { .. }),
            "source predicate now below the ShortestPath"
        ),
        other => panic!("expected ShortestPath at top, got {other:?}"),
    }
}

#[test]
fn adjacent_filters_merge() {
    let store = social();
    // An unlabelled scan used to be the way to keep seeding out of this test, since
    // the seeks once required a label. They no longer do, so the merge is observed
    // through its CONSEQUENCE instead: the two conjuncts must fuse before the seeding
    // rule can take one as the seek and leave the other as a residual. Two filters
    // that never merged would leave the outer one stranded above.
    // One conjunct is an EQUALITY so the merged filter has something worth seeding:
    // a range conjunct alone cannot seed here, because this store has no range index
    // and an unindexed `RangeSeek` falls back to a scan that BOXES every cell —
    // measured 3873.0us against 3456.9us for the `Filter(Scan)` it replaces (E76), so
    // the planner no longer takes that rung.
    let plan = Plan::Scan { label: None }
        .filter(cmp(CompareOp::Ge, prop(0, "age"), Expr::Lit(n(28.0))))
        .filter(cmp(CompareOp::Eq, prop(0, "name"), Expr::Lit(s("alice"))));
    let opt = assert_rows_preserved(&plan, &store);
    // And the answer: alice is 30, so she passes both.
    assert_eq!(run(&opt, &store).rows.len(), 1);
    // Shape: ONE residual filter, directly over the seek — not two stacked.
    match &opt {
        Plan::Filter { input, pred } => {
            assert!(
                !matches!(pred, Expr::And(..)),
                "one conjunct should have become the seek, leaving a single residual"
            );
            assert!(
                matches!(**input, Plan::IndexSeek { .. }),
                "the merged conjunction seeded, got {input:?}"
            );
        }
        other => panic!("expected a single Filter over a seek, got {other:?}"),
    }
}

#[test]
fn driver_reaches_fixpoint_merge_then_pushdown() {
    let store = social();
    // Two filters (slot 0) above an Expand: the driver must MERGE them, PUSH the
    // merged filter below the Expand, and then SEED from it — three rules, to a
    // fixpoint. (Seeding used to be kept out of this by leaving the scan unlabelled;
    // the seeks no longer require a label, so it is part of what is checked.)
    let plan = Plan::Scan { label: None }
        .expand(0, Dir::Out, &["KNOWS".to_string()])
        .filter(cmp(CompareOp::Le, prop(0, "age"), Expr::Lit(n(100.0))))
        .filter(cmp(CompareOp::Eq, prop(0, "name"), Expr::Lit(s("alice"))));
    let opt = assert_rows_preserved(&plan, &store);
    match opt {
        Plan::Expand { input, .. } => match *input {
            // Merged, pushed below the hop, and one conjunct consumed by the seek.
            Plan::Filter { input, pred } => {
                assert!(
                    !matches!(pred, Expr::And(..)),
                    "one conjunct should have become the seek"
                );
                assert!(
                    matches!(*input, Plan::IndexSeek { .. }),
                    "expected the pushed filter to seed, got {input:?}"
                );
            }
            other => panic!("expected a residual Filter below Expand, got {other:?}"),
        },
        other => panic!("expected Expand at top, got {other:?}"),
    }
}

#[test]
fn pushdown_into_join_left() {
    let store = social();
    // A filter on a left-side slot pushes into the Join's left input.
    // Unlabelled left scan so the pushed filter stays a Filter (not seeded),
    // which is what this test checks.
    let left = Plan::Scan { label: None }.expand(0, Dir::Out, &["KNOWS".to_string()]);
    let right = Plan::Scan {
        label: Some("Person".into()),
    }
    .expand(0, Dir::Out, &["KNOWS".to_string()]);
    // left width is 2 (a, b); a filter on slot 0 (left's a) pushes left.
    let plan = Plan::join(left, right, vec![(0, 0)]).filter(cmp(
        CompareOp::Ge,
        prop(0, "age"),
        Expr::Lit(n(30.0)),
    ));
    let opt = assert_rows_preserved(&plan, &store);
    match opt {
        Plan::Join { left, .. } => {
            // The left input now begins with a Filter somewhere it was pushed
            // to (top of the left subtree, above or below its own expand).
            let has_filter = plan_contains_filter(&left);
            assert!(has_filter, "filter pushed into the left side");
        }
        other => panic!("expected Join at top, got {other:?}"),
    }
}

fn plan_contains_filter(p: &Plan) -> bool {
    match p {
        Plan::Filter { .. } => true,
        Plan::PathRecord { input, .. }
        | Plan::Expand { input, .. }
        | Plan::Unwind { input, .. }
        | Plan::OptionalExpand { input, .. }
        | Plan::IntervalExpand { input, .. }
        | Plan::VarLength { input, .. }
        | Plan::RepeatGroup { input, .. }
        | Plan::NestedGroup { input, .. }
        | Plan::ShortestPath { input, .. }
        | Plan::Aggregate { input, .. }
        | Plan::OrderPage { input, .. }
        | Plan::Project { input, .. }
        | Plan::Update { input, .. }
        | Plan::CallInline { input, .. }
        | Plan::Distinct { input }
        | Plan::Fail { input, .. }
        | Plan::DistinctBy { input, .. }
        | Plan::Tail { input, .. }
        | Plan::Sample { input, .. }
        | Plan::Branch { input, .. }
        | Plan::Reconverge { input, .. }
        | Plan::NullPadIfEmpty { input, .. }
        | Plan::OptionalScan { input, .. }
        | Plan::GroupToMap { input }
        | Plan::AlgoAnnotate { input, .. }
        | Plan::Tree { input, .. }
        | Plan::MapSlot { input, .. }
        | Plan::EdgeVertex { input, .. }
        | Plan::Enumerate { input, .. }
        | Plan::Subgraph { input, .. }
        | Plan::ShortestPathEnum { input, .. }
        | Plan::SortLocal { input, .. } => plan_contains_filter(input),
        Plan::Join { left, right, .. } | Plan::Union { left, right, .. } => {
            plan_contains_filter(left) || plan_contains_filter(right)
        }
        Plan::PerElementBranch {
            input, cond, arms, ..
        } => {
            plan_contains_filter(input)
                || cond.as_deref().is_some_and(plan_contains_filter)
                || arms.iter().any(plan_contains_filter)
        }
        Plan::InsertReturn { tail, .. } => plan_contains_filter(tail),
        Plan::UpdateReturn { input, tail, .. } => {
            plan_contains_filter(input) || plan_contains_filter(tail)
        }
        Plan::AddEdgeStep { input, tail, .. } | Plan::AddVertexStep { input, tail, .. } => {
            plan_contains_filter(input) || plan_contains_filter(tail)
        }
        Plan::Scan { .. }
        | Plan::NodeSeed { .. }
        | Plan::EdgeScan
        | Plan::EdgeSeed { .. }
        | Plan::Row
        | Plan::IndexSeek { .. }
        | Plan::RangeSeek { .. }
        | Plan::Insert { .. }
        | Plan::InsertFrom { .. }
        | Plan::Merge { .. }
        | Plan::MergeEdge { .. }
        | Plan::AddEdge { .. }
        | Plan::CallProcedure { .. }
        | Plan::TxControl { .. } => false,
    }
}

/// Optimizing a plan from the GQL front-end preserves rows — the rules fire
/// on either language's output because the IR is neutral.
#[test]
fn optimizes_a_parsed_gql_plan() {
    let store = social();
    let plan = crate::gql::parse(
        "MATCH (a:Person)-[:KNOWS]->(b) WHERE a.name = 'alice' RETURN b.name AS b",
    )
    .unwrap();
    // The WHERE (slot 0) should end up pushed below the Expand.
    let _ = assert_rows_preserved(&plan, &store);
}

/// `count(<bound element>)` over a pure chain canonicalizes to argument-free
/// `count(*)` (same plan → same O(1) fast path), while `count(<property>)` and
/// `count(DISTINCT …)` are left alone. The spelling-perf-cliff guard.
#[test]
fn count_of_bound_element_canonicalizes_to_count_star() {
    let store = social();
    let plan_str = |q: &str| format!("{:?}", optimize(crate::gql::parse(q).unwrap()));

    // count(n) == count(*) and count(b) == count(*) (1-hop), same optimized plan.
    assert_eq!(
        plan_str("MATCH (n:Person) RETURN count(n) AS c"),
        plan_str("MATCH (n:Person) RETURN count(*) AS c"),
    );
    assert_eq!(
        plan_str("MATCH (a:Person)-[:KNOWS]->(b) RETURN count(b) AS c"),
        plan_str("MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c"),
    );
    // A property count and a DISTINCT element count are NOT count(*).
    assert_ne!(
        plan_str("MATCH (n:Person) RETURN count(n.age) AS c"),
        plan_str("MATCH (n:Person) RETURN count(*) AS c"),
    );
    assert_ne!(
        plan_str("MATCH (n:Person) RETURN count(DISTINCT n) AS c"),
        plan_str("MATCH (n:Person) RETURN count(*) AS c"),
    );

    // And every one of these still returns the SAME rows before/after optimizing.
    for q in [
        "MATCH (n:Person) RETURN count(n) AS c",
        "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(b) AS c",
        "MATCH (n:Person) RETURN count(n.age) AS c",
    ] {
        assert_rows_preserved(&crate::gql::parse(q).unwrap(), &store);
    }
}

/// A multi-predicate `WHERE a = x AND b = y` seeds ONE conjunct into a seek and
/// keeps the rest as a residual filter — so it costs the same as the inline
/// `(n:L {a: x, b: y})` twin (which already seeded), not a full-scan conjunction.
/// The `count(*)`-shaped fixture is the one that showed the 34x gap.
#[test]
fn multi_predicate_where_seeds_a_conjunct() {
    let store = social();
    let seeded = |q: &str| {
        let p = optimize(crate::gql::parse(q).unwrap());
        format!("{p:?}").contains("IndexSeek")
    };
    // Both AND and the inline map seed; a lone equality already did.
    assert!(seeded(
        "MATCH (n:Person) WHERE n.name = 'alice' AND n.age = 30 RETURN count(*) AS c"
    ));
    assert!(seeded(
        "MATCH (n:Person {name: 'alice', age: 30}) RETURN count(*) AS c"
    ));
    // The two spellings optimize to the SAME plan (same seek + residual).
    assert_eq!(
        format!(
            "{:?}",
            optimize(
                crate::gql::parse("MATCH (n:Person {name: 'alice', age: 30}) RETURN n.age AS a")
                    .unwrap()
            )
        ),
        format!(
            "{:?}",
            optimize(
                crate::gql::parse(
                    "MATCH (n:Person) WHERE n.name = 'alice' AND n.age = 30 RETURN n.age AS a"
                )
                .unwrap()
            )
        ),
    );
    // And the rewrite never changes the rows (a 3-conjunct case too).
    for q in [
            "MATCH (n:Person) WHERE n.name = 'alice' AND n.age = 30 RETURN n.name AS x",
            "MATCH (n:Person) WHERE n.age >= 20 AND n.age <= 40 AND n.name = 'carol' RETURN n.name AS x",
        ] {
            assert_rows_preserved(&crate::gql::parse(q).unwrap(), &store);
        }
}

/// The multi-predicate seed is INDEX-AWARE: it seeds the conjunct backed by a
/// real index (so the seek reads the index, not a scan), falling back to the
/// first seekable conjunct only when nothing is indexed. The store-less
/// `optimize` stays blind (unchanged behavior).
#[test]
fn multi_predicate_seed_prefers_the_indexed_conjunct() {
    let fresh = || {
        let mut b = Builder::default();
        for i in 0..40u32 {
            b.node(
                &["Person"],
                &[
                    ("dept", s(if i % 2 == 0 { "eng" } else { "sales" })),
                    ("age", n(f64::from(i % 10))),
                ],
            );
        }
        b.build()
    };
    let q = "MATCH (n:Person) WHERE n.dept = 'eng' AND n.age = 4 RETURN n.age AS a";
    let plan = crate::gql::parse(q).unwrap();
    let seeded_key = |store: &Store| -> Option<String> {
        fn find(p: &Plan) -> Option<String> {
            match p {
                Plan::IndexSeek { key, .. } => Some(key.clone()),
                Plan::Filter { input, .. }
                | Plan::Project { input, .. }
                | Plan::Aggregate { input, .. } => find(input),
                _ => None,
            }
        }
        find(&optimize_indexed(plan.clone(), store))
    };

    // No index → first seekable conjunct (dept).
    let mut plain = fresh();
    assert_eq!(seeded_key(&plain).as_deref(), Some("dept"));
    // Index on age → the seed switches to age (the indexed conjunct).
    plain.create_index("age");
    assert_eq!(seeded_key(&plain).as_deref(), Some("age"));
    // Index on dept instead → seeds dept.
    let mut dept_idx = fresh();
    dept_idx.create_index("dept");
    assert_eq!(seeded_key(&dept_idx).as_deref(), Some("dept"));
    // The store-less path is unchanged (blind): seeds the first conjunct.
    assert!(format!("{:?}", optimize(plan)).contains("key: \"dept\""));
}

/// Gremlin `order().by(k)` + `range(lo, hi)` lowers to two stacked OrderPages;
/// merging the page into the sort must NOT change which rows come back — the
/// delicate case is a TIE at the page boundary, where the surviving rows depend
/// on tie-breaking. A fixture with many equal keys stresses exactly that.
#[test]
fn stacked_orderpage_merge_preserves_rows_under_ties() {
    let mut b = Builder::default();
    // 12 nodes, keys in {0,1,2} — heavy ties, so a top-k boundary lands inside a
    // tie group and the merged vs stacked forms must agree on which rows win.
    for i in 0..12u32 {
        b.node(
            &["P"],
            &[("k", n(f64::from(i % 3))), ("id", n(f64::from(i)))],
        );
    }
    let store = b.build();
    // Gremlin forms that produce stacked OrderPages (sort, then page).
    for q in [
        "g.V().hasLabel('P').order().by('k', desc).range(0, 2).values('id')",
        "g.V().hasLabel('P').order().by('k').range(1, 4).values('id')",
        "g.V().hasLabel('P').order().by('k', desc).range(2, 5).values('id')",
    ] {
        let plan = crate::gremlin::parse(q).unwrap();
        // Sanity: the UNoptimized plan really is two stacked OrderPages. `values`
        // now skips absent properties, so a `Filter` (PropertyExists) sits between
        // the Project and the OrderPages — descend through it.
        let below_project = match &plan {
            Plan::Project { input, .. } => match input.as_ref() {
                Plan::Filter { input, .. } => input.as_ref(),
                other => other,
            },
            other => other,
        };
        assert!(
            matches!(below_project, Plan::OrderPage { input: inner, keys, .. }
                    if keys.is_empty() && matches!(inner.as_ref(), Plan::OrderPage { .. })),
            "expected stacked OrderPages for `{q}`"
        );
        assert_rows_preserved(&plan, &store);
    }
}

// ─────────────────────────────────────────────────────── pattern orientation ───

/// A store whose `age` carries a RANGE index, so the orientation rule has something
/// to seed from. Without one it must decline — reversing a scan into a scan is no
/// improvement, only churn.
fn social_indexed() -> Store {
    let mut store = social();
    store.create_range_index("age");
    store
}

/// An UNLABELLED far node does not reverse, even though the predicate is seekable.
/// Without a label the reversed seed is `Filter <- Scan { None }`, which no seeding
/// rule can turn into a seek — so the reversal buys a pre-filter but pays a residual
/// `IsLabeled` above the hop, and that residual defeats the `count(*)` degree-sum
/// shortcut. Measured, it trades on selectivity and can lose badly: `b.age > 98` (1%
/// pass) went 1652us -> 669us, but `b.age > -1` (100% pass) went 788us -> 3805us.
/// Fire only on a provable win; the speculative case needs a cardinality estimate.
#[test]
fn orient_declines_an_unlabelled_far_node() {
    let store = social_indexed();
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0)))),
        ),
        items: vec![("who".into(), prop(0, "name"))],
    };

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);

    assert_eq!(before, bag(&run(&opt, &store)), "the rows changed");

    fn hop_dir(plan: &Plan) -> Option<Dir> {
        match plan {
            Plan::Expand { dir, .. } => Some(*dir),
            Plan::Filter { input, .. }
            | Plan::Project { input, .. }
            | Plan::Aggregate { input, .. } => hop_dir(input),
            _ => None,
        }
    }

    assert_eq!(
        hop_dir(&opt),
        Some(Dir::Out),
        "an unlabelled far node must keep its written direction: {opt:?}"
    );
}

/// Slot indices are NOT global: an `Aggregate` starts a fresh namespace, so `Slot(0)`
/// above one is its first OUTPUT column and must NOT be renamed with the pattern's
/// slots. The first version of this rewrite renamed straight through the boundary and
/// turned `count(*)` into a read of a column that does not exist.
#[test]
fn orient_does_not_rename_across_an_aggregate() {
    let store = social_indexed();
    let plan = Plan::Project {
        input: Box::new(Plan::Aggregate {
            input: Box::new(
                Plan::Scan {
                    label: Some("Person".into()),
                }
                .expand(0, Dir::Out, &["KNOWS".to_string()])
                .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0)))),
            ),
            keys: vec![],
            aggs: vec![crate::ir::Agg {
                func: crate::ir::AggFn::Count,
                arg: None,
                distinct: false,
                name: "c".into(),
                frac: None,
                null_on_empty: false,
                numeric_only: false,
            }],
        }),
        // Reads the AGGREGATE's output column, not the pattern's slot 0.
        items: vec![("c".into(), Expr::Slot(0))],
    };

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);
    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "orientation changed the count"
    );
}

/// With the pattern's slots exposed at the root they are the query's OUTPUT columns,
/// so reversing would return `(b, a)` for a query that asked for `(a, b)`. Caught by
/// this test returning `carol, carol` where the answer is `alice, bob` — a wrong
/// answer, not a crash, which is why the rule now requires a closing projection.
#[test]
fn orient_declines_when_the_pattern_is_the_output() {
    let store = social_indexed();
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .expand(0, Dir::Out, &["KNOWS".to_string()])
    .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0))));

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);
    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "orientation changed the rows"
    );
}

/// A predicate that reads BOTH ends cannot be moved to the seed: the far half would
/// arrive before the near slot exists. `max_slot` alone does not catch this (it is a
/// maximum), so the rule checks the swapped predicate instead.
#[test]
fn orient_declines_a_predicate_reading_both_ends() {
    let store = social_indexed();
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .expand(0, Dir::Out, &["KNOWS".to_string()])
    .filter(Expr::And(
        Box::new(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0)))),
        Box::new(cmp(CompareOp::Gt, prop(0, "age"), Expr::Lit(n(20.0)))),
    ));

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan.clone(), &store);
    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "rows must survive either way"
    );

    // Still walking the written direction — the reversal declined.
    fn first_dir(p: &Plan) -> Option<Dir> {
        match p {
            Plan::Expand { dir, .. } => Some(*dir),
            Plan::Filter { input, .. } => first_dir(input),
            _ => None,
        }
    }

    assert_eq!(first_dir(&opt), Some(Dir::Out), "not reversed: {opt:?}");
}

/// With no index there is nothing to seed from, so reversing would trade one scan for
/// another. The rule must leave the plan alone.
#[test]
fn orient_declines_without_an_index() {
    let store = social(); // no range index
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .expand(0, Dir::Out, &["KNOWS".to_string()])
    .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0))));

    let opt = optimize_indexed(plan, &store);

    fn first_dir(p: &Plan) -> Option<Dir> {
        match p {
            Plan::Expand { dir, .. } => Some(*dir),
            Plan::Filter { input, .. } => first_dir(input),
            _ => None,
        }
    }

    assert_eq!(first_dir(&opt), Some(Dir::Out), "not reversed: {opt:?}");
}

/// Does `plan` contain a `RangeSeek` anywhere down its spine?
fn has_range_seek(plan: &Plan) -> bool {
    match plan {
        Plan::RangeSeek { .. } => true,
        Plan::Project { input, .. }
        | Plan::Aggregate { input, .. }
        | Plan::Distinct { input }
        | Plan::Filter { input, .. }
        | Plan::OrderPage { input, .. }
        | Plan::Expand { input, .. } => has_range_seek(input),
        _ => false,
    }
}

/// The ORDERING regression. A pattern written `(a:L)-[:T]->(b:M)` arrives as two
/// STACKED filters, which the local rules merge into one `And`. Orientation used to
/// run BEFORE that merge, so this — the only shape whose reversed seed can become a
/// seek, since `RangeSeek` requires a label — never matched the rewrite at all, and
/// measured 2.7x SLOWER than the same query with `(b)` left unlabelled.
#[test]
fn orient_seeds_when_the_far_node_carries_a_label() {
    let store = social_indexed();
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::IsLabeled {
                slot: 1,
                labels: vec!["Person".into()],
            })
            .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0)))),
        ),
        items: vec![("who".into(), prop(0, "name"))],
    };

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);

    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "orientation changed the rows"
    );
    assert!(
        has_range_seek(&opt),
        "the lifted label should let the reversed seed become a seek: {opt:?}"
    );
}

/// `Scan` carries ONE label, so a multi-label check (`:A|B`) cannot be lifted onto it.
/// The reversal may still happen — it just seeds a plain scan and keeps the check as a
/// residual filter. What must NOT happen is lifting one arm and dropping the other,
/// which would silently widen the answer.
#[test]
fn orient_does_not_lift_a_multi_label_check() {
    let store = social_indexed();
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::And(
                Box::new(Expr::IsLabeled {
                    slot: 1,
                    labels: vec!["Person".into(), "Robot".into()],
                }),
                Box::new(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0)))),
            )),
        ),
        items: vec![("who".into(), prop(0, "name"))],
    };

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);

    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "orientation changed the rows"
    );
    assert!(
        !has_range_seek(&opt),
        "a two-label check is not liftable onto a one-label Scan: {opt:?}"
    );
}

/// The label may be written on EITHER side of the conjunction — `b:Person AND b.age >
/// 26` and `b.age > 26 AND b:Person` are the same query, and the equivalent-spellings
/// rule says they must cost the same. `lift_seed_label` recurses both arms.
#[test]
fn orient_lifts_the_label_from_either_side_of_the_conjunction() {
    let store = social_indexed();
    let build = |label_first: bool| {
        let lab = Expr::IsLabeled {
            slot: 1,
            labels: vec!["Person".into()],
        };
        let age = cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0)));
        let pred = if label_first {
            Expr::And(Box::new(lab), Box::new(age))
        } else {
            Expr::And(Box::new(age), Box::new(lab))
        };

        Plan::Project {
            input: Box::new(
                Plan::Scan {
                    label: Some("Person".into()),
                }
                .expand(0, Dir::Out, &["KNOWS".to_string()])
                .filter(pred),
            ),
            items: vec![("who".into(), prop(0, "name"))],
        }
    };

    let first = optimize_indexed(build(true), &store);
    let second = optimize_indexed(build(false), &store);

    assert!(
        has_range_seek(&first),
        "label first did not seek: {first:?}"
    );
    assert!(
        has_range_seek(&second),
        "label second did not seek: {second:?}"
    );
    assert_eq!(
        bag(&run(&first, &store)),
        bag(&run(&second, &store)),
        "the two spellings disagree on the answer"
    );
}

/// A MIXED conjunction over an `Expand` must split: the conjunct reading only the
/// pre-hop slots goes below (where it can seed a seek), the rest stays above.
///
/// The all-or-nothing guard this replaces made an ordinary query 300x slower for a
/// reason no user could see. Both ends of `(a:L)-[:T]->(b:M) WHERE a.k > v` lower to
/// stacked filters; the merge rule fuses them into one `And`; and from then on the
/// slot-1 label check pinned the slot-0 range predicate above the hop, so the walk
/// ran from every `L`. Writing `(b)` instead of `(b:M)` was 300x faster.
#[test]
fn pushdown_splits_a_mixed_conjunction_below_an_expand() {
    let store = social_indexed();
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::And(
                // Reads the APPENDED slot — must stay above the hop.
                Box::new(Expr::IsLabeled {
                    slot: 1,
                    labels: vec!["Person".into()],
                }),
                // Reads only the pre-hop slot — must go below, and seed.
                Box::new(cmp(CompareOp::Gt, prop(0, "age"), Expr::Lit(n(26.0)))),
            )),
        ),
        items: vec![("who".into(), prop(1, "name"))],
    };

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);

    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "the split changed the rows"
    );
    assert!(
        has_range_seek(&opt),
        "the slot-0 conjunct should have pushed below the hop and seeded: {opt:?}"
    );

    // And the slot-1 conjunct must NOT have gone with it.
    fn filter_above_expand(plan: &Plan) -> bool {
        match plan {
            Plan::Filter { input, .. } if matches!(input.as_ref(), Plan::Expand { .. }) => true,
            Plan::Project { input, .. }
            | Plan::Aggregate { input, .. }
            | Plan::Distinct { input }
            | Plan::Filter { input, .. }
            | Plan::Expand { input, .. } => filter_above_expand(input),
            _ => false,
        }
    }

    assert!(
        filter_above_expand(&opt),
        "the label check reads the appended slot and must stay above: {opt:?}"
    );
}

/// The split must not starve the interval-overlap fusion arm, which matches the SAME
/// `Expand` and whose predicate (reading the bound edge slot) is pushable by nothing.
/// The first version of the split dropped its match guard and silently disabled
/// interval seeks for every bitemporal query.
#[test]
fn pushdown_split_leaves_an_unpushable_predicate_for_a_later_arm() {
    let store = social_indexed();
    // Nothing here reads a pre-hop slot, so the pushdown arm must decline entirely
    // and hand the operator on unchanged rather than rebuilding it.
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .expand(0, Dir::Out, &["KNOWS".to_string()])
    .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0))));

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan.clone(), &store);

    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "the split changed the rows"
    );
}

/// A two-hop pattern reverses, and the MIDDLE node's label must survive the reversal.
///
/// This is the test the integration probe structurally cannot be: its fixture labels
/// every node `Person`, so dropping an intermediate `(b:Person)` check changes no
/// answer there. Here `b` is constrained to a label only some nodes carry, so a
/// dropped check shows up immediately as extra rows.
#[test]
fn orient_two_hop_keeps_the_middle_label() {
    let mut b = Builder::default();
    let a1 = b.node(&["Person"], &[("name", s("a1")), ("age", n(10.0))]);
    let hub = b.node(
        &["Person", "Staff"],
        &[("name", s("hub")), ("age", n(11.0))],
    );
    let plain = b.node(&["Person"], &[("name", s("plain")), ("age", n(12.0))]);
    let target = b.node(&["Person"], &[("name", s("target")), ("age", n(99.0))]);
    // Two routes a1 -> ? -> target; only the one through `hub` carries :Staff.
    b.edge(a1, hub, "KNOWS");
    b.edge(hub, target, "KNOWS");
    b.edge(a1, plain, "KNOWS");
    b.edge(plain, target, "KNOWS");
    let mut store = b.build();
    store.create_range_index("age");

    // (a:Person)-[:KNOWS]->(b:Staff)-[:KNOWS]->(c:Person) WHERE c.age > 98
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::IsLabeled {
                slot: 1,
                labels: vec!["Staff".into()],
            })
            .expand(1, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::And(
                Box::new(Expr::IsLabeled {
                    slot: 2,
                    labels: vec!["Person".into()],
                }),
                Box::new(cmp(CompareOp::Gt, prop(2, "age"), Expr::Lit(n(98.0)))),
            )),
        ),
        items: vec![("who".into(), prop(0, "name"))],
    };

    let before = bag(&run(&plan, &store));
    // Exactly one route qualifies — if the middle label were dropped it would be two.
    assert_eq!(before.len(), 1, "fixture: expected one qualifying route");

    let opt = optimize_indexed(plan, &store);
    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "the two-hop reversal changed the rows: {opt:?}"
    );
}

/// Mixed hop directions must each flip independently: `(a)-[:T]->(b)<-[:T]-(c)`
/// reversed is `(c)-[:T]->(b)<-[:T]-(a)`, not both hops pointing one way.
#[test]
fn orient_two_hop_flips_each_direction_independently() {
    let mut b = Builder::default();
    let a1 = b.node(&["Person"], &[("name", s("a1")), ("age", n(10.0))]);
    let mid = b.node(&["Person"], &[("name", s("mid")), ("age", n(11.0))]);
    let c1 = b.node(&["Person"], &[("name", s("c1")), ("age", n(99.0))]);
    let decoy = b.node(&["Person"], &[("name", s("decoy")), ("age", n(99.0))]);
    b.edge(a1, mid, "KNOWS"); // a -> mid
    b.edge(c1, mid, "KNOWS"); // c -> mid, so mid <- c
    b.edge(mid, decoy, "KNOWS"); // wrong direction for the pattern
    let mut store = b.build();
    store.create_range_index("age");

    // (a:Person)-[:KNOWS]->(b)<-[:KNOWS]-(c:Person) WHERE c.age > 98
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .expand(1, Dir::In, &["KNOWS".to_string()])
            .filter(Expr::And(
                Box::new(Expr::IsLabeled {
                    slot: 2,
                    labels: vec!["Person".into()],
                }),
                Box::new(cmp(CompareOp::Gt, prop(2, "age"), Expr::Lit(n(98.0)))),
            )),
        ),
        items: vec![
            ("who".into(), prop(0, "name")),
            ("far".into(), prop(2, "name")),
        ],
    };

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);

    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "mixed directions reversed wrongly: {opt:?}"
    );
}

/// THREE hops orient too, and this is the case that broke when the rename was a
/// single swap: at n = 3 the permutation is 0<->3 AND 1<->2, so the two MIDDLE slots
/// trade places. A swap of the ends alone leaves them crossed — which returns wrong
/// rows whenever the middles are distinguishable, and silently correct ones when they
/// are not. The fixture makes them distinguishable on purpose.
#[test]
fn orient_three_hops_does_not_cross_the_middle_slots() {
    let mut b = Builder::default();
    let a1 = b.node(&["Person"], &[("name", s("a1")), ("age", n(10.0))]);
    // Second hop must land on a :Mid, third on a :Late. Cross them and no row matches.
    let mid = b.node(&["Person", "Mid"], &[("name", s("mid")), ("age", n(11.0))]);
    let late = b.node(
        &["Person", "Late"],
        &[("name", s("late")), ("age", n(12.0))],
    );
    let target = b.node(&["Person"], &[("name", s("target")), ("age", n(99.0))]);
    b.edge(a1, mid, "KNOWS");
    b.edge(mid, late, "KNOWS");
    b.edge(late, target, "KNOWS");
    // A decoy route with the labels the other way round.
    let x = b.node(&["Person", "Late"], &[("name", s("x")), ("age", n(13.0))]);
    let y = b.node(&["Person", "Mid"], &[("name", s("y")), ("age", n(14.0))]);
    b.edge(a1, x, "KNOWS");
    b.edge(x, y, "KNOWS");
    b.edge(y, target, "KNOWS");
    // Filler, so `age > 98` is genuinely SELECTIVE. Orientation is gated on the far
    // predicate's measured share of the graph (`ORIENT_MAX_FRACTION`), and in a
    // six-node fixture one matching node is 17% — above the threshold, so the rewrite
    // would correctly decline and the test would be testing nothing.
    for i in 0..60 {
        b.node(&["Person"], &[("age", n(f64::from(i % 50)))]);
    }
    let mut store = b.build();
    store.create_range_index("age");

    // (a:Person)-[:KNOWS]->(b:Mid)-[:KNOWS]->(c:Late)-[:KNOWS]->(d:Person) WHERE d.age > 98
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::IsLabeled {
                slot: 1,
                labels: vec!["Mid".into()],
            })
            .expand(1, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::IsLabeled {
                slot: 2,
                labels: vec!["Late".into()],
            })
            .expand(2, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::And(
                Box::new(Expr::IsLabeled {
                    slot: 3,
                    labels: vec!["Person".into()],
                }),
                Box::new(cmp(CompareOp::Gt, prop(3, "age"), Expr::Lit(n(98.0)))),
            )),
        ),
        items: vec![("who".into(), prop(0, "name"))],
    };

    let before = bag(&run(&plan, &store));
    // Exactly the :Mid-then-:Late route. The decoy has them reversed and must not count.
    assert_eq!(
        before.len(),
        1,
        "fixture: expected exactly one qualifying route"
    );

    let opt = optimize_indexed(plan, &store);

    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "the three-hop reversal crossed the middle slots: {opt:?}"
    );
    assert!(
        has_range_seek(&opt),
        "three hops should now seed from the far end: {opt:?}"
    );
}

/// Orientation is gated on what the far-side predicate actually SELECTS, not on how
/// it is written. The same pattern, the same index, the same shape — one bound that
/// matches almost nothing and one that matches everything — must plan differently.
///
/// Reversing an unselective predicate is a measured regression (788us -> 3805us for
/// `b.age > -1`): the reversal shrinks nothing and still pays a residual label check
/// above the hop, which defeats the `count(*)` degree-sum shortcut.
#[test]
fn orient_declines_an_unselective_far_predicate() {
    let mut b = Builder::default();
    for i in 0..200 {
        b.node(&["Person"], &[("age", n(f64::from(i % 100)))]);
    }
    for i in 0..200u32 {
        b.edge(i, (i + 7) % 200, "KNOWS");
    }
    let mut store = b.build();
    store.create_range_index("age");

    let pattern = |bound: f64| Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(bound)))),
        ),
        items: vec![("who".into(), prop(0, "age"))],
    };

    // > 98 matches 1% of the graph — worth seeding from.
    let selective = pattern(98.0);
    let before = bag(&run(&selective, &store));
    let opt = optimize_indexed(selective, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "selective: rows changed");
    assert!(
        has_range_seek(&opt),
        "a 1% far predicate should orient and seed: {opt:?}"
    );

    // > -1 matches everything — reversing buys nothing and costs a residual check.
    let unselective = pattern(-1.0);
    let before = bag(&run(&unselective, &store));
    let opt = optimize_indexed(unselective, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "unselective: rows changed");
    assert!(
        !has_range_seek(&opt),
        "a predicate matching the whole graph must not orient: {opt:?}"
    );
}

/// An intermediate predicate that reads its hop's endpoint AND some other slot must
/// not be treated as belonging to that hop.
///
/// FOUND BY `rewrite_fuzz`, in code shipped two days earlier, and it is the same
/// "a maximum is not an only" mistake that `reverse_chain` already documents for the
/// far-side predicate — where a maximum of 0 is sufficient only because 0 is also the
/// minimum. A middle slot has no such luck: a predicate over slots {1, 4} has maximum
/// 4, so `peel_hops` accepted it as hop 4's, and `shift_slot` then renamed it as
/// though slot 1 were not there. The slot-1 conjunct came out reading slot 4 at a
/// point in the chain where only slots 0 and 1 exist — an out-of-bounds column read,
/// which panicked rather than answering wrongly, but only by luck.
///
/// A DISJUNCTION is what makes it reachable. An `And` over two slots is taken apart by
/// the per-conjunct pushdown split long before orientation sees it; an `Or` cannot be
/// split, so it arrives whole.
#[test]
fn orient_declines_an_intermediate_predicate_reading_two_slots() {
    // Big enough that `age > 46` is ~6% of the graph. Orientation is gated on the far
    // predicate selecting under ~15%, so a smaller fixture would make the rewrite
    // decline and the test would guard nothing.
    let mut b = Builder::default();
    for i in 0..100 {
        let mut labels: Vec<&str> = vec!["Node"];
        if i % 2 == 0 {
            labels.push("Half");
        }
        b.node(
            &labels,
            &[("name", s(&format!("n{i}"))), ("age", n(f64::from(i % 50)))],
        );
    }
    for i in 0..100u32 {
        b.edge(i, (i + 1) % 100, "T");
        b.edge(i, (i + 3) % 100, "T");
        b.edge(i, (i + 7) % 100, "T");
    }
    let mut store = b.build();
    store.create_range_index("age");

    // Three hops, with an Or spanning slot 1 and slot 3 sitting where the peeler would
    // otherwise attribute it to the hop that appends slot 3.
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Node".into()),
            }
            .expand(0, Dir::Out, &["T".to_string()])
            .expand(1, Dir::Out, &["T".to_string()])
            .expand(2, Dir::Out, &["T".to_string()])
            // The two-slot `Or`, sitting where the peeler will attribute it to the hop
            // that appends slot 3 — because 3 is its MAXIMUM slot. There must be hops
            // ABOVE it: as the last filter it would merge into the top-level predicate
            // instead, where a different (and correct) guard rejects it, and the bug
            // would not reproduce.
            .filter(Expr::Or(
                Box::new(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(40.0)))),
                Box::new(Expr::IsLabeled {
                    slot: 3,
                    labels: vec!["Half".into()],
                }),
            ))
            .expand(3, Dir::Out, &["T".to_string()])
            .expand(4, Dir::Out, &["T".to_string()])
            .filter(cmp(CompareOp::Gt, prop(5, "age"), Expr::Lit(n(46.0)))),
        ),
        items: vec![("a".into(), prop(0, "name")), ("f".into(), prop(5, "name"))],
    };

    let before = bag(&run(&plan, &store));
    assert!(!before.is_empty(), "fixture: expected some rows to match");

    let opt = optimize_indexed(plan, &store);
    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "a two-slot intermediate predicate was moved as if it read one: {opt:?}"
    );
}

/// A pattern under an `ORDER BY` orients, and the page's SORT KEYS are renamed with it.
///
/// `orient_scan` had no arm for `OrderPage`, so the whole plan declined and a query
/// with a far-side predicate and a sort scanned where the same query without the sort
/// sought. Safe, but a missed optimization on a shape most real queries have.
///
/// Reversing changes the order rows reach the sort, which with tied keys and a stable
/// sort changes their order out of it. That is already true of every seeding rewrite —
/// a `RangeSeek` yields index order where a `Scan` yields id order — so a tie's
/// position was never a property of the query. What must not change is the row set.
#[test]
fn orient_sees_through_an_order_by() {
    let store = social_indexed();
    let plan = Plan::Project {
        input: Box::new(
            Plan::Scan {
                label: Some("Person".into()),
            }
            .expand(0, Dir::Out, &["KNOWS".to_string()])
            .filter(Expr::And(
                Box::new(Expr::IsLabeled {
                    slot: 1,
                    labels: vec!["Person".into()],
                }),
                Box::new(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(26.0)))),
            ))
            .order_page(
                vec![
                    crate::ir::SortKey {
                        expr: prop(0, "name"),
                        descending: false,
                        nulls_first: false,
                    },
                    crate::ir::SortKey {
                        expr: prop(1, "name"),
                        descending: false,
                        nulls_first: false,
                    },
                ],
                None,
                None,
            ),
        ),
        items: vec![("a".into(), prop(0, "name")), ("b".into(), prop(1, "name"))],
    };

    let before = bag(&run(&plan, &store));
    assert!(!before.is_empty(), "fixture: expected rows");

    let opt = optimize_indexed(plan, &store);
    assert_eq!(
        before,
        bag(&run(&opt, &store)),
        "orienting under a sort changed the rows: {opt:?}"
    );
    assert!(
        has_range_seek(&opt),
        "a pattern under ORDER BY should still orient and seed: {opt:?}"
    );

    // And the keys must have moved with the slots they name.
    fn page_keys(p: &Plan) -> Option<&Vec<crate::ir::SortKey>> {
        match p {
            Plan::OrderPage { keys, .. } => Some(keys),
            Plan::Project { input, .. } | Plan::Filter { input, .. } => page_keys(input),
            _ => None,
        }
    }
    let keys = page_keys(&opt).expect("the page survived");
    assert_eq!(keys.len(), 2, "both keys kept: {opt:?}");
}

/// A range index is only seeded when it will actually FILTER. Declaring an index must
/// not make a broad query slower.
///
/// Measured (`simd_index_probe` E40, 200k `Person` rows): `age > 98` (1% pass) is 9.8x
/// faster with the index, 303us -> 31us; `age > 50` (49% pass) is 3.7x SLOWER,
/// 321us -> 1184us — seeking 98,000 rows costs more than scanning 200,000. The engine
/// seeded whenever an index existed, so a user could declare one and quietly lose 4x on
/// their broad queries.
///
/// The threshold is the measured crossover (`SEEK_MAX_FRACTION`): a scan is 1.88 ns per
/// node, a seek 12.2 ns per row returned, so a seek stops paying at 1.88/12.2 = 15.4%.
#[test]
fn a_range_index_is_seeded_only_when_it_is_selective() {
    // Above `SEEK_FLOOR_NODES`, or the rule declines to decide.
    let mut b = Builder::default();
    for i in 0..8_000 {
        b.node(
            &["Person"],
            &[
                ("name", s(&format!("n{i}"))),
                ("age", n(f64::from(i % 100))),
            ],
        );
    }
    let mut store = b.build();
    store.create_range_index("age");

    let q = |bound: f64| {
        Plan::Scan {
            label: Some("Person".into()),
        }
        .filter(cmp(CompareOp::Gt, prop(0, "age"), Expr::Lit(n(bound))))
        .project(vec![("who".into(), prop(0, "name"))])
    };

    // 1% of the graph — the index earns its keep.
    let selective = q(98.0);
    let before = bag(&run(&selective, &store));
    let opt = optimize_indexed(selective, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "selective: rows changed");
    assert!(
        has_range_seek(&opt),
        "a 1% predicate should seed the index: {opt:?}"
    );

    // 49% — seeking costs more than scanning, so the filter stays a filter.
    let broad = q(50.0);
    let before = bag(&run(&broad, &store));
    let opt = optimize_indexed(broad, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "broad: rows changed");
    assert!(
        !has_range_seek(&opt),
        "a 49% predicate must not seed: {opt:?}"
    );
}

/// Below the floor the rule declines to decide, keeping the planner's existing
/// behaviour. A full scan of 1,000 nodes is ~1.9us and the worst seek over them ~6us,
/// so choosing differently would churn plans over a difference nobody can measure.
#[test]
fn a_tiny_graph_still_seeds_whatever_the_selectivity() {
    let mut b = Builder::default();
    for i in 0..64 {
        b.node(
            &["Person"],
            &[
                ("name", s(&format!("n{i}"))),
                ("age", n(f64::from(i % 100))),
            ],
        );
    }
    let mut store = b.build();
    store.create_range_index("age");

    // Selects everything — unselective by any measure, and still seeded, because at
    // this size the decision is noise.
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .filter(cmp(CompareOp::Gt, prop(0, "age"), Expr::Lit(n(-1.0))))
    .project(vec![("who".into(), prop(0, "name"))]);

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "rows changed");
    assert!(
        has_range_seek(&opt),
        "below the floor, seed as before: {opt:?}"
    );
}

fn has_index_seek(plan: &Plan) -> bool {
    match plan {
        Plan::IndexSeek { .. } => true,
        Plan::Project { input, .. }
        | Plan::Aggregate { input, .. }
        | Plan::Distinct { input }
        | Plan::Filter { input, .. }
        | Plan::OrderPage { input, .. }
        | Plan::Expand { input, .. } => has_index_seek(input),
        _ => false,
    }
}

/// A store above the floor: `name` is unique, `dept` takes 5 values (20% each).
fn indexed_departments(keys: &[&str]) -> Store {
    let depts = ["eng", "sales", "ops", "legal", "hr"];
    let mut b = Builder::default();
    for i in 0..8_000 {
        b.node(
            &["Person"],
            &[
                ("name", s(&format!("n{i}"))),
                ("dept", s(depts[i % depts.len()])),
                ("age", n(f64::from(i as u32 % 100))),
            ],
        );
    }
    let mut store = b.build();
    for k in keys {
        store.create_index(k);
    }
    store
}

fn eq_plan(key: &str, value: &str) -> Plan {
    Plan::Scan {
        label: Some("Person".into()),
    }
    .filter(cmp(CompareOp::Eq, prop(0, key), Expr::Lit(s(value))))
    .project(vec![("who".into(), prop(0, "name"))])
}

/// The equality twin of [`a_range_index_is_seeded_only_when_it_is_selective`]. It had
/// the same bug for longer and hid it better: `seek_beats_scan` read as a selectivity
/// test but, for `Eq`, `seed_fraction` answers `Some` for ANY bucket size (only the
/// range probe aborts early), so the check was really just "is there an index".
///
/// Measured (`simd_index_probe` E75, 200k `Person` rows): declaring a hash index on a
/// 5-value key made `dept = 'eng'` 2.7x SLOWER (194.7us -> 526.5us) and 2.9x under
/// GROUP BY. The seek materializes 40k scattered ids and binary-searches each against
/// the label bucket; the scan streams the column.
#[test]
fn an_unselective_equality_does_not_seed_its_index() {
    let store = indexed_departments(&["dept", "name"]);

    // 20% of the graph — the bucket costs more than the scan it replaces.
    let broad = eq_plan("dept", "eng");
    let before = bag(&run(&broad, &store));
    let opt = optimize_indexed(broad, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "broad: rows changed");
    assert!(
        !has_index_seek(&opt),
        "a 20% equality must not seed: {opt:?}"
    );

    // One row — the index is the whole point.
    let selective = eq_plan("name", "n4096");
    let before = bag(&run(&selective, &store));
    let opt = optimize_indexed(selective, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "selective: rows changed");
    assert!(
        has_index_seek(&opt),
        "a unique-key equality should seed: {opt:?}"
    );
}

/// With NO index the decision does not arise, and the seed is still taken: an
/// `IndexSeek` with nothing behind it degrades to a typed column scan inside
/// `index_seek_ids`, which is the CHEAPEST of the shapes available here — 194.7us
/// against 291.7us for the `Filter(Scan)` that declining would leave (E75). Declining
/// would also give one predicate two plans depending on whether an index happens to
/// exist on a key it cannot use.
#[test]
fn an_unindexed_equality_still_seeds_as_a_scan_fallback() {
    let store = indexed_departments(&[]);
    let plan = eq_plan("dept", "eng");
    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "rows changed");
    assert!(
        has_index_seek(&opt),
        "no index to consult, so seed as before: {opt:?}"
    );
}

/// The same gate applies to the conjunct picker, which is where the two spellings of
/// one predicate can part company: `WHERE dept = 'eng'` and `WHERE dept = 'eng' AND
/// age > 1` must agree about whether the index is worth seeding.
#[test]
fn an_unselective_equality_conjunct_does_not_seed_either() {
    let store = indexed_departments(&["dept"]);
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .filter(Expr::And(
        Box::new(cmp(CompareOp::Eq, prop(0, "dept"), Expr::Lit(s("eng")))),
        Box::new(cmp(CompareOp::Gt, prop(0, "age"), Expr::Lit(n(1.0)))),
    ))
    .project(vec![("who".into(), prop(0, "name"))]);

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "rows changed");
    assert!(
        !has_index_seek(&opt),
        "the 20% conjunct must not seed: {opt:?}"
    );
    // And it must not fall through to seeding the UNINDEXED range instead, which is
    // the worse of the two (651.0us against 374.4us as a plain filter, E75).
    assert!(
        !has_range_seek(&opt),
        "no range index, so no range seed: {opt:?}"
    );
}

/// A conjunction of RANGES with no range index behind them seeds nothing. The picker
/// used to have an "any range" rung below its indexed ones, which made
/// `RangeSeek` fall back to a scan that BOXES every cell — measured 3873.0us against
/// 3456.9us for the `Filter(Scan)` it replaced (E76). The single-comparison arm had
/// been gated on `has_range_index` for exactly this reason; the two disagreed.
#[test]
fn an_unindexed_range_conjunction_seeds_nothing() {
    let store = indexed_departments(&[]);
    let plan = Plan::Scan {
        label: Some("Person".into()),
    }
    .filter(Expr::And(
        Box::new(cmp(CompareOp::Ge, prop(0, "age"), Expr::Lit(n(28.0)))),
        Box::new(cmp(CompareOp::Le, prop(0, "age"), Expr::Lit(n(35.0)))),
    ))
    .project(vec![("who".into(), prop(0, "name"))]);

    let before = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);
    assert_eq!(before, bag(&run(&opt, &store)), "rows changed");
    assert!(!has_range_seek(&opt), "no range index, no seed: {opt:?}");
    assert!(!has_index_seek(&opt), "and no equality to seed: {opt:?}");
}

/// Within a rung the picker takes the MOST SELECTIVE conjunct, not the first written.
/// Going by position made conjunct ORDER change the plan: `age >= 30 AND age < 40`
/// seeded the 70% bound while `age < 40 AND age >= 30` seeded the 40% one, two
/// spellings of one range measured 1.55x apart (`spelling_probe`, "range AND"). The
/// Gremlin seed layer has ranked by selectivity since
/// `the_more_selective_of_two_filters_seeds`; this path still went by position.
#[test]
fn the_most_selective_indexed_conjunct_seeds_whatever_the_order() {
    let mut store = indexed_departments(&[]);
    store.create_range_index("age");

    // Both bounds are indexed and both are selective enough to seed; `>= 99` takes 1%
    // of the graph against `>= 90`'s 10%, so it must win from either position.
    let seeded_bound = |lo: f64, hi: f64| -> f64 {
        let plan = Plan::Scan {
            label: Some("Person".into()),
        }
        .filter(Expr::And(
            Box::new(cmp(CompareOp::Ge, prop(0, "age"), Expr::Lit(n(lo)))),
            Box::new(cmp(CompareOp::Ge, prop(0, "age"), Expr::Lit(n(hi)))),
        ))
        .project(vec![("who".into(), prop(0, "name"))]);
        let before = bag(&run(&plan, &store));
        let opt = optimize_indexed(plan, &store);
        assert_eq!(before, bag(&run(&opt, &store)), "rows changed");

        fn bound(p: &Plan) -> Option<f64> {
            match p {
                Plan::RangeSeek {
                    value: crate::value::Value::Num(x),
                    ..
                } => Some(*x),
                Plan::Project { input, .. } | Plan::Filter { input, .. } => bound(input),
                _ => None,
            }
        }
        bound(&opt).unwrap_or_else(|| panic!("expected a RangeSeek: {opt:?}"))
    };

    assert_eq!(
        seeded_bound(90.0, 99.0),
        99.0,
        "selective bound written last"
    );
    assert_eq!(
        seeded_bound(99.0, 90.0),
        99.0,
        "selective bound written first"
    );
}

/// A pattern whose selective predicate sits on a MIDDLE node cannot be helped by
/// reversing — whichever end you start from, the predicate is still in the interior. It is
/// helped by SPLITTING: seed the middle, walk backwards to the start, then forwards to the
/// end. Measured 678.8us to 218.8us on 100k nodes x 5 edges (E81).
///
/// This is the third slot-permutation rewrite on this page, and the previous two each
/// shipped a crossed-slot bug that a `count(*)` fixture could not see. So every case here
/// projects ALL the pattern's slots and compares the optimized rows against the raw plan's
/// as a multiset — a crossing changes the pairing, not the count.
#[cfg(test)]
fn split_fixture() -> Store {
    let mut b = Builder::default();
    // Two inbound and two outbound neighbours of the pivot, all distinguishable, so a
    // left/right crossing produces different PAIRS rather than a different row count.
    let pivot = b.node(&["N"], &[("name", s("pivot")), ("age", n(99.0))]);
    let in0 = b.node(&["N"], &[("name", s("in0")), ("age", n(1.0))]);
    let in1 = b.node(&["N"], &[("name", s("in1")), ("age", n(2.0))]);
    let out0 = b.node(&["N"], &[("name", s("out0")), ("age", n(3.0))]);
    let out1 = b.node(&["N"], &[("name", s("out1")), ("age", n(4.0))]);
    // A decoy pivot with the same shape but a non-matching age, so the seek must filter.
    let decoy = b.node(&["N"], &[("name", s("decoy")), ("age", n(5.0))]);
    // Padding, and NOT decoration: orientation fires only when the pivot predicate's share
    // of the graph is under `ORIENT_MAX_FRACTION` (15.4%). One matching node out of six is
    // 16.7%, so the six-node version of this fixture declined every rewrite under test —
    // including the plain far-end reversal, which is how the gate was identified rather
    // than the split being blamed.
    for i in 0..40u32 {
        b.node(&["N"], &[("name", s(&format!("pad{i}"))), ("age", n(0.0))]);
    }
    b.edge(in0, pivot, "R");
    b.edge(in1, pivot, "R");
    b.edge(pivot, out0, "R");
    b.edge(pivot, out1, "R");
    b.edge(in0, decoy, "R");
    b.edge(decoy, out0, "R");
    let mut store = b.build();
    store.create_range_index("age");
    store
}

/// `(a)-[:R]->(b)-[:R]->(c)` with the predicate on `b`, projecting all three.
#[cfg(test)]
fn split_plan() -> Plan {
    Plan::Scan {
        label: Some("N".into()),
    }
    .expand(0, Dir::Out, &["R".to_string()])
    .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(98.0))))
    .expand(1, Dir::Out, &["R".to_string()])
    // `(c:N)` in the surface syntax. Not incidental: `orient_scan` reaches a pattern
    // through a residual Filter, so a chain with NOTHING above its last hop is rooted at an
    // `Expand` and is not considered at all. See the note at `split_candidates`.
    .filter(Expr::IsLabeled {
        slot: 2,
        labels: vec!["N".into()],
    })
    .project(vec![
        ("a".into(), prop(0, "name")),
        ("b".into(), prop(1, "name")),
        ("c".into(), prop(2, "name")),
    ])
}

#[test]
fn a_middle_predicate_re_seeds_the_pattern_at_the_middle() {
    let store = split_fixture();
    let plan = split_plan();

    // The answer first, independent of any plan: in0/in1 -> pivot -> out0/out1.
    let raw = bag(&run(&plan, &store));
    assert_eq!(raw.len(), 4, "two inbound x two outbound: {raw:?}");

    let opt = optimize_indexed(plan, &store);
    assert_eq!(
        raw,
        bag(&run(&opt, &store)),
        "re-seeding at the middle changed the rows"
    );
    assert!(
        has_range_seek(&opt),
        "the middle predicate should have become the seed: {opt:?}"
    );
    // And the pairing specifically: `a` must be an inbound name and `c` an outbound one.
    for row in &run(&opt, &store).rows {
        let cell = |i: usize| format!("{:?}", row[i]);
        assert!(cell(0).contains("in"), "slot a held {}", cell(0));
        assert_eq!(cell(1), "Str(\"pivot\")", "slot b");
        assert!(cell(2).contains("out"), "slot c held {}", cell(2));
    }
}

/// The split must not disturb the case orientation already handles: a predicate on the FAR
/// end still reverses the whole chain and keeps it LINEAR, because a linear chain is what
/// the count and degree fast paths recognize. `split_candidates` returns the far end first
/// for exactly this reason.
#[test]
fn a_far_predicate_still_reverses_rather_than_splitting() {
    let store = split_fixture();
    let plan = Plan::Scan {
        label: Some("N".into()),
    }
    .expand(0, Dir::Out, &["R".to_string()])
    .expand(1, Dir::Out, &["R".to_string()])
    .filter(cmp(CompareOp::Gt, prop(2, "age"), Expr::Lit(n(98.0))))
    .project(vec![
        ("a".into(), prop(0, "name")),
        ("c".into(), prop(2, "name")),
    ]);
    let raw = bag(&run(&plan, &store));
    let opt = optimize_indexed(plan, &store);
    assert_eq!(raw, bag(&run(&opt, &store)), "rows changed");
    assert!(has_range_seek(&opt), "the far predicate seeds: {opt:?}");

    // Linear means every Expand reads the slot the one below it appended. A split would
    // give the seed two branches, so some `from` would repeat.
    fn froms(p: &Plan, out: &mut Vec<usize>) {
        match p {
            Plan::Expand { input, from, .. } => {
                froms(input, out);
                out.push(*from);
            }
            Plan::Project { input, .. } | Plan::Filter { input, .. } => froms(input, out),
            _ => {}
        }
    }
    let mut got = Vec::new();
    froms(&opt, &mut got);
    assert_eq!(
        got,
        vec![0, 1],
        "the reversed chain should stay linear: {opt:?}"
    );
}

/// A split at a middle slot of a THREE-hop chain: the seed has one hop to its left and two
/// to its right, so the right branch has to keep walking from the slot it just appended
/// rather than from the seed. Getting that wrong crosses `c` and `d`.
#[test]
fn a_split_walks_both_branches_of_a_three_hop_chain() {
    let mut b = Builder::default();
    let start = b.node(&["N"], &[("name", s("start")), ("age", n(1.0))]);
    let pivot = b.node(&["N"], &[("name", s("pivot")), ("age", n(99.0))]);
    let mid = b.node(&["N"], &[("name", s("mid")), ("age", n(2.0))]);
    let end = b.node(&["N"], &[("name", s("end")), ("age", n(3.0))]);
    // Same padding, same reason: one match in four nodes is 25% and would decline.
    for i in 0..40u32 {
        b.node(&["N"], &[("name", s(&format!("pad{i}"))), ("age", n(0.0))]);
    }
    b.edge(start, pivot, "R");
    b.edge(pivot, mid, "R");
    b.edge(mid, end, "R");
    let mut store = b.build();
    store.create_range_index("age");

    let plan = Plan::Scan {
        label: Some("N".into()),
    }
    .expand(0, Dir::Out, &["R".to_string()])
    .filter(cmp(CompareOp::Gt, prop(1, "age"), Expr::Lit(n(98.0))))
    .expand(1, Dir::Out, &["R".to_string()])
    .expand(2, Dir::Out, &["R".to_string()])
    .filter(Expr::IsLabeled {
        slot: 3,
        labels: vec!["N".into()],
    })
    .project(vec![
        ("a".into(), prop(0, "name")),
        ("b".into(), prop(1, "name")),
        ("c".into(), prop(2, "name")),
        ("d".into(), prop(3, "name")),
    ]);

    let raw = bag(&run(&plan, &store));
    assert_eq!(raw.len(), 1, "exactly one path: {raw:?}");
    let opt = optimize_indexed(plan, &store);
    assert_eq!(raw, bag(&run(&opt, &store)), "rows changed");
    assert!(has_range_seek(&opt), "should re-seed: {opt:?}");
    // Named explicitly, because a crossing of the two right-hand slots keeps the row COUNT.
    let row = &run(&opt, &store).rows[0];
    let cells: Vec<String> = row.iter().map(|v| format!("{v:?}")).collect();
    assert_eq!(
        cells,
        vec![
            "Str(\"start\")".to_string(),
            "Str(\"pivot\")".to_string(),
            "Str(\"mid\")".to_string(),
            "Str(\"end\")".to_string()
        ],
        "slots crossed"
    );
}
