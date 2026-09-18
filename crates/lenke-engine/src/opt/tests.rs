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
        (label.clone(), key.clone(), value.clone())
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
fn unlabelled_scan_not_seeded() {
    let store = social();
    let unlabelled = Plan::Scan { label: None }
        .filter(cmp(CompareOp::Eq, prop(0, "name"), Expr::Lit(s("alice"))))
        .project(vec![("name".into(), prop(0, "name"))]);
    assert!(plan_contains_filter(&assert_rows_preserved(
        &unlabelled,
        &store
    )));
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
    // Unlabelled scan so seeding (which needs a label) does not fire — this
    // isolates the merge rule. social() is all-Person, so the rows match.
    let plan = Plan::Scan { label: None }
        .filter(cmp(CompareOp::Ge, prop(0, "age"), Expr::Lit(n(28.0))))
        .filter(cmp(CompareOp::Le, prop(0, "age"), Expr::Lit(n(35.0))));
    let opt = assert_rows_preserved(&plan, &store);
    // And the answer: only alice(30) is in [28,35].
    assert_eq!(run(&opt, &store).rows.len(), 1);
    // Shape: one Filter (an And) over the Scan.
    match &opt {
        Plan::Filter { input, pred } => {
            assert!(matches!(pred, Expr::And(..)), "merged into an AND");
            assert!(
                matches!(**input, Plan::Scan { .. }),
                "single filter over scan"
            );
        }
        other => panic!("expected a single Filter, got {other:?}"),
    }
}

#[test]
fn driver_reaches_fixpoint_merge_then_pushdown() {
    let store = social();
    // Two filters (slot 0) above an Expand: the driver must MERGE them and
    // then PUSH the merged filter below the Expand — two rules, to a fixpoint.
    // Unlabelled scan so seeding does not fire, isolating merge + pushdown.
    let plan = Plan::Scan { label: None }
        .expand(0, Dir::Out, &["KNOWS".to_string()])
        .filter(cmp(CompareOp::Le, prop(0, "age"), Expr::Lit(n(100.0))))
        .filter(cmp(CompareOp::Ge, prop(0, "age"), Expr::Lit(n(0.0))));
    let opt = assert_rows_preserved(&plan, &store);
    match opt {
        Plan::Expand { input, .. } => match *input {
            Plan::Filter { input, pred } => {
                assert!(matches!(pred, Expr::And(..)), "the two filters merged");
                assert!(matches!(*input, Plan::Scan { .. }));
            }
            other => panic!("expected merged Filter below Expand, got {other:?}"),
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
