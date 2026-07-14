//! PageRank (pull model, f64). `pr'[v] = (1−d)/N + d·Σ_{u→v} pr[u]·w(u→v)/S[u] +
//! d·dangling/N`, where `S[u]` is u's out-strength (out-degree, or Σ edge weight
//! when `weightProperty` is set), `dangling = Σ pr[u]` over out-strength-0 vertices,
//! `d` = damping (default 0.85), for a fixed `iterations` (default 20).
//!
//! Cross-engine bit-identity: the summation order of every f64 accumulation is
//! pinned to **global edge-insertion order** (dense eidx == NDJSON order == the TS
//! `edgesById` insertion order). Both engines build the per-target contribution
//! lists by scanning all edges once in that order, so each `pr'[v]` sum adds its
//! terms in the same sequence — making the TS mirror byte-for-byte equal, parallel
//! edges and weights included. The dangling sum is taken in vertex-insertion order,
//! also identical.

use super::AlgoConfig;
use crate::graph::{Graph, Value};

const DEFAULT_DAMPING: f64 = 0.85;
const DEFAULT_ITERATIONS: u32 = 20;

pub fn pagerank(graph: &Graph, cfg: &AlgoConfig) -> Vec<(u32, Value)> {
    let d = cfg.damping_factor.unwrap_or(DEFAULT_DAMPING);
    let iterations = cfg.iterations.unwrap_or(DEFAULT_ITERATIONS);
    let n = graph.vertex_count();
    if n == 0 {
        return Vec::new();
    }
    let nf = n as f64;

    // Some(None) = every type; Some(Some(t)) = one type; None = unknown type → no
    // edges (every vertex dangling → uniform 1/N).
    let etype = cfg.etype(graph);
    let type_ok = |ty: u32| match etype {
        Some(Some(t)) => ty == t,
        Some(None) => true,
        None => false,
    };
    let weight_of = |ei: usize| -> f64 {
        match &cfg.weight_property {
            None => 1.0,
            Some(key) => match graph.edge_props.value(ei, key, &graph.strs) {
                Value::Num(x) => x,
                _ => 0.0,
            },
        }
    };

    let slots = graph.n;

    // Pass 1: out-strength per source, accumulated in edge-insertion order.
    let mut out_strength = vec![0.0f64; slots];
    for ei in 0..graph.edge_slots() {
        if graph.is_edge_live(ei as u32) && type_ok(graph.e_type[ei]) {
            out_strength[graph.e_src[ei] as usize] += weight_of(ei);
        }
    }

    // Pass 2: per-target contribution list (source, weight/out_strength), pushed in
    // edge-insertion order so each target's later sum is order-canonical.
    let mut incoming: Vec<Vec<(u32, f64)>> = vec![Vec::new(); slots];
    for ei in 0..graph.edge_slots() {
        if !graph.is_edge_live(ei as u32) || !type_ok(graph.e_type[ei]) {
            continue;
        }
        let src = graph.e_src[ei];
        // out_strength[src] > 0 here (this edge contributes to it); no zero-divide.
        let factor = weight_of(ei) / out_strength[src as usize];
        incoming[graph.e_dst[ei] as usize].push((src, factor));
    }

    let mut pr = vec![0.0f64; slots];
    for v in graph.vertex_indices() {
        pr[v as usize] = 1.0 / nf;
    }

    for _ in 0..iterations {
        // Dangling mass: Σ pr[u] over out-strength-0 vertices, in vertex order.
        let mut dangling = 0.0;
        for u in graph.vertex_indices() {
            if out_strength[u as usize] == 0.0 {
                dangling += pr[u as usize];
            }
        }
        let base = (1.0 - d) / nf + d * dangling / nf;

        let mut next = vec![0.0f64; slots];
        for v in graph.vertex_indices() {
            let mut sum = 0.0;
            for &(u, factor) in &incoming[v as usize] {
                sum += pr[u as usize] * factor;
            }
            next[v as usize] = base + d * sum;
        }
        pr = next;
    }

    graph
        .vertex_indices()
        .map(|v| (v, Value::Num(pr[v as usize])))
        .collect()
}
