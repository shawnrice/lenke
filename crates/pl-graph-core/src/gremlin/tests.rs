//! Gremlin executor tests over the canonical TinkerPop "Modern" graph, mirroring
//! the TS `@pl-graph/gremlin` integration suite (social / filters / aggregations
//! / paths / select-as).

use super::{g, GVal, Order, P};
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
    ndjson::decode(&lines.join("\n"))
}

/// Extract string results, sorted (most traversals are order-independent).
fn names(r: Vec<GVal>) -> Vec<String> {
    let mut v: Vec<String> = r
        .into_iter()
        .map(|g| match g {
            GVal::Str(s) => s.to_string(),
            other => format!("{other:?}"),
        })
        .collect();
    v.sort();
    v
}

/// Extract string results in stream order (for ORDER BY etc.).
fn names_ordered(r: Vec<GVal>) -> Vec<String> {
    r.into_iter()
        .map(|g| match g {
            GVal::Str(s) => s.to_string(),
            other => format!("{other:?}"),
        })
        .collect()
}

fn one_num(r: Vec<GVal>) -> f64 {
    match r.as_slice() {
        [GVal::Num(n)] => *n,
        _ => panic!("expected single number, got {r:?}"),
    }
}

#[test]
fn markos_direct_friends() {
    let gr = modern();
    let r = g().V().has("name", P::eq("marko")).out(&["KNOWS"]).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["josh", "vadas"]);
}

#[test]
fn markos_friends_older_than_29() {
    let gr = modern();
    let r = g().V().has("name", P::eq("marko")).out(&["KNOWS"]).has("age", P::gt(29)).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["josh"]);
}

#[test]
fn friends_of_friends_deduped() {
    let gr = modern();
    // marko → vadas, josh → (vadas knows nobody; josh knows nobody) ⇒ josh creates lop/ripple
    // out KNOWS twice from marko: marko→josh→(josh has no KNOWS out) ; marko→vadas→none ⇒ empty.
    let r = g().V().has("name", P::eq("marko")).out(&["KNOWS"]).out(&["KNOWS"]).dedup().values(&["name"]).run(&gr);
    assert_eq!(names(r), Vec::<String>::new());
}

#[test]
fn who_created_lop() {
    let gr = modern();
    let r = g().V().has("name", P::eq("lop")).in_(&["CREATED"]).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["josh", "marko", "peter"]);
}

#[test]
fn count_persons() {
    let gr = modern();
    let r = g().V().has_label(&["PERSON"]).count().run(&gr);
    assert_eq!(one_num(r), 4.0);
}

#[test]
fn software_names() {
    let gr = modern();
    let r = g().V().has_label(&["SOFTWARE"]).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["lop", "ripple"]);
}

#[test]
fn has_id_lookup() {
    let gr = modern();
    let r = g().V().has_id(&["1"]).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["marko"]);
}

#[test]
fn within_predicate() {
    let gr = modern();
    let r = g().V().has("name", P::within(["marko", "josh"])).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["josh", "marko"]);
}

#[test]
fn between_predicate_on_age() {
    let gr = modern();
    // between is [min, max): 29 and 32 in [28,33) ; 35 excluded, 27 excluded.
    let r = g().V().has("age", P::between(28, 33)).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["josh", "marko"]);
}

#[test]
fn order_by_age_desc() {
    let gr = modern();
    let r = g().V().has_label(&["PERSON"]).order_by("age", Order::Desc).values(&["name"]).run(&gr);
    assert_eq!(names_ordered(r), vec!["peter", "josh", "marko", "vadas"]);
}

#[test]
fn out_edges_then_in_v() {
    let gr = modern();
    let r = g().V().has("name", P::eq("marko")).out_e(&["KNOWS"]).in_v().values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["josh", "vadas"]);
}

#[test]
fn values_age_sum_and_mean() {
    let gr = modern();
    let sum = g().V().has_label(&["PERSON"]).values(&["age"]).sum().run(&gr);
    assert_eq!(one_num(sum), 29.0 + 27.0 + 32.0 + 35.0);
    let mean = g().V().has_label(&["PERSON"]).values(&["age"]).mean().run(&gr);
    assert_eq!(one_num(mean), (29.0 + 27.0 + 32.0 + 35.0) / 4.0);
    let max = g().V().has_label(&["PERSON"]).values(&["age"]).max().run(&gr);
    assert_eq!(one_num(max), 35.0);
}

#[test]
fn group_count_by_label() {
    let gr = modern();
    let r = g().V().group_count(Some("name")).run(&gr);
    // One map with each name → 1 (all distinct names).
    match r.as_slice() {
        [GVal::Map(entries)] => assert_eq!(entries.len(), 6),
        _ => panic!("expected one map, got {r:?}"),
    }
}

#[test]
fn where_created_something() {
    let gr = modern();
    // Persons who created at least one piece of software.
    let r = g().V().has_label(&["PERSON"]).where_(super::__().out(&["CREATED"])).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["josh", "marko", "peter"]);
}

#[test]
fn not_created_anything() {
    let gr = modern();
    let r = g().V().has_label(&["PERSON"]).not(super::__().out(&["CREATED"])).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["vadas"]);
}

#[test]
fn repeat_times_two_hops() {
    let gr = modern();
    // marko -out-> {vadas, josh, lop} -out-> {ripple, lop} (from josh) ⇒ names of 2-hop targets.
    let r = g().V().has("name", P::eq("marko")).repeat(super::__().out(&[])).times(2).values(&["name"]).run(&gr);
    assert_eq!(names(r), vec!["lop", "ripple"]);
}

#[test]
fn union_name_and_age() {
    let gr = modern();
    let r = g()
        .V()
        .has("name", P::eq("marko"))
        .union(vec![super::__().values(&["name"]), super::__().values(&["age"])])
        .run(&gr);
    // marko's name + age, order: name then age.
    assert_eq!(r.len(), 2);
    assert_eq!(r[0], GVal::Str("marko".into()));
    assert_eq!(r[1], GVal::Num(29.0));
}

#[test]
fn select_as_labels() {
    let gr = modern();
    // Pair each person with software they created: select a (person) and b (sw).
    let r = g()
        .V()
        .has("name", P::eq("josh"))
        .as_("a")
        .out(&["CREATED"])
        .as_("b")
        .select(&["a", "b"])
        .run(&gr);
    // Two creations (ripple, lop): each a Map{a: josh-vertex, b: sw-vertex}.
    assert_eq!(r.len(), 2);
    assert!(matches!(r[0], GVal::Map(_)));
}

#[test]
fn path_of_two_hops() {
    let gr = modern();
    let r = g().V().has("name", P::eq("marko")).out(&["KNOWS"]).path().run(&gr);
    // Each path: [marko-vertex, friend-vertex] ⇒ length 2.
    assert_eq!(r.len(), 2);
    for p in &r {
        match p {
            GVal::List(items) => assert_eq!(items.len(), 2),
            _ => panic!("expected path list"),
        }
    }
}

#[test]
fn simple_path_excludes_cycles() {
    let gr = modern();
    // both() can revisit marko (marko-knows-josh-knows... no; use created back-and-forth):
    // marko-created-lop-created<-... in() back to creators includes marko ⇒ simplePath drops marko.
    let r = g()
        .V()
        .has("name", P::eq("marko"))
        .out(&["CREATED"])
        .in_(&["CREATED"])
        .simple_path()
        .values(&["name"])
        .run(&gr);
    // lop's creators: marko, josh, peter — but simplePath drops the marko→lop→marko cycle.
    assert_eq!(names(r), vec!["josh", "peter"]);
}

#[test]
fn value_map_of_marko() {
    let gr = modern();
    let r = g().V().has("name", P::eq("marko")).value_map(&["name", "age"]).run(&gr);
    match r.as_slice() {
        [GVal::Map(entries)] => {
            assert!(entries.contains(&(GVal::Str("name".into()), GVal::Str("marko".into()))));
            assert!(entries.contains(&(GVal::Str("age".into()), GVal::Num(29.0))));
        }
        _ => panic!("expected one map, got {r:?}"),
    }
}

#[test]
fn dedup_creators() {
    let gr = modern();
    // Everyone who created software, deduped by name.
    let r = g().V().has_label(&["SOFTWARE"]).in_(&["CREATED"]).dedup().count().run(&gr);
    assert_eq!(one_num(r), 3.0); // marko, josh, peter
}
