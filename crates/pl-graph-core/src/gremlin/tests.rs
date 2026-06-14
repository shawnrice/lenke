//! Gremlin executor tests over the canonical TinkerPop "Modern" graph, porting
//! the TS `@pl-graph/gremlin` suites (social / filters / aggregations / paths /
//! repeat / select-as / software-creators) plus the modulator / projection /
//! side-effect / mutation features. TS closures are expressed as sub-traversals.

use super::{g, GVal, Order, Pop, Token, P, __};
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

/// Run a read-only traversal against a fresh Modern graph.
fn q(t: super::Traversal) -> Vec<GVal> {
    let mut g = modern();
    t.run(&mut g)
}

fn s(g: &GVal) -> String {
    match g {
        GVal::Str(s) => s.to_string(),
        other => format!("{other:?}"),
    }
}

/// Sorted string results (order-independent traversals).
fn names(r: Vec<GVal>) -> Vec<String> {
    let mut v: Vec<String> = r.iter().map(s).collect();
    v.sort();
    v
}

/// String results in stream order (order-dependent traversals).
fn ordered(r: Vec<GVal>) -> Vec<String> {
    r.iter().map(s).collect()
}

fn one_num(r: Vec<GVal>) -> f64 {
    match r.as_slice() {
        [GVal::Num(n)] => *n,
        _ => panic!("expected single number, got {r:?}"),
    }
}

/// Sort a result map's entries by string key for deterministic assertions.
fn map_sorted(g: &GVal) -> Vec<(String, GVal)> {
    match g {
        GVal::Map(entries) => {
            let mut v: Vec<(String, GVal)> = entries.iter().map(|(k, val)| (s(k), val.clone())).collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            v
        }
        _ => panic!("expected map, got {g:?}"),
    }
}

fn list_names(g: &GVal) -> Vec<String> {
    match g {
        GVal::List(items) => names(items.clone()),
        _ => panic!("expected list, got {g:?}"),
    }
}

// ===== sources / movement =====

#[test]
fn v_all_and_count() {
    assert_eq!(one_num(q(g().V().count())), 6.0);
}

#[test]
fn v_by_id() {
    assert_eq!(names(q(g().v_ids(&["1"]).values(&["name"]))), vec!["marko"]);
}

#[test]
fn out_multi_label_order_matters() {
    assert_eq!(ordered(q(g().v_ids(&["1"]).out(&["CREATED", "KNOWS"]).values(&["name"]))), vec!["lop", "vadas", "josh"]);
}

#[test]
fn out_all_neighbors_of_marko() {
    assert_eq!(names(q(g().v_ids(&["1"]).out(&[]).values(&["name"]))), vec!["josh", "lop", "vadas"]);
}

#[test]
fn oute_inv_equals_out() {
    let a = names(q(g().v_ids(&["1"]).out(&["KNOWS"]).values(&["name"])));
    let b = names(q(g().v_ids(&["1"]).out_e(&["KNOWS"]).in_v().values(&["name"])));
    assert_eq!(a, b);
    assert_eq!(a, vec!["josh", "vadas"]);
}

#[test]
fn in_created_creators_of_lop() {
    assert_eq!(names(q(g().V().has("name", P::eq("lop")).in_(&["CREATED"]).values(&["name"]))), vec!["josh", "marko", "peter"]);
}

#[test]
fn both_neighborhood() {
    assert_eq!(names(q(g().v_ids(&["1"]).both(&[]).dedup().values(&["name"]))), vec!["josh", "lop", "vadas"]);
}

#[test]
fn edge_source_and_count() {
    assert_eq!(one_num(q(g().E().count())), 6.0);
}

#[test]
fn other_v_from_marko_edges() {
    // marko's incident edges, otherV back from marko ⇒ the far endpoints.
    assert_eq!(names(q(g().v_ids(&["1"]).both_e(&[]).other_v().values(&["name"]))), vec!["josh", "lop", "vadas"]);
}

// ===== filters / predicates =====

#[test]
fn has_age_gt_30() {
    assert_eq!(names(q(g().V().has("age", P::gt(30)).values(&["name"]))), vec!["josh", "peter"]);
}

#[test]
fn between_inside_outside() {
    assert_eq!(names(q(g().V().has("age", P::between(28, 33)).values(&["name"]))), vec!["josh", "marko"]);
    assert_eq!(names(q(g().V().has("age", P::inside(27, 32)).values(&["name"]))), vec!["marko"]);
    assert_eq!(names(q(g().V().has("age", P::outside(28, 33)).values(&["name"]))), vec!["peter", "vadas"]);
}

#[test]
fn within_without() {
    assert_eq!(names(q(g().V().has("name", P::within(["josh", "marko"])).values(&["name"]))), vec!["josh", "marko"]);
    assert_eq!(names(q(g().V().has_label(&["PERSON"]).has("name", P::without(["josh", "marko"])).values(&["name"]))), vec!["peter", "vadas"]);
}

#[test]
fn text_predicates() {
    assert_eq!(names(q(g().V().has("name", P::starts_with("ma")).values(&["name"]))), vec!["marko"]);
    assert_eq!(names(q(g().V().has("name", P::containing("o")).values(&["name"]))), vec!["josh", "lop", "marko"]);
}

#[test]
fn has_id_and_has_not() {
    assert_eq!(names(q(g().V().has_id(&["1"]).values(&["name"]))), vec!["marko"]);
    // hasNot('age') keeps software (no age property).
    assert_eq!(names(q(g().V().has_not(&["age"]).values(&["name"]))), vec!["lop", "ripple"]);
}

#[test]
fn has_key_keeps_elements_with_property() {
    assert_eq!(names(q(g().V().has_key(&["lang"]).values(&["name"]))), vec!["lop", "ripple"]);
}

#[test]
fn software_has_no_age() {
    assert_eq!(q(g().V().has_label(&["SOFTWARE"]).values(&["age"])).len(), 0);
}

// ===== combinators (closures → sub-traversals) =====

#[test]
fn and_knows_out_and_young() {
    let r = g().V().and(vec![__().out_e(&["KNOWS"]), __().values(&["age"]).is(P::lt(30))]).values(&["name"]);
    assert_eq!(names(q(r)), vec!["marko"]);
}

#[test]
fn or_created_out_or_many_creators() {
    let r = g().V().or(vec![__().out_e(&["CREATED"]), __().in_(&["CREATED"]).count().is(P::gt(1))]).values(&["name"]);
    assert_eq!(names(q(r)), vec!["josh", "lop", "marko", "peter"]);
}

#[test]
fn not_created_more_than_one() {
    let r = g().V().has_label(&["PERSON"]).not(__().out(&["CREATED"]).count().is(P::gt(1))).values(&["name"]);
    assert_eq!(names(q(r)), vec!["marko", "peter", "vadas"]);
}

#[test]
fn chained_where_no_created_has_knows_in() {
    let r = g().V().where_(__().not(__().out(&["CREATED"]))).where_(__().in_(&["KNOWS"])).values(&["name"]);
    assert_eq!(names(q(r)), vec!["vadas"]);
}

#[test]
fn where_count_is_gte_2() {
    let r = g().V().where_(__().in_(&["CREATED"]).count().is(P::gte(2))).values(&["name"]);
    assert_eq!(names(q(r)), vec!["lop"]);
}

#[test]
fn marko_friends_who_created() {
    let r = g().V().has("name", P::eq("marko")).out(&["KNOWS"]).where_(__().out(&["CREATED"])).values(&["name"]);
    assert_eq!(names(q(r)), vec!["josh"]);
}

#[test]
fn coalesce_first_nonempty() {
    // coalesce(out CREATED names, constant 'none') per person.
    let r = g()
        .V()
        .has_label(&["PERSON"])
        .coalesce(vec![__().out(&["CREATED"]).values(&["name"]), __().constant("none")]);
    // marko→lop, josh→{lop,ripple}, peter→lop, vadas→none
    assert_eq!(names(q(r)), vec!["lop", "lop", "lop", "none", "ripple"]);
}

#[test]
fn optional_falls_back_to_input() {
    let r = g().V().has("name", P::eq("vadas")).optional(__().out(&["CREATED"]));
    // vadas creates nothing ⇒ optional yields vadas itself.
    assert_eq!(names(q(r.values(&["name"]))), vec!["vadas"]);
}

#[test]
fn choose_branches_on_label() {
    let r = g().V().choose_else(__().has_label(&["PERSON"]), __().values(&["name"]), __().constant("sw"));
    assert_eq!(names(q(r)), vec!["josh", "marko", "peter", "sw", "sw", "vadas"]);
}

#[test]
fn union_name_and_age() {
    let r = g().V().has("name", P::eq("marko")).union(vec![__().values(&["name"]), __().values(&["age"])]);
    let out = q(r);
    assert_eq!(out, vec![GVal::Str("marko".into()), GVal::Num(29.0)]);
}

#[test]
fn local_out_count_per_person() {
    // local(out().count()) counts each person's out-degree per traverser.
    let r = g().V().has("name", P::eq("marko")).local(__().out(&[]).count());
    assert_eq!(one_num(q(r)), 3.0);
}

// ===== aggregates / by modulators =====

#[test]
fn group_count_by_label() {
    let out = q(g().V().group_count().by_label());
    let m = map_sorted(&out[0]);
    assert_eq!(m, vec![("PERSON".into(), GVal::Num(4.0)), ("SOFTWARE".into(), GVal::Num(2.0))]);
}

#[test]
fn group_names_by_label() {
    let out = q(g().V().group().by_label().by("name"));
    let m = map_sorted(&out[0]);
    assert_eq!(m[0].0, "PERSON");
    assert_eq!(list_names(&m[0].1), vec!["josh", "marko", "peter", "vadas"]);
    assert_eq!(m[1].0, "SOFTWARE");
    assert_eq!(list_names(&m[1].1), vec!["lop", "ripple"]);
}

#[test]
fn group_count_by_age_value() {
    let out = q(g().V().has_label(&["PERSON"]).values(&["age"]).group_count());
    let m = map_sorted(&out[0]);
    assert_eq!(m.len(), 4);
    assert!(m.iter().all(|(_, n)| *n == GVal::Num(1.0)));
}

#[test]
fn group_software_by_lang() {
    let out = q(g().V().has_label(&["SOFTWARE"]).group().by("lang").by("name"));
    let m = map_sorted(&out[0]);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].0, "java");
    assert_eq!(list_names(&m[0].1), vec!["lop", "ripple"]);
}

#[test]
fn group_count_edges_by_label() {
    let out = q(g().V().out_e(&[]).group_count().by_label());
    let m = map_sorted(&out[0]);
    assert_eq!(m, vec![("CREATED".into(), GVal::Num(4.0)), ("KNOWS".into(), GVal::Num(2.0))]);
}

#[test]
fn order_by_age_desc() {
    let r = g().V().has_label(&["PERSON"]).order_by("age", Order::Desc).values(&["name"]);
    assert_eq!(ordered(q(r)), vec!["peter", "josh", "marko", "vadas"]);
}

#[test]
fn order_by_name_asc() {
    let r = g().V().has_label(&["PERSON"]).order().by("name").values(&["name"]);
    assert_eq!(ordered(q(r)), vec!["josh", "marko", "peter", "vadas"]);
}

#[test]
fn sum_mean_max_min_of_age() {
    assert_eq!(one_num(q(g().V().has_label(&["PERSON"]).values(&["age"]).sum())), 123.0);
    assert_eq!(one_num(q(g().V().has_label(&["PERSON"]).values(&["age"]).mean())), 30.75);
    assert_eq!(one_num(q(g().V().has_label(&["PERSON"]).values(&["age"]).max())), 35.0);
    assert_eq!(one_num(q(g().V().has_label(&["PERSON"]).values(&["age"]).min())), 27.0);
}

#[test]
fn fold_then_local_count() {
    // fold to one list, then local count of its length.
    let r = g().V().has_label(&["PERSON"]).values(&["name"]).fold().count_local();
    assert_eq!(one_num(q(r)), 4.0);
}

// ===== project =====

#[test]
fn project_name_and_created_count() {
    let r = g().V().has_label(&["PERSON"]).project(&["name", "created"]).by("name").by_t(__().out_e(&["CREATED"]).count());
    let out = q(r);
    // Per person, a map {name, created}.
    let mut got: Vec<(String, f64)> = out
        .iter()
        .map(|g| {
            let m = match g {
                GVal::Map(e) => e,
                _ => panic!(),
            };
            let name = s(&m[0].1);
            let created = match m[1].1 {
                GVal::Num(n) => n,
                _ => panic!(),
            };
            (name, created)
        })
        .collect();
    got.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(got, vec![("josh".into(), 2.0), ("marko".into(), 1.0), ("peter".into(), 1.0), ("vadas".into(), 0.0)]);
}

#[test]
fn project_marko_degrees() {
    let r = g().V().has("name", P::eq("marko")).project(&["id", "out", "in"]).by_id().by_t(__().out_e(&[]).count()).by_t(__().in_e(&[]).count());
    let out = q(r);
    let m = match &out[0] {
        GVal::Map(e) => e,
        _ => panic!(),
    };
    assert_eq!(s(&m[0].1), "1");
    assert_eq!(m[1].1, GVal::Num(3.0)); // out-degree
    assert_eq!(m[2].1, GVal::Num(0.0)); // in-degree
}

// ===== select / as =====

#[test]
fn select_three_labels() {
    let r = g().V().as_("a").out(&[]).as_("b").out(&[]).as_("c").select(&["a", "b", "c"]).by_id().by_id().by_id();
    let out = q(r);
    // marko→josh→{ripple,lop}; map of ids.
    let maps: Vec<Vec<(String, String)>> = out
        .iter()
        .map(|g| match g {
            GVal::Map(e) => e.iter().map(|(k, v)| (s(k), s(v))).collect(),
            _ => panic!(),
        })
        .collect();
    assert_eq!(maps.len(), 2);
    assert!(maps.iter().all(|m| m[0] == ("a".to_string(), "1".to_string()) && m[1] == ("b".to_string(), "4".to_string())));
}

#[test]
fn select_single_label_unwraps() {
    let r = g().V().has("name", P::eq("marko")).as_("a").out(&["KNOWS"]).select(&["a"]).values(&["name"]);
    // 'a' recalls marko for each of the two friends ⇒ ['marko','marko'].
    assert_eq!(names(q(r)), vec!["marko", "marko"]);
}

#[test]
fn select_by_name() {
    let r = g().V().has("name", P::eq("marko")).as_("a").out(&["CREATED"]).as_("b").select(&["a", "b"]).by("name").by("name");
    let out = q(r);
    let m = match &out[0] {
        GVal::Map(e) => e,
        _ => panic!(),
    };
    assert_eq!(s(&m[0].1), "marko");
    assert_eq!(s(&m[1].1), "lop");
}

#[test]
fn where_key_compares_tags() {
    // Pairs (a, b) where both are persons and b is older than a, via tag compare.
    let r = g()
        .V()
        .has("name", P::eq("marko"))
        .as_("a")
        .out(&["KNOWS"])
        .as_("b")
        .where_key("a", P::lt(GVal::Str("b".into())))
        .by("age")
        .by("age")
        .select(&["b"])
        .values(&["name"]);
    // a=marko(29); b in {vadas(27), josh(32)}; keep where a.age < b.age ⇒ josh.
    assert_eq!(names(q(r)), vec!["josh"]);
}

// ===== paths =====

#[test]
fn path_by_name_two_hops() {
    let r = g().V().out(&[]).out(&[]).path().by("name");
    let out = q(r);
    let mut paths: Vec<Vec<String>> = out.iter().map(list_names_ordered).collect();
    paths.sort();
    assert_eq!(paths, vec![vec!["marko", "josh", "lop"], vec!["marko", "josh", "ripple"]]);
}

#[test]
fn simple_path_excludes_cycle() {
    let r = g().V().has("name", P::eq("marko")).out(&["CREATED"]).in_(&["CREATED"]).simple_path().values(&["name"]);
    assert_eq!(names(q(r)), vec!["josh", "peter"]);
}

#[test]
fn cyclic_path_retains_cycle() {
    let r = g().V().has("name", P::eq("marko")).out(&["CREATED"]).in_(&["CREATED"]).cyclic_path().values(&["name"]);
    assert_eq!(names(q(r)), vec!["marko"]);
}

#[test]
fn tree_from_marko() {
    let out = q(g().v_ids(&["1"]).out(&["KNOWS"]).tree());
    // root → marko → {vadas, josh} → {}
    let m = map_sorted(&out[0]);
    assert_eq!(m.len(), 1); // single root: marko (id 1)
    let marko_children = map_sorted(&m[0].1);
    assert_eq!(marko_children.len(), 2);
}

// ===== repeat =====

#[test]
fn repeat_times_two() {
    let r = g().v_ids(&["1"]).repeat(__().out(&[])).times(2).values(&["name"]);
    assert_eq!(names(q(r)), vec!["lop", "ripple"]);
}

#[test]
fn repeat_until_software() {
    let r = g().v_ids(&["1"]).repeat(__().out(&[])).until(__().has_label(&["SOFTWARE"])).values(&["name"]);
    assert_eq!(names(q(r)), vec!["lop", "lop", "ripple"]);
}

#[test]
fn repeat_times_emit() {
    let r = g().v_ids(&["1"]).repeat(__().out(&[])).times(2).emit_all().values(&["name"]);
    assert_eq!(names(q(r)), vec!["josh", "lop", "lop", "ripple", "vadas"]);
}

#[test]
fn repeat_emit_filtered() {
    let r = g().v_ids(&["1"]).repeat(__().out(&[])).times(2).emit(__().has("lang", P::eq("java"))).values(&["name"]);
    assert_eq!(names(q(r)), vec!["lop", "lop", "ripple"]);
}

#[test]
fn repeat_times_one_equals_out() {
    let r = g().v_ids(&["1"]).repeat(__().out(&[])).times(1).values(&["name"]);
    assert_eq!(names(q(r)), vec!["josh", "lop", "vadas"]);
}

// ===== cardinality / scope =====

#[test]
fn limit_and_range() {
    assert_eq!(q(g().V().limit(2)).len(), 2);
    assert_eq!(q(g().V().range(1, 3)).len(), 2);
    assert_eq!(q(g().V().tail(2)).len(), 2);
}

#[test]
fn local_range_on_fold() {
    // fold all names then take first 2 locally.
    let r = g().V().has_label(&["PERSON"]).order().by("name").values(&["name"]).fold().range_local(0, 2);
    let out = q(r);
    assert_eq!(list_names_ordered(&out[0]), vec!["josh", "marko"]);
}

// ===== misc / projection =====

#[test]
fn value_map_of_marko() {
    let out = q(g().V().has("name", P::eq("marko")).value_map(&["name", "age"]));
    let m = match &out[0] {
        GVal::Map(e) => e,
        _ => panic!(),
    };
    assert!(m.contains(&(GVal::Str("name".into()), GVal::Str("marko".into()))));
    assert!(m.contains(&(GVal::Str("age".into()), GVal::Num(29.0))));
}

#[test]
fn element_map_of_marko_includes_id_label() {
    let out = q(g().V().has("name", P::eq("marko")).element_map(&["name"]));
    let m = map_sorted(&out[0]);
    assert!(m.iter().any(|(k, v)| k == "id" && s(v) == "1"));
    assert!(m.iter().any(|(k, v)| k == "label" && s(v) == "PERSON"));
    assert!(m.iter().any(|(k, v)| k == "name" && s(v) == "marko"));
}

#[test]
fn id_and_label_steps() {
    assert_eq!(names(q(g().v_ids(&["1"]).id())), vec!["1"]);
    assert_eq!(names(q(g().v_ids(&["1"]).label())), vec!["PERSON"]);
}

#[test]
fn unfold_a_folded_list() {
    let r = g().V().has_label(&["SOFTWARE"]).values(&["name"]).fold().unfold();
    assert_eq!(names(q(r)), vec!["lop", "ripple"]);
}

#[test]
fn constant_and_inject() {
    assert_eq!(names(q(g().V().has("name", P::eq("marko")).constant("hi"))), vec!["hi"]);
    let r = g().inject([1, 2, 3]);
    assert_eq!(q(r), vec![GVal::Num(1.0), GVal::Num(2.0), GVal::Num(3.0)]);
}

// ===== side effects =====

#[test]
fn aggregate_then_cap() {
    let r = g().V().has_label(&["PERSON"]).values(&["name"]).aggregate("names").cap("names");
    let out = q(r);
    assert_eq!(list_names(&out[0]), vec!["josh", "marko", "peter", "vadas"]);
}

// ===== edge properties =====

#[test]
fn strong_knows_edges() {
    let r = g().V().out_e(&["KNOWS"]).has("weight", P::gt(0.75)).in_v().values(&["name"]);
    assert_eq!(names(q(r)), vec!["josh"]);
}

#[test]
fn marko_created_edge_weight() {
    assert_eq!(q(g().v_ids(&["1"]).out_e(&["CREATED"]).values(&["weight"])), vec![GVal::Num(0.4)]);
}

// ===== mutation =====

#[test]
fn add_vertex_and_property() {
    let mut g0 = modern();
    let r = g().add_v(Some("PERSON")).property("name", "newbie").property("age", 40).values(&["name"]).run(&mut g0);
    assert_eq!(names(r), vec!["newbie"]);
    // The new vertex is queryable.
    assert_eq!(one_num(g().V().has("name", P::eq("newbie")).count().run(&mut g0)), 1.0);
}

#[test]
fn add_edge_between_tagged() {
    let mut g0 = modern();
    // marko --LIKES--> ripple
    let _ = g()
        .V()
        .has("name", P::eq("marko"))
        .as_("a")
        .V()
        .has("name", P::eq("ripple"))
        .add_e("LIKES")
        .from_tag("a")
        .run(&mut g0);
    let r = g().V().has("name", P::eq("marko")).out(&["LIKES"]).values(&["name"]).run(&mut g0);
    assert_eq!(names(r), vec!["ripple"]);
}

#[test]
fn drop_removes_vertex() {
    let mut g0 = modern();
    let _ = g().V().has("name", P::eq("vadas")).drop().run(&mut g0);
    assert_eq!(one_num(g().V().count().run(&mut g0)), 5.0);
}

#[test]
fn group_count_by_token_label() {
    // by_token(Token::Label) is equivalent to by_label().
    let out = q(g().V().group_count().by_token(Token::Label));
    let m = map_sorted(&out[0]);
    assert_eq!(m, vec![("PERSON".into(), GVal::Num(4.0)), ("SOFTWARE".into(), GVal::Num(2.0))]);
}

#[test]
fn select_pop_first_vs_last() {
    // Tag 'a' twice (marko, then the friend); first/last pick different ends.
    let first = g().v_ids(&["1"]).as_("a").out(&["KNOWS"]).as_("a").select_pop(Pop::First, &["a"]).values(&["name"]);
    assert_eq!(names(q(first)), vec!["marko", "marko"]);
    let last = g().v_ids(&["1"]).as_("a").out(&["KNOWS"]).as_("a").select_pop(Pop::Last, &["a"]).values(&["name"]);
    assert_eq!(names(q(last)), vec!["josh", "vadas"]);
}

// helper used above
fn list_names_ordered(g: &GVal) -> Vec<String> {
    match g {
        GVal::List(items) => items.iter().map(s).collect(),
        _ => panic!("expected list, got {g:?}"),
    }
}
