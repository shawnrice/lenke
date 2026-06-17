//! The Gremlin executor: runs a [`Traversal`]'s [`Step`] list over a stream of
//! traversers against the columnar [`Graph`]. Eager (Vec-per-step) — the modest
//! result scale doesn't need lazy iterators, and it keeps step semantics
//! readable. Movement/projection steps extend each traverser's path; filters
//! pass traversers through unchanged. `by()` modulators resolve via [`eval_by`].

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::{By, Endpoint, GVal, Order, Pop, Scope, Step, Token, Traversal, P};
use crate::graph::{Graph, IdxKey, RangeBound, Value};

/// A unit flowing through the pipeline: its value, the path it took, `as(label)`
/// tags (label → accumulated values, for `select` pop), and the repeat loop count.
#[derive(Clone)]
struct Trav {
    val: GVal,
    path: Vec<GVal>,
    tags: Vec<(String, Vec<GVal>)>,
    loops: usize,
}

impl Trav {
    fn root(val: GVal) -> Trav {
        Trav { path: vec![val.clone()], val, tags: Vec::new(), loops: 0 }
    }
    /// A successor that moved to `val` (extends path, keeps tags/loops).
    fn step(&self, val: GVal) -> Trav {
        let mut path = self.path.clone();
        path.push(val.clone());
        Trav { val, path, tags: self.tags.clone(), loops: self.loops }
    }
    /// Same traverser with a replaced value, keeping the existing path tail.
    fn with(&self, val: GVal) -> Trav {
        let mut path = self.path.clone();
        path.push(val.clone());
        Trav { val, path, tags: self.tags.clone(), loops: self.loops }
    }
    fn recall(&self, label: &str, pop: Pop) -> Option<GVal> {
        let list = &self.tags.iter().find(|(l, _)| l == label)?.1;
        match pop {
            _ if list.is_empty() => None,
            Pop::First => Some(list[0].clone()),
            Pop::Last => Some(list[list.len() - 1].clone()),
            Pop::All => Some(GVal::List(list.clone())),
        }
    }
}

/// Per-run mutable context: named side-effect bags for `aggregate`/`store`/`cap`,
/// plus `subgraph(key)` accumulators (deduped (vertex ids, edge ids)).
#[derive(Default)]
struct Ctx {
    side: HashMap<String, Vec<GVal>>,
    subgraphs: HashMap<String, (Vec<u32>, Vec<u32>)>,
}

/// Run a traversal against `graph`, returning the final traversers' values.
pub fn run(graph: &mut Graph, t: &Traversal) -> Vec<GVal> {
    let mut ctx = Ctx::default();
    // Index seeding: `V().has(key, pred)` on an indexed key seeds from the
    // property index (skipping the full label scan + the now-satisfied `has`).
    let (seed, start) = match index_seed(graph, &t.steps) {
        Some(s) => (s, 2),
        None => (Vec::new(), 0),
    };
    run_steps(graph, &mut ctx, &t.steps[start..], seed).into_iter().map(|t| t.val).collect()
}

fn gval_to_idxkey(v: &GVal) -> Option<IdxKey> {
    match v {
        GVal::Str(s) => Some(IdxKey::Str(s.clone())),
        GVal::Num(n) => Some(IdxKey::Num(*n)),
        GVal::Bool(b) => Some(IdxKey::Bool(*b)),
        _ => None,
    }
}

/// The smallest string strictly greater than every string with prefix `s`
/// (for `startsWith` → `[s, s⁺)`). `None` ⇒ no upper bound (e.g. empty prefix).
fn prefix_upper(s: &str) -> Option<String> {
    let mut bytes = s.as_bytes().to_vec();
    while let Some(&last) = bytes.last() {
        if last < 0xff {
            *bytes.last_mut().unwrap() = last + 1;
            return String::from_utf8(bytes).ok();
        }
        bytes.pop();
    }
    None
}

/// If the plan opens with `V().has(key, pred)` / `E().has(key, pred)` on an
/// indexed key and `pred` is index-seekable (eq / within / range / startsWith),
/// return the seeded elements (the `has` is then fully satisfied by the index).
/// `None` ⇒ fall back to scan.
fn index_seed(graph: &Graph, steps: &[Step]) -> Option<Vec<Trav>> {
    let (key, pred, is_edge) = match steps {
        [Step::V(ids), Step::Has(k, p), ..] if ids.is_empty() && graph.vertex_indexed(k) => (k, p, false),
        [Step::E(ids), Step::Has(k, p), ..] if ids.is_empty() && graph.edge_indexed(k) => (k, p, true),
        _ => return None,
    };
    let eq = |k: &IdxKey| if is_edge { graph.edges_by_prop(key, k) } else { graph.vertices_by_prop(key, k) };
    let rng = |b: RangeBound| if is_edge { graph.edges_by_prop_range(key, &b) } else { graph.vertices_by_prop_range(key, &b) };
    let ids: Vec<u32> = match pred {
        P::Eq(v) => eq(&gval_to_idxkey(v)?)?.to_vec(),
        P::Within(vs) => {
            let mut out = Vec::new();
            for v in vs {
                if let Some(k) = gval_to_idxkey(v) {
                    if let Some(s) = eq(&k) {
                        out.extend_from_slice(s);
                    }
                }
            }
            out
        }
        P::Gt(v) => rng(RangeBound { gt: gval_to_idxkey(v), ..Default::default() })?,
        P::Gte(v) => rng(RangeBound { gte: gval_to_idxkey(v), ..Default::default() })?,
        P::Lt(v) => rng(RangeBound { lt: gval_to_idxkey(v), ..Default::default() })?,
        P::Lte(v) => rng(RangeBound { lte: gval_to_idxkey(v), ..Default::default() })?,
        P::Between(lo, hi) => rng(RangeBound { gte: gval_to_idxkey(lo), lt: gval_to_idxkey(hi), ..Default::default() })?,
        P::Inside(lo, hi) => rng(RangeBound { gt: gval_to_idxkey(lo), lt: gval_to_idxkey(hi), ..Default::default() })?,
        P::Outside(lo, hi) => {
            let mut out = rng(RangeBound { lt: gval_to_idxkey(lo), ..Default::default() })?;
            out.extend(rng(RangeBound { gt: gval_to_idxkey(hi), ..Default::default() })?);
            out
        }
        P::StartsWith(prefix) => {
            let lo = Some(IdxKey::Str(prefix.as_str().into()));
            let hi = prefix_upper(prefix).map(|u| IdxKey::Str(u.as_str().into()));
            rng(RangeBound { gte: lo, lt: hi, ..Default::default() })?
        }
        _ => return None,
    };
    let mk = |id: u32| if is_edge { GVal::Edge(id) } else { GVal::Vertex(id) };
    Some(ids.into_iter().map(|id| Trav::root(mk(id))).collect())
}

/// Serialize traversal results to a JSON array string — the FFI carrier. Graph
/// elements become `{"id":…,"label":…}`; lists → arrays; maps → objects.
pub fn results_to_json(graph: &Graph, vals: &[GVal]) -> String {
    let arr = serde_json::Value::Array(vals.iter().map(|v| gval_json(graph, v)).collect());
    arr.to_string()
}

fn gval_json(graph: &Graph, v: &GVal) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        GVal::Null => J::Null,
        GVal::Bool(b) => J::Bool(*b),
        GVal::Num(n) => serde_json::Number::from_f64(*n).map(J::Number).unwrap_or(J::Null),
        GVal::Str(s) => J::String(s.to_string()),
        GVal::Vertex(_) | GVal::Edge(_) => {
            let id = match elem_id(graph, v) {
                GVal::Str(s) => s.to_string(),
                _ => String::new(),
            };
            let label = match elem_label(graph, v) {
                GVal::Str(s) => s.to_string(),
                _ => String::new(),
            };
            J::Object(serde_json::Map::from_iter([("id".to_string(), J::String(id)), ("label".to_string(), J::String(label))]))
        }
        GVal::List(items) => J::Array(items.iter().map(|x| gval_json(graph, x)).collect()),
        GVal::Map(entries) => {
            let mut m = serde_json::Map::new();
            for (k, val) in entries {
                let key = match k {
                    GVal::Str(s) => s.to_string(),
                    other => match gval_json(graph, other) {
                        J::String(s) => s,
                        j => j.to_string(),
                    },
                };
                m.insert(key, gval_json(graph, val));
            }
            J::Object(m)
        }
    }
}

fn run_steps(graph: &mut Graph, ctx: &mut Ctx, steps: &[Step], mut stream: Vec<Trav>) -> Vec<Trav> {
    for step in steps {
        stream = apply(graph, ctx, step, stream);
    }
    stream
}

/// Run a sub-plan from a single seed value; collect its output values.
fn sub_vals(graph: &mut Graph, ctx: &mut Ctx, plan: &Traversal, seed: &Trav) -> Vec<GVal> {
    run_steps(graph, ctx, &plan.steps, vec![seed.clone()]).into_iter().map(|t| t.val).collect()
}

fn sub_nonempty(graph: &mut Graph, ctx: &mut Ctx, plan: &Traversal, seed: &Trav) -> bool {
    !run_steps(graph, ctx, &plan.steps, vec![seed.clone()]).is_empty()
}

// --- match() solver ---------------------------------------------------------
//
// Port of the TS `executor/match.ts`. Each pattern is `as(start) … [as(end)]`:
// from the value bound to `start`, run the inner traversal, then bind `end` to
// the output (if unbound) or filter against it (if bound). No trailing `as` ⇒ a
// pure filter on `start`; a `not(...)`/`where(...)` wrapper ⇒ a (negated) filter.
// `GVal` already compares graph elements by their dense id, so `==` is identity.

struct MatchPattern {
    start_key: String,
    end_key: Option<String>,
    inner: Traversal,
    negated: bool,
}

/// Lower one pattern plan into a {@link MatchPattern}.
fn parse_pattern(plan: &Traversal) -> MatchPattern {
    let steps = &plan.steps;
    // `not(inner)` / `where(inner)` filter wrappers (single step): parse the inner
    // pattern and flip negation (`where` keeps it positive).
    if steps.len() == 1 {
        if let Step::Not(inner) = &steps[0] {
            let mut p = parse_pattern(inner);
            p.negated = !p.negated;
            return p;
        }
        if let Step::Where(inner) = &steps[0] {
            return parse_pattern(inner);
        }
    }
    let start_key = match steps.first() {
        Some(Step::As(l)) => l.clone(),
        // Malformed (no leading as): an unbindable start ⇒ the pattern never runs.
        _ => String::new(),
    };
    if steps.len() >= 2 {
        if let Some(Step::As(end)) = steps.last() {
            let inner = Traversal { steps: steps[1..steps.len() - 1].to_vec() };
            return MatchPattern { start_key, end_key: Some(end.clone()), inner, negated: false };
        }
    }
    let inner = Traversal { steps: steps.get(1..).unwrap_or(&[]).to_vec() };
    MatchPattern { start_key, end_key: None, inner, negated: false }
}

/// The seed label: a pattern *start* that is never a binding *end* (a source).
fn match_start_label(patterns: &[MatchPattern]) -> String {
    let ends: Vec<&String> =
        patterns.iter().filter(|p| !p.negated).filter_map(|p| p.end_key.as_ref()).collect();
    for p in patterns {
        if !ends.iter().any(|e| **e == p.start_key) {
            return p.start_key.clone();
        }
    }
    patterns.first().map(|p| p.start_key.clone()).unwrap_or_default()
}

/// `t` with `key` bound to a single `val` (match binds each label once).
fn match_bind(t: &Trav, key: &str, val: GVal) -> Trav {
    let mut nt = t.clone();
    match nt.tags.iter_mut().find(|(l, _)| l == key) {
        Some((_, list)) => *list = vec![val],
        None => nt.tags.push((key.to_string(), vec![val])),
    }
    nt
}

/// Apply one pattern to a traverser, returning the consistent continuations.
fn apply_pattern(graph: &mut Graph, ctx: &mut Ctx, p: &MatchPattern, t: &Trav) -> Vec<Trav> {
    let Some(start_val) = t.recall(&p.start_key, Pop::Last) else {
        return vec![];
    };
    let seed = Trav { val: start_val, path: t.path.clone(), tags: t.tags.clone(), loops: t.loops };
    let outs = sub_vals(graph, ctx, &p.inner, &seed);
    let bound_end = p.end_key.as_ref().and_then(|k| t.recall(k, Pop::Last));

    if p.negated {
        let satisfiable = outs.iter().any(|o| bound_end.as_ref().is_none_or(|b| o == b));
        return if satisfiable { vec![] } else { vec![t.clone()] };
    }
    let Some(end_key) = &p.end_key else {
        return if outs.is_empty() { vec![] } else { vec![t.clone()] }; // pure filter
    };
    if let Some(b) = bound_end {
        return if outs.iter().any(|o| *o == b) { vec![t.clone()] } else { vec![] };
    }
    // Bind the end label, one branch per distinct candidate value.
    let mut seen: Vec<GVal> = Vec::new();
    let mut branches = Vec::new();
    for o in outs {
        if seen.iter().any(|s| *s == o) {
            continue;
        }
        seen.push(o.clone());
        branches.push(match_bind(t, end_key, o));
    }
    branches
}

/// Pick a not-yet-applied pattern whose start is bound, preferring binders.
fn pick_runnable(patterns: &[MatchPattern], done: &[bool], t: &Trav) -> Option<usize> {
    let mut negated = None;
    for (i, p) in patterns.iter().enumerate() {
        if done[i] || t.recall(&p.start_key, Pop::Last).is_none() {
            continue;
        }
        if !p.negated {
            return Some(i);
        }
        if negated.is_none() {
            negated = Some(i);
        }
    }
    negated
}

/// Depth-first join: apply runnable patterns until all are satisfied, emitting
/// one traverser (carrying the binding tags) per consistent assignment.
fn match_solve(
    graph: &mut Graph,
    ctx: &mut Ctx,
    patterns: &[MatchPattern],
    t: Trav,
    done: &mut Vec<bool>,
    out: &mut Vec<Trav>,
) {
    if done.iter().all(|&d| d) {
        // Emit the binding map as the value (TinkerPop-faithful); tags carry the
        // bindings for any following select(...).
        let bindings: Vec<(GVal, GVal)> = t
            .tags
            .iter()
            .filter_map(|(l, vs)| vs.last().map(|v| (GVal::Str(Arc::from(l.as_str())), v.clone())))
            .collect();
        out.push(t.with(GVal::Map(bindings)));
        return;
    }
    let Some(idx) = pick_runnable(patterns, done, &t) else {
        return; // stuck: this branch contributes nothing
    };
    done[idx] = true;
    for t2 in apply_pattern(graph, ctx, &patterns[idx], &t) {
        match_solve(graph, ctx, patterns, t2, done, out);
    }
    done[idx] = false; // backtrack
}

// --- shortestPath() solver --------------------------------------------------
//
// Port of the TS executor/shortest-path.ts: unweighted BFS over incident edges
// (both directions), emitting all shortest vertex paths from each source.

/// All shortest (fewest-hop) vertex paths from `src` to each destination, as
/// vertex-index arrays `[src, …, dest]`. `targets` (None ⇒ every reached vertex)
/// filters destinations; equal-length alternatives are all returned.
fn shortest_paths_from(graph: &Graph, src: u32, targets: Option<&HashSet<u32>>) -> Vec<Vec<u32>> {
    let mut dist: HashMap<u32, usize> = HashMap::from([(src, 0)]);
    let mut preds: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut frontier = vec![src];
    while !frontier.is_empty() {
        let mut next = Vec::new();
        for &v in &frontier {
            let d = dist[&v];
            for (_, n) in adj_in_label_order(graph, v, true, true, &[]) {
                match dist.get(&n).copied() {
                    None => {
                        dist.insert(n, d + 1);
                        preds.insert(n, vec![v]);
                        next.push(n);
                    }
                    Some(nd) if nd == d + 1 => preds.entry(n).or_default().push(v),
                    _ => {}
                }
            }
        }
        frontier = next;
    }
    let mut paths = Vec::new();
    for &id in dist.keys() {
        if targets.is_none_or(|t| t.contains(&id)) {
            build_paths(src, id, &[], &preds, &mut paths);
        }
    }
    paths
}

/// Reconstruct every shortest path to `id` by walking predecessors back to `src`.
fn build_paths(src: u32, id: u32, tail: &[u32], preds: &HashMap<u32, Vec<u32>>, out: &mut Vec<Vec<u32>>) {
    let mut path = vec![id];
    path.extend_from_slice(tail);
    if id == src {
        out.push(path);
        return;
    }
    for &p in preds.get(&id).map(Vec::as_slice).unwrap_or_default() {
        build_paths(src, p, &path, preds, out);
    }
}

fn shortest_path_step(graph: &mut Graph, ctx: &mut Ctx, target: Option<&Traversal>, stream: Vec<Trav>) -> Vec<Trav> {
    // Resolve the destination set once: run the target sub-plan over every vertex.
    // Collect the indices first so the immutable borrow is released before the
    // mutable `run_steps` call inside the filter.
    let targets: Option<HashSet<u32>> = target.map(|plan| {
        let verts: Vec<u32> = graph.vertex_indices().collect();
        verts
            .into_iter()
            .filter(|&v| !run_steps(graph, ctx, &plan.steps, vec![Trav::root(GVal::Vertex(v))]).is_empty())
            .collect()
    });
    let mut next = Vec::new();
    for t in &stream {
        if let GVal::Vertex(src) = t.val {
            for path in shortest_paths_from(graph, src, targets.as_ref()) {
                next.push(t.with(GVal::List(path.into_iter().map(GVal::Vertex).collect())));
            }
        }
    }
    next
}

fn match_step(graph: &mut Graph, ctx: &mut Ctx, plans: &[Traversal], stream: Vec<Trav>) -> Vec<Trav> {
    let patterns: Vec<MatchPattern> = plans.iter().map(parse_pattern).collect();
    let start_label = match_start_label(&patterns);
    let mut out = Vec::new();
    for t in stream {
        // Seed the source label from the incoming value unless already bound.
        let seed = if t.recall(&start_label, Pop::Last).is_some() {
            t
        } else {
            let v = t.val.clone();
            match_bind(&t, &start_label, v)
        };
        let mut done = vec![false; patterns.len()];
        match_solve(graph, ctx, &patterns, seed, &mut done, &mut out);
    }
    out
}

// --- value helpers ----------------------------------------------------------

fn value_to_gval(v: Value) -> GVal {
    match v {
        Value::Null => GVal::Null,
        Value::Bool(b) => GVal::Bool(b),
        Value::Num(n) => GVal::Num(n),
        Value::Str(s) => GVal::Str(s),
        Value::List(items) => GVal::List(items.into_iter().map(value_to_gval).collect()),
    }
}

fn gval_to_value(v: &GVal) -> Value {
    match v {
        GVal::Null => Value::Null,
        GVal::Bool(b) => Value::Bool(*b),
        GVal::Num(n) => Value::Num(*n),
        GVal::Str(s) => Value::Str(s.clone()),
        GVal::List(items) => Value::List(items.iter().map(gval_to_value).collect()),
        _ => Value::Null,
    }
}

fn prop(graph: &Graph, v: &GVal, key: &str) -> GVal {
    match v {
        GVal::Vertex(i) => value_to_gval(graph.props.value(*i as usize, key, &graph.strs)),
        GVal::Edge(e) => value_to_gval(graph.edge_props.value(*e as usize, key, &graph.strs)),
        _ => GVal::Null,
    }
}

/// A `{ key: value }` map of an element's present (non-null) properties.
fn element_props_map(graph: &Graph, v: &GVal) -> GVal {
    let entries: Vec<(GVal, GVal)> = present_keys(graph, v)
        .into_iter()
        .filter_map(|k| {
            let pv = prop(graph, v, &k);
            (pv != GVal::Null).then(|| (GVal::Str(Arc::from(k.as_str())), pv))
        })
        .collect();
    GVal::Map(entries)
}

/// A self-describing vertex record for a subgraph cap: `{ id, labels, properties }`.
fn subgraph_vertex(graph: &Graph, v: u32) -> GVal {
    let gv = GVal::Vertex(v);
    let labels: Vec<GVal> =
        graph.vertex_labels(v).iter().map(|&l| GVal::Str(graph.labels.arc(l))).collect();
    GVal::Map(vec![
        (GVal::Str(Arc::from("id")), GVal::Str(graph.vid.arc(v))),
        (GVal::Str(Arc::from("labels")), GVal::List(labels)),
        (GVal::Str(Arc::from("properties")), element_props_map(graph, &gv)),
    ])
}

/// A self-describing edge record: `{ id, label, outV, inV, properties }`.
fn subgraph_edge(graph: &Graph, e: u32) -> GVal {
    let ge = GVal::Edge(e);
    let outv = GVal::Vertex(graph.e_src[e as usize]);
    let inv = GVal::Vertex(graph.e_dst[e as usize]);
    GVal::Map(vec![
        (GVal::Str(Arc::from("id")), elem_id(graph, &ge)),
        (GVal::Str(Arc::from("label")), GVal::Str(graph.etype.arc(graph.e_type[e as usize]))),
        (GVal::Str(Arc::from("outV")), elem_id(graph, &outv)),
        (GVal::Str(Arc::from("inV")), elem_id(graph, &inv)),
        (GVal::Str(Arc::from("properties")), element_props_map(graph, &ge)),
    ])
}

fn present_keys(graph: &Graph, v: &GVal) -> Vec<String> {
    let (store, idx) = match v {
        GVal::Vertex(i) => (&graph.props, *i as usize),
        GVal::Edge(e) => (&graph.edge_props, *e as usize),
        _ => return Vec::new(),
    };
    (0..store.keys.len() as u32)
        .filter(|&kid| !matches!(store.value_id(idx, kid, &graph.strs), Value::Null))
        .map(|kid| store.keys.text(kid).to_string())
        .collect()
}

fn elem_id(graph: &Graph, v: &GVal) -> GVal {
    match v {
        GVal::Vertex(i) => GVal::Str(graph.vid.arc(*i)),
        // External edge id if one was assigned, else the canonical `e{index}`.
        GVal::Edge(e) => GVal::Str(match graph.edge_id(*e) {
            Some(id) => Arc::from(id),
            None => Arc::from(format!("e{e}").as_str()),
        }),
        other => other.clone(),
    }
}

fn elem_label(graph: &Graph, v: &GVal) -> GVal {
    match v {
        GVal::Vertex(i) => match graph.vertex_labels(*i).first() {
            Some(&lid) => GVal::Str(graph.labels.arc(lid)),
            None => GVal::Null,
        },
        GVal::Edge(e) => GVal::Str(graph.etype.arc(graph.e_type[*e as usize])),
        _ => GVal::Null,
    }
}

fn gnum(v: &GVal) -> Option<f64> {
    match v {
        GVal::Num(n) => Some(*n),
        GVal::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        GVal::Str(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn gcmp(a: &GVal, b: &GVal) -> Option<Ordering> {
    if let (Some(x), Some(y)) = (gnum(a), gnum(b)) {
        return x.partial_cmp(&y);
    }
    match (a, b) {
        (GVal::Str(x), GVal::Str(y)) => Some(x.as_ref().cmp(y.as_ref())),
        _ => None,
    }
}

fn p_matches(p: &P, v: &GVal) -> bool {
    let cmp = |t: &GVal, want: Ordering| gcmp(v, t) == Some(want);
    let ge = |t: &GVal| matches!(gcmp(v, t), Some(Ordering::Greater | Ordering::Equal));
    let le = |t: &GVal| matches!(gcmp(v, t), Some(Ordering::Less | Ordering::Equal));
    let s = |g: &GVal| match g {
        GVal::Str(s) => Some(s.to_string()),
        _ => None,
    };
    match p {
        P::Eq(t) => v == t,
        P::Neq(t) => v != t,
        P::Gt(t) => cmp(t, Ordering::Greater),
        P::Lt(t) => cmp(t, Ordering::Less),
        P::Gte(t) => ge(t),
        P::Lte(t) => le(t),
        P::Between(lo, hi) => ge(lo) && cmp(hi, Ordering::Less),
        P::Inside(lo, hi) => cmp(lo, Ordering::Greater) && cmp(hi, Ordering::Less),
        P::Outside(lo, hi) => cmp(lo, Ordering::Less) || cmp(hi, Ordering::Greater),
        P::Within(vs) => vs.contains(v),
        P::Without(vs) => !vs.contains(v),
        P::StartsWith(p) => s(v).is_some_and(|x| x.starts_with(p)),
        P::EndingWith(p) => s(v).is_some_and(|x| x.ends_with(p)),
        P::Containing(p) => s(v).is_some_and(|x| x.contains(p)),
        P::NotContaining(p) => s(v).is_some_and(|x| !x.contains(p)),
        P::Not(inner) => !p_matches(inner, v),
    }
}

fn token_project(graph: &Graph, tok: Token, v: &GVal) -> GVal {
    match tok {
        Token::Id => elem_id(graph, v),
        Token::Label => elem_label(graph, v),
        Token::Key | Token::Value => match v {
            // Project a {key, value} property map.
            GVal::Map(entries) => {
                let want = if tok == Token::Key { "key" } else { "value" };
                entries.iter().find(|(k, _)| matches!(k, GVal::Str(s) if s.as_ref() == want)).map(|(_, x)| x.clone()).unwrap_or(GVal::Null)
            }
            _ => GVal::Null,
        },
    }
}

/// Resolve a `by()` modulator against `value`.
fn eval_by(graph: &mut Graph, ctx: &mut Ctx, by: &By, value: &GVal) -> GVal {
    match by {
        By::Identity(_) => value.clone(),
        By::Key(key, _) => match value {
            GVal::Vertex(_) | GVal::Edge(_) => prop(graph, value, key),
            _ => value.clone(),
        },
        By::Token(tok, _) => token_project(graph, *tok, value),
        By::Traversal(plan, _) => sub_vals(graph, ctx, plan, &Trav::root(value.clone())).into_iter().next().unwrap_or(GVal::Null),
    }
}

/// Elements of a value for `Scope::local` (non-string iterables; else singleton).
fn local_elems(v: &GVal) -> Vec<GVal> {
    match v {
        GVal::List(items) => items.clone(),
        other => vec![other.clone()],
    }
}

// --- per-step application ---------------------------------------------------

fn apply(graph: &mut Graph, ctx: &mut Ctx, step: &Step, stream: Vec<Trav>) -> Vec<Trav> {
    match step {
        // --- sources (root) / re-source (mid-traversal, carrying tags) ---
        Step::V(ids) => {
            let verts: Vec<u32> = if ids.is_empty() {
                graph.vertex_indices().collect()
            } else {
                ids.iter().filter_map(|id| graph.vid.get(id)).filter(|&v| graph.is_vertex_live(v)).collect()
            };
            if stream.is_empty() {
                verts.into_iter().map(|v| Trav::root(GVal::Vertex(v))).collect()
            } else {
                stream.iter().flat_map(|t| verts.iter().map(move |&v| t.step(GVal::Vertex(v)))).collect()
            }
        }
        Step::E(ids) => {
            let edges: Vec<u32> = (0..graph.e_src.len() as u32)
                .filter(|&e| graph.is_edge_live(e))
                .filter(|&e| ids.is_empty() || ids.iter().any(|i| i == &format!("e{e}")))
                .collect();
            if stream.is_empty() {
                edges.into_iter().map(|e| Trav::root(GVal::Edge(e))).collect()
            } else {
                stream.iter().flat_map(|t| edges.iter().map(move |&e| t.step(GVal::Edge(e)))).collect()
            }
        }

        // --- vertex → vertex (multi-label emits in label-arg order) ---
        Step::Out(labels) | Step::In(labels) | Step::Both(labels) => {
            let (out, inn) = dir_flags(step);
            let mut next = Vec::new();
            for t in &stream {
                if let GVal::Vertex(v) = t.val {
                    for a in adj_in_label_order(graph, v, out, inn, labels) {
                        next.push(t.step(GVal::Vertex(a.1)));
                    }
                }
            }
            next
        }

        // --- vertex → edge ---
        Step::OutE(labels) | Step::InE(labels) | Step::BothE(labels) => {
            let (out, inn) = dir_flags(step);
            let mut next = Vec::new();
            for t in &stream {
                if let GVal::Vertex(v) = t.val {
                    for a in adj_in_label_order(graph, v, out, inn, labels) {
                        next.push(t.step(GVal::Edge(a.0)));
                    }
                }
            }
            next
        }

        // --- edge → vertex ---
        Step::OutV => map_step(stream, |t| match t.val {
            GVal::Edge(e) => vec![GVal::Vertex(graph.e_src[e as usize])],
            _ => vec![],
        }),
        Step::InV => map_step(stream, |t| match t.val {
            GVal::Edge(e) => vec![GVal::Vertex(graph.e_dst[e as usize])],
            _ => vec![],
        }),
        Step::BothV => map_step(stream, |t| match t.val {
            GVal::Edge(e) => vec![GVal::Vertex(graph.e_src[e as usize]), GVal::Vertex(graph.e_dst[e as usize])],
            _ => vec![],
        }),
        Step::OtherV => {
            let mut next = Vec::new();
            for t in &stream {
                if let GVal::Edge(e) = t.val {
                    let (src, dst) = (graph.e_src[e as usize], graph.e_dst[e as usize]);
                    let from = t.path.iter().rev().nth(1).and_then(|g| match g {
                        GVal::Vertex(v) => Some(*v),
                        _ => None,
                    });
                    next.push(t.step(GVal::Vertex(if from == Some(src) { dst } else { src })));
                }
            }
            next
        }

        // --- filters ---
        Step::Has(key, pred) => stream.into_iter().filter(|t| p_matches(pred, &prop(graph, &t.val, key))).collect(),
        Step::HasLabel(labels) => stream
            .into_iter()
            .filter(|t| matches!(elem_label(graph, &t.val), GVal::Str(ref s) if labels.iter().any(|l| l == s.as_ref())))
            .collect(),
        Step::HasId(ids) => stream.into_iter().filter(|t| matches!(elem_id(graph, &t.val), GVal::Str(ref s) if ids.iter().any(|i| i == s.as_ref()))).collect(),
        Step::HasKey(keys) => stream
            .into_iter()
            .filter(|t| {
                let present = present_keys(graph, &t.val);
                keys.iter().any(|k| present.iter().any(|p| p == k))
            })
            .collect(),
        Step::HasNot(keys) => stream
            .into_iter()
            .filter(|t| {
                let present = present_keys(graph, &t.val);
                !keys.iter().any(|k| present.iter().any(|p| p == k))
            })
            .collect(),
        Step::HasValue(vals) => stream.into_iter().filter(|t| prop_value_field(&t.val).is_some_and(|v| vals.contains(&v))).collect(),
        Step::Is(pred) => stream.into_iter().filter(|t| p_matches(pred, &t.val)).collect(),
        Step::SimplePath => stream.into_iter().filter(|t| !has_dup(&t.path)).collect(),
        Step::CyclicPath => stream.into_iter().filter(|t| has_dup(&t.path)).collect(),
        Step::Dedupe(bys) => {
            let mut seen: Vec<GVal> = Vec::new();
            let mut next = Vec::new();
            for t in stream {
                let key = match bys.first() {
                    Some(by) => eval_by(graph, ctx, by, &t.val),
                    None => t.val.clone(),
                };
                if !seen.contains(&key) {
                    seen.push(key);
                    next.push(t);
                }
            }
            next
        }

        // --- projection ---
        Step::Values(keys) => {
            let mut next = Vec::new();
            for t in &stream {
                let ks = if keys.is_empty() { present_keys(graph, &t.val) } else { keys.clone() };
                for k in ks {
                    let v = prop(graph, &t.val, &k);
                    if v != GVal::Null {
                        next.push(t.step(v));
                    }
                }
            }
            next
        }
        Step::ValueMap(keys) => map_step(stream, |t| {
            let ks = if keys.is_empty() { present_keys(graph, &t.val) } else { keys.clone() };
            let entries =
                ks.into_iter().map(|k| (GVal::Str(Arc::from(k.as_str())), prop(graph, &t.val, &k))).filter(|(_, v)| *v != GVal::Null).collect();
            vec![GVal::Map(entries)]
        }),
        Step::PropertyMap(keys) => map_step(stream, |t| {
            let ks = if keys.is_empty() { present_keys(graph, &t.val) } else { keys.clone() };
            let entries = ks
                .into_iter()
                .filter_map(|k| {
                    let v = prop(graph, &t.val, &k);
                    (v != GVal::Null).then(|| (GVal::Str(Arc::from(k.as_str())), GVal::List(vec![v])))
                })
                .collect();
            vec![GVal::Map(entries)]
        }),
        Step::ElementMap(keys) => map_step(stream, |t| {
            if !matches!(t.val, GVal::Vertex(_) | GVal::Edge(_)) {
                return vec![];
            }
            let mut entries = vec![
                (GVal::Str(Arc::from("id")), elem_id(graph, &t.val)),
                (GVal::Str(Arc::from("label")), elem_label(graph, &t.val)),
            ];
            if let GVal::Edge(e) = t.val {
                let inv = GVal::Vertex(graph.e_dst[e as usize]);
                let outv = GVal::Vertex(graph.e_src[e as usize]);
                entries.push((GVal::Str(Arc::from("IN")), GVal::Map(vec![(GVal::Str(Arc::from("id")), elem_id(graph, &inv)), (GVal::Str(Arc::from("label")), elem_label(graph, &inv))])));
                entries.push((GVal::Str(Arc::from("OUT")), GVal::Map(vec![(GVal::Str(Arc::from("id")), elem_id(graph, &outv)), (GVal::Str(Arc::from("label")), elem_label(graph, &outv))])));
            }
            let ks = if keys.is_empty() { present_keys(graph, &t.val) } else { keys.clone() };
            for k in ks {
                let v = prop(graph, &t.val, &k);
                if v != GVal::Null {
                    entries.push((GVal::Str(Arc::from(k.as_str())), v));
                }
            }
            vec![GVal::Map(entries)]
        }),
        Step::Properties(keys) => {
            let mut next = Vec::new();
            for t in &stream {
                let ks = if keys.is_empty() { present_keys(graph, &t.val) } else { keys.clone() };
                for k in ks {
                    let v = prop(graph, &t.val, &k);
                    if v != GVal::Null {
                        next.push(t.step(GVal::Map(vec![(GVal::Str(Arc::from("key")), GVal::Str(Arc::from(k.as_str()))), (GVal::Str(Arc::from("value")), v)])));
                    }
                }
            }
            next
        }
        Step::Value => map_step(stream, |t| prop_value_field(&t.val).map(|v| vec![v]).unwrap_or_default()),
        Step::Id => map_step(stream, |t| vec![elem_id(graph, &t.val)]),
        Step::Label => map_step(stream, |t| match &t.val {
            GVal::Map(_) => prop_key_field(&t.val).map(|v| vec![v]).unwrap_or_default(),
            other => vec![elem_label(graph, other)],
        }),
        Step::Path(bys) => stream
            .iter()
            .map(|t| {
                let projected = if bys.is_empty() {
                    t.path.clone()
                } else {
                    t.path.iter().enumerate().map(|(i, v)| eval_by(graph, ctx, &bys[i % bys.len()], v)).collect()
                };
                t.with(GVal::List(projected))
            })
            .collect(),
        Step::Project(keys, bys) => stream
            .iter()
            .map(|t| {
                let entries = keys
                    .iter()
                    .enumerate()
                    .map(|(i, k)| {
                        let v = match bys.get(i) {
                            Some(by) => eval_by(graph, ctx, by, &t.val),
                            None => t.val.clone(),
                        };
                        (GVal::Str(Arc::from(k.as_str())), v)
                    })
                    .collect();
                t.with(GVal::Map(entries))
            })
            .collect(),
        Step::Tree(bys) => {
            // Build a nested map from each traverser's path.
            let mut root: Vec<(GVal, GVal)> = Vec::new();
            for t in &stream {
                let keys: Vec<GVal> = t
                    .path
                    .iter()
                    .enumerate()
                    .map(|(i, v)| if bys.is_empty() { v.clone() } else { eval_by(graph, ctx, &bys[i % bys.len()], v) })
                    .collect();
                insert_tree(&mut root, &keys);
            }
            vec![Trav::root(GVal::Map(root))]
        }

        // --- cardinality ---
        Step::Limit(n, Scope::Global) => stream.into_iter().take(*n).collect(),
        Step::Limit(n, Scope::Local) => map_step(stream, |t| vec![slice_local(&t.val, 0, *n)]),
        Step::Skip(n, Scope::Global) => stream.into_iter().skip(*n).collect(),
        Step::Skip(n, Scope::Local) => map_step(stream, |t| vec![slice_local(&t.val, *n, usize::MAX)]),
        Step::Range(s, e, Scope::Global) => stream.into_iter().skip(*s).take(e.saturating_sub(*s)).collect(),
        Step::Range(s, e, Scope::Local) => map_step(stream, |t| vec![slice_local(&t.val, *s, *e)]),
        Step::Tail(n, Scope::Global) => {
            let len = stream.len();
            stream.into_iter().skip(len.saturating_sub(*n)).collect()
        }
        Step::Tail(n, Scope::Local) => map_step(stream, |t| {
            let e = local_elems(&t.val);
            let start = e.len().saturating_sub(*n);
            vec![GVal::List(e[start..].to_vec())]
        }),
        Step::Sample(n) => stream.into_iter().take(*n).collect(), // deterministic prefix sample

        // --- aggregates ---
        Step::Count(Scope::Global) => vec![Trav::root(GVal::Num(stream.len() as f64))],
        Step::Count(Scope::Local) => map_step(stream, |t| vec![GVal::Num(local_elems(&t.val).len() as f64)]),
        Step::Fold => vec![Trav::root(GVal::List(stream.into_iter().map(|t| t.val).collect()))],
        Step::Sum(Scope::Global) => fold_num(stream, |ns| ns.iter().sum()),
        Step::Sum(Scope::Local) => map_step(stream, |t| vec![local_num(&t.val, |ns| ns.iter().sum())]),
        Step::Mean(Scope::Global) => fold_num(stream, |ns| ns.iter().sum::<f64>() / ns.len() as f64),
        Step::Mean(Scope::Local) => map_step(stream, |t| vec![local_num(&t.val, |ns| ns.iter().sum::<f64>() / ns.len() as f64)]),
        Step::Min(Scope::Global) => fold_extreme(stream, Ordering::Less),
        Step::Min(Scope::Local) => map_step(stream, |t| vec![local_extreme(&t.val, Ordering::Less)]),
        Step::Max(Scope::Global) => fold_extreme(stream, Ordering::Greater),
        Step::Max(Scope::Local) => map_step(stream, |t| vec![local_extreme(&t.val, Ordering::Greater)]),
        Step::Order(bys, desc) => {
            let bys: Vec<By> = if bys.is_empty() { vec![By::Identity(None)] } else { bys.clone() };
            // Precompute sort keys (eval_by needs &mut; can't run inside the comparator).
            let mut keyed: Vec<(Vec<GVal>, Trav)> =
                stream.into_iter().map(|t| (bys.iter().map(|by| eval_by(graph, ctx, by, &t.val)).collect(), t)).collect();
            keyed.sort_by(|(ka, _), (kb, _)| {
                for (i, by) in bys.iter().enumerate() {
                    let dir = by.direction().unwrap_or(if *desc { Order::Desc } else { Order::Asc });
                    let mut o = gcmp(&ka[i], &kb[i]).unwrap_or(Ordering::Equal);
                    if dir == Order::Desc {
                        o = o.reverse();
                    }
                    if o != Ordering::Equal {
                        return o;
                    }
                }
                Ordering::Equal
            });
            keyed.into_iter().map(|(_, t)| t).collect()
        }
        Step::Group(bys) => {
            let key_by = bys.first().cloned().unwrap_or(By::Identity(None));
            let val_by = bys.get(1).cloned();
            let mut entries: Vec<(GVal, Vec<GVal>)> = Vec::new();
            for t in &stream {
                let key = eval_by(graph, ctx, &key_by, &t.val);
                let value = match &val_by {
                    Some(by) => eval_by(graph, ctx, by, &t.val),
                    None => t.val.clone(),
                };
                match entries.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, list)) => list.push(value),
                    None => entries.push((key, vec![value])),
                }
            }
            vec![Trav::root(GVal::Map(entries.into_iter().map(|(k, vs)| (k, GVal::List(vs))).collect()))]
        }
        Step::GroupCount(bys) => {
            let by = bys.first().cloned().unwrap_or(By::Identity(None));
            let mut entries: Vec<(GVal, f64)> = Vec::new();
            for t in &stream {
                let key = eval_by(graph, ctx, &by, &t.val);
                match entries.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, n)) => *n += 1.0,
                    None => entries.push((key, 1.0)),
                }
            }
            vec![Trav::root(GVal::Map(entries.into_iter().map(|(k, n)| (k, GVal::Num(n))).collect()))]
        }

        // --- combinators ---
        Step::Where(sub) => stream.into_iter().filter(|t| sub_nonempty(graph, ctx, sub, t)).collect(),
        Step::WhereKey(start, pred, bys) => {
            let Some(GVal::Str(end_label)) = pred.rhs() else {
                return stream; // non-comparison predicate; nothing to compare against
            };
            let end_label = end_label.to_string();
            let start_by = bys.first().cloned().unwrap_or(By::Identity(None));
            let end_by = bys.get(1).cloned().unwrap_or_else(|| start_by.clone());
            let mut next = Vec::new();
            for t in stream {
                let (Some(sv), Some(ev)) = (t.recall(start, Pop::Last), t.recall(&end_label, Pop::Last)) else {
                    continue;
                };
                let sv = eval_by(graph, ctx, &start_by, &sv);
                let ev = eval_by(graph, ctx, &end_by, &ev);
                let resolved = substitute_rhs(pred, ev);
                if p_matches(&resolved, &sv) {
                    next.push(t);
                }
            }
            next
        }
        Step::And(plans) => stream.into_iter().filter(|t| plans.iter().all(|p| sub_nonempty(graph, ctx, p, t))).collect(),
        Step::Or(plans) => stream.into_iter().filter(|t| plans.iter().any(|p| sub_nonempty(graph, ctx, p, t))).collect(),
        Step::Not(sub) => stream.into_iter().filter(|t| !sub_nonempty(graph, ctx, sub, t)).collect(),
        Step::Union(plans) => {
            let mut next = Vec::new();
            for t in &stream {
                for p in plans {
                    next.extend(run_steps(graph, ctx, &p.steps, vec![t.clone()]));
                }
            }
            next
        }
        Step::Coalesce(plans) => {
            let mut next = Vec::new();
            for t in &stream {
                for p in plans {
                    let r = run_steps(graph, ctx, &p.steps, vec![t.clone()]);
                    if !r.is_empty() {
                        next.extend(r);
                        break;
                    }
                }
            }
            next
        }
        Step::Optional(sub) => {
            let mut next = Vec::new();
            for t in stream {
                let r = run_steps(graph, ctx, &sub.steps, vec![t.clone()]);
                if r.is_empty() {
                    next.push(t);
                } else {
                    next.extend(r);
                }
            }
            next
        }
        Step::Local(sub) => {
            let mut next = Vec::new();
            for t in &stream {
                next.extend(run_steps(graph, ctx, &sub.steps, vec![t.clone()]));
            }
            next
        }
        Step::Choose { test, then_, else_ } => {
            let mut next = Vec::new();
            for t in stream {
                if sub_nonempty(graph, ctx, test, &t) {
                    next.extend(run_steps(graph, ctx, &then_.steps, vec![t]));
                } else if let Some(e) = else_ {
                    next.extend(run_steps(graph, ctx, &e.steps, vec![t]));
                } else {
                    next.push(t);
                }
            }
            next
        }
        Step::Map(sub) => {
            let mut next = Vec::new();
            for t in &stream {
                if let Some(v) = sub_vals(graph, ctx, sub, t).into_iter().next() {
                    next.push(t.with(v));
                }
            }
            next
        }
        Step::FlatMap(sub) => {
            let mut next = Vec::new();
            for t in &stream {
                for v in sub_vals(graph, ctx, sub, t) {
                    next.push(t.with(v));
                }
            }
            next
        }
        Step::SideEffect(sub) => {
            for t in &stream {
                let _ = run_steps(graph, ctx, &sub.steps, vec![t.clone()]);
            }
            stream
        }
        Step::Aggregate(key) | Step::Store(key) => {
            for t in &stream {
                ctx.side.entry(key.clone()).or_default().push(t.val.clone());
            }
            stream
        }
        Step::Subgraph(key) => {
            // Accumulate each edge (+ its endpoints) into the named subgraph,
            // deduped by id; traversers pass through so it composes mid-stream.
            let entry = ctx.subgraphs.entry(key.clone()).or_default();
            for t in &stream {
                if let GVal::Edge(e) = t.val {
                    let (s, d) = (graph.e_src[e as usize], graph.e_dst[e as usize]);
                    if !entry.1.contains(&e) {
                        entry.1.push(e);
                    }
                    for v in [s, d] {
                        if !entry.0.contains(&v) {
                            entry.0.push(v);
                        }
                    }
                }
            }
            stream
        }
        Step::ShortestPath { target } => shortest_path_step(graph, ctx, target.as_deref(), stream),
        Step::Cap(key) => {
            // A subgraph key caps to a self-describing {vertices, edges} map of
            // full element records (GVal has no graph type — the TS engine returns
            // a Graph object). The JS `subgraphToGraph` helper rebuilds a real
            // @pl-graph/core Graph from this, giving cross-engine parity. Else the
            // capped value is the plain side-effect bag.
            if let Some((verts, edges)) = ctx.subgraphs.get(key) {
                let (verts, edges) = (verts.clone(), edges.clone());
                let vlist = GVal::List(verts.iter().map(|v| subgraph_vertex(graph, *v)).collect());
                let elist = GVal::List(edges.iter().map(|e| subgraph_edge(graph, *e)).collect());
                vec![Trav::root(GVal::Map(vec![
                    (GVal::Str(Arc::from("vertices")), vlist),
                    (GVal::Str(Arc::from("edges")), elist),
                ]))]
            } else {
                vec![Trav::root(GVal::List(ctx.side.get(key).cloned().unwrap_or_default()))]
            }
        }
        Step::Barrier => stream,
        Step::Repeat { body, times, until, emit, emit_before } => run_repeat(graph, ctx, &stream, body, *times, until.as_deref(), emit.as_deref(), *emit_before),

        // --- tagging / select ---
        Step::As(label) => stream
            .into_iter()
            .map(|mut t| {
                let val = t.val.clone();
                match t.tags.iter_mut().find(|(l, _)| l == label) {
                    Some((_, list)) => list.push(val),
                    None => t.tags.push((label.clone(), vec![val])),
                }
                t
            })
            .collect(),
        Step::Select { labels, pop, bys } => {
            let mut next = Vec::new();
            for t in &stream {
                let vals: Vec<Option<GVal>> = labels.iter().map(|l| t.recall(l, *pop)).collect();
                if vals.iter().any(Option::is_none) {
                    continue;
                }
                // A single `by()` cycles across all labels (Gremlin semantics); no
                // `by()` ⇒ identity. Matches the TS selectStep.
                let by_at = |i: usize| -> By {
                    if bys.is_empty() {
                        By::Identity(None)
                    } else {
                        bys[i % bys.len()].clone()
                    }
                };
                if labels.len() == 1 {
                    let v = eval_by(graph, ctx, &by_at(0), vals[0].as_ref().unwrap());
                    next.push(t.with(v));
                } else {
                    let entries = labels
                        .iter()
                        .enumerate()
                        .map(|(i, l)| {
                            (GVal::Str(Arc::from(l.as_str())), eval_by(graph, ctx, &by_at(i), vals[i].as_ref().unwrap()))
                        })
                        .collect();
                    next.push(t.with(GVal::Map(entries)));
                }
            }
            next
        }
        Step::Match(plans) => match_step(graph, ctx, plans, stream),

        // --- misc ---
        Step::Unfold => {
            let mut next = Vec::new();
            for t in &stream {
                match &t.val {
                    GVal::List(items) => {
                        for it in items {
                            next.push(t.step(it.clone()));
                        }
                    }
                    other => next.push(t.step(other.clone())),
                }
            }
            next
        }
        Step::Index => stream.iter().enumerate().map(|(i, t)| t.with(GVal::List(vec![t.val.clone(), GVal::Num(i as f64)]))).collect(),
        Step::Loops => map_step(stream, |t| vec![GVal::Num(t.loops as f64)]),
        Step::Constant(v) => map_step(stream, |_t| vec![v.clone()]),
        Step::Identity => stream,
        Step::Inject(vs) => {
            let mut next: Vec<Trav> = vs.iter().map(|v| Trav::root(v.clone())).collect();
            next.extend(stream);
            next
        }
        Step::None(None) => Vec::new(),
        Step::None(Some(pred)) => stream.into_iter().filter(|t| !local_elems(&t.val).iter().any(|e| p_matches(pred, e))).collect(),
        Step::Fail(msg) => {
            if !stream.is_empty() {
                panic!("{}", msg.clone().unwrap_or_else(|| "fail() reached".to_string()));
            }
            stream
        }

        // --- mutation ---
        Step::AddV(label) => {
            let labels: Vec<String> = label.iter().cloned().collect();
            // As a source (`g.addV()`), create one even with no incoming traverser.
            let base = if stream.is_empty() { vec![Trav::root(GVal::Null)] } else { stream };
            base.iter().map(|t| t.with(GVal::Vertex(graph.add_vertex(&labels, vec![])))).collect()
        }
        Step::AddE { label, from, to } => {
            let mut next = Vec::new();
            for t in &stream {
                let (Some(f), Some(to_v)) = (resolve_endpoint(graph, ctx, from, t), resolve_endpoint(graph, ctx, to, t)) else {
                    continue;
                };
                let e = graph.add_edge(f, to_v, label, vec![]);
                next.push(t.with(GVal::Edge(e)));
            }
            next
        }
        Step::Property(key, v) => {
            for t in &stream {
                match t.val {
                    GVal::Vertex(i) => graph.set_vertex_prop(i, key, gval_to_value(v)),
                    GVal::Edge(e) => graph.set_edge_prop(e, key, gval_to_value(v)),
                    _ => {}
                }
            }
            stream
        }
        Step::Drop => {
            for t in &stream {
                match t.val {
                    GVal::Vertex(i) => {
                        let _ = graph.remove_vertex(i, true);
                    }
                    GVal::Edge(e) => {
                        graph.remove_edge(e);
                    }
                    _ => {}
                }
            }
            Vec::new()
        }
    }
}

/// Collect a vertex's adjacency as `(eidx, nbr)`. With labels, emit per label in
/// argument order (Gremlin `out('A','B')` yields all A-edges then all B-edges);
/// without, adjacency order (out then in for `both`), deduped across both for
/// `both` with no labels is not required (TinkerPop both yields each edge once
/// per direction — matches iterating out then in).
fn adj_in_label_order(graph: &Graph, v: u32, out: bool, inn: bool, labels: &[String]) -> Vec<(u32, u32)> {
    let outs: Vec<(u32, u32, u32)> = if out { graph.out_adj(v).map(|a| (a.eidx, a.nbr, a.etype)).collect() } else { Vec::new() };
    let ins: Vec<(u32, u32, u32)> = if inn { graph.in_adj(v).map(|a| (a.eidx, a.nbr, a.etype)).collect() } else { Vec::new() };
    let collect_dir = |adjs: &[(u32, u32, u32)], dst: &mut Vec<(u32, u32)>| {
        if labels.is_empty() {
            dst.extend(adjs.iter().map(|a| (a.0, a.1)));
        } else {
            for lbl in labels {
                if let Some(id) = graph.etype.get(lbl) {
                    dst.extend(adjs.iter().filter(|a| a.2 == id).map(|a| (a.0, a.1)));
                }
            }
        }
    };
    let mut res = Vec::new();
    collect_dir(&outs, &mut res);
    collect_dir(&ins, &mut res);
    res
}

fn dir_flags(step: &Step) -> (bool, bool) {
    match step {
        Step::Out(_) | Step::OutE(_) => (true, false),
        Step::In(_) | Step::InE(_) => (false, true),
        _ => (true, true),
    }
}

/// Resolve an `addE` endpoint to a vertex id.
fn resolve_endpoint(graph: &mut Graph, ctx: &mut Ctx, ep: &Endpoint, t: &Trav) -> Option<u32> {
    let v = match ep {
        Endpoint::Current => t.val.clone(),
        Endpoint::Tag(label) => t.recall(label, Pop::Last)?,
        Endpoint::Plan(plan) => sub_vals(graph, ctx, plan, t).into_iter().next()?,
    };
    match v {
        GVal::Vertex(i) => Some(i),
        _ => None,
    }
}

/// The `value` field of a `{key, value}` property map (for `value`/`hasValue`).
fn prop_value_field(v: &GVal) -> Option<GVal> {
    match v {
        GVal::Map(entries) => entries.iter().find(|(k, _)| matches!(k, GVal::Str(s) if s.as_ref() == "value")).map(|(_, x)| x.clone()),
        _ => None,
    }
}
fn prop_key_field(v: &GVal) -> Option<GVal> {
    match v {
        GVal::Map(entries) => entries.iter().find(|(k, _)| matches!(k, GVal::Str(s) if s.as_ref() == "key")).map(|(_, x)| x.clone()),
        _ => None,
    }
}

/// Substitute a comparison predicate's RHS with a resolved value (`where(key,pred)`).
fn substitute_rhs(p: &P, v: GVal) -> P {
    match p {
        P::Eq(_) => P::Eq(v),
        P::Neq(_) => P::Neq(v),
        P::Gt(_) => P::Gt(v),
        P::Gte(_) => P::Gte(v),
        P::Lt(_) => P::Lt(v),
        P::Lte(_) => P::Lte(v),
        other => other.clone(),
    }
}

fn slice_local(v: &GVal, start: usize, end: usize) -> GVal {
    let e = local_elems(v);
    let s = start.min(e.len());
    let en = end.min(e.len());
    GVal::List(if s < en { e[s..en].to_vec() } else { Vec::new() })
}

fn map_step(stream: Vec<Trav>, f: impl Fn(&Trav) -> Vec<GVal>) -> Vec<Trav> {
    let mut next = Vec::new();
    for t in &stream {
        for v in f(t) {
            next.push(t.with(v));
        }
    }
    next
}

fn has_dup(path: &[GVal]) -> bool {
    for i in 0..path.len() {
        for j in (i + 1)..path.len() {
            if path[i] == path[j] {
                return true;
            }
        }
    }
    false
}

fn fold_num(stream: Vec<Trav>, f: impl Fn(&[f64]) -> f64) -> Vec<Trav> {
    let ns: Vec<f64> = stream.iter().filter_map(|t| gnum(&t.val)).collect();
    if ns.is_empty() {
        Vec::new()
    } else {
        vec![Trav::root(GVal::Num(f(&ns)))]
    }
}

fn local_num(v: &GVal, f: impl Fn(&[f64]) -> f64) -> GVal {
    let ns: Vec<f64> = local_elems(v).iter().filter_map(gnum).collect();
    if ns.is_empty() {
        GVal::Null
    } else {
        GVal::Num(f(&ns))
    }
}

fn fold_extreme(stream: Vec<Trav>, want: Ordering) -> Vec<Trav> {
    let mut best: Option<GVal> = None;
    for t in stream {
        best = Some(match best {
            None => t.val,
            Some(b) => {
                if gcmp(&t.val, &b) == Some(want) {
                    t.val
                } else {
                    b
                }
            }
        });
    }
    best.map(|v| vec![Trav::root(v)]).unwrap_or_default()
}

fn local_extreme(v: &GVal, want: Ordering) -> GVal {
    let mut best: Option<GVal> = None;
    for e in local_elems(v) {
        best = Some(match best {
            None => e,
            Some(b) => {
                if gcmp(&e, &b) == Some(want) {
                    e
                } else {
                    b
                }
            }
        });
    }
    best.unwrap_or(GVal::Null)
}

/// Insert a key chain into a nested tree map (for `tree()`).
fn insert_tree(node: &mut Vec<(GVal, GVal)>, keys: &[GVal]) {
    let Some((head, rest)) = keys.split_first() else {
        return;
    };
    let child = match node.iter_mut().find(|(k, _)| k == head) {
        Some((_, GVal::Map(m))) => m,
        Some(_) => return,
        None => {
            node.push((head.clone(), GVal::Map(Vec::new())));
            match &mut node.last_mut().unwrap().1 {
                GVal::Map(m) => m,
                _ => unreachable!(),
            }
        }
    };
    insert_tree(child, rest);
}

/// `repeat(body)` with `times` / `until` / `emit` modulators.
#[allow(clippy::too_many_arguments)]
fn run_repeat(
    graph: &mut Graph,
    ctx: &mut Ctx,
    stream: &[Trav],
    body: &Traversal,
    times: Option<usize>,
    until: Option<&Traversal>,
    emit: Option<&Traversal>,
    emit_before: bool,
) -> Vec<Trav> {
    const CAP: usize = 64;
    let emit_matches = |graph: &mut Graph, ctx: &mut Ctx, t: &Trav, e: &Traversal| e.steps.is_empty() || sub_nonempty(graph, ctx, e, t);

    if until.is_none() && emit.is_none() {
        let n = times.unwrap_or(CAP);
        let mut current = stream.to_vec();
        for _ in 0..n {
            if current.is_empty() {
                break;
            }
            current = run_steps(graph, ctx, &body.steps, current.into_iter().map(inc_loops).collect());
        }
        return current;
    }

    let mut out: Vec<Trav> = Vec::new();
    let mut current = stream.to_vec();
    if emit_before {
        if let Some(e) = emit {
            for t in &current {
                if emit_matches(graph, ctx, t, e) {
                    out.push(t.clone());
                }
            }
        }
    }
    let max = times.unwrap_or(CAP);
    for _ in 0..max {
        if current.is_empty() {
            break;
        }
        // `until` is checked BEFORE the body (do-while): satisfiers exit.
        let mut advancing = Vec::new();
        for t in std::mem::take(&mut current) {
            if let Some(u) = until {
                if sub_nonempty(graph, ctx, u, &t) {
                    out.push(t);
                    continue;
                }
            }
            advancing.push(t);
        }
        if advancing.is_empty() {
            break;
        }
        let stepped: Vec<Trav> = run_steps(graph, ctx, &body.steps, advancing.into_iter().map(inc_loops).collect());
        if !emit_before {
            if let Some(e) = emit {
                for t in &stepped {
                    if emit_matches(graph, ctx, t, e) {
                        out.push(t.clone());
                    }
                }
            }
        }
        current = stepped;
    }
    // Pre-emit form yields the final frontier too (it never got a pre-emit pass).
    if emit_before && until.is_none() {
        out.extend(current);
    }
    out
}

fn inc_loops(mut t: Trav) -> Trav {
    t.loops += 1;
    t
}
