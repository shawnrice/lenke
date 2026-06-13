//! Evaluator + executor over the lowered IR ([`super::plan`]). Pattern matching
//! is a backtracking visitor over the columnar adjacency; expressions use ISO
//! three-valued (Kleene) logic. The IR has already resolved `$param` to a
//! positional slot, functions to enums, and projection metadata — so the
//! per-row path here is a plain `match`, no string work for params/functions.
//!
//! A query is run via a [`Prepared`] plan: lower once, execute many times with
//! different params (positional, slotted at lower time) against any graph.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::rc::Rc;

use super::ast::{ArithOp, CompareOp, Direction, Lit, Quantifier, SetOp, SetOpKind};
use super::lexer::SyntaxError;
use super::plan::{
    lower, AggFn, CClause, CExpr, CLabelExpr, CLinear, CNode, CPath, CProjection, CPropConstraint, CQuery, CRel,
    CRemoveItem, CSegment, CSetItem, ScalarFn,
};
use crate::graph::{Column, Graph, Value};
use crate::query::RowSet;

/// A runtime value. Extends the core [`Value`] with graph-element handles
/// (`Node`/`Edge` by dense index) so variables, identity (`a = b`), and
/// `element_id` work before projection flattens elements to their ids.
#[derive(Clone, Debug)]
pub enum Val {
    Null,
    Bool(bool),
    Num(f64),
    /// Interned string: cloning is a refcount bump, not an allocation.
    Str(Rc<str>),
    List(Vec<Val>),
    Node(u32),
    Edge(u32),
}

/// One candidate solution: variable slot → value. Slots are assigned per scope
/// by the lowering pass, so access is an array index (not a name scan). `None` is
/// an unbound slot; `Some(Val::Null)` is an explicit null (e.g. OPTIONAL MATCH).
#[derive(Clone, Debug, Default)]
pub struct Binding(Vec<Option<Val>>);

impl Binding {
    fn get(&self, slot: usize) -> Option<&Val> {
        self.0.get(slot).and_then(|o| o.as_ref())
    }
    fn bound(&self, slot: usize) -> bool {
        self.0.get(slot).is_some_and(|o| o.is_some())
    }
    fn set(&mut self, slot: usize, v: Val) {
        if slot >= self.0.len() {
            self.0.resize(slot + 1, None);
        }
        self.0[slot] = Some(v);
    }
    fn unset(&mut self, slot: usize) {
        if slot < self.0.len() {
            self.0[slot] = None;
        }
    }
    fn resize(&mut self, len: usize) {
        self.0.resize(len, None);
    }
}

/// Query parameters supplied by name; bound to positional slots at execute time.
pub type Params = HashMap<String, Val>;

/// Per-execution context resolved once against the graph: positional params, and
/// each plan ref (property key / label name) resolved to its graph id so the
/// per-row path is an array index, not a `HashMap` lookup. It owns the resolved
/// tables and borrows nothing from the graph, so the write path can still take
/// `&mut Graph` alongside it.
struct Ctx<'a> {
    params: &'a [Val],
    /// key_ref -> (vertex property-key id, edge property-key id).
    prop_keys: Vec<(Option<u32>, Option<u32>)>,
    /// label ref -> (vertex-label id, edge-type id) — a name can be both.
    labels: Vec<(Option<u32>, Option<u32>)>,
    /// label ref -> name (for write clauses, which create labels/types by name).
    label_names: &'a [String],
}

fn resolve_ctx<'a>(graph: &Graph, plan: &'a CQuery, params: &'a [Val]) -> Ctx<'a> {
    Ctx {
        params,
        prop_keys: plan
            .key_names
            .iter()
            .map(|n| (graph.props.keys.get(n), graph.edge_props.keys.get(n)))
            .collect(),
        labels: plan.label_names.iter().map(|n| (graph.labels.get(n), graph.etype.get(n))).collect(),
        label_names: &plan.label_names,
    }
}

/// The environment an expression evaluates against.
struct Env<'a> {
    graph: &'a Graph,
    ctx: &'a Ctx<'a>,
    binding: &'a Binding,
    /// Set while folding an aggregate over its group of bindings (the rare
    /// `eval`-time aggregate path, e.g. an aggregate in WHERE).
    group: Option<&'a [Binding]>,
    /// Folded values of a projection's extracted aggregates, resolved by
    /// [`CExpr::AggRef`] when materializing a group's output row.
    agg_values: Option<&'a [Val]>,
}

impl<'a> Env<'a> {
    fn new(graph: &'a Graph, ctx: &'a Ctx<'a>, binding: &'a Binding) -> Self {
        Env { graph, ctx, binding, group: None, agg_values: None }
    }
}

// --- value helpers -----------------------------------------------------------

fn is_nullish(v: &Val) -> bool {
    matches!(v, Val::Null)
}

/// ISO Kleene truth: `None` = UNKNOWN. Mirrors TS `asTruth` (`Boolean(v)`).
type Truth = Option<bool>;
fn as_truth(v: &Val) -> Truth {
    match v {
        Val::Null => None,
        Val::Bool(b) => Some(*b),
        Val::Num(n) => Some(*n != 0.0 && !n.is_nan()),
        Val::Str(s) => Some(!s.is_empty()),
        _ => Some(true),
    }
}
fn not3(t: Truth) -> Truth {
    t.map(|b| !b)
}
fn and3(a: Truth, b: Truth) -> Truth {
    if a == Some(false) || b == Some(false) {
        return Some(false);
    }
    if a.is_none() || b.is_none() {
        None
    } else {
        Some(true)
    }
}
fn or3(a: Truth, b: Truth) -> Truth {
    if a == Some(true) || b == Some(true) {
        return Some(true);
    }
    if a.is_none() || b.is_none() {
        None
    } else {
        Some(false)
    }
}
fn xor3(a: Truth, b: Truth) -> Truth {
    match (a, b) {
        (Some(x), Some(y)) => Some(x != y),
        _ => None,
    }
}

/// JS `Number(v)` for the cases that matter; `None` only for nullish.
fn num_of(v: &Val) -> Option<f64> {
    match v {
        Val::Null => None,
        Val::Num(n) => Some(*n),
        Val::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Val::Str(s) => {
            let t = s.trim();
            Some(if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) })
        }
        _ => Some(f64::NAN),
    }
}

fn num_of_owned(v: &Val) -> Option<f64> {
    num_of(v)
}

fn js_num(n: f64) -> String {
    if n.is_nan() {
        "NaN".to_string()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() }
    } else {
        format!("{n}")
    }
}

/// JS `String(v)` for non-null values (concat/string fns guard nullish first).
fn js_str(graph: &Graph, v: &Val) -> String {
    match v {
        Val::Null => "null".to_string(),
        Val::Bool(b) => b.to_string(),
        Val::Num(n) => js_num(*n),
        Val::Str(s) => s.to_string(),
        Val::Node(i) => graph.vid.text(*i).to_string(),
        Val::Edge(i) => format!("e{i}"),
        Val::List(items) => items.iter().map(|x| js_str(graph, x)).collect::<Vec<_>>().join(","),
    }
}

/// Make a `Val::Str` from anything that can produce an owned/borrowed `str`.
fn vstr(s: impl Into<Rc<str>>) -> Val {
    Val::Str(s.into())
}

/// Structural / identity equality (Null == Null is true). Used by `=` (after a
/// nullish guard) and by the element-pattern predicate's strict comparison.
fn val_eq(a: &Val, b: &Val) -> bool {
    match (a, b) {
        (Val::Null, Val::Null) => true,
        (Val::Bool(x), Val::Bool(y)) => x == y,
        (Val::Num(x), Val::Num(y)) => x == y,
        (Val::Str(x), Val::Str(y)) => x == y,
        (Val::Node(x), Val::Node(y)) => x == y,
        (Val::Edge(x), Val::Edge(y)) => x == y,
        (Val::List(x), Val::List(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| val_eq(p, q)),
        _ => false,
    }
}

/// Ordering for `< > <= >=`, min/max, and ORDER BY. `None` = incomparable.
fn val_cmp(a: &Val, b: &Val) -> Option<Ordering> {
    match (a, b) {
        (Val::Num(x), Val::Num(y)) => x.partial_cmp(y),
        (Val::Str(x), Val::Str(y)) => Some(x.cmp(y)),
        (Val::Bool(x), Val::Bool(y)) => Some(x.cmp(y)),
        (Val::Node(x), Val::Node(y)) => Some(x.cmp(y)),
        (Val::Edge(x), Val::Edge(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

/// `v IN list` as a three-valued OR of equalities (identity = empty → FALSE).
fn in_list(v: &Val, list: &Val) -> Truth {
    let Val::List(items) = list else { return None };
    let mut saw_unknown = false;
    for e in items {
        if is_nullish(v) || is_nullish(e) {
            saw_unknown = true;
            continue;
        }
        if val_eq(e, v) {
            return Some(true);
        }
    }
    if saw_unknown {
        None
    } else {
        Some(false)
    }
}

/// A canonical, hashable key for a value — grouping, DISTINCT, row keys.
fn val_key(v: &Val, out: &mut String) {
    match v {
        Val::Null => out.push('N'),
        Val::Bool(b) => {
            out.push('b');
            out.push(if *b { '1' } else { '0' });
        }
        Val::Num(n) => {
            let _ = write!(out, "n{:016x}", n.to_bits());
        }
        Val::Str(s) => {
            let _ = write!(out, "s{s}");
        }
        Val::Node(i) => {
            let _ = write!(out, "@v{i}");
        }
        Val::Edge(i) => {
            let _ = write!(out, "@e{i}");
        }
        Val::List(items) => {
            out.push('[');
            for it in items {
                val_key(it, out);
                out.push(',');
            }
            out.push(']');
        }
    }
}

fn row_key(b: &Binding) -> String {
    let mut s = String::new();
    for cell in &b.0 {
        match cell {
            Some(v) => val_key(v, &mut s),
            None => s.push('\u{2}'), // distinct marker for an unbound slot
        }
        s.push('\u{1}');
    }
    s
}

// --- property / label access -------------------------------------------------

fn value_to_val(v: &Value) -> Val {
    match v {
        Value::Null => Val::Null,
        Value::Bool(b) => Val::Bool(*b),
        Value::Num(n) => Val::Num(*n),
        Value::Str(s) => vstr(s.as_str()),
        Value::List(items) => Val::List(items.iter().map(value_to_val).collect()),
    }
}

/// Project a runtime value to the core output [`Value`]; elements flatten to
/// their id string (the rowset/JSON model has no element type).
fn val_to_value(graph: &Graph, v: &Val) -> Value {
    match v {
        Val::Null => Value::Null,
        Val::Bool(b) => Value::Bool(*b),
        Val::Num(n) => Value::Num(*n),
        Val::Str(s) => Value::Str(s.to_string()),
        Val::List(items) => Value::List(items.iter().map(|x| val_to_value(graph, x)).collect()),
        Val::Node(i) => Value::Str(graph.vid.text(*i).to_string()),
        Val::Edge(i) => Value::Str(format!("e{i}")),
    }
}

/// ISO: an absent property — or a property of a non-element/NULL — yields NULL.
/// Vertices and edges read from the same columnar store; `key_ref`'s id was
/// resolved once at execute time (no per-access name lookup).
fn prop_of(graph: &Graph, ctx: &Ctx, bound: &Val, key_ref: usize) -> Val {
    let (store, kid, idx) = match bound {
        Val::Node(vi) => (&graph.props, ctx.prop_keys[key_ref].0, *vi as usize),
        Val::Edge(ei) => (&graph.edge_props, ctx.prop_keys[key_ref].1, *ei as usize),
        _ => return Val::Null,
    };
    let Some(kid) = kid else { return Val::Null };
    // Read the column directly: a string property is a refcount bump (Rc clone),
    // not an allocation; numbers/bools are copied; Mixed converts.
    match store.cols.get(kid as usize) {
        Some(Column::Num { data, present }) if present.get(idx) => Val::Num(data[idx]),
        Some(Column::Bool { data, present }) if present.get(idx) => Val::Bool(data[idx]),
        Some(Column::Str { data, present }) if present.get(idx) => Val::Str(graph.strs.rc(data[idx])),
        Some(Column::Mixed { data }) => data[idx].as_ref().map(value_to_val).unwrap_or(Val::Null),
        _ => Val::Null,
    }
}

fn eval_label_node(graph: &Graph, ctx: &Ctx, vi: u32, expr: &CLabelExpr) -> bool {
    match expr {
        CLabelExpr::Label(r) => ctx.labels[*r].0.is_some_and(|lid| graph.has_label(vi, lid)),
        CLabelExpr::Wildcard => !graph.vertex_labels(vi).is_empty(),
        CLabelExpr::Not(e) => !eval_label_node(graph, ctx, vi, e),
        CLabelExpr::And(l, r) => eval_label_node(graph, ctx, vi, l) && eval_label_node(graph, ctx, vi, r),
        CLabelExpr::Or(l, r) => eval_label_node(graph, ctx, vi, l) || eval_label_node(graph, ctx, vi, r),
    }
}

fn eval_label_edge(ctx: &Ctx, etype: u32, expr: &CLabelExpr) -> bool {
    match expr {
        CLabelExpr::Label(r) => ctx.labels[*r].1 == Some(etype),
        CLabelExpr::Wildcard => true, // an edge always has exactly one type
        CLabelExpr::Not(e) => !eval_label_edge(ctx, etype, e),
        CLabelExpr::And(l, r) => eval_label_edge(ctx, etype, l) && eval_label_edge(ctx, etype, r),
        CLabelExpr::Or(l, r) => eval_label_edge(ctx, etype, l) || eval_label_edge(ctx, etype, r),
    }
}

/// `IS LABELED` over a runtime element value.
fn labels_match(graph: &Graph, ctx: &Ctx, el: &Val, expr: &CLabelExpr) -> bool {
    match el {
        Val::Node(vi) => eval_label_node(graph, ctx, *vi, expr),
        Val::Edge(ei) => eval_label_edge(ctx, graph.e_type[*ei as usize], expr),
        _ => false,
    }
}

fn matches_label(graph: &Graph, ctx: &Ctx, vi: u32, label: Option<&CLabelExpr>) -> bool {
    label.is_none_or(|e| eval_label_node(graph, ctx, vi, e))
}

// --- expression evaluation ---------------------------------------------------

fn truth_to_val(t: Truth) -> Val {
    match t {
        Some(b) => Val::Bool(b),
        None => Val::Null,
    }
}

fn eval(env: &Env, expr: &CExpr) -> Val {
    match expr {
        CExpr::Lit(l) => match l {
            Lit::Null => Val::Null,
            Lit::Bool(b) => Val::Bool(*b),
            Lit::Num(n) => Val::Num(*n),
            Lit::Str(s) => vstr(s.as_str()),
        },
        CExpr::Var(slot) => env.binding.get(*slot).cloned().unwrap_or(Val::Null),
        CExpr::Param(slot) => env.ctx.params.get(*slot).cloned().unwrap_or(Val::Null),
        CExpr::Prop { var_slot, key_ref } => {
            let bound = env.binding.get(*var_slot).cloned().unwrap_or(Val::Null);
            prop_of(env.graph, env.ctx, &bound, *key_ref)
        }
        CExpr::List(items) => Val::List(items.iter().map(|e| eval(env, e)).collect()),
        CExpr::Neg(e) => match num_of(&eval(env, e)) {
            Some(n) => Val::Num(-n),
            None => Val::Null,
        },
        CExpr::Arith { op, left, right } => {
            let lv = num_of(&eval(env, left));
            let rv = num_of(&eval(env, right));
            match (lv, rv) {
                (Some(a), Some(b)) => Val::Num(match op {
                    ArithOp::Add => a + b,
                    ArithOp::Sub => a - b,
                    ArithOp::Mul => a * b,
                    ArithOp::Div => a / b,
                    ArithOp::Mod => a % b,
                }),
                _ => Val::Null,
            }
        }
        CExpr::Concat { left, right } => {
            let lv = eval(env, left);
            let rv = eval(env, right);
            if is_nullish(&lv) || is_nullish(&rv) {
                Val::Null
            } else {
                vstr(js_str(env.graph, &lv) + &js_str(env.graph, &rv))
            }
        }
        CExpr::Not(e) => truth_to_val(not3(as_truth(&eval(env, e)))),
        CExpr::And(l, r) => truth_to_val(and3(as_truth(&eval(env, l)), as_truth(&eval(env, r)))),
        CExpr::Or(l, r) => truth_to_val(or3(as_truth(&eval(env, l)), as_truth(&eval(env, r)))),
        CExpr::Xor(l, r) => truth_to_val(xor3(as_truth(&eval(env, l)), as_truth(&eval(env, r)))),
        CExpr::IsNull { expr, negated } => {
            let isnull = is_nullish(&eval(env, expr));
            Val::Bool(if *negated { !isnull } else { isnull })
        }
        CExpr::IsTruth { expr, truth, negated } => {
            let m = as_truth(&eval(env, expr)) == *truth;
            Val::Bool(if *negated { !m } else { m })
        }
        CExpr::IsLabeled { expr, label, negated } => {
            let el = eval(env, expr);
            let has = labels_match(env.graph, env.ctx, &el, label);
            Val::Bool(if *negated { !has } else { has })
        }
        CExpr::In { expr, list, negated } => {
            let r = in_list(&eval(env, expr), &eval(env, list));
            truth_to_val(if *negated { not3(r) } else { r })
        }
        CExpr::Compare { op, left, right } => {
            let lv = eval(env, left);
            let rv = eval(env, right);
            if is_nullish(&lv) || is_nullish(&rv) {
                return Val::Null; // UNKNOWN
            }
            let res = match op {
                CompareOp::Eq => val_eq(&lv, &rv),
                CompareOp::Ne => !val_eq(&lv, &rv),
                CompareOp::Lt => val_cmp(&lv, &rv) == Some(Ordering::Less),
                CompareOp::Gt => val_cmp(&lv, &rv) == Some(Ordering::Greater),
                CompareOp::Le => matches!(val_cmp(&lv, &rv), Some(Ordering::Less | Ordering::Equal)),
                CompareOp::Ge => matches!(val_cmp(&lv, &rv), Some(Ordering::Greater | Ordering::Equal)),
            };
            Val::Bool(res)
        }
        CExpr::Case { subject, whens, else_ } => {
            if let Some(subj) = subject {
                let s = eval(env, subj);
                for (w, t) in whens {
                    let wv = eval(env, w);
                    if !is_nullish(&s) && !is_nullish(&wv) && val_eq(&s, &wv) {
                        return eval(env, t);
                    }
                }
            } else {
                for (w, t) in whens {
                    if as_truth(&eval(env, w)) == Some(true) {
                        return eval(env, t);
                    }
                }
            }
            else_.as_ref().map(|e| eval(env, e)).unwrap_or(Val::Null)
        }
        CExpr::Exists { patterns, where_, sub_len } => {
            Val::Bool(any_match(env.graph, env.ctx, patterns, where_.as_deref(), env.binding, *sub_len))
        }
        CExpr::CountSubquery { patterns, where_, sub_len } => {
            Val::Num(count_matches(env.graph, env.ctx, patterns, where_.as_deref(), env.binding, *sub_len) as f64)
        }
        CExpr::Scalar { func, args } => {
            let vals: Vec<Val> = args.iter().map(|a| eval(env, a)).collect();
            call_scalar(env.graph, *func, &vals)
        }
        CExpr::Aggregate { func, arg, distinct, star } => {
            eval_aggregate(env, *func, arg.as_deref(), *distinct, *star)
        }
        CExpr::AggRef(idx) => env.agg_values.and_then(|a| a.get(*idx)).cloned().unwrap_or(Val::Null),
    }
}

fn eval_aggregate(env: &Env, func: AggFn, arg: Option<&CExpr>, distinct: bool, star: bool) -> Val {
    let single;
    let group: &[Binding] = match env.group {
        Some(g) => g,
        None => {
            single = [env.binding.clone()];
            &single
        }
    };
    if func == AggFn::Count && star {
        return Val::Num(group.len() as f64);
    }
    let Some(arg) = arg else { return Val::Null };
    // Evaluate the argument over every binding in the group.
    let raw: Vec<Val> = group
        .iter()
        .map(|b| {
            let e = Env { graph: env.graph, ctx: env.ctx, binding: b, group: Some(group), agg_values: None };
            eval(&e, arg)
        })
        .collect();
    let mut values: Vec<Val> = raw.into_iter().filter(|v| !is_nullish(v)).collect();
    if distinct {
        let mut seen = HashSet::new();
        values.retain(|v| {
            let mut k = String::new();
            val_key(v, &mut k);
            seen.insert(k)
        });
    }
    match func {
        AggFn::Count => Val::Num(values.len() as f64),
        AggFn::Sum => Val::Num(values.iter().filter_map(num_of_owned).sum()),
        AggFn::Avg => {
            if values.is_empty() {
                Val::Null
            } else {
                let s: f64 = values.iter().filter_map(num_of_owned).sum();
                Val::Num(s / values.len() as f64)
            }
        }
        AggFn::Min => fold_extreme(values, Ordering::Less),
        AggFn::Max => fold_extreme(values, Ordering::Greater),
        AggFn::CollectList => Val::List(values),
    }
}

fn fold_extreme(values: Vec<Val>, want: Ordering) -> Val {
    let mut it = values.into_iter();
    let Some(mut acc) = it.next() else { return Val::Null };
    for v in it {
        if val_cmp(&v, &acc) == Some(want) {
            acc = v;
        }
    }
    acc
}

// --- scalar functions (dispatched on the resolved enum) ----------------------

fn call_scalar(graph: &Graph, func: ScalarFn, args: &[Val]) -> Val {
    use ScalarFn::*;
    let a = args.first();
    let b = args.get(1);
    let un = |f: fn(f64) -> f64| match a {
        Some(v) if !is_nullish(v) => Val::Num(f(num_of(v).unwrap_or(f64::NAN))),
        _ => Val::Null,
    };
    let us = |f: fn(&str) -> Val| match a {
        Some(v) if !is_nullish(v) => f(&js_str(graph, v)),
        _ => Val::Null,
    };
    let bn = |f: fn(f64, f64) -> f64| match (a, b) {
        (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
            Val::Num(f(num_of(x).unwrap_or(f64::NAN), num_of(y).unwrap_or(f64::NAN)))
        }
        _ => Val::Null,
    };
    match func {
        Abs => un(f64::abs),
        Ceil => un(f64::ceil),
        Floor => un(f64::floor),
        Sqrt => un(f64::sqrt),
        Exp => un(f64::exp),
        Ln => un(f64::ln),
        Log10 => un(f64::log10),
        Sin => un(f64::sin),
        Cos => un(f64::cos),
        Tan => un(f64::tan),
        Cot => un(|n| 1.0 / n.tan()),
        Asin => un(f64::asin),
        Acos => un(f64::acos),
        Atan => un(f64::atan),
        Sinh => un(f64::sinh),
        Cosh => un(f64::cosh),
        Tanh => un(f64::tanh),
        Degrees => un(f64::to_degrees),
        Radians => un(f64::to_radians),
        Upper => us(|s| vstr(s.to_uppercase())),
        Lower => us(|s| vstr(s.to_lowercase())),
        Trim => us(|s| vstr(s.trim())),
        Ltrim => us(|s| vstr(s.trim_start())),
        Rtrim => us(|s| vstr(s.trim_end())),
        CharLength => us(|s| Val::Num(s.chars().count() as f64)),
        Power => bn(|x, y| x.powf(y)),
        Mod => bn(|x, y| x % y),
        Log => bn(|base, value| value.ln() / base.ln()),
        Size => match a {
            Some(Val::List(items)) => Val::Num(items.len() as f64),
            Some(Val::Str(s)) => Val::Num(s.chars().count() as f64),
            _ => Val::Null,
        },
        Left => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s = js_str(graph, x);
                let n = num_of(y).unwrap_or(0.0).max(0.0) as usize;
                vstr(s.chars().take(n).collect::<String>())
            }
            _ => Val::Null,
        },
        Right => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s: Vec<char> = js_str(graph, x).chars().collect();
                let n = num_of(y).unwrap_or(0.0);
                if n <= 0.0 {
                    vstr("")
                } else {
                    let n = (n as usize).min(s.len());
                    vstr(s[s.len() - n..].iter().collect::<String>())
                }
            }
            _ => Val::Null,
        },
        Coalesce => args.iter().find(|x| !is_nullish(x)).cloned().unwrap_or(Val::Null),
        Nullif => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) && val_eq(x, y) => Val::Null,
            (Some(x), _) => x.clone(),
            _ => Val::Null,
        },
        ElementId => match a {
            Some(Val::Node(i)) => Val::Str(graph.vid.rc(*i)),
            Some(Val::Edge(i)) => vstr(format!("e{i}")),
            _ => Val::Null,
        },
        Unknown => Val::Null,
    }
}

// --- pattern matching --------------------------------------------------------

/// Bind a slot to `value` for a recursion branch, returning whether it was newly
/// set (so the caller can restore it on backtrack). A consistent already-bound
/// slot is left untouched; an inconsistent one is rejected (`None`).
fn bind_slot(binding: &mut Binding, slot: Option<usize>, value: &Val) -> Option<bool> {
    match slot {
        None => Some(false),
        Some(s) => {
            if binding.bound(s) {
                if val_eq(binding.get(s).unwrap(), value) {
                    Some(false)
                } else {
                    None // join conflict — this branch fails
                }
            } else {
                binding.set(s, value.clone());
                Some(true)
            }
        }
    }
}

fn satisfies(
    graph: &Graph,
    ctx: &Ctx,
    element: &Val,
    props: &[CPropConstraint],
    where_: Option<&CExpr>,
    binding: &Binding,
) -> bool {
    let env = Env::new(graph, ctx, binding);
    for pc in props {
        if !val_eq(&prop_of(graph, ctx, element, pc.key_ref), &eval(&env, &pc.value)) {
            return false;
        }
    }
    where_.is_none_or(|w| as_truth(&eval(&env, w)) == Some(true))
}

/// A label this expression *guarantees* (for seeding from a label bucket): the
/// ref of a bare label or a conjunct; `or`/`not`/`%` can't narrow.
fn seed_label(expr: &CLabelExpr) -> Option<usize> {
    match expr {
        CLabelExpr::Label(r) => Some(*r),
        CLabelExpr::And(l, r) => seed_label(l).or_else(|| seed_label(r)),
        _ => None,
    }
}

/// Run `f` over each seed vertex, returning `false` if `f` requested a stop.
/// Iterates the label bucket / live-vertex range directly — no `Vec` of seeds.
fn for_each_seed(
    graph: &Graph,
    ctx: &Ctx,
    label: Option<&CLabelExpr>,
    f: &mut dyn FnMut(u32) -> bool,
) -> bool {
    match label.and_then(seed_label) {
        Some(r) => match ctx.labels[r].0 {
            Some(lid) => graph.vertices_with_label(lid).iter().all(|&s| f(s)),
            None => true, // unknown label → no seeds
        },
        None => graph.vertex_indices().all(|s| f(s)),
    }
}

/// Expand one segment from `v` as `(edge index, neighbor)` — a lazy iterator
/// (no intermediate `Vec`), so a short-circuiting consumer stops walking early.
fn expand<'a>(
    graph: &'a Graph,
    ctx: &'a Ctx,
    v: u32,
    direction: Direction,
    label: Option<&'a CLabelExpr>,
) -> impl Iterator<Item = (u32, u32)> + 'a {
    let out = matches!(direction, Direction::Out | Direction::Both).then(|| graph.out_adj(v));
    let inn = matches!(direction, Direction::In | Direction::Both).then(|| graph.in_adj(v));
    out.into_iter()
        .flatten()
        .chain(inn.into_iter().flatten())
        .filter(move |a| label.is_none_or(|e| eval_label_edge(ctx, a.etype, e)))
        .map(|a| (a.eidx, a.nbr))
}

/// Try to match `node` at vertex `vi`, extending `binding` in place and invoking
/// `cont` on success, then restoring it. Returns `false` only if `cont` asked to
/// stop the whole traversal.
fn match_node_then(
    graph: &Graph,
    ctx: &Ctx,
    binding: &mut Binding,
    node: &CNode,
    vi: u32,
    cont: &mut dyn FnMut(&mut Binding) -> bool,
) -> bool {
    if !matches_label(graph, ctx, vi, node.label.as_ref()) {
        return true; // no match here, but keep going
    }
    let Some(did_set) = bind_slot(binding, node.var_slot, &Val::Node(vi)) else {
        return true; // join conflict
    };
    let go = satisfies(graph, ctx, &Val::Node(vi), &node.props, node.where_.as_ref(), binding);
    let keep = if go { cont(binding) } else { true };
    if did_set {
        binding.unset(node.var_slot.unwrap());
    }
    keep
}

/// Vertices reachable from `from` in [min, max] hops of `rel` (var-length).
/// Returns just the endpoints — no per-hop path bookkeeping.
fn reachable(graph: &Graph, ctx: &Ctx, from: u32, rel: &CRel, q: Quantifier) -> Vec<u32> {
    let cap = q.max.unwrap_or(graph.n as u32 + 1);
    let mut result: Vec<u32> = Vec::new();
    let mut in_result = vec![false; graph.n];
    let add = |v: u32, result: &mut Vec<u32>, in_result: &mut [bool]| {
        if !in_result[v as usize] {
            in_result[v as usize] = true;
            result.push(v);
        }
    };
    if q.min == 0 {
        add(from, &mut result, &mut in_result);
    }
    let mut frontier = vec![from];
    let mut depth = 1u32;
    while depth <= cap && !frontier.is_empty() {
        let mut next = Vec::new();
        let mut seen_next = vec![false; graph.n];
        for &v in &frontier {
            for (_, nbr) in expand(graph, ctx, v, rel.direction, rel.label.as_ref()) {
                if !seen_next[nbr as usize] {
                    seen_next[nbr as usize] = true;
                    next.push(nbr);
                }
            }
        }
        if depth >= q.min && q.max.is_none_or(|m| depth <= m) {
            for &v in &next {
                add(v, &mut result, &mut in_result);
            }
        }
        frontier = next;
        depth += 1;
    }
    result
}

/// Walk the remaining segments of `pattern` from `from`, emitting each complete
/// binding via `emit`. Returns `false` to propagate a consumer's stop request.
fn walk_segments(
    graph: &Graph,
    ctx: &Ctx,
    pattern: &CPath,
    index: usize,
    from: u32,
    binding: &mut Binding,
    emit: &mut dyn FnMut(&mut Binding) -> bool,
) -> bool {
    if index >= pattern.segments.len() {
        return emit(binding);
    }
    let CSegment { rel, node } = &pattern.segments[index];
    if let Some(q) = rel.quantifier {
        // Var-length: edge variable / per-edge predicate not bound (known simplification).
        for end in reachable(graph, ctx, from, rel, q) {
            let stop = !match_node_then(graph, ctx, binding, node, end, &mut |b| {
                walk_segments(graph, ctx, pattern, index + 1, end, b, emit)
            });
            if stop {
                return false;
            }
        }
        return true;
    }
    for (eidx, nbr) in expand(graph, ctx, from, rel.direction, rel.label.as_ref()) {
        let Some(did_set) = bind_slot(binding, rel.var_slot, &Val::Edge(eidx)) else {
            continue; // join conflict on the edge variable
        };
        let ok = satisfies(graph, ctx, &Val::Edge(eidx), &rel.props, rel.where_.as_ref(), binding);
        let keep = if ok {
            match_node_then(graph, ctx, binding, node, nbr, &mut |b| {
                walk_segments(graph, ctx, pattern, index + 1, nbr, b, emit)
            })
        } else {
            true
        };
        if did_set {
            binding.unset(rel.var_slot.unwrap());
        }
        if !keep {
            return false;
        }
    }
    true
}

/// Seed and match a single path pattern, emitting each binding via `emit`.
fn visit_pattern(
    graph: &Graph,
    ctx: &Ctx,
    pattern: &CPath,
    binding: &mut Binding,
    emit: &mut dyn FnMut(&mut Binding) -> bool,
) -> bool {
    let mut at_seed = |seed: u32, binding: &mut Binding| {
        match_node_then(graph, ctx, binding, &pattern.start, seed, &mut |b| {
            walk_segments(graph, ctx, pattern, 0, seed, b, emit)
        })
    };
    // An already-bound start variable fixes the single seed; otherwise iterate
    // the label bucket / live vertices directly (no materialized seed list).
    match pattern.start.var_slot {
        Some(s) if binding.bound(s) => match binding.get(s) {
            Some(Val::Node(i)) => at_seed(*i, binding),
            _ => true,
        },
        _ => for_each_seed(graph, ctx, pattern.start.label.as_ref(), &mut |seed| at_seed(seed, binding)),
    }
}

/// Extend a binding through every pattern (nested), filter by an optional WHERE,
/// and emit each surviving binding. Returns `false` if `emit` asked to stop.
fn visit_patterns(
    graph: &Graph,
    ctx: &Ctx,
    patterns: &[CPath],
    idx: usize,
    where_: Option<&CExpr>,
    binding: &mut Binding,
    emit: &mut dyn FnMut(&mut Binding) -> bool,
) -> bool {
    if idx >= patterns.len() {
        if let Some(w) = where_ {
            let env = Env::new(graph, ctx, binding);
            if as_truth(&eval(&env, w)) != Some(true) {
                return true; // filtered out, keep going
            }
        }
        return emit(binding);
    }
    visit_pattern(graph, ctx, &patterns[idx], binding, &mut |b| {
        visit_patterns(graph, ctx, patterns, idx + 1, where_, b, emit)
    })
}

/// Does the (correlated) sub-pattern have at least one match? Short-circuits.
/// The work binding is the outer binding grown to the sub-scope (`sub_len`):
/// outer slots stay set (correlation), the sub's own slots start unbound.
fn any_match(
    graph: &Graph,
    ctx: &Ctx,
    patterns: &[CPath],
    where_: Option<&CExpr>,
    binding: &Binding,
    sub_len: usize,
) -> bool {
    let mut found = false;
    let mut work = binding.clone();
    work.resize(sub_len);
    visit_patterns(graph, ctx, patterns, 0, where_, &mut work, &mut |_| {
        found = true;
        false
    });
    found
}

/// Count matches of the (correlated) sub-pattern.
fn count_matches(
    graph: &Graph,
    ctx: &Ctx,
    patterns: &[CPath],
    where_: Option<&CExpr>,
    binding: &Binding,
    sub_len: usize,
) -> u64 {
    let mut count = 0u64;
    let mut work = binding.clone();
    work.resize(sub_len);
    visit_patterns(graph, ctx, patterns, 0, where_, &mut work, &mut |_| {
        count += 1;
        true
    });
    count
}

/// Slots a pattern set introduces (for OPTIONAL MATCH null-binding).
fn pattern_slots(patterns: &[CPath]) -> Vec<usize> {
    let mut slots = Vec::new();
    let mut push = |s: Option<usize>| {
        if let Some(s) = s {
            slots.push(s);
        }
    };
    for p in patterns {
        push(p.start.var_slot);
        for CSegment { rel, node } in &p.segments {
            push(rel.var_slot);
            push(node.var_slot);
        }
    }
    slots
}

/// Stream every binding produced by a chain of MATCH clauses (extending `binding`
/// in place, backtracking) into `sink`. No intermediate `Vec<Binding>`: matches
/// nest directly into the consumer. Returns `false` to propagate a stop request.
fn drive_matches(
    graph: &Graph,
    ctx: &Ctx,
    matches: &[&CClause],
    idx: usize,
    binding: &mut Binding,
    sink: &mut dyn FnMut(&Binding) -> bool,
) -> bool {
    let Some(clause) = matches.get(idx) else {
        return sink(binding);
    };
    let CClause::Match { optional, patterns, where_, scope_len } = clause else {
        return true; // only MATCH clauses are streamed
    };
    binding.resize(*scope_len);
    let mut matched = false;
    let cont = visit_patterns(graph, ctx, patterns, 0, where_.as_ref(), binding, &mut |b| {
        matched = true;
        drive_matches(graph, ctx, matches, idx + 1, b, sink)
    });
    if !cont {
        return false;
    }
    if !matched && *optional {
        // OPTIONAL with no match: null-fill this clause's slots and continue.
        for s in pattern_slots(patterns) {
            if !binding.bound(s) {
                binding.set(s, Val::Null);
            }
        }
        return drive_matches(graph, ctx, matches, idx + 1, binding, sink);
    }
    true
}

/// An aggregate's running state, folded one value at a time (no stored group).
struct Agg {
    func: AggFn,
    star: bool,
    distinct: bool,
    n: u64,
    sum: f64,
    extreme: Option<Val>,
    list: Vec<Val>,
    seen: HashSet<String>,
}

impl Agg {
    fn new(spec: &super::plan::CAgg) -> Self {
        Agg {
            func: spec.func,
            star: spec.star,
            distinct: spec.distinct,
            n: 0,
            sum: 0.0,
            extreme: None,
            list: Vec::new(),
            seen: HashSet::new(),
        }
    }
    fn step(&mut self, value: Option<Val>) {
        if self.func == AggFn::Count && self.star {
            self.n += 1; // count(*) counts rows
            return;
        }
        let Some(val) = value else { return };
        if is_nullish(&val) {
            return;
        }
        if self.distinct {
            let mut k = String::new();
            val_key(&val, &mut k);
            if !self.seen.insert(k) {
                return;
            }
        }
        match self.func {
            AggFn::Count => self.n += 1,
            AggFn::Sum => self.sum += num_of(&val).unwrap_or(f64::NAN),
            AggFn::Avg => {
                self.sum += num_of(&val).unwrap_or(f64::NAN);
                self.n += 1;
            }
            AggFn::Min => {
                if self.extreme.as_ref().is_none_or(|m| val_cmp(&val, m) == Some(Ordering::Less)) {
                    self.extreme = Some(val);
                }
            }
            AggFn::Max => {
                if self.extreme.as_ref().is_none_or(|m| val_cmp(&val, m) == Some(Ordering::Greater)) {
                    self.extreme = Some(val);
                }
            }
            AggFn::CollectList => self.list.push(val),
        }
    }
    fn finish(self) -> Val {
        match self.func {
            AggFn::Count => Val::Num(self.n as f64),
            AggFn::Sum => Val::Num(self.sum),
            AggFn::Avg => {
                if self.n == 0 {
                    Val::Null
                } else {
                    Val::Num(self.sum / self.n as f64)
                }
            }
            AggFn::Min | AggFn::Max => self.extreme.unwrap_or(Val::Null),
            AggFn::CollectList => Val::List(self.list),
        }
    }
}

/// Fold one input binding into a group's aggregate states (one per extracted
/// aggregate), evaluating each aggregate's argument against the binding.
fn step_aggs(aggs: &mut [Agg], specs: &[super::plan::CAgg], graph: &Graph, ctx: &Ctx, binding: &Binding) {
    for (agg, spec) in aggs.iter_mut().zip(specs) {
        let v = spec.arg.as_ref().map(|a| eval(&Env::new(graph, ctx, binding), a));
        agg.step(v);
    }
}

/// A streaming projection: accepts bindings one at a time (folding aggregates
/// incrementally; never storing the full input), then `finish`es to result rows.
struct ProjAccum<'p> {
    proj: &'p CProjection,
    /// Whether grouping keys exist (some non-aggregate item). When false but
    /// aggregating, it's a single global group (no map, no key string).
    grouped: bool,
    /// Top-k mode: `ORDER BY … LIMIT n` whose keys don't reference output, so we
    /// keep only the top-k *input* bindings (sort keys computed without
    /// projecting) and project just those at finish. `cap` = skip+limit.
    topk: bool,
    cap: usize,
    /// Top-k: the worst (largest) kept sort key once at capacity — a new row not
    /// better than this can't make the top-k, so it's skipped without cloning.
    threshold: Option<Vec<Val>>,
    /// Reused scratch binding for computing a top-k sort key (no per-row alloc).
    sort_scratch: Binding,
    /// Non-aggregating: projected rows (+ ORDER BY keys); in top-k mode, instead
    /// the kept *input* bindings (+ keys) until `finish` projects them.
    rows: Vec<(Binding, Vec<Val>)>,
    /// Global aggregate (no group keys): one running accumulator set.
    global: Option<(Binding, Vec<Agg>)>,
    /// Grouped aggregate: group key -> (rep binding, agg states), first-seen order.
    group_order: Vec<String>,
    groups: HashMap<String, (Binding, Vec<Agg>)>,
    distinct_seen: HashSet<String>,
    /// Reused scratch for building a group key (no per-row String alloc on hits).
    key_buf: String,
}

impl<'p> ProjAccum<'p> {
    fn new(proj: &'p CProjection) -> Self {
        let topk = !proj.aggregating
            && !proj.order_by.is_empty()
            && proj.limit.is_some()
            && !proj.distinct
            && !proj.order_needs_output;
        ProjAccum {
            proj,
            grouped: proj.aggregating && proj.items.iter().any(|i| !i.is_agg),
            topk,
            cap: proj.skip.unwrap_or(0) + proj.limit.unwrap_or(0),
            threshold: None,
            sort_scratch: Binding::default(),
            rows: Vec::new(),
            global: None,
            group_order: Vec::new(),
            groups: HashMap::new(),
            distinct_seen: HashSet::new(),
            key_buf: String::new(),
        }
    }

    fn project_row(&self, graph: &Graph, ctx: &Ctx, input: &Binding, agg_values: Option<&[Val]>) -> Binding {
        let proj = self.proj;
        let mut out = Binding(vec![None; proj.out_len]);
        if proj.star {
            for (i, &islot) in proj.star_cols.iter().enumerate() {
                if let Some(v) = input.get(islot) {
                    out.0[i] = Some(v.clone());
                }
            }
        } else {
            let env = Env { graph, ctx, binding: input, group: None, agg_values };
            for (i, item) in proj.items.iter().enumerate() {
                out.0[i] = Some(eval(&env, &item.expr));
            }
        }
        out
    }

    fn sort_keys(&self, graph: &Graph, ctx: &Ctx, input: &Binding, projected: &Binding, agg_values: Option<&[Val]>) -> Vec<Val> {
        let proj = self.proj;
        if proj.order_by.is_empty() {
            return Vec::new();
        }
        let mut sort_binding = projected.clone();
        for &islot in &proj.order_overlay {
            sort_binding.0.push(input.get(islot).cloned());
        }
        let env = Env { graph, ctx, binding: &sort_binding, group: None, agg_values };
        proj.order_by.iter().map(|s| eval(&env, &s.expr)).collect()
    }

    /// Accept one input binding. Returns `false` to request a stop (streamable
    /// LIMIT: non-aggregating, no ORDER BY, enough rows collected).
    fn accept(&mut self, graph: &Graph, ctx: &Ctx, binding: &Binding) -> bool {
        let proj = self.proj;
        if self.topk {
            // Sort key from the input alone (output slots absent + input overlay),
            // built into the reused scratch binding (no per-row alloc).
            self.sort_scratch.0.clear();
            self.sort_scratch.0.resize(proj.out_len, None);
            for &islot in &proj.order_overlay {
                let v = binding.get(islot).cloned();
                self.sort_scratch.0.push(v);
            }
            let keys: Vec<Val> = {
                let env = Env { graph, ctx, binding: &self.sort_scratch, group: None, agg_values: None };
                proj.order_by.iter().map(|s| eval(&env, &s.expr)).collect()
            };
            // Once at capacity, skip (no clone) anything not better than the worst kept.
            if let Some(th) = &self.threshold {
                if cmp_keys(&keys, th, &proj.order_by) != Ordering::Less {
                    return true;
                }
            }
            self.rows.push((binding.clone(), keys));
            if self.cap >= 1 && self.rows.len() >= self.cap * 2 {
                let cap = self.cap;
                self.rows.select_nth_unstable_by(cap - 1, |a, b| cmp_keyed(a, b, &proj.order_by));
                self.rows.truncate(cap);
                self.threshold = Some(self.rows[cap - 1].1.clone());
            }
            return true;
        }
        if proj.aggregating {
            if !self.grouped {
                // Global aggregate: one accumulator set, no key/map per row.
                let entry = self
                    .global
                    .get_or_insert_with(|| (binding.clone(), proj.aggs.iter().map(Agg::new).collect()));
                step_aggs(&mut entry.1, &proj.aggs, graph, ctx, binding);
                return true;
            }
            // Build the group key into the reused buffer.
            self.key_buf.clear();
            {
                let env = Env::new(graph, ctx, binding);
                for item in proj.items.iter().filter(|i| !i.is_agg) {
                    val_key(&eval(&env, &item.expr), &mut self.key_buf);
                    self.key_buf.push('\u{1}');
                }
            }
            // One hash on the group-hit path (the common case): get_mut by &str,
            // and only a brand-new group clones the key + allocates accumulators.
            match self.groups.get_mut(self.key_buf.as_str()) {
                Some(entry) => step_aggs(&mut entry.1, &proj.aggs, graph, ctx, binding),
                None => {
                    self.group_order.push(self.key_buf.clone());
                    let mut aggs: Vec<Agg> = proj.aggs.iter().map(Agg::new).collect();
                    step_aggs(&mut aggs, &proj.aggs, graph, ctx, binding);
                    self.groups.insert(self.key_buf.clone(), (binding.clone(), aggs));
                }
            }
            return true;
        }
        // Non-aggregating: project the row now (no full-binding clone retained).
        let projected = self.project_row(graph, ctx, binding, None);
        if proj.distinct && !self.distinct_seen.insert(row_key(&projected)) {
            return true;
        }
        let keys = self.sort_keys(graph, ctx, binding, &projected, None);
        self.rows.push((projected, keys));
        // Streamable LIMIT: with no ORDER BY, match order is result order.
        if proj.order_by.is_empty() {
            if let Some(limit) = proj.limit {
                if self.rows.len() >= proj.skip.unwrap_or(0) + limit {
                    return false;
                }
            }
        }
        true
    }

    fn finish(mut self, graph: &Graph, ctx: &Ctx) -> Vec<Binding> {
        let proj = self.proj;
        if proj.aggregating {
            if !self.grouped {
                // Global aggregate always emits exactly one row (0/null over no input).
                let (rep, aggs) = self
                    .global
                    .take()
                    .unwrap_or_else(|| (Binding::default(), proj.aggs.iter().map(Agg::new).collect()));
                let agg_values: Vec<Val> = aggs.into_iter().map(Agg::finish).collect();
                let projected = self.project_row(graph, ctx, &rep, Some(&agg_values));
                let keys = self.sort_keys(graph, ctx, &rep, &projected, Some(&agg_values));
                self.rows.push((projected, keys));
            } else {
                for key in &self.group_order {
                    let (rep, aggs) = self.groups.remove(key).unwrap();
                    let agg_values: Vec<Val> = aggs.into_iter().map(Agg::finish).collect();
                    let projected = self.project_row(graph, ctx, &rep, Some(&agg_values));
                    let keys = self.sort_keys(graph, ctx, &rep, &projected, Some(&agg_values));
                    self.rows.push((projected, keys));
                }
                if proj.distinct {
                    let mut seen = HashSet::new();
                    self.rows.retain(|(b, _)| seen.insert(row_key(b)));
                }
            }
        } else if self.topk {
            // Trim to the top-k input bindings, then project only those.
            if self.cap >= 1 && self.rows.len() > self.cap {
                let cap = self.cap;
                self.rows.select_nth_unstable_by(cap - 1, |a, b| cmp_keyed(a, b, &proj.order_by));
                self.rows.truncate(cap);
            }
            let buf = std::mem::take(&mut self.rows);
            self.rows = buf.into_iter().map(|(inb, keys)| (self.project_row(graph, ctx, &inb, None), keys)).collect();
        }
        if !proj.order_by.is_empty() {
            let cmp = |a: &(Binding, Vec<Val>), b: &(Binding, Vec<Val>)| cmp_keyed(a, b, &proj.order_by);
            // ORDER BY + LIMIT: partition the smallest `cap` with quickselect
            // (O(n)), then sort only those — instead of a full O(n log n) sort.
            let n = self.rows.len();
            if let Some(cap) = proj.limit.map(|l| proj.skip.unwrap_or(0) + l) {
                if cap >= 1 && cap < n {
                    self.rows.select_nth_unstable_by(cap - 1, cmp);
                    self.rows.truncate(cap);
                }
            }
            self.rows.sort_by(cmp);
        }
        let start = proj.skip.unwrap_or(0);
        let mut rows: Vec<Binding> = self.rows.into_iter().map(|(b, _)| b).skip(start).collect();
        if let Some(n) = proj.limit {
            rows.truncate(n);
        }
        rows
    }
}

/// Project the binding stream from `incoming × pending matches` (streamed) into
/// `proj`, returning result rows. The hot path: no intermediate `Vec<Binding>`.
fn project_matches(
    graph: &Graph,
    ctx: &Ctx,
    incoming: &[Binding],
    matches: &[&CClause],
    proj: &CProjection,
) -> Vec<Binding> {
    let mut acc = ProjAccum::new(proj);
    for inb in incoming {
        let mut work = inb.clone();
        let cont = drive_matches(graph, ctx, matches, 0, &mut work, &mut |b| acc.accept(graph, ctx, b));
        if !cont {
            break;
        }
    }
    acc.finish(graph, ctx)
}

/// Materialize the binding stream from `incoming × pending matches` (needed
/// before a write clause, which mutates per row).
fn materialize_matches(graph: &Graph, ctx: &Ctx, incoming: &[Binding], matches: &[&CClause]) -> Vec<Binding> {
    let mut out = Vec::new();
    for inb in incoming {
        let mut work = inb.clone();
        drive_matches(graph, ctx, matches, 0, &mut work, &mut |b| {
            out.push(b.clone());
            true
        });
    }
    out
}

// --- projection --------------------------------------------------------------

/// Compare two ORDER BY key vectors lexicographically (per-key direction/nulls).
fn cmp_keys(a: &[Val], b: &[Val], order: &[super::plan::CSortItem]) -> Ordering {
    for (i, s) in order.iter().enumerate() {
        let o = compare_sort(&a[i], &b[i], s.descending, s.nulls_first);
        if o != Ordering::Equal {
            return o;
        }
    }
    Ordering::Equal
}

/// Compare two keyed rows by their ORDER BY keys.
fn cmp_keyed(a: &(Binding, Vec<Val>), b: &(Binding, Vec<Val>), order: &[super::plan::CSortItem]) -> Ordering {
    cmp_keys(&a.1, &b.1, order)
}

/// Compare two ORDER BY keys, honoring direction and ISO NULLS FIRST/LAST.
fn compare_sort(a: &Val, b: &Val, descending: bool, nulls_first: Option<bool>) -> Ordering {
    let a_null = is_nullish(a);
    let b_null = is_nullish(b);
    if a_null && b_null {
        return Ordering::Equal;
    }
    if a_null || b_null {
        let first = nulls_first.unwrap_or(descending);
        return if a_null == first { Ordering::Less } else { Ordering::Greater };
    }
    let base = val_cmp(a, b).unwrap_or(Ordering::Equal);
    if descending {
        base.reverse()
    } else {
        base
    }
}

// --- linear query & set ops --------------------------------------------------

fn run_linear(linear: &CLinear, graph: &mut Graph, plan: &CQuery, params: &[Val]) -> Result<Vec<Binding>, String> {
    // `bindings` is the materialized row set at the last barrier; `pending` are
    // MATCH clauses deferred so a projection (or write) can stream them directly.
    let mut bindings: Vec<Binding> = vec![Binding::default()];
    let mut pending: Vec<&CClause> = Vec::new();
    // Refs (keys/labels) resolved to ids once; rebuilt after a write, since a
    // mutation may introduce a new key or label the rest of the query reads.
    let mut ctx = resolve_ctx(graph, plan, params);

    for clause in &linear.clauses {
        match clause {
            CClause::Match { .. } => pending.push(clause), // defer; consumed at a barrier
            CClause::With { projection, where_ } => {
                let projected = project_matches(graph, &ctx, &bindings, &pending, projection);
                pending.clear();
                bindings = match where_ {
                    None => projected,
                    Some(expr) => projected
                        .into_iter()
                        .filter(|b| as_truth(&eval(&Env::new(graph, &ctx, b), expr)) == Some(true))
                        .collect(),
                };
            }
            CClause::Return(proj) => {
                return Ok(project_matches(graph, &ctx, &bindings, &pending, proj));
            }
            CClause::Finish => return Ok(Vec::new()),
            // Mutations run eagerly, exactly once per binding. Flush deferred
            // matches first, then re-resolve refs against the mutated graph.
            CClause::Insert(patterns) => {
                if !pending.is_empty() {
                    bindings = materialize_matches(graph, &ctx, &bindings, &pending);
                    pending.clear();
                }
                bindings = bindings.iter().map(|b| run_insert(graph, &ctx, patterns, b)).collect();
                ctx = resolve_ctx(graph, plan, params);
            }
            CClause::Set(items) => {
                if !pending.is_empty() {
                    bindings = materialize_matches(graph, &ctx, &bindings, &pending);
                    pending.clear();
                }
                for b in &bindings {
                    run_set(graph, &ctx, items, b);
                }
                ctx = resolve_ctx(graph, plan, params);
            }
            CClause::Remove(items) => {
                if !pending.is_empty() {
                    bindings = materialize_matches(graph, &ctx, &bindings, &pending);
                    pending.clear();
                }
                for b in &bindings {
                    run_remove(graph, items, b);
                }
            }
            CClause::Delete { detach, targets } => {
                if !pending.is_empty() {
                    bindings = materialize_matches(graph, &ctx, &bindings, &pending);
                    pending.clear();
                }
                for b in &bindings {
                    run_delete(graph, &ctx, *detach, targets, b)?;
                }
            }
        }
    }
    Ok(Vec::new()) // write-only / no RETURN
}

// --- write execution ---------------------------------------------------------

/// Concrete labels a (lowered) label expression names, for element creation;
/// resolves each ref back to its name. `|`/`!`/`%` can't name a creatable set.
fn labels_of(expr: Option<&CLabelExpr>, names: &[String]) -> Vec<String> {
    match expr {
        Some(CLabelExpr::Label(r)) => vec![names[*r].clone()],
        Some(CLabelExpr::And(l, r)) => {
            let mut v = labels_of(Some(l), names);
            v.extend(labels_of(Some(r), names));
            v
        }
        _ => Vec::new(),
    }
}

/// Evaluate a pattern property map to concrete core `Value`s (for create/set).
fn eval_props(graph: &Graph, ctx: &Ctx, props: &[CPropConstraint], binding: &Binding) -> Vec<(String, Value)> {
    let env = Env::new(graph, ctx, binding);
    props.iter().map(|pc| (pc.key.clone(), val_to_value(graph, &eval(&env, &pc.value)))).collect()
}

/// Create a node from a pattern, reusing an already-bound variable.
fn ensure_node(graph: &mut Graph, ctx: &Ctx, binding: &mut Binding, node: &CNode) -> u32 {
    if let Some(slot) = node.var_slot {
        if let Some(Val::Node(vi)) = binding.get(slot) {
            return *vi;
        }
    }
    let labels = labels_of(node.label.as_ref(), ctx.label_names);
    let props = eval_props(graph, ctx, &node.props, binding);
    let vi = graph.add_vertex(&labels, props);
    if let Some(slot) = node.var_slot {
        binding.set(slot, Val::Node(vi));
    }
    vi
}

fn run_insert(graph: &mut Graph, ctx: &Ctx, patterns: &[CPath], binding: &Binding) -> Binding {
    let mut out = binding.clone();
    for pattern in patterns {
        let mut prev = ensure_node(graph, ctx, &mut out, &pattern.start);
        for CSegment { rel, node } in &pattern.segments {
            let next = ensure_node(graph, ctx, &mut out, node);
            let (from, to) = if rel.direction == Direction::In { (next, prev) } else { (prev, next) };
            let etype = labels_of(rel.label.as_ref(), ctx.label_names).into_iter().next().unwrap_or_default();
            let eprops = eval_props(graph, ctx, &rel.props, &out);
            let ei = graph.add_edge(from, to, &etype, eprops);
            if let Some(slot) = rel.var_slot {
                out.set(slot, Val::Edge(ei));
            }
            prev = next;
        }
    }
    out
}

fn run_set(graph: &mut Graph, ctx: &Ctx, items: &[CSetItem], binding: &Binding) {
    for item in items {
        match item {
            CSetItem::Prop { var_slot, key, value } => {
                let Some(el) = binding.get(*var_slot).cloned() else { continue };
                let v = {
                    let env = Env::new(graph, ctx, binding);
                    val_to_value(graph, &eval(&env, value))
                };
                match el {
                    Val::Node(vi) => graph.set_vertex_prop(vi, key, v),
                    Val::Edge(ei) => graph.set_edge_prop(ei, key, v),
                    _ => {}
                }
            }
            CSetItem::Label { var_slot, label } => match binding.get(*var_slot) {
                Some(Val::Node(vi)) => graph.add_vertex_label(*vi, label),
                Some(Val::Edge(ei)) => graph.add_edge_label(*ei, label),
                _ => {}
            },
        }
    }
}

fn run_remove(graph: &mut Graph, items: &[CRemoveItem], binding: &Binding) {
    for item in items {
        match item {
            CRemoveItem::Prop { var_slot, key } => match binding.get(*var_slot) {
                Some(Val::Node(vi)) => graph.remove_vertex_prop(*vi, key),
                Some(Val::Edge(ei)) => graph.remove_edge_prop(*ei, key),
                _ => {}
            },
            CRemoveItem::Label { var_slot, label } => match binding.get(*var_slot) {
                Some(Val::Node(vi)) => graph.remove_vertex_label(*vi, label),
                Some(Val::Edge(ei)) => graph.remove_edge_label(*ei, label),
                _ => {}
            },
        }
    }
}

fn run_delete(graph: &mut Graph, ctx: &Ctx, detach: bool, targets: &[CExpr], binding: &Binding) -> Result<(), String> {
    for target in targets {
        let v = {
            let env = Env::new(graph, ctx, binding);
            eval(&env, target)
        };
        match v {
            Val::Edge(ei) => graph.remove_edge(ei),
            Val::Node(vi) => graph.remove_vertex(vi, detach)?,
            _ => {}
        }
    }
    Ok(())
}

fn distinct_rows(rows: Vec<Binding>) -> Vec<Binding> {
    let mut seen = HashSet::new();
    rows.into_iter().filter(|r| seen.insert(row_key(r))).collect()
}

fn combine(op: SetOp, left: Vec<Binding>, right: Vec<Binding>) -> Vec<Binding> {
    let right_keys: HashSet<String> = right.iter().map(row_key).collect();
    match op.op {
        SetOpKind::Union => {
            let mut all = left;
            all.extend(right);
            if op.all {
                all
            } else {
                distinct_rows(all)
            }
        }
        SetOpKind::Except => {
            let kept: Vec<Binding> = left.into_iter().filter(|r| !right_keys.contains(&row_key(r))).collect();
            if op.all {
                kept
            } else {
                distinct_rows(kept)
            }
        }
        SetOpKind::Intersect => {
            let kept: Vec<Binding> = left.into_iter().filter(|r| right_keys.contains(&row_key(r))).collect();
            if op.all {
                kept
            } else {
                distinct_rows(kept)
            }
        }
    }
}

/// Output column names for a plan: the terminal RETURN projection's column names
/// (computed at lower time, including the `*` expansion).
fn output_columns(plan: &CQuery) -> Vec<String> {
    plan.parts
        .first()
        .and_then(|p| {
            p.clauses.iter().rev().find_map(|c| match c {
                CClause::Return(proj) => Some(proj.out_names.clone()),
                _ => None,
            })
        })
        .unwrap_or_default()
}

/// Execute a lowered plan against a graph with positional params. Final result
/// bindings are sized to the terminal projection, so output column `i` is slot `i`.
fn run_cquery(plan: &CQuery, graph: &mut Graph, params: &[Val]) -> Result<RowSet, String> {
    let first = plan.parts.first().ok_or("empty query")?;
    let mut rows = run_linear(first, graph, plan, params)?;
    for (i, op) in plan.ops.iter().enumerate() {
        let right = run_linear(&plan.parts[i + 1], graph, plan, params)?;
        rows = combine(*op, rows, right);
    }
    let cols = output_columns(plan);
    let out_rows: Vec<Vec<Value>> = rows
        .iter()
        .map(|b| (0..cols.len()).map(|i| b.get(i).map(|v| val_to_value(graph, v)).unwrap_or(Value::Null)).collect())
        .collect();
    Ok(RowSet { cols, rows: out_rows })
}

/// Bind named params into the plan's positional slot order.
fn positional(param_names: &[String], params: &Params) -> Vec<Val> {
    param_names.iter().map(|n| params.get(n).cloned().unwrap_or(Val::Null)).collect()
}

/// A prepared (lowered) query: compile once, execute many times with different
/// params against any graph. Parameters slot in positionally at execute time.
pub struct Prepared {
    plan: CQuery,
    /// param slot → name (the order positional args are bound in).
    param_names: Vec<String>,
}

impl Prepared {
    pub fn execute(&self, graph: &mut Graph, params: &Params) -> Result<RowSet, String> {
        run_cquery(&self.plan, graph, &positional(&self.param_names, params))
    }
}

/// Parse and lower a query into a reusable [`Prepared`] plan.
pub fn prepare(text: &str) -> Result<Prepared, SyntaxError> {
    let query = super::parse(text)?;
    let (plan, param_names) = lower(&query);
    Ok(Prepared { plan, param_names })
}

impl super::ast::Query {
    /// Lower and execute in one call (no plan reuse). Keeps the simple
    /// `parse(q)?.execute(graph, &params)` path; reuse a [`Prepared`] for speed.
    pub fn execute(&self, graph: &mut Graph, params: &Params) -> Result<RowSet, String> {
        let (plan, param_names) = lower(self);
        run_cquery(&plan, graph, &positional(&param_names, params))
    }
}
