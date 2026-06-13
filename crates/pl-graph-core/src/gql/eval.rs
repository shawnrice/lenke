//! Evaluator + executor — the semantic core, ported from TS `executor.ts` and
//! `graph-queries.ts`. A tree-walking interpreter (TS compiles to closures; the
//! same behavior, simpler in Rust). Pattern matching is eager nested loops over
//! the columnar adjacency; expressions use ISO three-valued (Kleene) logic.
//!
//! Columnar boundaries: edge properties read as NULL (the core stores none), and
//! write clauses error (the core is build-once immutable).

use std::collections::HashMap;
use std::fmt::Write as _;

use super::ast::*;
use crate::graph::{Graph, Value};
use crate::query::RowSet;

/// A runtime value. Extends the core [`Value`] with graph-element handles
/// (`Node`/`Edge` by dense index) so variables, identity (`a = b`), and
/// `element_id` work before projection flattens elements to their ids.
#[derive(Clone, Debug)]
pub enum Val {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Val>),
    Node(u32),
    Edge(u32),
}

/// One candidate solution: variables bound so far, in insertion order (so
/// `RETURN *` and row keys keep a stable column order, like the TS `Map`).
#[derive(Clone, Debug, Default)]
pub struct Binding(Vec<(String, Val)>);

impl Binding {
    fn get(&self, k: &str) -> Option<&Val> {
        self.0.iter().find(|(n, _)| n == k).map(|(_, v)| v)
    }
    fn has(&self, k: &str) -> bool {
        self.0.iter().any(|(n, _)| n == k)
    }
    fn set(&mut self, k: &str, v: Val) {
        if let Some(slot) = self.0.iter_mut().find(|(n, _)| n == k) {
            slot.1 = v;
        } else {
            self.0.push((k.to_string(), v));
        }
    }
    fn with(&self, k: &str, v: Val) -> Binding {
        let mut b = self.clone();
        b.set(k, v);
        b
    }
    fn iter(&self) -> impl Iterator<Item = &(String, Val)> {
        self.0.iter()
    }
}

pub type Params = HashMap<String, Val>;

/// The environment a compiled expression evaluates against.
struct Env<'a> {
    graph: &'a Graph,
    binding: &'a Binding,
    params: &'a Params,
    /// Set while folding an aggregate over its group of bindings.
    group: Option<&'a [Binding]>,
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
        Val::Str(s) => s.clone(),
        Val::Node(i) => graph.vid.text(*i).to_string(),
        Val::Edge(i) => format!("e{i}"),
        Val::List(items) => items.iter().map(|x| js_str(graph, x)).collect::<Vec<_>>().join(","),
    }
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
fn val_cmp(a: &Val, b: &Val) -> Option<std::cmp::Ordering> {
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
    for (k, v) in b.iter() {
        s.push_str(k);
        s.push('=');
        val_key(v, &mut s);
    }
    s
}

// --- property / label access -------------------------------------------------

fn value_to_val(v: &Value) -> Val {
    match v {
        Value::Null => Val::Null,
        Value::Bool(b) => Val::Bool(*b),
        Value::Num(n) => Val::Num(*n),
        Value::Str(s) => Val::Str(s.clone()),
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
        Val::Str(s) => Value::Str(s.clone()),
        Val::List(items) => Value::List(items.iter().map(|x| val_to_value(graph, x)).collect()),
        Val::Node(i) => Value::Str(graph.vid.text(*i).to_string()),
        Val::Edge(i) => Value::Str(format!("e{i}")),
    }
}

/// ISO: an absent property — or a property of a non-element/NULL — yields NULL.
/// Vertices and edges read from the same kind of columnar store (`props` vs
/// `edge_props`), so node and edge property access is one code path.
fn prop_of(graph: &Graph, bound: &Val, key: &str) -> Val {
    let (store, idx) = match bound {
        Val::Node(vi) => (&graph.props, *vi as usize),
        Val::Edge(ei) => (&graph.edge_props, *ei as usize),
        _ => return Val::Null,
    };
    value_to_val(&store.value(idx, key, &graph.strs))
}

fn eval_label_node(graph: &Graph, vi: u32, expr: &LabelExpr) -> bool {
    match expr {
        LabelExpr::Label(name) => graph.labels.get(name).is_some_and(|lid| graph.has_label(vi, lid)),
        LabelExpr::Wildcard => !graph.vertex_labels(vi).is_empty(),
        LabelExpr::Not(e) => !eval_label_node(graph, vi, e),
        LabelExpr::And(l, r) => eval_label_node(graph, vi, l) && eval_label_node(graph, vi, r),
        LabelExpr::Or(l, r) => eval_label_node(graph, vi, l) || eval_label_node(graph, vi, r),
    }
}

fn eval_label_edge(graph: &Graph, etype: u32, expr: &LabelExpr) -> bool {
    match expr {
        LabelExpr::Label(name) => graph.etype.get(name) == Some(etype),
        LabelExpr::Wildcard => true, // an edge always has exactly one type
        LabelExpr::Not(e) => !eval_label_edge(graph, etype, e),
        LabelExpr::And(l, r) => eval_label_edge(graph, etype, l) && eval_label_edge(graph, etype, r),
        LabelExpr::Or(l, r) => eval_label_edge(graph, etype, l) || eval_label_edge(graph, etype, r),
    }
}

/// `IS LABELED` over a runtime element value.
fn labels_match(graph: &Graph, el: &Val, expr: &LabelExpr) -> bool {
    match el {
        Val::Node(vi) => eval_label_node(graph, *vi, expr),
        Val::Edge(ei) => eval_label_edge(graph, graph.e_type[*ei as usize], expr),
        _ => false,
    }
}

fn matches_label(graph: &Graph, vi: u32, label: Option<&LabelExpr>) -> bool {
    label.is_none_or(|e| eval_label_node(graph, vi, e))
}

// --- expression evaluation ---------------------------------------------------

const AGGREGATES: &[&str] = &["count", "sum", "avg", "min", "max", "collect_list"];

fn has_aggregate(expr: &Expr) -> bool {
    match expr {
        Expr::Func { name, args, .. } => AGGREGATES.contains(&name.as_str()) || args.iter().any(has_aggregate),
        Expr::Neg(e) | Expr::Not(e) => has_aggregate(e),
        Expr::IsNull { expr, .. } | Expr::IsTruth { expr, .. } | Expr::IsLabeled { expr, .. } => {
            has_aggregate(expr)
        }
        Expr::Arith { left, right, .. }
        | Expr::Concat { left, right }
        | Expr::And(left, right)
        | Expr::Or(left, right)
        | Expr::Xor(left, right)
        | Expr::Compare { left, right, .. } => has_aggregate(left) || has_aggregate(right),
        Expr::In { expr, list, .. } => has_aggregate(expr) || has_aggregate(list),
        Expr::List(items) => items.iter().any(has_aggregate),
        Expr::Case { subject, whens, else_ } => {
            subject.as_deref().is_some_and(has_aggregate)
                || whens.iter().any(|(w, t)| has_aggregate(w) || has_aggregate(t))
                || else_.as_deref().is_some_and(has_aggregate)
        }
        _ => false,
    }
}

fn truth_to_val(t: Truth) -> Val {
    match t {
        Some(b) => Val::Bool(b),
        None => Val::Null,
    }
}

fn eval(env: &Env, expr: &Expr) -> Val {
    match expr {
        Expr::Lit(l) => match l {
            Lit::Null => Val::Null,
            Lit::Bool(b) => Val::Bool(*b),
            Lit::Num(n) => Val::Num(*n),
            Lit::Str(s) => Val::Str(s.clone()),
        },
        Expr::Var(name) => env.binding.get(name).cloned().unwrap_or(Val::Null),
        Expr::Param(name) => env.params.get(name).cloned().unwrap_or(Val::Null),
        Expr::Prop { variable, key } => {
            let bound = env.binding.get(variable).cloned().unwrap_or(Val::Null);
            prop_of(env.graph, &bound, key)
        }
        Expr::List(items) => Val::List(items.iter().map(|e| eval(env, e)).collect()),
        Expr::Neg(e) => match num_of(&eval(env, e)) {
            Some(n) => Val::Num(-n),
            None => Val::Null,
        },
        Expr::Arith { op, left, right } => {
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
        Expr::Concat { left, right } => {
            let lv = eval(env, left);
            let rv = eval(env, right);
            if is_nullish(&lv) || is_nullish(&rv) {
                Val::Null
            } else {
                Val::Str(js_str(env.graph, &lv) + &js_str(env.graph, &rv))
            }
        }
        Expr::Not(e) => truth_to_val(not3(as_truth(&eval(env, e)))),
        Expr::And(l, r) => truth_to_val(and3(as_truth(&eval(env, l)), as_truth(&eval(env, r)))),
        Expr::Or(l, r) => truth_to_val(or3(as_truth(&eval(env, l)), as_truth(&eval(env, r)))),
        Expr::Xor(l, r) => truth_to_val(xor3(as_truth(&eval(env, l)), as_truth(&eval(env, r)))),
        Expr::IsNull { expr, negated } => {
            let isnull = is_nullish(&eval(env, expr));
            Val::Bool(if *negated { !isnull } else { isnull })
        }
        Expr::IsTruth { expr, truth, negated } => {
            let m = as_truth(&eval(env, expr)) == *truth;
            Val::Bool(if *negated { !m } else { m })
        }
        Expr::IsLabeled { expr, label, negated } => {
            let el = eval(env, expr);
            let has = labels_match(env.graph, &el, label);
            Val::Bool(if *negated { !has } else { has })
        }
        Expr::In { expr, list, negated } => {
            let r = in_list(&eval(env, expr), &eval(env, list));
            truth_to_val(if *negated { not3(r) } else { r })
        }
        Expr::Compare { op, left, right } => {
            let lv = eval(env, left);
            let rv = eval(env, right);
            if is_nullish(&lv) || is_nullish(&rv) {
                return Val::Null; // UNKNOWN
            }
            let res = match op {
                CompareOp::Eq => val_eq(&lv, &rv),
                CompareOp::Ne => !val_eq(&lv, &rv),
                CompareOp::Lt => val_cmp(&lv, &rv) == Some(std::cmp::Ordering::Less),
                CompareOp::Gt => val_cmp(&lv, &rv) == Some(std::cmp::Ordering::Greater),
                CompareOp::Le => matches!(
                    val_cmp(&lv, &rv),
                    Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
                ),
                CompareOp::Ge => matches!(
                    val_cmp(&lv, &rv),
                    Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
                ),
            };
            Val::Bool(res)
        }
        Expr::Case { subject, whens, else_ } => {
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
        Expr::Exists { patterns, where_ } => {
            let ms = match_patterns(env.graph, patterns, where_.as_deref(), env.binding, env.params);
            Val::Bool(!ms.is_empty())
        }
        Expr::CountSubquery { patterns, where_ } => {
            let ms = match_patterns(env.graph, patterns, where_.as_deref(), env.binding, env.params);
            Val::Num(ms.len() as f64)
        }
        Expr::Func { name, args, distinct, star } => {
            if AGGREGATES.contains(&name.as_str()) {
                eval_aggregate(env, name, args.first(), *distinct, *star)
            } else {
                let vals: Vec<Val> = args.iter().map(|a| eval(env, a)).collect();
                call_scalar(env.graph, name, &vals)
            }
        }
    }
}

fn eval_aggregate(env: &Env, name: &str, arg: Option<&Expr>, distinct: bool, star: bool) -> Val {
    let single;
    let group: &[Binding] = match env.group {
        Some(g) => g,
        None => {
            single = [env.binding.clone()];
            &single
        }
    };
    if name == "count" && star {
        return Val::Num(group.len() as f64);
    }
    let arg = match arg {
        Some(a) => a,
        None => return Val::Null,
    };
    // Evaluate the argument over every binding in the group.
    let raw: Vec<Val> = group
        .iter()
        .map(|b| {
            let e = Env { graph: env.graph, binding: b, params: env.params, group: Some(group) };
            eval(&e, arg)
        })
        .collect();
    let mut values: Vec<Val> = raw.into_iter().filter(|v| !is_nullish(v)).collect();
    if distinct {
        let mut seen = std::collections::HashSet::new();
        values.retain(|v| {
            let mut k = String::new();
            val_key(v, &mut k);
            seen.insert(k)
        });
    }
    match name {
        "count" => Val::Num(values.len() as f64),
        "sum" => Val::Num(values.iter().filter_map(num_of_owned).sum()),
        "avg" => {
            if values.is_empty() {
                Val::Null
            } else {
                let s: f64 = values.iter().filter_map(num_of_owned).sum();
                Val::Num(s / values.len() as f64)
            }
        }
        "min" => fold_extreme(values, std::cmp::Ordering::Less),
        "max" => fold_extreme(values, std::cmp::Ordering::Greater),
        "collect_list" => Val::List(values),
        _ => Val::Null,
    }
}

fn num_of_owned(v: &Val) -> Option<f64> {
    num_of(v)
}

fn fold_extreme(values: Vec<Val>, want: std::cmp::Ordering) -> Val {
    let mut it = values.into_iter();
    let Some(mut acc) = it.next() else { return Val::Null };
    for v in it {
        if val_cmp(&v, &acc) == Some(want) {
            acc = v;
        }
    }
    acc
}

// --- scalar functions --------------------------------------------------------

fn call_scalar(graph: &Graph, name: &str, args: &[Val]) -> Val {
    let a = args.first();
    let b = args.get(1);
    let unary_num = |f: fn(f64) -> f64| match a {
        Some(v) if !is_nullish(v) => Val::Num(f(num_of(v).unwrap_or(f64::NAN))),
        _ => Val::Null,
    };
    match name {
        "abs" => return unary_num(f64::abs),
        "ceil" | "ceiling" => return unary_num(f64::ceil),
        "floor" => return unary_num(f64::floor),
        "sqrt" => return unary_num(f64::sqrt),
        "exp" => return unary_num(f64::exp),
        "ln" => return unary_num(f64::ln),
        "log10" => return unary_num(f64::log10),
        "sin" => return unary_num(f64::sin),
        "cos" => return unary_num(f64::cos),
        "tan" => return unary_num(f64::tan),
        "cot" => return unary_num(|n| 1.0 / n.tan()),
        "asin" => return unary_num(f64::asin),
        "acos" => return unary_num(f64::acos),
        "atan" => return unary_num(f64::atan),
        "sinh" => return unary_num(f64::sinh),
        "cosh" => return unary_num(f64::cosh),
        "tanh" => return unary_num(f64::tanh),
        "degrees" => return unary_num(f64::to_degrees),
        "radians" => return unary_num(f64::to_radians),
        _ => {}
    }
    let unary_str = |f: fn(&str) -> Val| match a {
        Some(v) if !is_nullish(v) => f(&js_str(graph, v)),
        _ => Val::Null,
    };
    match name {
        "upper" => return unary_str(|s| Val::Str(s.to_uppercase())),
        "lower" => return unary_str(|s| Val::Str(s.to_lowercase())),
        "trim" | "btrim" => return unary_str(|s| Val::Str(s.trim().to_string())),
        "ltrim" => return unary_str(|s| Val::Str(s.trim_start().to_string())),
        "rtrim" => return unary_str(|s| Val::Str(s.trim_end().to_string())),
        "char_length" | "character_length" => return unary_str(|s| Val::Num(s.chars().count() as f64)),
        _ => {}
    }
    let binary_num = |f: fn(f64, f64) -> f64| match (a, b) {
        (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
            Val::Num(f(num_of(x).unwrap_or(f64::NAN), num_of(y).unwrap_or(f64::NAN)))
        }
        _ => Val::Null,
    };
    match name {
        "power" => return binary_num(|x, y| x.powf(y)),
        "mod" => return binary_num(|x, y| x % y),
        "log" => return binary_num(|base, value| value.ln() / base.ln()),
        _ => {}
    }
    match name {
        "size" | "length" => match a {
            Some(Val::List(items)) => Val::Num(items.len() as f64),
            Some(Val::Str(s)) => Val::Num(s.chars().count() as f64),
            _ => Val::Null,
        },
        "left" => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s = js_str(graph, x);
                let n = num_of(y).unwrap_or(0.0).max(0.0) as usize;
                Val::Str(s.chars().take(n).collect())
            }
            _ => Val::Null,
        },
        "right" => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s: Vec<char> = js_str(graph, x).chars().collect();
                let n = num_of(y).unwrap_or(0.0);
                if n <= 0.0 {
                    Val::Str(String::new())
                } else {
                    let n = (n as usize).min(s.len());
                    Val::Str(s[s.len() - n..].iter().collect())
                }
            }
            _ => Val::Null,
        },
        "coalesce" => args.iter().find(|x| !is_nullish(x)).cloned().unwrap_or(Val::Null),
        "nullif" => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) && val_eq(x, y) => Val::Null,
            (Some(x), _) => x.clone(),
            _ => Val::Null,
        },
        "element_id" => match a {
            Some(Val::Node(i)) => Val::Str(graph.vid.text(*i).to_string()),
            Some(Val::Edge(i)) => Val::Str(format!("e{i}")),
            _ => Val::Null,
        },
        _ => Val::Null, // unknown function → null (TS throws; we stay total)
    }
}

// --- pattern matching --------------------------------------------------------

fn consistent(binding: &Binding, name: Option<&str>, value: &Val) -> bool {
    match name {
        None => true,
        Some(n) => match binding.get(n) {
            None => true,
            Some(existing) => val_eq(existing, value),
        },
    }
}

fn with_opt(binding: &Binding, name: Option<&str>, value: Val) -> Binding {
    match name {
        None => binding.clone(),
        Some(n) => binding.with(n, value),
    }
}

fn satisfies(
    graph: &Graph,
    element: &Val,
    props: &[PropertyConstraint],
    where_: Option<&Expr>,
    binding: &Binding,
    params: &Params,
) -> bool {
    let env = Env { graph, binding, params, group: None };
    for pc in props {
        if !val_eq(&prop_of(graph, element, &pc.key), &eval(&env, &pc.value)) {
            return false;
        }
    }
    where_.is_none_or(|w| as_truth(&eval(&env, w)) == Some(true))
}

fn seed_label(expr: &LabelExpr) -> Option<&str> {
    match expr {
        LabelExpr::Label(name) => Some(name),
        LabelExpr::And(l, r) => seed_label(l).or_else(|| seed_label(r)),
        _ => None,
    }
}

fn candidate_vertices(graph: &Graph, label: Option<&LabelExpr>) -> Vec<u32> {
    match label.and_then(seed_label) {
        Some(name) => match graph.labels.get(name) {
            Some(lid) => graph.vertices_with_label(lid).to_vec(),
            None => Vec::new(),
        },
        None => graph.vertex_indices().collect(),
    }
}

/// Expand one segment from `v`: `(edge index, neighbor)` per the direction and
/// edge-type label expression.
fn expand(graph: &Graph, v: u32, direction: Direction, label: Option<&LabelExpr>) -> Vec<(u32, u32)> {
    let ok = |etype: u32| label.is_none_or(|e| eval_label_edge(graph, etype, e));
    let mut out = Vec::new();
    if matches!(direction, Direction::Out | Direction::Both) {
        for a in graph.out_adj(v) {
            if ok(a.etype) {
                out.push((a.eidx, a.nbr));
            }
        }
    }
    if matches!(direction, Direction::In | Direction::Both) {
        for a in graph.in_adj(v) {
            if ok(a.etype) {
                out.push((a.eidx, a.nbr));
            }
        }
    }
    out
}

fn match_node(graph: &Graph, binding: &Binding, node: &NodePattern, vi: u32, params: &Params) -> Option<Binding> {
    if !matches_label(graph, vi, node.label.as_ref()) {
        return None;
    }
    let val = Val::Node(vi);
    if !consistent(binding, node.variable.as_deref(), &val) {
        return None;
    }
    let bound = with_opt(binding, node.variable.as_deref(), val);
    if !satisfies(graph, &Val::Node(vi), &node.props, node.where_.as_ref(), &bound, params) {
        return None;
    }
    Some(bound)
}

/// Vertices reachable from `from` in [min, max] hops of `rel` (var-length).
fn reachable(graph: &Graph, from: u32, rel: &RelPattern, q: Quantifier) -> Vec<u32> {
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
            for (_, nbr) in expand(graph, v, rel.direction, rel.label.as_ref()) {
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

fn walk_segments(
    graph: &Graph,
    pattern: &PathPattern,
    index: usize,
    from: u32,
    binding: &Binding,
    params: &Params,
    out: &mut Vec<Binding>,
) {
    if index >= pattern.segments.len() {
        out.push(binding.clone());
        return;
    }
    let Segment { rel, node } = &pattern.segments[index];
    if let Some(q) = rel.quantifier {
        // Var-length: edge variable / per-edge predicate not bound (known simplification).
        for end in reachable(graph, from, rel, q) {
            if let Some(m) = match_node(graph, binding, node, end, params) {
                walk_segments(graph, pattern, index + 1, end, &m, params, out);
            }
        }
        return;
    }
    for (eidx, nbr) in expand(graph, from, rel.direction, rel.label.as_ref()) {
        let edge = Val::Edge(eidx);
        if !consistent(binding, rel.variable.as_deref(), &edge) {
            continue;
        }
        let with_edge = with_opt(binding, rel.variable.as_deref(), edge);
        if !satisfies(graph, &Val::Edge(eidx), &rel.props, rel.where_.as_ref(), &with_edge, params) {
            continue;
        }
        if let Some(m) = match_node(graph, &with_edge, node, nbr, params) {
            walk_segments(graph, pattern, index + 1, nbr, &m, params, out);
        }
    }
}

fn match_pattern(graph: &Graph, pattern: &PathPattern, binding: &Binding, params: &Params) -> Vec<Binding> {
    let seeds: Vec<u32> = match pattern.start.variable.as_deref() {
        Some(v) if binding.has(v) => match binding.get(v) {
            Some(Val::Node(i)) => vec![*i],
            _ => vec![],
        },
        _ => candidate_vertices(graph, pattern.start.label.as_ref()),
    };
    let mut out = Vec::new();
    for seed in seeds {
        if let Some(seeded) = match_node(graph, binding, &pattern.start, seed, params) {
            walk_segments(graph, pattern, 0, seed, &seeded, params, &mut out);
        }
    }
    out
}

/// Extend a binding through every pattern, then filter by an optional WHERE.
fn match_patterns(
    graph: &Graph,
    patterns: &[PathPattern],
    where_: Option<&Expr>,
    binding: &Binding,
    params: &Params,
) -> Vec<Binding> {
    let mut stream = vec![binding.clone()];
    for pattern in patterns {
        let mut next = Vec::new();
        for b in &stream {
            next.extend(match_pattern(graph, pattern, b, params));
        }
        stream = next;
    }
    match where_ {
        None => stream,
        Some(w) => stream
            .into_iter()
            .filter(|b| {
                let env = Env { graph, binding: b, params, group: None };
                as_truth(&eval(&env, w)) == Some(true)
            })
            .collect(),
    }
}

/// Variables a pattern introduces (for OPTIONAL MATCH null-binding).
fn pattern_vars(patterns: &[PathPattern]) -> Vec<String> {
    let mut vars = Vec::new();
    for p in patterns {
        if let Some(v) = &p.start.variable {
            vars.push(v.clone());
        }
        for Segment { rel, node } in &p.segments {
            if let Some(v) = &rel.variable {
                vars.push(v.clone());
            }
            if let Some(v) = &node.variable {
                vars.push(v.clone());
            }
        }
    }
    vars
}

fn run_match(graph: &Graph, clause: &MatchClause, bindings: Vec<Binding>, params: &Params) -> Vec<Binding> {
    let mut out = Vec::new();
    for b in &bindings {
        let matched = match_patterns(graph, &clause.patterns, clause.where_.as_ref(), b, params);
        if matched.is_empty() && clause.optional {
            let mut filled = b.clone();
            for v in pattern_vars(&clause.patterns) {
                if !filled.has(&v) {
                    filled.set(&v, Val::Null);
                }
            }
            out.push(filled);
        } else {
            out.extend(matched);
        }
    }
    out
}

// --- projection --------------------------------------------------------------

fn column_name(expr: &Expr) -> String {
    match expr {
        Expr::Var(name) => name.clone(),
        Expr::Prop { variable, key } => format!("{variable}.{key}"),
        _ => "expr".to_string(),
    }
}

fn item_name(item: &ReturnItem) -> String {
    item.alias.clone().unwrap_or_else(|| column_name(&item.expr))
}

/// Compare two ORDER BY keys, honoring direction and ISO NULLS FIRST/LAST.
fn compare_sort(a: &Val, b: &Val, descending: bool, nulls_first: Option<bool>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
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

fn apply_projection(proj: &Projection, bindings: Vec<Binding>, params: &Params, graph: &Graph) -> Vec<Binding> {
    let order_n = proj.order_by.len();
    let item_names: Vec<String> = proj.items.iter().map(item_name).collect();
    let is_agg: Vec<bool> = proj.items.iter().map(|i| has_aggregate(&i.expr)).collect();
    let aggregating = !proj.star && is_agg.iter().any(|&a| a);

    // (projected binding, sort keys)
    let mut keyed: Vec<(Binding, Vec<Val>)> = Vec::new();

    let project_one = |rep: &Binding, group: Option<&[Binding]>| -> Binding {
        if proj.star {
            return rep.clone();
        }
        let env = Env { graph, binding: rep, params, group };
        let mut out = Binding::default();
        for (item, name) in proj.items.iter().zip(&item_names) {
            out.set(name, eval(&env, &item.expr));
        }
        out
    };
    let sort_keys = |input: &Binding, projected: &Binding, group: Option<&[Binding]>| -> Vec<Val> {
        if order_n == 0 {
            return Vec::new();
        }
        // ORDER BY sees output columns overlaid on input variables.
        let mut overlay = input.clone();
        for (k, v) in projected.iter() {
            overlay.set(k, v.clone());
        }
        let env = Env { graph, binding: &overlay, params, group };
        proj.order_by.iter().map(|s| eval(&env, &s.expr)).collect()
    };

    if aggregating {
        let group_key_exprs: Vec<&Expr> = proj
            .items
            .iter()
            .zip(&is_agg)
            .filter(|(_, &agg)| !agg)
            .map(|(i, _)| &i.expr)
            .collect();
        let mut order_keys: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Vec<Binding>> = HashMap::new();
        for b in bindings {
            let env = Env { graph, binding: &b, params, group: None };
            let mut key = String::new();
            for e in &group_key_exprs {
                val_key(&eval(&env, e), &mut key);
                key.push('\u{1}');
            }
            if !groups.contains_key(&key) {
                order_keys.push(key.clone());
                groups.insert(key.clone(), Vec::new());
            }
            groups.get_mut(&key).unwrap().push(b);
        }
        // No rows but a global aggregate (no group keys) → one empty group.
        if groups.is_empty() && group_key_exprs.is_empty() {
            order_keys.push(String::new());
            groups.insert(String::new(), Vec::new());
        }
        for key in &order_keys {
            let group = &groups[key];
            let rep = group.first().cloned().unwrap_or_default();
            let projected = project_one(&rep, Some(group));
            let keys = sort_keys(&rep, &projected, Some(group));
            keyed.push((projected, keys));
        }
    } else {
        for b in bindings {
            let projected = project_one(&b, None);
            let keys = sort_keys(&b, &projected, None);
            keyed.push((projected, keys));
        }
    }

    if proj.distinct {
        let mut seen = std::collections::HashSet::new();
        keyed.retain(|(b, _)| seen.insert(row_key(b)));
    }

    if order_n > 0 {
        keyed.sort_by(|a, b| {
            for (i, s) in proj.order_by.iter().enumerate() {
                let o = compare_sort(&a.1[i], &b.1[i], s.descending, s.nulls_first);
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
            }
            std::cmp::Ordering::Equal
        });
    }

    let start = proj.skip.unwrap_or(0);
    let mut rows: Vec<Binding> = keyed.into_iter().map(|(b, _)| b).skip(start).collect();
    if let Some(n) = proj.limit {
        rows.truncate(n);
    }
    rows
}

// --- linear query & set ops --------------------------------------------------

fn run_linear(linear: &LinearQuery, graph: &mut Graph, params: &Params) -> Result<Vec<Binding>, String> {
    let mut bindings: Vec<Binding> = vec![Binding::default()];
    for clause in &linear.clauses {
        match clause {
            Clause::Match(m) => {
                bindings = run_match(graph, m, bindings, params);
            }
            Clause::With(w) => {
                let projected = apply_projection(&w.projection, bindings, params, graph);
                bindings = match &w.where_ {
                    None => projected,
                    Some(expr) => projected
                        .into_iter()
                        .filter(|b| {
                            let env = Env { graph, binding: b, params, group: None };
                            as_truth(&eval(&env, expr)) == Some(true)
                        })
                        .collect(),
                };
            }
            Clause::Return(proj) => {
                return Ok(apply_projection(proj, bindings, params, graph));
            }
            Clause::Finish => return Ok(Vec::new()),
            // Mutations run eagerly, exactly once per binding.
            Clause::Insert(patterns) => {
                bindings = bindings.iter().map(|b| run_insert(graph, patterns, b, params)).collect();
            }
            Clause::Set(items) => {
                for b in &bindings {
                    run_set(graph, items, b, params);
                }
            }
            Clause::Remove(items) => {
                for b in &bindings {
                    run_remove(graph, items, b);
                }
            }
            Clause::Delete { detach, targets } => {
                for b in &bindings {
                    run_delete(graph, *detach, targets, b, params)?;
                }
            }
        }
    }
    Ok(Vec::new()) // write-only / no RETURN
}

// --- write execution ---------------------------------------------------------

/// Concrete labels a label expression names (for element creation). `|`/`!`/`%`
/// can't name a creatable label set, so they contribute nothing.
fn labels_of(expr: Option<&LabelExpr>) -> Vec<String> {
    match expr {
        Some(LabelExpr::Label(name)) => vec![name.clone()],
        Some(LabelExpr::And(l, r)) => {
            let mut v = labels_of(Some(l));
            v.extend(labels_of(Some(r)));
            v
        }
        _ => Vec::new(),
    }
}

/// Evaluate a pattern property map to concrete core `Value`s (for create/set).
fn eval_props(
    graph: &Graph,
    props: &[PropertyConstraint],
    binding: &Binding,
    params: &Params,
) -> Vec<(String, Value)> {
    let env = Env { graph, binding, params, group: None };
    props.iter().map(|pc| (pc.key.clone(), val_to_value(graph, &eval(&env, &pc.value)))).collect()
}

/// Create a node from a pattern, reusing an already-bound variable.
fn ensure_node(graph: &mut Graph, binding: &mut Binding, node: &NodePattern, params: &Params) -> u32 {
    if let Some(var) = &node.variable {
        if let Some(Val::Node(vi)) = binding.get(var) {
            return *vi;
        }
    }
    let labels = labels_of(node.label.as_ref());
    let props = eval_props(graph, &node.props, binding, params);
    let vi = graph.add_vertex(&labels, props);
    if let Some(var) = &node.variable {
        binding.set(var, Val::Node(vi));
    }
    vi
}

fn run_insert(graph: &mut Graph, patterns: &[PathPattern], binding: &Binding, params: &Params) -> Binding {
    let mut out = binding.clone();
    for pattern in patterns {
        let mut prev = ensure_node(graph, &mut out, &pattern.start, params);
        for Segment { rel, node } in &pattern.segments {
            let next = ensure_node(graph, &mut out, node, params);
            let (from, to) = if rel.direction == Direction::In { (next, prev) } else { (prev, next) };
            let etype = labels_of(rel.label.as_ref()).into_iter().next().unwrap_or_default();
            let eprops = eval_props(graph, &rel.props, &out, params);
            let ei = graph.add_edge(from, to, &etype, eprops);
            if let Some(var) = &rel.variable {
                out.set(var, Val::Edge(ei));
            }
            prev = next;
        }
    }
    out
}

fn run_set(graph: &mut Graph, items: &[SetItem], binding: &Binding, params: &Params) {
    for item in items {
        match item {
            SetItem::Prop { variable, key, value } => {
                let Some(el) = binding.get(variable).cloned() else { continue };
                // Evaluate the value first (immutable borrow), then mutate.
                let v = {
                    let env = Env { graph, binding, params, group: None };
                    val_to_value(graph, &eval(&env, value))
                };
                match el {
                    Val::Node(vi) => graph.set_vertex_prop(vi, key, v),
                    Val::Edge(ei) => graph.set_edge_prop(ei, key, v),
                    _ => {}
                }
            }
            SetItem::Label { variable, label } => match binding.get(variable) {
                Some(Val::Node(vi)) => graph.add_vertex_label(*vi, label),
                Some(Val::Edge(ei)) => graph.add_edge_label(*ei, label),
                _ => {}
            },
        }
    }
}

fn run_remove(graph: &mut Graph, items: &[RemoveItem], binding: &Binding) {
    for item in items {
        match item {
            RemoveItem::Prop { variable, key } => match binding.get(variable) {
                Some(Val::Node(vi)) => graph.remove_vertex_prop(*vi, key),
                Some(Val::Edge(ei)) => graph.remove_edge_prop(*ei, key),
                _ => {}
            },
            RemoveItem::Label { variable, label } => match binding.get(variable) {
                Some(Val::Node(vi)) => graph.remove_vertex_label(*vi, label),
                Some(Val::Edge(ei)) => graph.remove_edge_label(*ei, label),
                _ => {}
            },
        }
    }
}

fn run_delete(
    graph: &mut Graph,
    detach: bool,
    targets: &[Expr],
    binding: &Binding,
    params: &Params,
) -> Result<(), String> {
    for target in targets {
        let v = {
            let env = Env { graph, binding, params, group: None };
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
    let mut seen = std::collections::HashSet::new();
    rows.into_iter().filter(|r| seen.insert(row_key(r))).collect()
}

fn combine(op: SetOp, left: Vec<Binding>, right: Vec<Binding>) -> Vec<Binding> {
    let right_keys: std::collections::HashSet<String> = right.iter().map(row_key).collect();
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

/// Output column names for a query: the terminal RETURN item names of part 0
/// (or, for `RETURN *`, the keys of the first result row).
fn output_columns(query: &Query, rows: &[Binding]) -> Vec<String> {
    let terminal = query.parts.first().and_then(|p| {
        p.clauses.iter().rev().find_map(|c| match c {
            Clause::Return(proj) => Some(proj),
            _ => None,
        })
    });
    match terminal {
        Some(proj) if !proj.star && !proj.items.is_empty() => proj.items.iter().map(item_name).collect(),
        _ => rows.first().map(|r| r.iter().map(|(k, _)| k.clone()).collect()).unwrap_or_default(),
    }
}

impl Query {
    /// Execute against a columnar graph, returning real result rows. The graph
    /// is `&mut` because a query may mutate it (`INSERT`/`SET`/`REMOVE`/`DELETE`).
    pub fn execute(&self, graph: &mut Graph, params: &Params) -> Result<RowSet, String> {
        let first = self.parts.first().ok_or("empty query")?;
        let mut rows = run_linear(first, graph, params)?;
        for (i, op) in self.ops.iter().enumerate() {
            let right = run_linear(&self.parts[i + 1], graph, params)?;
            rows = combine(*op, rows, right);
        }
        let cols = output_columns(self, &rows);
        let out_rows: Vec<Vec<Value>> = rows
            .iter()
            .map(|b| {
                cols.iter()
                    .map(|c| b.get(c).map(|v| val_to_value(graph, v)).unwrap_or(Value::Null))
                    .collect()
            })
            .collect();
        Ok(RowSet { cols, rows: out_rows })
    }
}
