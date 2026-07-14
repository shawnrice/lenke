//! Single-source shortest path from a `source` external id, following out-edges
//! (optionally of one type). Unweighted → BFS integer hop distance; weighted (a
//! `weightProperty` is set) → Dijkstra f64 distance. Returns `{node, distance}` for
//! every reachable vertex (including the source at 0), in vertex-insertion order.
//!
//! Cross-engine identity: a vertex's shortest distance is the canonical minimum
//! over all path costs — BFS layer distances are unique integers, and Dijkstra's
//! settled distance is the minimum path float-sum — so both engines produce the
//! same distances. The priority queue breaks ties by (distance, then vertex index)
//! so the *exploration* order is identical too, keeping even float-pathological
//! graphs byte-identical. Unknown/absent source → no rows.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};

use super::AlgoConfig;
use crate::graph::{Adj, Graph, Value};

/// A Dijkstra frontier entry ordered as a min-heap on `(dist, idx)`: `BinaryHeap`
/// is a max-heap, so `Ord` is reversed — the smallest distance (then smallest
/// vertex index) compares greatest and pops first.
struct State {
    dist: f64,
    idx: u32,
}

impl PartialEq for State {
    fn eq(&self, other: &Self) -> bool {
        self.dist == other.dist && self.idx == other.idx
    }
}
impl Eq for State {}
impl Ord for State {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .dist
            .partial_cmp(&self.dist)
            .unwrap_or(Ordering::Equal)
            .then_with(|| other.idx.cmp(&self.idx))
    }
}
impl PartialOrd for State {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn shortest_path(graph: &Graph, cfg: &AlgoConfig) -> Vec<(u32, Value)> {
    // Resolve the source external id → dense id; unknown/absent → no reachable set.
    let Some(src) = cfg.source.as_deref().and_then(|s| graph.vid.get(s)) else {
        return Vec::new();
    };
    // A named-but-unknown edge type → only the source is reachable (no edges).
    let etype = cfg.etype(graph);
    let passes = |a: &Adj| match etype {
        Some(Some(t)) => a.etype == t,
        Some(None) => true,
        None => false,
    };

    let slots = graph.n;

    // A* is a goal-directed backend: given a `target`, it returns just the source→
    // target distance (identical to Dijkstra's, so interchangeable), exploring far
    // fewer vertices via the admissible `heuristicProperty`.
    if cfg.algorithm.as_deref() == Some("astar") {
        let Some(tgt) = cfg.target.as_deref().and_then(|t| graph.vid.get(t)) else {
            return Vec::new();
        };
        return match astar(graph, src, tgt, slots, cfg, &passes) {
            Some(d) => vec![(tgt, Value::Num(d))],
            None => Vec::new(),
        };
    }

    let dist = match &cfg.weight_property {
        None => bfs(graph, src, slots, &passes),
        Some(key) => dijkstra(graph, src, slots, key, &passes),
    };

    graph
        .vertex_indices()
        .filter(|&v| dist[v as usize].is_finite())
        .map(|v| (v, Value::Num(dist[v as usize])))
        .collect()
}

/// Goal-directed A\*: explore by `f = g + h`, where `h` is the admissible estimate
/// to `tgt` read from each vertex's `heuristicProperty` (absent → 0, degrading to
/// Dijkstra). Returns `Some(distance)` when `tgt` is settled (its `g` is then
/// optimal — identical to Dijkstra), `None` if unreachable. Edge weights come from
/// `weightProperty` (absent → unit weights). Same `(priority, idx)` tie-break as
/// Dijkstra, so native and TS explore identically.
fn astar(
    graph: &Graph,
    src: u32,
    tgt: u32,
    slots: usize,
    cfg: &AlgoConfig,
    passes: &impl Fn(&Adj) -> bool,
) -> Option<f64> {
    let hkey = cfg.heuristic_property.as_deref();
    let h = |v: u32| -> f64 {
        match hkey {
            None => 0.0,
            Some(k) => match graph.props.value(v as usize, k, &graph.strs) {
                Value::Num(x) => x,
                _ => 0.0,
            },
        }
    };
    let wkey = cfg.weight_property.as_deref();
    let weight = |a: &Adj| -> f64 {
        match wkey {
            None => 1.0,
            Some(k) => match graph.edge_props.value(a.eidx as usize, k, &graph.strs) {
                Value::Num(x) => x,
                _ => 0.0,
            },
        }
    };

    let mut g = vec![f64::INFINITY; slots];
    let mut closed = vec![false; slots];
    g[src as usize] = 0.0;
    let mut heap = BinaryHeap::new();
    heap.push(State {
        dist: h(src),
        idx: src,
    });
    while let Some(State { idx: u, .. }) = heap.pop() {
        if closed[u as usize] {
            continue;
        }
        closed[u as usize] = true;
        if u == tgt {
            return Some(g[u as usize]);
        }
        for a in graph.out_adj(u) {
            if !passes(&a) || closed[a.nbr as usize] {
                continue;
            }
            let ng = g[u as usize] + weight(&a);
            if ng < g[a.nbr as usize] {
                g[a.nbr as usize] = ng;
                heap.push(State {
                    dist: ng + h(a.nbr),
                    idx: a.nbr,
                });
            }
        }
    }
    None
}

/// Unweighted BFS hop distance (as f64), `INFINITY` for unreached.
fn bfs(graph: &Graph, src: u32, slots: usize, passes: &impl Fn(&Adj) -> bool) -> Vec<f64> {
    let mut dist = vec![f64::INFINITY; slots];
    dist[src as usize] = 0.0;
    let mut queue = VecDeque::new();
    queue.push_back(src);
    while let Some(u) = queue.pop_front() {
        let du = dist[u as usize];
        for a in graph.out_adj(u) {
            if passes(&a) && dist[a.nbr as usize].is_infinite() {
                dist[a.nbr as usize] = du + 1.0;
                queue.push_back(a.nbr);
            }
        }
    }
    dist
}

/// Weighted Dijkstra f64 distance, `INFINITY` for unreached. Missing/non-numeric
/// edge weights count as 0.0; negative weights are out of contract (Dijkstra).
fn dijkstra(
    graph: &Graph,
    src: u32,
    slots: usize,
    key: &str,
    passes: &impl Fn(&Adj) -> bool,
) -> Vec<f64> {
    let mut dist = vec![f64::INFINITY; slots];
    dist[src as usize] = 0.0;
    let mut heap = BinaryHeap::new();
    heap.push(State {
        dist: 0.0,
        idx: src,
    });
    while let Some(State { dist: du, idx: u }) = heap.pop() {
        // Skip a stale entry (a shorter distance was already settled).
        if du > dist[u as usize] {
            continue;
        }
        for a in graph.out_adj(u) {
            if !passes(&a) {
                continue;
            }
            let w = match graph.edge_props.value(a.eidx as usize, key, &graph.strs) {
                Value::Num(x) => x,
                _ => 0.0,
            };
            let nd = du + w;
            if nd < dist[a.nbr as usize] {
                dist[a.nbr as usize] = nd;
                heap.push(State {
                    dist: nd,
                    idx: a.nbr,
                });
            }
        }
    }
    dist
}
