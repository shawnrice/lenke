//! Conformance tests for the GQL engine, mirroring the TS `gql.test.ts` /
//! `tck.test.ts` spec over the TinkerPop "Modern" fixture. Covers the read
//! surface, edge properties, and write clauses (the graph is mutable).

use std::sync::Arc;

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
    ndjson::decode(&lines.join("\n")).unwrap()
}

fn n(x: f64) -> Value {
    Value::Num(x)
}
fn s(x: &str) -> Value {
    Value::Str(x.into())
}
fn b(x: bool) -> Value {
    Value::Bool(x)
}

/// Run a query (no params) and return (columns, rows).
fn q(g: &mut Graph, query: &str) -> (Vec<String>, Vec<Vec<Value>>) {
    let parsed = parse(query).unwrap_or_else(|e| panic!("parse error for `{query}`: {e}"));
    let rs = parsed
        .execute(g, &Params::new())
        .unwrap_or_else(|e| panic!("exec error for `{query}`: {e}"));
    (rs.cols.clone(), rs.rows().map(|r| r.to_vec()).collect())
}

fn qp(g: &mut Graph, query: &str, params: Params) -> Vec<Vec<Value>> {
    parse(query)
        .unwrap()
        .execute(g, &params)
        .unwrap()
        .rows()
        .map(|r| r.to_vec())
        .collect()
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

/// A numeric `score` present on some nodes, absent on others — so the column
/// carries NaN for the absent ones. Exercises the absent→NaN columnar path that
/// the vectorized aggregate executor now handles for plain `MATCH … WHERE …
/// RETURN <aggregate>` (no intermediate WITH): a numeric predicate must treat
/// `NaN <cmp> x` as false (matching GQL null semantics), and sum/avg/count must
/// skip absent values — exactly the scalar engine's behavior.
fn mixed_presence() -> Graph {
    let lines = [
        r#"{"type":"node","id":"a","labels":["T"],"properties":{"score":1,"age":10}}"#,
        r#"{"type":"node","id":"b","labels":["T"],"properties":{"age":20}}"#,
        r#"{"type":"node","id":"c","labels":["T"],"properties":{"score":9,"age":30}}"#,
        r#"{"type":"node","id":"d","labels":["T"],"properties":{"score":5}}"#,
        r#"{"type":"node","id":"e","labels":["T"],"properties":{"score":4,"age":20}}"#,
        r#"{"type":"node","id":"f","labels":["T"],"properties":{"age":40}}"#,
    ];
    ndjson::decode(&lines.join("\n")).unwrap()
}

#[test]
fn vectorized_aggregates_over_absent_and_nan() {
    let mut g = mixed_presence();
    // count(*) — every matched row
    assert_eq!(
        rows(&mut g, "MATCH (n:T) RETURN count(*) AS c"),
        vec![vec![n(6.0)]]
    );
    // numeric predicate where absent score is NaN in the column: NaN > x is false,
    // so absent nodes are excluded (b, f have no score).
    assert_eq!(
        rows(&mut g, "MATCH (n:T) WHERE n.score > 5 RETURN count(*) AS c"),
        vec![vec![n(1.0)]]
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:T) WHERE n.score >= 5 RETURN count(*) AS c"
        ),
        vec![vec![n(2.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:T) WHERE n.age > 15 RETURN count(*) AS c"),
        vec![vec![n(4.0)]]
    );
    // aggregates skip absent values (4 nodes have score: 1,9,5,4)
    assert_eq!(
        rows(&mut g, "MATCH (n:T) RETURN sum(n.score) AS s"),
        vec![vec![n(19.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:T) RETURN avg(n.score) AS a"),
        vec![vec![n(4.75)]]
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:T) RETURN min(n.score) AS lo, max(n.score) AS hi"
        ),
        vec![vec![n(1.0), n(9.0)]],
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:T) RETURN count(n.score) AS c"),
        vec![vec![n(4.0)]]
    );
    // filter on one property, aggregate another: age>=20 → {b,c,e,f}; present
    // scores among them are c=9, e=4 (b, f skipped).
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:T) WHERE n.age >= 20 RETURN sum(n.score) AS s"
        ),
        vec![vec![n(13.0)]]
    );
}

#[test]
fn count_star_shortcut_edges() {
    let mut g = mixed_presence();
    // bare count(*) over a label takes the O(1) `vertices_with_label(l).len()`
    // shortcut — must equal the general count.
    assert_eq!(
        rows(&mut g, "MATCH (n:T) RETURN count(*) AS c"),
        vec![vec![n(6.0)]]
    );
    // a label with no vertices → count 0 (still one row, like the general path).
    assert_eq!(
        rows(&mut g, "MATCH (n:Ghost) RETURN count(*) AS c"),
        vec![vec![n(0.0)]]
    );
    // count(*)+1 is NOT the bare shortcut (output is an expression over the agg).
    assert_eq!(
        rows(&mut g, "MATCH (n:T) RETURN count(*) + 1 AS c"),
        vec![vec![n(7.0)]]
    );
    // a second aggregate / a grouping key / a WHERE all keep the general path.
    assert_eq!(
        rows(&mut g, "MATCH (n:T) WHERE n.age > 15 RETURN count(*) AS c"),
        vec![vec![n(4.0)]]
    );
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
fn two_hop_linear_pattern() {
    // Regression: a linear two-segment pattern `(a)-[r1]->(b)-[r2]->(c)` used to
    // panic in build_scan because the per-row column copy referenced `c`'s slot
    // (bound only by the second segment) while building the first segment.
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a:Person {name: 'marko'})-[:KNOWS]->(b)-[:CREATED]->(c) RETURN c.name ORDER BY c.name",
    );
    // marko KNOWS josh; josh CREATED lop + ripple.
    assert_eq!(r, vec![vec![s("lop")], vec![s("ripple")]]);
}

#[test]
fn three_hop_linear_pattern() {
    // A three-segment chain exercises copying multiple already-bound columns
    // across several future-bound slots.
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a:Person {name: 'marko'})-[:KNOWS]->(b)-[:CREATED]->(c)<-[:CREATED]-(d) RETURN d.name ORDER BY d.name",
    );
    // marko->josh; josh created lop+ripple; lop also created-by marko,josh,peter;
    // ripple created-by josh. Distinct d over both c's, ordered.
    assert_eq!(
        r,
        vec![
            vec![s("josh")],
            vec![s("josh")],
            vec![s("marko")],
            vec![s("peter")],
        ]
    );
}

#[test]
fn incoming_edge() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (s:Software)<-[:CREATED]-(p:Person) WHERE s.name = 'ripple' RETURN p.name",
    );
    assert_eq!(r, vec![vec![s("josh")]]);
}

#[test]
fn undirected_edge() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a)~[:KNOWS]~(b) WHERE a.name = 'josh' RETURN b.name",
    );
    assert_eq!(r, vec![vec![s("marko")]]);
}

#[test]
fn var_length_plus() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a:Person {name: 'marko'})-[:KNOWS]->+(b) RETURN b.name ORDER BY b.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("vadas")]]);
}

#[test]
fn var_length_star_includes_self() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a:Person {name: 'marko'})-[:KNOWS]->*(b) RETURN b.name ORDER BY b.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")], vec![s("vadas")]]);
}

#[test]
fn var_length_bounded() {
    let mut g = modern();
    // exactly 1 hop of KNOWS from marko → vadas, josh
    let r = rows(
        &mut g,
        "MATCH (a:Person {name: 'marko'})-[:KNOWS]->{1,1}(b) RETURN b.name ORDER BY b.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("vadas")]]);
}

#[test]
fn with_filter() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (n:Person) WITH n.age AS age WHERE age > 30 RETURN age ORDER BY age",
    );
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
        vec![
            vec![s("marko"), s("josh"), s("lop")],
            vec![s("marko"), s("vadas"), s("lop")]
        ]
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
    let d = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name AS x UNION MATCH (s:Software) RETURN s.name AS x",
    );
    assert_eq!(d.len(), 6);
    let a = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name AS x UNION ALL MATCH (n:Person) RETURN n.name AS x",
    );
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
    let r = rows(
        &mut g,
        "MATCH (n:Person) WHERE EXISTS { (n)-[:CREATED]->(s) } RETURN n.name ORDER BY n.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")], vec![s("peter")]]);
}

#[test]
fn count_subquery() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name, COUNT { (n)-[:CREATED]->() } AS c ORDER BY n.name",
    );
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
    let r = rows(
        &mut g,
        "MATCH (n:Person) WHERE n.name IN ['marko','josh'] RETURN n.name ORDER BY n.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")]]);
    let r2 = rows(
        &mut g,
        "MATCH (n:Person) WHERE n.name NOT IN ['marko'] RETURN count(*) AS c",
    );
    assert_eq!(r2, vec![vec![n(3.0)]]);
}

#[test]
fn is_null_and_is_truth() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (n:Software) WHERE n.age IS NULL RETURN count(*) AS c",
    );
    assert_eq!(r, vec![vec![n(2.0)]]);
    let t = rows(
        &mut g,
        "RETURN true IS TRUE AS a, (1 = 2) IS FALSE AS b, null IS UNKNOWN AS c",
    );
    assert_eq!(t, vec![vec![b(true), b(true), b(true)]]);
}

#[test]
fn arithmetic_concat_and_negation() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "RETURN 7 % 3 AS a, -5 AS b, 2 + 3 * 4 AS c, 'x' || '!' AS d",
    );
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
    let r = rows(
        &mut g,
        "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN s.name, count(*) AS c ORDER BY s.name",
    );
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
    let r = rows(
        &mut g,
        "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN collect_list(DISTINCT s.name) AS langs",
    );
    // marko/josh/peter → lop, josh → ripple; distinct → {lop, ripple} in encounter order
    assert_eq!(r, vec![vec![Value::List(vec![s("lop"), s("ripple")])]]);
}

#[test]
fn order_desc_limit_skip() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name ORDER BY n.age DESC SKIP 1 LIMIT 2",
    );
    // ages desc: peter35, josh32, marko29, vadas27 → skip peter → josh, marko
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")]]);
}

#[test]
fn distinct_projection() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN DISTINCT s.lang",
    );
    assert_eq!(r, vec![vec![s("java")]]);
}

#[test]
fn label_expression_or_not_wildcard() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "MATCH (n:Person|Software) RETURN count(*) AS c"),
        vec![vec![n(6.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:!Software) RETURN count(*) AS c"),
        vec![vec![n(4.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:%) RETURN count(*) AS c"),
        vec![vec![n(6.0)]]
    );
}

#[test]
fn property_map_and_inline_where() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "MATCH (n {name: 'marko'}) RETURN n.age"),
        vec![vec![n(29.0)]]
    );
    let r = rows(
        &mut g,
        "MATCH (n:Person WHERE n.age > 30) RETURN n.name ORDER BY n.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("peter")]]);
}

#[test]
fn parameters() {
    let mut g = modern();
    let mut params = Params::new();
    params.insert("who".to_string(), super::eval::Val::Str("vadas".into()));
    let r = qp(
        &mut g,
        "MATCH (n:Person) WHERE n.name = $who RETURN n.age",
        params,
    );
    assert_eq!(r, vec![vec![n(27.0)]]);
}

#[test]
fn indexed_param_lookup_matches_scan() {
    // An index seek must return the SAME rows as a full scan — proving the
    // param-resolved seek (WHERE `.k = $p` and inline `{k: $p}`) is correct, not
    // just fast. Compare an indexed graph's results to an un-indexed one.
    let mk = || {
        let mut g = modern();
        g.create_vertex_index("name");
        g
    };
    let param = |name: &str| {
        let mut p = Params::new();
        p.insert("who".to_string(), super::eval::Val::Str(name.into()));
        p
    };
    // WHERE with a $param → index seek on `name`.
    assert_eq!(
        qp(
            &mut mk(),
            "MATCH (n:Person) WHERE n.name = $who RETURN n.age",
            param("josh")
        ),
        vec![vec![n(32.0)]]
    );
    // Inline `{name: $param}` → index seek.
    assert_eq!(
        qp(
            &mut mk(),
            "MATCH (n:Person {name: $who}) RETURN n.age",
            param("marko")
        ),
        vec![vec![n(29.0)]]
    );
    // A miss returns nothing (not a stale index hit).
    assert!(qp(
        &mut mk(),
        "MATCH (n:Person {name: $who}) RETURN n.age",
        param("nobody")
    )
    .is_empty());
}

#[test]
fn prepared_plan_reused_with_params() {
    use super::eval::Val;
    let mut g = modern();
    // Lower once, execute many with different params slotted in positionally.
    let plan = super::prepare("MATCH (n:Person) WHERE n.name = $who RETURN n.age AS age").unwrap();

    let mut p1 = Params::new();
    p1.insert("who".to_string(), Val::Str("marko".into()));
    assert_eq!(
        plan.execute(&mut g, &p1)
            .unwrap()
            .rows()
            .map(|r| r.to_vec())
            .collect::<Vec<_>>(),
        vec![vec![n(29.0)]]
    );

    let mut p2 = Params::new();
    p2.insert("who".to_string(), Val::Str("josh".into()));
    assert_eq!(
        plan.execute(&mut g, &p2)
            .unwrap()
            .rows()
            .map(|r| r.to_vec())
            .collect::<Vec<_>>(),
        vec![vec![n(32.0)]]
    );
}

#[test]
fn prepared_write_persists() {
    use super::eval::Val;
    let mut g = modern();
    let ins = super::prepare("INSERT (n:Person {name: $nm, age: $age}) RETURN n.name").unwrap();
    let mut p = Params::new();
    p.insert("nm".to_string(), Val::Str("zoe".into()));
    p.insert("age".to_string(), Val::Num(40.0));
    assert_eq!(
        ins.execute(&mut g, &p)
            .unwrap()
            .rows()
            .map(|r| r.to_vec())
            .collect::<Vec<_>>(),
        vec![vec![s("zoe")]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:Person) RETURN count(*) AS c"),
        vec![vec![n(5.0)]]
    );
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
    let r = rows(
        &mut g,
        "MATCH (a:Person {name:'marko'}) RETURN element_id(a) AS id",
    );
    assert_eq!(r, vec![vec![s("marko")]]);
    let c = rows(
        &mut g,
        "MATCH (a:Person), (b:Person) WHERE a = b RETURN count(*) AS c",
    );
    assert_eq!(c, vec![vec![n(4.0)]]); // only the 4 self-pairs
}

#[test]
fn is_labeled_predicate() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (n) WHERE n IS LABELED Software RETURN count(*) AS c",
    );
    assert_eq!(r, vec![vec![n(2.0)]]);
    let r2 = rows(
        &mut g,
        "MATCH (n) WHERE n IS NOT LABELED Software RETURN count(*) AS c",
    );
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
    let r = rows(
        &mut g,
        "MATCH (a)-[r:CREATED WHERE r.weight >= 1.0]->(s) RETURN a.name, s.name",
    );
    assert_eq!(r, vec![vec![s("josh"), s("ripple")]]);
}

#[test]
fn edge_property_map_constraint() {
    let mut g = modern();
    // Property-map constraint on an edge.
    let r = rows(
        &mut g,
        "MATCH (a:Person)-[:CREATED {weight: 0.4}]->(s) RETURN a.name ORDER BY a.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")]]);
}

#[test]
fn edge_property_aggregate() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH ()-[r:CREATED]->() RETURN sum(r.weight) AS total, count(*) AS c",
    );
    assert_eq!(r, vec![vec![n(0.4 + 1.0 + 0.4 + 0.2), n(4.0)]]);
}

#[test]
fn limit_pushdown_streams_match_order() {
    let mut g = modern();
    // No ORDER BY → streamable; LIMIT short-circuits matching in declaration order.
    assert_eq!(
        rows(&mut g, "MATCH (n:Person) RETURN n.name LIMIT 2"),
        vec![vec![s("marko")], vec![s("vadas")]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:Person) RETURN n.name SKIP 1 LIMIT 2"),
        vec![vec![s("vadas")], vec![s("josh")]]
    );
}

#[test]
fn order_by_limit_is_global_not_pushed_down() {
    let mut g = modern();
    // ORDER BY present → cap NOT applied; result is the globally smallest ages.
    let r = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name ORDER BY n.age LIMIT 2",
    );
    assert_eq!(r, vec![vec![s("vadas")], vec![s("marko")]]);
}

#[test]
fn group_by_expression() {
    let mut g = modern();
    // group key is an expression (age parity), not just a property.
    let r = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.age % 2 AS parity, count(*) AS c ORDER BY parity",
    );
    assert_eq!(r, vec![vec![n(0.0), n(1.0)], vec![n(1.0), n(3.0)]]);
}

#[test]
fn count_distinct_aggregate() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN count(DISTINCT s.lang) AS c",
    );
    assert_eq!(r, vec![vec![n(1.0)]]);
}

#[test]
fn nested_function_calls() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN upper(left('hello', 3)) AS x"),
        vec![vec![s("HEL")]]
    );
}

#[test]
fn case_simple_form() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "RETURN CASE 2 WHEN 1 THEN 'a' WHEN 2 THEN 'b' ELSE 'c' END AS x",
    );
    assert_eq!(r, vec![vec![s("b")]]);
}

#[test]
fn order_by_expression() {
    let mut g = modern();
    // ORDER BY an expression (negated age) → effectively descending by age.
    let r = rows(&mut g, "MATCH (n:Person) RETURN n.name ORDER BY n.age * -1");
    assert_eq!(
        r,
        vec![
            vec![s("peter")],
            vec![s("josh")],
            vec![s("marko")],
            vec![s("vadas")]
        ]
    );
}

#[test]
fn concat_coerces_number_and_comparison_projects_bool() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN 'age=' || 29 AS x"),
        vec![vec![s("age=29")]]
    );
    let r = rows(
        &mut g,
        "MATCH (n:Person {name:'josh'}) RETURN n.age > 30 AS old",
    );
    assert_eq!(r, vec![vec![b(true)]]);
}

#[test]
fn three_valued_boolean_logic() {
    let mut g = modern();
    // AND/OR/XOR/NOT with UNKNOWN (null), per ISO Kleene logic.
    let r = rows(
        &mut g,
        "RETURN null AND false AS a, null AND true AS b, null OR true AS c, \
         null OR false AS d, NOT null AS e, null XOR true AS f",
    );
    assert_eq!(
        r,
        vec![vec![
            b(false),
            Value::Null,
            b(true),
            Value::Null,
            Value::Null,
            Value::Null
        ]]
    );
}

#[test]
fn null_comparison_and_arithmetic_propagate() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "RETURN (1 = 1) AS a, (1 = 2) AS b, (null = 1) AS c, (1 + null) AS d",
    );
    assert_eq!(r, vec![vec![b(true), b(false), Value::Null, Value::Null]]);
}

#[test]
fn in_three_valued_logic() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "RETURN 1 IN [1,2] AS a, 3 IN [1,2] AS b, null IN [] AS c, \
         1 IN [null] AS d, 3 IN [1,null] AS e, 1 IN [1,null] AS f",
    );
    // null IN [] is FALSE (empty disjunction); a TRUE equality beats UNKNOWN.
    assert_eq!(
        r,
        vec![vec![
            b(true),
            b(false),
            b(false),
            Value::Null,
            Value::Null,
            b(true)
        ]]
    );
}

#[test]
fn two_match_clauses() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a:Person {name:'marko'}) MATCH (a)-[:KNOWS]->(b) RETURN b.name ORDER BY b.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("vadas")]]);
}

#[test]
fn with_carries_element_forward() {
    let mut g = modern();
    let r = rows(&mut g, "MATCH (a:Person {name:'josh'}) WITH a MATCH (a)-[:CREATED]->(x) RETURN x.name ORDER BY x.name");
    assert_eq!(r, vec![vec![s("lop")], vec![s("ripple")]]);
}

#[test]
fn with_then_match_expand_count() {
    let mut g = modern();
    // All CREATED edges: marko→lop, josh→ripple, josh→lop, peter→lop = 4.
    let r = rows(
        &mut g,
        "MATCH (a:Person) WITH a MATCH (a)-[:CREATED]->(x) RETURN count(*) AS c",
    );
    assert_eq!(r, vec![vec![n(4.0)]]);
}

#[test]
fn with_carry_computed_col_across_expand() {
    let mut g = modern();
    // Carry a.age forward, expand KNOWS, keep neighbors older than the carried age.
    // marko(29)→vadas(27): no; marko(29)→josh(32): yes ⇒ 1.
    let r = rows(&mut g, "MATCH (a:Person) WITH a, a.age AS aage MATCH (a)-[:KNOWS]->(b) WHERE b.age > aage RETURN count(*) AS c");
    assert_eq!(r, vec![vec![n(1.0)]]);
}

#[test]
fn with_value_col_survives_expand() {
    let mut g = modern();
    // The computed column `an` (a value column) must ride through the expand and
    // appear in output alongside the expanded b's property.
    let r = rows(&mut g, "MATCH (a:Person {name:'marko'}) WITH a, a.name AS an MATCH (a)-[:KNOWS]->(b {name:'josh'}) RETURN an, b.age");
    assert_eq!(r, vec![vec![s("marko"), n(32.0)]]);
}

#[test]
fn not_exists_subquery() {
    let mut g = modern();
    // vadas is the only Person who created nothing.
    let r = rows(
        &mut g,
        "MATCH (n:Person) WHERE NOT EXISTS { (n)-[:CREATED]->() } RETURN n.name ORDER BY n.name",
    );
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
    assert_eq!(
        rows(&mut g, "MATCH (n:Ghost) RETURN count(*) AS c"),
        vec![vec![n(0.0)]]
    );
}

#[test]
fn min_max_over_empty_is_null() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (n:Ghost) RETURN min(n.age) AS lo, max(n.age) AS hi",
    );
    assert_eq!(r, vec![vec![Value::Null, Value::Null]]);
}

#[test]
fn order_by_multiple_keys() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (p:Person)-[:CREATED]->(s:Software) RETURN p.name, s.name ORDER BY s.name, p.name",
    );
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
    let r = rows(
        &mut g,
        "MATCH (n:Person) RETURN n.name AS who, n.age AS yrs ORDER BY yrs DESC LIMIT 2",
    );
    assert_eq!(r, vec![vec![s("peter"), n(35.0)], vec![s("josh"), n(32.0)]]);
}

#[test]
fn coalesce_and_nullif() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "RETURN coalesce(null, null, 7) AS a, nullif(3, 3) AS b, nullif(3, 4) AS c",
    );
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
fn return_star_columns_are_bound_vars() {
    let mut g = modern();
    // `*` projects every in-scope variable as a column (here just `n`).
    let (cols, r) = q(&mut g, "MATCH (n:Person {name:'marko'}) RETURN *");
    assert_eq!(cols, vec!["n"]);
    // A returned node serializes to a rich `{id, labels, properties}` map
    // (byte-identical to the TS engine); keys/labels are sorted.
    let node = Value::Map(vec![
        (Arc::from("id"), s("marko")),
        (Arc::from("labels"), Value::List(vec![s("Person")])),
        (
            Arc::from("properties"),
            Value::Map(vec![
                (Arc::from("age"), n(29.0)),
                (Arc::from("name"), s("marko")),
            ]),
        ),
    ]);
    assert_eq!(r, vec![vec![node]]);
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
    let r = rows(
        &mut g,
        "MATCH (a:Person {name:'vadas'})-[:KNOWS]-*(b) RETURN b.name ORDER BY b.name",
    );
    assert_eq!(r, vec![vec![s("josh")], vec![s("marko")], vec![s("vadas")]]);
}

// --- write clauses (the graph is mutable) -----------------------------------

#[test]
fn insert_multi_label_node() {
    let mut g = modern();
    // ISO label conjunction `:A&B` names both labels on creation.
    let r = rows(
        &mut g,
        "INSERT (n:Person&Admin {name:'root'}) RETURN n.name",
    );
    assert_eq!(r, vec![vec![s("root")]]);
    assert_eq!(
        rows(&mut g, "MATCH (n:Admin) RETURN n.name"),
        vec![vec![s("root")]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:Person&Admin) RETURN n.name"),
        vec![vec![s("root")]]
    );
}

#[test]
fn insert_node_then_return() {
    let mut g = modern();
    let r = rows(
        &mut g,
        "INSERT (n:Person {name: 'newbie', age: 99}) RETURN n.name, n.age",
    );
    assert_eq!(r, vec![vec![s("newbie"), n(99.0)]]);
    // The new node is matchable afterward, and Person count grew 4 → 5.
    assert_eq!(
        rows(&mut g, "MATCH (p:Person) RETURN count(*) AS c"),
        vec![vec![n(5.0)]]
    );
    assert_eq!(g.vertex_count(), 7);
}

#[test]
fn insert_edge_between_matched_nodes() {
    let mut g = modern();
    // marko does not yet know peter; create the edge, then traverse it.
    rows(&mut g, "MATCH (a:Person {name:'marko'}), (b:Person {name:'peter'}) INSERT (a)-[:KNOWS {weight: 0.9}]->(b)");
    let r = rows(
        &mut g,
        "MATCH (a:Person {name:'marko'})-[r:KNOWS]->(b) RETURN b.name, r.weight ORDER BY b.name",
    );
    assert_eq!(
        r,
        vec![
            vec![s("josh"), n(1.0)],
            vec![s("peter"), n(0.9)],
            vec![s("vadas"), n(0.5)]
        ]
    );
}

#[test]
fn set_property_and_label() {
    let mut g = modern();
    rows(
        &mut g,
        "MATCH (n:Person {name:'vadas'}) SET n.age = 28, n:Senior",
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:Person {name:'vadas'}) RETURN n.age"),
        vec![vec![n(28.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:Senior) RETURN n.name"),
        vec![vec![s("vadas")]]
    );
}

#[test]
fn set_new_property_creates_column() {
    let mut g = modern();
    // 'city' is a brand-new key — the column is created on demand.
    rows(
        &mut g,
        "MATCH (n:Person {name:'josh'}) SET n.city = 'berlin'",
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:Person) WHERE n.city = 'berlin' RETURN n.name"
        ),
        vec![vec![s("josh")]]
    );
}

#[test]
fn set_promotes_column_to_mixed_on_type_change() {
    let mut g = modern();
    // age is a Num column; setting a string promotes it to Mixed (lossless).
    rows(
        &mut g,
        "MATCH (n:Person {name:'marko'}) SET n.age = 'twenty-nine'",
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:Person {name:'marko'}) RETURN n.age"),
        vec![vec![s("twenty-nine")]]
    );
    // other rows keep their numeric ages
    assert_eq!(
        rows(&mut g, "MATCH (n:Person {name:'josh'}) RETURN n.age"),
        vec![vec![n(32.0)]]
    );
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
fn set_null_stores_a_present_null_and_remove_deletes_it() {
    // Divergence from Cypher: `SET n.k = null` STORES a present null — it does
    // NOT remove the property. `REMOVE` is the explicit deletion path. Both a
    // present null and an absent key satisfy `IS NULL` (three-valued logic).
    let mut g = modern();
    rows(&mut g, "MATCH (n:Person {name:'marko'}) SET n.nick = null");

    let marko = g.vid.get("marko").unwrap() as usize;
    assert!(
        g.props.is_present(marko, "nick"),
        "SET null stores a PRESENT null, not a removal"
    );
    assert_eq!(g.props.value(marko, "nick", &g.strs), Value::Null);

    // IS NULL matches the stored null.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:Person {name:'marko'}) WHERE n.nick IS NULL RETURN n.name"
        ),
        vec![vec![s("marko")]]
    );

    // REMOVE actually deletes it.
    rows(&mut g, "MATCH (n:Person {name:'marko'}) REMOVE n.nick");
    assert!(
        !g.props.is_present(marko, "nick"),
        "REMOVE deletes the property outright"
    );
}

#[test]
fn delete_isolated_vertex() {
    let mut g = modern();
    // ripple has only an incoming CREATED edge, so plain DELETE needs DETACH;
    // delete an edge first, then a now-isolated vertex.
    rows(
        &mut g,
        "MATCH (:Person {name:'josh'})-[r:CREATED]->(:Software {name:'ripple'}) DELETE r",
    );
    rows(&mut g, "MATCH (n:Software {name:'ripple'}) DELETE n");
    assert_eq!(
        rows(&mut g, "MATCH (s:Software) RETURN count(*) AS c"),
        vec![vec![n(1.0)]]
    );
}

#[test]
fn detach_delete_cascades_edges() {
    let mut g = modern();
    rows(&mut g, "MATCH (n:Person {name:'marko'}) DETACH DELETE n");
    // marko and all his edges are gone; remaining people = 3.
    assert_eq!(
        rows(&mut g, "MATCH (p:Person) RETURN count(*) AS c"),
        vec![vec![n(3.0)]]
    );
    // lop now has 2 creators (josh, peter) instead of 3.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (:Person)-[:CREATED]->(s:Software {name:'lop'}) RETURN count(*) AS c"
        ),
        vec![vec![n(2.0)]]
    );
}

#[test]
fn scalar_functions_graph_string_list_conversion() {
    let mut g = modern();
    // graph functions (label/key order is sorted for determinism)
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:Person {name:'marko'}) RETURN labels(n) AS l"
        ),
        vec![vec![Value::List(vec![s("Person")])]]
    );
    assert_eq!(
        rows(&mut g, "MATCH ()-[r:KNOWS]->() RETURN type(r) AS t LIMIT 1"),
        vec![vec![s("KNOWS")]]
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:Person {name:'marko'}) RETURN keys(n) AS k"
        ),
        vec![vec![Value::List(vec![s("age"), s("name")])]]
    );
    // conversion
    assert_eq!(
        rows(&mut g, "RETURN to_integer('42') AS x"),
        vec![vec![n(42.0)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN to_float('3.5') AS x"),
        vec![vec![n(3.5)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN to_string(42) AS x"),
        vec![vec![s("42")]]
    );
    // string / list — substring is 1-based (SQL / ISO GQL): positions 1..3.
    assert_eq!(
        rows(&mut g, "RETURN substring('hello', 1, 3) AS x"),
        vec![vec![s("hel")]]
    );
    assert_eq!(
        rows(&mut g, "RETURN substring('hello', 4) AS x"),
        vec![vec![s("lo")]]
    );
    assert_eq!(
        rows(&mut g, "RETURN substring('hello', 0, 3) AS x"),
        vec![vec![s("he")]]
    );
    assert_eq!(
        rows(&mut g, "RETURN split('a,b,c', ',') AS x"),
        vec![vec![Value::List(vec![s("a"), s("b"), s("c")])]]
    );
    assert_eq!(
        rows(&mut g, "RETURN replace('a.b.c', '.', '-') AS x"),
        vec![vec![s("a-b-c")]]
    );
    assert_eq!(
        rows(&mut g, "RETURN head([1, 2, 3]) AS x"),
        vec![vec![n(1.0)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN last([1, 2, 3]) AS x"),
        vec![vec![n(3.0)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN reverse('abc') AS x"),
        vec![vec![s("cba")]]
    );
}

#[test]
fn math_round_sign_pi_e() {
    let mut g = modern();
    // round: half away from zero, optional digits (negative rounds to tens).
    assert_eq!(rows(&mut g, "RETURN round(2.5) AS x"), vec![vec![n(3.0)]]);
    assert_eq!(rows(&mut g, "RETURN round(-2.5) AS x"), vec![vec![n(-3.0)]]);
    assert_eq!(
        rows(&mut g, "RETURN round(1.2345, 2) AS x"),
        vec![vec![n(1.23)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN round(1234.5678, -2) AS x"),
        vec![vec![n(1200.0)]]
    );
    // sign: -1 | 0 | 1.
    assert_eq!(rows(&mut g, "RETURN sign(-3.7) AS x"), vec![vec![n(-1.0)]]);
    assert_eq!(rows(&mut g, "RETURN sign(0) AS x"), vec![vec![n(0.0)]]);
    assert_eq!(rows(&mut g, "RETURN sign(5) AS x"), vec![vec![n(1.0)]]);
    // 0-arg constants.
    assert_eq!(
        rows(&mut g, "RETURN pi() AS x"),
        vec![vec![n(std::f64::consts::PI)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN e() AS x"),
        vec![vec![n(std::f64::consts::E)]]
    );
    // null in → null out.
    assert_eq!(
        rows(&mut g, "RETURN round(null) AS x"),
        vec![vec![Value::Null]]
    );
}

#[test]
fn order_by_and_minmax_total_order_across_types() {
    let lines = [
        r#"{"type":"node","id":"1","labels":["X"],"properties":{"v":2}}"#,
        r#"{"type":"node","id":"2","labels":["X"],"properties":{"v":"a"}}"#,
        r#"{"type":"node","id":"3","labels":["X"],"properties":{"v":1}}"#,
        r#"{"type":"node","id":"4","labels":["X"],"properties":{"v":true}}"#,
        r#"{"type":"node","id":"5","labels":["X"],"properties":{"v":"b"}}"#,
    ];
    let mut g = ndjson::decode(&lines.join("\n")).unwrap();
    let col = |g: &mut Graph, q: &str| -> Vec<Value> {
        rows(g, q).into_iter().map(|r| r[0].clone()).collect()
    };
    // Total order across type groups: number < string < boolean.
    assert_eq!(
        col(&mut g, "MATCH (n:X) RETURN n.v AS v ORDER BY n.v"),
        vec![n(1.0), n(2.0), s("a"), s("b"), b(true)]
    );
    assert_eq!(
        col(&mut g, "MATCH (n:X) RETURN n.v AS v ORDER BY n.v DESC"),
        vec![b(true), s("b"), s("a"), n(2.0), n(1.0)]
    );
    // min / max use the same total order.
    assert_eq!(
        rows(&mut g, "MATCH (n:X) RETURN min(n.v) AS m"),
        vec![vec![n(1.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (n:X) RETURN max(n.v) AS m"),
        vec![vec![b(true)]]
    );
}

#[test]
fn set_style_list_functions() {
    let mut g = modern();
    let list = |xs: Vec<Value>| vec![vec![Value::List(xs)]];
    assert_eq!(
        rows(&mut g, "RETURN list_union([1,2,2,3], [3,4,5]) AS x"),
        list(vec![n(1.0), n(2.0), n(3.0), n(4.0), n(5.0)])
    );
    assert_eq!(
        rows(&mut g, "RETURN intersection([1,2,3,3], [3,3,4,5]) AS x"),
        list(vec![n(3.0)])
    );
    assert_eq!(
        rows(&mut g, "RETURN difference([1,2,2,3], [3,4,5]) AS x"),
        list(vec![n(1.0), n(2.0)])
    );
    // ISO GQL: list_contains returns numeric 1 / 0.
    assert_eq!(
        rows(&mut g, "RETURN list_contains([1,2,3], 2) AS x"),
        vec![vec![n(1.0)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN list_contains([1,2,3], 9) AS x"),
        vec![vec![n(0.0)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN list_sort([3,1,4,1,5]) AS x"),
        list(vec![n(1.0), n(1.0), n(3.0), n(4.0), n(5.0)])
    );
    assert_eq!(
        rows(&mut g, "RETURN list_sort([3,1,2], 'desc') AS x"),
        list(vec![n(3.0), n(2.0), n(1.0)])
    );
    assert_eq!(
        rows(&mut g, "RETURN list_sort([3,1,null,2]) AS x"),
        list(vec![n(1.0), n(2.0), n(3.0), Value::Null])
    );
    assert_eq!(
        rows(
            &mut g,
            "RETURN list_sort([3,1,null,2], 'asc', 'first') AS x"
        ),
        list(vec![Value::Null, n(1.0), n(2.0), n(3.0)])
    );
}

#[test]
fn infix_string_match_predicates() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN 'Hello World' CONTAINS 'World' AS x"),
        vec![vec![Value::Bool(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN 'Hello World' STARTS WITH 'Hello' AS x"),
        vec![vec![Value::Bool(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN 'Hello World' ENDS WITH 'World' AS x"),
        vec![vec![Value::Bool(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN 'abc' CONTAINS 'z' AS x"),
        vec![vec![Value::Bool(false)]]
    );
    // as a WHERE filter
    assert_eq!(
        rows(
            &mut g,
            "MATCH (p:Person) WHERE p.name STARTS WITH 'ma' RETURN p.name AS x"
        ),
        vec![vec![s("marko")]]
    );
}

#[test]
fn cast_desugars_to_conversion_functions() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN CAST('42' AS INTEGER) AS x"),
        vec![vec![n(42.0)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN CAST(3.7 AS INT) AS x"),
        vec![vec![n(3.0)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN CAST('3.5' AS FLOAT) AS x"),
        vec![vec![n(3.5)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN CAST(42 AS STRING) AS x"),
        vec![vec![s("42")]]
    );
    assert_eq!(
        rows(&mut g, "RETURN CAST('yes' AS BOOL) AS x"),
        vec![vec![Value::Bool(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN CAST('ab' AS LIST) AS x"),
        vec![vec![Value::List(vec![s("a"), s("b")])]]
    );
    assert_eq!(
        rows(&mut g, "RETURN CAST('nope' AS INT) AS x"),
        vec![vec![Value::Null]]
    );
}

#[test]
fn cast_to_unrepresentable_type_is_a_syntax_error() {
    assert!(parse("RETURN CAST(1 AS DATE) AS x").is_err());
    assert!(parse("RETURN CAST(1 AS BYTES) AS x").is_err());
}

#[test]
fn unknown_function_errors_instead_of_silent_null() {
    let mut g = modern();
    let err = parse("RETURN nope_fn(1) AS x")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::UnknownFunction);
    // The message NAMES the offending function (parity with the TS engine).
    assert!(
        err.message.contains("nope_fn()"),
        "message should name the function, got: {}",
        err.message
    );
}

#[test]
fn unbound_param_errors_instead_of_silent_null() {
    let mut g = modern();
    // `$missing` is referenced but not supplied — a programming error, not a
    // silent empty result.
    let err = parse("MATCH (n) WHERE n.name = $missing RETURN n")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::MissingParameter);
}

#[test]
fn string_length_counts_utf16_units_like_js() {
    // Non-BMP chars are 2 UTF-16 units — matching JS `.length` (the TS engine),
    // not Unicode code points (which Rust's `chars().count()` gave before).
    let mut g = modern();
    assert_eq!(rows(&mut g, "RETURN size('😀') AS s"), vec![vec![n(2.0)]]);
    assert_eq!(
        rows(&mut g, "RETURN char_length('a😀b') AS s"),
        vec![vec![n(4.0)]]
    );
    // left/right slice on the same UTF-16 unit as JS `String.slice`.
    assert_eq!(
        rows(&mut g, "RETURN left('😀x', 2) AS s"),
        vec![vec![s("😀")]]
    );
    assert_eq!(
        rows(&mut g, "RETURN right('x😀', 2) AS s"),
        vec![vec![s("😀")]]
    );
}

#[test]
fn insert_rejects_ambiguous_label_and_typeless_edge() {
    // A non-conjunction node label (`|`/`!`/`%`) can't be created (which one?),
    // and an edge must carry exactly one type — both were silently accepted
    // (unlabelled node / empty-type edge) before.
    for q in [
        "INSERT (a:Foo|Bar)",
        "INSERT (a:!Foo)",
        "INSERT (a)-[r]->(b)",    // typeless edge
        "INSERT (a)-[:A|B]->(b)", // disjunction edge type
    ] {
        let mut g = modern();
        let err = parse(q)
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap_err();
        assert_eq!(
            err.code,
            crate::error_codes::ErrorCode::InvalidGraphOp,
            "should reject: {q}"
        );
    }
    // Sanity: conjunction, an unlabelled node, and a single-type edge all succeed.
    let mut g = modern();
    rows(&mut g, "INSERT (a:Foo&Bar)");
    rows(&mut g, "INSERT (a)"); // an unlabelled node is legitimate in GQL
    rows(&mut g, "INSERT (a:X)-[:REL]->(b:Y)");
}

#[test]
fn unique_constraint_enforced_on_insert_and_set() {
    // A UNIQUE constraint on (Acct, email): at most one live Acct per email. A
    // plain INSERT/SET that would duplicate faults with ConstraintViolation
    // (_MERGE, a later slice, reconciles instead). docs/design/gql-extensions.md §3.
    let mut g = modern(); // has no Acct/Other labels — a clean namespace.
    g.create_unique_constraint("Acct", "email").unwrap();

    rows(&mut g, "INSERT (:Acct {email: 'a@x.io', name: 'A'})");

    // Duplicate email under the same label → violation (no partial write: the
    // check precedes add_vertex).
    let err = parse("INSERT (:Acct {email: 'a@x.io', name: 'B'})")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::ConstraintViolation);

    // A different email is fine; a different label with the same email is fine
    // (the constraint is per-label).
    rows(&mut g, "INSERT (:Acct {email: 'b@x.io', name: 'B'})");
    rows(&mut g, "INSERT (:Other {email: 'a@x.io'})");

    // A SET that collides with an existing Acct email → violation …
    let err = parse("MATCH (n:Acct {email: 'b@x.io'}) SET n.email = 'a@x.io'")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::ConstraintViolation);
    // … but setting a row to its OWN current value is not a self-collision.
    rows(
        &mut g,
        "MATCH (n:Acct {email: 'b@x.io'}) SET n.email = 'b@x.io'",
    );
}

#[test]
fn unique_constraint_null_values_are_exempt() {
    // SQL semantics: NULLs are distinct, so multiple null-emails don't collide
    // (lenke stores null first-class, but uniqueness still exempts it — matching
    // the value index, which never buckets null). An absent value is likewise ok.
    let mut g = modern();
    g.create_unique_constraint("Acct", "email").unwrap();
    rows(&mut g, "INSERT (:Acct {email: null, name: 'A'})");
    rows(&mut g, "INSERT (:Acct {email: null, name: 'B'})");
    rows(&mut g, "INSERT (:Acct {name: 'C'})");
}

#[test]
fn create_unique_constraint_rejects_preexisting_duplicates() {
    // Declaring a constraint the current data already violates is meaningless —
    // SQL rejects the unique-index build the same way.
    let mut g = ndjson::decode(
        &[
            r#"{"type":"node","id":"1","labels":["Acct"],"properties":{"email":"dup@x.io"}}"#,
            r#"{"type":"node","id":"2","labels":["Acct"],"properties":{"email":"dup@x.io"}}"#,
        ]
        .join("\n"),
    )
    .unwrap();
    let err = g.create_unique_constraint("Acct", "email").unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::ConstraintViolation);
}

#[test]
fn unique_constraint_introspection_and_drop() {
    let mut g = modern();
    g.create_unique_constraint("Acct", "email").unwrap();
    g.create_unique_constraint("Acct", "handle").unwrap();
    assert!(g.has_unique_constraint("Acct", "email"));
    assert_eq!(
        g.unique_keys("Acct"),
        &["email".to_string(), "handle".to_string()]
    );
    assert_eq!(
        g.unique_constraints(),
        vec![
            ("Acct".to_string(), "email".to_string()),
            ("Acct".to_string(), "handle".to_string()),
        ]
    );
    g.drop_unique_constraint("Acct", "email");
    assert!(!g.has_unique_constraint("Acct", "email"));
    assert!(g.has_unique_constraint("Acct", "handle"));
}

// `_MERGE` keyed upsert (node form). Mirrors the TS `merge.test.ts` so the two
// engines stay byte-identical. See docs/design/gql-extensions.md §2.

#[test]
fn merge_create_path_runs_on_create() {
    let mut g = modern();
    g.create_unique_constraint("Acct", "email").unwrap();
    rows(
        &mut g,
        "_MERGE (u:Acct {email: 'a@x.io', name: 'A'}) _ON_CREATE SET u.created = 1",
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (u:Acct {email: 'a@x.io'}) RETURN u.name, u.created"
        ),
        vec![vec![s("A"), n(1.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (u:Acct) RETURN count(*) AS c"),
        vec![vec![n(1.0)]]
    );
}

#[test]
fn merge_update_default_clobbers_payload_keeps_one_node() {
    let mut g = modern();
    g.create_unique_constraint("Acct", "email").unwrap();
    rows(
        &mut g,
        "_MERGE (u:Acct {email: 'a@x.io', name: 'A'}) _ON_CREATE SET u.created = 1",
    );
    // Present → clobber payload (name); created stays (birth-only); one node.
    rows(&mut g, "_MERGE (u:Acct {email: 'a@x.io', name: 'A2'})");
    assert_eq!(
        rows(
            &mut g,
            "MATCH (u:Acct {email: 'a@x.io'}) RETURN u.name, u.created"
        ),
        vec![vec![s("A2"), n(1.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (u:Acct) RETURN count(*) AS c"),
        vec![vec![n(1.0)]]
    );
}

#[test]
fn merge_on_update_set_replaces_default_clobber() {
    let mut g = modern();
    g.create_unique_constraint("Acct", "email").unwrap();
    rows(&mut g, "_MERGE (u:Acct {email: 'a@x.io', name: 'A'})");
    // Pattern payload 'IGNORED' is NOT written — _ON_UPDATE replaces the default.
    rows(
        &mut g,
        "_MERGE (u:Acct {email: 'a@x.io', name: 'IGNORED'}) _ON_UPDATE SET u.name = 'FromUpdate'",
    );
    assert_eq!(
        rows(&mut g, "MATCH (u:Acct {email: 'a@x.io'}) RETURN u.name"),
        vec![vec![s("FromUpdate")]]
    );
}

#[test]
fn merge_on_update_nothing_leaves_untouched() {
    let mut g = modern();
    g.create_unique_constraint("Acct", "email").unwrap();
    rows(&mut g, "_MERGE (u:Acct {email: 'a@x.io', name: 'A'})");
    rows(
        &mut g,
        "_MERGE (u:Acct {email: 'a@x.io', name: 'IGNORED'}) _ON_UPDATE_NOTHING",
    );
    assert_eq!(
        rows(&mut g, "MATCH (u:Acct {email: 'a@x.io'}) RETURN u.name"),
        vec![vec![s("A")]]
    );
}

#[test]
fn merge_where_gated_update_is_last_write_wins() {
    let mut g = modern();
    g.create_unique_constraint("Doc", "id").unwrap();
    rows(&mut g, "_MERGE (d:Doc {id: 1, v: 1, body: 'first'})");
    // Incoming v (5) newer than stored (1) → applies.
    rows(
        &mut g,
        "_MERGE (d:Doc {id: 1}) _ON_UPDATE SET d.v = 5, d.body = 'newer' WHERE d.v < 5",
    );
    assert_eq!(
        rows(&mut g, "MATCH (d:Doc {id: 1}) RETURN d.v, d.body"),
        vec![vec![n(5.0), s("newer")]]
    );
    // Stored (5) not < 3 → predicate false → no-op.
    rows(
        &mut g,
        "_MERGE (d:Doc {id: 1}) _ON_UPDATE SET d.v = 3, d.body = 'older' WHERE d.v < 3",
    );
    assert_eq!(
        rows(&mut g, "MATCH (d:Doc {id: 1}) RETURN d.v, d.body"),
        vec![vec![n(5.0), s("newer")]]
    );
}

#[test]
fn merge_presence_idiom_clobbers() {
    let mut g = modern();
    g.create_unique_constraint("Presence", "sid").unwrap();
    rows(&mut g, "_MERGE (p:Presence {sid: 's1', x: 0, y: 0})");
    rows(&mut g, "_MERGE (p:Presence {sid: 's1', x: 10, y: 20})");
    assert_eq!(
        rows(&mut g, "MATCH (p:Presence) RETURN p.x, p.y"),
        vec![vec![n(10.0), n(20.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (p:Presence) RETURN count(*) AS c"),
        vec![vec![n(1.0)]]
    );
}

#[test]
fn merge_without_constraint_errors() {
    let mut g = modern();
    let err = parse("_MERGE (x:Nope {k: 1})")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::InvalidGraphOp);
}

#[test]
fn merge_conflicting_dispositions_is_parse_error() {
    assert!(
        parse("_MERGE (u:Acct {email: 'a'}) _ON_UPDATE SET u.n = 1 _ON_UPDATE_NOTHING").is_err()
    );
}

#[test]
fn merge_gated_off_under_iso_strict() {
    use super::ast::Dialect;
    use super::parser::parse_with_dialect;
    // Under iso-strict, `_MERGE` is a plain identifier → no clause → syntax error.
    assert!(parse_with_dialect("_MERGE (u:Acct {email: 'a'})", Dialect::IsoStrict).is_err());
    // …but it parses fine under the default (lenke) dialect.
    assert!(parse_with_dialect("_MERGE (u:Acct {email: 'a'})", Dialect::Lenke).is_ok());
}

#[test]
fn merge_edge_form_upserts_edge_between_matched_endpoints() {
    let mut g = modern();
    g.create_unique_constraint("User", "id").unwrap();
    g.create_unique_constraint("Team", "id").unwrap();
    rows(&mut g, "INSERT (:User {id: 'u1'}), (:Team {id: 'g1'})");

    // ensure-tuple: endpoints matched by key, the MEMBER edge is upserted.
    rows(
        &mut g,
        "_MERGE (u:User {id: 'u1'})-[m:MEMBER {since: 1}]->(g:Team {id: 'g1'}) _ON_CREATE SET m.role = 'admin'",
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (:User {id:'u1'})-[m:MEMBER]->(:Team {id:'g1'}) RETURN m.since, m.role"
        ),
        vec![vec![n(1.0), s("admin")]]
    );

    // Idempotent: second _MERGE clobbers edge props (default), no duplicate edge;
    // _ON_CREATE does not re-run, so role stays.
    rows(
        &mut g,
        "_MERGE (u:User {id: 'u1'})-[m:MEMBER {since: 2}]->(g:Team {id: 'g1'})",
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (:User {id:'u1'})-[m:MEMBER]->(:Team {id:'g1'}) RETURN m.since, m.role"
        ),
        vec![vec![n(2.0), s("admin")]]
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (:User)-[m:MEMBER]->(:Team) RETURN count(*) AS c"
        ),
        vec![vec![n(1.0)]]
    );

    // _ON_UPDATE_NOTHING leaves the edge untouched.
    rows(
        &mut g,
        "_MERGE (u:User {id: 'u1'})-[m:MEMBER {since: 99}]->(g:Team {id: 'g1'}) _ON_UPDATE_NOTHING",
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (:User {id:'u1'})-[m:MEMBER]->(:Team {id:'g1'}) RETURN m.since"
        ),
        vec![vec![n(2.0)]]
    );
}

#[test]
fn merge_edge_missing_endpoint_errors() {
    let mut g = modern();
    g.create_unique_constraint("User", "id").unwrap();
    g.create_unique_constraint("Team", "id").unwrap();
    rows(&mut g, "INSERT (:User {id: 'u1'})"); // no Team t1

    let err = parse("_MERGE (u:User {id:'u1'})-[m:MEMBER]->(g:Team {id:'g1'})")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::InvalidGraphOp);
}

#[test]
fn iso_strict_parses_iso_surface_rejects_extensions() {
    use super::ast::Dialect;
    use super::parser::parse_with_dialect;
    // The whole ISO surface parses under iso-strict (self-contained; no extension
    // leaked in).
    for q in [
        "MATCH (a:Person)-[:KNOWS]->(b) WHERE a.age > 30 RETURN b.name",
        "INSERT (:Person {name: 'x', age: 1})",
        "MATCH (n:Person) SET n.age = 2",
        "MATCH (n:Person) REMOVE n.age",
        "MATCH (n:Person) DETACH DELETE n",
        "MATCH (n) RETURN count(*) AS c ORDER BY c DESC LIMIT 5",
    ] {
        assert!(
            parse_with_dialect(q, Dialect::IsoStrict).is_ok(),
            "should parse: {q}"
        );
    }
    // Every extension construct is a syntax error under iso-strict.
    for ext in [
        "_MERGE (u:Acct {email: 'a'})",
        "_MERGE (u:Acct {email: 'a'}) _ON_CREATE SET u.x = 1",
    ] {
        assert!(
            parse_with_dialect(ext, Dialect::IsoStrict).is_err(),
            "should reject: {ext}"
        );
    }
}

#[test]
fn delete_vertex_with_edges_errors_without_detach() {
    let mut g = modern();
    let err = parse("MATCH (n:Person {name:'marko'}) DELETE n")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    // The code is the contract; the message is just the human hint.
    assert_eq!(err.code, crate::error_codes::ErrorCode::InvalidGraphOp);
    assert!(err.message.contains("DETACH"), "got: {err}");
}

#[test]
fn missing_label_empty_with_columns() {
    let mut g = modern();
    let (cols, r) = q(&mut g, "MATCH (n:Ghost) RETURN n.name AS who");
    assert_eq!(cols, vec!["who"]);
    assert!(r.is_empty());
}

// --- property-index seeding (indexed result must equal the scan result) ---

#[test]
fn index_eq_inline_matches_scan() {
    let scan = {
        let mut g = modern();
        rows(&mut g, "MATCH (n:Person {name:'marko'}) RETURN n.age")
    };
    let idx = {
        let mut g = modern();
        g.create_vertex_index("name");
        rows(&mut g, "MATCH (n:Person {name:'marko'}) RETURN n.age")
    };
    assert_eq!(scan, idx);
    assert_eq!(idx, vec![vec![n(29.0)]]);
}

#[test]
fn index_where_eq_matches_scan() {
    let mut g = modern();
    g.create_vertex_index("name");
    assert_eq!(
        rows(&mut g, "MATCH (n) WHERE n.name = 'marko' RETURN n.age"),
        vec![vec![n(29.0)]]
    );
}

#[test]
fn index_where_range_matches_scan() {
    let mut g = modern();
    g.create_vertex_index("age");
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:Person) WHERE n.age > 30 RETURN n.name ORDER BY n.name"
        ),
        vec![vec![s("josh")], vec![s("peter")]]
    );
}

#[test]
fn index_where_and_range_matches_scan() {
    let mut g = modern();
    g.create_vertex_index("age");
    // AND of two comparisons on the indexed key — first conjunct seeds, WHERE re-filters.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:Person) WHERE n.age > 28 AND n.age < 33 RETURN n.name ORDER BY n.name"
        ),
        vec![vec![s("josh")], vec![s("marko")]]
    );
}

#[test]
fn index_range_does_not_bleed_into_software() {
    let mut g = modern();
    g.create_vertex_index("age");
    // age > 0 must not surface software (no age) — type-block bounded seed.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n) WHERE n.age > 0 RETURN n.name ORDER BY n.name"
        )
        .len(),
        4
    );
}

#[test]
fn index_live_under_gql_insert() {
    let mut g = modern();
    g.create_vertex_index("name");
    rows(&mut g, "INSERT (z:Person {name:'zoe', age:50})");
    // The new vertex is found via the (maintained) index seed.
    assert_eq!(
        rows(&mut g, "MATCH (n) WHERE n.name = 'zoe' RETURN n.age"),
        vec![vec![n(50.0)]]
    );
}

#[test]
fn index_live_under_gql_set() {
    let mut g = modern();
    g.create_vertex_index("name");
    rows(
        &mut g,
        "MATCH (n:Person) WHERE n.name = 'marko' SET n.name = 'mark'",
    );
    assert!(rows(&mut g, "MATCH (n) WHERE n.name = 'marko' RETURN n.name").is_empty());
    assert_eq!(
        rows(&mut g, "MATCH (n) WHERE n.name = 'mark' RETURN n.age"),
        vec![vec![n(29.0)]]
    );
}

// --- edge property index seeding (edge-first single-segment build) ---

#[test]
fn edge_index_where_eq() {
    let scan = {
        let mut g = modern();
        rows(
            &mut g,
            "MATCH (a)-[r:CREATED]->(s) WHERE r.weight = 1.0 RETURN s.name",
        )
    };
    let idx = {
        let mut g = modern();
        g.create_edge_index("weight");
        rows(
            &mut g,
            "MATCH (a)-[r:CREATED]->(s) WHERE r.weight = 1.0 RETURN s.name",
        )
    };
    assert_eq!(scan, idx);
    assert_eq!(idx, vec![vec![s("ripple")]]); // josh -created(1.0)-> ripple
}

#[test]
fn edge_index_inline_prop() {
    let mut g = modern();
    g.create_edge_index("weight");
    // inline edge prop drives the seek; label CREATED narrows the weight-1.0 edges.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a)-[r:CREATED {weight:1.0}]->(s) RETURN s.name"
        ),
        vec![vec![s("ripple")]]
    );
}

#[test]
fn edge_index_range() {
    let mut g = modern();
    g.create_edge_index("weight");
    // CREATED weights {0.4,1.0,0.4,0.2}; >= 0.5 ⇒ only ripple's edge.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a)-[r:CREATED]->(s) WHERE r.weight >= 0.5 RETURN s.name ORDER BY s.name"
        ),
        vec![vec![s("ripple")]]
    );
}

#[test]
fn edge_index_knows_eq() {
    let mut g = modern();
    g.create_edge_index("weight");
    // KNOWS weight 1.0 ⇒ marko -knows-> josh.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a)-[r:KNOWS]->(b) WHERE r.weight = 1.0 RETURN b.name"
        ),
        vec![vec![s("josh")]]
    );
}

#[test]
fn edge_index_live_under_set() {
    let mut g = modern();
    g.create_edge_index("weight");
    // bump every CREATED edge to weight 2.0, then seek 2.0.
    rows(&mut g, "MATCH ()-[r:CREATED]->() SET r.weight = 2.0");
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a)-[r:CREATED]->(s) WHERE r.weight = 2.0 RETURN s.name ORDER BY s.name"
        ),
        vec![
            vec![s("lop")],
            vec![s("lop")],
            vec![s("lop")],
            vec![s("ripple")]
        ]
    );
    // and 1.0 now finds nothing among CREATED (josh->ripple moved to 2.0).
    assert!(rows(
        &mut g,
        "MATCH (a)-[r:CREATED]->(s) WHERE r.weight = 1.0 RETURN s.name"
    )
    .is_empty());
}

// --- edge TYPE index seeding (always-on `by_etype`; `()-[:T]->()` patterns) ---

#[test]
fn edge_type_seed_single() {
    // marko -knows-> vadas, marko -knows-> josh. The type bucket seeds these two
    // edges directly instead of expanding every vertex's adjacency.
    let mut g = modern();
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a)-[r:KNOWS]->(b) RETURN b.name ORDER BY b.name"
        ),
        vec![vec![s("josh")], vec![s("vadas")]],
    );
}

#[test]
fn edge_type_seed_disjunction() {
    // `:KNOWS|CREATED` unions two type buckets (disjoint — an edge has one type).
    // KNOWS: 2 edges, CREATED: 4 edges ⇒ 6 rows.
    let mut g = modern();
    let r = rows(
        &mut g,
        "MATCH (a)-[r:KNOWS|CREATED]->(b) RETURN count(*) AS c",
    );
    assert_eq!(r, vec![vec![n(6.0)]]);
}

#[test]
fn edge_type_seed_absent_is_empty() {
    // A type that was never interned seeds an empty candidate set (no scan).
    let mut g = modern();
    assert!(rows(&mut g, "MATCH (a)-[r:NONEXISTENT]->(b) RETURN b.name").is_empty());
}

#[test]
fn edge_type_seed_with_endpoint_filter() {
    // Type seed is a superset; edge_first_build re-validates the endpoint WHERE.
    // Of marko's two KNOWS targets, only josh is 32.
    let mut g = modern();
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a)-[r:KNOWS]->(b) WHERE b.age = 32 RETURN b.name"
        ),
        vec![vec![s("josh")]],
    );
}

#[test]
fn edge_type_seed_live_under_insert() {
    // A KNOWS edge created at runtime must land in the type bucket and be found.
    let mut g = modern();
    rows(&mut g, "MATCH (a:Person), (b:Person) WHERE a.name = 'peter' AND b.name = 'vadas' INSERT (a)-[:KNOWS]->(b)");
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a)-[r:KNOWS]->(b) RETURN a.name ORDER BY a.name"
        ),
        vec![vec![s("marko")], vec![s("marko")], vec![s("peter")]],
    );
}

#[test]
fn edge_type_seed_live_under_delete() {
    // Deleting an edge must purge it from the type bucket, so the seed shrinks.
    let mut g = modern();
    rows(
        &mut g,
        "MATCH (a)-[r:KNOWS]->(b) WHERE b.name = 'vadas' DELETE r",
    );
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a)-[r:KNOWS]->(b) RETURN b.name ORDER BY b.name"
        ),
        vec![vec![s("josh")]],
    );
}

// --- reactive change tracking (version + per-token epochs) ---

#[test]
fn reactive_version_and_epoch() {
    let mut g = modern();
    let v0 = g.version();
    let person0 = g.epoch("Person");
    let age0 = g.epoch("age");
    let name0 = g.epoch("name");

    // A read does not bump anything.
    rows(&mut g, "MATCH (n:Person) RETURN n.name");
    assert_eq!(g.version(), v0);
    assert_eq!(g.epoch("Person"), person0);

    // Inserting a Person bumps the global version and the touched tokens.
    rows(&mut g, "INSERT (:Person {name: 'zoe', age: 99})");
    assert!(g.version() > v0);
    assert!(g.epoch("Person") > person0);
    assert!(g.epoch("age") > age0);
    assert!(g.epoch("name") > name0);

    // A property write bumps that key's epoch but NOT the label's (finer
    // invalidation: a label-only/topology query is not disturbed).
    let v1 = g.version();
    let person1 = g.epoch("Person");
    let age1 = g.epoch("age");
    let name1 = g.epoch("name");
    rows(
        &mut g,
        "MATCH (n:Person) WHERE n.name = 'marko' SET n.age = 30",
    );
    assert!(g.version() > v1);
    assert!(g.epoch("age") > age1);
    assert_eq!(g.epoch("Person"), person1); // label untouched by a value write
    assert_eq!(g.epoch("name"), name1); // unrelated key untouched
}

// --- hardening: parser/lexer robustness (ports of the TS hardening.test.ts) ---

#[test]
fn deep_nesting_errors_instead_of_stack_overflow() {
    // Each of these would overflow the native stack (an uncatchable abort)
    // without the recursion-depth guard; they must return a parse error.
    let parens = format!("RETURN {}1{} AS r", "(".repeat(5000), ")".repeat(5000));
    assert!(parse(&parens).is_err());

    let nots = format!("MATCH (n) WHERE {}n.x RETURN n", "NOT ".repeat(5000));
    assert!(parse(&nots).is_err());

    let bangs = format!("MATCH (n:{}A) RETURN n", "!".repeat(5000));
    assert!(parse(&bangs).is_err());

    let lists = format!("RETURN {}1{} AS r", "[".repeat(5000), "]".repeat(5000));
    assert!(parse(&lists).is_err());
}

#[test]
fn normally_nested_query_still_parses() {
    assert!(parse("RETURN (((1 + 2)) * 3) AS r").is_ok());
}

#[test]
fn malformed_numeric_literals_rejected() {
    for bad in [
        "0x", "0b", "0o", "0b2", "0o8", "0o9", "1e", "1e+", "0xG", "1e999",
    ] {
        assert!(
            parse(&format!("RETURN {bad} AS r")).is_err(),
            "expected a lex error for `{bad}`"
        );
    }
}

#[test]
fn oversized_integer_literal_rejected() {
    // Beyond 2^53 an integer literal loses precision as an f64.
    assert!(parse("RETURN 99999999999999999999 AS r").is_err());
}

#[test]
fn valid_numeric_literals_still_parse_and_eval() {
    let mut g = modern();
    assert_eq!(rows(&mut g, "RETURN 0xFF AS r"), vec![vec![n(255.0)]]);
    assert_eq!(rows(&mut g, "RETURN 0o17 AS r"), vec![vec![n(15.0)]]);
    assert_eq!(rows(&mut g, "RETURN 0b101 AS r"), vec![vec![n(5.0)]]);
    assert_eq!(rows(&mut g, "RETURN 1_000 AS r"), vec![vec![n(1000.0)]]);
    assert_eq!(rows(&mut g, "RETURN 1.5e2 AS r"), vec![vec![n(150.0)]]);
}

#[test]
fn skip_limit_reject_non_integers() {
    assert!(parse("MATCH (n) RETURN n LIMIT 2.5").is_err());
    assert!(parse("MATCH (n) RETURN n SKIP 1.5").is_err());
    assert!(parse("MATCH (n) RETURN n LIMIT 0.5").is_err());
}

#[test]
fn quantifier_rejects_fractional_and_reversed_bounds() {
    assert!(parse("MATCH (a)-[:R]->{1.5}(b) RETURN b").is_err());
    assert!(parse("MATCH (a)-[:R]->{3,2}(b) RETURN b").is_err());
}

#[test]
fn skip_limit_quantifier_valid_forms_still_parse() {
    assert!(parse("MATCH (n) RETURN n SKIP 1 LIMIT 2").is_ok());
    assert!(parse("MATCH (a)-[:R]->{1,3}(b) RETURN b").is_ok());
    assert!(parse("MATCH (a)-[:R]->{2}(b) RETURN b").is_ok());
}

#[test]
fn var_length_rejects_edge_variable_and_predicate() {
    // A quantified segment binds no single edge, so these can't be honored.
    assert!(parse("MATCH (a)-[r:KNOWS]->*(b) RETURN b").is_err());
    assert!(parse("MATCH (a)-[:KNOWS {weight:1}]->+(b) RETURN b").is_err());
    assert!(parse("MATCH (a)-[:KNOWS WHERE true]->+(b) RETURN b").is_err());
}

#[test]
fn var_length_label_only_still_parses() {
    assert!(parse("MATCH (a:Person {name:'marko'})-[:KNOWS]->+(b) RETURN b.name").is_ok());
}

#[test]
fn undirected_self_loop_counted_once() {
    let lines = [
        r#"{"type":"node","id":"n","labels":["N"],"properties":{"name":"n"}}"#,
        r#"{"type":"edge","from":"n","to":"n","labels":["LOOP"],"properties":{}}"#,
    ];
    let mut g = ndjson::decode(&lines.join("\n")).unwrap();
    // Before the fix an undirected walk yielded the self-loop twice (once from
    // the out-index, once from the in-index).
    assert_eq!(
        rows(&mut g, "MATCH (a)~[r]~(b) RETURN count(*) AS c"),
        vec![vec![n(1.0)]]
    );
    // Directed walks each see it exactly once.
    assert_eq!(
        rows(&mut g, "MATCH (a)-[r]->(b) RETURN count(*) AS c"),
        vec![vec![n(1.0)]]
    );
    assert_eq!(
        rows(&mut g, "MATCH (a)<-[r]-(b) RETURN count(*) AS c"),
        vec![vec![n(1.0)]]
    );
}

// --- ISO medium-conformance batch (mirrors TS hardening.test.ts) ------------

#[test]
fn ordering_across_incomparable_types_is_unknown() {
    let mut g = modern();
    // number vs string has no defined order → UNKNOWN (null), not a coerced bool.
    assert_eq!(
        rows(&mut g, "RETURN (1 < 'a') AS r"),
        vec![vec![Value::Null]]
    );
    assert_eq!(
        rows(&mut g, "RETURN ('a' >= 1) AS r"),
        vec![vec![Value::Null]]
    );
}

#[test]
fn equality_across_types_is_false_not_null() {
    let mut g = modern();
    assert_eq!(rows(&mut g, "RETURN (5 = '5') AS r"), vec![vec![b(false)]]);
    assert_eq!(rows(&mut g, "RETURN (5 <> '5') AS r"), vec![vec![b(true)]]);
}

#[test]
fn same_type_ordering_including_booleans_still_works() {
    let mut g = modern();
    assert_eq!(rows(&mut g, "RETURN (1 < 2) AS r"), vec![vec![b(true)]]);
    assert_eq!(rows(&mut g, "RETURN ('a' < 'b') AS r"), vec![vec![b(true)]]);
    assert_eq!(
        rows(&mut g, "RETURN (false >= false) AS r"),
        vec![vec![b(true)]]
    );
}

#[test]
fn nested_aggregates_rejected() {
    let mut g = modern();
    let err = parse("MATCH (n:Person) RETURN sum(avg(n.age))")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::Unsupported);
}

#[test]
fn plain_aggregate_still_works() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "MATCH (n:Person) RETURN sum(n.age) AS s"),
        vec![vec![n(123.0)]]
    );
}

#[test]
fn division_by_zero_raises_data_exception() {
    let mut g = modern();
    for q in ["RETURN 1 / 0 AS r", "RETURN 5 % 0 AS r"] {
        let err = parse(q)
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap_err();
        assert_eq!(
            err.code,
            crate::error_codes::ErrorCode::DataException,
            "{q}"
        );
    }
}

#[test]
fn division_by_zero_raises_over_rows_vectorized() {
    let mut g = modern();
    // MATCH … RETURN n.age / 0 takes the vectorized path; the divisor scan must
    // surface the data exception (via scalar fallback).
    let err = parse("MATCH (n:Person) RETURN n.age / 0 AS r")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::DataException);
}

#[test]
fn non_numeric_arithmetic_raises_data_exception() {
    let mut g = modern();
    for q in ["RETURN 'abc' + 1 AS r", "RETURN true * 2 AS r"] {
        let err = parse(q)
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap_err();
        assert_eq!(
            err.code,
            crate::error_codes::ErrorCode::DataException,
            "{q}"
        );
    }
}

#[test]
fn non_numeric_arithmetic_raises_in_vectorized_path() {
    let mut g = modern();
    // n.name is a string column → arithmetic over it falls back to scalar eval,
    // which raises the type error.
    let err = parse("MATCH (n:Person) RETURN n.name + 1 AS r")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::DataException);
}

#[test]
fn null_arithmetic_still_propagates_to_null() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN null + 1 AS r"),
        vec![vec![Value::Null]]
    );
    assert_eq!(
        rows(&mut g, "RETURN 1 / null AS r"),
        vec![vec![Value::Null]]
    );
}

// --- variable-length trail semantics ----------------------------------------

/// Build a graph from (id-label) nodes and (from,to) R-edges.
fn ring_graph() -> Graph {
    // a → b → c → a
    let lines = [
        r#"{"type":"node","id":"a","labels":["N"],"properties":{"name":"a"}}"#,
        r#"{"type":"node","id":"b","labels":["N"],"properties":{"name":"b"}}"#,
        r#"{"type":"node","id":"c","labels":["N"],"properties":{"name":"c"}}"#,
        r#"{"type":"edge","from":"a","to":"b","labels":["R"],"properties":{}}"#,
        r#"{"type":"edge","from":"b","to":"c","labels":["R"],"properties":{}}"#,
        r#"{"type":"edge","from":"c","to":"a","labels":["R"],"properties":{}}"#,
    ];
    ndjson::decode(&lines.join("\n")).unwrap()
}

#[test]
fn trail_excludes_repeated_relationship() {
    let mut g = modern();
    // From josh, undirected KNOWS reaches marko (1). The 2-hop step back to josh
    // would reuse the marko–josh edge, which a trail forbids — so josh is not
    // reached (Gremlin's walk semantics would include it).
    let r = rows(
        &mut g,
        "MATCH (a:Person {name:'josh'})-[:KNOWS]-{1,2}(b) RETURN b.name ORDER BY b.name",
    );
    assert_eq!(r, vec![vec![s("marko")], vec![s("vadas")]]);
}

#[test]
fn trail_cycle_terminates_one_row_per_trail() {
    let mut g = ring_graph();
    // From a the trails of ≥1 hop are a→b, a→b→c, a→b→c→a; the next step reuses
    // a→b, so it stops. Three trails.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a:N {name:'a'})-[:R]->+(x) RETURN count(*) AS c"
        ),
        vec![vec![n(3.0)]]
    );
}

#[test]
fn trail_endpoint_appears_once_per_trail() {
    let lines = [
        r#"{"type":"node","id":"a","labels":["N"],"properties":{"name":"a"}}"#,
        r#"{"type":"node","id":"b","labels":["N"],"properties":{"name":"b"}}"#,
        r#"{"type":"node","id":"c","labels":["N"],"properties":{"name":"c"}}"#,
        r#"{"type":"node","id":"d","labels":["N"],"properties":{"name":"d"}}"#,
        r#"{"type":"edge","from":"a","to":"b","labels":["R"],"properties":{}}"#,
        r#"{"type":"edge","from":"a","to":"c","labels":["R"],"properties":{}}"#,
        r#"{"type":"edge","from":"b","to":"d","labels":["R"],"properties":{}}"#,
        r#"{"type":"edge","from":"c","to":"d","labels":["R"],"properties":{}}"#,
    ];
    let mut g = ndjson::decode(&lines.join("\n")).unwrap();
    // d is reached by two distinct 2-hop trails: a→b→d and a→c→d.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (a:N {name:'a'})-[:R]->{2,2}(d) RETURN count(*) AS c"
        ),
        vec![vec![n(2.0)]]
    );
}

#[test]
fn trail_budget_guards_dense_unbounded_star() {
    let mut lines: Vec<String> = Vec::new();
    for i in 0..8 {
        lines.push(format!(
            r#"{{"type":"node","id":"{i}","labels":["N"],"properties":{{}}}}"#
        ));
    }
    for i in 0..8 {
        for j in 0..8 {
            if i != j {
                lines.push(format!(
                    r#"{{"type":"edge","from":"{i}","to":"{j}","labels":["R"],"properties":{{}}}}"#
                ));
            }
        }
    }
    let mut g = ndjson::decode(&lines.join("\n")).unwrap();
    let err = parse("MATCH (a)-[:R]->*(b) RETURN count(*) AS c")
        .unwrap()
        .execute(&mut g, &Params::new())
        .unwrap_err();
    assert_eq!(err.code, crate::error_codes::ErrorCode::ResourceExhausted);
}

#[test]
fn list_value_equality_is_structural() {
    // Lists compare by size then element-wise (ISO); the TS engine matches this
    // (it previously used reference identity — a byte-identical violation).
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN [1, 2] = [1, 2] AS x"),
        vec![vec![b(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN [1, 2] = [1, 3] AS x"),
        vec![vec![b(false)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN [1, 2] = [1, 2, 3] AS x"),
        vec![vec![b(false)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN [[1], [2]] = [[1], [2]] AS x"),
        vec![vec![b(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN [1, 2] <> [1, 3] AS x"),
        vec![vec![b(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN [1] IN [[1], [2]] AS x"),
        vec![vec![b(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN [3] IN [[1], [2]] AS x"),
        vec![vec![b(false)]]
    );
}

// --- FOR (ISO GQL list unwind / UNWIND) -------------------------------------

#[test]
fn for_unwinds_a_literal_list() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "FOR x IN [1, 2, 3] RETURN x"),
        vec![vec![n(1.0)], vec![n(2.0)], vec![n(3.0)]]
    );
}

#[test]
fn for_ordinality_counts_from_one() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "FOR x IN ['a', 'b'] WITH ORDINALITY i RETURN x, i"),
        vec![vec![s("a"), n(1.0)], vec![s("b"), n(2.0)]]
    );
}

#[test]
fn for_offset_counts_from_zero() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "FOR x IN ['a', 'b'] WITH OFFSET i RETURN x, i"),
        vec![vec![s("a"), n(0.0)], vec![s("b"), n(1.0)]]
    );
}

#[test]
fn for_over_null_yields_no_rows() {
    let mut g = modern();
    assert!(rows(&mut g, "FOR x IN null RETURN x").is_empty());
}

#[test]
fn for_over_empty_list_yields_no_rows() {
    let mut g = modern();
    assert!(rows(&mut g, "FOR x IN [] RETURN x").is_empty());
}

#[test]
fn for_over_scalar_unwinds_as_singleton() {
    let mut g = modern();
    assert_eq!(rows(&mut g, "FOR x IN 5 RETURN x"), vec![vec![n(5.0)]]);
}

#[test]
fn for_multiplies_prior_match_rows() {
    let mut g = modern();
    // One matched row × a two-element list → two rows.
    assert_eq!(
        rows(
            &mut g,
            "MATCH (p:Person {name: 'marko'}) FOR t IN ['x', 'y'] RETURN p.name, t"
        ),
        vec![vec![s("marko"), s("x")], vec![s("marko"), s("y")]]
    );
}

#[test]
fn for_list_can_reference_a_bound_var() {
    let mut g = modern();
    // The list expression sees the pending MATCH binding (`p`).
    assert_eq!(
        rows(
            &mut g,
            "MATCH (p:Person {name: 'marko'}) FOR x IN [p.name, p.age] RETURN x"
        ),
        vec![vec![s("marko")], vec![n(29.0)]]
    );
}

#[test]
fn for_bare_with_after_for_starts_a_new_clause() {
    // `WITH x AS y` is NOT a FOR modifier (no ORDINALITY/OFFSET) — it must be
    // parsed as a WITH clause, so the lookahead disambiguation matters.
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "FOR x IN [1, 2] WITH x AS y RETURN y"),
        vec![vec![n(1.0)], vec![n(2.0)]]
    );
}

#[test]
fn for_first_clause_needs_no_seed_row() {
    // FOR as the very first clause runs against the single empty seed binding.
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "FOR x IN ['only'] RETURN x"),
        vec![vec![s("only")]]
    );
}

#[test]
fn for_drives_batch_optional_match_allow_and_deny() {
    // R-BATCH deny-side: one row per requested name, present or not. `josh`
    // exists (age 32); `nobody` does not, so OPTIONAL MATCH leaves `p` null.
    let mut g = modern();
    assert_eq!(
        rows(
            &mut g,
            "FOR name IN ['josh', 'nobody'] OPTIONAL MATCH (p:Person {name: name}) RETURN name, p.age"
        ),
        vec![vec![s("josh"), n(32.0)], vec![s("nobody"), Value::Null]]
    );
}

// --- temporal literals + comparison (Phase 1) -------------------------------

fn tdate(s: &str) -> Value {
    Value::Temporal(crate::temporal::Temporal::parse("date", s).unwrap())
}

#[test]
fn temporal_date_literal_returns_value() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN DATE '2020-02-29' AS d"),
        vec![vec![tdate("2020-02-29")]]
    );
}

#[test]
fn temporal_literals_compare_chronologically() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN DATE '2020-01-01' < DATE '2020-06-01' AS x"),
        vec![vec![b(true)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN DATE '2020-06-01' < DATE '2020-01-01' AS x"),
        vec![vec![b(false)]]
    );
    assert_eq!(
        rows(&mut g, "RETURN DATE '2020-01-01' = DATE '2020-01-01' AS x"),
        vec![vec![b(true)]]
    );
    // TIMESTAMP is a DATETIME synonym; fractional seconds parse.
    assert_eq!(
        rows(
            &mut g,
            "RETURN TIMESTAMP '2021-06-15T08:30:00.5' >= DATETIME '2021-06-15T08:30:00' AS x"
        ),
        vec![vec![b(true)]]
    );
}

#[test]
fn temporal_cross_kind_comparison_is_unknown() {
    // date vs datetime relationally → UNKNOWN (null), like a cross-type compare.
    let mut g = modern();
    assert_eq!(
        rows(
            &mut g,
            "RETURN DATE '2020-01-01' < DATETIME '2020-01-01T00:00:00' AS x"
        ),
        vec![vec![Value::Null]]
    );
}

#[test]
fn temporal_as_of_where_filter() {
    // Valid-time modeling: keep the fact whose [vfrom, vto) contains the as-of date.
    let doc = concat!(
        r#"{"type":"node","id":"1","labels":["Fact"],"properties":{"name":"a","vfrom":{"@date":"2020-01-01"},"vto":{"@date":"2021-01-01"}}}"#,
        "\n",
        r#"{"type":"node","id":"2","labels":["Fact"],"properties":{"name":"b","vfrom":{"@date":"2021-01-01"},"vto":{"@date":"2022-01-01"}}}"#,
    );
    let mut g = crate::ndjson::decode(doc).unwrap();
    assert_eq!(
        rows(
            &mut g,
            "MATCH (f:Fact) WHERE f.vfrom <= DATE '2020-06-01' AND DATE '2020-06-01' < f.vto RETURN f.name"
        ),
        vec![vec![s("a")]]
    );
}

#[test]
fn temporal_order_by_sorts_chronologically() {
    let mut g = modern();
    assert_eq!(
        rows(
            &mut g,
            "FOR d IN [DATE '2020-06-01', DATE '2020-01-01', DATE '2020-03-01'] RETURN d ORDER BY d"
        ),
        vec![
            vec![tdate("2020-01-01")],
            vec![tdate("2020-03-01")],
            vec![tdate("2020-06-01")]
        ]
    );
}

#[test]
fn temporal_bad_literal_is_a_syntax_error() {
    assert!(parse("RETURN DATE '2020-99-99'").is_err());
}

// --- temporal constructor functions (Phase 2 slice 1) -----------------------

#[test]
fn temporal_constructors_parse_strings() {
    let mut g = modern();
    assert_eq!(
        rows(&mut g, "RETURN date('2020-02-29') AS d"),
        vec![vec![tdate("2020-02-29")]]
    );
    // local_datetime + duration return their kinds (checked via re-serialized form).
    let dt = rows(&mut g, "RETURN local_datetime('2021-06-15T08:30:00') AS d");
    assert_eq!(dt.len(), 1);
    let du = rows(&mut g, "RETURN duration('P1Y2M') AS d");
    assert_eq!(du.len(), 1);
    // A bad string is lenient → null (like to_integer).
    assert_eq!(
        rows(&mut g, "RETURN date('nope') AS d"),
        vec![vec![Value::Null]]
    );
}

#[test]
fn temporal_constructors_convert_between_kinds() {
    let mut g = modern();
    // date(datetime) truncates to the date part.
    assert_eq!(
        rows(
            &mut g,
            "RETURN date(local_datetime('2020-02-29T13:45:00')) AS d"
        ),
        vec![vec![tdate("2020-02-29")]]
    );
    // local_datetime(date) is midnight; comparing to the explicit midnight literal.
    assert_eq!(
        rows(
            &mut g,
            "RETURN local_datetime(date('2020-02-29')) = DATETIME '2020-02-29T00:00:00' AS x"
        ),
        vec![vec![b(true)]]
    );
    // duration(date) has no sensible conversion → null.
    assert_eq!(
        rows(&mut g, "RETURN duration(date('2020-01-01')) AS d"),
        vec![vec![Value::Null]]
    );
}

#[test]
fn temporal_constructor_converts_a_string_property() {
    // The point of the function form (vs the literal): convert loaded string data.
    let doc = r#"{"type":"node","id":"1","labels":["E"],"properties":{"hired":"2019-03-15"}}"#;
    let mut g = crate::ndjson::decode(doc).unwrap();
    assert_eq!(
        rows(
            &mut g,
            "MATCH (n:E) RETURN date(n.hired) < DATE '2020-01-01' AS x"
        ),
        vec![vec![b(true)]]
    );
}
