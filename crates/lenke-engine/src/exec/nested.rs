use super::*;
use crate::batch::{Batch, Col};
use crate::ir::GElem;
use crate::store::Store;
use crate::value::Value;

pub(super) fn push_group_cols(
    node_stack: &[u32],
    edge_stack: &[u32],
    k: u32,
    group_binds: &[(crate::ir::GroupPos, usize)],
    group_cols: &mut [Vec<Value>],
) {
    use crate::ir::GroupPos;
    let k = k as usize;
    let reps = edge_stack.len() / k;
    for (i, (pos, _)) in group_binds.iter().enumerate() {
        let list: Vec<Value> = match pos {
            GroupPos::NodeAt(p) => (0..reps)
                .map(|r| Value::Num(f64::from(node_stack[r * k + *p as usize])))
                .collect(),
            GroupPos::EdgeAt(p) => (0..reps)
                .map(|r| Value::Num(f64::from(edge_stack[r * k + *p as usize])))
                .collect(),
        };
        group_cols[i].push(Value::List(list));
    }
}

// ── NESTED subpath groups (`Plan::NestedGroup`) ──────────────────────────────

/// One graph-consuming hop of a matched trail, tagged with its position in the
/// (nested) repetition pattern. `levels` is the cursor stack outer→inner: one
/// `(rep, elem_after)` per active unit — `elem_after` is the element index the hop
/// advanced PAST, EXCEPT that a step inside a `Sub` keeps the enclosing unit's entry
/// pinned at that Sub's element index. This is what lets the structured binder place
/// each variable at the right nesting depth. Mirrors the TS engine's `pathfind::StepRec`.
#[derive(Clone)]
pub(super) struct StepRec {
    levels: Vec<(u32, usize)>,
    source: u32,
    edge: u32,
    target: u32,
}

/// A partially-built nested list keyed by a rep-tuple: `insert([i,j], v)` puts `v` at
/// `list[i][j]`, growing intermediate lists. Depth-`d` variable → `d+1`-element keys.
pub(super) enum Nest {
    Leaf(Value),
    List(Vec<Nest>),
}
impl Nest {
    fn insert(&mut self, idx: &[u32], val: Value) {
        match idx.split_first() {
            None => *self = Nest::Leaf(val),
            Some((&i, rest)) => {
                if !matches!(self, Nest::List(_)) {
                    *self = Nest::List(Vec::new());
                }
                if let Nest::List(v) = self {
                    let i = i as usize;
                    while v.len() <= i {
                        v.push(Nest::List(Vec::new()));
                    }
                    v[i].insert(rest, val);
                }
            }
        }
    }
    fn into_val(self) -> Value {
        match self {
            Nest::Leaf(v) => v,
            Nest::List(items) => Value::List(items.into_iter().map(Nest::into_val).collect()),
        }
    }
}

/// Assemble every bound variable of `unit` (recursively into its `Sub`s) as a
/// (possibly nested) list keyed by the repetition counters of the units it sits in —
/// one list level per enclosing quantifier. `tree_path` is the `Sub`-element indices
/// from the top unit to THIS one, so `depth = tree_path.len()` is its nesting depth.
/// A node/edge id is stored as `Value::Num(id)` (the group-variable convention; the
/// `x[i].prop` element-typing reads it back). Mirrors the TS engine's `pathfind::bind_unit`
/// with `key_start = 0`.
/// Which of a unit's bound slots hold a NODE and which hold an EDGE, recursively through its
/// nested sub-groups. Needed because a per-rep mini-batch has to present each binding in a
/// column the evaluator can read it from: a node id in a `Col::Gen` is a bare `Value::Num`,
/// which `Prop` does not recognise as an element, so `x.name` over one reads NULL.
pub(super) fn unit_slot_kinds(
    unit: &crate::ir::GUnit,
    nodes: &mut Vec<usize>,
    edges: &mut Vec<usize>,
) {
    use crate::ir::GElem;
    if let Some(s) = unit.start_slot {
        nodes.push(s);
    }
    for elem in &unit.elems {
        match elem {
            GElem::Hop {
                edge_slot,
                target_slot,
                ..
            } => {
                if let Some(s) = edge_slot {
                    edges.push(*s);
                }
                if let Some(s) = target_slot {
                    nodes.push(*s);
                }
            }
            GElem::Sub {
                unit, target_slot, ..
            } => {
                if let Some(s) = target_slot {
                    nodes.push(*s);
                }
                unit_slot_kinds(unit, nodes, edges);
            }
        }
    }
}

pub(super) fn bind_nested(
    unit: &crate::ir::GUnit,
    tree_path: &[usize],
    key_start: usize,
    steps: &[StepRec],
    out: &mut Vec<(usize, Value)>,
) {
    use crate::ir::GElem;
    let depth = tree_path.len();
    // `key_start = 0` = the full-nesting emit view; `key_start = 1` drops the outer-rep
    // index for a PER-REP `WHERE` (each var one level shallower). Clamp to `depth+1`.
    let ks = key_start.min(depth + 1);
    let key = |s: &StepRec| -> Vec<u32> { s.levels[ks..=depth].iter().map(|(r, _)| *r).collect() };
    let within = |s: &StepRec| -> bool {
        s.levels.len() > depth
            && s.levels[..depth]
                .iter()
                .map(|(_, e)| *e)
                .eq(tree_path.iter().copied())
    };
    // The unit's source = each rep-instance's FIRST hop's source (deduped per key).
    if let Some(slot) = unit.start_slot {
        let mut nest = Nest::List(Vec::new());
        let mut seen: std::collections::HashSet<Vec<u32>> = std::collections::HashSet::new();
        for s in steps.iter().filter(|s| within(s)) {
            let k = key(s);
            if seen.insert(k.clone()) {
                nest.insert(&k, Value::Num(f64::from(s.source)));
            }
        }
        out.push((slot, nest.into_val()));
    }
    for (e, elem) in unit.elems.iter().enumerate() {
        match elem {
            GElem::Hop {
                edge_slot,
                target_slot,
                ..
            } => {
                let direct = |s: &&StepRec| {
                    within(s) && s.levels.len() == depth + 1 && s.levels[depth].1 == e + 1
                };
                if let Some(slot) = target_slot {
                    let mut nest = Nest::List(Vec::new());
                    for s in steps.iter().filter(direct) {
                        nest.insert(&key(s), Value::Num(f64::from(s.target)));
                    }
                    out.push((*slot, nest.into_val()));
                }
                if let Some(slot) = edge_slot {
                    let mut nest = Nest::List(Vec::new());
                    for s in steps.iter().filter(direct) {
                        nest.insert(&key(s), Value::Num(f64::from(s.edge)));
                    }
                    out.push((*slot, nest.into_val()));
                }
            }
            GElem::Sub {
                unit: sub,
                target_slot,
                ..
            } => {
                // The Sub's landing = its LAST inner hop's target, per rep-instance.
                if let Some(slot) = target_slot {
                    let mut last: Vec<(Vec<u32>, u32)> = Vec::new();
                    for s in steps.iter().filter(|s| {
                        within(s) && s.levels.len() > depth + 1 && s.levels[depth].1 == e
                    }) {
                        let k = key(s);
                        match last.iter_mut().find(|(kk, _)| *kk == k) {
                            Some(slot) => slot.1 = s.target,
                            None => last.push((k, s.target)),
                        }
                    }
                    let mut nest = Nest::List(Vec::new());
                    for (k, t) in last {
                        nest.insert(&k, Value::Num(f64::from(t)));
                    }
                    out.push((*slot, nest.into_val()));
                }
                let mut child = tree_path.to_vec();
                child.push(e);
                bind_nested(sub, &child, key_start, steps, out);
            }
        }
    }
}

/// `Plan::NestedGroup`: a subpath group `( <unit> ){min,max}` whose body is a single
/// nested quantified sub-group / quantified inner hop (the 2-level shape the corpus
/// and fuzzer produce: `( ((x)-[e]->(y)){a,b} ){c,d}` and `( (x)-[e]->{a,b}(y)
/// ){c,d}`). Enumerates every valid outer×inner repetition-decomposition as a TRAIL
/// and materializes each bound inner variable as a (nested) list via `bind_nested`.
// Recursion state, carried in a small struct to keep the many closures honest.
struct M<'a> {
    store: &'a Store,
    unit: &'a crate::ir::GUnit,
    per_rep: Option<&'a Expr>,
    omin: u32,
    omax: u32,
    trail: bool,
    node_unique: bool,
    /// SIMPLE only, where a hop back onto `start` CLOSES the path: it is admissible even
    /// though `start` is already marked, but nothing may follow it. `node_unique` is also
    /// true for ACYCLIC, which forbids that hop outright — the single distinction between
    /// the two modes.
    simple: bool,
    /// The source of the walk in progress, so a closing hop can be recognised.
    start: u32,
    /// Set while a closing hop is on the path: no further hop may be taken, and no further
    /// outer repetition started. See [`M::do_hop`].
    closed: bool,
    used_edges: Vec<u32>,
    used_nodes: Vec<u32>,
    steps: Vec<StepRec>,
}

impl M<'_> {
    // One hop from `v` (edge types `want`, direction `dir`, per-hop `epred`), tagged
    // with `levels`. Calls `f(target)` per admissible neighbour, StepRec pushed;
    // restores on return.
    //
    // SIMPLE's closing hop lives here (audit item 244): a hop onto `start` is admitted
    // although `start` is marked, and sets `closed` for the duration of the continuation.
    // `closed` then bars every further hop, so the close can only complete the unit it is
    // the last element of — a close MID-unit matches nothing beyond itself and so emits
    // nothing, which is exactly right, since an interior repeat of a node is forbidden.
    fn do_hop(
        &mut self,
        v: u32,
        want: &[u32],
        dir: Dir,
        epred: Option<&Expr>,
        levels: Vec<(u32, usize)>,
        f: &mut dyn FnMut(&mut Self, u32),
    ) {
        if self.closed {
            return; // a closed SIMPLE path cannot be extended
        }
        let mut adjs: Vec<crate::store::Adj> = Vec::new();
        if matches!(dir, Dir::Out | Dir::Both) {
            adjs.extend_from_slice(self.store.out(v));
        }
        if matches!(dir, Dir::In | Dir::Both) {
            adjs.extend_from_slice(self.store.inc(v));
        }
        for a in adjs {
            if !edge_carries_wanted(self.store, &a, want) {
                continue;
            }
            if !edge_pred_ok(epred, self.store, a.eid) {
                continue; // per-hop edge WHERE / inline props
            }
            if self.trail && self.used_edges.contains(&a.eid) {
                continue;
            }
            let is_close = self.simple && a.nbr == self.start;
            if self.node_unique && !is_close && self.used_nodes.contains(&a.nbr) {
                continue;
            }
            self.steps.push(StepRec {
                levels: levels.clone(),
                source: v,
                edge: a.eid,
                target: a.nbr,
            });
            if self.trail {
                self.used_edges.push(a.eid);
            }
            if self.node_unique {
                self.used_nodes.push(a.nbr);
            }
            self.closed = is_close;
            f(self, a.nbr);
            self.closed = false;
            if self.node_unique {
                self.used_nodes.pop();
            }
            if self.trail {
                self.used_edges.pop();
            }
            self.steps.pop();
        }
    }

    // Match the OUTER unit's element sequence `outer.elems[ei..]` from `v`, then
    // `cont(end)`. A direct hop advances one element (levels `[(orep, ei+1)]`); a
    // Sub repeats its flat inner unit before continuing (levels
    // `[(orep, ei), (irep, ihop+1)]` for its inner hops).
    fn seq(&mut self, v: u32, ei: usize, orep: u32, cont: &mut dyn FnMut(&mut Self, u32)) {
        let outer = self.unit; // copy the &GUnit so `self` stays free for the calls
        if ei == outer.elems.len() {
            cont(self, v);
            return;
        }
        match &outer.elems[ei] {
            GElem::Hop {
                dir,
                etypes,
                edge_pred,
                ..
            } => {
                let want = want_etypes(self.store, etypes).unwrap_or_else(|()| vec![u32::MAX]);
                let (dir, epred) = (*dir, edge_pred.as_deref());
                self.do_hop(
                    v,
                    &want,
                    dir,
                    epred,
                    vec![(orep, ei + 1)],
                    &mut |slf, nbr| slf.seq(nbr, ei + 1, orep, cont),
                );
            }
            GElem::Sub {
                unit: sub,
                min,
                max,
                ..
            } => {
                let (smin, smax) = (*min, *max);
                self.sub_walk(v, sub, smin, smax, orep, ei, 0, &mut |slf, end| {
                    slf.seq(end, ei + 1, orep, cont)
                });
            }
        }
    }

    // Repeat a Sub's flat inner unit [smin,smax] times from `v`; `cont(end)` at each
    // inner-rep-count boundary in range.
    #[allow(clippy::too_many_arguments)]
    fn sub_walk(
        &mut self,
        v: u32,
        sub: &crate::ir::GUnit,
        smin: u32,
        smax: u32,
        orep: u32,
        es: usize,
        irep: u32,
        cont: &mut dyn FnMut(&mut Self, u32),
    ) {
        if irep >= smin {
            cont(self, v);
        }
        if irep < smax {
            self.sub_rep(v, sub, 0, orep, es, irep, &mut |slf, end| {
                // The inner unit's per-rep `WHERE` gates the rep that just completed, BEFORE
                // the recursion — which gates both its emit (at the top of the next
                // `sub_walk`) and any further inner rep. Earlier reps were gated when they
                // completed, so a surviving branch has had every one of its reps tested.
                if slf.inner_rep_ok(sub, orep, irep) {
                    slf.sub_walk(end, sub, smin, smax, orep, es, irep + 1, cont);
                }
            });
        }
    }

    // The INNER unit's own per-repetition `WHERE`, evaluated at the boundary of inner rep
    // `irep` of outer rep `orep` (audit item 252).
    //
    // Built DIRECTLY as typed columns rather than through `bind_nested` like `rep_ok`: that
    // route exists because an OUTER rep's bindings can be nested lists, while an inner rep's
    // are all scalars — its source is one node, each hop one edge and one node. Slots match
    // what the parser bound: the rep's source at 0, hop `p`'s edge at `2p + 1` and its target
    // at `2p + 2`.
    //
    // `levels` is what makes the rep addressable: `sub_rep` tags each of its hops
    // `[(orep, es), (irep, ihop + 1)]`, so this rep's steps are exactly those whose first
    // level is `orep` and whose second is `irep`.
    fn inner_rep_ok(&self, sub: &crate::ir::GUnit, orep: u32, irep: u32) -> bool {
        let Some(pred) = sub.per_rep.as_deref() else {
            return true;
        };
        let rep: Vec<&StepRec> = self
            .steps
            .iter()
            .filter(|s| {
                s.levels.first().is_some_and(|(r, _)| *r == orep)
                    && s.levels.get(1).is_some_and(|(r, _)| *r == irep)
            })
            .collect();
        let Some(first) = rep.first() else {
            // No hops recorded for this rep: nothing to test, so nothing to prune. A zero-hop
            // rep cannot arise from `sub_rep` (it matches the unit's hops), but a predicate
            // over an empty binding would evaluate to null and prune every branch, which is
            // exactly the silent-wrong-answer shape item 51 recorded.
            return true;
        };
        let mut cols: Vec<Col> = Vec::with_capacity(2 * rep.len() + 1);
        cols.push(Col::Nodes(vec![first.source]));
        for s in &rep {
            cols.push(Col::Edges(vec![s.edge]));
            cols.push(Col::Nodes(vec![s.target]));
        }
        let mini = Batch::of(cols);
        eval(pred, self.store, &mini)
            .map(|c| c.value_at(0).is_true())
            .unwrap_or(false)
    }

    // Match one inner rep (the Sub's flat hops) from `v`, then `cont(end)`.
    #[allow(clippy::too_many_arguments)]
    fn sub_rep(
        &mut self,
        v: u32,
        sub: &crate::ir::GUnit,
        ihop: usize,
        orep: u32,
        es: usize,
        irep: u32,
        cont: &mut dyn FnMut(&mut Self, u32),
    ) {
        if ihop == sub.elems.len() {
            cont(self, v);
            return;
        }
        let GElem::Hop {
            dir,
            etypes,
            edge_pred,
            ..
        } = &sub.elems[ihop]
        else {
            return;
        };
        let want = want_etypes(self.store, etypes).unwrap_or_else(|()| vec![u32::MAX]);
        let (dir, epred) = (*dir, edge_pred.as_deref());
        self.do_hop(
            v,
            &want,
            dir,
            epred,
            vec![(orep, es), (irep, ihop + 1)],
            &mut |slf, nbr| slf.sub_rep(nbr, sub, ihop + 1, orep, es, irep, cont),
        );
    }

    // The PER-REP `WHERE` over the just-completed outer rep `orep`: bind the unit's
    // variables in the per-rep view (`key_start = 1`, over that rep's steps) and
    // evaluate. `true` when there is no predicate. A rep failing it is pruned.
    fn rep_ok(&self, orep: u32) -> bool {
        let Some(pred) = self.per_rep else {
            return true;
        };
        let rep_steps: Vec<StepRec> = self
            .steps
            .iter()
            .filter(|s| s.levels.first().is_some_and(|(r, _)| *r == orep))
            .cloned()
            .collect();
        let mut pairs: Vec<(usize, Value)> = Vec::new();
        bind_nested(self.unit, &[], 1, &rep_steps, &mut pairs);
        let maxslot = pairs.iter().map(|(s, _)| *s).max().unwrap_or(0);
        let mut cols: Vec<Col> = (0..=maxslot).map(|_| Col::Gen(vec![Value::Null])).collect();
        // A SCALAR binding goes in a TYPED column, matching what `rep_pred_ok` builds for
        // the single-direction path. Without this a node id arrived as `Value::Num` in a
        // `Col::Gen`, which `Prop` does not read as an element — so `x.name` was NULL, NULL
        // is not true, and every repetition was pruned for ANY predicate. A binding one
        // nesting level deeper is genuinely a LIST in the per-rep view and stays boxed.
        let (mut node_slots, mut edge_slots) = (Vec::new(), Vec::new());
        unit_slot_kinds(self.unit, &mut node_slots, &mut edge_slots);
        for (s, v) in pairs {
            cols[s] = match &v {
                Value::Num(id) if node_slots.contains(&s) => Col::Nodes(vec![*id as u32]),
                Value::Num(id) if edge_slots.contains(&s) => Col::Edges(vec![*id as u32]),
                _ => Col::Gen(vec![v]),
            };
        }
        let mini = Batch::of(cols);
        eval(pred, self.store, &mini)
            .map(|c| c.value_at(0).is_true())
            .unwrap_or(false)
    }

    // The outer repetition: repeat the whole unit [omin,omax] times from `v`,
    // emitting the endpoint at each outer-rep-count boundary in range. A completed
    // outer rep that fails the per-rep `WHERE` prunes that branch.
    fn outer_walk(&mut self, v: u32, orep: u32, emit: &mut dyn FnMut(&mut Self, u32)) {
        if orep >= self.omin {
            emit(self, v);
        }
        // `closed`: a SIMPLE path that has hopped back onto its start terminates there, so a
        // further repetition is not offered. `do_hop` would refuse every hop of it anyway;
        // this makes the termination the structure rather than a consequence.
        if orep < self.omax && !self.closed {
            let mut c = |slf: &mut Self, end: u32| {
                if slf.rep_ok(orep) {
                    slf.outer_walk(end, orep + 1, emit);
                }
            };
            self.seq(v, 0, orep, &mut c);
        }
    }
}

/// Drive the nested-group walk, calling `emit(&mut M, row, end)` once per emitted row.
///
/// Both the materializing [`nested_group`] and the counting [`nested_group_count`] run
/// through here, so every group semantic — the unsupported-shape check, the source
/// column, the path mode, the outer repetition and the per-repetition `WHERE` — is
/// decided by the same code rather than derived twice. Returns false when the unit's
/// shape is not supported, and the caller then yields no rows.
#[allow(clippy::too_many_arguments)]
fn drive_nested(
    batch: &Batch,
    store: &Store,
    from: usize,
    unit: &crate::ir::GUnit,
    min: u32,
    max: u32,
    mode: PathMode,
    per_rep_pred: Option<&Expr>,
    emit: &mut dyn FnMut(&mut M, usize, u32),
) -> bool {
    // Each outer element is a Hop or a Sub whose inner unit is FLAT (hops only — no
    // deeper than 2 levels). Anything else is unsupported here.
    for el in &unit.elems {
        if let GElem::Sub { unit: sub, .. } = el {
            if sub.elems.iter().any(|e| matches!(e, GElem::Sub { .. })) {
                return false;
            }
        }
    }
    let Col::Nodes(src) = batch.slot(from) else {
        return false;
    };
    let mut m = M {
        store,
        unit,
        per_rep: per_rep_pred,
        omin: min,
        omax: max,
        trail: matches!(mode, PathMode::Trail),
        node_unique: matches!(mode, PathMode::Simple | PathMode::Acyclic),
        simple: matches!(mode, PathMode::Simple),
        start: 0, // set per source row below
        closed: false,
        used_edges: Vec::new(),
        used_nodes: Vec::new(),
        steps: Vec::new(),
    };
    for (row, &s) in src.iter().enumerate() {
        m.start = s;
        if m.node_unique {
            m.used_nodes.push(s);
        }
        let mut one = |slf: &mut M, end: u32| emit(slf, row, end);
        m.outer_walk(s, 0, &mut one);
        if m.node_unique {
            m.used_nodes.pop();
        }
    }
    true
}

/// `count(*)` over a nested group: the same walk with a tally instead of a row.
///
/// A nested group appends to `keep`/`ends` per emitted path and then gathers every slot
/// column, which for a bare count materializes millions of rows to return one number.
/// `None` means the unit's shape is unsupported, so the caller must fall through to the
/// general path rather than report a count of zero.
#[allow(clippy::too_many_arguments)]
pub(super) fn nested_group_count(
    batch: &Batch,
    store: &Store,
    from: usize,
    unit: &crate::ir::GUnit,
    min: u32,
    max: u32,
    mode: PathMode,
    per_rep_pred: Option<&Expr>,
    sink: &mut crate::exec::varlen::CountSink,
) -> Option<()> {
    let ok = drive_nested(
        batch,
        store,
        from,
        unit,
        min,
        max,
        mode,
        per_rep_pred,
        &mut |_slf, _row, end| sink.hit(end),
    );
    if ok {
        Some(())
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn nested_group(
    batch: &Batch,
    store: &Store,
    from: usize,
    unit: &crate::ir::GUnit,
    min: u32,
    max: u32,
    mode: PathMode,
    bind_slots: &[usize],
    per_rep_pred: Option<&Expr>,
) -> Batch {
    let empty = || {
        let mut slots: Vec<Col> = batch.slots.iter().map(|_| Col::Nodes(vec![])).collect();
        slots.push(Col::Nodes(vec![]));
        for _ in bind_slots {
            slots.push(Col::Gen(vec![]));
        }
        Batch::of(slots)
    };

    let mut keep: Vec<usize> = Vec::new();
    let mut ends: Vec<u32> = Vec::new();
    let mut cols: Vec<Vec<Value>> = vec![Vec::new(); bind_slots.len()];

    let ok = drive_nested(
        batch,
        store,
        from,
        unit,
        min,
        max,
        mode,
        per_rep_pred,
        &mut |slf, row, end| {
            keep.push(row);
            ends.push(end);
            let mut pairs: Vec<(usize, Value)> = Vec::new();
            bind_nested(unit, &[], 0, &slf.steps, &mut pairs);
            for (ci, &want_slot) in bind_slots.iter().enumerate() {
                let v = pairs
                    .iter()
                    .find(|(sl, _)| *sl == want_slot)
                    .map(|(_, v)| v.clone())
                    .unwrap_or(Value::Null);
                cols[ci].push(v);
            }
        },
    );
    if !ok {
        return empty();
    }

    let mut slots: Vec<Col> = batch.slots.iter().map(|c| c.gather(&keep)).collect();
    slots.push(Col::Nodes(ends));
    for c in cols {
        slots.push(Col::Gen(c));
    }
    Batch::of(slots)
}
