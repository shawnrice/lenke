//! In-engine graph algorithms — degree centrality, connected components, label
//! propagation, PageRank, and shortest path — run natively over `&Graph` in a
//! single call (no per-iteration FFI round-trip), so a whole PageRank/CC/label-prop
//! computation stays in the engine instead of looping in JS.
//!
//! Each algorithm is a pure function over the **public** `Graph` surface
//! (`vertex_indices`, `out_adj`/`in_adj`, `vid`, `set_vertex_prop`, …) so a user can
//! write their own the same way — the built-ins double as worked examples. The
//! [`run`] driver dispatches by name, optionally writes the per-vertex result back
//! to a vertex property, and returns a `RowSet` of `(node, <result>)`.
//!
//! Cross-engine determinism: results are computed in dense-vertex-id order (= NDJSON
//! insertion order, which the TS engine also iterates), summing a vertex's
//! neighbours in adjacency (edge insertion) order — no sorting — so the TS mirror in
//! `@lenke/core` is byte-identical, including PageRank's f64 arithmetic.

use crate::graph::{Graph, Value};
use crate::json;
use crate::query::RowSet;

mod components;
mod degree;

/// Parsed algorithm configuration (a superset; each algorithm reads the fields it
/// needs). Deserialized from the JSON object handed across the FFI boundary.
#[derive(Debug, Default, Clone)]
pub struct AlgoConfig {
    /// Restrict traversal to one edge type (`None` = every type).
    pub edge_label: Option<String>,
    /// `"out"` (default) / `"in"` / `"both"` — for degree.
    pub direction: Option<String>,
    /// Numeric edge property to weight by (PageRank / weighted shortest path).
    pub weight_property: Option<String>,
    /// PageRank damping factor (default 0.85).
    pub damping_factor: Option<f64>,
    /// Fixed iteration count (PageRank / label propagation).
    pub iterations: Option<u32>,
    /// Source vertex external id (shortest path).
    pub source: Option<String>,
    /// Target vertex external id (goal-directed shortest path).
    pub target: Option<String>,
    /// If set, write each vertex's result to this property before returning.
    pub write_property: Option<String>,
    /// Shortest-path backend: `"dijkstra"` (default) / `"astar"` / `"bmssp"`.
    pub algorithm: Option<String>,
    /// Admissible-heuristic vertex property for A\*.
    pub heuristic_property: Option<String>,
}

impl AlgoConfig {
    fn from_json(s: &str) -> Result<Self, ()> {
        if s.trim().is_empty() {
            return Ok(Self::default());
        }
        let j = json::parse(s)?;
        let string = |k: &str| j.get(k).and_then(json::Json::as_str).map(str::to_string);
        let num = |k: &str| j.get(k).and_then(json::Json::as_f64);
        Ok(Self {
            edge_label: string("edgeLabel"),
            direction: string("direction"),
            weight_property: string("weightProperty"),
            damping_factor: num("dampingFactor"),
            iterations: num("iterations").map(|n| n as u32),
            source: string("source"),
            target: string("target"),
            write_property: string("writeProperty"),
            algorithm: string("algorithm"),
            heuristic_property: string("heuristicProperty"),
        })
    }

    /// Resolve `edge_label` to an etype filter: `Some(None)` = every type,
    /// `Some(Some(id))` = a known type, `None` = a *named but unknown* type (no edge
    /// matches — the algorithm treats the graph as edgeless for that relationship).
    fn etype(&self, graph: &Graph) -> Option<Option<u32>> {
        match &self.edge_label {
            None => Some(None),
            Some(name) => graph.etype.get(name).map(Some),
        }
    }
}

/// Run algorithm `name` with a JSON `config`, optionally write each vertex's result
/// to `config.writeProperty`, and return the result rows `(node, <result-column>)`
/// where `node` is the external vertex id. Unknown `name` → `Err`.
pub fn run(graph: &mut Graph, name: &str, config: &str) -> Result<RowSet, String> {
    let cfg =
        AlgoConfig::from_json(config).map_err(|()| "invalid algorithm config JSON".to_string())?;

    // Each algorithm is a pure `&Graph -> Vec<(vertex, Value)>`; the driver handles
    // the optional property write and row materialization uniformly.
    let (column, results): (&str, Vec<(u32, Value)>) = match name {
        "degree" => ("degree", degree::degree(graph, &cfg)),
        "connectedComponents" => ("componentId", components::connected_components(graph, &cfg)),
        other => return Err(format!("unknown algorithm: {other}")),
    };

    if let Some(prop) = &cfg.write_property {
        for (v, val) in &results {
            graph.set_vertex_prop(*v, prop, val.clone());
        }
    }

    let mut rs = RowSet::new(vec!["node".to_string(), column.to_string()]);
    for (v, val) in results {
        rs.push_row([Value::Str(graph.vid.arc(v)), val]);
    }
    Ok(rs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ndjson;

    /// The TinkerPop "modern" graph. 1=marko 2=vadas 3=lop 4=josh 5=ripple 6=peter.
    /// KNOWS: marko→vadas, marko→josh. CREATED: marko→lop, josh→ripple, josh→lop,
    /// peter→lop.
    fn modern() -> Graph {
        let lines = [
            r#"{"type":"node","id":"1","labels":["Person"],"properties":{"name":"marko"}}"#,
            r#"{"type":"node","id":"2","labels":["Person"],"properties":{"name":"vadas"}}"#,
            r#"{"type":"node","id":"3","labels":["Software"],"properties":{"name":"lop"}}"#,
            r#"{"type":"node","id":"4","labels":["Person"],"properties":{"name":"josh"}}"#,
            r#"{"type":"node","id":"5","labels":["Software"],"properties":{"name":"ripple"}}"#,
            r#"{"type":"node","id":"6","labels":["Person"],"properties":{"name":"peter"}}"#,
            r#"{"type":"edge","from":"1","to":"2","labels":["KNOWS"]}"#,
            r#"{"type":"edge","from":"1","to":"4","labels":["KNOWS"]}"#,
            r#"{"type":"edge","from":"1","to":"3","labels":["CREATED"]}"#,
            r#"{"type":"edge","from":"4","to":"5","labels":["CREATED"]}"#,
            r#"{"type":"edge","from":"4","to":"3","labels":["CREATED"]}"#,
            r#"{"type":"edge","from":"6","to":"3","labels":["CREATED"]}"#,
        ];
        ndjson::decode(&lines.join("\n")).unwrap()
    }

    /// `(external id, degree)` rows in engine order.
    fn degrees(g: &mut Graph, cfg: &str) -> Vec<(String, i64)> {
        let rs = run(g, "degree", cfg).unwrap();
        rs.rows()
            .map(|r| match (&r[0], &r[1]) {
                (Value::Str(id), Value::Num(d)) => (id.to_string(), *d as i64),
                _ => panic!("unexpected degree row shape"),
            })
            .collect()
    }

    #[test]
    fn degree_out_in_both_and_typed() {
        let mut g = modern();
        // Rows are in insertion (dense-id) order: nodes "1".."6".
        assert_eq!(
            degrees(&mut g, r#"{"direction":"out"}"#),
            vec![
                ("1".into(), 3),
                ("2".into(), 0),
                ("3".into(), 0),
                ("4".into(), 2),
                ("5".into(), 0),
                ("6".into(), 1),
            ],
        );
        assert_eq!(
            degrees(&mut g, r#"{"direction":"in"}"#),
            vec![
                ("1".into(), 0),
                ("2".into(), 1),
                ("3".into(), 3),
                ("4".into(), 1),
                ("5".into(), 1),
                ("6".into(), 0),
            ],
        );
        assert_eq!(
            degrees(&mut g, r#"{"direction":"both"}"#),
            vec![
                ("1".into(), 3),
                ("2".into(), 1),
                ("3".into(), 3),
                ("4".into(), 3),
                ("5".into(), 1),
                ("6".into(), 1),
            ],
        );
        // Typed: out KNOWS — only marko (→vadas,→josh) = 2.
        assert_eq!(
            degrees(&mut g, r#"{"direction":"out","edgeLabel":"KNOWS"}"#)[0],
            ("1".into(), 2),
        );
        // in CREATED of lop("3") = marko, josh, peter = 3.
        assert_eq!(
            degrees(&mut g, r#"{"direction":"in","edgeLabel":"CREATED"}"#)[2],
            ("3".into(), 3),
        );
        // Unknown edge type → all zero.
        assert!(degrees(&mut g, r#"{"edgeLabel":"NOPE"}"#)
            .iter()
            .all(|(_, d)| *d == 0));
    }

    #[test]
    fn write_property_and_unknown_algo() {
        let mut g = modern();
        run(
            &mut g,
            "degree",
            r#"{"direction":"out","writeProperty":"deg"}"#,
        )
        .unwrap();
        // marko's written degree property is now 3.
        let rs = crate::gql::prepare("MATCH (n) WHERE n.name = 'marko' RETURN n.deg AS d")
            .unwrap()
            .execute(&mut g, &crate::gql::eval::Params::new())
            .unwrap();
        assert_eq!(rs.row(0)[0], Value::Num(3.0));
        assert!(run(&mut g, "nope", "{}").is_err());
    }

    /// `(external id, componentId)` rows in engine order.
    fn components(g: &mut Graph, cfg: &str) -> Vec<(String, String)> {
        let rs = run(g, "connectedComponents", cfg).unwrap();
        rs.rows()
            .map(|r| match (&r[0], &r[1]) {
                (Value::Str(id), Value::Str(c)) => (id.to_string(), c.to_string()),
                _ => panic!("unexpected component row shape"),
            })
            .collect()
    }

    /// Two disjoint components (1–2–3 and 5–4) plus an isolated vertex (6). Node
    /// insertion order 1,2,3,4,5,6 makes the component roots the min-index member:
    /// {1,2,3}→"1", {4,5}→"4", {6}→"6". Edge `5→4` also proves undirected union.
    fn two_components() -> Graph {
        let lines = [
            r#"{"type":"node","id":"1","labels":["N"]}"#,
            r#"{"type":"node","id":"2","labels":["N"]}"#,
            r#"{"type":"node","id":"3","labels":["N"]}"#,
            r#"{"type":"node","id":"4","labels":["N"]}"#,
            r#"{"type":"node","id":"5","labels":["N"]}"#,
            r#"{"type":"node","id":"6","labels":["N"]}"#,
            r#"{"type":"edge","from":"1","to":"2","labels":["E"]}"#,
            r#"{"type":"edge","from":"2","to":"3","labels":["E"]}"#,
            r#"{"type":"edge","from":"5","to":"4","labels":["E"]}"#,
        ];
        ndjson::decode(&lines.join("\n")).unwrap()
    }

    #[test]
    fn wcc_roots_are_min_index_member() {
        let mut g = two_components();
        assert_eq!(
            components(&mut g, "{}"),
            vec![
                ("1".into(), "1".into()),
                ("2".into(), "1".into()),
                ("3".into(), "1".into()),
                ("4".into(), "4".into()),
                ("5".into(), "4".into()),
                ("6".into(), "6".into()),
            ],
        );
        // The whole modern graph is one weakly-connected component rooted at "1".
        let mut m = modern();
        assert!(components(&mut m, "{}").iter().all(|(_, c)| c == "1"));
        // A named-but-unknown edge type → every vertex is its own component.
        assert_eq!(
            components(&mut g, r#"{"edgeLabel":"NOPE"}"#),
            (1..=6)
                .map(|i| (i.to_string(), i.to_string()))
                .collect::<Vec<_>>(),
        );
    }
}
