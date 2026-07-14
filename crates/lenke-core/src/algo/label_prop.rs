//! Synchronous label propagation (a community-detection heuristic). Every vertex
//! starts labelled with its own external id; each round it adopts the label most
//! common among its neighbours (edges undirected — both in- and out-neighbours
//! count), ties broken by the **smallest label string**. Rounds are synchronous
//! (all vertices read the previous round's labels, then commit together) for a
//! fixed `iterations` count (default 10). The winner is chosen by (count, then
//! lexicographic label), which is independent of neighbour-enumeration order, so
//! the TS mirror is byte-identical.

use std::collections::HashMap;
use std::sync::Arc;

use super::AlgoConfig;
use crate::graph::{Adj, Graph, Value};

const DEFAULT_ITERATIONS: u32 = 10;

pub fn label_propagation(graph: &Graph, cfg: &AlgoConfig) -> Vec<(u32, Value)> {
    let iterations = cfg.iterations.unwrap_or(DEFAULT_ITERATIONS);
    // Some(None) = every edge type; Some(Some(t)) = one type; None = a named-but-
    // unknown type → no edges, so every vertex keeps its own label forever.
    let etype = cfg.etype(graph);

    // Labels indexed by dense id over the whole slot space; tombstoned slots are
    // never read (they are neither vertices nor edge endpoints).
    let mut labels: Vec<Arc<str>> = (0..graph.n as u32).map(|v| graph.vid.arc(v)).collect();

    let passes = |a: &Adj| match etype {
        Some(Some(t)) => a.etype == t,
        _ => true,
    };

    // `etype` is `None` only for a named-but-unknown type; skip propagation then.
    if etype.is_some() {
        for _ in 0..iterations {
            let mut next = labels.clone();
            for v in graph.vertex_indices() {
                // Tally neighbour labels from the frozen `labels` snapshot.
                let mut counts: HashMap<&Arc<str>, u32> = HashMap::new();
                for a in graph.out_adj(v).chain(graph.in_adj(v)) {
                    if passes(&a) {
                        *counts.entry(&labels[a.nbr as usize]).or_insert(0) += 1;
                    }
                }
                // Adopt the most-frequent label; tie → lexicographically smallest.
                // No neighbours → keep the current label.
                let mut best: Option<(&Arc<str>, u32)> = None;
                for (&lbl, &c) in &counts {
                    let better = match best {
                        None => true,
                        Some((bl, bc)) => c > bc || (c == bc && lbl.as_ref() < bl.as_ref()),
                    };
                    if better {
                        best = Some((lbl, c));
                    }
                }
                if let Some((lbl, _)) = best {
                    next[v as usize] = lbl.clone();
                }
            }
            labels = next;
        }
    }

    graph
        .vertex_indices()
        .map(|v| (v, Value::Str(labels[v as usize].clone())))
        .collect()
}
