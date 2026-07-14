//! Degree centrality: per-vertex count of incident edges — out (default), in, or
//! both — optionally restricted to a single edge type. O(V + E), in dense-vertex-id
//! order (= NDJSON insertion order) so it matches the TS mirror exactly.

use super::AlgoConfig;
use crate::graph::{Adj, Graph, Value};

pub fn degree(graph: &Graph, cfg: &AlgoConfig) -> Vec<(u32, Value)> {
    // A named-but-unknown edge type → every vertex has degree 0.
    let Some(etype) = cfg.etype(graph) else {
        return graph
            .vertex_indices()
            .map(|v| (v, Value::Num(0.0)))
            .collect();
    };
    let dir = cfg.direction.as_deref().unwrap_or("out");

    graph
        .vertex_indices()
        .map(|v| {
            let d = match dir {
                "in" => count(graph.in_adj(v), etype),
                "both" => count(graph.out_adj(v), etype) + count(graph.in_adj(v), etype),
                _ => count(graph.out_adj(v), etype), // "out" (default)
            };
            (v, Value::Num(d as f64))
        })
        .collect()
}

/// Count edges of the iterator, filtered to `etype` when a specific type is given.
fn count(adj: impl Iterator<Item = Adj>, etype: Option<u32>) -> u64 {
    match etype {
        None => adj.count() as u64,
        Some(t) => adj.filter(|a| a.etype == t).count() as u64,
    }
}
