//! The Gremlin executor: runs a [`Traversal`]'s [`Step`] list over a stream of
//! traversers against the columnar [`Graph`]. Eager (Vec-per-step) — the modest
//! result scale doesn't need lazy iterators, and it keeps the step semantics
//! readable. Movement/projection steps extend each traverser's path; filters
//! pass traversers through unchanged.

use std::cmp::Ordering;
use std::sync::Arc;

use super::{GVal, Order, Step, Traversal, P};
use crate::graph::{Graph, Value};

/// A unit flowing through the pipeline: its current value, the path it took, and
/// any `as(label)` tags.
#[derive(Clone)]
struct Trav {
    val: GVal,
    path: Vec<GVal>,
    tags: Vec<(String, GVal)>,
}

impl Trav {
    fn root(val: GVal) -> Trav {
        Trav { path: vec![val.clone()], val, tags: Vec::new() }
    }
    /// A successor traverser that moved to `val` (extends the path, keeps tags).
    fn step(&self, val: GVal) -> Trav {
        let mut path = self.path.clone();
        path.push(val.clone());
        Trav { val, path, tags: self.tags.clone() }
    }
}

/// Run a traversal, returning the final traversers' values.
pub fn run(graph: &Graph, t: &Traversal) -> Vec<GVal> {
    run_steps(graph, &t.steps, Vec::new()).into_iter().map(|t| t.val).collect()
}

fn run_steps(graph: &Graph, steps: &[Step], mut stream: Vec<Trav>) -> Vec<Trav> {
    for step in steps {
        stream = apply(graph, step, stream);
    }
    stream
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

/// Read property `key` off an element value (vertex/edge); non-elements → Null.
fn prop(graph: &Graph, v: &GVal, key: &str) -> GVal {
    match v {
        GVal::Vertex(i) => value_to_gval(graph.props.value(*i as usize, key, &graph.strs)),
        GVal::Edge(e) => value_to_gval(graph.edge_props.value(*e as usize, key, &graph.strs)),
        _ => GVal::Null,
    }
}

/// All present property keys of an element, in key-id order.
fn present_keys<'a>(graph: &'a Graph, v: &GVal) -> Vec<&'a str> {
    let store = match v {
        GVal::Vertex(_) => &graph.props,
        GVal::Edge(_) => &graph.edge_props,
        _ => return Vec::new(),
    };
    let idx = match v {
        GVal::Vertex(i) => *i as usize,
        GVal::Edge(e) => *e as usize,
        _ => return Vec::new(),
    };
    (0..store.keys.len() as u32)
        .filter(|&kid| !matches!(store.value_id(idx, kid, &graph.strs), Value::Null))
        .map(|kid| store.keys.text(kid))
        .collect()
}

/// The external id of an element as a string (vertices: their id; edges: `e<idx>`).
fn elem_id(graph: &Graph, v: &GVal) -> GVal {
    match v {
        GVal::Vertex(i) => GVal::Str(graph.vid.arc(*i)),
        GVal::Edge(e) => GVal::Str(Arc::from(format!("e{e}").as_str())),
        other => other.clone(),
    }
}

/// The label of an element (vertices: first label; edges: their type).
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

/// Order two values: numerically when both coerce to numbers, else lexically for
/// strings; otherwise incomparable (`None`).
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
    let cmp = |target: &GVal, want: Ordering| gcmp(v, target) == Some(want);
    let cmp_le = |target: &GVal| matches!(gcmp(v, target), Some(Ordering::Less | Ordering::Equal));
    let cmp_ge = |target: &GVal| matches!(gcmp(v, target), Some(Ordering::Greater | Ordering::Equal));
    let s = |g: &GVal| match g {
        GVal::Str(s) => Some(s.to_string()),
        _ => None,
    };
    match p {
        P::Eq(t) => v == t,
        P::Neq(t) => v != t,
        P::Gt(t) => cmp(t, Ordering::Greater),
        P::Lt(t) => cmp(t, Ordering::Less),
        P::Gte(t) => cmp_ge(t),
        P::Lte(t) => cmp_le(t),
        P::Between(lo, hi) => cmp_ge(lo) && cmp(hi, Ordering::Less),
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

/// Resolve edge-type label names to dense ids. `None` = no filter (all types).
fn label_filter(graph: &Graph, labels: &[String]) -> Option<Vec<u32>> {
    if labels.is_empty() {
        None
    } else {
        Some(labels.iter().filter_map(|l| graph.etype.get(l)).collect())
    }
}

fn etype_ok(filter: &Option<Vec<u32>>, etype: u32) -> bool {
    filter.as_ref().is_none_or(|ids| ids.contains(&etype))
}

// --- per-step application ---------------------------------------------------

fn apply(graph: &Graph, step: &Step, stream: Vec<Trav>) -> Vec<Trav> {
    match step {
        // --- sources (ignore the incoming stream) ---
        Step::V(ids) => {
            if ids.is_empty() {
                graph.vertex_indices().map(|v| Trav::root(GVal::Vertex(v))).collect()
            } else {
                ids.iter()
                    .filter_map(|id| graph.vid.get(id))
                    .filter(|&v| graph.is_vertex_live(v))
                    .map(|v| Trav::root(GVal::Vertex(v)))
                    .collect()
            }
        }
        Step::E(_) => (0..graph.e_src.len() as u32)
            .filter(|&e| graph.is_edge_live(e))
            .map(|e| Trav::root(GVal::Edge(e)))
            .collect(),

        // --- movement: vertex → vertex ---
        Step::Out(labels) | Step::In(labels) | Step::Both(labels) => {
            let f = label_filter(graph, labels);
            let (out, inn) = match step {
                Step::Out(_) => (true, false),
                Step::In(_) => (false, true),
                _ => (true, true),
            };
            let mut next = Vec::new();
            for t in &stream {
                if let GVal::Vertex(v) = t.val {
                    if out {
                        for a in graph.out_adj(v) {
                            if etype_ok(&f, a.etype) {
                                next.push(t.step(GVal::Vertex(a.nbr)));
                            }
                        }
                    }
                    if inn {
                        for a in graph.in_adj(v) {
                            if etype_ok(&f, a.etype) {
                                next.push(t.step(GVal::Vertex(a.nbr)));
                            }
                        }
                    }
                }
            }
            next
        }

        // --- movement: vertex → edge ---
        Step::OutE(labels) | Step::InE(labels) | Step::BothE(labels) => {
            let f = label_filter(graph, labels);
            let (out, inn) = match step {
                Step::OutE(_) => (true, false),
                Step::InE(_) => (false, true),
                _ => (true, true),
            };
            let mut next = Vec::new();
            for t in &stream {
                if let GVal::Vertex(v) = t.val {
                    if out {
                        for a in graph.out_adj(v) {
                            if etype_ok(&f, a.etype) {
                                next.push(t.step(GVal::Edge(a.eidx)));
                            }
                        }
                    }
                    if inn {
                        for a in graph.in_adj(v) {
                            if etype_ok(&f, a.etype) {
                                next.push(t.step(GVal::Edge(a.eidx)));
                            }
                        }
                    }
                }
            }
            next
        }

        // --- movement: edge → vertex ---
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
            // The endpoint that is not where we came from (path element before the edge).
            let mut next = Vec::new();
            for t in &stream {
                if let GVal::Edge(e) = t.val {
                    let (src, dst) = (graph.e_src[e as usize], graph.e_dst[e as usize]);
                    let from = t.path.iter().rev().nth(1).and_then(|g| match g {
                        GVal::Vertex(v) => Some(*v),
                        _ => None,
                    });
                    let other = if from == Some(src) { dst } else { src };
                    next.push(t.step(GVal::Vertex(other)));
                }
            }
            next
        }

        // --- filters (pass traversers through unchanged) ---
        Step::Has(key, pred) => stream.into_iter().filter(|t| p_matches(pred, &prop(graph, &t.val, key))).collect(),
        Step::HasLabel(labels) => {
            stream.into_iter().filter(|t| matches!(elem_label(graph, &t.val), GVal::Str(ref s) if labels.iter().any(|l| l == s.as_ref()))).collect()
        }
        Step::HasId(ids) => stream
            .into_iter()
            .filter(|t| matches!(elem_id(graph, &t.val), GVal::Str(ref s) if ids.iter().any(|i| i == s.as_ref())))
            .collect(),
        Step::HasKey(keys) => stream
            .into_iter()
            .filter(|t| {
                let present = present_keys(graph, &t.val);
                keys.iter().all(|k| present.iter().any(|p| *p == k))
            })
            .collect(),
        Step::HasNot(keys) => stream
            .into_iter()
            .filter(|t| {
                let present = present_keys(graph, &t.val);
                !keys.iter().any(|k| present.iter().any(|p| *p == k))
            })
            .collect(),
        Step::Is(pred) => stream.into_iter().filter(|t| p_matches(pred, &t.val)).collect(),
        Step::SimplePath => stream.into_iter().filter(|t| !has_dup(&t.path)).collect(),
        Step::CyclicPath => stream.into_iter().filter(|t| has_dup(&t.path)).collect(),
        Step::Dedup | Step::Dedupe => {
            let mut seen: Vec<GVal> = Vec::new();
            stream
                .into_iter()
                .filter(|t| {
                    if seen.contains(&t.val) {
                        false
                    } else {
                        seen.push(t.val.clone());
                        true
                    }
                })
                .collect()
        }

        // --- projection ---
        Step::Values(keys) => {
            let mut next = Vec::new();
            for t in &stream {
                let ks: Vec<String> = if keys.is_empty() {
                    present_keys(graph, &t.val).iter().map(|s| s.to_string()).collect()
                } else {
                    keys.clone()
                };
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
            let ks: Vec<String> = if keys.is_empty() {
                present_keys(graph, &t.val).iter().map(|s| s.to_string()).collect()
            } else {
                keys.clone()
            };
            let entries: Vec<(GVal, GVal)> =
                ks.into_iter().map(|k| (GVal::Str(Arc::from(k.as_str())), prop(graph, &t.val, &k))).filter(|(_, v)| *v != GVal::Null).collect();
            vec![GVal::Map(entries)]
        }),
        Step::Id => map_step(stream, |t| vec![elem_id(graph, &t.val)]),
        Step::Label => map_step(stream, |t| vec![elem_label(graph, &t.val)]),
        Step::Path => stream.iter().map(|t| t.step(GVal::List(t.path.clone()))).collect(),

        // --- cardinality ---
        Step::Limit(n) => stream.into_iter().take(*n).collect(),
        Step::Skip(n) => stream.into_iter().skip(*n).collect(),
        Step::Range(s, e) => stream.into_iter().skip(*s).take(e.saturating_sub(*s)).collect(),
        Step::Tail(n) => {
            let len = stream.len();
            stream.into_iter().skip(len.saturating_sub(*n)).collect()
        }

        // --- aggregates / terminals (collapse the stream) ---
        Step::Count => vec![Trav::root(GVal::Num(stream.len() as f64))],
        Step::Fold => vec![Trav::root(GVal::List(stream.into_iter().map(|t| t.val).collect()))],
        Step::Sum => fold_num(stream, |ns| ns.iter().sum()),
        Step::Mean => fold_num(stream, |ns| ns.iter().sum::<f64>() / ns.len() as f64),
        Step::Min => fold_extreme(stream, Ordering::Less),
        Step::Max => fold_extreme(stream, Ordering::Greater),
        Step::Order(by, dir) => {
            let mut v = stream;
            v.sort_by(|a, b| {
                let pa = by.as_ref().map(|k| prop(graph, &a.val, k)).unwrap_or_else(|| a.val.clone());
                let pb = by.as_ref().map(|k| prop(graph, &b.val, k)).unwrap_or_else(|| b.val.clone());
                let o = gcmp(&pa, &pb).unwrap_or(Ordering::Equal);
                if *dir == Order::Desc {
                    o.reverse()
                } else {
                    o
                }
            });
            v
        }
        Step::Group(key_by, value_by) => {
            let mut entries: Vec<(GVal, Vec<GVal>)> = Vec::new();
            for t in &stream {
                let key = key_by.as_ref().map(|k| prop(graph, &t.val, k)).unwrap_or_else(|| t.val.clone());
                let value = value_by.as_ref().map(|k| prop(graph, &t.val, k)).unwrap_or_else(|| t.val.clone());
                match entries.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, list)) => list.push(value),
                    None => entries.push((key, vec![value])),
                }
            }
            vec![Trav::root(GVal::Map(entries.into_iter().map(|(k, vs)| (k, GVal::List(vs))).collect()))]
        }
        Step::GroupCount(by) => {
            let mut entries: Vec<(GVal, f64)> = Vec::new();
            for t in &stream {
                let key = by.as_ref().map(|k| prop(graph, &t.val, k)).unwrap_or_else(|| t.val.clone());
                match entries.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, n)) => *n += 1.0,
                    None => entries.push((key, 1.0)),
                }
            }
            vec![Trav::root(GVal::Map(entries.into_iter().map(|(k, n)| (k, GVal::Num(n))).collect()))]
        }

        // --- combinators / branch ---
        Step::Where(sub) => stream.into_iter().filter(|t| !run_steps(graph, &sub.steps, vec![t.clone()]).is_empty()).collect(),
        Step::And(plans) => stream
            .into_iter()
            .filter(|t| plans.iter().all(|p| !run_steps(graph, &p.steps, vec![t.clone()]).is_empty()))
            .collect(),
        Step::Or(plans) => stream
            .into_iter()
            .filter(|t| plans.iter().any(|p| !run_steps(graph, &p.steps, vec![t.clone()]).is_empty()))
            .collect(),
        Step::Not(sub) => stream.into_iter().filter(|t| run_steps(graph, &sub.steps, vec![t.clone()]).is_empty()).collect(),
        Step::Union(plans) => {
            let mut next = Vec::new();
            for t in &stream {
                for p in plans {
                    next.extend(run_steps(graph, &p.steps, vec![t.clone()]));
                }
            }
            next
        }
        Step::Coalesce(plans) => {
            let mut next = Vec::new();
            for t in &stream {
                for p in plans {
                    let r = run_steps(graph, &p.steps, vec![t.clone()]);
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
                let r = run_steps(graph, &sub.steps, vec![t.clone()]);
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
                next.extend(run_steps(graph, &sub.steps, vec![t.clone()]));
            }
            next
        }
        Step::Repeat { body, times, until, emit, emit_before } => run_repeat(graph, &stream, body, *times, until.as_deref(), emit.as_deref(), *emit_before),

        // --- misc ---
        Step::As(label) => stream
            .into_iter()
            .map(|mut t| {
                let val = t.val.clone();
                t.tags.retain(|(l, _)| l != label);
                t.tags.push((label.clone(), val));
                t
            })
            .collect(),
        Step::Select(labels) => {
            let mut next = Vec::new();
            for t in &stream {
                let vals: Vec<Option<&GVal>> = labels.iter().map(|l| t.tags.iter().rev().find(|(tl, _)| tl == l).map(|(_, v)| v)).collect();
                if vals.iter().any(Option::is_none) {
                    continue; // a traverser missing any selected label is dropped
                }
                if labels.len() == 1 {
                    next.push(t.step(vals[0].unwrap().clone()));
                } else {
                    let map = labels
                        .iter()
                        .zip(&vals)
                        .map(|(l, v)| (GVal::Str(Arc::from(l.as_str())), (*v).unwrap().clone()))
                        .collect();
                    next.push(t.step(GVal::Map(map)));
                }
            }
            next
        }
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
        Step::Constant(v) => map_step(stream, |_t| vec![v.clone()]),
        Step::Identity => stream,
        Step::Inject(vs) => {
            let mut next = stream;
            next.extend(vs.iter().map(|v| Trav::root(v.clone())));
            next
        }
    }
}

/// flatMap a stream by mapping each traverser's value to zero+ successor values.
fn map_step(stream: Vec<Trav>, f: impl Fn(&Trav) -> Vec<GVal>) -> Vec<Trav> {
    let mut next = Vec::new();
    for t in &stream {
        for v in f(t) {
            next.push(t.step(v));
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

/// Numeric reducer over the stream (`sum`/`mean`). Empty stream → empty result.
fn fold_num(stream: Vec<Trav>, f: impl Fn(&[f64]) -> f64) -> Vec<Trav> {
    let ns: Vec<f64> = stream.iter().filter_map(|t| gnum(&t.val)).collect();
    if ns.is_empty() {
        Vec::new()
    } else {
        vec![Trav::root(GVal::Num(f(&ns)))]
    }
}

/// `min`/`max` over the stream by `gcmp`. Empty stream → empty result.
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

/// `repeat(body)` with `times` / `until` / `emit` modulators (post-form).
fn run_repeat(
    graph: &Graph,
    stream: &[Trav],
    body: &Traversal,
    times: Option<usize>,
    until: Option<&Traversal>,
    emit: Option<&Traversal>,
    emit_before: bool,
) -> Vec<Trav> {
    const CAP: usize = 64; // safety bound for until-only loops
    let yields = |t: &Trav, plan: &Traversal| !run_steps(graph, &plan.steps, vec![t.clone()]).is_empty();

    // Plain `repeat(body).times(n)` (no until/emit): apply the body n times.
    if until.is_none() && emit.is_none() {
        let n = times.unwrap_or(CAP);
        let mut current = stream.to_vec();
        for _ in 0..n {
            if current.is_empty() {
                break;
            }
            current = run_steps(graph, &body.steps, current);
        }
        return current;
    }

    // until/emit loop: body runs, then `until` exits satisfiers to output and
    // `emit` additionally outputs satisfiers; the rest loop again.
    let mut out: Vec<Trav> = Vec::new();
    let mut current = stream.to_vec();
    if emit_before {
        if let Some(e) = emit {
            out.extend(current.iter().filter(|t| yields(t, e)).cloned());
        }
    }
    let max = times.unwrap_or(CAP);
    for _ in 0..max {
        if current.is_empty() {
            break;
        }
        let stepped = run_steps(graph, &body.steps, current);
        let mut looping = Vec::new();
        for t in stepped {
            if !emit_before {
                if let Some(e) = emit {
                    if yields(&t, e) {
                        out.push(t.clone());
                    }
                }
            }
            match until {
                Some(u) if yields(&t, u) => out.push(t), // satisfied → leaves loop
                _ => looping.push(t),
            }
        }
        current = looping;
    }
    out
}
