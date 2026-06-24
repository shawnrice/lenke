//! Regression tests for Rust/TS behavioral divergences surfaced by the test
//! parity port. Each previously diverged from `@pl-graph/gremlin` and is now
//! aligned; these lock the TS-faithful behavior in place.

use super::{g, GVal, __, P};
use crate::graph::Graph;
use crate::ndjson;

fn modern() -> Graph {
    let lines = [
        r#"{"type":"node","id":"1","labels":["PERSON"],"properties":{"name":"marko","age":29}}"#,
        r#"{"type":"node","id":"2","labels":["PERSON"],"properties":{"name":"vadas","age":27}}"#,
        r#"{"type":"node","id":"4","labels":["PERSON"],"properties":{"name":"josh","age":32}}"#,
        r#"{"type":"node","id":"6","labels":["PERSON"],"properties":{"name":"peter","age":35}}"#,
        r#"{"type":"node","id":"3","labels":["SOFTWARE"],"properties":{"name":"lop","lang":"java"}}"#,
        r#"{"type":"node","id":"5","labels":["SOFTWARE"],"properties":{"name":"ripple","lang":"java"}}"#,
        r#"{"type":"edge","from":"1","to":"2","labels":["KNOWS"],"properties":{"weight":0.5}}"#,
        r#"{"type":"edge","from":"1","to":"4","labels":["KNOWS"],"properties":{"weight":1.0}}"#,
        r#"{"type":"edge","from":"1","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}"#,
        r#"{"type":"edge","from":"4","to":"5","labels":["CREATED"],"properties":{"weight":1.0}}"#,
        r#"{"type":"edge","from":"4","to":"3","labels":["CREATED"],"properties":{"weight":0.4}}"#,
        r#"{"type":"edge","from":"6","to":"3","labels":["CREATED"],"properties":{"weight":0.2}}"#,
    ];
    ndjson::decode(&lines.join("\n")).unwrap()
}

fn q(t: super::Traversal) -> Vec<GVal> {
    let mut g = modern();
    t.run(&mut g)
}

fn one_num(r: Vec<GVal>) -> f64 {
    match r.as_slice() {
        [GVal::Num(n)] => *n,
        _ => panic!("expected single number, got {r:?}"),
    }
}

/// Sorted string results (order-independent).
fn sorted_names(r: Vec<GVal>) -> Vec<String> {
    let mut v: Vec<String> = r
        .iter()
        .map(|g| match g {
            GVal::Str(s) => s.to_string(),
            other => format!("{other:?}"),
        })
        .collect();
    v.sort();
    v
}

// --- min/max skip nulls (TS: Comparable ignores null) -----------------------

#[test]
fn min_skips_nulls() {
    let r = g()
        .inject([GVal::Null, GVal::Num(10.0), GVal::Num(9.0), GVal::Null])
        .min();
    assert_eq!(one_num(q(r)), 9.0);
}

#[test]
fn max_skips_nulls() {
    let r = g()
        .inject([GVal::Null, GVal::Num(10.0), GVal::Num(9.0), GVal::Null])
        .max();
    assert_eq!(one_num(q(r)), 10.0);
}

#[test]
fn min_all_null_is_null() {
    let r = g().inject([GVal::Null, GVal::Null]).min();
    assert!(matches!(q(r).as_slice(), [GVal::Null]));
}

// --- sum/mean over all-null collapse to [null] ------------------------------

#[test]
fn sum_all_null_is_null() {
    let r = g().inject([GVal::Null, GVal::Null]).sum();
    assert!(matches!(q(r).as_slice(), [GVal::Null]));
}

#[test]
fn mean_all_null_is_null() {
    let r = g().inject([GVal::Null]).mean();
    assert!(matches!(q(r).as_slice(), [GVal::Null]));
}

// --- E() resolves external "e<n>" edge ids ----------------------------------

#[test]
fn e_external_id_resolves() {
    let r = g().e_ids(&["e0"]);
    assert_eq!(q(r).len(), 1);
}

// --- hasKey works on a property stream --------------------------------------

#[test]
fn has_key_on_property_stream() {
    // marko has name + age; hasKey("name") keeps just the name property.
    let r = g().v_ids(&["1"]).properties(&[]).has_key(&["name"]);
    assert_eq!(q(r).len(), 1);
}

// --- dedup().by(a).by(b) keys on the full tuple, not just the first by -------

#[test]
fn dedup_multi_by_keys_on_full_tuple() {
    // lop and ripple share lang=java but differ on name.
    let by_lang = g().v_ids(&["3", "5"]).dedup().by("lang");
    assert_eq!(q(by_lang).len(), 1);

    let by_lang_name = g().v_ids(&["3", "5"]).dedup().by("lang").by("name");
    assert_eq!(q(by_lang_name).len(), 2);
}

// --- value() is identity on a non-property traverser ------------------------

#[test]
fn value_identity_on_non_property() {
    let r = g().inject([GVal::Num(5.0)]).value();
    assert_eq!(one_num(q(r)), 5.0);
}

// --- property() drops non-element traversers (TS) ---------------------------

#[test]
fn property_drops_non_element() {
    let r = g().inject([GVal::Num(5.0)]).property("k", GVal::Num(1.0));
    assert!(q(r).is_empty());
}

// --- loops() counts from 1 in the first body pass (TinkerPop) ----------------

#[test]
fn repeat_until_loops_stops_after_first_pass() {
    // loops()==2 fires one body pass in: marko's neighbors, not their neighbors.
    let r = g()
        .v_ids(&["1"])
        .repeat(__().out(&[]))
        .until(__().loops().is(P::eq(2)))
        .values(&["name"]);
    assert_eq!(sorted_names(q(r)), vec!["josh", "lop", "vadas"]);
}

#[test]
fn repeat_emit_before_yields_every_level() {
    // Pre-form emit (emit().repeat(out()).times(2)) emits the start vertex and
    // every level's frontier, not just the initial + final frontier.
    let r = g()
        .v_ids(&["1"])
        .repeat(__().out(&[]))
        .times(2)
        .emit_before(__())
        .values(&["name"]);
    assert_eq!(
        sorted_names(q(r)),
        vec!["josh", "lop", "lop", "marko", "ripple", "vadas"]
    );
}

#[test]
fn repeat_emit_loops_predicate_offset() {
    // emit(loops().is(gt(1))) emits both body levels of a times(3) walk.
    let r = g()
        .v_ids(&["1"])
        .repeat(__().out(&[]))
        .times(3)
        .emit(__().loops().is(P::gt(1)))
        .values(&["name"]);
    assert_eq!(
        sorted_names(q(r)),
        vec!["josh", "lop", "lop", "ripple", "vadas"]
    );
}
