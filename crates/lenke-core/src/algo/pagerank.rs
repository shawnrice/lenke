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

#[cfg(feature = "parallel")]
use rayon::prelude::*;

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
    // Precompute per-edge weights ONCE so both build passes index a flat Vec instead
    // of re-resolving the property twice per edge. `None` = unweighted (1.0).
    let weights: Option<Vec<f64>> = cfg
        .weight_property
        .as_deref()
        .map(|k| super::edge_weights(graph, k));
    let weight_of = |ei: usize| -> f64 { weights.as_ref().map_or(1.0, |w| w[ei]) };

    let slots = graph.n;

    // Pass 1: out-strength per source, accumulated in edge-insertion order (serial —
    // the per-source weighted sum's f64 order is part of the byte-identity contract).
    let mut out_strength = vec![0.0f64; slots];
    for ei in 0..graph.edge_slots() {
        if graph.is_edge_live(ei as u32) && type_ok(graph.e_type[ei]) {
            out_strength[graph.e_src[ei] as usize] += weight_of(ei);
        }
    }

    // Pass 2: per-target contribution lists as a flat CSR — `inc_off[v]..inc_off[v+1]`
    // indexes `(inc_src, inc_fac)` for target v, filled in edge-insertion order so
    // each target's later sum is order-canonical. Flat arrays (vs Vec<Vec>) give the
    // hot pull loop contiguous, cache-friendly reads and one allocation.
    let mut inc_off = vec![0usize; slots + 1];
    for ei in 0..graph.edge_slots() {
        if graph.is_edge_live(ei as u32) && type_ok(graph.e_type[ei]) {
            inc_off[graph.e_dst[ei] as usize + 1] += 1;
        }
    }
    for v in 0..slots {
        inc_off[v + 1] += inc_off[v];
    }
    let mut inc_src = vec![0u32; inc_off[slots]];
    let mut inc_fac = vec![0.0f64; inc_off[slots]];
    let mut cursor = inc_off[..slots].to_vec();
    for ei in 0..graph.edge_slots() {
        if !graph.is_edge_live(ei as u32) || !type_ok(graph.e_type[ei]) {
            continue;
        }
        let src = graph.e_src[ei];
        // A node whose total out-weight is 0 (only reachable in the weighted path,
        // when every out-edge has weight 0) is a DANGLING node: its rank mass is
        // redistributed uniformly via the `dangling` sum below — it must NOT be
        // divided by zero (`weight_of / 0 == 0/0 == NaN`, which would poison every
        // score). Emit a 0 factor so this edge carries no directed mass. The CSR
        // slot is still filled (Pass 1 reserved it), so the summation order stays
        // byte-identical to the unweighted path and to the TS engine. Unweighted
        // never hits this branch: an existing edge implies out_strength > 0.
        let factor = if out_strength[src as usize] == 0.0 {
            0.0
        } else {
            weight_of(ei) / out_strength[src as usize]
        };
        let pos = cursor[graph.e_dst[ei] as usize];
        cursor[graph.e_dst[ei] as usize] += 1;
        inc_src[pos] = src;
        inc_fac[pos] = factor;
    }

    let mut pr = vec![0.0f64; slots];
    for v in graph.vertex_indices() {
        pr[v as usize] = 1.0 / nf;
    }

    for _ in 0..iterations {
        // Dangling mass: Σ pr[u] over out-strength-0 vertices, in vertex order (serial
        // reduction — a parallel one would reorder the f64 sum).
        let mut dangling = 0.0;
        for u in graph.vertex_indices() {
            if out_strength[u as usize] == 0.0 {
                dangling += pr[u as usize];
            }
        }
        let base = (1.0 - d) / nf + d * dangling / nf;

        // Pull: each target's sum is independent and taken in its own fixed CSR
        // order, so parallelizing ACROSS targets keeps every accumulation
        // bit-identical. Dead slots see an empty range → `base` (never read/output).
        let mut next = vec![0.0f64; slots];
        let pull = |v: usize, nv: &mut f64| {
            let mut sum = 0.0;
            for j in inc_off[v]..inc_off[v + 1] {
                sum += pr[inc_src[j] as usize] * inc_fac[j];
            }
            *nv = base + d * sum;
        };
        #[cfg(feature = "parallel")]
        next.par_iter_mut()
            .enumerate()
            .for_each(|(v, nv)| pull(v, nv));
        #[cfg(not(feature = "parallel"))]
        for (v, nv) in next.iter_mut().enumerate() {
            pull(v, nv);
        }
        pr = next;
    }

    graph
        .vertex_indices()
        .map(|v| (v, Value::Num(pr[v as usize])))
        .collect()
}
