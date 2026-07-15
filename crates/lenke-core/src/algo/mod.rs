//! In-engine graph algorithms — degree centrality, connected components, label
//! propagation, peer pressure (community detection), PageRank, and shortest path —
//! run natively over `&Graph` in a single call (no per-iteration FFI round-trip), so
//! a whole PageRank/CC/label-prop computation stays in the engine instead of JS.
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
//!
//! Parallelism (behind the `parallel` feature; serial twins for wasm) is applied
//! only where it preserves that contract: PageRank fans out **across targets** (each
//! target still sums its own fixed-order contribution list) and label propagation
//! **across vertices** per round (each reads only the frozen snapshot; the winner is
//! order-independent). The dangling reduction and per-source weight sums stay serial
//! — reordering those f64 additions would change the last bits. So parallel-native
//! == serial-native == serial-TS, verified by the differential conformance suite.

use crate::graph::{Graph, Value};
use crate::json;
use crate::query::RowSet;

mod components;
mod degree;
mod label_prop;
mod pagerank;
mod peer_pressure;
mod shortest_path;

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

/// Per-edge numeric weights (indexed by edge id) for property `key`: resolve the
/// key to a dense id once and read each edge via `value_id` — no per-edge key-string
/// hashing and one flat allocation the weighted algorithms can index directly.
/// Absent/non-numeric values read as `0.0`, exactly as `Properties::value` would.
pub(super) fn edge_weights(graph: &Graph, key: &str) -> Vec<f64> {
    let kid = graph.edge_props.keys.get(key);
    (0..graph.edge_slots())
        .map(|ei| match kid {
            Some(k) => match graph.edge_props.value_id(ei, k, &graph.strs) {
                Value::Num(x) => x,
                _ => 0.0,
            },
            None => 0.0,
        })
        .collect()
}

/// An algorithm's output: the result column name + per-vertex `(dense id, value)`s.
/// An algorithm's output: the result column name + `(dense vertex id, value)` rows.
pub type AlgoOutput = (&'static str, Vec<(u32, Value)>);
/// Pending `writeProperty` writes: the property key + per-vertex `(dense id, value)`s.
type PendingWrites = Option<(String, Vec<(u32, Value)>)>;

/// Dispatch by name to the pure `&Graph -> Vec<(vertex, Value)>` algorithm, returning
/// the result column name alongside. Read-only. Unknown `name` → `Err`.
fn dispatch(graph: &Graph, name: &str, cfg: &AlgoConfig) -> Result<AlgoOutput, String> {
    Ok(match name {
        "degree" => ("degree", degree::degree(graph, cfg)),
        "connectedComponents" => ("componentId", components::connected_components(graph, cfg)),
        "labelPropagation" => ("label", label_prop::label_propagation(graph, cfg)),
        "peerPressure" => ("cluster", peer_pressure::peer_pressure(graph, cfg)),
        "pagerank" => ("score", pagerank::pagerank(graph, cfg)),
        "shortestPath" => ("distance", shortest_path::shortest_path(graph, cfg)),
        other => return Err(format!("unknown algorithm: {other}")),
    })
}

/// Materialize `(vertex, value)` results into a `(node, <column>)` RowSet, mapping
/// each dense vertex id to its external id. Read-only.
fn build_rowset(graph: &Graph, column: &str, results: &[(u32, Value)]) -> RowSet {
    let mut rs = RowSet::new(vec!["node".to_string(), column.to_string()]);
    for (v, val) in results {
        rs.push_row([Value::Str(graph.vid.arc(*v)), val.clone()]);
    }
    rs
}

/// Run algorithm `name` with a JSON `config`, optionally write each vertex's result
/// to `config.writeProperty`, and return the result rows `(node, <result-column>)`
/// where `node` is the external vertex id. Unknown `name` → `Err`.
pub fn run(graph: &mut Graph, name: &str, config: &str) -> Result<RowSet, String> {
    let cfg =
        AlgoConfig::from_json(config).map_err(|()| "invalid algorithm config JSON".to_string())?;
    run_with(graph, name, &cfg)
}

/// Like [`run`] but taking a pre-built [`AlgoConfig`] (no JSON round-trip) — the entry
/// used by the in-query Gremlin algorithm steps, which build the config from their
/// step modulators directly.
pub fn run_with(graph: &mut Graph, name: &str, cfg: &AlgoConfig) -> Result<RowSet, String> {
    let (column, results) = run_columns(graph, name, cfg)?;

    Ok(build_rowset(graph, column, &results))
}

/// Run an algorithm and return the raw `(dense vertex id, result value)` rows plus
/// the result column name — applying `writeProperty` but WITHOUT materializing a
/// `RowSet`. The GQL `CALL` path uses this so it can bind `node` as a live
/// `Val::Node` handle (deferring the `{id, labels, properties}` hydration to the
/// rows that actually survive to output) instead of a pre-stringified id.
pub fn run_columns(graph: &mut Graph, name: &str, cfg: &AlgoConfig) -> Result<AlgoOutput, String> {
    let (column, results) = dispatch(graph, name, cfg)?;

    if let Some(prop) = &cfg.write_property {
        for (v, val) in &results {
            graph.set_vertex_prop(*v, prop, val.clone());
        }
    }

    Ok((column, results))
}

/// Read-only counterpart of [`run`] for the async (off-thread) path: compute the
/// result RowSet and return any pending `writeProperty` writes for the caller to
/// apply back on the main thread (where `&mut Graph` is exclusive again). The whole
/// computation touches only `&Graph`, so it is safe to run off the JS thread.
pub fn compute_parts(
    graph: &Graph,
    name: &str,
    config: &str,
) -> Result<(RowSet, PendingWrites), String> {
    let cfg =
        AlgoConfig::from_json(config).map_err(|()| "invalid algorithm config JSON".to_string())?;
    let (column, results) = dispatch(graph, name, &cfg)?;
    let rs = build_rowset(graph, column, &results);
    let writes = cfg.write_property.map(|prop| (prop, results));
    Ok((rs, writes))
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

    /// `(external id, label)` rows in engine order.
    fn labels(g: &mut Graph, cfg: &str) -> Vec<(String, String)> {
        let rs = run(g, "labelPropagation", cfg).unwrap();
        rs.rows()
            .map(|r| match (&r[0], &r[1]) {
                (Value::Str(id), Value::Str(l)) => (id.to_string(), l.to_string()),
                _ => panic!("unexpected label row shape"),
            })
            .collect()
    }

    /// Two disjoint triangles {1,2,3} and {4,5,6}. A triangle is a clique, so
    /// synchronous LPA converges each to its smallest-id label within a couple of
    /// rounds and stays there — {1,2,3}→"1", {4,5,6}→"4".
    fn two_triangles() -> Graph {
        let lines = [
            r#"{"type":"node","id":"1","labels":["N"]}"#,
            r#"{"type":"node","id":"2","labels":["N"]}"#,
            r#"{"type":"node","id":"3","labels":["N"]}"#,
            r#"{"type":"node","id":"4","labels":["N"]}"#,
            r#"{"type":"node","id":"5","labels":["N"]}"#,
            r#"{"type":"node","id":"6","labels":["N"]}"#,
            r#"{"type":"edge","from":"1","to":"2","labels":["E"]}"#,
            r#"{"type":"edge","from":"2","to":"3","labels":["E"]}"#,
            r#"{"type":"edge","from":"1","to":"3","labels":["E"]}"#,
            r#"{"type":"edge","from":"4","to":"5","labels":["E"]}"#,
            r#"{"type":"edge","from":"5","to":"6","labels":["E"]}"#,
            r#"{"type":"edge","from":"4","to":"6","labels":["E"]}"#,
        ];
        ndjson::decode(&lines.join("\n")).unwrap()
    }

    #[test]
    fn label_prop_triangles_converge_to_min_label() {
        let mut g = two_triangles();
        assert_eq!(
            labels(&mut g, "{}"),
            vec![
                ("1".into(), "1".into()),
                ("2".into(), "1".into()),
                ("3".into(), "1".into()),
                ("4".into(), "4".into()),
                ("5".into(), "4".into()),
                ("6".into(), "4".into()),
            ],
        );
        // Zero iterations → every vertex keeps its own external id as its label.
        assert_eq!(
            labels(&mut g, r#"{"iterations":0}"#),
            (1..=6)
                .map(|i| (i.to_string(), i.to_string()))
                .collect::<Vec<_>>(),
        );
        // A named-but-unknown edge type → no propagation, labels stay = own id.
        assert_eq!(
            labels(&mut g, r#"{"edgeLabel":"NOPE"}"#),
            (1..=6)
                .map(|i| (i.to_string(), i.to_string()))
                .collect::<Vec<_>>(),
        );
    }

    /// `(external id, score)` rows in engine order.
    fn scores(g: &mut Graph, cfg: &str) -> Vec<(String, f64)> {
        let rs = run(g, "pagerank", cfg).unwrap();
        rs.rows()
            .map(|r| match (&r[0], &r[1]) {
                (Value::Str(id), Value::Num(s)) => (id.to_string(), *s),
                _ => panic!("unexpected pagerank row shape"),
            })
            .collect()
    }

    #[test]
    fn pagerank_two_cycle_is_uniform_and_mass_conserving() {
        // 1↔2 symmetric cycle → exactly [0.5, 0.5] (a fixed point of the iteration).
        let two_cycle = ndjson::decode(
            &[
                r#"{"type":"node","id":"1","labels":["N"]}"#,
                r#"{"type":"node","id":"2","labels":["N"]}"#,
                r#"{"type":"edge","from":"1","to":"2","labels":["E"]}"#,
                r#"{"type":"edge","from":"2","to":"1","labels":["E"]}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let mut g = two_cycle;
        assert_eq!(
            scores(&mut g, "{}"),
            vec![("1".into(), 0.5), ("2".into(), 0.5)]
        );

        // Mass conservation: the scores form a probability distribution summing to 1
        // (dangling redistribution keeps total rank constant). The modern graph has
        // dangling sinks (lop, vadas, ripple), so this exercises that path.
        let mut m = modern();
        let total: f64 = scores(&mut m, "{}").iter().map(|(_, s)| s).sum();
        assert!(
            (total - 1.0).abs() < 1e-9,
            "PageRank mass not conserved: {total}"
        );

        // The most-created software (lop, id 3: in-degree 3) outranks a leaf (vadas).
        let s = scores(&mut m, "{}");
        let by = |id: &str| s.iter().find(|(v, _)| v == id).unwrap().1;
        assert!(by("3") > by("2"));
    }

    /// `(external id, cluster)` rows in engine order.
    fn clusters(g: &mut Graph, cfg: &str) -> Vec<(String, String)> {
        let rs = run(g, "peerPressure", cfg).unwrap();
        rs.rows()
            .map(|r| match (&r[0], &r[1]) {
                (Value::Str(id), Value::Str(c)) => (id.to_string(), c.to_string()),
                _ => panic!("unexpected peerPressure row shape"),
            })
            .collect()
    }

    /// Two directed cliques {1,2,3} and {4,5,6} (all 6 intra-triangle edges each) —
    /// peer pressure converges each to its smallest-id cluster ("1" and "4").
    fn two_cliques() -> Graph {
        let mut lines: Vec<String> = (1..=6)
            .map(|i| format!(r#"{{"type":"node","id":"{i}","labels":["N"]}}"#))
            .collect();
        for &(a, b) in &[(1, 2), (1, 3), (2, 3), (4, 5), (4, 6), (5, 6)] {
            lines.push(format!(
                r#"{{"type":"edge","from":"{a}","to":"{b}","labels":["E"]}}"#
            ));
            lines.push(format!(
                r#"{{"type":"edge","from":"{b}","to":"{a}","labels":["E"]}}"#
            ));
        }
        ndjson::decode(&lines.join("\n")).unwrap()
    }

    #[test]
    fn peer_pressure_cliques_converge_to_min_cluster() {
        let mut g = two_cliques();
        assert_eq!(
            clusters(&mut g, "{}"),
            vec![
                ("1".into(), "1".into()),
                ("2".into(), "1".into()),
                ("3".into(), "1".into()),
                ("4".into(), "4".into()),
                ("5".into(), "4".into()),
                ("6".into(), "4".into()),
            ],
        );
        // A named-but-unknown edge type → no votes, every vertex its own cluster.
        assert_eq!(
            clusters(&mut g, r#"{"edgeLabel":"NOPE"}"#),
            (1..=6)
                .map(|i| (i.to_string(), i.to_string()))
                .collect::<Vec<_>>(),
        );
    }

    /// `(external id, distance)` rows in engine order.
    fn paths(g: &mut Graph, cfg: &str) -> Vec<(String, f64)> {
        let rs = run(g, "shortestPath", cfg).unwrap();
        rs.rows()
            .map(|r| match (&r[0], &r[1]) {
                (Value::Str(id), Value::Num(d)) => (id.to_string(), *d),
                _ => panic!("unexpected shortest-path row shape"),
            })
            .collect()
    }

    /// 1→2 (w1), 2→3 (w2), 1→3 (w5); node 4 isolated (unreachable from 1).
    fn weighted_chain() -> Graph {
        let lines = [
            r#"{"type":"node","id":"1","labels":["N"]}"#,
            r#"{"type":"node","id":"2","labels":["N"]}"#,
            r#"{"type":"node","id":"3","labels":["N"]}"#,
            r#"{"type":"node","id":"4","labels":["N"]}"#,
            r#"{"type":"edge","from":"1","to":"2","labels":["E"],"properties":{"w":1.0}}"#,
            r#"{"type":"edge","from":"2","to":"3","labels":["E"],"properties":{"w":2.0}}"#,
            r#"{"type":"edge","from":"1","to":"3","labels":["E"],"properties":{"w":5.0}}"#,
        ];
        ndjson::decode(&lines.join("\n")).unwrap()
    }

    #[test]
    fn shortest_path_bfs_and_dijkstra() {
        let mut g = weighted_chain();
        // Unweighted BFS from 1: 1→3 is a direct edge, so node 3 is 1 hop.
        assert_eq!(
            paths(&mut g, r#"{"source":"1"}"#),
            vec![("1".into(), 0.0), ("2".into(), 1.0), ("3".into(), 1.0)],
        );
        // Weighted Dijkstra from 1: 1→2→3 (1+2=3) beats the direct 1→3 (5).
        assert_eq!(
            paths(&mut g, r#"{"source":"1","weightProperty":"w"}"#),
            vec![("1".into(), 0.0), ("2".into(), 1.0), ("3".into(), 3.0)],
        );
        // From 2 (weighted): only 2 and 3 reachable; node 1 is upstream, omitted.
        assert_eq!(
            paths(&mut g, r#"{"source":"2","weightProperty":"w"}"#),
            vec![("2".into(), 0.0), ("3".into(), 2.0)],
        );
        // Unknown source → no rows; unknown edge type → only the source at 0.
        assert!(paths(&mut g, r#"{"source":"99"}"#).is_empty());
        assert_eq!(
            paths(&mut g, r#"{"source":"1","edgeLabel":"NOPE"}"#),
            vec![("1".into(), 0.0)],
        );
    }

    #[test]
    fn astar_matches_dijkstra_target_distance() {
        let mut g = weighted_chain();
        // A* to node 3 returns just the target's distance, identical to Dijkstra (3).
        assert_eq!(
            paths(
                &mut g,
                r#"{"source":"1","target":"3","weightProperty":"w","algorithm":"astar"}"#,
            ),
            vec![("3".into(), 3.0)],
        );
        // For every reachable target, A* agrees with Dijkstra's distance.
        let dijkstra = paths(&mut g, r#"{"source":"1","weightProperty":"w"}"#);
        for (id, dist) in dijkstra {
            let astar = paths(
                &mut g,
                &format!(
                    r#"{{"source":"1","target":"{id}","weightProperty":"w","algorithm":"astar"}}"#
                ),
            );
            assert_eq!(astar, vec![(id, dist)]);
        }
        // Unreachable target (upstream) → no rows.
        assert!(paths(
            &mut g,
            r#"{"source":"3","target":"1","weightProperty":"w","algorithm":"astar"}"#,
        )
        .is_empty());
    }
}
