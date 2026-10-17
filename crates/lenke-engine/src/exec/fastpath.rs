use super::aggregation::*;
use super::evaluator::*;
use super::*;
use crate::batch::{Batch, Col};
use crate::gstr::GStr;
use crate::ir::{Expr, Plan};
use crate::store::{Column, Store};
use crate::value::{self, Value};

/// Fused `count(*)` over `Filter(<numeric conj on the frontier>, Expand(Scan))` — the
/// single-hop analogue of [`try_filtered_count`]'s streaming. Sweep the type's edges (per-type
/// CSR) and test the numeric predicate INLINE against the neighbour's column, counting per
/// (src, nbr) PATH — no `[src, nbr]` batch, no keep list, no separate filter pass. Byte-
/// identical: the same typed compare per path as the materialize path (multiplicity kept,
/// present-null dropped). Declined for a reverse-seedable (selective) predicate — the
/// `reverse_seed_worth` guard prices the reverse walk against the SOURCE scan (node count),
/// which over-fires for a sparse type, so `reverse_seed_decide` returning `Some` here means the
/// endpoint is genuinely more selective than sweeping the type's edges forward.
pub(super) fn try_fused_hop_num_count(input: &Plan, store: &Store) -> Option<u64> {
    let (label, w, pred, exp) = fused_hop_shape(input, store)?;
    let (key, bounds) = num_conj_on_slot(pred, 1)?;
    let Some(Column::Num { data, present, .. }) = store.column(&key) else {
        return None;
    };
    if reverse_seed_decide(pred, exp, store, false).is_some() {
        return None;
    }
    let mut count = 0u64;
    for_each_typed_out(store, label, w, |nbr| {
        let j = nbr as usize;
        if present[j] && bounds.iter().all(|&(op, t)| num_pred(op, data[j], t)) {
            count += 1;
        }
    })?;
    Some(count)
}

/// Fused numeric-filtered PROJECTION over `Project(Filter(<numeric conj>, Expand(Scan)))`.
/// The general path pulls the whole expand into an `[src, nbr]` batch, filters, and GATHERS
/// the survivors — a fixed ~0.8ms for an 80k-edge hop no matter how few rows survive, which
/// loses to the TS engine's streaming when the filter is mid-selective (survivors ≪ edges) but not
/// selective enough to reverse-seed. Instead STREAM the type's edges (per-type CSR), test the
/// numeric predicate inline, collect just the surviving TARGET ids, and evaluate the projection
/// over that survivor frontier — the survivor count of output rows, never the `[src, nbr]`
/// intermediate. Byte-identical: same typed test per (src, nbr) PATH, survivors in the same
/// (source, out_adj) order the expand emits, projection unchanged. `None` unless every projected
/// item reads only the endpoint (slot 1), lineage-free, single-type Out hop, per-type CSR fresh,
/// and the endpoint is not reverse-seedable.
pub(super) fn try_fused_hop_project(
    input: &Plan,
    items: &[(String, Expr)],
    store: &Store,
    track: bool,
) -> Option<Batch> {
    if track || items.is_empty() {
        return None;
    }
    let (label, w, pred, exp) = fused_hop_shape(input, store)?;
    if !items.iter().all(|(_, e)| refs_only_slot(e, 1)) {
        return None;
    }
    let (key, bounds) = num_conj_on_slot(pred, 1)?;
    let Some(Column::Num { data, present, .. }) = store.column(&key) else {
        return None;
    };
    if reverse_seed_decide(pred, exp, store, false).is_some() {
        return None;
    }
    // Stream the type's edges, collecting just the surviving TARGET ids (output-proportional,
    // never the `[src, nbr]` intermediate); then evaluate the projection over that frontier.
    let mut survivors: Vec<u32> = Vec::new();
    for_each_typed_out(store, label, w, |nbr| {
        let j = nbr as usize;
        if present[j] && bounds.iter().all(|&(op, t)| num_pred(op, data[j], t)) {
            survivors.push(nbr);
        }
    })?;
    // Evaluate the projection over the survivor frontier (endpoint at slot 1).
    let cols = vec![
        Col::Nodes(vec![0u32; survivors.len()]),
        Col::Nodes(survivors),
    ];
    let out = eval_all(items.iter().map(|(_, e)| e), store, &Batch::of(cols)).ok()?;
    Some(Batch::of(out))
}

/// Fused scalar aggregate — `count(*)` / `sum` / `min` / `max` — over
/// `Filter(<any endpoint-only pred>, Expand(Scan))` for a predicate the inline numeric count
/// can't take (an OR, a mixed-key disjunction, a string search). Sweep the type's edges off
/// the per-type CSR into just the TARGET-id column, run the SAME vectorized `eval_mask` the
/// materialize path would, and fold the aggregate over the TRUE cells — skipping the
/// `[src, nbr]` batch the general Aggregate builds AND the keep-gather it discards. Byte-
/// identical: the mask is per (src, nbr) PATH exactly as the materialize filter, and the flat
/// partition is in the SAME (source, out_adj) order the expand emits, so a float `sum` folds in
/// the identical order. Declined for a reverse-seedable (selective) endpoint.
pub(super) fn try_fused_hop_mask_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.distinct {
        return None;
    }
    // count(*) has no arg; sum/min/max fold a Num property of the frontier (slot 1).
    let arg_key: Option<&String> = match (&agg.func, agg.arg.as_ref()) {
        (AggFn::Count, None) => None,
        (AggFn::Sum | AggFn::Min | AggFn::Max, Some(Expr::Prop { slot: 1, key })) => Some(key),
        _ => return None,
    };
    let (label, w, pred, exp) = fused_hop_shape(input, store)?;
    if !refs_only_slot(pred, 1) {
        return None;
    }
    // The agg property must be a plain Num column (min/max/sum semantics; a NULL cell is
    // skipped, matching the general aggregate).
    let agg_col: Option<(&[f64], &[bool])> = match arg_key {
        Some(k) => match store.column(k)? {
            Column::Num { data, present, .. } => Some((data, present)),
            _ => return None,
        },
        None => None,
    };
    if reverse_seed_decide(pred, exp, store, false).is_some() {
        return None;
    }
    let mut targets: Vec<u32> = Vec::new();
    for_each_typed_out(store, label, w, |nbr| targets.push(nbr))?;
    // Frontier at slot 1; slot 0 is a dummy the endpoint-only predicate never reads.
    let cols = vec![Col::Nodes(vec![0u32; targets.len()]), Col::Nodes(targets)];
    let batch = Batch::of(cols);
    let mask = eval_mask(pred, store, &batch).ok()?;
    let Col::Nodes(targets) = batch.slot(1) else {
        return None;
    };
    let is_true = |i: usize| mask.get(i) == Some(&Some(true));
    match (&agg.func, agg_col) {
        (AggFn::Count, _) => {
            let c = (0..targets.len()).filter(|&i| is_true(i)).count();
            Some(scalar_num(c as f64))
        }
        (AggFn::Sum, Some((data, present))) => {
            let mut total = 0f64;
            for (i, &t) in targets.iter().enumerate() {
                let j = t as usize;
                if is_true(i) && present[j] {
                    total += data[j];
                }
            }
            Some(scalar_num(total))
        }
        (AggFn::Min | AggFn::Max, Some((data, present))) => {
            let want_min = matches!(agg.func, AggFn::Min);
            let mut best: Option<f64> = None;
            for (i, &t) in targets.iter().enumerate() {
                let j = t as usize;
                if is_true(i) && present[j] {
                    let x = data[j];
                    best = Some(match best {
                        None => x,
                        Some(b) => {
                            let ord = value::cmp_num_total(x, b);
                            if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                                x
                            } else {
                                b
                            }
                        }
                    });
                }
            }
            Some(Batch::single(Col::Gen(vec![
                best.map_or(Value::Null, Value::Num)
            ])))
        }
        _ => None,
    }
}

/// Count nodes of `label` whose `pred` holds, STREAMING the label bucket with raw
/// f64 compares — no scan-id materialization, no keep vector. Handles a single
/// `prop OP num` compare and a same-column numeric range (`lo <= x AND x < hi`), the
/// hot filtered-count shapes; `None` for anything else (the caller materializes and
/// runs the general filter). Every survivor test matches `try_filter_keep`'s typed
/// paths exactly (present gates NULL; a NaN cell fails ordering → dropped), so the
/// count is identical.
/// Recognize a filter predicate that is a CONJUNCTION of numeric compares all on the
/// SAME property of one `slot` — `prop OP num` (either operand order) — returning
/// `(key, bounds)`. Shared by the streaming node/edge count fast paths; `None` for a
/// string / disjunction / multi-slot / multi-key / non-numeric predicate.
pub(super) fn num_conj_on_slot(
    pred: &Expr,
    slot: usize,
) -> Option<(String, Vec<(CompareOp, f64)>)> {
    // An atom on `slot` is either a numeric compare (a bound) or a `PropertyExists`
    // presence gate (NO bound — redundant with the streaming count's own `present[i]`
    // check, and implied by any compare on the same key). `has(k, pred)` desugars to
    // `And(PropertyExists{k}, <compare>)`, so accepting the presence atom is what keeps
    // a non-selective `has('age', neq(60)).count()` on the streaming path instead of
    // materializing a 99% keep-list.
    let atom = |e: &Expr| -> Option<(String, Option<(CompareOp, f64)>)> {
        match e {
            Expr::PropertyExists { slot: s, key } if *s == slot => Some((key.clone(), None)),
            Expr::Compare { op, left, right } => {
                let (key, op, lit) = match (left.as_ref(), right.as_ref()) {
                    (Expr::Prop { slot: s, key }, Expr::Lit(v)) if *s == slot => {
                        (key.clone(), *op, v)
                    }
                    (Expr::Lit(v), Expr::Prop { slot: s, key }) if *s == slot => {
                        (key.clone(), flip_op(*op), v)
                    }
                    _ => return None,
                };
                match lit {
                    Value::Num(t) => Some((key, Some((op, *t)))),
                    _ => None,
                }
            }
            _ => None,
        }
    };
    let mut conjuncts = Vec::new();
    flatten_and(pred, &mut conjuncts);
    let mut key0: Option<String> = None;
    let mut bounds: Vec<(CompareOp, f64)> = Vec::with_capacity(conjuncts.len());
    for c in &conjuncts {
        let (key, bound) = atom(c)?;
        match &key0 {
            Some(k) if *k != key => return None, // a second key can't stream one column
            _ => key0 = Some(key),
        }
        if let Some(b) = bound {
            bounds.push(b);
        }
    }
    Some((key0?, bounds))
}

/// Answer `count(*)` over `Filter(edge-pred, Expand{bind_edge})` by STREAMING the
/// expansion — for each source, test each matching out-edge's property inline and
/// count — instead of materializing every `(source, edge, target)` row and filtering
/// (an O(edges) Batch). Edge properties are boxed (a per-key eid→Value map), so the
/// per-edge lookup stays, but the row materialization is what dominated. The survivor
/// test matches the general Filter (a present Num edge prop tests the bounds;
/// null/non-numeric → UNKNOWN → dropped), so the count is identical. Only the pred on
/// the bound EDGE slot (not the target node) is handled; anything else falls through.
pub(super) fn try_edge_filtered_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None; // count(*) only
    }
    let Plan::Filter {
        input: expand,
        pred,
    } = input
    else {
        return None;
    };
    let Plan::Expand {
        input: src,
        from,
        dir,
        edge_label,
        bind_edge,
        double_loops: false,
    } = expand.as_ref()
    else {
        return None;
    };
    if !bind_edge {
        return None; // the edge must be bound for the filter to read its property
    }
    // A bind_edge Expand appends the edge at the slot just past its input (then the
    // target node); the pred must be a numeric conjunction on that edge slot.
    let edge_slot = from + 1;
    let (key, bounds) = num_conj_on_slot(pred, edge_slot)?;
    let want = match want_etypes(store, edge_label) {
        Ok(w) => w,
        Err(()) => return Some(scalar_num(0.0)), // unknown edge type → no rows
    };
    let src_ids = frontier_ids(src, store)?;
    let mut count = 0u64;
    // Typed overlay: read the edge property as a raw f64 (no per-edge hash probe +
    // Value unbox). Falls back to the boxed edge_prop when the overlay is stale or the
    // key is not homogeneously numeric.
    if let Some((data, present)) = store.edge_num_column(&key) {
        for &v in &src_ids {
            for_each_nbr(store, v, *dir, &want, false, |_nbr, eid| {
                let i = eid as usize;
                if present[i] && bounds.iter().all(|&(op, t)| num_pred(op, data[i], t)) {
                    count += 1;
                }
            });
        }
    } else {
        for &v in &src_ids {
            for_each_nbr(store, v, *dir, &want, false, |_nbr, eid| {
                if let Value::Num(x) = store.edge_prop(eid, &key) {
                    if bounds.iter().all(|&(op, t)| num_pred(op, x, t)) {
                        count += 1;
                    }
                }
            });
        }
    }
    Some(scalar_num(count as f64))
}

/// A searched `CASE` that is a categorical remap: EVERY branch condition is
/// `<dict col> = <string literal>` on ONE key. Returns the slot, key, and a code →
/// first-matching-branch-index table (`None` where no branch matches that dict value).
pub(super) fn case_dict_lookup(
    branches: &[(Expr, Expr)],
    store: &Store,
) -> Option<(usize, String, Vec<Option<usize>>)> {
    if branches.is_empty() {
        return None;
    }
    let mut slot_key: Option<(usize, String)> = None;
    let mut lits: Vec<&str> = Vec::with_capacity(branches.len());
    for (cond, _) in branches {
        let Expr::Compare {
            op: CompareOp::Eq,
            left,
            right,
        } = cond
        else {
            return None;
        };
        let (s, k, v) = match (left.as_ref(), right.as_ref()) {
            (Expr::Prop { slot, key }, Expr::Lit(Value::Str(v)))
            | (Expr::Lit(Value::Str(v)), Expr::Prop { slot, key }) => (*slot, key, v),
            _ => return None,
        };
        match &slot_key {
            None => slot_key = Some((s, k.clone())),
            Some((s0, k0)) if *s0 == s && k0 == k => {}
            Some(_) => return None,
        }
        lits.push(v.as_ref());
    }
    let (slot, key) = slot_key?;
    let Some(Column::Dict { dict, .. }) = store.column(&key) else {
        return None;
    };
    let code_to_branch: Vec<Option<usize>> = dict
        .iter()
        .map(|dstr| lits.iter().position(|lit| dstr.as_ref() == *lit))
        .collect();
    Some((slot, key, code_to_branch))
}

/// Is `pred` a disjunction (or a single term) of `slot.key == <literal>`, all on ONE
/// key? Returns that key and the literal values — the shape `x IN [a, b, …]` desugars to.
pub(super) fn eq_disjunction_on_slot(pred: &Expr, slot: usize) -> Option<(String, Vec<Value>)> {
    fn collect(e: &Expr, slot: usize, key: &mut Option<String>, vals: &mut Vec<Value>) -> bool {
        match e {
            Expr::Or(a, b) => collect(a, slot, key, vals) && collect(b, slot, key, vals),
            Expr::Compare {
                op: CompareOp::Eq,
                left,
                right,
            } => {
                let (k, v) = match (left.as_ref(), right.as_ref()) {
                    (Expr::Prop { slot: s, key }, Expr::Lit(v))
                    | (Expr::Lit(v), Expr::Prop { slot: s, key })
                        if *s == slot =>
                    {
                        (key, v)
                    }
                    _ => return false,
                };
                if v.is_null() {
                    return false; // a NULL term makes non-matches UNKNOWN, not FALSE
                }
                match key.as_deref() {
                    None => *key = Some(k.clone()),
                    Some(existing) if existing == k => {}
                    Some(_) => return false, // mixed keys — not this shape
                }
                vals.push(v.clone());
                true
            }
            _ => false,
        }
    }
    let (mut key, mut vals) = (None, Vec::new());
    collect(pred, slot, &mut key, &mut vals).then_some(())?;
    Some((key?, vals))
}

/// If every leaf of `pred` that touches a row is `Prop { slot, key }` for ONE `(slot,
/// key)` (no label tests, presence tests, or other columns), return it — the predicate is
/// a pure function of a single property, evaluable once per distinct value.
pub(super) fn sole_prop_ref(pred: &Expr) -> Option<(usize, String)> {
    fn walk(e: &Expr, seen: &mut Option<(usize, String)>) -> bool {
        match e {
            Expr::Lit(_) => true,
            Expr::Prop { slot, key } => match seen {
                None => {
                    *seen = Some((*slot, key.clone()));
                    true
                }
                Some((s0, k0)) => *s0 == *slot && k0 == key,
            },
            Expr::Not(a) => walk(a, seen),
            Expr::And(a, b) | Expr::Or(a, b) | Expr::Xor(a, b) => walk(a, seen) && walk(b, seen),
            Expr::Compare { left, right, .. } => walk(left, seen) && walk(right, seen),
            Expr::Call { args, .. } => args.iter().all(|a| walk(a, seen)),
            Expr::In { needle, haystack } => walk(needle, seen) && walk(haystack, seen),
            _ => false, // other slots, subqueries, label/presence tests → not pure-in-key
        }
    }
    let mut seen = None;
    walk(pred, &mut seen).then_some(())?;
    seen
}

/// [`sole_prop_ref`] constrained to a specific `slot` (returns just the key).
pub(super) fn sole_prop_key(pred: &Expr, slot: usize) -> Option<String> {
    sole_prop_ref(pred)
        .filter(|(s, _)| *s == slot)
        .map(|(_, k)| k)
}

/// Evaluate a single-property predicate for one concrete value of that property, by
/// substituting the literal and folding the now-constant expression. `None` on a faulting
/// eval; `Some(true)` only when the result is definitely TRUE (3VL — the keep condition).
pub(super) fn dict_pred_value(
    pred: &Expr,
    slot: usize,
    key: &str,
    v: &Value,
    store: &Store,
) -> Option<bool> {
    let e = subst_prop(pred, slot, key, v);
    let col = eval(&e, store, &Batch::single(Col::Num(vec![0.0]))).ok()?;
    Some(matches!(col.value_at(0), Value::Bool(true)))
}

/// Evaluate a scalar expression that is a pure function of one DICT column by computing it
/// once per distinct dict value (≤ dict size) and mapping each row to the shared result —
/// so `upper(city)`, `substring(city, …)`, etc. over a categorical column do dict.len()
/// string allocations instead of one per row (the result `Value`s, including `Arc<str>`,
/// are cloned per row = a refcount bump, not a new allocation). Byte-identical: the value
/// is a function of the property alone (absent → the NULL case, computed once).
/// Fold the boxed `Vec<Value>` a scalar function produced into a TYPED column when every
/// cell is the same non-null primitive (`Num`/`Str`/`Bool`). A downstream sort, DISTINCT or
/// GROUP BY on the computed value then takes the typed fast path (raw f64 / `Arc<str>`
/// compare, dict-code dedup) instead of boxing every cell per comparison. A single null or a
/// mixed type keeps it `Gen`; either way `value_at(i)` is byte-identical for every row, so
/// this is purely an internal representation choice — never an observable one.
pub(super) fn typed_col_from_values(out: Vec<Value>) -> Col {
    let Some(first) = out.first() else {
        return Col::Gen(out);
    };
    match first {
        Value::Num(_) if out.iter().all(|v| matches!(v, Value::Num(_))) => Col::Num(
            out.iter()
                .map(|v| {
                    if let Value::Num(x) = v {
                        *x
                    } else {
                        unreachable!()
                    }
                })
                .collect(),
        ),
        Value::Str(_) if out.iter().all(|v| matches!(v, Value::Str(_))) => Col::Str(
            out.into_iter()
                .map(|v| {
                    if let Value::Str(s) = v {
                        s
                    } else {
                        unreachable!()
                    }
                })
                .collect(),
        ),
        Value::Bool(_) if out.iter().all(|v| matches!(v, Value::Bool(_))) => Col::Bool(
            out.iter()
                .map(|v| {
                    if let Value::Bool(b) = v {
                        *b
                    } else {
                        unreachable!()
                    }
                })
                .collect(),
        ),
        _ => Col::Gen(out),
    }
}

pub(super) fn try_eval_dict_scalar(expr: &Expr, store: &Store, batch: &Batch) -> Option<Col> {
    let (slot, key) = sole_prop_ref(expr)?;
    let Col::Nodes(ids) = batch.slot(slot) else {
        return None;
    };
    let Some(Column::Dict {
        dict,
        codes,
        present,
        ..
    }) = store.column(&key)
    else {
        return None;
    };
    let ev = |v: &Value| -> Option<Value> {
        let e = subst_prop(expr, slot, &key, v);
        Some(
            eval(&e, store, &Batch::single(Col::Num(vec![0.0])))
                .ok()?
                .value_at(0),
        )
    };
    let mut per_code = Vec::with_capacity(dict.len());
    for dv in dict.iter() {
        per_code.push(ev(&Value::Str(dv.clone()))?);
    }
    let null_val = ev(&Value::Null)?;
    Some(Col::Gen(
        ids.iter()
            .map(|&id| {
                if id != u32::MAX && present[id as usize] {
                    per_code[codes[id as usize] as usize].clone()
                } else {
                    null_val.clone()
                }
            })
            .collect(),
    ))
}

/// Keep-list for a predicate that is a pure function of one DICT column: evaluate it once
/// per distinct dict value, then keep rows whose code matches — the projection sibling of
/// [`try_stream_dict_pred_count`], for `WHERE <dict pred> RETURN …`. Byte-identical to the
/// per-row boxed filter (same 3VL TRUE-keeps rule).
pub(super) fn try_filter_keep_dict(
    pred: &Expr,
    store: &Store,
    batch: &Batch,
) -> Option<Vec<usize>> {
    let (slot, key) = sole_prop_ref(pred)?;
    let Col::Nodes(ids) = batch.slot(slot) else {
        return None;
    };
    let Some(Column::Dict {
        dict,
        codes,
        present,
        ..
    }) = store.column(&key)
    else {
        return None;
    };
    let mut matches = Vec::with_capacity(dict.len());
    for dv in dict.iter() {
        matches.push(dict_pred_value(
            pred,
            slot,
            &key,
            &Value::Str(dv.clone()),
            store,
        )?);
    }
    let null_match = dict_pred_value(pred, slot, &key, &Value::Null, store)?;
    Some(
        ids.iter()
            .enumerate()
            .filter_map(|(i, &id)| {
                let hit = if id != u32::MAX && present[id as usize] {
                    matches[codes[id as usize] as usize]
                } else {
                    null_match
                };
                hit.then_some(i)
            })
            .collect(),
    )
}

/// Replace every `Prop { slot, key }` in `e` with `Lit(value)` — so a predicate that is a
/// pure function of one property becomes a constant expression, evaluable once.
pub(super) fn subst_prop(e: &Expr, slot: usize, key: &str, value: &Value) -> Expr {
    match e {
        Expr::Prop { slot: s, key: k } if *s == slot && k == key => Expr::Lit(value.clone()),
        Expr::Not(a) => Expr::Not(Box::new(subst_prop(a, slot, key, value))),
        Expr::And(a, b) => Expr::And(
            Box::new(subst_prop(a, slot, key, value)),
            Box::new(subst_prop(b, slot, key, value)),
        ),
        Expr::Or(a, b) => Expr::Or(
            Box::new(subst_prop(a, slot, key, value)),
            Box::new(subst_prop(b, slot, key, value)),
        ),
        Expr::Xor(a, b) => Expr::Xor(
            Box::new(subst_prop(a, slot, key, value)),
            Box::new(subst_prop(b, slot, key, value)),
        ),
        Expr::Compare { op, left, right } => Expr::Compare {
            op: *op,
            left: Box::new(subst_prop(left, slot, key, value)),
            right: Box::new(subst_prop(right, slot, key, value)),
        },
        Expr::Call { name, args } => Expr::Call {
            name: name.clone(),
            args: args
                .iter()
                .map(|a| subst_prop(a, slot, key, value))
                .collect(),
        },
        Expr::In { needle, haystack } => Expr::In {
            needle: Box::new(subst_prop(needle, slot, key, value)),
            haystack: Box::new(subst_prop(haystack, slot, key, value)),
        },
        other => other.clone(),
    }
}

/// Streaming count for ANY predicate that is a pure function of one DICT column: evaluate
/// it once per distinct dict value (≤ dict size), then count code membership in a single
/// pass — never materializing rows. Covers `STARTS WITH … OR …`, `CONTAINS`, ranges, and
/// arbitrary boolean combinations over a categorical column. Byte-identical: a row is
/// counted iff the predicate is definitely TRUE for its value (or NULL, evaluated once).
pub(super) fn try_stream_dict_pred_count(
    store: &Store,
    label: &Option<String>,
    pred: &Expr,
) -> Option<u64> {
    let key = sole_prop_key(pred, 0)?;
    let Some(Column::Dict {
        dict,
        codes,
        present,
        ..
    }) = store.column(&key)
    else {
        return None;
    };
    let eval_const = |v: &Value| -> Option<bool> {
        let e = subst_prop(pred, 0, &key, v);
        let col = eval(&e, store, &Batch::single(Col::Num(vec![0.0]))).ok()?;
        Some(matches!(col.value_at(0), Value::Bool(true)))
    };
    let mut matches = Vec::with_capacity(dict.len());
    for dv in dict.iter() {
        matches.push(eval_const(&Value::Str(dv.clone()))?);
    }
    let null_match = eval_const(&Value::Null)?;
    let mut count = 0u64;
    scan_visit(store, label, |i| {
        let hit = if present[i] {
            matches[codes[i] as usize]
        } else {
            null_match
        };
        if hit {
            count += 1;
        }
    });
    Some(count)
}

/// Streaming count for categorical membership — `col IN [a, b, …]` (desugared to an
/// OR-chain of equals) on a `Dict` or `Str` column — the string sibling of
/// `try_stream_num_count`. Maps the literals to dict CODES once, then counts matches in
/// one pass over the bucket, never materializing an id vector or keep list. Byte-identical
/// to the OR filter (a literal absent from the dict simply matches nothing).
pub(super) fn try_stream_membership_count(
    store: &Store,
    label: &Option<String>,
    pred: &Expr,
) -> Option<u64> {
    let (key, vals) = eq_disjunction_on_slot(pred, 0)?;
    let mut count = 0u64;
    match store.column(&key)? {
        Column::Dict {
            dict,
            codes,
            present,
            ..
        } => {
            // Every literal must be a string (else it can't equal a dict value). Resolve
            // to codes; a literal not in the dict contributes no code (never matches).
            let mut targets: Vec<u32> = Vec::with_capacity(vals.len());
            for v in &vals {
                let Value::Str(s) = v else { return None };
                if let Some(c) = dict.iter().position(|d| d.as_ref() == s.as_ref()) {
                    targets.push(c as u32);
                }
            }
            scan_visit(store, label, |i| {
                if present[i] && targets.contains(&codes[i]) {
                    count += 1;
                }
            });
        }
        Column::Str { data, present, .. } => {
            let mut targets: Vec<&str> = Vec::with_capacity(vals.len());
            for v in &vals {
                let Value::Str(s) = v else { return None };
                targets.push(s.as_ref());
            }
            scan_visit(store, label, |i| {
                if present[i] && targets.iter().any(|t| data[i].as_ref() == *t) {
                    count += 1;
                }
            });
        }
        _ => return None,
    }
    Some(count)
}

/// `DISTINCT`/`dedup()` over `values(<dict col>)`: emit the distinct dict values in
/// FIRST-SEEN order by scanning codes against a `dict.len()` bitset — never decoding or
/// hashing the per-row strings. Byte-identical to the general first-seen dedup (first
/// occurrence of a code == first occurrence of its string). Bails (→ general path) on any
/// absent value or null-sentinel id, whose NULL dedup this fast path doesn't model.
pub(super) fn try_distinct_dict_col(input: &Plan, store: &Store) -> Option<Batch> {
    let Plan::Project { input: pin, items } = input else {
        return None;
    };
    let [(_, Expr::Prop { slot, key })] = items.as_slice() else {
        return None;
    };
    let Some(Column::Dict {
        dict,
        codes,
        present,
        ..
    }) = store.column(key)
    else {
        return None;
    };
    // `values(k)` drops an element whose property is ABSENT, so Gremlin lowers it to
    // `Project(Filter(PropertyExists{k}))`. That filter is exactly the `present[i]` test
    // this loop already performs — running it as a separate pass materializes and then
    // compacts the whole frontier for nothing. Recognize it and drop it, keeping its
    // meaning by SKIPPING an absent row here instead of bailing out.
    //
    // Measured on 100k `Person` nodes, `values('dept').dedup()` (5 distinct values):
    //
    //   ```text
    //   DistinctBy { Project { Exists { Scan } } }   270.1us   <- what Gremlin emitted
    //   DistinctBy { Project { Scan } }               86.9us   <- the same answer
    //   ```
    //
    // Without the filter present the bail stays: an absent property then means a NULL in
    // the dedup, which is a value, and this path has no way to emit one.
    let (pin, absent_dropped) = match pin.as_ref() {
        Plan::Filter {
            input,
            pred:
                Expr::PropertyExists {
                    slot: fslot,
                    key: fkey,
                },
        } if fslot == slot && fkey == key => (input.as_ref(), true),
        other => (other, false),
    };
    let frontier = pull(pin, store, false).ok()?;
    // The property may sit on any bound slot — slot 0 for `values(k).dedup()`, but the
    // hop endpoint (e.g. slot 2) for `out().out().values(k).dedup()`.
    let Col::Nodes(ids) = frontier.slot(*slot) else {
        return None;
    };
    let mut seen = vec![false; dict.len()];
    let mut out: Vec<GStr> = Vec::new();
    for &id in ids {
        if id == u32::MAX {
            return None; // a NULL value in the dedup — let the general path handle it
        }
        let i = id as usize;
        if !present[i] {
            if absent_dropped {
                continue;
            }
            return None;
        }
        let c = codes[i] as usize;
        if !seen[c] {
            seen[c] = true;
            out.push(dict[c].clone());
        }
    }
    Some(Batch::of(vec![Col::Str(out)]))
}

/// `MATCH (a)-[]->(b) WHERE b.k <op> a.k RETURN count(*)` — a hop whose survival compares
/// the two ENDPOINTS' numeric properties. Stream the edges and compare the source/neighbor
/// num columns directly, never building the neighbor frontier or a boxed compare. A count
/// is order-free, so byte-identical (NaN / absent → not counted, matching the 3VL filter).
pub(super) fn try_edge_cross_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None;
    }
    let Plan::Filter {
        input: expand,
        pred,
    } = input
    else {
        return None;
    };
    let Plan::Expand {
        input: scan,
        from: 0, // source at slot 0, neighbour appended at slot 1
        dir,
        edge_label,
        bind_edge: false,
        double_loops: _,
    } = expand.as_ref()
    else {
        return None;
    };
    let Plan::Scan { label } = scan.as_ref() else {
        return None;
    };
    // The predicate is the endpoint compare, optionally AND a neighbour-label test (the
    // `(b:Label)` pattern) — peel that off and check the label per edge.
    let (cmp, nbr_labels): (&Expr, Option<&[String]>) = match pred {
        Expr::Compare { .. } => (pred, None),
        Expr::And(a, b) => match (a.as_ref(), b.as_ref()) {
            (c @ Expr::Compare { .. }, Expr::IsLabeled { slot: 1, labels })
            | (Expr::IsLabeled { slot: 1, labels }, c @ Expr::Compare { .. }) => (c, Some(labels)),
            _ => return None,
        },
        _ => return None,
    };
    // The compare relates two properties, each on slot 0 (source) or slot 1 (neighbour).
    let Expr::Compare { op, left, right } = cmp else {
        return None;
    };
    let (Expr::Prop { slot: ls, key: lk }, Expr::Prop { slot: rs, key: rk }) =
        (left.as_ref(), right.as_ref())
    else {
        return None;
    };
    if *ls > 1 || *rs > 1 {
        return None;
    }
    let (
        Some(Column::Num {
            data: ld,
            present: lp,
            ..
        }),
        Some(Column::Num {
            data: rd,
            present: rp,
            ..
        }),
    ) = (store.column(lk), store.column(rk))
    else {
        return None; // unboxed numeric endpoints only
    };
    let want = match want_etypes(store, edge_label) {
        Ok(w) => w,
        Err(()) => return Some(scalar_num(0.0)),
    };
    // O(1) neighbour-label check: a membership bitset beats a `is_labeled` binary-search
    // per edge (which made this LOSE to the general path).
    let nbr_bits: Option<Vec<bool>> = nbr_labels.map(|labels| {
        let mut b = vec![false; store.node_count()];
        for l in labels {
            for &id in store.nodes_with_label(l) {
                b[id as usize] = true;
            }
        }
        b
    });
    let mut count = 0u64;
    scan_visit(store, label, |src| {
        let src = src as u32;
        for_each_nbr(store, src, *dir, &want, false, |nbr, _| {
            if let Some(bits) = &nbr_bits {
                if !bits[nbr as usize] {
                    return; // neighbour fails its `(b:Label)` constraint
                }
            }
            let li = if *ls == 0 { src } else { nbr } as usize;
            let ri = if *rs == 0 { src } else { nbr } as usize;
            if lp[li] && rp[ri] && num_pred(*op, ld[li], rd[ri]) {
                count += 1;
            }
        });
    });
    Some(scalar_num(count as f64))
}

/// Count the scanned nodes whose column cell is present and satisfies `cmp`, with `cmp`
/// MONOMORPHIC so it inlines into the sweep (item 451).
fn sweep_num_count<F: Fn(f64) -> bool>(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
    cmp: F,
) -> u64 {
    let mut count = 0u64;
    scan_visit(store, label, |i| {
        if present[i] && cmp(data[i]) {
            count += 1;
        }
    });
    count
}

/// The TWO-BOUND arm of [`try_stream_num_count`], in its own function so that one stays small
/// (item 453).
///
/// Item 451 left this measured and open: a range filter cost 1.774 ms at 1,000,000 nodes against
/// 0.459 for a single bound — 3.9x, for one extra f64 compare, which is ~1.1 ns a row and far
/// more than a compare costs. The cause is not the `Vec`: removing it alone measured ~1.12x and
/// left the gap at 3.5x. It is VECTORIZATION — the single-bound sweep's monomorphic closure
/// auto-vectorizes and a pair of `num_pred` matches does not.
///
/// So a RANGE gets four monomorphic arms, which takes it to 0.431 ms: 4.1x, landing exactly on
/// the single-bound cost. Classified rather than matched pairwise, so written order does not
/// matter — `k < 100 AND k > 5` is the same range as `k > 5 AND k < 100` and must not cost more.
///
/// **Why this is a separate function and not an `if` inside the caller.** Written inline, the
/// range arm gained its 4.1x and made the THREE-bound shape 1.4x SLOWER — 1.978 ms to 2.78,
/// consistently over three rounds — because the enclosing function grew and LLVM inlined
/// `scan_visit` differently for the general arm that follows. That is the Rust twin of
/// `ts-closure-size-is-load-bearing` and of item 90's finding that `exec::pull`'s layout is
/// load-bearing crate-wide: **a fast path can cost a shape it never runs, through code layout
/// alone.** The split restores the 3-bound shape and keeps the range win, which is the only
/// configuration where a control that the change cannot reach does not move.
#[inline(never)]
fn try_stream_range_count(
    store: &Store,
    label: &Option<String>,
    bounds: &[(CompareOp, f64)],
    data: &[f64],
    present: &[bool],
) -> Option<u64> {
    let [(op1, t1), (op2, t2)] = bounds else {
        return None;
    };
    let lower = |op: CompareOp, t: f64| match op {
        CompareOp::Gt => Some((t, false)),
        CompareOp::Ge => Some((t, true)),
        _ => None,
    };
    let upper = |op: CompareOp, t: f64| match op {
        CompareOp::Lt => Some((t, false)),
        CompareOp::Le => Some((t, true)),
        _ => None,
    };
    let ((lo, lo_incl), (hi, hi_incl)) = lower(*op1, *t1)
        .zip(upper(*op2, *t2))
        .or_else(|| lower(*op2, *t2).zip(upper(*op1, *t1)))?;
    // Any other PAIR — two equalities, a `<>`, two lower bounds — declines to the caller's
    // general arm rather than getting a half-measure here.
    let count = match (lo_incl, hi_incl) {
        (false, false) => sweep_num_count(store, label, data, present, |x| x > lo && x < hi),
        (false, true) => sweep_num_count(store, label, data, present, |x| x > lo && x <= hi),
        (true, false) => sweep_num_count(store, label, data, present, |x| x >= lo && x < hi),
        (true, true) => sweep_num_count(store, label, data, present, |x| x >= lo && x <= hi),
    };

    Some(count)
}

pub(super) fn try_stream_num_count(
    store: &Store,
    label: &Option<String>,
    pred: &Expr,
) -> Option<u64> {
    let (key, bounds) = num_conj_on_slot(pred, 0)?;
    let Some(Column::Num {
        data,
        present,
        nulls,
    }) = store.column(&key)
    else {
        return None;
    };
    // SINGLE-BOUND specialization (item 451). `bounds` is a heap `Vec`, so the general arm
    // below iterates it — pointer, length, loop, and a runtime `op` match — once per scanned
    // node. Hoisting the one bound into a monomorphic closure leaves the sweep with a compare
    // and a branch.
    //
    // This existed because a filtered `count(*)` measured SLOWER than the same predicate
    // wrapped in a `CASE` (item 450): 0.30 ms against 0.21 at 200,000 nodes, isolated one case
    // per process. The `CASE` form reaches `try_filter_keep`'s plain arm, which matches `op`
    // directly rather than through a `Vec`, and a streaming count with no allocation losing to a
    // path that materializes a 200,000-id batch AND a 91,000-entry keep-list is the tell that the
    // per-element cost, not the allocation, was deciding it.
    if let [(op, t)] = bounds.as_slice() {
        let t = *t;
        let count = match op {
            CompareOp::Eq => sweep_num_count(store, label, data, present, |x| x == t),
            CompareOp::Ne => sweep_num_count(store, label, data, present, |x| x != t),
            CompareOp::Lt => sweep_num_count(store, label, data, present, |x| x < t),
            CompareOp::Le => sweep_num_count(store, label, data, present, |x| x <= t),
            CompareOp::Gt => sweep_num_count(store, label, data, present, |x| x > t),
            CompareOp::Ge => sweep_num_count(store, label, data, present, |x| x >= t),
        };

        return Some(count);
    }
    if let Some(count) = try_stream_range_count(store, label, &bounds, data, present) {
        return Some(count);
    }
    let mut count = 0u64;
    scan_visit(store, label, |i| {
        // A bare presence gate (`has(k)`, no bounds) counts PRESENCE — a stored
        // present-null included (`present || nulls`). A bounded compare counts only
        // typed values (`present`): a null satisfies no numeric predicate.
        if bounds.is_empty() {
            if present[i] || nulls[i] {
                count += 1;
            }
        } else if present[i] && bounds.iter().all(|&(op, t)| num_pred(op, data[i], t)) {
            count += 1;
        }
    });
    Some(count)
}

/// Answer a scalar `count(*)` over a `VarLength` hop by DFS-counting the emitted
/// paths per source row, WITHOUT materializing the (up to millions of) keep/ends
/// vectors or gathering the input slots — which the general VarLength → Aggregate
/// path builds and immediately discards for a count. Same traversal, edge-type
/// filter and trail bookkeeping as `var_length`, so the count is exact and
/// identical. `None` for a grouped / arg'd / DISTINCT aggregate or a non-`VarLength`
/// input (handled elsewhere).
/// `count(*)` over a quantified subpath GROUP, counted without materializing a row.
///
/// Item 47 flattens a single-hop group onto `try_varlen_count`, but a `k > 1` unit cannot be
/// flattened — it emits only at rep boundaries, and the equivalent hop bounds would be
/// `min * k ..= max * k` — so such a count fell through to the materializing walk and tripped the
/// trail budget. That budget guards against materializing rows, which a bare count does not do,
/// and the TS engine answers the same query: at 20,000 vertices of a random degree-3 graph the
/// count is 1,796,808, over the 1,000,000 default, and native refused where TS did not.
///
/// A `per_rep_pred` is carried through rather than declined, because `run_varlen` applies it
/// during the walk exactly as the materializing path does.
pub(super) fn try_group_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None; // count(*) only — anything else reads a column
    }
    // An endpoint filter sits ABOVE the group (`(t:Person)` and `WHERE t.age < 10` both lower
    // that way), and declining on it put the count back on the materializing walk — measured on
    // 50,000 vertices, 911,360us for the nested form and an outright `E_RESOURCE_EXHAUSTED` for
    // the `k = 2` one, a count the TS engine answers. The filter cannot be dropped, so the sink
    // applies it: see `CountSink`.
    let (input, endpoint) = peel_endpoint_filter(input);
    let pred = endpoint.map(|(p, _)| p);
    let mut sink = crate::exec::varlen::CountSink::new(store, pred.is_some());
    match input {
        Plan::RepeatGroup {
            input: inner,
            from,
            dir,
            edge_label,
            min,
            max,
            mode,
            k,
            per_rep_pred,
            ..
        } => {
            let batch = pull(inner, store, false).ok()?;
            crate::exec::varlen::var_length_count(
                &batch,
                store,
                *from,
                *dir,
                edge_label,
                *min,
                *max,
                *mode,
                per_rep_pred.as_deref(),
                *k,
                false,
                &mut sink,
            )?;
        }
        // A unit with mixed hop directions lowers to `NestedGroup`, which has its own
        // walker rather than `run_varlen` — so it needs its own counting sink, not a
        // flattening onto the var-length one.
        Plan::NestedGroup {
            input: inner,
            from,
            unit,
            min,
            max,
            mode,
            per_rep_pred,
            ..
        } => {
            let batch = pull(inner, store, false).ok()?;
            crate::exec::nested::nested_group_count(
                &batch,
                store,
                *from,
                unit,
                *min,
                *max,
                *mode,
                per_rep_pred.as_deref(),
                &mut sink,
            )?;
        }
        _ => return None,
    }

    let n = sink
        .finish(pred, endpoint.map_or(0, |(_, slot)| slot), store)
        .ok()?;
    Some(scalar_num(n as f64))
}

/// Peel a `Filter` whose predicate reads ONLY the group's endpoint slot off a count's input,
/// returning the group and that predicate with the slot it reads.
///
/// An endpoint-only predicate is a function of the node the path ended at and nothing else, which
/// is what lets a counting sink apply it once per distinct reached node. Anything else — a
/// predicate touching a source column, a bound list, or the endpoint AND something else — is left
/// in place, so the count declines and the general path runs, exactly as before.
fn peel_endpoint_filter(input: &Plan) -> (&Plan, Option<(&Expr, usize)>) {
    let Plan::Filter { input: inner, pred } = input else {
        return (input, None);
    };
    match endpoint_slot_of(inner) {
        Some(endpoint) if crate::opt::reads_only_slot(pred, endpoint) => {
            (inner, Some((pred, endpoint)))
        }
        _ => (input, None),
    }
}

/// Where a path-producing plan puts the endpoint its count is about.
fn endpoint_slot_of(p: &Plan) -> Option<usize> {
    match p {
        Plan::RepeatGroup { endpoint_slot, .. } | Plan::NestedGroup { endpoint_slot, .. } => {
            Some(*endpoint_slot)
        }
        // A var-length hop appends its endpoint after its input's columns. A `{1,2}`
        // single-direction group flattens to one of these, which is the most ordinary shape a
        // user writes.
        Plan::VarLength { input: below, .. } => crate::opt::plan_out_width(below),
        _ => None,
    }
}

pub(super) fn try_varlen_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None; // count(*) only
    }
    // An endpoint filter sits ABOVE the hop, and declining on it sent the count to the
    // materializing path. The same peel the group counts use.
    let (input, endpoint) = peel_endpoint_filter(input);
    let pred = endpoint.map(|(p, _)| p);
    let Plan::VarLength {
        input: inner,
        from,
        dir,
        edge_label,
        min,
        max,
        mode,
        until,
        body_filter,
        double_loops,
        ..
    } = input
    else {
        return None;
    };
    if until.is_some() {
        return None; // an until(pred) walk emits a filtered subset — no closed-form count
    }
    // A `body_filter` is a per-LANDING node predicate (item 570 routes a `k = 1` per-rep
    // `WHERE` here). The algebra below folds it in as a second mask; the DFS fallback at the
    // bottom does NOT take one, so if the algebra declines this must decline too rather than
    // enumerate without the filter. That is the `return None` guarding the fallback.
    let want = match want_etypes(store, edge_label) {
        Ok(w) => w,
        // Unknown edge type → no edge is traversable. A non-empty want of a non-existent id
        // (etype ids are dense, so `u32::MAX` is none) matches nothing, which is NOT the same as
        // "no rows": a `{0,n}` quantifier still emits the zero-length path, one per source row.
        // Returning 0 here answered 0 where the pattern returns one row per source. The sentinel
        // is the idiom the agg twin and `var_length` itself already use.
        Err(()) => vec![u32::MAX],
    };
    let batch = pull(inner, store, false).ok()?;
    let Col::Nodes(src) = batch.slot(*from) else {
        return None;
    };

    // ALGEBRAIC count: for a bounded OUT walk/trail with max<=2, count(*) is the sum of
    // per-hop path counts computed from degrees in O(V+E) — NOT by enumerating the
    // O(paths) walks. 1-hop = the source out-edges; 2-hop = for each source out-edge
    // s->y, the neighbour's out-degree. A TRAIL (no edge reuse) then excludes the one
    // reused-self-loop path s->s->s over the same edge; a WALK (repeat()'s default)
    // permits it, so it makes no correction. Only taken when the enumeration would be
    // the MORE expensive path (a large source set); a filtered / small source stays on
    // the DFS below, where enumeration is already cheap. WALK/TRAIL only: the degree
    // algebra counts node-repeating paths, which SIMPLE / ACYCLIC forbid — those must
    // enumerate via the DFS below.
    let is_trail = matches!(mode, PathMode::Trail);
    if matches!(dir, Dir::Out)
        && *max <= 2
        && *max >= 1
        && matches!(mode, PathMode::Trail | PathMode::Walk)
    {
        let (nc, ec) = (store.node_count(), store.edge_count());
        let avg_deg = if nc == 0 { 0.0 } else { ec as f64 / nc as f64 };
        let est_paths = src.len() as f64 * avg_deg.powi(*max as i32);
        if est_paths > 2.0 * (nc + ec) as f64 {
            // An endpoint predicate folds INTO the algebra rather than defeating it: a node's
            // contribution as a hop TARGET is either counted or not, so the per-node out-degree
            // becomes a per-node PASSING out-degree.
            //
            // The labelled block is the fallback. Unlike the per-endpoint sink, this asks the
            // predicate about EVERY node rather than only the reached ones, so it can fail where
            // the walk would not — see `an_endpoint_predicate_is_evaluated_only_for_reached_nodes`.
            // On that it breaks out and the enumeration below answers.
            'algebra: {
                let ok: Option<Vec<bool>> = match pred {
                    None => None,
                    Some(p) => {
                        let slot = endpoint.map_or(0, |(_, slot)| slot);
                        match crate::exec::varlen::node_pass_mask(p, slot, store) {
                            Ok(o) => Some(o),
                            Err(_) => break 'algebra,
                        }
                    }
                };
                // The BODY mask is a second, independent question from the endpoint one, and
                // the two apply at different places: the endpoint predicate asks only about a
                // path's LAST node, the body filter about EVERY node past the source. A 2-hop
                // path `s -> y -> z` needs `body(y) && body(z) && end(z)`; a 1-hop `s -> y`
                // needs `body(y) && end(y)`; the zero-length path has no landing at all, so
                // only `end(s)` applies to it. Collapsing them into one mask would silently
                // apply the endpoint predicate to the intermediate node.
                let body_ok: Option<Vec<bool>> = match body_filter {
                    None => None,
                    Some(p) => {
                        match crate::exec::varlen::node_pass_mask(p, batch.slots.len(), store) {
                            Ok(o) => Some(o),
                            Err(_) => break 'algebra,
                        }
                    }
                };
                let passes = |v: u32| ok.as_ref().is_none_or(|o| o[v as usize]);
                let body = |v: u32| body_ok.as_ref().is_none_or(|o| o[v as usize]);
                let mut outdeg = vec![0u64; nc];
                for (v, d) in outdeg.iter_mut().enumerate() {
                    let adj = store.out(v as u32);
                    // The O(1) read stays for the common case; a wanted-type or predicate filter
                    // is what forces the walk over the adjacency.
                    *d = if want.is_empty() && ok.is_none() && body_ok.is_none() {
                        adj.len() as u64
                    } else {
                        adj.iter()
                            .filter(|a| {
                                edge_carries_wanted(store, a, &want) && passes(a.nbr) && body(a.nbr)
                            })
                            .count() as u64
                    };
                }
                let mut total: u64 = 0;
                // A ZERO-LENGTH path: `{0,n}` emits the source itself as an endpoint, one row per
                // source row, and the degree algebra counted only paths that traverse an edge
                // (item 64). Its endpoint is the SOURCE, so an endpoint predicate applies to that.
                if *min == 0 {
                    total += src.iter().filter(|&&s| passes(s)).count() as u64;
                }
                for &s in src {
                    for a in store.out(s) {
                        if !edge_carries_wanted(store, a, &want) {
                            continue;
                        }
                        if *min <= 1 && passes(a.nbr) && body(a.nbr) {
                            total += 1; // the 1-hop path s -> a.nbr
                        }
                        // The body filter PRUNES, so a failing `a.nbr` kills the 2-hop paths
                        // through it as well as the 1-hop path to it.
                        if *max >= 2 && body(a.nbr) {
                            // 2-hop paths s -> a.nbr -> z
                            total += outdeg[a.nbr as usize];
                            // A trail excludes the one path that reuses this edge, `s -> s -> s`,
                            // which `outdeg[s]` counted — and only if that endpoint passes.
                            // No `body(s)` term: this arm is already inside `body(a.nbr)` and
                            // `a.nbr == s`, so the body mask is known true here. It was written
                            // with one, and mutation showed the condition UNKILLABLE — provably
                            // dead rather than untested, so it is gone instead of pinned.
                            if is_trail && a.nbr == s && passes(s) {
                                total -= 1;
                            }
                        }
                    }
                }
                return Some(scalar_num(total as f64));
            }
        }
    }

    if body_filter.is_some() {
        return None; // see the note above `want`: the DFS below ignores a body filter
    }
    let mut sink = crate::exec::varlen::CountSink::new(store, pred.is_some());
    let mut used: Vec<u32> = Vec::new();
    let node_unique = matches!(mode, PathMode::Simple | PathMode::Acyclic);
    for &v in src {
        if node_unique {
            used.push(v); // mark the start node
        }
        varlen_count_dfs(
            store,
            v,
            0,
            *min,
            *max,
            *dir,
            &want,
            *mode,
            v,
            &mut used,
            &mut sink,
            *double_loops,
        );
        if node_unique {
            used.pop();
        }
        debug_assert!(used.is_empty());
    }
    let total = sink
        .finish(pred, endpoint.map_or(0, |(_, slot)| slot), store)
        .ok()?;
    Some(scalar_num(total as f64))
}

/// The shared LEAN iterative walker behind the count/agg var-length fast-paths: like
/// `varlen_walk` but with neither the path stacks nor an emit sink — it just calls
/// `visit(v)` once per "row" the materializing path would emit (every length in
/// `min..=max`, plus each `Close` endpoint). An explicit heap frame stack, so it uses
/// O(1) CALL stack however deep the closure — the recursive twins it replaced went one
/// frame per hop, so a deep count/agg could overflow (or commit the 1 GiB big stack).
#[allow(clippy::too_many_arguments)]
pub(super) fn varlen_scan_walk(
    store: &Store,
    v0: u32,
    min: u32,
    max: u32,
    dir: Dir,
    want: &[u32],
    mode: PathMode,
    start: u32,
    used: &mut Vec<u32>,
    double_loops: bool,
    visit: &mut dyn FnMut(u32),
) {
    // Root pre-work: the length-0 source is a row iff `min == 0`; no descent past `max`.
    if min == 0 {
        visit(v0);
    }
    if max == 0 {
        return;
    }
    let drop_loop = matches!(dir, Dir::Both) && !double_loops;
    struct SF {
        v: u32,
        len: u32,
        cursor: usize,
        pending: Option<bool>, // Some(pop_used) once we've descended into a child
    }
    let mut stack = vec![SF {
        v: v0,
        len: 0,
        cursor: 0,
        pending: None,
    }];
    'frames: while let Some(top) = stack.last_mut() {
        if let Some(pop_used) = top.pending.take() {
            if pop_used {
                used.pop();
            }
        }
        let (v, len) = (top.v, top.len);
        loop {
            let Some((is_inc, a)) = adj_nth(store, v, dir, top.cursor) else {
                stack.pop();
                continue 'frames;
            };
            top.cursor += 1;
            if !want.is_empty()
                && !want.iter().any(|&w| {
                    w == a.etype
                        || (store.has_multi_label_edges() && store.edge_has_label(a.eid, w))
                })
            {
                continue;
            }
            if is_inc && drop_loop && a.nbr == v {
                continue;
            }
            let mark = match varlen_step(mode, start, &a, used) {
                VarStep::Skip => continue,
                VarStep::Close => {
                    if len + 1 >= min {
                        visit(a.nbr);
                    }
                    continue;
                }
                VarStep::Go(mark) => mark,
            };
            // Child pre-work at len+1: it is a row iff in range, then descend unless at
            // `max` (the recursion's `len == max` early return — its mark push/pop around
            // an immediately-returning child cannot affect the tally, so we skip it).
            let clen = len + 1;
            if clen >= min {
                visit(a.nbr);
            }
            if clen == max {
                continue;
            }
            if let Some(m) = mark {
                used.push(m);
            }
            top.pending = Some(mark.is_some());
            stack.push(SF {
                v: a.nbr,
                len: clen,
                cursor: 0,
                pending: None,
            });
            continue 'frames;
        }
    }
}

/// The counting twin of `varlen_dfs`: tallies every row the materializing path would
/// emit. Iterative (see [`varlen_scan_walk`]) so a deep count can't overflow the stack.
#[allow(clippy::too_many_arguments)]
pub(super) fn varlen_count_dfs(
    store: &Store,
    v: u32,
    _len: u32, // always 0 at the call sites — the walk starts at the source
    min: u32,
    max: u32,
    dir: Dir,
    want: &[u32],
    mode: PathMode,
    start: u32,
    used: &mut Vec<u32>,
    sink: &mut crate::exec::varlen::CountSink,
    double_loops: bool,
) {
    // `visit` is called once per row the materializing path would emit, with that row's
    // ENDPOINT — which is exactly what an endpoint predicate is about.
    varlen_scan_walk(
        store,
        v,
        min,
        max,
        dir,
        want,
        mode,
        start,
        used,
        double_loops,
        &mut |end| sink.hit(end),
    );
}

/// The outcome of the per-hop reuse gate ([`varlen_step`]).
pub(super) enum VarStep {
    /// The hop is forbidden — skip this neighbour.
    Skip,
    /// A SIMPLE closing hop (`nbr == start`): emit the endpoint but do NOT descend —
    /// the cycle is closed, and extending it would repeat an interior node (mirrors
    /// the TS engine's `is_close` early-`continue`).
    Close,
    /// Descend. `Some(id)` is pushed onto the reuse stack before recursing (Trail:
    /// the edge id; Simple/Acyclic: the node id); `None` pushes nothing (Walk).
    Go(Option<u32>),
}

/// The per-hop reuse gate shared by every var-length DFS. Decides whether the hop
/// across `a` is legal under `mode`, and whether it closes a Simple cycle.
///
/// For the node modes `used` is a NODE stack (the driver seeds it with `start`); for
/// Trail it is an EDGE stack. `Simple` permits a hop that closes the cycle on the
/// walk's `start` even though `start` is already marked — that hop emits (via
/// [`VarStep::Close`]) but terminates the path.
#[inline]
pub(super) fn varlen_step(
    mode: PathMode,
    start: u32,
    a: &crate::store::Adj,
    used: &[u32],
) -> VarStep {
    if matches!(mode, PathMode::Simple) && a.nbr == start {
        return VarStep::Close;
    }
    let collide = match mode {
        PathMode::Trail => used.contains(&a.eid),
        PathMode::Simple | PathMode::Acyclic => used.contains(&a.nbr),
        PathMode::Walk => false,
    };
    if collide {
        return VarStep::Skip;
    }
    let mark = match mode {
        PathMode::Walk => None,
        PathMode::Trail => Some(a.eid),
        PathMode::Simple | PathMode::Acyclic => Some(a.nbr),
    };
    VarStep::Go(mark)
}

/// Answer `count(DISTINCT endpoint)` over a bounded var-length hop by MULTI-SOURCE
/// BFS with a visited bitset — O(V+E) — instead of enumerating every path (with its
/// full multiplicity) and deduping the endpoints, which explodes with fan-out. The
/// DISTINCT endpoint set is exactly the nodes at shortest distance in `min..=max`
/// from the source set: a node with ANY walk of length `L ≤ max` has shortest
/// distance ≤ L, so a `min ≤ 1` reachability is the same set whether paths are
/// walks or trails (the shortest path is simple, reusing no edge). That equivalence
/// only holds for `min ≤ 1` (a node discovered at its shortest distance `< min`
/// might still be a valid longer-walk endpoint, which BFS would miss), so deeper
/// lower bounds fall back to the general path. The count is a set size, so it is
/// byte-identical to the TS engine's regardless of visitation order.
pub(super) fn try_varlen_distinct_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    // count(DISTINCT <endpoint slot>) only.
    if agg.func != AggFn::Count || !agg.distinct {
        return None;
    }
    let Some(Expr::Slot(want_slot)) = agg.arg.as_ref() else {
        return None;
    };
    let Plan::VarLength {
        input: inner,
        from,
        dir,
        edge_label,
        min,
        max,
        mode,
        until,
        body_filter,
        double_loops: _, // a distinct endpoint set is blind to edge multiplicity
        ..
    } = input
    else {
        return None;
    };
    if until.is_some() || body_filter.is_some() {
        return None; // an until(pred) walk emits a filtered subset — no closed-form count
    }
    // A distinct ENDPOINT set is blind to edge multiplicity, so `double_loops` (a
    // both()-crossed self-loop counted twice) is irrelevant here — the self is reached
    // either way. It is deliberately NOT a bail condition (unlike the multiplicity
    // counts).
    //
    // The set-reachability fusion relies on nodes being allowed to repeat, which SIMPLE and
    // ACYCLIC forbid — so those must enumerate. A TRAIL is the subtler one, and it was WRONG here:
    // it forbids EDGE reuse, and this BFS permits it, so what the BFS computes is WALK
    // reachability. A node reachable only by re-crossing an edge belongs to the walk set and NOT to
    // the trail set, and the shortcut counted it.
    //
    // Two nodes and one edge, `(x)-[:R]-{2,3}(y)`: a trail of length 2 needs two distinct edges, so
    // the pattern returns NO rows, while the BFS walks `a -> b -> a` and reports 2 distinct
    // endpoints. Found by `fastpath_fuzz` at seed 3249 (item 68).
    //
    // `max <= 1` is the whole safe region for a trail: with at most one hop no edge can be reused,
    // so walk and trail reachability coincide. Anything larger needs per-path edge sets, which is
    // not a BFS.
    if !set_reachability_is_exact(*mode, *max) {
        return None;
    }
    let want = match want_etypes(store, edge_label) {
        Ok(w) => w,
        // Unknown edge type → no edge is traversable. A non-empty want of a non-existent id
        // (etype ids are dense, so `u32::MAX` is none) matches nothing, which is NOT the same as
        // "no rows": a `{0,n}` quantifier still emits the zero-length path, one per source row.
        // Returning 0 here answered 0 where the pattern returns one row per source. The sentinel
        // is the idiom the agg twin and `var_length` itself already use.
        Err(()) => vec![u32::MAX],
    };
    let batch = pull(inner, store, false).ok()?;
    // The endpoint the VarLength appends lands at the slot just past the inner width;
    // the DISTINCT arg must be exactly that endpoint (not, say, the source slot).
    if *want_slot != batch.slots.len() {
        return None;
    }
    let Col::Nodes(src) = batch.slot(*from) else {
        return None;
    };
    let count = varlen_distinct_endpoint_count(store, src, *dir, &want, *min, *max);
    Some(scalar_num(count as f64))
}

/// `<walk>.dedup().count()` — `count(*)` over a `DistinctBy` (on the endpoint slot) of a
/// var-length walk. Same distinct-endpoint count as [`try_varlen_distinct_count`]'s
/// `count(DISTINCT endpoint)`, but the front-end spells `dedup().count()` as a separate
/// `DistinctBy` node rather than a distinct aggregate, so it needs its own matcher. The
/// dedup key must be exactly the walk's appended endpoint slot; anything else (dedup on
/// the source, a multi-key dedup) is a different question and falls through.
pub(super) fn try_varlen_distinctby_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None; // plain count(*)
    }
    let Plan::DistinctBy {
        input: inner,
        key_slots,
    } = input
    else {
        return None;
    };
    let [dedup_slot] = key_slots.as_slice() else {
        return None;
    };
    // The dedup'd source is either a var-length WALK (repeat(...).times(k)) or a single
    // Expand hop (`both().dedup()`) — both a distinct-endpoint question. Normalize to
    // (inner-plan, from, dir, edge_label, min, max); a single Expand is a 1-hop walk.
    let (src_plan, from, dir, edge_label, min, max) = match inner.as_ref() {
        Plan::VarLength {
            input: vl_inner,
            from,
            dir,
            edge_label,
            min,
            max,
            mode,
            until,
            body_filter,
            double_loops: _, // a distinct endpoint set is blind to edge multiplicity
            ..
        } => {
            // See the note on `set_reachability_is_exact`: a TRAIL is only safe here at one hop.
            if until.is_some() || body_filter.is_some() || !set_reachability_is_exact(*mode, *max) {
                return None;
            }
            (vl_inner.as_ref(), *from, *dir, edge_label, *min, *max)
        }
        Plan::Expand {
            input: ex_inner,
            from,
            dir,
            edge_label,
            bind_edge,
            double_loops: _,
        } => {
            if *bind_edge {
                return None; // the bound edge slot shifts the endpoint; not this shape
            }
            // A single hop below the dedup; a deeper chain (`both().both().dedup()`) keeps
            // its already-good path — materialize the earlier hops, BFS the last — because
            // a full multi-level BFS from the scan re-expands the whole (dense) graph and
            // measured ~8x SLOWER on a dense 2-hop. (Rejected optimization, kept for the
            // note.)
            (ex_inner.as_ref(), *from, *dir, edge_label, 1u32, 1u32)
        }
        _ => return None,
    };
    let want = match want_etypes(store, edge_label) {
        Ok(w) => w,
        // The sentinel, not an early 0 — see the note in `try_varlen_count`.
        Err(()) => vec![u32::MAX],
    };
    let batch = pull(src_plan, store, false).ok()?;
    // The dedup key must be exactly the endpoint the hop appends (slot == inner width).
    if *dedup_slot != batch.slots.len() {
        return None;
    }
    let Col::Nodes(src) = batch.slot(from) else {
        return None;
    };
    let count = varlen_distinct_endpoint_count(store, src, dir, &want, min, max);
    Some(scalar_num(count as f64))
}

/// The number of DISTINCT nodes reachable from `src` by a Walk/Trail of `min..=max`
/// hops along `dir`/`want` edges — the shared kernel behind both `count(DISTINCT
/// endpoint)` and `count(*)` over a `dedup()` of a var-length walk. Two regimes:
///
/// - `min ≤ 1`: cumulative shortest-distance BFS. Each node is expanded at most once
///   (at its shortest distance), so an edge is traversed once — O(E) — and every node
///   within `max` hops is an endpoint (every hop ≥ 1 ≥ min).
/// - `min ≥ 2`: a walk may revisit, so the endpoints at EXACTLY h hops are the h-th
///   neighbour-set iterate N^h(src), NOT the distance-h set. Expand the DISTINCT
///   frontier one level at a time (each level a set — a node expands at most once per
///   level) and union the levels in `min..=max`. O(hops · E), versus the
///   product-of-degrees an enumeration of every walk would pay.
///
/// Blind to edge multiplicity (a set), so a both()-crossed self-loop needs no special
/// casing. `min == 0` also counts the sources as their own 0-hop endpoints.
/// Is BFS set-reachability the exact answer for this mode and hop bound?
///
/// [`varlen_distinct_endpoint_count`] computes the nodes reachable by a WALK, so it is exact for
/// `Walk` at any bound. For a `Trail` it is exact only at `max <= 1`, where no edge can be reused;
/// beyond that the walk set can strictly contain the trail set. `Simple` and `Acyclic` forbid node
/// reuse, which a BFS frontier permits, so they never qualify.
fn set_reachability_is_exact(mode: PathMode, max: u32) -> bool {
    match mode {
        PathMode::Walk => true,
        PathMode::Trail => max <= 1,
        PathMode::Simple | PathMode::Acyclic => false,
    }
}

pub(super) fn varlen_distinct_endpoint_count(
    store: &Store,
    src: &[u32],
    dir: Dir,
    want: &[u32],
    min: u32,
    max: u32,
) -> usize {
    let n = store.node_count();
    if min >= 2 {
        let mut reached = vec![false; n];
        let mut in_next = vec![false; n];
        let mut seen = vec![false; n];
        let mut frontier: Vec<u32> = Vec::with_capacity(src.len());
        for &s in src {
            if !seen[s as usize] {
                seen[s as usize] = true;
                frontier.push(s);
            }
        }
        let mut next: Vec<u32> = Vec::new();
        for hop in 1..=max {
            if frontier.is_empty() {
                break;
            }
            next.clear();
            for &v in &frontier {
                for_each_nbr(store, v, dir, want, false, |nbr, _| {
                    if !in_next[nbr as usize] {
                        in_next[nbr as usize] = true;
                        next.push(nbr);
                    }
                });
            }
            if hop >= min {
                for &w in &next {
                    reached[w as usize] = true;
                }
            }
            // Reset the level-set for reuse (only the touched entries), then advance.
            for &w in &next {
                in_next[w as usize] = false;
            }
            std::mem::swap(&mut frontier, &mut next);
        }
        return reached.iter().filter(|&&r| r).count();
    }
    let mut visited = vec![false; n]; // added to a frontier (expansion dedup)
    let mut reached = vec![false; n]; // a valid endpoint (hop in min..=max)
    let mut frontier: Vec<u32> = Vec::with_capacity(src.len());
    for &s in src {
        if !visited[s as usize] {
            visited[s as usize] = true;
            frontier.push(s);
        }
        if min == 0 {
            reached[s as usize] = true; // the 0-hop path a=b
        }
    }
    let mut next: Vec<u32> = Vec::new();
    for _hop in 1..=max {
        if frontier.is_empty() {
            break;
        }
        for &v in &frontier {
            for_each_nbr(store, v, dir, want, false, |nbr, _| {
                reached[nbr as usize] = true;
                if !visited[nbr as usize] {
                    visited[nbr as usize] = true;
                    next.push(nbr);
                }
            });
        }
        std::mem::swap(&mut frontier, &mut next);
        next.clear();
    }
    reached.iter().filter(|&&r| r).count()
}

/// The fold twin of `varlen_count_dfs`: calls `emit(endpoint)` at every length in
/// `min..=max` instead of counting. Traversal / edge-type / trail logic — and thus
/// the EMISSION ORDER — are identical to `var_length`, so a `sum` folded here lands
/// the same value as materializing then summing.
#[allow(clippy::too_many_arguments)]
pub(super) fn varlen_agg_dfs(
    store: &Store,
    v: u32,
    _len: u32, // always 0 at the call sites — the walk starts at the source
    min: u32,
    max: u32,
    dir: Dir,
    want: &[u32],
    mode: PathMode,
    start: u32,
    used: &mut Vec<u32>,
    emit: &mut dyn FnMut(u32),
) {
    // The fold twin visits the same endpoints in the same order as the materializing
    // path (this fast-path is only taken without a `both()` double-loop, so `false`).
    varlen_scan_walk(
        store, v, min, max, dir, want, mode, start, used, false, emit,
    );
}

/// A scalar `sum`/`avg`/`min`/`max`/`count(arg)` over a bare var-length's ENDPOINT
/// property, folded DURING the DFS — no keep/ends, no gather, no intermediate batch
/// (which `try_frontier_aggregate`/`aggregate` all build, ~3x the traversal). The
/// emission order matches `var_length`, so `sum` folds in the same order and the
/// value contract (`cmp_num_total`) drives min/max — byte-identical to the
/// materializing path. `None` unless the aggregate reads exactly the appended
/// endpoint slot (block-streaming the general chain was measured a net regression;
/// this surgical fold is the low-overhead win).
pub(super) fn try_varlen_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.distinct
        || !matches!(
            agg.func,
            AggFn::Sum | AggFn::Avg | AggFn::Min | AggFn::Max | AggFn::Count
        )
    {
        return None;
    }
    // The SAME peel `try_varlen_count` already does: an endpoint label or predicate lowers
    // to a `Filter` ABOVE the hop — `(b:Person)` becomes `IsLabeled { slot: <endpoint> }` —
    // and declining on it sent the fold to the MATERIALIZING aggregate. The peel was added
    // to the count twin and not to this one (item 372). Measured 2.32x for `sum` and 1.95x
    // for `max`; and at 200k x degree-5 the labelled spelling additionally FAULTED on the
    // trail ROW CAP that a fold never reaches, so the two spellings of one query differed in
    // whether the query could complete at all, not merely in cost.
    let (input, endpoint) = peel_endpoint_filter(input);
    let Plan::VarLength {
        input: inner,
        from,
        dir,
        edge_label,
        min,
        max,
        mode,
        until,
        body_filter,
        double_loops,
        ..
    } = input
    else {
        return None;
    };
    if until.is_some() || body_filter.is_some() || *double_loops {
        return None; // an until(pred) walk emits a filtered subset — no closed-form agg
    }
    // The aggregate argument must be a property of the ENDPOINT (the appended slot).
    let Some(Expr::Prop { slot, key }) = agg.arg.as_ref() else {
        return None; // count(*) is `try_varlen_count`
    };
    let want = match want_etypes(store, edge_label) {
        Ok(w) => w,
        // Unknown edge type → no paths. A non-empty want of a non-existent id
        // (etype ids are dense, so u32::MAX is none) matches nothing, yielding the
        // empty-aggregate value without a special-cased early return here.
        Err(()) => vec![u32::MAX],
    };
    let batch = pull(inner, store, false).ok()?;
    if *slot != batch.slots.len() {
        return None; // arg is not the endpoint
    }
    let Col::Nodes(src) = batch.slot(*from) else {
        return None;
    };
    let column = store.column(key)?; // property absent everywhere → fall back
    let node_unique = matches!(mode, PathMode::Simple | PathMode::Acyclic);
    // What the endpoint test COSTS per reached node decides whether peeling the filter is a
    // win at all, and the general evaluator already settled that question for `IsLabeled`
    // (E78): a label that every LIVE node carries is a TAUTOLOGY and need not be tested,
    // and otherwise a membership BITSET built once beats probing per row. Two shapes were
    // tried here first and refuted by measurement — `until_ok` per endpoint (a label-string
    // hash plus a bucket binary search every time) at 1.8x SLOWER than not peeling, and the
    // same with the bucket hoisted out of the walk, still 1.22x slower. The fold's win only
    // survives the filter it now has to apply if that filter is O(1).
    enum EndGuard<'a> {
        Off,                   // nothing to test
        Bits(Vec<u64>),        // a selective label: O(1) membership
        Pred(&'a Expr, usize), // anything else: tested per REACHED node
    }
    let guard = match endpoint {
        None => EndGuard::Off,
        Some((Expr::IsLabeled { labels, .. }, _)) => {
            let buckets: Vec<&[u32]> = labels.iter().map(|l| store.nodes_with_label(l)).collect();
            let live = store.live_node_count();
            // A walk emits only live nodes, so unlike the evaluator there is no OPTIONAL
            // `u32::MAX` sentinel left to exclude — the tautology tests nothing at all, and
            // the labelled spelling becomes exactly the bare one.
            if live > 0 && buckets.iter().any(|b| b.len() == live) {
                EndGuard::Off
            } else {
                let mut bits = vec![0u64; store.node_count().div_ceil(64)];
                for b in &buckets {
                    for &id in *b {
                        bits[id as usize / 64] |= 1u64 << (id % 64);
                    }
                }
                EndGuard::Bits(bits)
            }
        }
        Some((pred, slot)) => EndGuard::Pred(pred, slot),
    };
    let walk = |sink: &mut dyn FnMut(u32)| {
        let mut used: Vec<u32> = Vec::new();
        for &v in src {
            if node_unique {
                used.push(v); // mark the start node
            }
            varlen_agg_dfs(
                store, v, 0, *min, *max, *dir, &want, *mode, v, &mut used, sink,
            );
            if node_unique {
                used.pop();
            }
        }
    };
    let dfs = |emit: &mut dyn FnMut(u32)| {
        // The UNGUARDED walk keeps the sink it always had. Wrapping `emit` unconditionally
        // measured ~1.11x on the bare spelling — a tax on the path that has no endpoint
        // filter to pay for, which is the one thing this change must not do.
        if matches!(guard, EndGuard::Off) {
            walk(emit);
            return;
        }
        // The endpoint predicate is tested HERE, once per REACHED endpoint, not swept over
        // every node ahead of the walk. That is not only cheaper, it is the only correct
        // place: a predicate evaluated over nodes the walk never reaches can raise where the
        // query would not — the trap `try_varlen_count` records against its own peel.
        let mut guarded = |v: u32| {
            let pass = match &guard {
                EndGuard::Off => true,
                EndGuard::Bits(bits) => (bits[v as usize / 64] >> (v % 64)) & 1 == 1,
                EndGuard::Pred(pred, slot) => crate::exec::varlen::until_ok(pred, store, *slot, v),
            };
            if pass {
                emit(v);
            }
        };
        walk(&mut guarded);
    };

    let val = match (agg.func, column) {
        (AggFn::Sum | AggFn::Avg, Column::Num { data, present, .. }) => {
            let mut total = 0.0f64;
            let mut cnt = 0u64;
            dfs(&mut |v| {
                let i = v as usize;
                if present[i] {
                    total += data[i];
                    cnt += 1;
                }
            });
            if agg.func == AggFn::Sum {
                Value::Num(total)
            } else if cnt == 0 {
                Value::Null
            } else {
                Value::Num(total / cnt as f64)
            }
        }
        (AggFn::Min | AggFn::Max, Column::Num { data, present, .. }) => {
            let want_min = agg.func == AggFn::Min;
            let mut best: Option<f64> = None;
            dfs(&mut |v| {
                let i = v as usize;
                if present[i] {
                    let x = data[i];
                    best = Some(match best {
                        None => x,
                        Some(b) => {
                            let ord = value::cmp_num_total(x, b);
                            if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                                x
                            } else {
                                b
                            }
                        }
                    });
                }
            });
            best.map_or(Value::Null, Value::Num)
        }
        (AggFn::Min | AggFn::Max, Column::Str { data, present, .. }) => {
            // Track the best endpoint id (not a borrow into `data`), comparing `&str`
            // directly — the value contract's order for two strings is lexicographic,
            // so this equals the materializing min/max. `<`/`>` on equal keeps the
            // first (`cmp_total(..).is_lt()` semantics).
            let want_min = agg.func == AggFn::Min;
            let mut best: Option<u32> = None;
            dfs(&mut |v| {
                let i = v as usize;
                if present[i] {
                    best = Some(match best {
                        None => v,
                        Some(b) => {
                            let (sv, sb) = (data[i].as_ref(), data[b as usize].as_ref());
                            if (want_min && sv < sb) || (!want_min && sv > sb) {
                                v
                            } else {
                                b
                            }
                        }
                    });
                }
            });
            best.map_or(Value::Null, |v| Value::Str(data[v as usize].clone()))
        }
        (
            AggFn::Min | AggFn::Max,
            Column::Dict {
                dict,
                codes,
                present,
                ..
            },
        ) => {
            let want_min = agg.func == AggFn::Min;
            let str_of = |v: u32| dict[codes[v as usize] as usize].as_ref();
            let mut best: Option<u32> = None;
            dfs(&mut |v| {
                if present[v as usize] {
                    best = Some(match best {
                        None => v,
                        Some(b) => {
                            if (want_min && str_of(v) < str_of(b))
                                || (!want_min && str_of(v) > str_of(b))
                            {
                                v
                            } else {
                                b
                            }
                        }
                    });
                }
            });
            best.map_or(Value::Null, |v| {
                Value::Str(dict[codes[v as usize] as usize].clone())
            })
        }
        (AggFn::Min | AggFn::Max, _) => return None, // Temporal/Bool/Gen → general path
        (AggFn::Count, col) => {
            // count(arg): endpoints whose property is present (non-null).
            let present: &[bool] = match col {
                Column::Num { present, .. }
                | Column::Str { present, .. }
                | Column::Bool { present, .. }
                | Column::Dict { present, .. } => present,
                _ => return None, // Temporal/Gen → the general path
            };
            let mut cnt = 0u64;
            dfs(&mut |v| {
                if present[v as usize] {
                    cnt += 1;
                }
            });
            Value::Num(cnt as f64)
        }
        _ => return None,
    };
    Some(Batch::single(Col::Gen(vec![val])))
}

/// `<hop-chain>.values(k).min()/max()` over a pure Scan/Expand chain: fold the numeric
/// property `k` over the per-node PATH-COUNT frontier — WITHOUT materializing the
/// exploding frontier (the min/max analog of the count fast-path). MIN/MAX only: they
/// are order-INDEPENDENT, so collapsing the frontier to per-node multiplicity (which
/// loses row order) is byte-identical; SUM/AVG would change the summation order, so they
/// stay on `try_frontier_aggregate` (`frontier_ids`, which keeps order). Numeric columns
/// only; a filtered chain / edge hop / non-numeric column returns None.
/// `count(*)` over any plan `frontier_counts` can fold — including a `hasLabel(L)`-
/// filtered hop chain (`<hops>.hasLabel(L).count()`) — as the SUM of the per-node path
/// multiplicities, never materializing the frontier. Order-independent (an integer row
/// count), so byte-identical. `None` for a non-fusable shape.
pub(super) fn try_frontier_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None; // count(*) only
    }
    // Only worth the frontier fold when a plain filter/hop chain would otherwise
    // materialize — i.e. there IS a frontier filter (the bare-chain counts already have
    // their own fast-paths). Require a top-level IsLabeled filter.
    if !matches!(
        input,
        Plan::Filter {
            pred: Expr::IsLabeled { .. },
            ..
        }
    ) {
        return None;
    }
    // `count(*)` needs only the TOTAL, so building a per-node map for the LAST hop is
    // pure waste — and it is where the time goes. Stream that hop instead: for each
    // node still carrying paths, count its label-matching neighbours and accumulate
    // `paths * matches`. Every earlier hop still needs its map (that is what keeps a
    // deep chain from enumerating an exploding path multiset); only the last is folded.
    //
    // Measured, 100k `Person` nodes at degree 5, seeded on a 1%-selective range:
    //
    //   ```text
    //   (a:Person)-[:KNOWS]->(b)          16.4us   no frontier label — try_fused_count
    //   (a:Person)-[:KNOWS]->(b:Person)  143.9us   the map, then summed
    //   (a:Person)-[:KNOWS]->(b:Tagged)  105.0us   same, with a 1%-sized label
    //   ```
    //
    // The label's SIZE barely moves it (135.8us at 100% membership against 105.0us at
    // 1%), so the membership bitset was never the cost: the ~5,000-entry `FnvMap`
    // scatter was, at ~16ns an insert. Streaming the hop removes it.
    //
    // Byte-identical for the same reason the sparse/dense switch is: path counts are
    // exact integers below 2^53, so `paths * matches` is exact and the f64 sum does not
    // depend on the order it is accumulated in.
    let streamable = match input {
        Plan::Filter {
            input: hop,
            pred: Expr::IsLabeled { slot, labels },
        } => match &**hop {
            Plan::Expand {
                input: below,
                from,
                dir,
                edge_label,
                double_loops,
                ..
            } if *slot + 1 == chain_width(hop)? && *from + 1 == chain_width(below)? => {
                Some((below, *dir, edge_label, *double_loops, labels))
            }
            _ => None,
        },
        _ => None,
    };
    if let Some((below, dir, edge_label, double_loops, labels)) = streamable {
        let want = match want_etypes(store, edge_label) {
            Ok(w) => w,
            Err(()) => return Some(scalar_num(0.0)), // unknown edge type → no paths
        };
        let prev = frontier_counts(below, store)?;
        // A label that EVERY live node carries is a tautology — `IsLabeled` is ANY-of, so
        // one such label is enough. Recognizing it costs a length comparison and removes
        // both the bitset and the per-neighbour test: 80.1us to 34.1us on a graph whose
        // nodes are all `Person`. Buckets hold only live ids, so the comparison is exact.
        // (34.1us and not the 16.4us of the no-label count because this path still WALKS
        // the adjacency, where `try_fused_count` reads a degree off the CSR offsets.)
        //
        // The alternative to a bitset for the non-universal case is a `binary_search` per
        // neighbour, which the row evaluator switches to for a small frontier. Tried here
        // and REJECTED: it took the 1%-selective 1-hop count from 142.3us to 259.0us,
        // because ~5,000 cache-missing searches cost more than filling the bitset ever
        // does (measured at both 1% and 100% label membership).
        let live = store.live_node_count();
        let universal = live > 0
            && labels
                .iter()
                .any(|l| store.nodes_with_label(l).len() == live);
        let mut member = Vec::new();
        if !universal {
            member = vec![false; store.node_count()];
            for l in labels {
                for &id in store.nodes_with_label(l) {
                    member[id as usize] = true;
                }
            }
        }
        // With a universal label nothing is being tested, so the hop's matching degree IS
        // the hit count — and `matching_degree` can often read it off a contiguous slice
        // instead of walking the adjacency.
        let all_types = want_covers_all_etypes(store, &want);
        let mut total = 0f64;
        prev.for_each(|v, c| {
            let hits = if universal {
                matching_degree(store, v, dir, &want, double_loops, all_types)
            } else {
                let mut h = 0f64;
                for_each_nbr(store, v, dir, &want, double_loops, |nbr, _| {
                    if member[nbr as usize] {
                        h += 1.0;
                    }
                });
                h
            };
            total += c * hits;
        });
        return Some(scalar_num(total));
    }
    let counts = frontier_counts(input, store)?;
    let mut total = 0f64;
    counts.for_each(|_, c| total += c);
    Some(scalar_num(total))
}

pub(super) fn try_frontier_prop_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.distinct || !matches!(agg.func, AggFn::Min | AggFn::Max) {
        return None;
    }
    let Some(Expr::Prop { slot, key }) = agg.arg.as_ref() else {
        return None;
    };
    let width = chain_width(input)?;
    if *slot != width - 1 {
        return None; // arg must be a property of the chain frontier
    }
    let Some(Column::Num { data, present, .. }) = store.column(key) else {
        return None; // non-numeric / absent-everywhere → general path
    };
    let counts = frontier_counts(input, store)?;
    let want_min = agg.func == AggFn::Min;
    let mut best: Option<f64> = None;
    counts.for_each(|v, _c| {
        let i = v as usize;
        if present[i] {
            let x = data[i];
            best = Some(match best {
                None => x,
                Some(b) => {
                    let ord = value::cmp_num_total(x, b);
                    if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                        x
                    } else {
                        b
                    }
                }
            });
        }
    });
    Some(Batch::single(Col::Gen(vec![
        best.map_or(Value::Null, Value::Num)
    ])))
}

/// Answer a scalar `count(*)` over a bare labelled/unlabelled `Scan` in O(1) (a
/// label bucket length — buckets hold only live ids) or a single tombstone-bitmap
/// sweep (unlabelled), WITHOUT materializing the id vector. `None` for any other
/// shape (a WHERE seed, an Expand, `count(arg)`), which the other paths handle.
pub(super) fn try_scan_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() {
        return None; // count(*) only; count(arg)/DISTINCT need the values
    }
    let n = match input {
        Plan::Scan { label: Some(l) } => store.nodes_with_label(l).len(),
        Plan::Scan { label: None } => store.live_node_count(),
        // The EDGE twin, which this had never had: `E().count()` built the whole 1,000,000-id
        // vector in `all_edges` and SORTED it, 12.12 ms, to return its length — while the TS
        // engine answered from a size. `live_edge_count` is that length by construction
        // (audit item 412).
        Plan::EdgeScan => store.live_edge_count(),
        _ => return None,
    };
    Some(scalar_num(n as f64))
}

/// Answer a scalar `sum`/`avg`/`count(arg)` over a bare `Scan`'s Num property by
/// summing the RAW f64 column (present cells only), WITHOUT materializing the
/// frontier or boxing each cell into a `Value`. `None` (fall back) for a grouped
/// aggregate, a DISTINCT, `min`/`max` (need the value-contract order), a non-`Num`
/// column (which may need poison handling), or any non-`Scan` input.
/// A scalar numeric aggregate (`sum`/`avg`/`min`/`max`/`count(prop)`) over a FILTERED
/// scan — `has(...).values(k).sum()` and friends. Get the survivors from the filter fast
/// path (`try_filter_keep`, which raw-passes num/str/And/Not/dict predicates), then
/// accumulate the aggregate directly over their column values — no gather of a survivor
/// frontier, no Project into a Col::Num, no boxed fold. `None` for a non-`Filter{Scan}`
/// input, a non-fast-pathable predicate, or an unsupported agg — the general path runs.
pub(super) fn try_filtered_scan_num_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.distinct
        || !matches!(
            agg.func,
            AggFn::Sum | AggFn::Avg | AggFn::Min | AggFn::Max | AggFn::Count
        )
    {
        return None;
    }
    let Plan::Filter { input: scan, pred } = input else {
        return None;
    };
    let Plan::Scan { label } = scan.as_ref() else {
        return None;
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None; // count(*) is try_filtered_count; only a prop agg here
    };
    let Some(Column::Num { data, present, .. }) = store.column(key) else {
        return None;
    };
    // Survivor ROWS of the scan frontier (row index == the node id for a bare scan).
    let ids: Vec<u32> = match label {
        Some(l) => store.nodes_with_label(l).to_vec(),
        None => store.all_nodes(),
    };
    let batch = Batch::of(vec![Col::Nodes(ids)]);
    let keep = try_filter_keep(pred, store, &batch)?;
    let Col::Nodes(sids) = batch.slot(0) else {
        return None;
    };
    let (mut total, mut cnt, mut best): (f64, u64, Option<f64>) = (0.0, 0, None);
    for &row in &keep {
        let i = sids[row] as usize;
        if !present[i] {
            continue; // the agg's own prop may be NULL even when the filter passed
        }
        let x = data[i];
        total += x;
        cnt += 1;
        best = Some(match best {
            None => x,
            Some(b) => {
                let keep_new = (agg.func == AggFn::Min && value::cmp_num_total(x, b).is_lt())
                    || (agg.func == AggFn::Max && value::cmp_num_total(x, b).is_gt());
                if keep_new {
                    x
                } else {
                    b
                }
            }
        });
    }
    let result = match agg.func {
        AggFn::Sum if agg.null_on_empty && cnt == 0 => Value::Null,
        AggFn::Sum => Value::Num(total),
        AggFn::Count => Value::Num(cnt as f64),
        AggFn::Avg => {
            if cnt == 0 {
                Value::Null
            } else {
                Value::Num(total / cnt as f64)
            }
        }
        _ => best.map_or(Value::Null, Value::Num), // min/max of nothing → NULL
    };
    Some(Batch::single(Col::Gen(vec![result])))
}

/// The STRING twin of [`try_filtered_scan_num_agg`], and the second half of item 421's answer.
///
/// 421 gave the bare-`Scan` `min`/`max` a columnar fold for `Column::Str` and `Column::Dict`.
/// The same `Column::Num` gate sits on this entry and on [`try_frontier_prop_agg`], so after
/// 421 ONE question cost three different amounts depending on how it was spelled — which is the
/// asymmetry this repo is named after, introduced by fixing one spelling and not its siblings.
/// Measured at 1,000,000 nodes over 97 distinct values (audit item 422):
///
/// ```text
///                              string      numeric    the string gate's share
///   scan     max(a.s)         0.796ms      2.151ms    (421: already folded)
///   FILTERED max(a.s)         7.412        2.326       3.2x   <- this entry
///   hop      max(b.s)        14.172        9.372       1.5x   <- still open
/// ```
///
/// The hop/frontier arm is deliberately left: it folds per-node path MULTIPLICITIES rather than
/// rows, and item 376's rule about which aggregates may do that (`count` yes, `sum`/`avg` never)
/// has to be re-read for a dictionary before extending it. A filtered scan has no multiplicity —
/// each survivor is one row — so this one is the same fold 421 shipped over a different id list.
///
/// `Min`/`Max` only, for the reasons 421 records: `Count` over any column type belongs to the
/// filtered count path, and `Sum`/`Avg` over a string is a data exception the general path raises.
/// The survivor-id machinery is byte-for-byte the numeric arm's, so both evaluate the predicate
/// over the same rows in the same order — what items 139/142 require of a fast path.
pub(super) fn try_filtered_scan_str_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.distinct || !matches!(agg.func, AggFn::Min | AggFn::Max) {
        return None;
    }
    let Plan::Filter { input: scan, pred } = input else {
        return None;
    };
    let Plan::Scan { label } = scan.as_ref() else {
        return None;
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    // Decline BEFORE evaluating the predicate: the general path must do that work itself, and
    // doing it twice would make a declined shape slower than no fast path at all.
    if !matches!(
        store.column(key),
        Some(Column::Str { .. } | Column::Dict { .. })
    ) {
        return None;
    }
    let ids: Vec<u32> = match label {
        Some(l) => store.nodes_with_label(l).to_vec(),
        None => store.all_nodes(),
    };
    let batch = Batch::of(vec![Col::Nodes(ids)]);
    let keep = try_filter_keep(pred, store, &batch)?;
    let Col::Nodes(sids) = batch.slot(0) else {
        return None;
    };
    let want_min = agg.func == AggFn::Min;
    let best: Option<GStr> = match store.column(key)? {
        Column::Str { data, present, .. } => {
            let mut best_i: Option<usize> = None;
            for &row in &keep {
                let i = sids[row] as usize;
                // The agg's own prop may be NULL even where the filter passed.
                if !present[i] {
                    continue;
                }
                best_i = Some(match best_i {
                    None => i,
                    Some(b) => {
                        let ord = data[i].cmp(&data[b]);
                        if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                            i
                        } else {
                            b
                        }
                    }
                });
            }
            best_i.map(|i| data[i].clone())
        }
        Column::Dict {
            dict,
            codes,
            present,
            ..
        } => {
            // Which codes SURVIVED. One bool store per survivor, no string comparison — and
            // unlike the unfiltered case, the `present` gate here is load-bearing for the
            // ANSWER in the ordinary way too: a code 0 from an absent slot names `dict[0]`,
            // which the filter may well have excluded.
            let mut seen = vec![false; dict.len()];
            for &row in &keep {
                let i = sids[row] as usize;
                if present[i] {
                    seen[codes[i] as usize] = true;
                }
            }
            let mut best_c: Option<usize> = None;
            for (c, &used) in seen.iter().enumerate() {
                if used {
                    best_c = Some(match best_c {
                        None => c,
                        Some(b) => {
                            let ord = dict[c].cmp(&dict[b]);
                            if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                                c
                            } else {
                                b
                            }
                        }
                    });
                }
            }
            best_c.map(|c| dict[c].clone())
        }
        _ => return None,
    };
    Some(Batch::single(Col::Gen(vec![
        best.map_or(Value::Null, Value::Str)
    ])))
}

/// `count(k)` over a hop-chain FRONTIER, folded from the per-node path multiplicities
/// instead of materializing the frontier ids. Order-INDEPENDENT — a count is integer
/// addition — so collapsing the frontier is byte-identical, exactly as
/// [`try_frontier_count`] already relies on for `count(*)`. The ORDER-DEPENDENT folds
/// cannot do this: `try_frontier_prop_agg`'s own note records that `sum`/`avg` "would
/// change the summation order, so they stay on `try_frontier_aggregate`", and that
/// decision stands (item 376) — this entry exists because `count` is the one aggregate
/// in that family which is NOT order-dependent.
///
/// Any column TYPE, not just `Num`: a count never reads the value, only `present`.
///
/// Declines a bare `Scan`, which belongs to [`try_scan_count_prop`]. **That gate is
/// UNREACHABLE as the chain stands** — `try_scan_count_prop` is placed before this entry,
/// so a bare `Scan` never arrives here — and it is deliberately kept anyway, because item
/// 375 shipped a REORDER of this very region and a path that merely sits earlier silently
/// claims another's shape. Pinned by a direct assertion rather than left unexercised (the
/// practice item 369 established for its own unreachable gates), since a mutation that
/// deletes it cannot fail any end-to-end test: both paths return the same count, and the
/// two were measured at 25.6 vs 23.8us (50k) and 93.0 vs 93.9us (200k) — noise in both
/// directions, so the gate is about OWNERSHIP, not speed.
pub(super) fn try_frontier_count_prop(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.distinct || agg.func != AggFn::Count {
        return None;
    }
    let Some(Expr::Prop { slot, key }) = agg.arg.as_ref() else {
        return None; // `count(*)` is `try_frontier_count`
    };
    if matches!(input, Plan::Scan { .. }) {
        return None;
    }
    let width = chain_width(input)?;
    if *slot != width - 1 {
        return None; // arg must be a property of the chain frontier
    }
    let col = store.column(key)?; // absent everywhere → general path
    let counts = frontier_counts(input, store)?;
    let mut total = 0f64;
    counts.for_each(|v, c| {
        if col.has_value_at(v as usize) {
            total += c;
        }
    });
    Some(Batch::single(Col::Gen(vec![Value::Num(total)])))
}

/// TWO OR MORE scalar aggregates over one frontier — `count(*), max(b.k)` — folded in a single
/// pass over the frontier's (vertex, multiplicity) map.
///
/// WHY THIS EXISTS. Every frontier aggregate path above refuses `aggs.len() != 1`, so a pair
/// fell to the general aggregate, which materializes the whole wide batch. Measured at 200,000
/// nodes over 1,000,000 edges (item 473): `max(b.age)` alone 2.4 ms, `count(*), max(b.age)`
/// 6.4 and `min(b.age), max(b.age)` 8.1.
///
/// The admission set is `count`/`min`/`max`, which is item 376's rule and NOT an arbitrary
/// subset: `count` folds the per-node multiplicities because it does not care about order, and
/// `min`/`max` ignore multiplicity entirely. `sum`/`avg` would have to add a value `c` times in
/// an order the general path does not promise, which is exactly what item 376 declined and
/// item 419 records the cost of.
pub(super) fn try_frontier_multi_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() < 2 || matches!(input, Plan::Scan { .. }) {
        return None;
    }
    let width = chain_width(input)?;
    // Per agg: what to accumulate. `Rows` is `count(*)`, which reads no column.
    enum FSpec<'a> {
        Rows,
        CountProp(&'a Column),
        MinMax(&'a [f64], &'a [bool], bool),
    }
    let mut specs: Vec<FSpec> = Vec::with_capacity(aggs.len());
    for agg in aggs {
        if agg.distinct {
            return None;
        }
        match (agg.func, agg.arg.as_ref()) {
            (AggFn::Count, None) => specs.push(FSpec::Rows),
            (AggFn::Count | AggFn::Min | AggFn::Max, Some(Expr::Prop { slot, key })) => {
                if *slot != width - 1 {
                    return None; // arg must be a property of the chain frontier
                }
                if agg.func == AggFn::Count {
                    specs.push(FSpec::CountProp(store.column(key)?));
                } else {
                    let Some(Column::Num { data, present, .. }) = store.column(key) else {
                        return None;
                    };
                    specs.push(FSpec::MinMax(
                        data.as_slice(),
                        present.as_slice(),
                        agg.func == AggFn::Min,
                    ));
                }
            }
            _ => return None, // sum/avg (item 376) and everything else
        }
    }
    let counts = frontier_counts(input, store)?;
    // (weighted total, best) per agg — one or the other is used, never both.
    let mut acc: Vec<(f64, Option<f64>)> = vec![(0.0, None); specs.len()];
    counts.for_each(|v, c| {
        let i = v as usize;
        for (k, spec) in specs.iter().enumerate() {
            match spec {
                FSpec::Rows => acc[k].0 += c,
                FSpec::CountProp(col) => {
                    if col.has_value_at(i) {
                        acc[k].0 += c;
                    }
                }
                FSpec::MinMax(data, present, want_min) => {
                    if present[i] {
                        let x = data[i];
                        acc[k].1 = Some(match acc[k].1 {
                            None => x,
                            Some(b) => {
                                let ord = value::cmp_num_total(x, b);
                                if (*want_min && ord.is_lt()) || (!*want_min && ord.is_gt()) {
                                    x
                                } else {
                                    b
                                }
                            }
                        });
                    }
                }
            }
        }
    });
    let cols: Vec<Col> = specs
        .iter()
        .zip(&acc)
        .map(|(spec, &(total, best))| {
            let v = match spec {
                FSpec::Rows | FSpec::CountProp(_) => Value::Num(total),
                FSpec::MinMax(..) => best.map_or(Value::Null, Value::Num),
            };
            Col::Gen(vec![v])
        })
        .collect();
    Some(Batch::of(cols))
}

/// `count(<property>)` over a bare `Scan` — a presence scan, with no column materialized.
///
/// `count(expr)` counts NON-NULL values, so for a plain `Prop` it never needs the values at
/// all: the answer is how many of the scanned nodes hold one. `try_scan_num_agg` already did
/// this, but only for a `Column::Num`, which is why the two spellings of one question cost
/// 112us and 1,048us over the same 200,000 vertices — the string column fell through to the
/// general path, which built a 200,000-element `Col::Str` (an `Arc` clone per row) and then
/// asked each cell whether it was null.
///
/// The column's TYPE is irrelevant to a count, so this takes any of them. `has_value_at` is
/// the question: present AND not a stored present-null, which is `present` for a typed
/// variant and a discriminant check for `Gen`.
pub(super) fn try_scan_count_prop(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    // `count(*)` has its own shortcut; DISTINCT needs the values, so it stays on the general
    // path. Only the plain `count(<prop>)`.
    if agg.func != AggFn::Count || agg.distinct {
        return None;
    }
    let Plan::Scan { label } = input else {
        return None;
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    // A key NO node carries counts zero without touching anything — the same rule the typed
    // masks and the seeks apply.
    //
    // A DOTTED path must NOT take that rule: `store.column("m.k")` is `None` because the
    // column is `m`, so without this guard a record field would count ZERO instead of its
    // values. The guard is a CONTRACT rather than a live branch — a dotted access does not
    // reach `Expr::Prop` in an aggregate argument today, verified by removing the guard and
    // seeing `count(n.m.k)` still answer correctly in both engines — so it is pinned by a
    // direct unit test (`the_count_shortcut_declines_a_dotted_key`) rather than through a
    // query, since no query currently reaches it.
    if key.contains('.') {
        return None;
    }
    let Some(col) = store.column(key) else {
        return Some(scalar_num(0.0));
    };
    let mut cnt = 0u64;
    scan_visit(store, label, |i| {
        if col.has_value_at(i) {
            cnt += 1;
        }
    });
    Some(scalar_num(cnt as f64))
}

pub(super) fn try_scan_num_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    // `Count` is NOT here: it does not read the values, so `try_scan_count_prop` answers it
    // for a column of ANY type rather than this arm answering it for `Num` alone.
    //
    // `Min`/`Max` ARE here (item 375), and this entry moved ABOVE `try_frontier_prop_agg` to
    // make that reachable. A bare `Scan` is a trivial frontier, so the frontier path was
    // claiming scan min/max and answering them at 6.4x what this columnar fold charges for
    // `sum` over the SAME column — 180.5us vs 28.1us at 50k. Nothing was wrong with either
    // path; the aggregate set was split across two of them and each covered only half of it.
    if agg.distinct || !matches!(agg.func, AggFn::Sum | AggFn::Avg | AggFn::Min | AggFn::Max) {
        return None;
    }
    let label = match input {
        Plan::Scan { label } => label,
        _ => return None,
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    let Some(Column::Num { data, present, .. }) = store.column(key) else {
        return None; // non-numeric column: the general path handles poison
    };
    let (mut total, mut cnt) = (0f64, 0u64);
    let mut best: Option<f64> = None;
    // Whole-column fast path: when the scan covers EVERY live node (an unlabelled
    // scan, or a label all nodes carry) with nothing deleted, sum the raw
    // `data`/`present` slices directly — no per-row id indirection, so the loop
    // auto-vectorizes. Otherwise walk the label's id list.
    let all_live = store.live_node_count() == store.node_count();
    let whole = all_live
        && match label {
            None => true,
            Some(l) => store.nodes_with_label(l).len() == store.node_count(),
        };
    // The two folds get SEPARATE loops rather than one loop with a branch in it. The first
    // draft shared the body behind an `is_extremum` test and the `sum` CONTROL moved 1.09x
    // the wrong way at 50k — a tax on the aggregate that was already fast, levied to pay for
    // the one being added, inside the loop whose whole point is that it auto-vectorizes.
    // Splitting leaves the sum/avg body byte-for-byte what it was, so the question does not
    // arise rather than being answered.
    if matches!(agg.func, AggFn::Min | AggFn::Max) {
        // min/max fold in the value contract's TOTAL order (`cmp_num_total`: NaN last,
        // NaN == NaN), identical to `try_frontier_prop_agg`'s fold. A plain `f64::min`/`max`
        // here would be byte-identity divergence between two paths answering one query —
        // and it is `-0.0` vs `0.0`, not NaN, where that would bite first.
        let want_min = agg.func == AggFn::Min;
        let mut take = |x: f64| {
            best = Some(match best {
                None => x,
                Some(b) => {
                    let ord = value::cmp_num_total(x, b);
                    if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                        x
                    } else {
                        b
                    }
                }
            });
        };
        if whole {
            for (i, &x) in data.iter().enumerate() {
                if present[i] {
                    take(x);
                }
            }
        } else {
            let mut visit = |i: usize| {
                if present[i] {
                    take(data[i]);
                }
            };
            match label {
                Some(l) => store
                    .nodes_with_label(l)
                    .iter()
                    .for_each(|&id| visit(id as usize)),
                None => (0..store.node_count()).for_each(|i| {
                    if store.is_alive(i as u32) {
                        visit(i);
                    }
                }),
            }
        }
    } else if whole {
        for (i, &x) in data.iter().enumerate() {
            if present[i] {
                total += x;
                cnt += 1;
            }
        }
    } else {
        let mut visit = |i: usize| {
            if present[i] {
                total += data[i];
                cnt += 1;
            }
        };
        match label {
            Some(l) => store
                .nodes_with_label(l)
                .iter()
                .for_each(|&id| visit(id as usize)),
            None => (0..store.node_count()).for_each(|i| {
                if store.is_alive(i as u32) {
                    visit(i);
                }
            }),
        }
    }
    let result = match agg.func {
        // An empty set has no extremum, so NULL — the same answer `try_frontier_prop_agg`
        // gives, and distinct from `sum`'s 0.0 (K0a).
        AggFn::Min | AggFn::Max => best.map_or(Value::Null, Value::Num),
        AggFn::Sum if agg.null_on_empty && cnt == 0 => Value::Null, // Gremlin sum() of nothing
        AggFn::Sum => Value::Num(total), // 0.0 over an empty/all-null set (K0a)
        _ => {
            if cnt == 0 {
                Value::Null // avg of nothing
            } else {
                Value::Num(total / cnt as f64)
            }
        }
    };
    Some(Batch::of(vec![Col::Gen(vec![result])]))
}

/// `MATCH (n:L) RETURN max(n.s)` over a STRING column — the arm [`try_scan_num_agg`]'s gate
/// declines in as many words ("non-numeric column: the general path handles poison").
///
/// What that cost, 5 reps, min, nothing indexed (audit item 421):
///
/// ```text
///                          50k        200k        1M
///   max over a string    0.642ms    2.574ms   12.966ms
///   max over `Num`       0.118      0.472      2.144      5.4-6.0x
///   count(n.s)           0.031      0.123      0.555      21-23x, SAME column
///   project n.s          0.295      1.183     10.547
/// ```
///
/// The 21x against `count` on the same column is the shape of it: `count` reads only the
/// `present` mask, where `max` was materializing rows and boxing each value to compare it.
///
/// The DICTIONARY arm is the reason this is worth its own function rather than one more branch
/// in the numeric one. A `Column::Dict` holds few distinct strings behind a `u32` per row, and
/// the extremum of the column is the extremum of the distinct values that APPEAR in it — so the
/// per-row pass compares no strings at all, it only marks codes, and the string comparisons are
/// one pass over the dictionary. The probe showed the two encodings costing the same before this
/// (2.574ms against 2.564ms at 200k over 97 distinct values versus 200,000), which is what
/// "no encoding awareness" looks like from outside.
///
/// `Min`/`Max` only. `Sum`/`Avg` over a string is a data exception, which the general path
/// raises; `Count` belongs to [`try_scan_count_prop`], which answers it for a column of any
/// type. The order is `GStr::cmp`, which is exactly what `value::cmp_total` dispatches to for
/// `(Str, Str)` — the same single home for order the numeric arm uses `cmp_num_total` from, so
/// two paths answering one query cannot disagree.
pub(super) fn try_scan_str_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.distinct || !matches!(agg.func, AggFn::Min | AggFn::Max) {
        return None;
    }
    let label = match input {
        Plan::Scan { label } => label,
        _ => return None,
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    let want_min = agg.func == AggFn::Min;
    // The extremum is tracked as an INDEX rather than a borrow: `scan_visit` takes an `FnMut`,
    // and holding a `&GStr` out of it across iterations is a borrow the closure cannot own.
    let best: Option<GStr> = match store.column(key)? {
        Column::Str { data, present, .. } => {
            let mut best_i: Option<usize> = None;
            scan_visit(store, label, |i| {
                if present[i] {
                    best_i = Some(match best_i {
                        None => i,
                        Some(b) => {
                            let ord = data[i].cmp(&data[b]);
                            if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                                i
                            } else {
                                b
                            }
                        }
                    });
                }
            });
            best_i.map(|i| data[i].clone())
        }
        Column::Dict {
            dict,
            codes,
            present,
            ..
        } => {
            // Pass one: WHICH codes appear among the scanned rows. No string comparison, one
            // bool store per present row.
            let mut seen = vec![false; dict.len()];
            scan_visit(store, label, |i| {
                if present[i] {
                    seen[codes[i] as usize] = true;
                }
            });
            // Pass two: the extremum among the strings those codes name. `dict.len()` rather
            // than the row count, which is the whole point.
            let mut best_c: Option<usize> = None;
            for (c, &used) in seen.iter().enumerate() {
                if used {
                    best_c = Some(match best_c {
                        None => c,
                        Some(b) => {
                            let ord = dict[c].cmp(&dict[b]);
                            if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                                c
                            } else {
                                b
                            }
                        }
                    });
                }
            }
            best_c.map(|c| dict[c].clone())
        }
        // Every other encoding declines. `Gen` is a mixed column, where the extremum crosses
        // type ranks and belongs to the general fold; `Bool` and `Temporal` have their own
        // orders and are simply not measured here, so they are left where they were rather
        // than extended on a guess.
        _ => return None,
    };
    // An empty set has no extremum, so NULL — the same answer the numeric arm and
    // `try_frontier_prop_agg` give.
    Some(Batch::of(vec![Col::Gen(vec![
        best.map_or(Value::Null, Value::Str)
    ])]))
}

/// Visit each scanned node's dense id (as `usize`) for a bare `Scan`. Iterates the
/// raw `0..node_count` range directly when the scan covers every live node (an
/// unlabelled scan, or a label all nodes carry, nothing deleted) — sequential and
/// vectorizable — otherwise walks the label's id list. Generic over `F` so there is
/// no per-node dynamic dispatch. Shared by the scan-aggregate fast paths.
pub(super) fn scan_visit<F: FnMut(usize)>(store: &Store, label: &Option<String>, mut f: F) {
    let all_live = store.live_node_count() == store.node_count();
    let whole = all_live
        && match label {
            None => true,
            Some(l) => store.nodes_with_label(l).len() == store.node_count(),
        };
    if whole {
        (0..store.node_count()).for_each(&mut f);
    } else {
        match label {
            Some(l) => store
                .nodes_with_label(l)
                .iter()
                .for_each(|&id| f(id as usize)),
            None => (0..store.node_count()).for_each(|i| {
                if store.is_alive(i as u32) {
                    f(i);
                }
            }),
        }
    }
}

/// A group's accumulators: row count (for `count(*)`) plus `(total, count, best)`
/// per numeric aggregate.
struct GroupAcc {
    rows: u64,
    aggs: Vec<(f64, u64, Option<f64>)>,
}

/// Fused single-key grouped aggregate over a bare `Scan`: `RETURN n.k AS key,
/// <aggs> …` where the group key is a `Str`/`Num`/`Bool` column and each aggregate
/// is `count(*)` or a numeric reduction over a `Num` column. Reads the storage
/// columns directly and groups by the TYPED key value (first-seen order, matching
/// the grouping contract), so the frontier and projected columns are never
/// materialized. `None` for any other shape (Temporal/Gen key, non-numeric agg
/// arg, DISTINCT, multi-key). The per-key string hashing is the residual floor.
/// The TIGHT case of [`try_scan_group_agg`]: a plain `count(*) GROUP BY <col>` where the
/// group column is DICTIONARY-encoded (a categorical `city`/`status`). Count directly per
/// dict CODE into a `Vec<u64>` — no per-group `GroupAcc` struct, no `accumulate` closure,
/// no bounds-checked `acc[group]` write per row, just `counts[code] += 1`.
///
/// This exists because the general `GroupAcc` path, while fine natively, is
/// DISPROPORTIONATELY slow on wasm: its nested closure + per-row struct indexing compile
/// to indirect calls / bounds-checked accesses that wasm penalizes several times more
/// than native, which flipped `groupCount().by('city')` and `GROUP BY city` from wins to
/// losses on the wasm surface while they won on FFI/native. The lean loop closes that.
/// Numeric aggregates, multi-agg, and non-dict keys stay on `try_scan_group_agg`.
pub(super) fn try_scan_dict_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let [(_, Expr::Prop { slot: 0, key })] = keys else {
        return None;
    };
    let [agg] = aggs else {
        return None;
    };
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None; // count(*) only
    }
    let Plan::Scan { label } = input else {
        return None;
    };
    let Some(Column::Dict {
        dict,
        codes,
        present,
        ..
    }) = store.column(key)
    else {
        return None;
    };
    // `usize` counters, NOT u64: a count cannot exceed node_count, and `usize` is 32-bit
    // (native i32) on wasm32 where a u64 add is EMULATED — the general path's u64
    // GroupAcc.rows is part of why grouping was disproportionately slow on wasm.
    let mut counts = vec![0usize; dict.len()];
    let mut null_count = 0usize;
    // Group output order is FIRST-SEEN (the grouping contract, matching the general path):
    // record a code the first time it is counted (its count goes 0 -> 1); -1 = null group.
    let mut order: Vec<i32> = Vec::new();
    let mut seen_null = false;
    scan_visit(store, label, |i| {
        if present[i] {
            let c = codes[i] as usize;
            if counts[c] == 0 {
                order.push(c as i32);
            }
            counts[c] += 1;
        } else {
            if !seen_null {
                seen_null = true;
                order.push(-1);
            }
            null_count += 1;
        }
    });
    let mut key_col: Vec<Value> = Vec::with_capacity(order.len());
    let mut cnt_col: Vec<Value> = Vec::with_capacity(order.len());
    for &code in &order {
        if code < 0 {
            key_col.push(Value::Null);
            cnt_col.push(Value::Num(null_count as f64));
        } else {
            key_col.push(Value::Str(dict[code as usize].clone()));
            cnt_col.push(Value::Num(counts[code as usize] as f64));
        }
    }
    Some(Batch::of(vec![Col::Gen(key_col), Col::Gen(cnt_col)]))
}

/// `count(*) GROUP BY <dict col>` over ANY frontier — a hop, a filter — not just a bare
/// Scan (which [`try_scan_dict_count`] already streams). Pull the frontier once, then
/// count per dict CODE, instead of the general group_by decoding each cell to a
/// `Value::Str` and HASHING it (`group_by_arc`) — the string hash over a big hop frontier
/// was the whole cost (`inE('R').outV().groupCount().by('city')` at 0.08x). First-seen
/// group order and null handling (absent OR the u32::MAX optional-match sentinel → the
/// null group) match the general path exactly.
pub(super) fn try_frontier_dict_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
    track: bool,
) -> Option<Batch> {
    let [(_, Expr::Prop { slot, key })] = keys else {
        return None;
    };
    let [agg] = aggs else {
        return None;
    };
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None;
    }
    if matches!(input, Plan::Scan { .. }) {
        return None; // the bare-scan case streams via try_scan_dict_count
    }
    let Some(Column::Dict {
        dict,
        codes,
        present,
        ..
    }) = store.column(key)
    else {
        return None;
    };
    let batch = pull(input, store, track).ok()?;
    let Col::Nodes(ids) = batch.slot(*slot) else {
        return None;
    };
    let mut counts = vec![0usize; dict.len()];
    let mut null_count = 0usize;
    let mut order: Vec<i32> = Vec::new();
    let mut seen_null = false;
    for &id in ids {
        if id != u32::MAX && present[id as usize] {
            let c = codes[id as usize] as usize;
            if counts[c] == 0 {
                order.push(c as i32);
            }
            counts[c] += 1;
        } else {
            if !seen_null {
                seen_null = true;
                order.push(-1);
            }
            null_count += 1;
        }
    }
    let mut key_col: Vec<Value> = Vec::with_capacity(order.len());
    let mut cnt_col: Vec<Value> = Vec::with_capacity(order.len());
    for &code in &order {
        if code < 0 {
            key_col.push(Value::Null);
            cnt_col.push(Value::Num(null_count as f64));
        } else {
            key_col.push(Value::Str(dict[code as usize].clone()));
            cnt_col.push(Value::Num(counts[code as usize] as f64));
        }
    }
    Some(Batch::of(vec![Col::Gen(key_col), Col::Gen(cnt_col)]))
}

pub(super) fn try_scan_group_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let [(_, Expr::Prop { slot: 0, key: gkey })] = keys else {
        return None;
    };
    let label = match input {
        Plan::Scan { label } => label,
        _ => return None,
    };
    // Agg specs: the Num column (None for count(*)) and function.
    type Spec<'a> = (Option<(&'a [f64], &'a [bool])>, AggFn);
    let mut specs: Vec<Spec> = Vec::with_capacity(aggs.len());
    for agg in aggs {
        if agg.distinct {
            return None;
        }
        match (agg.func, agg.arg.as_ref()) {
            (AggFn::Count, None) => specs.push((None, AggFn::Count)),
            (
                AggFn::Sum | AggFn::Avg | AggFn::Count | AggFn::Min | AggFn::Max,
                Some(Expr::Prop { slot: 0, key }),
            ) => {
                let Some(Column::Num { data, present, .. }) = store.column(key) else {
                    return None;
                };
                specs.push((Some((data.as_slice(), present.as_slice())), agg.func));
            }
            _ => return None,
        }
    }

    let mut group_keys: Vec<Value> = Vec::new();
    let mut acc: Vec<GroupAcc> = Vec::new();
    let na = specs.len();
    // Add one row (dense group id `g`) to the accumulators.
    let accumulate = |acc: &mut Vec<GroupAcc>, g: usize, i: usize| {
        let a = &mut acc[g];
        a.rows += 1;
        for (k, &(col, func)) in specs.iter().enumerate() {
            let Some((data, present)) = col else { continue };
            if !present[i] {
                continue;
            }
            let x = data[i];
            let s = &mut a.aggs[k];
            s.0 += x;
            s.1 += 1;
            s.2 = Some(match s.2 {
                None => x,
                Some(b) => match func {
                    AggFn::Min if value::cmp_num_total(x, b).is_lt() => x,
                    AggFn::Max if value::cmp_num_total(x, b).is_gt() => x,
                    _ => b,
                },
            });
        }
    };

    // Resolve a row to a dense group id (first-seen), creating the group on demand.
    macro_rules! run {
        ($present:expr, $lookup:expr, $keyval:expr, $nullkey:expr) => {{
            let present = $present;
            let mut map: FnvMap<_, u32> = FnvMap::default();
            let mut null_group: Option<u32> = None;
            scan_visit(store, label, |i| {
                let g = if present[i] {
                    let k = $lookup(i);
                    match map.get(&k) {
                        Some(&g) => g as usize,
                        None => {
                            let g = group_keys.len() as u32;
                            map.insert(k, g);
                            group_keys.push($keyval(i));
                            acc.push(GroupAcc {
                                rows: 0,
                                aggs: vec![(0.0, 0, None); na],
                            });
                            g as usize
                        }
                    }
                } else {
                    match null_group {
                        Some(g) => g as usize,
                        None => {
                            let g = group_keys.len() as u32;
                            null_group = Some(g);
                            group_keys.push(Value::Null);
                            acc.push(GroupAcc {
                                rows: 0,
                                aggs: vec![(0.0, 0, None); na],
                            });
                            g as usize
                        }
                    }
                };
                accumulate(&mut acc, g, i);
            });
            let _ = $nullkey; // silence unused when the key type has no null path
        }};
    }
    // Only a STRING group key: reading the storage column directly avoids
    // materializing 100k `Arc<str>` (the win). A Num/Bool key already groups via
    // `assign_groups`' typed fast path over the materialized column, which is as
    // fast — so leave those to the general aggregate (this fused path's per-agg
    // accumulator loop is slightly heavier and would regress them).
    match store.column(gkey)? {
        Column::Str { data, present, .. } => {
            run!(
                present,
                |i: usize| data[i].as_ref(),
                |i: usize| Value::Str(data[i].clone()),
                ()
            );
        }
        Column::Dict {
            dict,
            codes,
            present,
            ..
        } => {
            // Group by CODE, mapped to a dense group id in first-seen (scan) order —
            // a per-code slot, no per-row string hash. First-seen (not dict order) is
            // what the pinned GROUP BY order requires, since the dict was built over
            // all nodes and the scan may visit a label subset in a different order.
            let mut code_to_group: Vec<u32> = vec![u32::MAX; dict.len()];
            let mut null_group: Option<u32> = None;
            scan_visit(store, label, |i| {
                let g = if present[i] {
                    let c = codes[i] as usize;
                    if code_to_group[c] == u32::MAX {
                        let g = group_keys.len() as u32;
                        code_to_group[c] = g;
                        group_keys.push(Value::Str(dict[c].clone()));
                        acc.push(GroupAcc {
                            rows: 0,
                            aggs: vec![(0.0, 0, None); na],
                        });
                        g as usize
                    } else {
                        code_to_group[c] as usize
                    }
                } else {
                    match null_group {
                        Some(g) => g as usize,
                        None => {
                            let g = group_keys.len() as u32;
                            null_group = Some(g);
                            group_keys.push(Value::Null);
                            acc.push(GroupAcc {
                                rows: 0,
                                aggs: vec![(0.0, 0, None); na],
                            });
                            g as usize
                        }
                    }
                };
                accumulate(&mut acc, g, i);
            });
        }
        _ => return None,
    }

    // Build the output: the key column, then one column per aggregate.
    let key_col = Col::Gen(group_keys);
    let mut cols = vec![key_col];
    for (k, &(col, func)) in specs.iter().enumerate() {
        let vals: Vec<Value> = acc
            .iter()
            .map(|a| {
                let (total, cnt, best) = a.aggs[k];
                match func {
                    AggFn::Count if col.is_none() => Value::Num(a.rows as f64),
                    AggFn::Count => Value::Num(cnt as f64),
                    AggFn::Sum => Value::Num(total),
                    AggFn::Avg => {
                        if cnt == 0 {
                            Value::Null
                        } else {
                            Value::Num(total / cnt as f64)
                        }
                    }
                    _ => best.map_or(Value::Null, Value::Num),
                }
            })
            .collect();
        cols.push(Col::Gen(vals));
    }
    Some(Batch::of(cols))
}

/// Answer `count(DISTINCT n.k)` over a bare `Scan` by deduping the RAW column into
/// a typed set (a `&str`, the f64 group bits, or a bool) and returning its size —
/// no frontier materialization and no per-cell byte-key serialization. Nulls are
/// skipped (as `count(DISTINCT)` does). `None` for a non-`Scan` input, a
/// Temporal/Gen column, or a non-distinct/`count(*)` agg.
/// A membership bitset over the DISTINCT integer values of a Num column: returns
/// `(min, bits)` where `bits[k]` is set iff the value `min + k` is present. Used
/// instead of hashing when every present value is a finite INTEGER in a small span
/// — `count(DISTINCT age)` / `DISTINCT age` over 100 ages then sets 100 bits rather
/// than hashing 200k cells. One pass finds the span + integrality (a non-integer,
/// NaN, or Inf value disqualifies via `fract()`/`is_finite`), a second sets the
/// bits. Distinct finite integers map to distinct offsets, so a popcount equals the
/// FnvSet's `len` and the set bits recover every distinct value exactly. `None`
/// (fall back to hashing) when the column is empty, non-integer, or spans too wide.
pub(super) fn low_card_int_bitset(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
) -> Option<(f64, Vec<bool>, bool)> {
    const MAX_SPAN: usize = 1 << 20; // cap the bitset at ~1M bits (128 KB)
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut any, mut all_int, mut saw_absent) = (false, true, false);
    // REJECTED (2026-09-27, E80): running this function's TWO sweeps inline for the
    // whole-graph case instead of through `scan_visit`'s closure, the way the `DISTINCT`
    // `Bool` and `Dict` arms do. Same shape of change, and it measured NOTHING here —
    // `DISTINCT n.bucket` over a 50-value column on 100k nodes went 202.7us to 196.0us,
    // inside the noise floor. The cost is the two passes over memory, not the call shape.
    //
    // The bitset itself is emphatically worth keeping: disabling it and falling back to the
    // `FnvSet<u64>` path measured 575.8us for that same query, and 2052.6us against 879.6us
    // for a 100k-distinct column.
    scan_visit(store, label, |i| {
        if present[i] {
            let x = data[i];
            any = true;
            if x.is_finite() && x.fract() == 0.0 {
                lo = lo.min(x);
                hi = hi.max(x);
            } else {
                all_int = false;
            }
        } else {
            saw_absent = true; // a NULL cell — DISTINCT keeps one, count ignores it
        }
    });
    if !any || !all_int {
        return None;
    }
    let span = (hi - lo) as usize;
    if span >= MAX_SPAN {
        return None;
    }
    let mut bits = vec![false; span + 1];
    scan_visit(store, label, |i| {
        if present[i] {
            bits[(data[i] - lo) as usize] = true;
        }
    });
    Some((lo, bits, saw_absent))
}

/// `min(k)` / `max(k)` answered from the RANGE index's first and last key — O(log n) against a
/// column scan of every live node.
///
/// The range twin of [`try_indexed_distinct_count`], and sound for the same three reasons, each
/// checked rather than assumed:
///
/// - **The ORDER agrees.** `OrdVal`, the range index's key, compares by `value::cmp_total`, and
///   that is the order `min`/`max` use (the repo's NaN policy: predicates keep NaN unordered, but
///   sort/min/max use a total order so the two engines stay byte-identical). So the index's
///   extremes ARE the aggregate's, including for NaN and across types — pinned by a differential
///   test over a mixed-type column, not by reading the two comparators.
/// - **NULLs agree.** `range_add` returns early on a null, so a range index holds only non-null
///   values, and `min`/`max` ignore nulls. Exactness additionally needs item 370's emptied-key
///   pruning: without it the first key can be a DELETED node's value.
/// - **The label.** A range index is ANY-LABEL like the hash one, so a labelled scan is answerable
///   only when the label is VACUOUS — the same O(1) exact test.
///
/// `distinct` is DECLINED even though `min(DISTINCT k) == min(k)` semantically. Every sibling fast
/// path declines it, so accepting it here would silently move which path answers a shape for no
/// gain — and "the gates match the path I sit above" is what lets a reader check that these two
/// cannot disagree.
pub(super) fn try_indexed_min_max(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.distinct || !matches!(agg.func, AggFn::Min | AggFn::Max) {
        return None;
    }
    let Plan::Scan { label } = input else {
        return None;
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    if let Some(l) = label {
        if store.nodes_with_label(l).len() != store.live_node_count() {
            return None;
        }
    }

    let (lo, hi) = store.range_min_max(key)?;

    Some(Batch::single(Col::Gen(vec![if agg.func == AggFn::Min {
        lo
    } else {
        hi
    }])))
}

/// `count(DISTINCT n.k)` answered from the hash index's KEY COUNT — O(1) against the vectorized
/// column scan `try_scan_distinct_count` below does, which is O(live nodes).
///
/// Sound because of two things established separately and neither assumed here:
///
/// - **NULLs agree.** `count(DISTINCT x)` excludes nulls, and so does the index — but only since
///   item 368, which found `create_index` indexing them while `apply_set_prop` did not, and a
///   bucket keeping its emptied key after a set. Checked against the path this replaces rather
///   than reasoned: over a fixture with a present null, an absent property and two real values,
///   both the existing answer and `index_distinct_count` are 2.
/// - **The label.** A hash index is ANY-LABEL (`index_lookup`'s own doc), so a LABELLED scan is
///   answerable from it only when the label is **vacuous** — carried by every live node. That test
///   is exact and O(1): label buckets are pruned on delete (`delete_node` "remove it from every
///   label bucket") and `live_node_count` is `node_count - deleted_count`, a maintained counter.
///   A non-vacuous label declines and falls through to the scan, which is correct and merely
///   slower.
///
/// Placed BEFORE `try_scan_distinct_count` for speed only — the two agree on every shape this one
/// accepts, which is what `an_indexed_distinct_count_agrees_with_the_scan` pins.
pub(super) fn try_indexed_distinct_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    // The same gates as `try_scan_distinct_count`, deliberately identical so the two cannot
    // disagree about which shapes they handle.
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || !agg.distinct {
        return None;
    }
    let Plan::Scan { label } = input else {
        return None;
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    // ANY-LABEL index against a labelled scan: only a vacuous label is answerable.
    if let Some(l) = label {
        if store.nodes_with_label(l).len() != store.live_node_count() {
            return None;
        }
    }

    Some(scalar_num(store.index_distinct_count(key)? as f64))
}

pub(super) fn try_scan_distinct_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || !agg.distinct {
        return None;
    }
    let label = match input {
        Plan::Scan { label } => label,
        _ => return None,
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    let count = match store.column(key)? {
        Column::Str { data, present, .. } => {
            let mut seen: FnvSet<&str> = FnvSet::default();
            scan_visit(store, label, |i| {
                if present[i] {
                    seen.insert(data[i].as_ref());
                }
            });
            seen.len()
        }
        Column::Dict {
            dict,
            codes,
            present,
            ..
        } => {
            // A distinct value == a distinct code: mark a per-code bitset, no hashing.
            let mut seen = vec![false; dict.len()];
            scan_visit(store, label, |i| {
                if present[i] {
                    seen[codes[i] as usize] = true;
                }
            });
            seen.iter().filter(|&&b| b).count()
        }
        Column::Num { data, present, .. } => {
            // Low-cardinality integer fast path: dedup with a bitset (popcount), no
            // hashing. Falls back to the FnvSet when values are wide-ranged or
            // non-integer. The distinct count is identical either way.
            if let Some((_, bits, _)) = low_card_int_bitset(store, label, data, present) {
                bits.iter().filter(|&&b| b).count()
            } else {
                let mut seen: FnvSet<u64> = FnvSet::default();
                scan_visit(store, label, |i| {
                    if present[i] {
                        seen.insert(value::num_group_bits(data[i]));
                    }
                });
                seen.len()
            }
        }
        Column::Bool { data, present, .. } => {
            let mut seen = [false; 2];
            scan_visit(store, label, |i| {
                if present[i] {
                    seen[usize::from(data[i])] = true;
                }
            });
            usize::from(seen[0]) + usize::from(seen[1])
        }
        _ => return None, // Temporal / Gen → the general aggregate
    };
    Some(scalar_num(count as f64))
}

/// The frontier sibling of [`try_scan_distinct_count`]: `count(DISTINCT <frontier prop>)`
/// over a hop chain, deduped over the DISTINCT reached endpoints (`frontier_counts`) rather
/// than materializing the exploded path multiset and byte-keying every row through the
/// general grouped fold. Path multiplicity is irrelevant to DISTINCT, so visiting each
/// endpoint once yields the identical value set — byte-identical count, far less work.
pub(super) fn try_frontier_distinct_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || !agg.distinct {
        return None;
    }
    let Some(Expr::Prop { slot, key }) = agg.arg.as_ref() else {
        return None;
    };
    let width = chain_width(input)?;
    if *slot != width - 1 {
        return None; // arg must be a property of the chain frontier
    }
    let counts = frontier_counts(input, store)?;
    let count = match store.column(key)? {
        Column::Str { data, present, .. } => {
            let mut seen: FnvSet<&str> = FnvSet::default();
            counts.for_each(|v, _| {
                let i = v as usize;
                if present[i] {
                    seen.insert(data[i].as_ref());
                }
            });
            seen.len()
        }
        Column::Dict {
            dict,
            codes,
            present,
            ..
        } => {
            let mut seen = vec![false; dict.len()];
            counts.for_each(|v, _| {
                let i = v as usize;
                if present[i] {
                    seen[codes[i] as usize] = true;
                }
            });
            seen.iter().filter(|&&b| b).count()
        }
        Column::Num { data, present, .. } => {
            let mut seen: FnvSet<u64> = FnvSet::default();
            counts.for_each(|v, _| {
                let i = v as usize;
                if present[i] {
                    seen.insert(value::num_group_bits(data[i]));
                }
            });
            seen.len()
        }
        Column::Bool { data, present, .. } => {
            let mut seen = [false; 2];
            counts.for_each(|v, _| {
                let i = v as usize;
                if present[i] {
                    seen[usize::from(data[i])] = true;
                }
            });
            usize::from(seen[0]) + usize::from(seen[1])
        }
        _ => return None, // Temporal / Gen → the general aggregate
    };
    Some(scalar_num(count as f64))
}

/// Answer several scalar numeric aggregates (`sum`/`avg`/`min`/`max`/`count`) over
/// a bare `Scan` in ONE pass over the Num columns — e.g. `min(age), max(age)` or
/// `count(*), avg(age)`. `None` if any agg is grouped/DISTINCT or not a numeric
/// reduction over a `Num` property (or `count(*)`). Complements the single-agg
/// [`try_scan_num_agg`], which keeps the tighter auto-vectorized loop.
/// The one-pass scan fold behind `try_scan_multi_agg`, specialized by WHICH quantities the
/// projection actually asks for.
///
/// WHY FOUR LOOPS AND NOT ONE. The single branch-free loop computed `sum`, `cnt`, `min` and
/// `max` unconditionally, on the theory that four straight f64 ops are cheaper than deciding
/// which to do. They are — per row, once you are in the loop — but most projections want one
/// or two of them, and the rest is work nobody reads. At 1,000,000 nodes a pair of aggregates
/// cost 2.2 ms against 0.5 for a single `count` (item 470), and the dead quantities are what
/// the difference bought. Specializing is only sound because the choice is made ONCE, before
/// the scan: a per-row `if need_sum` would hand back more than it saved.
///
/// Each variant is `#[inline(never)]` for the reason items 453, 459 and 462 each measured:
/// an arm inlined into this chain perturbs the layout of the shapes that never enter it.
#[inline(never)]
fn scan_fold_cnt(
    store: &Store,
    label: &Option<String>,
    present: &[bool],
) -> (f64, u64, f64, f64, u64) {
    let (mut cnt, mut rows) = (0u64, 0u64);
    scan_visit(store, label, |i| {
        rows += 1;
        if present[i] {
            cnt += 1;
        }
    });
    (0.0, cnt, f64::INFINITY, f64::NEG_INFINITY, rows)
}

#[inline(never)]
fn scan_fold_sum(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
) -> (f64, u64, f64, f64, u64) {
    let (mut sum, mut cnt, mut rows) = (0.0f64, 0u64, 0u64);
    scan_visit(store, label, |i| {
        rows += 1;
        if present[i] {
            sum += data[i];
            cnt += 1;
        }
    });
    (sum, cnt, f64::INFINITY, f64::NEG_INFINITY, rows)
}

#[inline(never)]
fn scan_fold_minmax(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
) -> (f64, u64, f64, f64, u64) {
    let (mut cnt, mut mn, mut mx, mut rows) = (0u64, f64::INFINITY, f64::NEG_INFINITY, 0u64);
    scan_visit(store, label, |i| {
        rows += 1;
        if present[i] {
            let x = data[i];
            cnt += 1;
            if x < mn {
                mn = x;
            }
            if x > mx {
                mx = x;
            }
        }
    });
    (0.0, cnt, mn, mx, rows)
}

#[inline(never)]
fn scan_fold_all(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
) -> (f64, u64, f64, f64, u64) {
    let (mut sum, mut cnt, mut mn, mut mx, mut rows) =
        (0.0f64, 0u64, f64::INFINITY, f64::NEG_INFINITY, 0u64);
    scan_visit(store, label, |i| {
        rows += 1;
        if present[i] {
            let x = data[i];
            sum += x;
            cnt += 1;
            if x < mn {
                mn = x;
            }
            if x > mx {
                mx = x;
            }
        }
    });
    (sum, cnt, mn, mx, rows)
}

pub(super) fn try_scan_multi_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.is_empty() {
        return None;
    }
    let label = match input {
        Plan::Scan { label } => label,
        _ => return None,
    };
    // Per agg: its Num column slices (None for `count(*)`) and function.
    type AggSpec<'a> = (Option<(&'a [f64], &'a [bool])>, AggFn);
    let mut specs: Vec<AggSpec> = Vec::with_capacity(aggs.len());
    for agg in aggs {
        if agg.distinct {
            return None;
        }
        match (agg.func, agg.arg.as_ref()) {
            (AggFn::Count, None) => specs.push((None, AggFn::Count)), // count(*)
            (
                AggFn::Sum | AggFn::Avg | AggFn::Count | AggFn::Min | AggFn::Max,
                Some(Expr::Prop { slot: 0, key }),
            ) => {
                let Some(Column::Num { data, present, .. }) = store.column(key) else {
                    return None;
                };
                specs.push((Some((data.as_slice(), present.as_slice())), agg.func));
            }
            _ => return None,
        }
    }
    // ONE PASS PER DISTINCT COLUMN, each a straight f64 loop specialized to the quantities
    // that column's aggregates actually read (stored Nums are finite, so `x < mn` ==
    // `cmp_num_total`). The alternative below — one interleaved pass with a per-element
    // per-spec `match` — reads every column's value for every row and decides what to do with
    // it there: measured 5.6 ms against 0.6 for `sum(age), max(w2)` at 1,000,000 nodes
    // (item 471). N passes over one column each beat one pass over N, because each pass is a
    // sequential walk of a single slice and the work inside it is known before it starts.
    //
    // This subsumes the same-column case (one distinct column, one pass), so there is ONE
    // code path here rather than a special case beside a general one.
    let mut groups: Vec<(*const f64, bool, bool)> = Vec::with_capacity(specs.len());
    for (col, func) in &specs {
        let Some((data, _)) = col else { continue };
        let want_sum = matches!(func, AggFn::Sum | AggFn::Avg);
        let want_minmax = matches!(func, AggFn::Min | AggFn::Max);
        if let Some(g) = groups.iter_mut().find(|(p, _, _)| *p == data.as_ptr()) {
            g.1 |= want_sum;
            g.2 |= want_minmax;
        } else {
            groups.push((data.as_ptr(), want_sum, want_minmax));
        }
    }
    if !groups.is_empty() {
        // Per distinct column: (sum, cnt, mn, mx). `rows` is the same for every pass — it is
        // the scan, not the column — so the last one answers `count(*)`.
        let mut rows = 0u64;
        let folded: Vec<(f64, u64, f64, f64)> = groups
            .iter()
            .map(|&(ptr, want_sum, want_minmax)| {
                let (data, present) = specs
                    .iter()
                    .find_map(|(c, _)| c.filter(|(d, _)| d.as_ptr() == ptr))
                    .expect("group came from a spec");
                let (sum, cnt, mn, mx, r) = match (want_sum, want_minmax) {
                    (false, false) => scan_fold_cnt(store, label, present),
                    (true, false) => scan_fold_sum(store, label, data, present),
                    (false, true) => scan_fold_minmax(store, label, data, present),
                    (true, true) => scan_fold_all(store, label, data, present),
                };
                rows = r;
                (sum, cnt, mn, mx)
            })
            .collect();
        let cols: Vec<Col> = specs
            .iter()
            .map(|&(col, func)| {
                let Some((data, _)) = col else {
                    return Col::Gen(vec![Value::Num(rows as f64)]); // count(*)
                };
                let i = groups
                    .iter()
                    .position(|(p, _, _)| *p == data.as_ptr())
                    .expect("spec has a group");
                let (sum, cnt, mn, mx) = folded[i];
                let v = match func {
                    AggFn::Count => Value::Num(cnt as f64),
                    AggFn::Sum => Value::Num(sum),
                    AggFn::Avg if cnt == 0 => Value::Null,
                    AggFn::Avg => Value::Num(sum / cnt as f64),
                    AggFn::Min if cnt == 0 => Value::Null,
                    AggFn::Min => Value::Num(mn),
                    AggFn::Max if cnt == 0 => Value::Null,
                    _ => Value::Num(mx),
                };
                Col::Gen(vec![v])
            })
            .collect();
        return Some(Batch::of(cols));
    }
    // (total, count, best) per agg; `rows` counts scanned nodes for count(*).
    let mut acc: Vec<(f64, u64, Option<f64>)> = vec![(0.0, 0, None); specs.len()];
    let mut rows = 0u64;
    let mut visit = |i: usize| {
        rows += 1;
        for (k, (col, func)) in specs.iter().enumerate() {
            let Some((data, present)) = col else { continue };
            if !present[i] {
                continue;
            }
            let x = data[i];
            let a = &mut acc[k];
            a.0 += x;
            a.1 += 1;
            a.2 = Some(match a.2 {
                None => x,
                Some(b) => match func {
                    AggFn::Min if value::cmp_num_total(x, b).is_lt() => x,
                    AggFn::Max if value::cmp_num_total(x, b).is_gt() => x,
                    _ => b,
                },
            });
        }
    };
    let all_live = store.live_node_count() == store.node_count();
    let whole = all_live
        && match label {
            None => true,
            Some(l) => store.nodes_with_label(l).len() == store.node_count(),
        };
    if whole {
        (0..store.node_count()).for_each(&mut visit);
    } else {
        match label {
            Some(l) => store
                .nodes_with_label(l)
                .iter()
                .for_each(|&id| visit(id as usize)),
            None => (0..store.node_count()).for_each(|i| {
                if store.is_alive(i as u32) {
                    visit(i);
                }
            }),
        }
    }
    // One output COLUMN per aggregate, each a single row (a scalar aggregate emits
    // exactly one row).
    let cols: Vec<Col> = specs
        .iter()
        .zip(&acc)
        .map(|(&(col, func), &(total, cnt, best))| {
            let v = match func {
                AggFn::Count if col.is_none() => Value::Num(rows as f64), // count(*)
                AggFn::Count => Value::Num(cnt as f64),                   // count(arg)
                AggFn::Sum => Value::Num(total),                          // 0.0 over empty (K0a)
                AggFn::Avg => {
                    if cnt == 0 {
                        Value::Null
                    } else {
                        Value::Num(total / cnt as f64)
                    }
                }
                _ => best.map_or(Value::Null, Value::Num), // min/max of nothing → NULL
            };
            Col::Gen(vec![v])
        })
        .collect();
    Some(Batch::of(cols))
}

/// Peel `n` frontier hops off a chain plan, WITH A PER-HOP DIRECTION: each hop reports its edge
/// labels and whether it reads the OUT index or the IN one.
///
/// It replaces an out-only `peel_out_hops`, which this generalizes and which had no other caller.
///
/// The comment on [`try_nhop_sweep_count`]'s own peel said this generalization was unavailable —
/// "the 3-hop product's identity really does want one orientation, since its `level1`/`outdeg3`
/// arrays are both built from `store.out`" — and that was an observation about the CODE mistaken
/// for one about the identity. (That sentence is corrected there too.) The product is
///
/// ```text
///   total = SUM over hop-2 edges (b - c) of   level1[b] x deg3(c)
/// ```
///
/// and each of the three terms reads a DIFFERENT hop's adjacency: `level1` hop 1's, the middle
/// loop hop 2's, `deg3` hop 3's. Nothing ties them to each other, so each may independently be
/// `out` or `inc` — which is what this peel reports and what item 432 measured (the all-`in`
/// spelling of one question cost 15.4 ms against the forward spelling's 3.3, because the reversed
/// chain declined the product entirely and fell to the enumerate-and-tally path).
/// One peeled hop with its direction: the edge labels it accepts, and `true` when it reads the
/// OUT index. A named type because the tuple is otherwise complex enough for clippy to object,
/// which it is right about — `(Vec<(Vec<String>, bool)>, Option<String>)` says nothing.
type DirHop = (Vec<String>, bool);

fn peel_dir_hops(plan: &Plan, n: usize) -> Option<(Vec<DirHop>, Option<String>)> {
    if n == 0 {
        return match plan {
            Plan::Scan { label } => Some((Vec::new(), label.clone())),
            _ => None,
        };
    }
    let Plan::Expand {
        input,
        from,
        dir,
        edge_label,
        bind_edge: false,
        double_loops: false,
    } = plan
    else {
        return None;
    };
    // `Dir::Both` is an undirected hop: one edge can be walked two ways, so it is not a chain of
    // fixed steps and the product's identity does not apply to it.
    let out = match dir {
        Dir::Out => true,
        Dir::In => false,
        _ => return None,
    };
    if *from + 1 != chain_width(input)? {
        return None; // must expand the current frontier
    }
    let (mut hops, base) = peel_dir_hops(input, n - 1)?;
    hops.push((edge_label.clone(), out));
    Some((hops, base))
}

/// One peeled hop: the edge labels it accepts and whether it reads the OUT index.
struct GateHop {
    types: Vec<String>,
    out: bool,
}

/// A directed chain of frontier hops over one scan, FIRST hop first, with a per-POSITION gate.
struct GatedChain {
    hops: Vec<GateHop>,
    base_label: Option<String>,
    /// Indexed by SLOT: 0 is the base, `i` is the node hop `i` lands on. `None` = ungated.
    gates: Vec<Option<Vec<NbrPred>>>,
}

/// Flatten a filter into `(slot, per-node test)` leaves. Every leaf carries the SLOT it names,
/// because a filter's place in the plan is not where its position is: an inline `{k: 1}` is pushed
/// down to the level that binds the node, a clause `WHERE n3.k = 1` is left at the top of the
/// chain, and both mean the same thing. The sweep applies each leaf at the pass that LANDS on its
/// slot, which is the pushdown the two spellings need in order to cost the same (item 125's class
/// of bug, one family along).
///
/// Per-NODE, unlike [`simple_nbr_pred`]'s "any slot but the expand's source": each test is
/// evaluated against ONE vertex with nothing else bound. So `n3.m = n1.m` has no leaf form and
/// declines, while `n3.k = 1 AND n1.k = 0` splits into two gates. Returns false for anything that
/// has no leaf form, which declines the whole sweep rather than dropping a predicate.
fn gate_leaves(pred: &Expr, out: &mut Vec<(usize, NbrPred)>) -> bool {
    match pred {
        // A conjunction SPLITS: `WHERE n1.k = 0 AND n3.k = 1` is two gates at two positions, not
        // one correlation to decline. Each leaf carries the slot it names, so the split is free —
        // and it is the same pushdown that puts a single gate at its own position.
        Expr::And(a, b) => gate_leaves(a, out) && gate_leaves(b, out),
        Expr::Compare { op, left, right } => {
            let (s, key, v, flip) = match (left.as_ref(), right.as_ref()) {
                (Expr::Prop { slot, key }, Expr::Lit(v)) => (*slot, key, v, false),
                (Expr::Lit(v), Expr::Prop { slot, key }) => (*slot, key, v, true),
                _ => return false,
            };
            // A null literal is UNKNOWN against every value, never a definite TRUE. `Eq` against
            // it already admits nothing, but `Ne` would admit EVERYTHING, so this is load-bearing
            // and not belt-and-braces — it is declined for the same reason `simple_nbr_pred`
            // declines it.
            if v.is_null() {
                return false;
            }
            let op = if flip {
                match op {
                    CompareOp::Lt => CompareOp::Gt,
                    CompareOp::Le => CompareOp::Ge,
                    CompareOp::Gt => CompareOp::Lt,
                    CompareOp::Ge => CompareOp::Le,
                    other => *other,
                }
            } else {
                *op
            };
            out.push((s, NbrPred::Cmp(key.clone(), op, v.clone())));
            true
        }
        Expr::PropertyExists { slot, key } => {
            out.push((*slot, NbrPred::Exists(key.clone())));
            true
        }
        Expr::IsLabeled { slot, labels } => {
            out.push((*slot, NbrPred::Labeled(labels.clone())));
            true
        }
        _ => false,
    }
}

/// Peel a chain of frontier hops of EITHER direction (no bound edge) down to a bare Scan,
/// collecting per-hop direction and edge labels plus each position's inline GATE.
///
/// Separate from [`peel_out_hops`] rather than a generalization of it, because that one is the
/// 3-hop edge product's gate and the product's identity genuinely wants one orientation — its
/// `level1`/`outdeg3` arrays are built from `store.out` on both ends. The SWEEP has no such
/// requirement: each pass reads whichever index its own hop names.
///
/// A fully REVERSED chain does not need the direction half — the optimizer's `orient` rewrite
/// normalizes it to a forward one, measured at 0.05ms for 8 hops against 0.02 forward. What needs
/// it is the shape `orient` cannot normalize: ALTERNATING arrows, where there is no single
/// orientation to flip to.
///
/// The width check is STRUCTURAL here (`from` must equal the number of hops already peeled)
/// rather than a [`chain_width`] call, because `chain_width` sees through an `IsLabeled` filter
/// only — and a gated position is exactly a filter it does not see through. This also replaces
/// the old `chain_depth` pre-pass: the depth is `hops.len()` once the peel is done, and two
/// peelers that each had to agree about what a `Filter` means was the duplication to avoid.
fn peel_gated_chain(plan: &Plan) -> Option<GatedChain> {
    let mut hops = Vec::new();
    let mut found = Vec::new();
    let base_label = peel_chain_hops(plan, &mut hops, &mut found)?;
    // Place each leaf at the position its own slot names. `get_mut` is the bound check, and a
    // chain of `n` hops binds slots `0..=n`. Leaves landing on one position CONJOIN, whether they
    // came from one `AND`, from two stacked filters, or from an inline constraint plus a clause
    // `WHERE` on the same node — which is what all of those spellings mean.
    let mut gates: Vec<Option<Vec<NbrPred>>> = Vec::new();
    gates.resize_with(hops.len() + 1, || None);
    for (slot, leaf) in found {
        gates.get_mut(slot)?.get_or_insert_with(Vec::new).push(leaf);
    }
    Some(GatedChain {
        hops,
        base_label,
        gates,
    })
}

/// The structural half of the peel: appends hops FIRST-to-LAST to `hops`, every filter's
/// `(slot, leaf)` gates to `found`, and returns the base `Scan`'s label.
fn peel_chain_hops(
    plan: &Plan,
    hops: &mut Vec<GateHop>,
    found: &mut Vec<(usize, NbrPred)>,
) -> Option<Option<String>> {
    // Filters STACK, and sit at whichever level the optimizer pushed them to — which for a clause
    // `WHERE` is the top of the chain, not the hop that binds the node it names.
    let mut node = plan;
    while let Plan::Filter { input, pred } = node {
        gate_leaves(pred, found).then_some(())?;
        node = input;
    }
    match node {
        Plan::Scan { label } => Some(label.clone()),
        Plan::Expand {
            input,
            from,
            dir,
            edge_label,
            bind_edge: false,
            double_loops: false,
        } => {
            // `Dir::Any` is an undirected hop, which is neither index on its own and is refused.
            let out = match dir {
                Dir::Out => true,
                Dir::In => false,
                _ => return None,
            };
            let base = peel_chain_hops(input, hops, found)?;
            if *from != hops.len() {
                return None; // must expand the current frontier
            }
            hops.push(GateHop {
                types: edge_label.clone(),
                out,
            });
            Some(base)
        }
        _ => None,
    }
}

/// count(*) over a 3-hop OUT chain via the identity `1ᵀA₁A₂A₃1 = Σ` over the MIDDLE
/// edges (b→c, hop 2) of `(source→b walks over hop 1) × (out-degree of c over hop
/// 3)` — O(V+E), replacing the 2-hop count-propagation SCATTER (the 3-hop
/// bottleneck: random `next[nbr] += c` writes) with degree products. A fixed chain
/// is a WALK (edges may repeat), so there is NO trail correction — byte-identical
/// to the propagation. Per-hop edge types are handled independently.
pub(super) fn try_3hop_product_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None;
    }
    let (hops, base) = peel_dir_hops(input, 3)?;
    let mut wants: Vec<Vec<u32>> = Vec::with_capacity(3);
    for (l, _) in &hops {
        match want_etypes(store, l) {
            Ok(w) => wants.push(w),
            Err(()) => return Some(scalar_num(0.0)), // unknown edge type → no paths
        }
    }
    let (w1, w2, w3) = (&wants[0], &wants[1], &wants[2]);
    // Each hop reads its OWN adjacency index; see `peel_dir_hops` for why the three are
    // independent and the old out-only peel was not a requirement of the identity.
    let (d1, d2, d3) = (hops[0].1, hops[1].1, hops[2].1);
    let adj = |node: u32, out: bool| {
        if out {
            store.out(node)
        } else {
            store.inc(node)
        }
    };
    let nc = store.node_count();
    // Empty want = any type; else the edge must carry one of the hop's labels
    // (primary or, on a multi-label graph, secondary).
    let hit = |a: &crate::store::Adj, w: &[u32]| edge_carries_wanted(store, a, w);

    // level1[b] = number of hop-1 edges from a SOURCE into b (= counts after 1 hop).
    let mut level1 = vec![0u64; nc];
    let bump = |s: u32, level1: &mut [u64]| {
        for a in adj(s, d1) {
            if hit(a, w1) {
                level1[a.nbr as usize] += 1;
            }
        }
    };
    match &base {
        Some(l) => {
            for &s in store.nodes_with_label(l) {
                bump(s, &mut level1);
            }
        }
        None => {
            for s in 0..nc as u32 {
                if store.is_alive(s) {
                    bump(s, &mut level1);
                }
            }
        }
    }
    // outdeg3[c] = number of hop-3 edges of c, in hop 3's OWN direction.
    let mut outdeg3 = vec![0u64; nc];
    for (c, d) in outdeg3.iter_mut().enumerate() {
        *d = adj(c as u32, d3).iter().filter(|a| hit(a, w3)).count() as u64;
    }
    // Σ over hop-2 middle edges (b→c) of level1[b] × outdeg3[c].
    let mut total = 0u64;
    for (b, &lvl) in level1.iter().enumerate() {
        if lvl == 0 {
            continue;
        }
        for a in adj(b as u32, d2) {
            if hit(a, w2) {
                total += lvl * outdeg3[a.nbr as usize];
            }
        }
    }
    Some(scalar_num(total as f64))
}

/// `count(*)` over a DIRECTED chain of FOUR OR MORE hops, as a forward SWEEP of per-node way
/// counts.
///
/// `ways[v]` is how many ways the current position can be node `v`; one pass per hop advances it,
/// and the last hop is a weighted sum of out-DEGREES rather than a final pass, so it never writes
/// a way count. O(hops x E) in time and O(V) in memory, where enumerating the chain is
/// O(degree^hops) in both.
///
/// This is the generalization [`try_3hop_product_count`] stops one hop short of, and it is the
/// same identity: that arm's `level1[b]` IS a way-count vector, and its degree product is the
/// last two hops of this sweep written out by hand. Four hops and up was the gap — the chain fell
/// through every arm here to the enumerate-and-tally path, whose cost is the PATH COUNT.
/// Measured at 200 nodes of degree 5 (item 298), native against the pure-TS sweep:
///
/// | hops |         paths | native before | ts sweep |
/// | ---- | ------------: | ------------: | -------: |
/// |    7 |    15,625,000 |       3.35 ms |  0.68 ms |
/// |    9 |   390,625,000 |     103.11 ms |  0.38 ms |
/// |   11 | 9,765,625,000 |    2223.64 ms |  0.42 ms |
///
/// A fixed-length chain is a WALK — edges may repeat and so may nodes — so there is NO trail
/// correction, exactly as [`try_3hop_product_count`] notes, and the sweep is byte-identical to the
/// enumeration. Per-hop edge types are independent, and an unknown type on any hop means no paths.
///
/// A bound edge or an `Any` (undirected) hop fails the peel, which [`peel_gated_chain`] enforces
/// rather than assumes.
///
/// EACH HOP CARRIES ITS OWN DIRECTION (item 302), because the pass that advances the way counts
/// simply reads whichever index its hop names. The first version was OUT-only and recorded mixed
/// directions as open; measuring it first showed the obvious case did not need the work at all —
/// a fully REVERSED chain is normalized to a forward one by the optimizer's `orient` rewrite
/// (0.05ms at 8 hops against 0.02 forward). What did need it is the shape `orient` cannot
/// normalize, ALTERNATING arrows, where there is no single orientation to flip to:
///
/// | hops | out-only native | ts sweep |
/// | ---- | --------------: | -------: |
/// |    5 |         0.20 ms |  0.36 ms |
/// |    6 |         0.71 ms |  0.53 ms |
/// |    7 |         4.13 ms |  0.43 ms |
///
/// Native grew ~5x a hop there — the degree, i.e. an enumeration — while the pure-TS sweep, which
/// has carried per-hop directions since item 298, stayed flat and ended up 10x FASTER. This peel
/// is its own function because it also carries a per-POSITION gate — and NOT, as this comment
/// used to say, because "the 3-hop product's identity really does want one orientation, since its
/// `level1`/`outdeg3` arrays are both built from `store.out`". Item 432 corrected that: the two
/// arrays being built from `store.out` was a fact about the CODE, not about the identity. The
/// product's `level1`, its middle loop and its `deg3` each read a DIFFERENT hop's adjacency, so
/// each may independently be `out` or `inc`, and since 432 each does (see `peel_dir_hops`).
///
/// EVERY POSITION CAN CARRY AN INLINE CONSTRAINT (item 304), applied on the `0 -> w` TRANSITION so
/// a predicate costs once per DISTINCT vertex reached there rather than once per edge into it —
/// item 219's argument, two families along. Before it, one constrained node declined the whole
/// family: measured at 20,000 vertices of degree 3, a five-hop chain against the unconstrained one
/// as the control, native and the TS twin (item 303) side by side.
///
/// | gate at     | native before | vs free | native after | vs free |   won |
/// | ----------- | ------------: | ------: | -----------: | ------: | ----: |
/// | (none)      |       0.50 ms |       — |      0.50 ms |       — |     — |
/// | 0 (seed)    |      15.60 ms |   28.6x |      0.90 ms |    1.7x | 17.3x |
/// | 1           |      16.50 ms |   30.2x |      0.90 ms |    1.7x | 18.3x |
/// | 2           |      17.90 ms |   32.8x |      0.90 ms |    1.7x | 19.9x |
/// | 3           |      32.00 ms |   58.6x |      1.00 ms |    1.8x | 32.0x |
/// | 4 (last)    |      66.20 ms |  121.3x |      1.10 ms |    2.0x | 60.2x |
///
/// A gated LAST position gets a PASS OF ITS OWN: an ungated end is a weighted sum of DEGREES, and
/// a degree cannot say which of a vertex's edges land somewhere that passes — which is why the
/// degree products refuse an end constraint at all (items 219, 290). It won the most here, as it
/// did in TS.
///
/// The gate's POSITION comes from its predicate's SLOT, not from where the optimizer put the
/// `Filter` — which is what makes the spellings cost the same. An inline `{k: 1}` is pushed down
/// to the level that binds the node; a clause `WHERE n3.k = 1` is left at the top of the chain,
/// and before item 304 the second spelling declined while the first was accepted. Same class of
/// bug as item 125's 4x, found by instrumenting which shapes the arm actually reaches rather than
/// by reading the plan and assuming.
///
/// What still declines, each for its own reason: a DISJUNCTION (`k = 0 OR k = 1`, and the `IN`
/// list that lowers to it), a CORRELATION naming two slots, and `IS NULL`/`IS NOT NULL` — which
/// is NOT `has_prop` in an engine where null is a stored present value, so it is declined rather
/// than approximated.
pub(super) fn try_nhop_sweep_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None;
    }
    let mut chain = peel_gated_chain(input)?;
    let hops = chain.hops.len();
    // FOUR or more hops always, and TWO or THREE only when some position is GATED (item 306).
    //
    // The tuned degree-product arms own the ungated shallow chains and this must not steal them —
    // item 301 measured the sweep LOSING 1.50x to the three-segment product when there is nothing
    // to filter. But a product cannot carry a constraint on the position it ENDS at: it answers
    // that end as a weighted sum of DEGREES, and a degree cannot say which of a vertex's edges
    // land somewhere that passes (items 219, 290). So those shapes declined every arm and
    // enumerated, which is the cliff items 304/305 MOVED rather than closed:
    //
    // | hops | ungated |  gate at the LAST position |
    // | ---- | ------: | -------------------------: |
    // |    2 | 0.21 ms |      1.12 ms       (5.3x)  |
    // |    3 | 0.32 ms |      4.21 ms      (13.2x)  |
    // |    4 | 0.41 ms |      0.95 ms  (the sweep)  |
    //
    // Reached only because `or_else` has already offered the shape to every product arm, so a
    // gated chain here is one they all refused. The `gates` test is what keeps the ungated case
    // theirs even if a future arm order changes.
    //
    // A SPLIT VERDICT at two hops, which is why the rule is per-depth rather than a floor: a gate
    // on the last position wins 1.5x there, but a gate on the INTERIOR reads 0.51 -> 0.69ms,
    // **0.74x SLOWER** than the arm that already answers it, so two hops is taken only for the
    // END constraint that nothing else can carry. Three hops gains at both (4.21 -> 0.77 at the
    // end, 1.21 -> 0.73 at an interior). Same shape of answer as item 301's.
    let take = match hops {
        0 | 1 => false,
        2 => chain.gates[hops].is_some(),
        3 => chain.gates.iter().any(Option::is_some),
        _ => true,
    };
    if !take {
        return None;
    }
    // READ THE CHAIN BACKWARDS when its LAST position is gated and its first is not (item 309,
    // the native half of 308's). A gate on the last position costs twice — it needs a pass of its
    // own, and every pass before it runs over a frontier nothing has narrowed — where a gate on
    // the FIRST narrows the seed and the degree tail answers the end. Measured at 20,000 vertices
    // of degree 3, same chain, same gate: 0.80ms at the end against 0.29 at the start.
    //
    // A fixed-length chain read backwards is the SAME multiset of walks, so the count is
    // identical. Two things have to travel with it, and they are why this is not just a `reverse`:
    //
    //   - the old BASE LABEL was applied by seeding from its bucket, and after the flip its
    //     position is the one the walk ENDS at, where the degree tail never looks at a far
    //     endpoint. Carrying it there would cost a gate's extra pass, so the flip is only taken
    //     when there is nothing to carry (see the guard below) and the label is dropped;
    //   - a single-label test on the new seed position is PROMOTED to the base label, which turns
    //     the live-node scan back into a bucket seek. That keeps the two directions symmetric
    //     rather than trading one engine's seek for the other's.
    // GUARDED BY A MEASUREMENT, not by taste. An unguarded flip is a big REGRESSION when the base
    // label is selective, because the forward seed is then a small bucket and the reversed one a
    // full live-node scan. 200,000 vertices at five edges, a three-hop chain with an end gate,
    // min of 7, forward against flipped:
    //
    // | seed bucket        | forward  | flipped  |            |
    // | ------------------ | -------: | -------: | ---------- |
    // | 1% (2,000)         |  3.21 ms | 20.05 ms | 6.2x WORSE |
    // | 10% (20,000)       | 10.66 ms | 23.02 ms | 2.2x WORSE |
    // | 100% (200,000)     | 12.62 ms | 10.28 ms | 1.23x better |
    //
    // So the flip is taken only when there is no seek to lose: no base label at all, or a base
    // label every LIVE node carries, in which case the test cannot fail and is dropped — which
    // gives the flip the pass count back as well as the narrower seed.
    //
    // `len() == live_node_count()` is sound and TIGHT, and it rests on an invariant worth naming
    // rather than assuming: `delete_node` RETAINS the id out of its label buckets (see
    // `is_labeled`, which binary-searches the bucket and documents the order `retain` preserves).
    // So a bucket holds only live nodes, and `|bucket| == |live|` forces `bucket == live`.
    // `node_count()` would also be sound — bucket <= live <= slots — but strictly weaker: it
    // stops firing the moment anything is deleted. The invariant it depends on is pinned directly
    // by `a_deleted_node_leaves_its_label_bucket`, because if that ever stopped holding this would
    // drop a test that is not vacuous and the answer would be a silent SUPERSET.
    let universal = chain
        .base_label
        .as_deref()
        .is_some_and(|l| store.nodes_with_label(l).len() == store.live_node_count());
    let flip = chain.gates[hops].is_some()
        && chain.gates[0].is_none()
        && (chain.base_label.is_none() || universal);
    if flip {
        chain.hops.reverse();
        for h in &mut chain.hops {
            h.out = !h.out;
        }
        chain.gates.reverse();

        // The old base label is simply DROPPED. There is deliberately no "demote it to a gate at
        // the far end" branch: the guard above only flips when there is nothing to carry — either
        // there was no label, or every slot has it and the test cannot fail. Mutation is how that
        // is known rather than argued: two mutants editing the demotion branch SURVIVED, because
        // the branch could not run, and dead code behind a condition is worse than no code.
        chain.base_label = None;

        if let Some(g) = chain.gates[0].as_mut() {
            if let Some(at) = g
                .iter()
                .position(|p| matches!(p, NbrPred::Labeled(ls) if ls.len() == 1))
            {
                if let NbrPred::Labeled(ls) = g.remove(at) {
                    chain.base_label = Some(ls[0].clone());
                }

                if g.is_empty() {
                    chain.gates[0] = None;
                }
            }
        }
    }

    // Resolved wanted edge-type ids per hop, first to last — parallel to `chain.hops`.
    let mut wants: Vec<Vec<u32>> = Vec::with_capacity(hops);
    for h in &chain.hops {
        match want_etypes(store, &h.types) {
            Ok(w) => wants.push(w),
            Err(()) => return Some(scalar_num(0.0)), // unknown edge type → no paths
        }
    }
    let nc = store.node_count();
    let hit = |a: &crate::store::Adj, w: &[u32]| edge_carries_wanted(store, a, w);
    let gate_ok = |v: u32, g: &[NbrPred]| g.iter().all(|p| nbr_pred_ok(store, v, p));

    let mut ways = vec![0u64; nc];
    let seed = chain.gates[0].as_deref();
    match &chain.base_label {
        Some(l) => {
            for &s in store.nodes_with_label(l) {
                if seed.is_none_or(|g| gate_ok(s, g)) {
                    ways[s as usize] = 1;
                }
            }
        }
        None => {
            for (s, w) in ways.iter_mut().enumerate() {
                if store.is_alive(s as u32) && seed.is_none_or(|g| gate_ok(s as u32, g)) {
                    *w = 1;
                }
            }
        }
    }

    // A gated LAST position gets a PASS OF ITS OWN. An ungated end is a weighted sum of DEGREES,
    // and a degree cannot say which of a vertex's edges land somewhere that passes — which is why
    // the degree products refuse an end constraint at all (items 219, 290). One more pass makes
    // the gate once-per-vertex like every other position and the answer is then the sum of the
    // surviving way counts. Same shape the TS sweep reached (item 303), and the biggest win here
    // too.
    let last_gated = chain.gates[hops].is_some();
    let passes = if last_gated { hops } else { hops - 1 };

    // One pass per hop (but the last, unless it is gated) over TWO reused buffers — a fresh
    // `vec![0; nc]` per hop is the one cost here that would grow with the depth.
    // REJECTED, with its numbers: specializing each pass by direction into two monomorphic loops
    // (a `macro_rules!` expanded once per arm, so the adjacency call is resolved at compile time)
    // was tried to recover the ~5% item 302 costs the forward chain, and it made things slightly
    // WORSE — 0.93x/0.92x against the simple branch below, on the 4-hop and 6-hop bench rows.
    //
    // It was tried because the branch looked like the obvious suspect. It is NOT: a variant
    // keeping every structural change here but reading `store.out` unconditionally — no direction
    // logic at all — still read 0.95x/0.95x. So the ~5% is the TOLL for editing this module, not
    // the feature, which is `pull-alignment-is-load-bearing` one module along. Accepted: a 5%
    // constant on forward chains against removing an O(degree^hops) cliff on mixed ones.
    let mut next = vec![0u64; nc];
    for (i, (want, hop)) in wants.iter().zip(&chain.hops).enumerate().take(passes) {
        // Hop `i` lands on slot `i + 1`.
        let gate = chain.gates[i + 1].as_deref();
        next.fill(0);
        for (v, &w) in ways.iter().enumerate() {
            if w == 0 {
                continue;
            }
            // `Adj::nbr` is the FAR end of the edge in whichever list it was read from, so one
            // loop serves both directions once the index is chosen.
            let adj = if hop.out {
                store.out(v as u32)
            } else {
                store.inc(v as u32)
            };
            match gate {
                // The ungated loop is kept EXACTLY as it was, not folded into the gated one
                // behind an `Option` test per edge: this module charges ~5% for a structural
                // edit (item 302) and the ungated forward chain is the commonest shape.
                None => {
                    for a in adj {
                        if hit(a, want) {
                            next[a.nbr as usize] += w;
                        }
                    }
                }
                // The gate runs on the `0 -> w` TRANSITION, so a predicate costs once per
                // DISTINCT vertex reached at this position rather than once per edge into it. A
                // rejected vertex keeps a 0 weight and is simply re-tested by the next edge that
                // finds it — the MEMO for that was written and REJECTED on its own numbers in the
                // TS twin (item 303: two mutants on it survived, and its sign flipped between
                // fixtures), so it is not re-attempted here.
                Some(g) => {
                    for a in adj {
                        if !hit(a, want) {
                            continue;
                        }
                        let j = a.nbr as usize;
                        if next[j] == 0 && !gate_ok(a.nbr, g) {
                            continue;
                        }
                        next[j] += w;
                    }
                }
            }
        }
        std::mem::swap(&mut ways, &mut next);
    }

    if last_gated {
        // The extra pass already landed on the last position and applied its gate, so every
        // surviving way count IS a path.
        return Some(scalar_num(ways.iter().sum::<u64>() as f64));
    }

    let (last, last_out) = (&wants[hops - 1], chain.hops[hops - 1].out);
    let mut total = 0u64;
    for (v, &w) in ways.iter().enumerate() {
        if w == 0 {
            continue;
        }
        let adj = if last_out {
            store.out(v as u32)
        } else {
            store.inc(v as u32)
        };
        total += w * adj.iter().filter(|a| hit(a, last)).count() as u64;
    }
    Some(scalar_num(total as f64))
}

// REJECTED (2026-09-17, E68/E69): folding a filter on the hop's ENDPOINT into the
// degree sum, so `count(*)` keeps its shortcut instead of enumerating paths.
//
// The premise looked airtight. `count(*)` over a bare `Expand` sums degrees and never
// walks an edge; ANY filter above it stops that, and the residual-`IsLabeled` shape
// measured 32us against 474us. Folding the predicate into the adjacency walk —
// `simple_nbr_preds` + `nbr_pred_ok` per neighbour, no row materialized — should have
// recovered most of the gap.
//
// It is SLOWER, every shape, and the reason generalizes: the filter it replaces is
// evaluated COLUMNARLY over a batch (one gather, one vectorized compare), and a
// per-neighbour scalar test cannot beat that, even with no row built. Measured at 200k
// nodes x 8 edges with a range index, folded against the existing paths:
//
//   endpoint compare  a.age > 50        112.5us  ->  344.8us    3.1x WORSE
//   endpoint exists   a.name            211.9us  ->  207.4us    noise
//   endpoint conjunction                532.7us  ->  724.1us    1.4x WORSE
//
// And for a bare `IsLabeled` endpoint filter — the shape that started this —
// `try_frontier_count` above already propagates a per-node count array and beats the
// fold 474us to 560us, so there was nothing to win there either.
//
// The deeper reason nothing here could have worked (E71): the "fast" baseline this was
// chasing sums adjacency LENGTHS. It is O(sources) and never looks at an edge — flat at
// ~33us while the degree goes 2 -> 16 and the edge count goes 4k -> 32k. Any predicate
// on the endpoint must visit every edge to know which endpoints to test, and that cost
// scales with edges (196us -> 712us over the same sweep, ~21-40 ns/edge). They are not
// the same question, so the gap between them is not a penalty to optimize away. Do not
// re-open this without a way to answer an endpoint predicate WITHOUT visiting edges.
//
// Two things worth keeping from the attempt. `bind_edge: false` is essential to any
// future version: a bound edge makes the hop append TWO slots, so the endpoint slot is
// the EDGE, and `simple_nbr_pred` will cheerfully test node properties against an edge
// id (four gql_corpus cases caught it). And the honest control for "the shortcut was
// defeated" is the same plan shape with and without the filter — NOT a bare Expand,
// whose degree sum never walks an edge at all.

pub(super) fn try_fused_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count {
        return None;
    }
    // An UNWIND is a row MULTIPLIER, so `count(*)` over one is Σ the list lengths — the input
    // rows evaluated once each, and not one row per element. ISO's rule is the arithmetic and
    // `unwind_batch` is where it lives: a LIST contributes its length, NULL contributes 0, and
    // any other scalar contributes 1 as a one-element singleton.
    //
    // Measured at 200,000 vertices with three list elements each:
    // `MATCH (n:Person) FOR t IN n.tags RETURN count(*)` built 600,000 rows to count them at
    // 15.8ms, where the TS engine answers the same question in 2.3 after item 518 (item 519).
    //
    // `count(*)` only, and any error DECLINES rather than being swallowed: the general path
    // then re-runs the same evaluation and raises it, so a faulting list still faults.
    if let Plan::Unwind { input, list, .. } = input {
        if agg.arg.is_some() || agg.distinct {
            return None;
        }

        let rows = pull(input, store, false).ok()?;
        let n = rows.rows();
        let len_of = |v: Value| match v {
            Value::List(items) => items.len() as f64,
            Value::Null => 0.0,
            _ => 1.0,
        };

        // A ROW-INVARIANT list is evaluated ONCE and multiplied, exactly as `unwind_rows` does
        // for the same reason. Evaluating it per row instead was MEASURED WORSE than the path
        // this arm replaced — `FOR x IN [1, 2, 3]` went 3.4ms to 11.6, because building 200,000
        // identical `Value::List`s costs more than the rows it saves. The fast path has to
        // mirror the operator's own invariance check, not just its element rule.
        let mut slots = Vec::new();

        if n > 0 && slots_read(list, &mut slots) && slots.is_empty() {
            let once = eval(list, store, &rows.gather(&[0])).ok()?;

            return Some(scalar_num(len_of(once.value_at(0)) * n as f64));
        }

        let lists = eval(list, store, &rows).ok()?;
        let mut total = 0f64;

        for i in 0..n {
            total += len_of(lists.value_at(i));
        }

        return Some(scalar_num(total));
    }

    // An OPTIONAL hop is the same degree sum with a FLOOR: a source with no matching
    // neighbour still yields one row (null-filled for GQL `OPTIONAL MATCH`, the source itself
    // for Gremlin `optional()` — one row either way), so `count(*)` is Σ max(degree, 1).
    // Without this arm the optional spelling enumerated every row: 4.5ms against 0.5 for the
    // identical non-optional count at 200,000 vertices / 1,000,000 edges (item 508).
    //
    // A LANDING PREDICATE declines. It decides both which neighbours count AND whether the
    // source null-fills, and a degree cannot say which of a vertex's edges land somewhere that
    // passes — items 219 and 290's rule, here with the null-fill riding on the same question.
    let (inner, from, dir, edge_label, dl, optional) = match input {
        Plan::Expand {
            input,
            from,
            dir,
            edge_label,
            double_loops,
            ..
        // Gremlin `both()` walks a self-loop twice — the final-hop degree counts it twice.
        } => (input, from, dir, edge_label, *double_loops, false),
        Plan::OptionalExpand {
            input,
            from,
            dir,
            edge_label,
            landing_pred: None,
            ..
        } => (input, from, dir, edge_label, false, true),
        _ => return None,
    };
    let w = chain_width(inner)?; // slot count feeding the final hop
    if *from + 1 != w {
        return None; // the final Expand must expand the current frontier
    }
    let want = match want_etypes(store, edge_label) {
        Ok(w) => w,
        Err(()) => {
            // An unknown edge type matches nothing. For a plain hop that is zero rows — but an
            // OPTIONAL hop still yields one row per source, so the answer is the SOURCE COUNT,
            // not zero. Caught by this item's own test before it shipped: the arm inherited the
            // plain hop's early return and answered 0 where 3 is right.
            if !optional {
                return Some(scalar_num(0.0));
            }

            // Only `count(*)` has that answer; `count(x)` and `count(DISTINCT x)` count
            // VALUES, and a null-filled row has none.
            if agg.arg.is_some() || agg.distinct {
                return None;
            }

            return Some(scalar_num(frontier_ids(inner, store)?.len() as f64));
        }
    };
    let src = frontier_ids(inner, store)?; // ids feeding the final hop, w/ multiplicity

    if agg.arg.is_none() {
        // DEEP chain (≥2 hops feed the final hop, so the intermediate frontier would
        // explode with path multiplicity): propagate a per-node count array instead
        // of materializing the frontier ids — O(hops * edges) time, O(node_count)
        // space. The count is Σ_v counts[v] * matching-out-degree(v).
        if count_hops(inner) >= 2 {
            if let Some(counts) = frontier_counts(inner, store) {
                // The final hop's degree comes from `matching_degree`, which reads it off a
                // contiguous slice when it can (a trivial type filter, or a single wanted
                // type on a graph without multi-label edges) rather than walking the
                // adjacency to count it. The shallow branch below has done this for a while;
                // this one kept walking.
                let all_types = want_covers_all_etypes(store, &want);
                let mut total = 0f64;
                counts.for_each(|v, c| {
                    let d = matching_degree(store, v, *dir, &want, dl, all_types);

                    total += c * if optional { d.max(1.0) } else { d };
                });
                return Some(scalar_num(total));
            }
        }
        // count(*): number of final-hop paths = sum over sources of matching
        // out-degree. When the sources come from an Expand they repeat (many paths
        // reach the same node), and a node's degree is the same each time — so
        // collapse to distinct nodes with multiplicity and walk each adjacency
        // once, scaled. When they come from a Scan they are already distinct, so
        // that dedup is pure overhead: sum degrees directly.
        //
        // When the hop's type set matches EVERY edge (an unlabeled hop, or the
        // graph's only type), the degree is the raw adjacency length — no per-edge
        // type check. That is the common "count all my out-neighbours" shape; the
        // per-edge walk it replaces was the one 1-hop-count regression vs the TS engine.
        let all_types = want_covers_all_etypes(store, &want);
        let mut total = 0f64;
        let degree_of = |v: u32| {
            let d = matching_degree(store, v, *dir, &want, dl, all_types);

            if optional {
                d.max(1.0)
            } else {
                d
            }
        };

        if matches!(inner.as_ref(), Plan::Expand { .. }) {
            let (distinct, mult) = distinct_with_mult(&src, store.node_count());
            for (i, &v) in distinct.iter().enumerate() {
                total += mult[i] * degree_of(v);
            }
        } else {
            for &v in &src {
                total += degree_of(v);
            }
        }
        return Some(scalar_num(total));
    }
    if optional {
        // Only `count(*)` is answered for an optional hop. `count(DISTINCT c)` counts
        // ENDPOINTS, and a null-filled row has none — a different question from Σ max(deg, 1).
        //
        // CONSERVATIVE, not load-bearing: its mutant survives, because the distinct arm's own
        // answer happens to coincide (it counts distinct neighbours, and the null-filled rows
        // it would skip contribute no endpoint either way — `count(DISTINCT x)` over this
        // fixture is 2 both ways). The guard stays because that arm was not written for a
        // left-outer hop and nothing measures it there; admitting it is a separate change with
        // its own number.
        return None;
    }
    if agg.distinct {
        // count(DISTINCT c) where c is the final (last) slot, index == w: distinct
        // endpoints deduped in a bitset — no per-row hashing, no boxed values.
        match agg.arg.as_ref() {
            Some(Expr::Slot(s)) if *s == w => {}
            _ => return None,
        }
        // The distinct endpoints depend only on the SET of last-hop sources, not
        // their multiplicity: a source reached by many paths yields the same
        // neighbours each time. When the sources come from an Expand they repeat,
        // so collapse them to distinct nodes first — a 2-hop's millions of repeated
        // intermediates down to the distinct nodes, each final hop walked once.
        // Sources from a Scan are already distinct, so skip that pass.
        let nc = store.node_count();
        let deduped;
        let sources: &[u32] = if matches!(inner.as_ref(), Plan::Expand { .. }) {
            let mut seen_src = vec![false; nc];
            let mut distinct_src = Vec::new();
            for &v in &src {
                if !seen_src[v as usize] {
                    seen_src[v as usize] = true;
                    distinct_src.push(v);
                }
            }
            deduped = distinct_src;
            &deduped
        } else {
            &src
        };
        let mut seen = vec![false; nc];
        let mut cnt = 0f64;
        for &v in sources {
            for_each_nbr(store, v, *dir, &want, false, |nbr, _| {
                if !seen[nbr as usize] {
                    seen[nbr as usize] = true;
                    cnt += 1.0;
                }
            });
        }
        return Some(scalar_num(cnt));
    }
    None // count(arg) non-distinct on the final slot: not fused (uncommon)
}

/// A one-row, one-column batch holding a single number — a scalar aggregate's
/// result.
pub(super) fn scalar_num(x: f64) -> Batch {
    Batch::of(vec![Col::Gen(vec![Value::Num(x)])])
}

/// A Gremlin `tree()` accumulator: a nested, INSERTION-ORDERED map (children keyed by
/// value, matched via `value::equals`), materialized into nested `Value::Map`s.
#[derive(Default)]
pub(super) struct GremlinTree {
    // Children in FIRST-SEEN order (the Gremlin tree contract) …
    order: Vec<(Value, GremlinTree)>,
    // … plus a grouping-key → index map so a level with many children is an O(1) hash
    // lookup, not a linear scan comparing full element-map keys (which made a wide
    // tree O(paths · children · map-size) — the dominant `tree()` cost).
    index: FnvMap<Vec<u8>, usize>,
}

impl GremlinTree {
    pub(super) fn insert(&mut self, keys: &[Value]) {
        let Some((first, rest)) = keys.split_first() else {
            return;
        };
        let mut kb = Vec::new();
        crate::value::group_key_into(first, &mut kb);
        let i = match self.index.get(&kb) {
            Some(&i) => i,
            None => {
                let idx = self.order.len();
                self.order.push((first.clone(), GremlinTree::default()));
                self.index.insert(kb, idx);
                idx
            }
        };
        self.order[i].1.insert(rest);
    }

    pub(super) fn to_value(&self) -> Value {
        Value::Map(std::sync::Arc::new(
            self.order
                .iter()
                .map(|(k, c)| (k.clone(), c.to_value()))
                .collect(),
        ))
    }
}

/// A component/cluster id as the ROOT vertex's external-id string — the value the TS engine's
/// `connectedComponent`/`peerPressure` write (`Value::Str(vid.arc(root))`). A root
/// with no external id (never, for a loaded node) reads back NULL.
pub(super) fn root_ext_id(store: &Store, root: u32) -> Value {
    store.node_ext_id(root).map_or(Value::Null, Value::Str)
}

/// Collapse a node-id multiset to (distinct ids in first-seen order, their
/// multiplicities) via a direct-mapped array — node ids are dense, so no hashing.
pub(super) fn distinct_with_mult(nodes: &[u32], node_count_total: usize) -> (Vec<u32>, Vec<f64>) {
    let mut group_of = vec![u32::MAX; node_count_total];
    let mut distinct: Vec<u32> = Vec::new();
    let mut mult: Vec<f64> = Vec::new();
    for &id in nodes {
        let slot = &mut group_of[id as usize];
        if *slot == u32::MAX {
            *slot = u32::try_from(distinct.len()).expect("distinct count fits in u32");
            distinct.push(id);
            mult.push(1.0);
        } else {
            mult[*slot as usize] += 1.0;
        }
    }
    (distinct, mult)
}

/// Does `expr` reference no slot other than `s` (and never the path)? Literals
/// and comparisons over slot `s` qualify; any other slot, or `Expr::Path`,
/// disqualifies — the signal that the frontier alone is enough to evaluate it.
pub(crate) fn refs_only_slot(expr: &Expr, s: usize) -> bool {
    match expr {
        Expr::Lit(_) | Expr::Param(_) => true,
        Expr::Slot(n) => *n == s,
        Expr::Prop { slot, .. } => *slot == s,
        Expr::Path
        | Expr::PathAccess { .. }
        | Expr::GremlinPath { .. }
        | Expr::GremlinFullPath { .. } => false,
        Expr::Not(x) => refs_only_slot(x, s),
        Expr::And(a, b)
        | Expr::Or(a, b)
        | Expr::Xor(a, b)
        | Expr::Arith {
            left: a, right: b, ..
        }
        | Expr::In {
            needle: a,
            haystack: b,
        } => refs_only_slot(a, s) && refs_only_slot(b, s),
        Expr::Call { args, .. } | Expr::GraphPred { args, .. } | Expr::List { items: args } => {
            args.iter().all(|a| refs_only_slot(a, s))
        }
        Expr::Record { fields }
        | Expr::MapLit {
            entries: fields, ..
        } => fields.iter().all(|(_, e)| refs_only_slot(e, s)),
        Expr::Field { base, .. } => refs_only_slot(base, s),
        Expr::Index { base, index, .. } => refs_only_slot(base, s) && refs_only_slot(index, s),
        Expr::Case {
            branches,
            otherwise,
        } => {
            branches
                .iter()
                .all(|(c, v)| refs_only_slot(c, s) && refs_only_slot(v, s))
                && otherwise.as_deref().is_none_or(|e| refs_only_slot(e, s))
        }
        Expr::Compare { left, right, .. } => refs_only_slot(left, s) && refs_only_slot(right, s),
        Expr::Cast { expr, .. } | Expr::IsNull { expr, .. } => refs_only_slot(expr, s),
        Expr::PropertyExists { slot, .. } | Expr::IsLabeled { slot, .. } => *slot == s,
        // An EXISTS correlates on outer slots below `outer_width`; conservatively
        // treat it as touching more than one, so it never rides the frontier-only
        // aggregate fast path.
        Expr::Exists { .. }
        | Expr::CountSubquery { .. }
        | Expr::ScalarSubquery { .. }
        | Expr::CollectSubquery { .. }
        | Expr::AggSubquery { .. }
        | Expr::UncorrelatedExists { .. }
        | Expr::UncorrelatedCount { .. }
        | Expr::UncorrelatedScalar { .. } => false,
    }
}

/// Rewrite every reference to slot `from` in `expr` to slot `to`. Used to retarget
/// frontier-only expressions onto a one-slot frontier batch. Callers guarantee
/// (via [`refs_only_slot`]) that no other slot appears.
pub(crate) fn remap_slot(expr: &Expr, from: usize, to: usize) -> Expr {
    let go = |e| Box::new(remap_slot(e, from, to));
    match expr {
        Expr::Slot(n) if *n == from => Expr::Slot(to),
        Expr::Prop { slot, key } if *slot == from => Expr::Prop {
            slot: to,
            key: key.clone(),
        },
        Expr::Slot(_)
        | Expr::Prop { .. }
        | Expr::Lit(_)
        | Expr::Path
        | Expr::PathAccess { .. }
        | Expr::GremlinPath { .. }
        | Expr::GremlinFullPath { .. } => expr.clone(),
        Expr::Not(x) => Expr::Not(go(x)),
        Expr::And(a, b) => Expr::And(go(a), go(b)),
        Expr::Or(a, b) => Expr::Or(go(a), go(b)),
        Expr::Xor(a, b) => Expr::Xor(go(a), go(b)),
        Expr::In { needle, haystack } => Expr::In {
            needle: go(needle),
            haystack: go(haystack),
        },
        Expr::Compare { op, left, right } => Expr::Compare {
            op: *op,
            left: go(left),
            right: go(right),
        },
        Expr::Arith { op, left, right } => Expr::Arith {
            op: *op,
            left: go(left),
            right: go(right),
        },
        Expr::Call { name, args } => Expr::Call {
            name: name.clone(),
            args: args.iter().map(|a| remap_slot(a, from, to)).collect(),
        },
        Expr::GraphPred { op, args, negated } => Expr::GraphPred {
            op: *op,
            args: args.iter().map(|a| remap_slot(a, from, to)).collect(),
            negated: *negated,
        },
        Expr::List { items } => Expr::List {
            items: items.iter().map(|a| remap_slot(a, from, to)).collect(),
        },
        Expr::Record { fields } => Expr::Record {
            fields: fields
                .iter()
                .map(|(k, e)| (k.clone(), remap_slot(e, from, to)))
                .collect(),
        },
        Expr::MapLit {
            entries,
            omit_absent,
        } => Expr::MapLit {
            entries: entries
                .iter()
                .map(|(k, e)| (k.clone(), remap_slot(e, from, to)))
                .collect(),
            omit_absent: *omit_absent,
        },
        Expr::Index { base, index, elem } => Expr::Index {
            base: go(base),
            index: go(index),
            elem: *elem,
        },
        Expr::Field { base, key } => Expr::Field {
            base: go(base),
            key: key.clone(),
        },
        Expr::Case {
            branches,
            otherwise,
        } => Expr::Case {
            branches: branches
                .iter()
                .map(|(c, v)| (remap_slot(c, from, to), remap_slot(v, from, to)))
                .collect(),
            otherwise: otherwise
                .as_ref()
                .map(|e| Box::new(remap_slot(e, from, to))),
        },
        Expr::Cast { target, expr } => Expr::Cast {
            target: *target,
            expr: go(expr),
        },
        Expr::IsNull { expr, negated } => Expr::IsNull {
            expr: go(expr),
            negated: *negated,
        },
        Expr::PropertyExists { slot, key } => Expr::PropertyExists {
            slot: if *slot == from { to } else { *slot },
            key: key.clone(),
        },
        Expr::IsLabeled { slot, labels } => Expr::IsLabeled {
            slot: if *slot == from { to } else { *slot },
            labels: labels.clone(),
        },
        // Never reached: `refs_only_slot` rejects EXISTS, so the frontier remap
        // that calls this is never handed one. Clone rather than rewrite a body.
        Expr::Exists { .. }
        | Expr::CountSubquery { .. }
        | Expr::ScalarSubquery { .. }
        | Expr::CollectSubquery { .. }
        | Expr::AggSubquery { .. }
        | Expr::UncorrelatedExists { .. }
        | Expr::UncorrelatedCount { .. }
        | Expr::UncorrelatedScalar { .. }
        | Expr::Param(_) => expr.clone(),
    }
}

/// `count(*)` grouped by a single property of the frontier node, computed by
/// grouping on the integer node id FIRST, then merging node groups by the
/// property value. The property is a function of the node, so two rows on the
/// same node share a property value: counting 8M endpoints by their (cheap,
/// dense) node id and reading/hashing the property for only the distinct nodes
/// replaces millions of string hashes and `Arc` clones with a direct-mapped
/// array index each. The final hop is fused into the count — endpoints are
/// streamed straight into the array, never materialized as a column. First-seen
/// order is preserved: the distinct nodes are visited in first-appearance order,
/// so a property value is first seen at the earliest node — hence earliest row —
/// carrying it. `None` for any other shape (non-count aggregate, key that is not
/// a lone frontier property), which falls through to the general frontier path.
///
/// Rejected optimization: for a DICT-encoded key, counting straight into per-code
/// buckets during the traversal (`counts[codes[nbr]] += 1`), skipping this per-node
/// intermediate and the Level-2 merge. It moved `c.city, count(*)` on the 2-hop
/// 100k/deg-5 fixture only 24.5ms -> 23.0ms (0.54x -> 0.57x of the TS engine) — a consistent
/// ~7% but still far from parity, and it TRADES the per-node scatter for reading the
/// property once PER PATH (2.5M reads) instead of once per distinct endpoint (100k).
/// The shape is memory-bound on ~2.5M random accesses either way; the TS engine's remaining
/// edge is its CSR adjacency (sequential neighbour reads), which the per-node `Vec`
/// adjacency here cannot match without a layout change (deferred, large blast radius).
/// Not worth a second grouped-count path for a sub-10% move that leaves it slowest.
pub(super) fn try_node_grouped_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let [agg] = aggs else { return None };
    if agg.func != AggFn::Count || agg.arg.is_some() {
        return None;
    }
    let [(_, key_expr)] = keys else { return None };
    // The group node is the endpoint of a final Expand over a Scan/Expand chain.
    let Plan::Expand {
        input: inner,
        from,
        dir,
        edge_label,
        bind_edge,
        double_loops: false,
    } = input
    else {
        return None;
    };
    if *bind_edge {
        // With the edge bound, the endpoint node sits at slot w+1 and slot w is the
        // EDGE — so a `Prop{slot: w}` key is an edge property, not a node one. This
        // fast path reads NODE properties of the endpoint; hand a bound-edge group
        // (e.g. `RETURN r.w, count(*)`) to the general aggregate, which reads the
        // edge slot correctly. (Found by the differential fuzzer: this used to read
        // the edge key as an absent node property and bucket every row under NULL.)
        return None;
    }
    let w = chain_width(inner)?;
    if *from + 1 != w {
        return None; // the final Expand must expand the current frontier
    }
    let Expr::Prop { slot, key } = key_expr else {
        return None;
    };
    if *slot != w {
        return None; // key must read the endpoint (last) slot, index == w
    }
    let want = match want_etypes(store, edge_label) {
        Ok(w) => w,
        Err(()) => return Some(Batch::of(vec![Col::Nodes(vec![]), Col::Gen(vec![])])),
    };
    let src = frontier_ids(inner, store)?; // nodes feeding the final hop, w/ multiplicity

    // Level 1: count per endpoint node id via a direct-mapped array (no hashing —
    // node ids are dense), with the final hop fused in so endpoints never
    // materialize. Distinct ids come out in first-seen order.
    let mut group_of = vec![u32::MAX; store.node_count()];
    let mut rep_ids: Vec<u32> = Vec::new();
    let mut node_count: Vec<f64> = Vec::new();
    for &v in &src {
        for_each_nbr(store, v, *dir, &want, false, |nbr, _| {
            let slot = &mut group_of[nbr as usize];
            if *slot == u32::MAX {
                *slot = u32::try_from(rep_ids.len()).expect("group count fits in u32");
                rep_ids.push(nbr);
                node_count.push(1.0);
            } else {
                node_count[*slot as usize] += 1.0;
            }
        });
    }

    // Read the grouping property for the DISTINCT endpoint nodes only.
    let key_col = read_property(store, &Col::Nodes(rep_ids), key);

    // Level 2: merge node groups by property value, summing their counts.
    let (val_of, val_first) = assign_groups(std::slice::from_ref(&key_col), key_col.len());
    let mut counts = vec![0f64; val_first.len()];
    for (node_group, &vg) in val_of.iter().enumerate() {
        counts[vg as usize] += node_count[node_group];
    }
    let key_out = key_col.gather(&val_first);
    Some(Batch::of(vec![
        key_out,
        Col::Gen(counts.into_iter().map(Value::Num).collect()),
    ]))
}

/// Run a grouped/scalar aggregate over a Scan/Expand chain WITHOUT materializing
/// the earlier slots: when every key and aggregate argument reads only the
/// frontier (last) slot, the chain's frontier is all the aggregate needs. The
/// frontier ([`frontier_ids`]) is produced in the same row order the full batch
/// would have, so first-seen group order — and every value — is identical to the
/// general path; this only drops the wasted slot columns. `None` for any shape it
/// does not handle (a filter/join in the chain, an expression over an earlier
/// slot), which falls back to the general aggregate.
pub(super) fn try_frontier_aggregate(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Result<Option<Batch>, String> {
    let Some(width) = chain_width(input) else {
        return Ok(None);
    };
    let last = width - 1; // frontier slot index of the whole chain
    let key_ok = keys.iter().all(|(_, e)| refs_only_slot(e, last));
    let agg_ok = aggs
        .iter()
        .all(|a| a.arg.as_ref().is_none_or(|e| refs_only_slot(e, last)));
    if !key_ok || !agg_ok {
        return Ok(None);
    }
    let Some(frontier) = frontier_ids(input, store) else {
        return Ok(None);
    };
    let batch = Batch::of(vec![Col::Nodes(frontier)]);
    // Retarget the frontier-only expressions onto the one-slot frontier batch.
    let keys: Vec<(String, Expr)> = keys
        .iter()
        .map(|(n, e)| (n.clone(), remap_slot(e, last, 0)))
        .collect();
    let aggs: Vec<Agg> = aggs
        .iter()
        .map(|a| Agg {
            func: a.func,
            arg: a.arg.as_ref().map(|e| remap_slot(e, last, 0)),
            distinct: a.distinct,
            name: a.name.clone(),
            frac: a.frac,
            null_on_empty: a.null_on_empty,
            // Preserve min()/max()'s cross-type-fault contract: dropping it let a grouped
            // `by(__.values(v).max())` return a value where the streamed spelling faulted.
            numeric_only: a.numeric_only,
        })
        .collect();
    Ok(Some(aggregate(&batch, store, &keys, &aggs)?))
}

/// `MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*)` — the product of the sides'
/// counts, because a `Join` with an empty `on` is a cartesian product and `count(*)`
/// of a product is the product of the counts.
///
/// A comma-pattern list lowers to `Plan::join(left, right, on)` where `on` pairs the
/// SHARED variables' slots, so an empty `on` is exactly "these patterns are
/// independent". Three patterns nest as `Join { left: Join { .. }, right }`, which the
/// recursion handles.
///
/// This was a missing path in BOTH engines. On 20,000 vertices with |k=1| = 5,000 and
/// |k=2| = 2,143 the answer is 10,715,000 rows, which this engine enumerated in 76ms
/// and the TypeScript engine in 2,637ms; the TS side took the product first (audit item
/// 135) and ran 95x faster than native here, which is what identified this gap. At the
/// cross-engine bench's 200,000 vertices the same query is over a BILLION rows.
///
/// Both spellings reach it, and for free: `MATCH (a) MATCH (b)` and `MATCH (a), (b)`
/// lower to the IDENTICAL optimized plan, so unlike the TypeScript side there is no
/// second spelling to teach.
///
/// ### Why counting a side that can RAISE is safe here
///
/// The first cut accepted only non-faulting leaves (label buckets and seeks), reasoning
/// that a side which evaluates expressions might be reached by the general path only
/// when the OTHER side is non-empty — so taking the product could raise where general
/// execution does not, and WHICH queries raise is part of the cross-engine invariant.
///
/// Reading the operator settles it the other way: `Plan::Join` executes as
/// `hash_join(&pull(left)?, &pull(right)?, on)`, which pulls BOTH sides unconditionally
/// and LEFT FIRST. So counting each side independently evaluates exactly what the
/// general path evaluates, in the same order; the only thing skipped is the cross. Hence
/// the fallback arm, which materializes one side and takes its row count — still
/// O(|A|) + O(|B|) instead of O(|A| x |B|) — and hence `Filter`-constrained factors
/// (any non-equality predicate, which stays a `Filter` rather than becoming a seek) are
/// covered too.
///
/// Two things that follow and must not be "tidied":
///
/// - **No early return on a zero factor.** It would skip pulling the right side, which
///   the general path always pulls, and so could drop a raise.
/// - **An error becomes `None`, not a propagated failure.** Returning `None` lets general
///   execution run and raise the identical error itself (the idiom the rest of this file
///   already uses for `pull`). The side is pulled twice on that path, which only happens
///   when the query is about to fail anyway.
///
/// `Filter` over the `Join` is NOT matched: a clause `WHERE` can CORRELATE the patterns
/// (`MATCH (a:P {k: 1}), (b:P) WHERE b.k = a.k` is not a product), so it declines.
pub(super) fn try_join_product_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() != 1 {
        return None;
    }
    let agg = &aggs[0];
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None;
    }
    // Only a cartesian `Join` at the ROOT; anything else is some other shape's job.
    let Plan::Join { on, .. } = input else {
        return None;
    };
    if !on.is_empty() {
        return None;
    }
    product_of_counts(input, keys, aggs, store).map(|n| scalar_num(n as f64))
}

/// The row count of a cartesian `Join` tree whose leaves are all non-faulting
/// lookups, or `None` if any leaf is a shape that could evaluate an expression.
///
/// `keys`/`aggs` are the caller's, already checked to be one global `count(*)`, so an
/// EDGE-pattern leaf can delegate to `try_fused_count` — the bare-hop counter — rather
/// than re-deriving a degree sum here, with its direction, edge-type and
/// `double_loops` (Gremlin `both()` over a self-loop) subtleties.
fn product_of_counts(
    plan: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<u64> {
    match plan {
        Plan::Join { left, right, on } if on.is_empty() => {
            // Saturating, not wrapping: the count is a row count, and 10^9 rows is
            // reachable at bench scale, so a product of two large factors must not
            // silently wrap into a small wrong answer.
            Some(
                product_of_counts(left, keys, aggs, store)?
                    .saturating_mul(product_of_counts(right, keys, aggs, store)?),
            )
        }
        Plan::Scan { label: Some(l) } => Some(store.nodes_with_label(l).len() as u64),
        Plan::Scan { label: None } => Some(store.live_node_count() as u64),
        Plan::EdgeScan => Some(store.all_edges().len() as u64),
        Plan::IndexSeek { label, key, value } => {
            Some(super::index_seek_ids(store, label.as_deref(), key, value).len() as u64)
        }
        // An edge pattern (`()-[:E]->()`) is an `Expand` over one of the leaves above.
        // `try_fused_count` answers that chain from degree sums, so it is preferred over
        // the fallback purely to avoid materializing a hop-sized batch; the fallback
        // would be correct, just wider.
        //
        // There is no `RangeSeek` arm. A range predicate stays `Filter { Scan }` — the
        // planner emits `IndexSeek` for an equality and leaves `>`/`<` alone — so such an
        // arm was unreachable, which mutation exposed by surviving: the test that was
        // supposed to cover it had been passing through general execution. The fallback
        // below handles the `Filter` shape that is actually produced.
        Plan::Expand { .. } => count_in_batch(try_fused_count(plan, keys, aggs, store)?),
        // ANY other side: materialize just this one and take its row count. See the
        // raise-parity argument on `try_join_product_count`.
        other => Some(pull(other, store, false).ok()?.rows() as u64),
    }
}

/// The scalar count a `try_*_count` fast path returns, as an exact `u64`.
fn count_in_batch(b: Batch) -> Option<u64> {
    match b.slots.first()?.value_at(0) {
        Value::Num(x) if x >= 0.0 && x.fract() == 0.0 && x <= 9.007_199_254_740_992e15 => {
            Some(x as u64)
        }
        _ => None,
    }
}
