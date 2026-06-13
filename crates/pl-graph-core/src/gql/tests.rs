//! Conformance tests for the GQL engine, mirroring the TS `gql.test.ts` /
//! `tck.test.ts` spec over the TinkerPop "Modern" fixture. Covers the read
//! surface, edge properties, and write clauses (the graph is mutable).

use super::eval::Params;
use super::parse;
use crate::graph::{Graph, Value};
use crate::ndjson;

/// Build the Modern graph (4 Person, 2 Software; KNOWS + CREATED edges) with the
/// TinkerPop edge `weight` properties — exercising edge properties, which now
/// share the same columnar store as vertex properties.
fn modern() -> Graph {
    let lines = [
        r#"{"type":"node","id":"marko","labels":["Person"],"properties":{"name":"marko","age":29}}"#,
        r#"{"type":"node","id":"vadas","labels":["Person"],"properties":{"name":"vadas","age":27}}"#,
        r#"{"type":"node","id":"josh","labels":["Person"],"properties":{"name":"josh","age":32}}"#,
        r#"{"type":"node","id":"peter","labels":["Person"],"properties":{"name":"peter","age":35}}"#,
        r#"{"type":"node","id":"lop","labels":["Software"],"properties":{"name":"lop","lang":"java"}}"#,
        r#"{"type":"node","id":"ripple","labels":["Software"],"properties":{"name":"ripple","lang":"java"}}"#,
        r#"{"type":"edge","from":"marko","to":"vadas","labels":["KNOWS"],"properties":{"weight":0.5}}"#,
        r#"{"type":"edge","from":"marko","to":"josh","labels":["KNOWS"],"properties":{"weight":1.0}}"#,
        r#"{"type":"edge","from":"marko","to":"lop","labels":["CREATED"],"properties":{"weight":0.4}}"#,
        r#"{"type":"edge","from":"josh","to":"ripple","labels":["CREATED"],"properties":{"weight":1.0}}"#,
        r#"{"type":"edge","from":"josh","to":"lop","labels":["CREATED"],"properties":{"weight":0.4}}"#,
        r#"{"type":"edge","from":"peter","to":"lop","labels":["CREATED"],"properties":{"weight":0.2}}"#,
    ];
    ndjson::decode(&lines.join("\n"))
}

fn n(x: f64) -> Value {
    Value::Num(x)
}
fn s(x: &str) -> Value {
    Value::Str(x.to_string())
}
fn b(x: bool) -> Value {
    Value::Bool(x)
}

/// Run a query (no params) and return (columns, rows).
fn q(g: &mut Graph, query: &str) -> (Vec<String>, Vec<Vec<Value>>) {
    let parsed = parse(query).unwrap_or_else(|e| panic!("parse error for `{query}`: {e}"));
    let rs = parsed.execute(g, &Params::new()).unwrap_or_else(|e| panic!("exec error for `{query}`: {e}"));
    (rs.cols, rs.rows)
}

fn qp(g: &mut Graph, query: &str, params: Params) -> Vec<Vec<Value>> {
    parse(query).unwrap().execute(g, &params).unwrap().rows
}

fn rows(g: &mut Graph, query: &str) -> Vec<Vec<Value>> {
    q(g, query).1
}

#[test]
fn count_star_alias() {
    let mut g = modern();
    let (cols, r) = q(&mut g, "MATCH (n:Person) RETURN count(*) AS c");
    assert_eq!(cols, vec!["c"]);
    assert_eq!(r, vec![vec![n(4.0)]]);
}

#[test]
fn projection_column_names_and_order() {
    let mut g = modern();
    let (cols, r) = q(
        &mut g,
        "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN p.name, s.name ORDER BY p.name, s.name",
    );
    assert_eq!(cols, vec!["p.name", "s.name"]);
    assert_eq!(
        r,
        vec![
            vec![s("josh"), s("lop")],
            vec![s("josh"), s("ripple")],
            vec![s("marko"), s("lop")],
            vec![s("peter"), s("lop")],
        ]
    );
}

#[test]
fn incoming_edge() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (s:Software)<-[:CREATED]-(p:Person) WHERE s.name = 'ripple' RETURN p.name");
    assert_eq!(r, vec![vec![s("josh")]]);
}

#[test]
fn undirected_edge() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (a)~[:KNOWS]~(b) WHERE a.name = 'josh' RETURN b.name");
    assert_eq!(r, vec![vec![s("marko")]]);
}

#[test]
fn var_length_plus() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (a:Person {name: 'marko'})-[:KNOWS]->+(b) RETURN b.name ORDER BY b.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("vadas")]]);
}

#[test]
fn var_length_star_includes_self() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (a:Person {name: 'marko'})-[:KNOWS]->*(b) RETURN b.name ORDER BY b.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")], vec![s("vadas")]]);
}

#[test]
fn var_length_bounded() {
    let mut g = modern();
    // exactly 1 hop of KNOWS from marko → vadas, josh
    let r = rows(&mut g, "MATCH (a:Person {name: 'marko'})-[:KNOWS]->{1,1}(b) RETURN b.name ORDER BY b.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("vadas")]]);
}

#[test]
fn with_filter() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Person) WITH n.age AS age WHERE age > 30 RETURN age ORDER BY age");
    assert_eq!(r, vec![vec![n(32.0)], vec![n(35.0)]]);
}

#[test]
fn comma_join_shared_var() {
    let mut g = modern();
    // marko knows josh, and marko created lop
    let r = rows(
        &mut g,
        "MATCH (a:Person)-[:KNOWS]->(b), (a)-[:CREATED]->(s) RETURN a.name, b.name, s.name ORDER BY b.name",
    );
    // a=marko (only marko has both KNOWS-out and CREATED-out); b in {vadas, josh}; s=lop
    assert_eq!(
        r,
        vec![vec![s("marko"), s("josh"), s("lop")], vec![s("marko"), s("vadas"), s("lop")]]
    );
}

#[test]
fn optional_match_keeps_unmatched() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a:Person) OPTIONAL MATCH (a)-[:KNOWS]->(b) RETURN a.name, b.name ORDER BY a.name, b.name",
    );
    // josh/peter/vadas have no KNOWS-out → b null; marko → josh, vadas
    assert_eq!(
        r,
        vec![
            vec![s("josh"), Value::Null],
            vec![s("marko"), s("josh")],
            vec![s("marko"), s("vadas")],
            vec![s("peter"), Value::Null],
            vec![s("vadas"), Value::Null],
        ]
    );
}

#[test]
fn union_distinct_and_all() {
    let mut g = modern();
    let d = rows(&mut g, "MATCH (n:Person) RETURN n.name AS x UNION MATCH (s:Software) RETURN s.name AS x");
    assert_eq!(d.len(), 6);
    let a = rows(&mut g, "MATCH (n:Person) RETURN n.name AS x UNION ALL MATCH (n:Person) RETURN n.name AS x");
    assert_eq!(a.len(), 8);
}

#[test]
fn except_and_intersect() {
    let mut g = modern();
    let e = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name AS x EXCEPT MATCH (n:Person {name:'marko'}) RETURN n.name AS x",
    );
    assert_eq!(e.len(), 3);
    let i = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name AS x INTERSECT MATCH (n:Person) WHERE n.age > 30 RETURN n.name AS x ORDER BY x",
    );
    assert_eq!(i, vec![vec![s("josh")], vec![s("peter")]]);
}

#[test]
fn exists_subquery() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Person) WHERE EXISTS { (n)-[:CREATED]->(s) } RETURN n.name ORDER BY n.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")], vec![s("peter")]]);
}

#[test]
fn count_subquery() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Person) RETURN n.name, COUNT { (n)-[:CREATED]->() } AS c ORDER BY n.name");
    assert_eq!(
        r,
        vec![
            vec![s("josh"), n(2.0)],
            vec![s("marko"), n(1.0)],
            vec![s("peter"), n(1.0)],
            vec![s("vadas"), n(0.0)],
        ]
    );
}

#[test]
fn case_searched() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name, CASE WHEN n.age >= 30 THEN 'senior' ELSE 'junior' END AS tier ORDER BY n.name",
    );
    assert_eq!(
        r,
        vec![
            vec![s("josh"), s("senior")],
            vec![s("marko"), s("junior")],
            vec![s("peter"), s("senior")],
            vec![s("vadas"), s("junior")],
        ]
    );
}

#[test]
fn in_and_not_in() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Person) WHERE n.name IN ['marko','josh'] RETURN n.name ORDER BY n.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")]]);
    let r2 = rows(&mut g, "MATCH (n:Person) WHERE n.name NOT IN ['marko'] RETURN count(*) AS c");
    assert_eq!(r2, vec![vec![n(3.0)]]);
}

#[test]
fn is_null_and_is_truth() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Software) WHERE n.age IS NULL RETURN count(*) AS c");
    assert_eq!(r, vec![vec![n(2.0)]]);
    let t = rows(&mut g, "RETURN true IS TRUE AS a, (1 = 2) IS FALSE AS b, null IS UNKNOWN AS c");
    assert_eq!(t, vec![vec![b(true), b(true), b(true)]]);
}

#[test]
fn arithmetic_concat_and_negation() {
    let mut g = modern();
    let r = rows(&mut g, "RETURN 7 % 3 AS a, -5 AS b, 2 + 3 * 4 AS c, 'x' || '!' AS d");
    assert_eq!(r, vec![vec![n(1.0), n(-5.0), n(14.0), s("x!")]]);
}

#[test]
fn xor_precedence() {
    let mut g = modern();
    // ISO: OR/XOR same level, left-assoc. true XOR false = true.
    let r = rows(&mut g, "RETURN true XOR false AS a, (1=1) XOR (2=2) AS b");
    assert_eq!(r, vec![vec![b(true), b(false)]]);
}

#[test]
fn group_by_aggregate() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN s.name, count(*) AS c ORDER BY s.name");
    assert_eq!(r, vec![vec![s("lop"), n(3.0)], vec![s("ripple"), n(1.0)]]);
}

#[test]
fn aggregate_functions() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (p:Person) RETURN min(p.age) AS lo, max(p.age) AS hi, sum(p.age) AS tot, avg(p.age) AS mean",
    );
    assert_eq!(r, vec![vec![n(27.0), n(35.0), n(123.0), n(123.0 / 4.0)]]);
}

#[test]
fn collect_list_distinct() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN collect_list(DISTINCT s.name) AS langs");
    // marko/josh/peter → lop, josh → ripple; distinct → {lop, ripple} in encounter order
    assert_eq!(r, vec![vec![Value::List(vec![s("lop"), s("ripple")])]]);
}

#[test]
fn order_desc_limit_skip() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Person) RETURN n.name ORDER BY n.age DESC SKIP 1 LIMIT 2");
    // ages desc: peter35, josh32, marko29, vadas27 → skip peter → josh, marko
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")]]);
}

#[test]
fn distinct_projection() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN DISTINCT s.lang");
    assert_eq!(r, vec![vec![s("java")]]);
}

#[test]
fn label_expression_or_not_wildcard() {
    let mut g = modern();
    assert_eq!(rows(&mut g, "MATCH (n:Person|Software) RETURN count(*) AS c"), vec![vec![n(6.0)]]);
    assert_eq!(rows(&mut g, "MATCH (n:!Software) RETURN count(*) AS c"), vec![vec![n(4.0)]]);
    assert_eq!(rows(&mut g, "MATCH (n:%) RETURN count(*) AS c"), vec![vec![n(6.0)]]);
}

#[test]
fn property_map_and_inline_where() {
    let mut g = modern();
    assert_eq!(rows(&mut g, "MATCH (n {name: 'marko'}) RETURN n.age"), vec![vec![n(29.0)]]);
    let r = rows(&mut g, "MATCH (n:Person WHERE n.age > 30) RETURN n.name ORDER BY n.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("peter")]]);
}

#[test]
fn parameters() {
    let mut g = modern();
    let mut params = Params::new();
    params.insert("who".to_string(), super::eval::Val::Str("vadas".to_string()));
    let r = qp(&mut g, "MATCH (n:Person) WHERE n.name = $who RETURN n.age", params);
    assert_eq!(r, vec![vec![n(27.0)]]);
}

#[test]
fn scalar_functions() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "RETURN upper('ab') AS u, abs(-3) AS a, coalesce(null, 5) AS c, size([1,2,3]) AS sz, left('hello', 3) AS l",
    );
    assert_eq!(r, vec![vec![s("AB"), n(3.0), n(5.0), n(3.0), s("hel")]]);
}

#[test]
fn element_id_and_identity() {
    let mut g = modern();
    // element_id of a vertex is its external id; a = b is identity.
    let r = rows(&mut g, "MATCH (a:Person {name:'marko'}) RETURN element_id(a) AS id");
    assert_eq!(r, vec![vec![s("marko")]]);
    let c = rows(&mut g, "MATCH (a:Person), (b:Person) WHERE a = b RETURN count(*) AS c");
    assert_eq!(c, vec![vec![n(4.0)]]); // only the 4 self-pairs
}

#[test]
fn is_labeled_predicate() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n) WHERE n IS LABELED Software RETURN count(*) AS c");
    assert_eq!(r, vec![vec![n(2.0)]]);
    let r2 = rows(&mut g, "MATCH (n) WHERE n IS NOT LABELED Software RETURN count(*) AS c");
    assert_eq!(r2, vec![vec![n(4.0)]]);
}

#[test]
fn three_valued_null_comparison() {
    let mut g = modern();
    // n.age > 30 is UNKNOWN for Software (no age) → excluded; only josh, peter
    let r = rows(&mut g, "MATCH (n) WHERE n.age > 30 RETURN count(*) AS c");
    assert_eq!(r, vec![vec![n(2.0)]]);
}

#[test]
fn edge_property_projection() {
    let mut g = modern();
    // Bind the edge variable and read its property — now backed by edge columns.
    let r = rows(
        &mut g,
        "MATCH (a:Person {name:'marko'})-[r:KNOWS]->(b) RETURN b.name, r.weight ORDER BY b.name",
    );
    assert_eq!(r, vec![vec![s("josh"), n(1.0)], vec![s("vadas"), n(0.5)]]);
}

#[test]
fn edge_property_inline_where() {
    let mut g = modern();
    // Inline edge predicate filters on the edge's own property.
    let r = rows(&mut g, "MATCH (a)-[r:CREATED WHERE r.weight >= 1.0]->(s) RETURN a.name, s.name");
    assert_eq!(r, vec![vec![s("josh"), s("ripple")]]);
}

#[test]
fn edge_property_map_constraint() {
    let mut g = modern();
    // Property-map constraint on an edge.
    let r = rows(&mut g, "MATCH (a:Person)-[:CREATED {weight: 0.4}]->(s) RETURN a.name ORDER BY a.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")]]);
}

#[test]
fn edge_property_aggregate() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH ()-[r:CREATED]->() RETURN sum(r.weight) AS total, count(*) AS c");
    assert_eq!(r, vec![vec![n(0.4 + 1.0 + 0.4 + 0.2), n(4.0)]]);
}

#[test]
fn two_match_clauses() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (a:Person {name:'marko'}) MATCH (a)-[:KNOWS]->(b) RETURN b.name ORDER BY b.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("vadas")]]);
}

#[test]
fn with_carries_element_forward() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (a:Person {name:'josh'}) WITH a MATCH (a)-[:CREATED]->(x) RETURN x.name ORDER BY x.name");
    assert_eq!(r, vec![vec![s("lop")], vec![s("ripple")]]);
}

#[test]
fn not_exists_subquery() {
    let mut g = modern();
    // vadas is the only Person who created nothing.
    let r = rows(&mut g, "MATCH (n:Person) WHERE NOT EXISTS { (n)-[:CREATED]->() } RETURN n.name ORDER BY n.name");
    assert_eq!(r, vec![vec![s("vadas")]]);
}

#[test]
fn exists_with_inner_where() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Person) WHERE EXISTS { (n)-[:CREATED]->(s) WHERE s.name = 'ripple' } RETURN n.name");
    assert_eq!(r, vec![vec![s("josh")]]);
}

#[test]
fn count_over_empty_is_zero() {
    let mut g = modern();
    assert_eq!(rows(&mut g, "MATCH (n:Ghost) RETURN count(*) AS c"), vec![vec![n(0.0)]]);
}

#[test]
fn min_max_over_empty_is_null() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Ghost) RETURN min(n.age) AS lo, max(n.age) AS hi");
    assert_eq!(r, vec![vec![Value::Null, Value::Null]]);
}

#[test]
fn order_by_multiple_keys() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN p.name, s.name ORDER BY s.name, p.name");
    assert_eq!(
        r,
        vec![
            vec![s("josh"), s("lop")],
            vec![s("marko"), s("lop")],
            vec![s("peter"), s("lop")],
            vec![s("josh"), s("ripple")],
        ]
    );
}

#[test]
fn order_by_alias() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (n:Person) RETURN n.name AS who, n.age AS yrs ORDER BY yrs DESC LIMIT 2");
    assert_eq!(r, vec![vec![s("peter"), n(35.0)], vec![s("josh"), n(32.0)]]);
}

#[test]
fn coalesce_and_nullif() {
    let mut g = modern();
    let r = rows(&mut g, "RETURN coalesce(null, null, 7) AS a, nullif(3, 3) AS b, nullif(3, 4) AS c");
    assert_eq!(r, vec![vec![n(7.0), Value::Null, n(3.0)]]);
}

#[test]
fn multi_stage_with_aggregate_filter() {
    let mut g = modern();
    // group, aggregate, filter on the aggregate, then return.
    let r = rows(
        &mut g,
        "MATCH (p:Person)-[:CREATED]->(s:Software) WITH s.name AS sw, count(*) AS c WHERE c > 1 RETURN sw, c",
    );
    assert_eq!(r, vec![vec![s("lop"), n(3.0)]]);
}

#[test]
fn with_star_carries_all_vars() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a:Person {name:'marko'})-[:KNOWS]->(b) WITH * WHERE b.age > 28 RETURN b.name ORDER BY b.name",
    );
    assert_eq!(r, vec![vec![s("josh")]]);
}

#[test]
fn undirected_var_length() {
    let mut g = modern();
    // From vadas, KNOWS is incoming (marko→vadas); undirected reaches marko,
    // then marko's other KNOWS reaches josh.
    let r = rows(&mut g, "MATCH (a:Person {name:'vadas'})-[:KNOWS]-*(b) RETURN b.name ORDER BY b.name");
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")], vec![s("vadas")]]);
}

// --- write clauses (the graph is mutable) -----------------------------------

#[test]
fn insert_multi_label_node() {
    let mut g = modern();
    // ISO label conjunction `:A&B` names both labels on creation.
    let r = rows(&mut g, "INSERT (n:Person&Admin {name:'root'}) RETURN n.name");
    assert_eq!(r, vec![vec![s("root")]]);
    assert_eq!(rows(&mut g, "MATCH (n:Admin) RETURN n.name"), vec![vec![s("root")]]);
    assert_eq!(rows(&mut g, "MATCH (n:Person&Admin) RETURN n.name"), vec![vec![s("root")]]);
}

#[test]
fn insert_node_then_return() {
    let mut g = modern();
    let r = rows(&mut g, "INSERT (n:Person {name: 'newbie', age: 99}) RETURN n.name, n.age");
    assert_eq!(r, vec![vec![s("newbie"), n(99.0)]]);
    // The new node is matchable afterward, and Person count grew 4 → 5.
    assert_eq!(rows(&mut g, "MATCH (p:Person) RETURN count(*) AS c"), vec![vec![n(5.0)]]);
    assert_eq!(g.vertex_count(), 7);
}

#[test]
fn insert_edge_between_matched_nodes() {
    let mut g = modern();
    // marko does not yet know peter; create the edge, then traverse it.
    rows(&mut g, "MATCH (a:Person {name:'marko'}), (b:Person {name:'peter'}) INSERT (a)-[:KNOWS {weight: 0.9}]->(b)");
    let r = rows(&mut g, "MATCH (a:Person {name:'marko'})-[r:KNOWS]->(b) RETURN b.name, r.weight ORDER BY b.name");
    assert_eq!(r, vec![vec![s("josh"), n(1.0)], vec![s("peter"), n(0.9)], vec![s("vadas"), n(0.5)]]);
}

#[test]
fn set_property_and_label() {
    let mut g = modern();
    rows(&mut g, "MATCH (n:Person {name:'vadas'}) SET n.age = 28, n:Senior");
    assert_eq!(rows(&mut g, "MATCH (n:Person {name:'vadas'}) RETURN n.age"), vec![vec![n(28.0)]]);
    assert_eq!(rows(&mut g, "MATCH (n:Senior) RETURN n.name"), vec![vec![s("vadas")]]);
}

#[test]
fn set_new_property_creates_column() {
    let mut g = modern();
    // 'city' is a brand-new key — the column is created on demand.
    rows(&mut g, "MATCH (n:Person {name:'josh'}) SET n.city = 'berlin'");
    assert_eq!(rows(&mut g, "MATCH (n:Person) WHERE n.city = 'berlin' RETURN n.name"), vec![vec![s("josh")]]);
}

#[test]
fn set_promotes_column_to_mixed_on_type_change() {
    let mut g = modern();
    // age is a Num column; setting a string promotes it to Mixed (lossless).
    rows(&mut g, "MATCH (n:Person {name:'marko'}) SET n.age = 'twenty-nine'");
    assert_eq!(rows(&mut g, "MATCH (n:Person {name:'marko'}) RETURN n.age"), vec![vec![s("twenty-nine")]]);
    // other rows keep their numeric ages
    assert_eq!(rows(&mut g, "MATCH (n:Person {name:'josh'}) RETURN n.age"), vec![vec![n(32.0)]]);
}

#[test]
fn remove_property() {
    let mut g = modern();
    rows(&mut g, "MATCH (n:Person {name:'peter'}) REMOVE n.age");
    assert_eq!(
        rows(&mut g, "MATCH (n:Person) WHERE n.age IS NULL RETURN n.name"),
        vec![vec![s("peter")]]
    );
}

#[test]
fn delete_isolated_vertex() {
    let mut g = modern();
    // ripple has only an incoming CREATED edge, so plain DELETE needs DETACH;
    // delete an edge first, then a now-isolated vertex.
    rows(&mut g, "MATCH (:Person {name:'josh'})-[r:CREATED]->(:Software {name:'ripple'}) DELETE r");
    rows(&mut g, "MATCH (n:Software {name:'ripple'}) DELETE n");
    assert_eq!(rows(&mut g, "MATCH (s:Software) RETURN count(*) AS c"), vec![vec![n(1.0)]]);
}

#[test]
fn detach_delete_cascades_edges() {
    let mut g = modern();
    rows(&mut g, "MATCH (n:Person {name:'marko'}) DETACH DELETE n");
    // marko and all his edges are gone; remaining people = 3.
    assert_eq!(rows(&mut g, "MATCH (p:Person) RETURN count(*) AS c"), vec![vec![n(3.0)]]);
    // lop now has 2 creators (josh, peter) instead of 3.
    assert_eq!(
        rows(&mut g, "MATCH (:Person)-[:CREATED]->(s:Software {name:'lop'}) RETURN count(*) AS c"),
        vec![vec![n(2.0)]]
    );
}

#[test]
fn delete_vertex_with_edges_errors_without_detach() {
    let mut g = modern();
    let err = parse("MATCH (n:Person {name:'marko'}) DELETE n")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert!(err.contains("DETACH"), "got: {err}");
}

#[test]
fn missing_label_empty_with_columns() {
    let mut g = modern();
    let (cols, r) = q(&mut g, "MATCH (n:Ghost) RETURN n.name AS who");
    assert_eq!(cols, vec!["who"]);
    assert!(r.is_empty());
}
