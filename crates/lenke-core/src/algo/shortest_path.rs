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
use std::collections::{BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque};

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
    // Precompute per-edge weights once (weighted runs read them per relaxation, so a
    // hashed property lookup there would dominate). `None` = unweighted.
    let weights: Option<Vec<f64>> = cfg
        .weight_property
        .as_deref()
        .map(|k| super::edge_weights(graph, k));

    // A* is a goal-directed backend: given a `target`, it returns just the source→
    // target distance (identical to Dijkstra's, so interchangeable), exploring far
    // fewer vertices via the admissible `heuristicProperty`.
    if cfg.algorithm.as_deref() == Some("astar") {
        let Some(tgt) = cfg.target.as_deref().and_then(|t| graph.vid.get(t)) else {
            return Vec::new();
        };
        return match astar(graph, src, tgt, slots, cfg, weights.as_deref(), &passes) {
            Some(d) => vec![(tgt, Value::Num(d))],
            None => Vec::new(),
        };
    }

    // Full SSSP. `algorithm` "dijkstra" (default) and "bmssp" both resolve here:
    // the Duan et al. 2025 sorting-barrier SSSP (arXiv 2504.17033) is an exact
    // algorithm, so it yields the identical canonical distances — it is a drop-in
    // *performance* backend (its specialized pivot/partial-sort structure is a
    // deferred internal optimization), validated against this reference.
    let dist = match weights.as_deref() {
        None => bfs(graph, src, slots, &passes),
        // The Duan et al. 2025 sorting-barrier SSSP — an exact backend yielding the
        // identical canonical distances as Dijkstra (validated against it). Only
        // the weighted case routes here; unweighted stays BFS.
        Some(w) if cfg.algorithm.as_deref() == Some("bmssp") => {
            let mut solver = Bmssp {
                graph,
                weights: w,
                passes: &passes,
                dist: vec![f64::INFINITY; slots],
                in_u: vec![false; slots],
                k: 1,
                t: 1,
                n: slots,
            };
            solver.run(src);
            solver.dist
        }
        Some(w) => dijkstra(graph, src, slots, w, &passes),
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
    weights: Option<&[f64]>,
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
    let weight = |a: &Adj| -> f64 { weights.map_or(1.0, |w| w[a.eidx as usize]) };

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

/// Weighted Dijkstra f64 distance, `INFINITY` for unreached. `weights` is the
/// precomputed per-edge weight (indexed by edge id); negative weights are out of
/// contract (Dijkstra).
fn dijkstra(
    graph: &Graph,
    src: u32,
    slots: usize,
    weights: &[f64],
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
            let nd = du + weights[a.eidx as usize];
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

// ---- BMSSP backend (Duan–Mao–Mao–Shu–Yin 2025, arXiv:2504.17033) -----------
//
// A bounded-recursion exact SSSP that "breaks the sorting barrier"
// (O(m·log^{2/3} n) in theory). This is a FAITHFUL implementation of the paper's
// Algorithms 1–3 with two deliberate, correctness-preserving simplifications:
//   • the Lemma 3.3 block structure D is replaced by a `BTreeSet` stand-in with
//     the same Insert / BatchPrepend / Pull *semantics* (correct + deterministic;
//     it costs O(log) per op instead of the amortized block bound — so we get the
//     right distances but Dijkstra-ish asymptotics, not the log^{2/3} factor);
//   • the constant-in/out-degree transform (paper §2) is skipped — it affects only
//     the complexity bound, never the result.
// Because a vertex's shortest distance is the canonical minimum over path costs,
// this yields the IDENTICAL f64 distances as `dijkstra` (proof: dist[v] = min over
// in-neighbours of dist[u]+w — a min over a fixed f64 multiset), so it is a
// drop-in backend, validated exhaustively against Dijkstra.

/// The paper's data structure D (Lemma 3.3), stand-in: an ordered set keyed on
/// `(distance-bits, vertex)` with decrease-key `insert`, and `pull` returning the
/// `M` smallest keys plus a separating bound. A non-negative finite `f64`'s
/// `to_bits()` is monotonic, so ordering by bits == ordering by distance, with the
/// vertex id as a deterministic tie-break.
struct BmsspSet {
    ord: BTreeSet<(u64, u32)>,
    /// Current distance-bits per key (decrease-key dedup).
    at: HashMap<u32, u64>,
    /// The bound `B` this structure was created with (the empty-Pull separator).
    bound: f64,
}

impl BmsspSet {
    fn new(bound: f64) -> Self {
        Self {
            ord: BTreeSet::new(),
            at: HashMap::new(),
            bound,
        }
    }

    /// Insert `⟨v, val⟩`, keeping the smaller value if `v` is already present.
    /// (`BatchPrepend` is just repeated `insert` here: the paper's precondition —
    /// all prepended values below the current minimum — is guaranteed by the
    /// caller and unnecessary for the ordered-set stand-in.)
    fn insert(&mut self, v: u32, val: f64) {
        let bits = val.to_bits();
        if let Some(&old) = self.at.get(&v) {
            if old <= bits {
                return;
            }
            self.ord.remove(&(old, v));
        }
        self.ord.insert((bits, v));
        self.at.insert(v, bits);
    }

    fn is_empty(&self) -> bool {
        self.ord.is_empty()
    }

    /// Remove and return the ≤ `m` smallest keys, and the separator: the smallest
    /// remaining value, or `bound` if the structure is now empty.
    fn pull(&mut self, m: usize) -> (f64, Vec<u32>) {
        let mut keys = Vec::new();
        for _ in 0..m {
            let Some((_, v)) = self.ord.pop_first() else {
                break;
            };
            self.at.remove(&v);
            keys.push(v);
        }
        let sep = self
            .ord
            .iter()
            .next()
            .map_or(self.bound, |&(bits, _)| f64::from_bits(bits));
        (sep, keys)
    }
}

/// BMSSP solver over a fixed graph + edge weights. `dist` is the tentative-distance
/// array `d̂`, mutated in place (the final answer is read from it after `run`).
struct Bmssp<'a, P: Fn(&Adj) -> bool> {
    graph: &'a Graph,
    weights: &'a [f64],
    passes: &'a P,
    dist: Vec<f64>,
    /// Whether a vertex has entered *some* returned `U` — the paper's `U` sets are
    /// globally disjoint (each vertex settled exactly once), so this both dedups the
    /// result and keeps the work-threshold count honest (a dup-inflated `|U|` would
    /// trip a premature partial-exit and drop reachable vertices).
    in_u: Vec<bool>,
    k: usize,
    t: usize,
    n: usize,
}

impl<P: Fn(&Adj) -> bool> Bmssp<'_, P> {
    /// Top-level driver: set the parameters (k = ⌊log^{1/3} n⌋, t = ⌊log^{2/3} n⌋),
    /// then one `BMSSP(⌈log n / t⌉, +∞, {src})` call settles all reachable vertices.
    fn run(&mut self, src: u32) {
        self.dist[src as usize] = 0.0;
        let log2n = (self.n.max(2) as f64).log2();
        self.k = (log2n.powf(1.0 / 3.0).floor() as usize).max(1);
        self.t = (log2n.powf(2.0 / 3.0).floor() as usize).max(1);
        let top = ((log2n / self.t as f64).ceil() as usize).max(1);
        self.bmssp(top, f64::INFINITY, vec![src]);
    }

    /// `2^(shift)`, capped at `n+1` (values only ever bound set sizes ≤ n, so the
    /// cap is semantically free and avoids overflow when `shift` is large).
    fn pow2_capped(&self, shift: usize) -> usize {
        if shift >= 62 {
            self.n + 1
        } else {
            (1usize << shift).min(self.n + 1)
        }
    }

    /// Algorithm 1 — FindPivots(B, S): `k` rounds of bounded relaxation from `S`
    /// (staying `< B`); returns `(P, W)` where `W` is everything relaxed and `P ⊆ S`
    /// are the pivots (roots of relaxation-forest subtrees of size ≥ `k`). If the
    /// frontier grows past `k·|S|`, bail early with `P = S`.
    fn find_pivots(&mut self, b: f64, s: &[u32]) -> (Vec<u32>, Vec<u32>) {
        let mut w_all: Vec<u32> = s.to_vec();
        let mut in_w: HashSet<u32> = s.iter().copied().collect();
        let mut frontier: Vec<u32> = s.to_vec();

        for _ in 0..self.k {
            let mut next = Vec::new();
            for &u in &frontier {
                let du = self.dist[u as usize];
                for a in self.graph.out_adj(u) {
                    if !(self.passes)(&a) {
                        continue;
                    }
                    let nd = du + self.weights[a.eidx as usize];
                    if nd < self.dist[a.nbr as usize] {
                        self.dist[a.nbr as usize] = nd;
                        if nd < b {
                            if in_w.insert(a.nbr) {
                                w_all.push(a.nbr);
                            }
                            next.push(a.nbr);
                        }
                    }
                }
            }
            frontier = next;
            // Once the relaxed frontier is large, stop early (the paper's pivot
            // condition) — either way we return P = S below.
            if w_all.len() > self.k * s.len() {
                break;
            }
        }

        // P = S: returning every source is CORRECT — S dominates every sub-B vertex
        // by the call precondition. The paper additionally shrinks S to the roots of
        // large relaxation-forest subtrees (a recursion-width optimization); we skip
        // that shrink — it's moot here since the BTreeSet stand-in already forgoes
        // the asymptotic bound, and the forest reduction is the subtle, bug-prone
        // part. `W` (the relaxed set) is still returned for the completeness back-fill.
        (s.to_vec(), w_all)
    }

    /// Algorithm 2 — BaseCase(B, {x}): a mini-Dijkstra bounded by `B`, settling up
    /// to `k+1` vertices. Returns `(B', U)`: either `(B, all ≤ k settled)` if it
    /// cleared the region, or `(the (k+1)-th distance, the k below it)`.
    fn base_case(&mut self, b: f64, x: u32) -> (f64, Vec<u32>) {
        let mut settled: Vec<u32> = Vec::new();
        let mut done: HashSet<u32> = HashSet::new();
        let mut heap = BinaryHeap::new();
        heap.push(State {
            dist: self.dist[x as usize],
            idx: x,
        });
        while let Some(State { dist: du, idx: u }) = heap.pop() {
            if settled.len() > self.k {
                break;
            }
            if du > self.dist[u as usize] || !done.insert(u) {
                continue;
            }
            settled.push(u);
            for a in self.graph.out_adj(u) {
                if !(self.passes)(&a) {
                    continue;
                }
                let nd = self.dist[u as usize] + self.weights[a.eidx as usize];
                // `≤` (not `<`): a neighbour already AT its final distance (lowered
                // earlier by find_pivots) must still be enqueued so it gets settled
                // and its own edges relaxed — else propagation stalls.
                if nd <= self.dist[a.nbr as usize] && nd < b {
                    self.dist[a.nbr as usize] = nd;
                    heap.push(State {
                        dist: nd,
                        idx: a.nbr,
                    });
                }
            }
        }
        if settled.len() <= self.k {
            (b, settled)
        } else {
            let b_prime = settled
                .iter()
                .map(|&v| self.dist[v as usize])
                .fold(f64::NEG_INFINITY, f64::max);
            let u: Vec<u32> = settled
                .into_iter()
                .filter(|&v| self.dist[v as usize] < b_prime)
                .collect();
            (b_prime, u)
        }
    }

    /// Algorithm 3 — BMSSP(l, B, S): the main recursion. Returns `(B', U)` where `U`
    /// is the set of vertices settled with final distance `< B'` (`B' ≤ B`).
    fn bmssp(&mut self, l: usize, b: f64, s: Vec<u32>) -> (f64, Vec<u32>) {
        if l == 0 {
            // Base case operates on a single complete source.
            return self.base_case(b, s[0]);
        }

        let (pivots, w) = self.find_pivots(b, &s);

        let m = self.pow2_capped((l - 1) * self.t);
        let threshold = self.k.saturating_mul(self.pow2_capped(l * self.t));
        let mut d = BmsspSet::new(b);
        for &x in &pivots {
            d.insert(x, self.dist[x as usize]);
        }

        let mut u: Vec<u32> = Vec::new();
        let mut last_b_prime = b;
        while u.len() < threshold && !d.is_empty() {
            let (b_i, s_i) = d.pull(m);
            let (b_prime_i, u_i) = self.bmssp(l - 1, b_i, s_i.clone());
            last_b_prime = b_prime_i;
            for &v in &u_i {
                if !self.in_u[v as usize] {
                    self.in_u[v as usize] = true;
                    u.push(v);
                }
            }

            // Relax out of the newly-settled set; route each improved neighbour into
            // D's range [B_i, B) via insert, or the smaller range [B'_i, B_i) via
            // batch-prepend (which is `insert` for the ordered-set stand-in).
            let mut prepend: Vec<(u32, f64)> = Vec::new();
            for &uu in &u_i {
                let du = self.dist[uu as usize];
                for a in self.graph.out_adj(uu) {
                    if !(self.passes)(&a) {
                        continue;
                    }
                    let nd = du + self.weights[a.eidx as usize];
                    // `≤` so a neighbour at its final tentative distance is still
                    // (re-)offered to D; the range checks below exclude already-
                    // settled vertices (dist < B'_i ≤ B_i), preserving disjointness.
                    if nd <= self.dist[a.nbr as usize] {
                        self.dist[a.nbr as usize] = nd;
                        if b_i <= nd && nd < b {
                            d.insert(a.nbr, nd);
                        } else if b_prime_i <= nd && nd < b_i {
                            prepend.push((a.nbr, nd));
                        }
                    }
                }
            }
            // Re-offer pulled sources the recursion did not finalize below B'_i.
            for &x in &s_i {
                let dx = self.dist[x as usize];
                if b_prime_i <= dx && dx < b_i {
                    prepend.push((x, dx));
                }
            }
            for (v, val) in prepend {
                d.insert(v, val);
            }
        }

        // Success (D emptied) settles the whole region below B; a partial stop
        // (hit the work threshold) settles below the last sub-boundary B'_i.
        let b_prime = if d.is_empty() { b } else { last_b_prime };
        for &x in &w {
            if self.dist[x as usize] < b_prime && !self.in_u[x as usize] {
                self.in_u[x as usize] = true;
                u.push(x);
            }
        }
        (b_prime, u)
    }
}
