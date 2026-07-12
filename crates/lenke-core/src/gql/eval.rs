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
use std::sync::atomic::{AtomicU8, Ordering as AtomOrdering};
use std::sync::Arc;

#[cfg(feature = "parallel-query")]
use rayon::prelude::*;

use super::ast::{ArithOp, CompareOp, Direction, Lit, Quantifier, SetOp, SetOpKind};
use super::lexer::SyntaxError;
use super::plan::{
    has_argless_aggregate, has_nested_aggregate, lower, AggFn, CClause, CExpr, CLabelExpr, CLinear,
    CMerge, CMergeUpdate, CNode, CPath, CProjection, CPropConstraint, CQuery, CRel, CRemoveItem,
    CReturnItem, CSegment, CSetItem, Op, Program, ScalarFn,
};
#[cfg(feature = "arrow")]
use crate::arrow::ArrowColumn;
use crate::error::{CodeError, CodeResult};
use crate::error_codes::ErrorCode;
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
    Str(Arc<str>),
    /// An ISO temporal scalar (`DATE`/`LOCAL DATETIME`/`DURATION`).
    Temporal(crate::temporal::Temporal),
    List(Vec<Self>),
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
    /// Unknown/unimplemented function names the plan references — named in the
    /// `UnknownFunction` error when one faults (see `FAULT_UNKNOWN_FN`).
    unknown_fns: &'a [String],
    /// First ISO data exception raised during evaluation (see `FAULT_*`). The
    /// infallible `eval`/VM/vectorized engines can't return `Err`, so they record
    /// the fault here and return a placeholder; the driver checks it at the row
    /// boundary and converts it to a `CodeError`. Atomic so the parallel (rayon)
    /// vectorized path can record faults safely.
    fault: AtomicU8,
}

const FAULT_NONE: u8 = 0;
const FAULT_DIV_ZERO: u8 = 1;
const FAULT_TYPE: u8 = 2;
const FAULT_BUDGET: u8 = 3;
const FAULT_BAD_LABEL: u8 = 4;
const FAULT_UNKNOWN_FN: u8 = 5;
const FAULT_CONSTRAINT: u8 = 6;
const FAULT_MERGE_KEY: u8 = 7;
const FAULT_MERGE_EDGE: u8 = 8;

/// Per-expansion cap on trail-traversal steps; a guard against exponential blowup.
const TRAIL_BUDGET: u64 = 1_000_000;

impl Ctx<'_> {
    /// Re-resolve property-key and label ids against the current graph (keeping
    /// params/fault). Needed mid-INSERT: freshly created nodes introduce columns
    /// a snapshot taken before the clause doesn't know about, so a forward
    /// reference (`INSERT (a {..}), (:B {x: a.id})`) would otherwise read NULL.
    fn refresh_ids(&mut self, graph: &Graph, plan: &CQuery) {
        self.prop_keys = plan
            .key_names
            .iter()
            .map(|n| (graph.props.keys.get(n), graph.edge_props.keys.get(n)))
            .collect();
        self.labels = plan
            .label_names
            .iter()
            .map(|n| (graph.labels.get(n), graph.etype.get(n)))
            .collect();
    }

    /// Record a data-exception fault (first one wins; later faults are ignored).
    #[inline]
    fn set_fault(&self, kind: u8) {
        if self.fault.load(AtomOrdering::Relaxed) == FAULT_NONE {
            self.fault.store(kind, AtomOrdering::Relaxed);
        }
    }

    /// Convert any recorded fault into an `Err`, to be called at a row boundary.
    fn check_fault(&self) -> CodeResult<()> {
        match self.fault.load(AtomOrdering::Relaxed) {
            FAULT_DIV_ZERO => Err(CodeError::new(ErrorCode::DataException, "division by zero")),
            FAULT_TYPE => Err(CodeError::new(
                ErrorCode::DataException,
                "arithmetic requires a number",
            )),
            FAULT_BUDGET => Err(CodeError::new(
                ErrorCode::ResourceExhausted,
                "variable-length pattern exceeded the trail budget; add a tighter bound",
            )),
            FAULT_BAD_LABEL => Err(CodeError::new(
                ErrorCode::InvalidGraphOp,
                "INSERT: a node's label expression must be a plain conjunction (`A` or `A&B`) and an edge must carry exactly one type — a disjunction/negation/wildcard or a typeless edge is not creatable",
            )),
            FAULT_CONSTRAINT => Err(CodeError::new(
                ErrorCode::ConstraintViolation,
                "write would duplicate a value under a unique constraint (use _MERGE to upsert)",
            )),
            FAULT_MERGE_KEY => Err(CodeError::new(
                ErrorCode::InvalidGraphOp,
                "_MERGE could not determine a unique key from the pattern — declare a unique constraint on the label (or narrow an ambiguous one)",
            )),
            FAULT_MERGE_EDGE => Err(CodeError::new(
                ErrorCode::NotImplemented,
                "_MERGE multi-hop compound patterns are not yet supported (v2)",
            )),
            FAULT_UNKNOWN_FN => {
                // Name the offending function(s) (as TS does), e.g.
                // "...: frobnicate()" — the plan collected them at lower time.
                let msg = if self.unknown_fns.is_empty() {
                    "call to an unknown or unimplemented function".to_string()
                } else {
                    let names = self
                        .unknown_fns
                        .iter()
                        .map(|n| format!("{n}()"))
                        .collect::<Vec<_>>()
                        .join(", ");

                    format!("call to an unknown or unimplemented function: {names}")
                };

                Err(CodeError::new(ErrorCode::UnknownFunction, msg))
            }
            _ => Ok(()),
        }
    }

    fn faulted(&self) -> bool {
        self.fault.load(AtomOrdering::Relaxed) != FAULT_NONE
    }
}

/// Coerce an arithmetic operand: a number passes, NULL propagates (`None`), and
/// anything else is an ISO type error recorded in `ctx` (returns `None` so eval
/// can continue to the row boundary, where the fault surfaces).
fn arith_num(v: &Val, ctx: &Ctx) -> Option<f64> {
    match v {
        Val::Null => None,
        Val::Num(n) => Some(*n),
        _ => {
            ctx.set_fault(FAULT_TYPE);
            None
        }
    }
}

fn resolve_ctx<'a>(graph: &Graph, plan: &'a CQuery, params: &'a [Val]) -> Ctx<'a> {
    Ctx {
        params,
        prop_keys: plan
            .key_names
            .iter()
            .map(|n| (graph.props.keys.get(n), graph.edge_props.keys.get(n)))
            .collect(),
        labels: plan
            .label_names
            .iter()
            .map(|n| (graph.labels.get(n), graph.etype.get(n)))
            .collect(),
        label_names: &plan.label_names,
        unknown_fns: &plan.unknown_fns,
        fault: AtomicU8::new(FAULT_NONE),
    }
}

/// A/B toggle for the expression VM at the hot per-row sites. Flip to `true`
/// to route those sites through the compiled stack-machine [`Program`]; `false`
/// uses the tree-walking `eval`. Both forms are kept side by side per item
/// (`CReturnItem` holds `expr` + `prog`, `CClause` holds `where_` + `where_prog`).
///
/// Measured (52k/225k graph, same-session, cooled — VM on vs off):
///   - single small expr/row (project one col, simple predicate): VM ~12-17% SLOWER
///   - many small exprs/row (4-col projection): VM ~17% SLOWER
///   - one deep predicate/row (expr-heavy filter): VM ~6% FASTER
///   - traversal/output-bound (joins, var-length): unaffected
///
/// Net: the naive scalar stack VM loses. Per-invocation setup + operand-stack
/// traffic of fat `Val`s outweighs the dispatch saved, except for a single deep
/// expression where the flat op-stream beats recursive boxed-tree pointer-chasing.
/// The win that would actually pay off is *vectorized* eval (one op over a batch
/// of rows, amortizing dispatch N-fold) — the columnar direction, not this.
const USE_VM: bool = false;

/// Toggle for the vectorized (batched, column-at-a-time) scan path. When on,
/// the single isolated-node shape `MATCH (n:L …) [WHERE pred] RETURN …` is
/// evaluated one *operation across all matched rows* instead of per row, so
/// numeric property reads gather straight from a typed `Column` and arithmetic /
/// comparison run tight `f64` loops the compiler can autovectorize. Anything
/// outside the supported numeric subset falls back to scalar `eval` per column.
///
/// Measured (52k/225k graph, same-session, cooled — vec on vs scalar off):
///   - expr-heavy numeric filter (RETURN count): 7.09ms → 1.43ms  (5.0x)
///   - ORDER BY input key, no LIMIT (50k sort):  7.24ms → 1.66ms  (4.4x)
///   - grouped aggregate (n.dept, count, avg):   3.02ms → 0.79ms  (3.8x)
///   - grouped aggregate, 2 keys:                4.08ms → 1.35ms  (3.0x)
///   - scan + numeric filter count:              1.49ms → 0.39ms  (3.8x)
///   - count(*) / count+pred:                    ~3-4x
///   - expr-heavy numeric projection (4 cols):   9.46ms → 4.42ms  (2.1x)
///   - numeric single-col projection:            1.16ms → 0.46ms  (2.5x)
///   - numeric projection over a 1-hop join:     2.78ms → 1.53ms  (1.8x)
///   - count+WHERE over a 1-hop join:            2.09ms → 1.24ms  (1.7x)
///   - DISTINCT over typed Props (raw-id group):  7.78ms → 1.23ms  (6.3x, 2 col)
///   - WITH carry + filter + project (pipeline): 4.26ms → 1.02ms  (4.2x)
///   - WITH … MATCH expand from a carried var:   7.72ms → 1.65ms  (4.7x)
///   - WITH aggregate then filter:               2.37ms → 0.92ms  (2.6x)
///   - ORDER BY input key + small LIMIT:         1.94ms → 1.37ms  (1.4x)
///   - var-length / subqueries / pure count over a join: not engaged
///   - ORDER BY on an output alias / grouped-or-DISTINCT+ORDER BY: not engaged
///
/// A read-only `MATCH … WITH … RETURN` chain runs fully vectorized end-to-end via
/// `vectorized_linear`: one columnar frame threads stage-to-stage, carrying
/// element columns forward (so prop reads / filters / ORDER BY past a `WITH` stay
/// vectorized) and adding computed value columns beside them — no per-stage
/// round-trip through `Vec<Binding>`. A `MATCH` after a `WITH` expands the frame
/// from a carried element column (`expand_frame`), fanning each row out to its
/// matching neighbors while replicating the other columns. It bails (→ scalar
/// `run_linear`) on a `WITH` that aggregates / DISTINCT / ORDER BYs mid-pipeline,
/// an expanding MATCH from an unbound/fresh start (cartesian), mutations, or
/// subqueries. `ScanCols::vals` is what makes this work: a carried node stays a
/// fast `Elem` column while `n.age * 2 AS x` rides alongside as a value column.
/// Same expressions where the scalar *bytecode VM* lost 6-17% (see [`USE_VM`])
/// win 2-5x here: dispatch amortizes over N rows, the f64 loops vectorize, and
/// values never get boxed into `Val` per row.
///
/// Tradeoffs found & handled (where vectorizing would cost more than it saves):
///   - small `LIMIT` with no WHERE: vectorizing the whole scan loses the scalar
///     streaming early-exit — `build_scan` caps the gather at `skip+limit`.
///   - an isolated-node scan: built by a tight label-bucket loop, not the general
///     matcher (which is ~3x slower per row and dominates a pure scan).
///   - a *pure* aggregate over a traversal (no WHERE): stays scalar — the scalar
///     engine stream-folds the join without materializing it, and there's no
///     per-row expression to vectorize. (With a WHERE or a projection, the
///     batched build in `build_scan` pays off.)
const USE_VEC: bool = true;

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
        Env {
            graph,
            ctx,
            binding,
            group: None,
            agg_values: None,
        }
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
            Some(if t.is_empty() {
                0.0
            } else {
                t.parse().unwrap_or(f64::NAN)
            })
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
        if n > 0.0 {
            "Infinity".to_string()
        } else {
            "-Infinity".to_string()
        }
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
        Val::Temporal(t) => t.format(),
        Val::Node(i) => graph.vid.text(*i).to_string(),
        Val::Edge(i) => format!("e{i}"),
        Val::List(items) => items
            .iter()
            .map(|x| js_str(graph, x))
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// Make a `Val::Str` from anything that can produce an owned/borrowed `str`.
fn vstr(s: impl Into<Arc<str>>) -> Val {
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
        // Distinct kinds (date vs datetime) are never equal (enum inequality).
        (Val::Temporal(x), Val::Temporal(y)) => x == y,
        (Val::Node(x), Val::Node(y)) => x == y,
        (Val::Edge(x), Val::Edge(y)) => x == y,
        (Val::List(x), Val::List(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| val_eq(p, q))
        }
        _ => false,
    }
}

/// Push `v` into `out` unless an equal element is already present (structural
/// equality, first occurrence wins). The building block for the ISO GQL set-style
/// list functions (`list_union`/`intersection`/`difference`), all of which dedup.
fn push_unique(out: &mut Vec<Val>, v: &Val) {
    if !out.iter().any(|x| val_eq(x, v)) {
        out.push(v.clone());
    }
}

/// Whether `a` and `b` are the same orderable primitive type (number, string,
/// or boolean). ISO ordering (`< > <= >=`) is only defined within such a type;
/// across types — or for graph elements — the comparison is UNKNOWN, not a
/// coerced bool. (Mirrors the TS executor's `orderable` guard.)
fn orderable_pair(a: &Val, b: &Val) -> bool {
    match (a, b) {
        (Val::Num(_), Val::Num(_)) | (Val::Str(_), Val::Str(_)) | (Val::Bool(_), Val::Bool(_)) => {
            true
        }
        // Instants (date/datetime, same kind) are relationally orderable;
        // durations and cross-kind pairs are not (`rel_cmp` → None).
        (Val::Temporal(x), Val::Temporal(y)) => x.rel_cmp(y).is_some(),
        _ => false,
    }
}

/// Partial ordering for the relational operators `< > <= >=`. `None` =
/// incomparable (different types, or a graph element) → the operator yields
/// UNKNOWN, never a coerced bool. This is NOT the sort order — see [`cmp_total`].
fn val_cmp(a: &Val, b: &Val) -> Option<Ordering> {
    match (a, b) {
        (Val::Num(x), Val::Num(y)) => x.partial_cmp(y),
        (Val::Str(x), Val::Str(y)) => Some(x.cmp(y)),
        (Val::Bool(x), Val::Bool(y)) => Some(x.cmp(y)),
        (Val::Temporal(x), Val::Temporal(y)) => x.rel_cmp(y),
        (Val::Node(x), Val::Node(y)) => Some(x.cmp(y)),
        (Val::Edge(x), Val::Edge(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

/// Type-group rank for the TOTAL sort order (mirrors the TS `typeRank`):
/// number < string < boolean < other (graph elements / lists). Null is handled
/// by [`cmp_total`] before this is consulted.
fn type_rank(v: &Val) -> u8 {
    match v {
        Val::Num(_) => 0,
        Val::Str(_) => 1,
        Val::Bool(_) => 2,
        Val::Temporal(_) => 3,
        _ => 4,
    }
}

/// A TOTAL order across value types, used by ORDER BY / min / max / list_sort so
/// a mixed-type column sorts deterministically (unlike `val_cmp`, which is
/// partial). Byte-for-byte identical to the TS `compareValues`: null sorts
/// largest; otherwise different type groups order by `type_rank`, and within a
/// group numbers/strings/booleans compare naturally while two graph
/// elements/lists compare Equal (leaving them in stable order). NaN, like the
/// relational path, compares Equal to every number.
fn cmp_total(a: &Val, b: &Val) -> Ordering {
    let a_null = is_nullish(a);
    let b_null = is_nullish(b);
    if a_null && b_null {
        return Ordering::Equal;
    }
    if a_null {
        return Ordering::Greater;
    }
    if b_null {
        return Ordering::Less;
    }
    let (ra, rb) = (type_rank(a), type_rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Val::Num(x), Val::Num(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (Val::Str(x), Val::Str(y)) => x.cmp(y),
        (Val::Bool(x), Val::Bool(y)) => x.cmp(y),
        (Val::Temporal(x), Val::Temporal(y)) => x.cmp_total(y),
        _ => Ordering::Equal,
    }
}

/// Compare two non-null operands to a three-valued result. Equality holds across
/// any types (mismatched types are simply unequal); ordering across incomparable
/// types is UNKNOWN (`Val::Null`), not a coerced bool.
fn compare_vals(op: CompareOp, lv: &Val, rv: &Val) -> Val {
    match op {
        CompareOp::Eq => Val::Bool(val_eq(lv, rv)),
        CompareOp::Ne => Val::Bool(!val_eq(lv, rv)),
        _ if !orderable_pair(lv, rv) => Val::Null,
        _ => {
            let c = val_cmp(lv, rv);
            Val::Bool(match op {
                CompareOp::Lt => c == Some(Ordering::Less),
                CompareOp::Gt => c == Some(Ordering::Greater),
                CompareOp::Le => matches!(c, Some(Ordering::Less | Ordering::Equal)),
                CompareOp::Ge => matches!(c, Some(Ordering::Greater | Ordering::Equal)),
                CompareOp::Eq | CompareOp::Ne => unreachable!(),
            })
        }
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
        Val::Temporal(t) => {
            let _ = write!(out, "t{}{}", t.tag(), t.format());
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

/// Canonical key for an output [`Value`] cell (DISTINCT / set-op identity).
fn value_key(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push('N'),
        Value::Bool(b) => {
            out.push('b');
            out.push(if *b { '1' } else { '0' });
        }
        Value::Num(n) => {
            let _ = write!(out, "n{:016x}", n.to_bits());
        }
        Value::Str(s) => {
            let _ = write!(out, "s{s}");
        }
        Value::Temporal(t) => {
            let _ = write!(out, "t{}{}", t.tag(), t.format());
        }
        Value::List(items) => {
            out.push('[');
            for it in items {
                value_key(it, out);
                out.push(',');
            }
            out.push(']');
        }
        Value::Map(pairs) => {
            out.push('{');
            for (k, val) in pairs {
                let _ = write!(out, "{k}=");
                value_key(val, out);
                out.push(',');
            }
            out.push('}');
        }
    }
}

fn value_row_key(row: &[Value]) -> String {
    let mut s = String::new();
    for cell in row {
        value_key(cell, &mut s);
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
        Value::Str(s) => Val::Str(s.clone()), // shared Arc — refcount bump, no alloc
        Value::Temporal(t) => Val::Temporal(*t),
        Value::List(items) => Val::List(items.iter().map(value_to_val).collect()),
        // Map is a query-result-only value (a serialized node/edge); it is never a
        // stored property, so it never flows back through property/label reads.
        Value::Map(_) => Val::Null,
    }
}

/// A store element's present properties as a sorted `Value::Map` — the shape a
/// returned node/edge's `properties` field serializes to. Keys are sorted so the
/// object is deterministic (the columnar store has no per-element key order).
fn props_map(store: &crate::graph::Properties, strs: &crate::graph::Dict, idx: usize) -> Value {
    let mut props: Vec<(Arc<str>, Value)> = (0..store.keys.len() as u32)
        .filter(|&kid| store.is_present_id(idx, kid))
        .map(|kid| {
            (
                Arc::from(store.keys.text(kid)),
                store.value_id(idx, kid, strs),
            )
        })
        .collect();
    props.sort_by(|a, b| a.0.cmp(&b.0));
    Value::Map(props)
}

/// Project a runtime value to the core output [`Value`]. A returned node/edge
/// reference serializes to a `{id, labels, properties}` object (matching the TS
/// engine) so `RETURN n` is useful, not a bare id.
fn val_to_value(graph: &Graph, v: &Val) -> Value {
    match v {
        Val::Null => Value::Null,
        Val::Bool(b) => Value::Bool(*b),
        Val::Num(n) => Value::Num(*n),
        Val::Str(s) => Value::Str(s.clone()), // shared Arc — refcount bump, no alloc
        Val::Temporal(t) => Value::Temporal(*t),
        Val::List(items) => Value::List(items.iter().map(|x| val_to_value(graph, x)).collect()),
        Val::Node(i) => {
            let mut labels: Vec<Arc<str>> = graph
                .vertex_labels(*i)
                .iter()
                .map(|&l| graph.labels.arc(l))
                .collect();
            labels.sort_unstable();
            Value::Map(vec![
                (Arc::from("id"), Value::Str(graph.vid.arc(*i))),
                (
                    Arc::from("labels"),
                    Value::List(labels.into_iter().map(Value::Str).collect()),
                ),
                (
                    Arc::from("properties"),
                    props_map(&graph.props, &graph.strs, *i as usize),
                ),
            ])
        }
        Val::Edge(i) => {
            let idx = *i as usize;
            Value::Map(vec![
                (
                    Arc::from("id"),
                    Value::Str(Arc::from(graph.edge_id(*i).as_ref())),
                ),
                (
                    Arc::from("from"),
                    Value::Str(graph.vid.arc(graph.e_src[idx])),
                ),
                (Arc::from("to"), Value::Str(graph.vid.arc(graph.e_dst[idx]))),
                (
                    Arc::from("labels"),
                    Value::List(vec![Value::Str(graph.etype.arc(graph.e_type[idx]))]),
                ),
                (
                    Arc::from("properties"),
                    props_map(&graph.edge_props, &graph.strs, idx),
                ),
            ])
        }
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
        Some(Column::Str { data, present }) if present.get(idx) => {
            Val::Str(graph.strs.arc(data[idx]))
        }
        Some(Column::Mixed { data }) => data[idx].as_ref().map(value_to_val).unwrap_or(Val::Null),
        _ => Val::Null,
    }
}

fn eval_label_node(graph: &Graph, ctx: &Ctx, vi: u32, expr: &CLabelExpr) -> bool {
    match expr {
        CLabelExpr::Label(r) => ctx.labels[*r].0.is_some_and(|lid| graph.has_label(vi, lid)),
        CLabelExpr::Wildcard => !graph.vertex_labels(vi).is_empty(),
        CLabelExpr::Not(e) => !eval_label_node(graph, ctx, vi, e),
        CLabelExpr::And(l, r) => {
            eval_label_node(graph, ctx, vi, l) && eval_label_node(graph, ctx, vi, r)
        }
        CLabelExpr::Or(l, r) => {
            eval_label_node(graph, ctx, vi, l) || eval_label_node(graph, ctx, vi, r)
        }
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
            Lit::Temporal(t) => Val::Temporal(*t),
        },
        CExpr::Var(slot) => env.binding.get(*slot).cloned().unwrap_or(Val::Null),
        CExpr::Param(slot) => env.ctx.params.get(*slot).cloned().unwrap_or(Val::Null),
        CExpr::Prop { var_slot, key_ref } => {
            let bound = env.binding.get(*var_slot).cloned().unwrap_or(Val::Null);
            prop_of(env.graph, env.ctx, &bound, *key_ref)
        }
        CExpr::List(items) => Val::List(items.iter().map(|e| eval(env, e)).collect()),
        CExpr::Neg(e) => match arith_num(&eval(env, e), env.ctx) {
            Some(n) => Val::Num(-n),
            None => Val::Null,
        },
        CExpr::Arith { op, left, right } => {
            let lv = arith_num(&eval(env, left), env.ctx);
            let rv = arith_num(&eval(env, right), env.ctx);
            match (lv, rv) {
                (Some(a), Some(b)) => {
                    if matches!(op, ArithOp::Div | ArithOp::Mod) && b == 0.0 {
                        env.ctx.set_fault(FAULT_DIV_ZERO);
                        Val::Null
                    } else {
                        Val::Num(match op {
                            ArithOp::Add => a + b,
                            ArithOp::Sub => a - b,
                            ArithOp::Mul => a * b,
                            ArithOp::Div => a / b,
                            ArithOp::Mod => a % b,
                        })
                    }
                }
                _ => Val::Null,
            }
        }
        CExpr::Concat { left, right } => {
            let lv = eval(env, left);
            let rv = eval(env, right);
            match (&lv, &rv) {
                _ if is_nullish(&lv) || is_nullish(&rv) => Val::Null,
                // ISO GQL `||`: list ++ list concatenates; otherwise string concat.
                (Val::List(a), Val::List(b)) => {
                    Val::List(a.iter().chain(b.iter()).cloned().collect())
                }
                _ => vstr(js_str(env.graph, &lv) + &js_str(env.graph, &rv)),
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
        CExpr::IsTruth {
            expr,
            truth,
            negated,
        } => {
            let m = as_truth(&eval(env, expr)) == *truth;
            Val::Bool(if *negated { !m } else { m })
        }
        CExpr::IsLabeled {
            expr,
            label,
            negated,
        } => {
            let el = eval(env, expr);
            let has = labels_match(env.graph, env.ctx, &el, label);
            Val::Bool(if *negated { !has } else { has })
        }
        CExpr::In {
            expr,
            list,
            negated,
        } => {
            let r = in_list(&eval(env, expr), &eval(env, list));
            truth_to_val(if *negated { not3(r) } else { r })
        }
        CExpr::Compare { op, left, right } => {
            let lv = eval(env, left);
            let rv = eval(env, right);
            if is_nullish(&lv) || is_nullish(&rv) {
                return Val::Null; // UNKNOWN
            }
            compare_vals(*op, &lv, &rv)
        }
        CExpr::Case {
            subject,
            whens,
            else_,
        } => {
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
        CExpr::Exists {
            patterns,
            where_,
            sub_len,
        } => Val::Bool(any_match(
            env.graph,
            env.ctx,
            patterns,
            where_.as_deref(),
            env.binding,
            *sub_len,
        )),
        CExpr::CountSubquery {
            patterns,
            where_,
            sub_len,
        } => Val::Num(count_matches(
            env.graph,
            env.ctx,
            patterns,
            where_.as_deref(),
            env.binding,
            *sub_len,
        ) as f64),
        CExpr::Scalar { func, args } => {
            if matches!(func, ScalarFn::Unknown) {
                env.ctx.set_fault(FAULT_UNKNOWN_FN); // fail loud, not silent NULL
            }
            let vals: Vec<Val> = args.iter().map(|a| eval(env, a)).collect();
            call_scalar(env.graph, *func, &vals)
        }
        CExpr::Aggregate {
            func,
            arg,
            distinct,
            star,
        } => eval_aggregate(env, *func, arg.as_deref(), *distinct, *star),
        CExpr::AggRef(idx) => env
            .agg_values
            .and_then(|a| a.get(*idx))
            .cloned()
            .unwrap_or(Val::Null),
    }
}

thread_local! {
    /// Reusable operand stack for the expression VM. The VM is never re-entrant
    /// on its own stack (the only recursion is `Op::Tree`, which calls the
    /// tree-walking `eval`, not `run`), so a single per-thread buffer is safe and
    /// keeps the hot per-row path allocation-free.
    static VM_STACK: std::cell::RefCell<Vec<Val>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Evaluate a projection item, routing through the VM or tree-walk per [`USE_VM`].
#[inline]
fn eval_item(env: &Env, item: &super::plan::CReturnItem) -> Val {
    if USE_VM {
        run(env, &item.prog)
    } else {
        eval(env, &item.expr)
    }
}

/// Execute a compiled expression [`Program`] (stack machine) against `env`.
/// Mirrors [`eval`] op-for-op; `Op::Tree` delegates the un-compilable
/// subexpressions (CASE / EXISTS / COUNT{} / aggregate) back to `eval`.
fn run(env: &Env, prog: &Program) -> Val {
    VM_STACK.with(|cell| {
        let mut st = cell.borrow_mut();
        let base = st.len();
        for op in &prog.0 {
            match op {
                Op::Const(l) => st.push(match l {
                    Lit::Null => Val::Null,
                    Lit::Bool(b) => Val::Bool(*b),
                    Lit::Num(n) => Val::Num(*n),
                    Lit::Str(s) => vstr(s.as_str()),
                    Lit::Temporal(t) => Val::Temporal(*t),
                }),
                Op::Var(slot) => st.push(env.binding.get(*slot).cloned().unwrap_or(Val::Null)),
                Op::Param(slot) => st.push(env.ctx.params.get(*slot).cloned().unwrap_or(Val::Null)),
                Op::Prop { var_slot, key_ref } => {
                    let bound = env.binding.get(*var_slot).cloned().unwrap_or(Val::Null);
                    st.push(prop_of(env.graph, env.ctx, &bound, *key_ref));
                }
                Op::MakeList(n) => {
                    let at = st.len() - n;
                    let items = st.split_off(at);
                    st.push(Val::List(items));
                }
                Op::Arith(op) => {
                    let b = arith_num(&st.pop().unwrap(), env.ctx);
                    let a = arith_num(&st.pop().unwrap(), env.ctx);
                    st.push(match (a, b) {
                        (Some(a), Some(b)) => {
                            if matches!(op, ArithOp::Div | ArithOp::Mod) && b == 0.0 {
                                env.ctx.set_fault(FAULT_DIV_ZERO);
                                Val::Null
                            } else {
                                Val::Num(match op {
                                    ArithOp::Add => a + b,
                                    ArithOp::Sub => a - b,
                                    ArithOp::Mul => a * b,
                                    ArithOp::Div => a / b,
                                    ArithOp::Mod => a % b,
                                })
                            }
                        }
                        _ => Val::Null,
                    });
                }
                Op::Compare(op) => {
                    let rv = st.pop().unwrap();
                    let lv = st.pop().unwrap();
                    st.push(if is_nullish(&lv) || is_nullish(&rv) {
                        Val::Null
                    } else {
                        compare_vals(*op, &lv, &rv)
                    });
                }
                Op::Concat => {
                    let rv = st.pop().unwrap();
                    let lv = st.pop().unwrap();
                    st.push(match (&lv, &rv) {
                        _ if is_nullish(&lv) || is_nullish(&rv) => Val::Null,
                        // ISO GQL `||`: list ++ list concatenates the two lists;
                        // otherwise it is string concatenation (unchanged).
                        (Val::List(a), Val::List(b)) => {
                            Val::List(a.iter().chain(b.iter()).cloned().collect())
                        }
                        _ => vstr(js_str(env.graph, &lv) + &js_str(env.graph, &rv)),
                    });
                }
                Op::Neg => {
                    let v = st.pop().unwrap();
                    st.push(match arith_num(&v, env.ctx) {
                        Some(n) => Val::Num(-n),
                        None => Val::Null,
                    });
                }
                Op::Not => {
                    let v = st.pop().unwrap();
                    st.push(truth_to_val(not3(as_truth(&v))));
                }
                Op::And => {
                    let b = as_truth(&st.pop().unwrap());
                    let a = as_truth(&st.pop().unwrap());
                    st.push(truth_to_val(and3(a, b)));
                }
                Op::Or => {
                    let b = as_truth(&st.pop().unwrap());
                    let a = as_truth(&st.pop().unwrap());
                    st.push(truth_to_val(or3(a, b)));
                }
                Op::Xor => {
                    let b = as_truth(&st.pop().unwrap());
                    let a = as_truth(&st.pop().unwrap());
                    st.push(truth_to_val(xor3(a, b)));
                }
                Op::IsNull(negated) => {
                    let isnull = is_nullish(&st.pop().unwrap());
                    st.push(Val::Bool(if *negated { !isnull } else { isnull }));
                }
                Op::IsTruth(truth, negated) => {
                    let m = as_truth(&st.pop().unwrap()) == *truth;
                    st.push(Val::Bool(if *negated { !m } else { m }));
                }
                Op::IsLabeled(label, negated) => {
                    let el = st.pop().unwrap();
                    let has = labels_match(env.graph, env.ctx, &el, label);
                    st.push(Val::Bool(if *negated { !has } else { has }));
                }
                Op::In(negated) => {
                    let list = st.pop().unwrap();
                    let expr = st.pop().unwrap();
                    let r = in_list(&expr, &list);
                    st.push(truth_to_val(if *negated { not3(r) } else { r }));
                }
                Op::Scalar(func, argc) => {
                    if matches!(func, ScalarFn::Unknown) {
                        env.ctx.set_fault(FAULT_UNKNOWN_FN);
                    }
                    let at = st.len() - argc;
                    let args = st.split_off(at);
                    st.push(call_scalar(env.graph, *func, &args));
                }
                Op::AggRef(idx) => {
                    st.push(
                        env.agg_values
                            .and_then(|a| a.get(*idx))
                            .cloned()
                            .unwrap_or(Val::Null),
                    );
                }
                Op::Tree(e) => {
                    let v = eval(env, e);
                    st.push(v);
                }
            }
        }
        // The program leaves exactly one value above `base`.
        debug_assert_eq!(st.len(), base + 1);
        st.pop().unwrap_or(Val::Null)
    })
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
            let e = Env {
                graph: env.graph,
                ctx: env.ctx,
                binding: b,
                group: Some(group),
                agg_values: None,
            };
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
    let Some(mut acc) = it.next() else {
        return Val::Null;
    };
    for v in it {
        if cmp_total(&v, &acc) == want {
            acc = v;
        }
    }
    acc
}

// --- scalar functions (dispatched on the resolved enum) ----------------------

/// Slice `len` UTF-16 code units starting at unit index `start` (JS
/// `String.slice` semantics), decoding back to a `String`. A slice that splits a
/// surrogate pair yields U+FFFD there (lossy) — an extreme edge JS keeps as a
/// lone surrogate; not worth carrying invalid UTF-16 through the engine for.
fn utf16_slice(s: &str, start: usize, len: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    let end = start.saturating_add(len).min(units.len());
    let start = start.min(end);
    String::from_utf16_lossy(&units[start..end])
}

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
        (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => Val::Num(f(
            num_of(x).unwrap_or(f64::NAN),
            num_of(y).unwrap_or(f64::NAN),
        )),
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
        // pi()/e() are 0-arg constants; sign()/round() null-in → null-out.
        Pi => Val::Num(std::f64::consts::PI),
        E => Val::Num(std::f64::consts::E),
        Sign => match a {
            Some(v) if !is_nullish(v) => {
                let x = num_of(v).unwrap_or(f64::NAN);
                // -1 | 0 | 1 (NaN passes through) — matches the TS `mathSign`,
                // NOT `f64::signum` (which yields +1 for 0.0).
                Val::Num(if x.is_nan() {
                    f64::NAN
                } else if x > 0.0 {
                    1.0
                } else if x < 0.0 {
                    -1.0
                } else {
                    0.0
                })
            }
            _ => Val::Null,
        },
        Round => match a {
            Some(v) if !is_nullish(v) => {
                let x = num_of(v).unwrap_or(f64::NAN);
                let digits = match b {
                    Some(d) if !is_nullish(d) => num_of(d).unwrap_or(0.0).trunc() as i32,
                    _ => 0,
                };
                // `f64::round` is already half-away-from-zero (the TS engine
                // reproduces this via `roundHalfAway`); same op order → same bits.
                let f = 10f64.powi(digits);
                Val::Num((x * f).round() / f)
            }
            _ => Val::Null,
        },
        Upper => us(|s| vstr(s.to_uppercase())),
        Lower => us(|s| vstr(s.to_lowercase())),
        Trim => us(|s| vstr(s.trim())),
        Ltrim => us(|s| vstr(s.trim_start())),
        Rtrim => us(|s| vstr(s.trim_end())),
        // String length/slicing count UTF-16 code units, matching JS `.length`
        // (the TS engine) — NOT Unicode code points. So `size('😀')` == 2, and
        // `left`/`right` slice on the same unit as JS `String.slice`.
        CharLength => us(|s| Val::Num(s.encode_utf16().count() as f64)),
        Power => bn(|x, y| x.powf(y)),
        Mod => bn(|x, y| x % y),
        Log => bn(|base, value| value.ln() / base.ln()),
        Size => match a {
            Some(Val::List(items)) => Val::Num(items.len() as f64),
            Some(Val::Str(s)) => Val::Num(s.encode_utf16().count() as f64),
            _ => Val::Null,
        },
        Left => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s = js_str(graph, x);
                let n = num_of(y).unwrap_or(0.0).max(0.0) as usize;
                vstr(utf16_slice(&s, 0, n))
            }
            _ => Val::Null,
        },
        Right => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s = js_str(graph, x);
                let units = s.encode_utf16().count();
                let n = num_of(y).unwrap_or(0.0);
                if n <= 0.0 {
                    vstr("")
                } else {
                    let n = (n as usize).min(units);
                    vstr(utf16_slice(&s, units - n, n))
                }
            }
            _ => Val::Null,
        },
        Coalesce => args
            .iter()
            .find(|x| !is_nullish(x))
            .cloned()
            .unwrap_or(Val::Null),
        Nullif => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) && val_eq(x, y) => Val::Null,
            (Some(x), _) => x.clone(),
            _ => Val::Null,
        },
        ElementId => match a {
            Some(Val::Node(i)) => Val::Str(graph.vid.arc(*i)),
            Some(Val::Edge(i)) => vstr(format!("e{i}")),
            _ => Val::Null,
        },
        // --- graph functions --- (label/key order is unspecified → sorted for
        // deterministic, cross-engine-identical output)
        Labels => match a {
            Some(Val::Node(i)) => {
                let mut ls: Vec<String> = graph
                    .vertex_labels(*i)
                    .iter()
                    .map(|&l| graph.labels.text(l).to_string())
                    .collect();
                ls.sort_unstable();
                Val::List(ls.into_iter().map(vstr).collect())
            }
            _ => Val::Null,
        },
        Type => match a {
            Some(Val::Edge(e)) => vstr(graph.etype.text(graph.e_type[*e as usize]).to_string()),
            _ => Val::Null,
        },
        Keys => {
            let store_idx = match a {
                Some(Val::Node(i)) => Some((&graph.props, *i as usize)),
                Some(Val::Edge(e)) => Some((&graph.edge_props, *e as usize)),
                _ => None,
            };
            match store_idx {
                Some((store, idx)) => {
                    let mut ks: Vec<String> = (0..store.keys.len() as u32)
                        .filter(|&kid| store.is_present_id(idx, kid))
                        .map(|kid| store.keys.text(kid).to_string())
                        .collect();
                    ks.sort_unstable();
                    Val::List(ks.into_iter().map(vstr).collect())
                }
                None => Val::Null,
            }
        }
        // --- conversion (null in → null out) ---
        ToString => match a {
            Some(v) if !is_nullish(v) => vstr(js_str(graph, v)),
            _ => Val::Null,
        },
        ToInteger => match a {
            Some(Val::Num(n)) => Val::Num(n.trunc()),
            Some(Val::Str(s)) => s
                .trim()
                .parse::<f64>()
                .ok()
                .map_or(Val::Null, |n| Val::Num(n.trunc())),
            _ => Val::Null,
        },
        ToFloat => match a {
            Some(Val::Num(n)) => Val::Num(*n),
            Some(Val::Str(s)) => s.trim().parse::<f64>().ok().map_or(Val::Null, Val::Num),
            _ => Val::Null,
        },
        ToBoolean => match a {
            Some(Val::Bool(b)) => Val::Bool(*b),
            Some(Val::Num(n)) if !n.is_nan() => Val::Bool(*n != 0.0),
            Some(Val::Str(s)) => match s.trim().to_lowercase().as_str() {
                "true" | "yes" | "1" => Val::Bool(true),
                "false" | "no" | "0" => Val::Bool(false),
                _ => Val::Null,
            },
            _ => Val::Null,
        },
        ToList => match a {
            Some(v @ Val::List(_)) => v.clone(),
            // A string → its UTF-16 code-unit characters (same unit model as
            // split('')); any other non-null scalar → a singleton list.
            Some(Val::Str(s)) => Val::List(
                s.encode_utf16()
                    .map(|u| vstr(String::from_utf16_lossy(&[u])))
                    .collect(),
            ),
            Some(v) if !is_nullish(v) => Val::List(vec![v.clone()]),
            _ => Val::Null,
        },
        // --- string predicates / measurement ---
        Contains => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                Val::Bool(js_str(graph, x).contains(js_str(graph, y).as_str()))
            }
            _ => Val::Null,
        },
        StartsWith => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                Val::Bool(js_str(graph, x).starts_with(js_str(graph, y).as_str()))
            }
            _ => Val::Null,
        },
        EndsWith => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                Val::Bool(js_str(graph, x).ends_with(js_str(graph, y).as_str()))
            }
            _ => Val::Null,
        },
        ByteLength => match a {
            Some(v) if !is_nullish(v) => Val::Num(js_str(graph, v).len() as f64),
            _ => Val::Null,
        },
        // --- string / list ---
        Substring => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s = js_str(graph, x);
                // ISO GQL: 1-based start (SQL `SUBSTRING`). Convert to a 0-based
                // offset; a start <= 0 shrinks the window from the front (SQL
                // semantics), byte-identical to the TS engine.
                let zero_start = num_of(y).unwrap_or(0.0) - 1.0;
                let from = zero_start.max(0.0) as usize;
                let count = match args.get(2) {
                    Some(z) if !is_nullish(z) => {
                        let end = (zero_start + num_of(z).unwrap_or(0.0)).max(0.0) as usize;
                        end.saturating_sub(from)
                    }
                    _ => usize::MAX,
                };
                vstr(utf16_slice(&s, from, count))
            }
            _ => Val::Null,
        },
        Split => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s = js_str(graph, x);
                let delim = js_str(graph, y);
                let parts: Vec<Val> = if delim.is_empty() {
                    // Empty delimiter → one element per UTF-16 code unit (JS
                    // `.length` model), matching the TS engine. A lone surrogate
                    // decodes to U+FFFD (`from_utf16_lossy`) — see the module note
                    // on the UTF-16 non-conformance; this keeps both engines
                    // byte-identical (UTF-8 can't carry a lone surrogate).
                    s.encode_utf16()
                        .map(|u| vstr(String::from_utf16_lossy(&[u])))
                        .collect()
                } else {
                    s.split(delim.as_str()).map(vstr).collect()
                };
                Val::List(parts)
            }
            _ => Val::Null,
        },
        Replace => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s = js_str(graph, x);
                let search = js_str(graph, y);
                let repl = match args.get(2) {
                    Some(z) if !is_nullish(z) => js_str(graph, z),
                    _ => String::new(),
                };
                if search.is_empty() {
                    vstr(s)
                } else {
                    vstr(s.replace(search.as_str(), &repl))
                }
            }
            _ => Val::Null,
        },
        Head => match a {
            Some(Val::List(items)) => items.first().cloned().unwrap_or(Val::Null),
            _ => Val::Null,
        },
        Last => match a {
            Some(Val::List(items)) => items.last().cloned().unwrap_or(Val::Null),
            _ => Val::Null,
        },
        Tail => match a {
            Some(Val::List(items)) => Val::List(items.iter().skip(1).cloned().collect()),
            _ => Val::Null,
        },
        Append => match a {
            // The element may be null (a first-class value); only a null LIST is
            // null-in → null-out.
            Some(Val::List(items)) => {
                let mut v = items.clone();
                v.push(b.cloned().unwrap_or(Val::Null));
                Val::List(v)
            }
            _ => Val::Null,
        },
        // --- set-style list functions (all dedup; first occurrence wins) ---
        ListUnion => match (a, b) {
            (Some(Val::List(x)), Some(Val::List(y))) => {
                let mut out = Vec::new();
                for v in x.iter().chain(y.iter()) {
                    push_unique(&mut out, v);
                }
                Val::List(out)
            }
            _ => Val::Null,
        },
        Intersection => match (a, b) {
            (Some(Val::List(x)), Some(Val::List(y))) => {
                let mut out = Vec::new();
                for v in x {
                    if y.iter().any(|w| val_eq(w, v)) {
                        push_unique(&mut out, v);
                    }
                }
                Val::List(out)
            }
            _ => Val::Null,
        },
        Difference => match (a, b) {
            (Some(Val::List(x)), Some(Val::List(y))) => {
                let mut out = Vec::new();
                for v in x {
                    if !y.iter().any(|w| val_eq(w, v)) {
                        push_unique(&mut out, v);
                    }
                }
                Val::List(out)
            }
            _ => Val::Null,
        },
        // ISO GQL `list_contains` returns the numeric 1 / 0 (per its Return Type),
        // not a boolean. The value may be null (a first-class value).
        ListContains => match a {
            Some(Val::List(items)) => {
                let found = b.is_some_and(|v| items.iter().any(|w| val_eq(w, v)));
                Val::Num(if found { 1.0 } else { 0.0 })
            }
            _ => Val::Null,
        },
        // list_sort(list, [order], [nullOrder]) — reuses the ORDER BY total order
        // (`compare_sort`) so a sorted list matches ORDER BY byte-for-byte. Stable.
        ListSort => match a {
            Some(Val::List(items)) => {
                let descending = matches!(b, Some(Val::Str(s)) if s.eq_ignore_ascii_case("desc"));
                let nulls_first = match args.get(2) {
                    Some(Val::Str(s)) if s.eq_ignore_ascii_case("first") => Some(true),
                    Some(Val::Str(s)) if s.eq_ignore_ascii_case("last") => Some(false),
                    _ => None,
                };
                let mut sorted = items.clone();
                sorted.sort_by(|x, y| compare_sort(x, y, descending, nulls_first));
                Val::List(sorted)
            }
            _ => Val::Null,
        },
        Range => match (a, b) {
            (Some(x), Some(y)) if !is_nullish(x) && !is_nullish(y) => {
                let s = num_of(x).unwrap_or(0.0).trunc();
                let e = num_of(y).unwrap_or(0.0).trunc();
                let st = match args.get(2) {
                    Some(z) if !is_nullish(z) => num_of(z).unwrap_or(1.0).trunc(),
                    _ => 1.0,
                };
                if st == 0.0 {
                    Val::Null // a zero step has no defined progression
                } else {
                    // Inclusive of both bounds (Cypher/ISO convention).
                    let mut out = Vec::new();
                    let mut i = s;
                    if st > 0.0 {
                        while i <= e {
                            out.push(Val::Num(i));
                            i += st;
                        }
                    } else {
                        while i >= e {
                            out.push(Val::Num(i));
                            i += st;
                        }
                    }
                    Val::List(out)
                }
            }
            _ => Val::Null,
        },
        Reverse => match a {
            Some(Val::List(items)) => Val::List(items.iter().rev().cloned().collect()),
            // Reverse by UTF-16 code unit (JS `.length` model), lossy-decoding
            // the reversed units the same way the TS engine does. Reversing
            // across a surrogate pair is inherently lossy → U+FFFD on both.
            Some(Val::Str(s)) => {
                let mut units: Vec<u16> = s.encode_utf16().collect();
                units.reverse();
                vstr(String::from_utf16_lossy(&units))
            }
            _ => Val::Null,
        },
        DateOf => temporal_ctor(a, "date"),
        DateTimeOf => temporal_ctor(a, "datetime"),
        DurationOf => temporal_ctor(a, "duration"),
        Unknown => Val::Null,
    }
}

/// The `date(x)` / `local_datetime(x)` / `duration(x)` constructors: parse a
/// string, or convert a temporal by kind (`date(datetime)` → the date part,
/// `local_datetime(date)` → midnight). Null / bad string / unconvertible → null
/// (lenient, like the `to_*` conversions).
fn temporal_ctor(v: Option<&Val>, kind: &str) -> Val {
    use crate::temporal::{Date, DateTime, Temporal};
    const SECS_PER_DAY: i64 = 86_400;
    let Some(v) = v else { return Val::Null };
    match v {
        Val::Str(s) => Temporal::parse(kind, s)
            .map(Val::Temporal)
            .unwrap_or(Val::Null),
        Val::Temporal(t) => match (kind, t) {
            ("date", Temporal::Date(_))
            | ("datetime", Temporal::DateTime(_))
            | ("duration", Temporal::Duration(_)) => Val::Temporal(*t),
            ("date", Temporal::DateTime(dt)) => Val::Temporal(Temporal::Date(Date {
                days: dt.secs.div_euclid(SECS_PER_DAY) as i32,
            })),
            ("datetime", Temporal::Date(d)) => Val::Temporal(Temporal::DateTime(DateTime {
                secs: d.days as i64 * SECS_PER_DAY,
                nanos: 0,
            })),
            _ => Val::Null, // e.g. duration(date) — no sensible conversion
        },
        _ => Val::Null,
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
        if !val_eq(
            &prop_of(graph, ctx, element, pc.key_ref),
            &eval(&env, &pc.value),
        ) {
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
        None => graph.vertex_indices().all(f),
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
    // A self-loop sits in both the out- and in-index of `v`, so an undirected
    // (`Both`) walk would yield it twice — once per side. The out-side already
    // emits it; drop it from the in-side (`a.nbr == v` ⇔ the far end is also `v`,
    // i.e. a self-loop). Directed In/Out keep it. The `!both` guard short-circuits
    // so directed traversal pays nothing.
    let both = matches!(direction, Direction::Both);
    out.into_iter()
        .flatten()
        .chain(
            inn.into_iter()
                .flatten()
                .filter(move |a| !both || a.nbr != v),
        )
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
    let go = satisfies(
        graph,
        ctx,
        &Val::Node(vi),
        &node.props,
        node.where_.as_ref(),
        binding,
    );
    let keep = if go { cont(binding) } else { true };
    if did_set {
        binding.unset(node.var_slot.unwrap());
    }
    keep
}

/// Endpoints of every *trail* — a path traversing each relationship at most once
/// (ISO/IEC 39075 default for a quantified path) — from `from` within [min, max]
/// hops of `rel`. One entry per trail, so an endpoint reached by `k` distinct
/// trails appears `k` times (ISO per-path multiplicity); `min == 0` includes the
/// zero-length trail (the start node).
///
/// Iterative (explicit stack) so a long chain can't overflow the native stack;
/// edge-uniqueness bounds trail length to the edge count, so it always
/// terminates on cycles. The *number* of trails can be exponential, so a
/// per-expansion step budget records a `FAULT_BUDGET` (→ `ResourceExhausted`)
/// and stops rather than exhausting memory/time.
fn reachable(graph: &Graph, ctx: &Ctx, from: u32, rel: &CRel, q: Quantifier) -> Vec<u32> {
    let collect = |v: u32| -> Vec<(u32, u32)> {
        expand(graph, ctx, v, rel.direction, rel.label.as_ref()).collect()
    };

    // Once the budget is blown, every later expansion short-circuits (the row
    // boundary will surface the fault) — otherwise each seed vertex would burn a
    // full budget before the query gives up.
    if ctx.faulted() {
        return Vec::new();
    }

    let mut ends: Vec<u32> = Vec::new();
    if q.min == 0 {
        ends.push(from);
    }

    // Edges on the *current* trail (size bounded by trail length, not graph
    // size — a dense `vec![false; edge_count]` would cost an O(E) alloc per seed
    // vertex, which dominates for short bounded quantifiers over many seeds).
    let mut used: HashSet<u32> = HashSet::new();
    let mut steps: u64 = 0;

    // Each frame walks one vertex's outgoing steps; `entry` is the edge taken to
    // reach it, unmarked when the frame pops (backtrack).
    struct Frame {
        edges: Vec<(u32, u32)>,
        idx: usize,
        depth: u32,
        entry: Option<u32>,
    }
    let mut stack: Vec<Frame> = vec![Frame {
        edges: collect(from),
        idx: 0,
        depth: 0,
        entry: None,
    }];

    while let Some(top) = stack.last_mut() {
        if q.max.is_some_and(|m| top.depth >= m) || top.idx >= top.edges.len() {
            if let Some(e) = top.entry {
                used.remove(&e);
            }
            stack.pop();
            continue;
        }

        let (eidx, nbr) = top.edges[top.idx];
        let depth = top.depth;
        top.idx += 1; // borrow of `stack` ends here (NLL)

        if used.contains(&eidx) {
            continue; // trail: each relationship traversed at most once
        }

        steps += 1;
        if steps > TRAIL_BUDGET {
            ctx.set_fault(FAULT_BUDGET);
            break;
        }

        used.insert(eidx);
        let d = depth + 1;
        if d >= q.min {
            ends.push(nbr);
        }

        stack.push(Frame {
            edges: collect(nbr),
            idx: 0,
            depth: d,
            entry: Some(eidx),
        });
    }

    ends
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
        let ok = satisfies(
            graph,
            ctx,
            &Val::Edge(eidx),
            &rel.props,
            rel.where_.as_ref(),
            binding,
        );
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
/// `where_` is the enclosing clause WHERE, threaded here only so the start node
/// can seed from a property index on a `WHERE var.k = $x` conjunct (in addition
/// to an inline `{k: $x}`); the full filter is still applied post-join.
fn visit_pattern(
    graph: &Graph,
    ctx: &Ctx,
    pattern: &CPath,
    where_: Option<&CExpr>,
    binding: &mut Binding,
    emit: &mut dyn FnMut(&mut Binding) -> bool,
) -> bool {
    let mut at_seed = |seed: u32, binding: &mut Binding| {
        match_node_then(graph, ctx, binding, &pattern.start, seed, &mut |b| {
            walk_segments(graph, ctx, pattern, 0, seed, b, emit)
        })
    };
    match pattern.start.var_slot {
        // An already-bound start variable fixes the single seed.
        Some(s) if binding.bound(s) => match binding.get(s) {
            Some(Val::Node(i)) => at_seed(*i, binding),
            _ => true,
        },
        // Otherwise prefer a property-index seek (indexed inline `{k:$x}` or a
        // `WHERE this.k=$x` conjunct), falling back to the label bucket / live
        // range. Without this, a comma-joined multi-pattern MATCH bails out of
        // every vectorized (seek-capable) path and full-scans *every* anchor —
        // the O(n) footgun R-SEED closes; `build_scan` already does this for the
        // single-pattern fast path. Postings are live-only in principle, but the
        // index can lag a delete, so re-check liveness (as `build_scan` does).
        //
        // Only a *named* start can carry a WHERE hint: `prop_index_hint`'s
        // slot filter treats a `None` slot as "any", so handing the clause WHERE
        // to an anonymous node (which WHERE can't even reference) would let it
        // seed on another var's conjunct. Inline props seed regardless — they're
        // this node's own.
        _ => match node_index_seed(
            graph,
            ctx,
            &pattern.start,
            pattern.start.var_slot.and(where_),
        ) {
            Some(cands) => {
                for seed in cands {
                    if graph.is_vertex_live(seed) && !at_seed(seed, binding) {
                        return false;
                    }
                }
                true
            }
            None => for_each_seed(graph, ctx, pattern.start.label.as_ref(), &mut |seed| {
                at_seed(seed, binding)
            }),
        },
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
    visit_pattern(graph, ctx, &patterns[idx], where_, binding, &mut |b| {
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
    let CClause::Match {
        optional,
        patterns,
        where_,
        scope_len,
        ..
    } = clause
    else {
        return true; // only MATCH clauses are streamed
    };
    binding.resize(*scope_len);
    let mut matched = false;
    let cont = visit_patterns(
        graph,
        ctx,
        patterns,
        0,
        where_.as_ref(),
        binding,
        &mut |b| {
            matched = true;
            drive_matches(graph, ctx, matches, idx + 1, b, sink)
        },
    );
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

// --- specialized single-path matcher (monomorphized, no per-segment dyn) -----
//
// The general matcher above passes `&mut dyn FnMut` down each segment, so a
// K-segment path does K dynamic calls per match. This generic variant inlines
// node/edge matching and recurses with the *same* `&mut F`, so it monomorphizes
// once per concrete sink and the per-edge hot loop has no dynamic dispatch — the
// dyn boundary collapses to a single call per emitted match. Used for the common
// shape: one MATCH clause, one path (quantifiers fine).

/// Match `node` at vertex `vi`; on success continue matching `path` from segment
/// `next_idx`. Restores the binding on backtrack. Generic over the sink `F`.
#[allow(
    clippy::too_many_arguments,
    reason = "recursive backtracking matcher; bundling its args into a struct would obscure the hot recursion"
)]
fn match_node_continue<F: FnMut(&mut Binding) -> bool>(
    graph: &Graph,
    ctx: &Ctx,
    binding: &mut Binding,
    node: &CNode,
    vi: u32,
    path: &CPath,
    next_idx: usize,
    emit: &mut F,
) -> bool {
    if !matches_label(graph, ctx, vi, node.label.as_ref()) {
        return true;
    }
    let Some(did) = bind_slot(binding, node.var_slot, &Val::Node(vi)) else {
        return true;
    };
    let go = satisfies(
        graph,
        ctx,
        &Val::Node(vi),
        &node.props,
        node.where_.as_ref(),
        binding,
    );
    let keep = if go {
        match_path(graph, ctx, path, next_idx, vi, binding, emit)
    } else {
        true
    };
    if did {
        binding.unset(node.var_slot.unwrap());
    }
    keep
}

/// Walk segments `idx..` of `path` from `from`, emitting each complete binding.
fn match_path<F: FnMut(&mut Binding) -> bool>(
    graph: &Graph,
    ctx: &Ctx,
    path: &CPath,
    idx: usize,
    from: u32,
    binding: &mut Binding,
    emit: &mut F,
) -> bool {
    if idx >= path.segments.len() {
        return emit(binding);
    }
    let CSegment { rel, node } = &path.segments[idx];
    if let Some(q) = rel.quantifier {
        for end in reachable(graph, ctx, from, rel, q) {
            if !match_node_continue(graph, ctx, binding, node, end, path, idx + 1, emit) {
                return false;
            }
        }
        return true;
    }
    for (eidx, nbr) in expand(graph, ctx, from, rel.direction, rel.label.as_ref()) {
        let Some(eset) = bind_slot(binding, rel.var_slot, &Val::Edge(eidx)) else {
            continue;
        };
        let keep = if satisfies(
            graph,
            ctx,
            &Val::Edge(eidx),
            &rel.props,
            rel.where_.as_ref(),
            binding,
        ) {
            match_node_continue(graph, ctx, binding, node, nbr, path, idx + 1, emit)
        } else {
            true
        };
        if eset {
            binding.unset(rel.var_slot.unwrap());
        }
        if !keep {
            return false;
        }
    }
    true
}

/// Seed and match a single path, emitting each complete binding via `emit`.
fn match_one_path<F: FnMut(&mut Binding) -> bool>(
    graph: &Graph,
    ctx: &Ctx,
    path: &CPath,
    binding: &mut Binding,
    emit: &mut F,
) -> bool {
    match path.start.var_slot {
        Some(sl) if binding.bound(sl) => match binding.get(sl) {
            Some(Val::Node(i)) => {
                match_node_continue(graph, ctx, binding, &path.start, *i, path, 0, emit)
            }
            _ => true,
        },
        _ => match path.start.label.as_ref().and_then(seed_label) {
            Some(r) => match ctx.labels[r].0 {
                Some(lid) => {
                    let seeds = graph.vertices_with_label(lid);
                    for &s in seeds {
                        if !match_node_continue(graph, ctx, binding, &path.start, s, path, 0, emit)
                        {
                            return false;
                        }
                    }
                    true
                }
                None => true,
            },
            None => {
                for s in graph.vertex_indices() {
                    if !match_node_continue(graph, ctx, binding, &path.start, s, path, 0, emit) {
                        return false;
                    }
                }
                true
            }
        },
    }
}

/// Recognize the common shape a single MATCH clause + single path so the
/// monomorphized matcher can drive it directly (returns path, clause WHERE, and
/// the binding slot count to size the working binding).
type SimpleWhere<'a> = (&'a CPath, Option<&'a CExpr>, Option<&'a Program>, usize);
fn single_simple_clause<'a>(matches: &[&'a CClause]) -> Option<SimpleWhere<'a>> {
    if matches.len() != 1 {
        return None;
    }
    match matches[0] {
        CClause::Match {
            optional: false,
            patterns,
            where_,
            where_prog,
            scope_len,
        } if patterns.len() == 1 => Some((
            &patterns[0],
            where_.as_ref(),
            where_prog.as_ref(),
            *scope_len,
        )),
        _ => None,
    }
}

/// Evaluate a fast-path clause WHERE (`true` = keep the row), per [`USE_VM`].
#[inline]
fn where_keep(env: &Env, cw: Option<&CExpr>, cwp: Option<&Program>) -> bool {
    if USE_VM {
        cwp.is_none_or(|w| as_truth(&run(env, w)) == Some(true))
    } else {
        cw.is_none_or(|w| as_truth(&eval(env, w)) == Some(true))
    }
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
        Self {
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
                if self
                    .extreme
                    .as_ref()
                    .is_none_or(|m| cmp_total(&val, m) == Ordering::Less)
                {
                    self.extreme = Some(val);
                }
            }
            AggFn::Max => {
                if self
                    .extreme
                    .as_ref()
                    .is_none_or(|m| cmp_total(&val, m) == Ordering::Greater)
                {
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
fn step_aggs(
    aggs: &mut [Agg],
    specs: &[super::plan::CAgg],
    graph: &Graph,
    ctx: &Ctx,
    binding: &Binding,
) {
    for (agg, spec) in aggs.iter_mut().zip(specs) {
        let v = spec
            .arg
            .as_ref()
            .map(|a| eval(&Env::new(graph, ctx, binding), a));
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

    fn project_row(
        &self,
        graph: &Graph,
        ctx: &Ctx,
        input: &Binding,
        agg_values: Option<&[Val]>,
    ) -> Binding {
        let proj = self.proj;
        let mut out = Binding(vec![None; proj.out_len]);
        if proj.star {
            for (i, &islot) in proj.star_cols.iter().enumerate() {
                if let Some(v) = input.get(islot) {
                    out.0[i] = Some(v.clone());
                }
            }
        } else {
            let env = Env {
                graph,
                ctx,
                binding: input,
                group: None,
                agg_values,
            };
            for (i, item) in proj.items.iter().enumerate() {
                out.0[i] = Some(eval_item(&env, item));
            }
        }
        out
    }

    fn sort_keys(
        &self,
        graph: &Graph,
        ctx: &Ctx,
        input: &Binding,
        projected: &Binding,
        agg_values: Option<&[Val]>,
    ) -> Vec<Val> {
        let proj = self.proj;
        if proj.order_by.is_empty() {
            return Vec::new();
        }
        let mut sort_binding = projected.clone();
        for &islot in &proj.order_overlay {
            sort_binding.0.push(input.get(islot).cloned());
        }
        let env = Env {
            graph,
            ctx,
            binding: &sort_binding,
            group: None,
            agg_values,
        };
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
                let env = Env {
                    graph,
                    ctx,
                    binding: &self.sort_scratch,
                    group: None,
                    agg_values: None,
                };
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
                self.rows
                    .select_nth_unstable_by(cap - 1, |a, b| cmp_keyed(a, b, &proj.order_by));
                self.rows.truncate(cap);
                self.threshold = Some(self.rows[cap - 1].1.clone());
            }
            return true;
        }
        if proj.aggregating {
            if !self.grouped {
                // Global aggregate: one accumulator set, no key/map per row.
                let entry = self.global.get_or_insert_with(|| {
                    (binding.clone(), proj.aggs.iter().map(Agg::new).collect())
                });
                step_aggs(&mut entry.1, &proj.aggs, graph, ctx, binding);
                return true;
            }
            // Build the group key into the reused buffer.
            self.key_buf.clear();
            {
                let env = Env::new(graph, ctx, binding);
                for item in proj.items.iter().filter(|i| !i.is_agg) {
                    val_key(&eval_item(&env, item), &mut self.key_buf);
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
                    self.groups
                        .insert(self.key_buf.clone(), (binding.clone(), aggs));
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
                let (rep, aggs) = self.global.take().unwrap_or_else(|| {
                    (Binding::default(), proj.aggs.iter().map(Agg::new).collect())
                });
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
                self.rows
                    .select_nth_unstable_by(cap - 1, |a, b| cmp_keyed(a, b, &proj.order_by));
                self.rows.truncate(cap);
            }
            let buf = std::mem::take(&mut self.rows);
            self.rows = buf
                .into_iter()
                .map(|(inb, keys)| (self.project_row(graph, ctx, &inb, None), keys))
                .collect();
        }
        if !proj.order_by.is_empty() {
            let cmp =
                |a: &(Binding, Vec<Val>), b: &(Binding, Vec<Val>)| cmp_keyed(a, b, &proj.order_by);
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
    if USE_VEC {
        if let Some(cols) = vectorized_cols(graph, ctx, incoming, matches, proj) {
            // WITH stage: carry output forward as bindings, *preserving* element
            // handles (a carried node stays `Val::Node`, not flattened to an id).
            let nrows = cols.first().map_or(0, |c| c.len());
            return (0..nrows)
                .map(|i| Binding(cols.iter().map(|c| Some(c[i].clone())).collect()))
                .collect();
        }
    }
    let mut acc = ProjAccum::new(proj);
    let simple = single_simple_clause(matches);
    for inb in incoming {
        let mut work = inb.clone();
        let cont = match simple {
            Some((path, cwhere, cwhere_prog, scope_len)) => {
                work.resize(scope_len);
                match_one_path(graph, ctx, path, &mut work, &mut |b| {
                    if !where_keep(&Env::new(graph, ctx, b), cwhere, cwhere_prog) {
                        return true;
                    }
                    acc.accept(graph, ctx, b)
                })
            }
            None => drive_matches(graph, ctx, matches, 0, &mut work, &mut |b| {
                acc.accept(graph, ctx, b)
            }),
        };
        if !cont {
            break;
        }
    }
    acc.finish(graph, ctx)
}

// --- vectorized (batched) node scan -----------------------------------------
//
// One operation across the whole matched row set instead of per row. A column
// of evaluated values; numeric data is a flat `Vec<f64>` with a validity mask
// so arithmetic/comparison loops stay branch-light and autovectorizable. Three
// representations: numeric, three-valued boolean, and a `Gen` escape hatch for
// anything outside the numeric subset (strings, CASE, identity, subqueries),
// evaluated per row by the scalar `eval` for just that column.
enum VVec {
    Num { d: Vec<f64>, valid: Vec<bool> },
    Bool { t: Vec<bool>, valid: Vec<bool> },
    Gen(Vec<Val>),
}

impl VVec {
    /// Coerce to numeric (`num_of` semantics): invalid where the source is null.
    fn into_num(self) -> (Vec<f64>, Vec<bool>) {
        match self {
            Self::Num { d, valid } => (d, valid),
            Self::Bool { t, valid } => (
                t.iter().map(|&b| if b { 1.0 } else { 0.0 }).collect(),
                valid,
            ),
            Self::Gen(vs) => {
                let mut d = Vec::with_capacity(vs.len());
                let mut valid = Vec::with_capacity(vs.len());
                for v in &vs {
                    match num_of(v) {
                        Some(x) => {
                            d.push(x);
                            valid.push(true);
                        }
                        None => {
                            d.push(f64::NAN);
                            valid.push(false);
                        }
                    }
                }
                (d, valid)
            }
        }
    }

    /// Per-row Kleene truth (for WHERE and boolean connectives).
    fn into_truth(self) -> Vec<Truth> {
        match self {
            Self::Bool { t, valid } => t
                .iter()
                .zip(&valid)
                .map(|(&b, &v)| v.then_some(b))
                .collect(),
            Self::Num { d, valid } => d
                .iter()
                .zip(&valid)
                .map(|(&x, &v)| v.then_some(x != 0.0 && !x.is_nan()))
                .collect(),
            Self::Gen(vs) => vs.iter().map(as_truth).collect(),
        }
    }

    /// Convert directly to a typed Arrow column — `Num`/`Bool` move their `f64`/
    /// `bool` buffers in with no `Val` boxing; `Gen` flattens its `Val`s (elements
    /// → ids) and infers the physical type. This is the boxing-free result path.
    #[cfg(feature = "arrow")]
    fn into_arrow(self, graph: &Graph) -> ArrowColumn {
        let opt = |v: Vec<bool>| if v.iter().all(|&b| b) { None } else { Some(v) };
        match self {
            Self::Num { d, valid } => ArrowColumn::Num {
                data: d,
                valid: opt(valid),
            },
            Self::Bool { t, valid } => ArrowColumn::Bool {
                data: t,
                valid: opt(valid),
            },
            Self::Gen(vals) => {
                let values: Vec<Value> = vals.iter().map(|v| val_to_value(graph, v)).collect();
                ArrowColumn::from_values(values.iter())
            }
        }
    }

    /// Keep only rows `[start, end)` (for SKIP/LIMIT on a typed column). Only the
    /// Arrow fast path slices typed columns; the RowSet path slices `ScanCols`.
    #[cfg(feature = "arrow")]
    fn slice(self, start: usize, end: usize) -> Self {
        match self {
            Self::Num { d, valid } => Self::Num {
                d: d[start..end].to_vec(),
                valid: valid[start..end].to_vec(),
            },
            Self::Bool { t, valid } => Self::Bool {
                t: t[start..end].to_vec(),
                valid: valid[start..end].to_vec(),
            },
            Self::Gen(v) => Self::Gen(v[start..end].to_vec()),
        }
    }

    /// Final per-row output values (for projection cells).
    fn into_vals(self) -> Vec<Val> {
        match self {
            Self::Num { d, valid } => d
                .iter()
                .zip(&valid)
                .map(|(&x, &v)| if v { Val::Num(x) } else { Val::Null })
                .collect(),
            Self::Bool { t, valid } => t
                .iter()
                .zip(&valid)
                .map(|(&b, &v)| if v { Val::Bool(b) } else { Val::Null })
                .collect(),
            Self::Gen(vs) => vs,
        }
    }
}

/// A unary math `ScalarFn` over f64, if `func` is one (so it vectorizes).
fn unary_math(func: ScalarFn) -> Option<fn(f64) -> f64> {
    use ScalarFn::*;
    Some(match func {
        Abs => f64::abs,
        Ceil => f64::ceil,
        Floor => f64::floor,
        Sqrt => f64::sqrt,
        Exp => f64::exp,
        Ln => f64::ln,
        Log10 => f64::log10,
        Sin => f64::sin,
        Cos => f64::cos,
        Tan => f64::tan,
        Asin => f64::asin,
        Acos => f64::acos,
        Atan => f64::atan,
        Sinh => f64::sinh,
        Cosh => f64::cosh,
        Tanh => f64::tanh,
        Degrees => f64::to_degrees,
        Radians => f64::to_radians,
        _ => return None,
    })
}

/// Which element kind a scanned binding slot holds (so a `Prop` reads the right
/// property store — vertex vs edge — at that slot's per-row ids).
#[derive(Clone, Copy, PartialEq)]
enum Elem {
    Node,
    Edge,
}

/// The matched row set as parallel columns. Each binding slot is either an
/// *element* column (kind + per-row dense id — fast to gather props from, and the
/// only thing a traversal can expand) or, once a `WITH` projects computed values,
/// a *value* column (per-row `Val`). A "row" is one full match. This is what
/// every vectorized expression reads from, so traversals (`a`, `r`, `b` slots)
/// and a single-node scan (`n` slot) look the same — just more slots — and a
/// pipeline `WITH` can carry elements forward as fast columns while adding
/// computed value columns beside them.
struct ScanCols {
    n: usize,
    slots: Vec<Option<(Elem, Vec<u32>)>>,
    /// Computed value columns, parallel to `slots` (set only post-projection).
    vals: Vec<Option<Vec<Val>>>,
}

impl ScanCols {
    fn new(scope_len: usize) -> Self {
        let w = scope_len.max(1);
        Self {
            n: 0,
            slots: (0..w).map(|_| None).collect(),
            vals: (0..w).map(|_| None).collect(),
        }
    }
    fn slot(&self, s: usize) -> Option<(Elem, &[u32])> {
        self.slots
            .get(s)
            .and_then(|o| o.as_ref())
            .map(|(e, v)| (*e, v.as_slice()))
    }
    fn val_slot(&self, s: usize) -> Option<&[Val]> {
        self.vals.get(s).and_then(|o| o.as_deref())
    }
}

/// Gather a numeric `Column` at `ids` into a `VVec::Num` (+ validity mask), or
/// `None` if the column isn't numeric (caller then falls back to per-row `Gen`).
fn gather_num(col: Option<&Column>, ids: &[u32]) -> Option<VVec> {
    match col {
        Some(Column::Num { data, present }) => {
            let mut d = Vec::with_capacity(ids.len());
            let mut valid = Vec::with_capacity(ids.len());
            for &vi in ids {
                let i = vi as usize;
                d.push(data[i]);
                valid.push(present.get(i));
            }
            Some(VVec::Num { d, valid })
        }
        _ => None,
    }
}

/// Scalar fallback: evaluate `e` once per row into a `Vec<Val>` (the slow path
/// for any subexpression outside the numeric vector subset). Reuses one binding,
/// setting every scanned slot to its per-row element.
fn scalar_col(graph: &Graph, ctx: &Ctx, sc: &ScanCols, e: &CExpr) -> Vec<Val> {
    let mut b = Binding(vec![None; sc.slots.len()]);
    (0..sc.n)
        .map(|i| {
            for (slot, col) in sc.slots.iter().enumerate() {
                if let Some((elem, ids)) = col {
                    b.set(
                        slot,
                        match elem {
                            Elem::Node => Val::Node(ids[i]),
                            Elem::Edge => Val::Edge(ids[i]),
                        },
                    );
                } else if let Some(vals) = &sc.vals[slot] {
                    b.set(slot, vals[i].clone());
                }
            }
            eval(&Env::new(graph, ctx, &b), e)
        })
        .collect()
}

/// Evaluate `e` over the whole matched row set `sc`. Numeric and boolean
/// subtrees stay vectorized; everything else degrades to a per-row `Gen` column.
fn eval_vec(graph: &Graph, ctx: &Ctx, sc: &ScanCols, e: &CExpr) -> VVec {
    let n = sc.n;
    let gen = |e: &CExpr| VVec::Gen(scalar_col(graph, ctx, sc, e));
    match e {
        CExpr::Lit(Lit::Num(x)) => VVec::Num {
            d: vec![*x; n],
            valid: vec![true; n],
        },
        CExpr::Lit(Lit::Bool(b)) => VVec::Bool {
            t: vec![*b; n],
            valid: vec![true; n],
        },
        CExpr::Lit(Lit::Null) => VVec::Num {
            d: vec![f64::NAN; n],
            valid: vec![false; n],
        },
        // A bare variable: a carried value column is taken directly (no per-row
        // binding rebuild); an element column becomes a column of element handles.
        CExpr::Var(slot) => {
            if let Some(v) = sc.val_slot(*slot) {
                VVec::Gen(v.to_vec())
            } else if let Some((elem, ids)) = sc.slot(*slot) {
                VVec::Gen(
                    ids.iter()
                        .map(|&i| match elem {
                            Elem::Node => Val::Node(i),
                            Elem::Edge => Val::Edge(i),
                        })
                        .collect(),
                )
            } else {
                VVec::Gen(vec![Val::Null; n])
            }
        }
        CExpr::Prop { var_slot, key_ref } => match sc.slot(*var_slot) {
            Some((Elem::Node, ids)) => gather_num(
                ctx.prop_keys[*key_ref]
                    .0
                    .and_then(|k| graph.props.cols.get(k as usize)),
                ids,
            )
            .unwrap_or_else(|| gen(e)),
            Some((Elem::Edge, ids)) => gather_num(
                ctx.prop_keys[*key_ref]
                    .1
                    .and_then(|k| graph.edge_props.cols.get(k as usize)),
                ids,
            )
            .unwrap_or_else(|| gen(e)),
            None => gen(e),
        },
        CExpr::Neg(x) => {
            let v = eval_vec(graph, ctx, sc, x);
            // A non-numeric operand → scalar fallback, which raises the type error.
            if matches!(v, VVec::Gen(_)) {
                gen(e)
            } else {
                let (mut d, valid) = v.into_num();
                for v in &mut d {
                    *v = -*v;
                }
                VVec::Num { d, valid }
            }
        }
        CExpr::Arith { op, left, right } => {
            let l = eval_vec(graph, ctx, sc, left);
            let r = eval_vec(graph, ctx, sc, right);
            // A non-numeric operand (general column) → scalar fallback, which
            // raises the ISO type error per-row rather than coercing to NaN.
            if matches!(l, VVec::Gen(_)) || matches!(r, VVec::Gen(_)) {
                gen(e)
            } else {
                let (ld, lv) = l.into_num();
                let (rd, rv) = r.into_num();
                // ISO: division/modulo by a zero divisor is a data exception. Scan
                // (a separate, vectorizable pass) so the arithmetic loop below
                // stays autovectorizable.
                if matches!(op, ArithOp::Div | ArithOp::Mod) {
                    for i in 0..n {
                        if rv[i] && rd[i] == 0.0 {
                            ctx.set_fault(FAULT_DIV_ZERO);
                            break;
                        }
                    }
                }
                let mut d = Vec::with_capacity(n);
                for i in 0..n {
                    d.push(match op {
                        ArithOp::Add => ld[i] + rd[i],
                        ArithOp::Sub => ld[i] - rd[i],
                        ArithOp::Mul => ld[i] * rd[i],
                        ArithOp::Div => ld[i] / rd[i],
                        ArithOp::Mod => ld[i] % rd[i],
                    });
                }
                let valid = (0..n).map(|i| lv[i] && rv[i]).collect();
                VVec::Num { d, valid }
            }
        }
        CExpr::Compare { op, left, right } => {
            let l = eval_vec(graph, ctx, sc, left);
            let r = eval_vec(graph, ctx, sc, right);
            // Numeric fast path when both sides are numeric/boolean; otherwise the
            // comparison may be over strings/identity → scalar fallback.
            match (&l, &r) {
                (VVec::Gen(_), _) | (_, VVec::Gen(_)) => gen(e),
                _ => {
                    let (ld, lv) = l.into_num();
                    let (rd, rv) = r.into_num();
                    let mut t = Vec::with_capacity(n);
                    let mut valid = Vec::with_capacity(n);
                    for i in 0..n {
                        valid.push(lv[i] && rv[i]);
                        let a = ld[i];
                        let b = rd[i];
                        t.push(match op {
                            CompareOp::Eq => a == b,
                            CompareOp::Ne => a != b,
                            CompareOp::Lt => a < b,
                            CompareOp::Gt => a > b,
                            CompareOp::Le => a <= b,
                            CompareOp::Ge => a >= b,
                        });
                    }
                    VVec::Bool { t, valid }
                }
            }
        }
        CExpr::Scalar { func, args } if args.len() == 1 && unary_math(*func).is_some() => {
            let f = unary_math(*func).unwrap();
            let (mut d, valid) = eval_vec(graph, ctx, sc, &args[0]).into_num();
            for v in &mut d {
                *v = f(*v);
            }
            VVec::Num { d, valid }
        }
        CExpr::Not(x) => {
            let tr = eval_vec(graph, ctx, sc, x).into_truth();
            kleene_vec(tr.iter().map(|&t| not3(t)))
        }
        CExpr::And(l, r) => {
            let a = eval_vec(graph, ctx, sc, l).into_truth();
            let b = eval_vec(graph, ctx, sc, r).into_truth();
            kleene_vec((0..n).map(|i| and3(a[i], b[i])))
        }
        CExpr::Or(l, r) => {
            let a = eval_vec(graph, ctx, sc, l).into_truth();
            let b = eval_vec(graph, ctx, sc, r).into_truth();
            kleene_vec((0..n).map(|i| or3(a[i], b[i])))
        }
        CExpr::Xor(l, r) => {
            let a = eval_vec(graph, ctx, sc, l).into_truth();
            let b = eval_vec(graph, ctx, sc, r).into_truth();
            kleene_vec((0..n).map(|i| xor3(a[i], b[i])))
        }
        CExpr::IsNull { expr, negated } => {
            let (_, valid) = eval_vec(graph, ctx, sc, expr).into_num();
            let t = valid
                .iter()
                .map(|&v| if *negated { v } else { !v })
                .collect();
            VVec::Bool {
                t,
                valid: vec![true; n],
            }
        }
        _ => gen(e),
    }
}

/// Build a `VVec::Bool` from a Kleene-truth stream (`None` → invalid/UNKNOWN).
fn kleene_vec(it: impl Iterator<Item = Truth>) -> VVec {
    let mut t = Vec::new();
    let mut valid = Vec::new();
    for tr in it {
        match tr {
            Some(b) => {
                t.push(b);
                valid.push(true);
            }
            None => {
                t.push(false);
                valid.push(false);
            }
        }
    }
    VVec::Bool { t, valid }
}

/// Materialize the matched rows of a fixed-length path into columns. An isolated
/// node is a tight label-bucket scan; a traversal is a batched adjacency
/// expansion — walk each frontier node's edges and push straight into the
/// columns, multiplying rows by matching neighbors, with no matcher recursion or
/// per-edge bind/unset. Returns `None` (→ scalar path) for var-length
/// quantifiers or a slot a path binds twice (a self-join). `cap` stops early.
fn lit_to_idxkey(lit: &Lit) -> Option<crate::graph::IdxKey> {
    use crate::graph::IdxKey;
    match lit {
        Lit::Str(s) => Some(IdxKey::Str(s.as_str().into())),
        Lit::Num(n) => Some(IdxKey::Num(*n)),
        Lit::Bool(b) => Some(IdxKey::Bool(*b)),
        // Temporals aren't index-key-able yet (no temporal range index) — a
        // temporal comparison falls back to a scan.
        Lit::Null | Lit::Temporal(_) => None,
    }
}

/// A runtime value as an index key (nulls/lists/elements aren't indexable).
fn val_to_idxkey(v: &Val) -> Option<crate::graph::IdxKey> {
    use crate::graph::IdxKey;
    match v {
        Val::Str(s) => Some(IdxKey::Str(s.as_ref().into())),
        Val::Num(n) => Some(IdxKey::Num(*n)),
        Val::Bool(b) => Some(IdxKey::Bool(*b)),
        _ => None,
    }
}

/// The index key an expression contributes to a seek: an inline literal, or a
/// `$param` resolved against the current bindings at execute time. Resolving
/// params here is what lets `WHERE v.k = $x` (not just `= 'lit'`) hit the index —
/// matching the TS engine, whose planner seeks on params too.
fn expr_to_idxkey(e: &CExpr, ctx: &Ctx) -> Option<crate::graph::IdxKey> {
    match e {
        CExpr::Lit(lit) => lit_to_idxkey(lit),
        CExpr::Param(slot) => val_to_idxkey(ctx.params.get(*slot)?),
        _ => None,
    }
}

/// A `var.key OP <literal-or-$param>` comparison, as (var slot, key ref, op,
/// resolved index key). The RHS is resolved via [`expr_to_idxkey`] so params
/// seek as well as literals.
fn cmp_bound(e: &CExpr, ctx: &Ctx) -> Option<(usize, usize, CompareOp, crate::graph::IdxKey)> {
    if let CExpr::Compare { op, left, right } = e {
        if let CExpr::Prop { var_slot, key_ref } = left.as_ref() {
            let key = expr_to_idxkey(right, ctx)?;
            return Some((*var_slot, *key_ref, *op, key));
        }
    }
    None
}

/// Apply one comparison to a range bound (`Eq` clamps both ends).
fn apply_bound(rb: &mut crate::graph::RangeBound, op: CompareOp, k: crate::graph::IdxKey) {
    match op {
        CompareOp::Gt => rb.gt = Some(k),
        CompareOp::Ge => rb.gte = Some(k),
        CompareOp::Lt => rb.lt = Some(k),
        CompareOp::Le => rb.lte = Some(k),
        CompareOp::Eq => {
            rb.gte = Some(k.clone());
            rb.lte = Some(k);
        }
        CompareOp::Ne => {}
    }
}

// --- vertex/edge-agnostic index seeks (dispatched by an `edge` flag) ---------
fn idx_indexed(graph: &Graph, name: &str, edge: bool) -> bool {
    if edge {
        graph.edge_indexed(name)
    } else {
        graph.vertex_indexed(name)
    }
}
fn idx_eq(graph: &Graph, name: &str, k: &crate::graph::IdxKey, edge: bool) -> Option<Vec<u32>> {
    if edge {
        graph.edges_by_prop(name, k).map(<[u32]>::to_vec)
    } else {
        graph.vertices_by_prop(name, k).map(<[u32]>::to_vec)
    }
}
fn idx_range(
    graph: &Graph,
    name: &str,
    rb: &crate::graph::RangeBound,
    edge: bool,
) -> Option<Vec<u32>> {
    if edge {
        graph.edges_by_prop_range(name, rb)
    } else {
        graph.vertices_by_prop_range(name, rb)
    }
}
/// The property name a `Prop` key-ref resolves to (vertex or edge store).
fn prop_name<'a>(graph: &'a Graph, ctx: &Ctx, key_ref: usize, edge: bool) -> Option<&'a str> {
    let (vk, ek) = ctx.prop_keys[key_ref];
    if edge {
        Some(graph.edge_props.keys.text(ek?))
    } else {
        Some(graph.props.keys.text(vk?))
    }
}

/// An index seek from a WHERE comparison `var.key OP <literal>` where `var` is at
/// `want_slot` (`None` = any), against the vertex or edge index. An `AND` of two
/// same-var/same-key comparisons coalesces into one tight range seek; else the
/// first usable conjunct. Returns candidate element ids.
fn prop_index_hint(
    graph: &Graph,
    ctx: &Ctx,
    e: &CExpr,
    want_slot: Option<usize>,
    edge: bool,
) -> Option<Vec<u32>> {
    use crate::graph::RangeBound;
    let slot_ok = |s: usize| want_slot.is_none_or(|w| w == s);
    match e {
        CExpr::Compare { .. } => {
            let (vslot, key_ref, op, key) = cmp_bound(e, ctx)?;
            if !slot_ok(vslot) {
                return None;
            }
            let name = prop_name(graph, ctx, key_ref, edge)?;
            if !idx_indexed(graph, name, edge) {
                return None;
            }
            if op == CompareOp::Eq {
                return idx_eq(graph, name, &key, edge);
            }
            let mut rb = RangeBound::default();
            apply_bound(&mut rb, op, key);
            idx_range(graph, name, &rb, edge)
        }
        CExpr::And(a, b) => {
            if let (Some((s1, k1, o1, key1)), Some((s2, k2, o2, key2))) =
                (cmp_bound(a, ctx), cmp_bound(b, ctx))
            {
                if s1 == s2 && k1 == k2 && slot_ok(s1) {
                    if let Some(name) = prop_name(graph, ctx, k1, edge) {
                        if idx_indexed(graph, name, edge) {
                            let mut rb = RangeBound::default();
                            apply_bound(&mut rb, o1, key1);
                            apply_bound(&mut rb, o2, key2);
                            return idx_range(graph, name, &rb, edge);
                        }
                    }
                }
            }
            prop_index_hint(graph, ctx, a, want_slot, edge)
                .or_else(|| prop_index_hint(graph, ctx, b, want_slot, edge))
        }
        _ => None,
    }
}

/// Candidate vertices for a single-node scan: an indexed inline `{key: lit}`
/// equality, or a WHERE comparison on the node. `None` ⇒ full scan.
fn node_index_seed(
    graph: &Graph,
    ctx: &Ctx,
    node: &CNode,
    where_: Option<&CExpr>,
) -> Option<Vec<u32>> {
    for pc in &node.props {
        if graph.vertex_indexed(&pc.key) {
            // Inline `{key: lit}` OR `{key: $param}` — both resolve to a seek.
            if let Some(k) = expr_to_idxkey(&pc.value, ctx) {
                return graph.vertices_by_prop(&pc.key, &k).map(<[u32]>::to_vec);
            }
        }
    }
    where_.and_then(|w| prop_index_hint(graph, ctx, w, node.var_slot, false))
}

/// Candidate edges for a single-segment pattern: an indexed inline `[r {key:lit}]`
/// equality, or a WHERE comparison on the relationship var. `None` ⇒ no edge seed.
/// Seed the candidate edges of a pattern's relationship from the always-on edge
/// **type** index (`by_etype`) — the analogue of seeding a node scan from its
/// label bucket. Handles a single type `:T` (one bucket) and a disjunction
/// `:A|B` (union of buckets; an edge has one type, so the buckets are disjoint).
/// A missing type name yields an empty seed (no edge matches — itself a win).
/// `And`/`Not`/wildcard fall through to `None` (no cheap enumeration / no gain).
fn etype_label_seed(graph: &Graph, ctx: &Ctx, expr: &CLabelExpr) -> Option<Vec<u32>> {
    match expr {
        CLabelExpr::Label(r) => Some(
            ctx.labels[*r]
                .1
                .map_or_else(Vec::new, |t| graph.edges_with_etype(t).to_vec()),
        ),
        CLabelExpr::Or(l, r) => {
            let mut a = etype_label_seed(graph, ctx, l)?;
            a.extend(etype_label_seed(graph, ctx, r)?);
            Some(a)
        }
        _ => None,
    }
}

fn edge_index_seed(
    graph: &Graph,
    ctx: &Ctx,
    rel: &CRel,
    where_: Option<&CExpr>,
) -> Option<Vec<u32>> {
    for pc in &rel.props {
        if graph.edge_indexed(&pc.key) {
            if let CExpr::Lit(lit) = &pc.value {
                if let Some(k) = lit_to_idxkey(lit) {
                    return graph.edges_by_prop(&pc.key, &k).map(<[u32]>::to_vec);
                }
            }
        }
    }
    // Prefer a (usually more selective) property hint; otherwise seed from the
    // edge type. edge_first_build re-validates label + props, so a type seed is
    // a correct superset for any extra constraints.
    where_
        .and_then(|w| prop_index_hint(graph, ctx, w, rel.var_slot, true))
        .or_else(|| {
            rel.label
                .as_ref()
                .and_then(|lbl| etype_label_seed(graph, ctx, lbl))
        })
}

/// Whether `build_scan` will turn this scan into an index seek (so a LIMIT cap
/// can't early-stop it and should be dropped).
fn scan_is_hinted(graph: &Graph, ctx: &Ctx, path: &CPath, where_: Option<&CExpr>) -> bool {
    if path.segments.is_empty() {
        node_index_seed(graph, ctx, &path.start, where_).is_some()
    } else if path.segments.len() == 1 {
        edge_index_seed(graph, ctx, &path.segments[0].rel, where_).is_some()
    } else {
        false
    }
}

fn build_scan(
    graph: &Graph,
    ctx: &Ctx,
    path: &CPath,
    scope_len: usize,
    cap: Option<usize>,
    where_: Option<&CExpr>,
) -> Option<ScanCols> {
    // Fast path: an isolated node is a tight scan. An index hint (inline `{k:v}`
    // eq or a WHERE comparison on the node) seeds just the candidate vertices;
    // otherwise the label bucket / all-live range. Either way the node's label +
    // inline constraints are re-checked.
    if path.segments.is_empty() {
        let node = &path.start;
        let seed = node_index_seed(graph, ctx, node, where_);
        let mut ids = Vec::new();
        let needs_check = !node.props.is_empty() || node.where_.is_some();
        let mut b = Binding(vec![None; scope_len.max(1)]);
        let consider = |graph: &Graph, vi: u32, ids: &mut Vec<u32>, b: &mut Binding| -> bool {
            if !matches_label(graph, ctx, vi, node.label.as_ref()) {
                return true;
            }
            if needs_check {
                if let Some(s) = node.var_slot {
                    b.set(s, Val::Node(vi));
                }
                if !satisfies(
                    graph,
                    ctx,
                    &Val::Node(vi),
                    &node.props,
                    node.where_.as_ref(),
                    b,
                ) {
                    return true;
                }
            }
            ids.push(vi);
            cap.is_none_or(|c| ids.len() < c)
        };
        match seed {
            Some(cands) => {
                for vi in cands {
                    if graph.is_vertex_live(vi) && !consider(graph, vi, &mut ids, &mut b) {
                        break;
                    }
                }
            }
            None => {
                for_each_seed(graph, ctx, node.label.as_ref(), &mut |vi| {
                    consider(graph, vi, &mut ids, &mut b)
                });
            }
        }
        let mut sc = ScanCols::new(scope_len);
        sc.n = ids.len();
        if let Some(s) = node.var_slot {
            sc.slots[s] = Some((Elem::Node, ids));
        }
        return Some(sc);
    }
    if path.segments.iter().any(|s| s.rel.quantifier.is_some()) {
        return None;
    }
    // Edge-first: a single segment with an indexed edge-property hint → seek the
    // matching edges and validate the surrounding (a)-[r]->(b) pattern, instead
    // of expanding every vertex's adjacency.
    if path.segments.len() == 1 {
        if let Some(edges) = edge_index_seed(graph, ctx, &path.segments[0].rel, where_) {
            return edge_first_build(graph, ctx, path, scope_len, &edges);
        }
    }
    // Bound slots and their element kind, in path order.
    let mut kinds: Vec<(usize, Elem)> = Vec::new();
    if let Some(s) = path.start.var_slot {
        kinds.push((s, Elem::Node));
    }
    for seg in &path.segments {
        if let Some(s) = seg.rel.var_slot {
            kinds.push((s, Elem::Edge));
        }
        if let Some(s) = seg.node.var_slot {
            kinds.push((s, Elem::Node));
        }
    }
    let mut seen = HashSet::new();
    if kinds.iter().any(|(s, _)| !seen.insert(*s)) {
        return None; // a slot bound twice (self-join) — not vectorized
    }

    // Per-bound-slot columns built so far; `endpoint` is the current last-node id
    // per row (tracked even for anonymous nodes, to expand the next segment).
    let mut cols: Vec<Option<Vec<u32>>> = (0..scope_len.max(1)).map(|_| None).collect();
    for &(s, _) in &kinds {
        cols[s] = Some(Vec::new());
    }
    let mut endpoint: Vec<u32> = Vec::new();

    // Which slots are populated so far. A later segment's rel/node slots are in
    // `kinds` (and pre-allocated in `cols`) but their columns stay empty until
    // that segment runs, so the per-row copy loops below must skip them.
    let mut bound = vec![false; scope_len.max(1)];
    if let Some(s) = path.start.var_slot {
        bound[s] = true;
    }

    // Seed from the start node (label + inline props/WHERE).
    let start = &path.start;
    let start_check = !start.props.is_empty() || start.where_.is_some();
    let mut sb = Binding(vec![None; scope_len.max(1)]);
    for_each_seed(graph, ctx, start.label.as_ref(), &mut |vi| {
        if !matches_label(graph, ctx, vi, start.label.as_ref()) {
            return true;
        }
        if start_check {
            if let Some(s) = start.var_slot {
                sb.set(s, Val::Node(vi));
            }
            if !satisfies(
                graph,
                ctx,
                &Val::Node(vi),
                &start.props,
                start.where_.as_ref(),
                &sb,
            ) {
                return true;
            }
        }
        endpoint.push(vi);
        if let Some(s) = start.var_slot {
            cols[s].as_mut().unwrap().push(vi);
        }
        true
    });

    // Expand each segment: every frontier row fans out to its matching neighbors,
    // replicating the already-bound columns and appending this segment's ids.
    let nseg = path.segments.len();
    let mut nb = Binding(vec![None; scope_len.max(1)]);
    for (si, seg) in path.segments.iter().enumerate() {
        let rel = &seg.rel;
        let node = &seg.node;
        let rel_check = !rel.props.is_empty() || rel.where_.is_some();
        let node_check = !node.props.is_empty() || node.where_.is_some();
        let need_bind = rel_check || node_check;
        let is_last = si + 1 == nseg;
        let mut new_cols: Vec<Option<Vec<u32>>> = (0..scope_len.max(1)).map(|_| None).collect();
        for &(s, _) in &kinds {
            new_cols[s] = Some(Vec::new());
        }
        let mut new_endpoint: Vec<u32> = Vec::new();
        'rows: for i in 0..endpoint.len() {
            // Prior slots are constant across this row's neighbors — set them once.
            if need_bind {
                for &(s, knd) in &kinds {
                    if !bound[s] || Some(s) == rel.var_slot || Some(s) == node.var_slot {
                        continue;
                    }
                    if let Some(col) = &cols[s] {
                        let v = match knd {
                            Elem::Node => Val::Node(col[i]),
                            Elem::Edge => Val::Edge(col[i]),
                        };
                        nb.set(s, v);
                    }
                }
            }
            for (eidx, nbr) in expand(graph, ctx, endpoint[i], rel.direction, rel.label.as_ref()) {
                if !matches_label(graph, ctx, nbr, node.label.as_ref()) {
                    continue;
                }
                if need_bind {
                    if let Some(s) = rel.var_slot {
                        nb.set(s, Val::Edge(eidx));
                    }
                    if let Some(s) = node.var_slot {
                        nb.set(s, Val::Node(nbr));
                    }
                    if rel_check
                        && !satisfies(
                            graph,
                            ctx,
                            &Val::Edge(eidx),
                            &rel.props,
                            rel.where_.as_ref(),
                            &nb,
                        )
                    {
                        continue;
                    }
                    if node_check
                        && !satisfies(
                            graph,
                            ctx,
                            &Val::Node(nbr),
                            &node.props,
                            node.where_.as_ref(),
                            &nb,
                        )
                    {
                        continue;
                    }
                }
                for &(s, _) in &kinds {
                    let v = if Some(s) == rel.var_slot {
                        eidx
                    } else if Some(s) == node.var_slot {
                        nbr
                    } else if bound[s] {
                        cols[s].as_ref().unwrap()[i]
                    } else {
                        // Slot bound by a later segment — not present in this row yet.
                        continue;
                    };
                    new_cols[s].as_mut().unwrap().push(v);
                }
                new_endpoint.push(nbr);
                // No WHERE ⇒ every built row survives, so a LIMIT can stop here.
                if is_last && cap.is_some_and(|c| new_endpoint.len() >= c) {
                    break 'rows;
                }
            }
        }
        // This segment's rel/node columns are now populated for every row.
        if let Some(s) = rel.var_slot {
            bound[s] = true;
        }
        if let Some(s) = node.var_slot {
            bound[s] = true;
        }
        cols = new_cols;
        endpoint = new_endpoint;
    }

    let mut sc = ScanCols::new(scope_len);
    sc.n = endpoint.len();
    for &(s, e) in &kinds {
        sc.slots[s] = Some((e, cols[s].take().unwrap()));
    }
    Some(sc)
}

/// Edge-first build for a single segment `(a)-[r]->(b)` seeded from the edge
/// index: for each candidate edge, validate its type + direction + the inline
/// node/rel constraints, and emit one `(a, r, b)` row. The clause WHERE is still
/// re-applied by the caller, so the edge seed only has to be a superset.
fn edge_first_build(
    graph: &Graph,
    ctx: &Ctx,
    path: &CPath,
    scope_len: usize,
    edges: &[u32],
) -> Option<ScanCols> {
    let seg = &path.segments[0];
    let (start, rel, node) = (&path.start, &seg.rel, &seg.node);
    // A slot bound twice (self-join) — leave to the scalar path.
    let slots: Vec<usize> = [start.var_slot, rel.var_slot, node.var_slot]
        .into_iter()
        .flatten()
        .collect();
    let mut seen = HashSet::new();
    if slots.iter().any(|s| !seen.insert(*s)) {
        return None;
    }
    let (start_check, rel_check, node_check) = (
        !start.props.is_empty() || start.where_.is_some(),
        !rel.props.is_empty() || rel.where_.is_some(),
        !node.props.is_empty() || node.where_.is_some(),
    );
    let mut a_ids = Vec::new();
    let mut r_ids = Vec::new();
    let mut b_ids = Vec::new();
    let mut bind = Binding(vec![None; scope_len.max(1)]);
    for &e in edges {
        let ei = e as usize;
        if !graph.is_edge_live(e) {
            continue;
        }
        if !rel
            .label
            .as_ref()
            .is_none_or(|lbl| eval_label_edge(ctx, graph.e_type[ei], lbl))
        {
            continue;
        }
        let (src, dst) = (graph.e_src[ei], graph.e_dst[ei]);
        let orients: &[(u32, u32)] = match rel.direction {
            Direction::Out => &[(src, dst)],
            Direction::In => &[(dst, src)],
            // A self-loop's two orientations are identical, so emit it once.
            Direction::Both if src == dst => &[(src, dst)],
            Direction::Both => &[(src, dst), (dst, src)],
        };
        for &(a, bn) in orients {
            if !matches_label(graph, ctx, a, start.label.as_ref())
                || !matches_label(graph, ctx, bn, node.label.as_ref())
            {
                continue;
            }
            if start_check || rel_check || node_check {
                if let Some(s) = start.var_slot {
                    bind.set(s, Val::Node(a));
                }
                if let Some(s) = rel.var_slot {
                    bind.set(s, Val::Edge(e));
                }
                if let Some(s) = node.var_slot {
                    bind.set(s, Val::Node(bn));
                }
                if start_check
                    && !satisfies(
                        graph,
                        ctx,
                        &Val::Node(a),
                        &start.props,
                        start.where_.as_ref(),
                        &bind,
                    )
                {
                    continue;
                }
                if rel_check
                    && !satisfies(
                        graph,
                        ctx,
                        &Val::Edge(e),
                        &rel.props,
                        rel.where_.as_ref(),
                        &bind,
                    )
                {
                    continue;
                }
                if node_check
                    && !satisfies(
                        graph,
                        ctx,
                        &Val::Node(bn),
                        &node.props,
                        node.where_.as_ref(),
                        &bind,
                    )
                {
                    continue;
                }
            }
            a_ids.push(a);
            r_ids.push(e);
            b_ids.push(bn);
        }
    }
    let nrows = r_ids.len();
    let mut sc = ScanCols::new(scope_len);
    sc.n = nrows;
    if let Some(s) = start.var_slot {
        sc.slots[s] = Some((Elem::Node, a_ids));
    }
    if let Some(s) = rel.var_slot {
        sc.slots[s] = Some((Elem::Edge, r_ids));
    }
    if let Some(s) = node.var_slot {
        sc.slots[s] = Some((Elem::Node, b_ids));
    }
    Some(sc)
}

/// Build a new row set holding only rows `idx`, in that order (for ORDER BY: the
/// sorted window — gathers the few output rows instead of projecting all of `sc`).
fn gather_rows(sc: &ScanCols, idx: &[usize]) -> ScanCols {
    let mut out = ScanCols::new(sc.slots.len());
    out.n = idx.len();
    for (s, col) in sc.slots.iter().enumerate() {
        if let Some((elem, ids)) = col {
            out.slots[s] = Some((*elem, idx.iter().map(|&i| ids[i]).collect()));
        } else if let Some(vals) = &sc.vals[s] {
            out.vals[s] = Some(idx.iter().map(|&i| vals[i].clone()).collect());
        }
    }
    out
}

/// A contiguous row-range view of a frame as its own (owned) `ScanCols` — used to
/// split a large frame into chunks for parallel column evaluation.
#[cfg(feature = "parallel-query")]
fn slice_rows(sc: &ScanCols, lo: usize, hi: usize) -> ScanCols {
    let mut out = ScanCols::new(sc.slots.len());
    out.n = hi - lo;
    for s in 0..sc.slots.len() {
        if let Some((e, ids)) = &sc.slots[s] {
            out.slots[s] = Some((*e, ids[lo..hi].to_vec()));
        } else if let Some(v) = &sc.vals[s] {
            out.vals[s] = Some(v[lo..hi].to_vec());
        }
    }
    out
}

/// Evaluate each projection item as a `Val` column over the whole frame. For a
/// large frame (and the opt-in `parallel-query` feature) the rows are split into
/// chunks evaluated concurrently, then the per-item columns concatenated in order —
/// the expression eval is embarrassingly parallel and `Graph`/`Ctx` are `Sync`.
///
/// Measured (52k rows, 16 threads): ~1.7x on heavy projections (expr-heavy 4.4ms
/// → 2.5ms; single num/str col ~1.7x). It does NOT scale to core count — these
/// loops stream `f64`/`Val` columns and are memory-bandwidth-bound, plus the
/// concat and the caller's RowSet transpose are serial tails. Two consequences:
/// (1) the threshold keeps small queries on the serial path (thread hand-off
/// would dominate); (2) on a server already saturated with concurrent queries,
/// *inter*-query parallelism uses the cores better — this trades a single query's
/// latency for throughput, so it's a win mainly when cores would otherwise idle.
fn par_project(graph: &Graph, ctx: &Ctx, sc: &ScanCols, items: &[CReturnItem]) -> Vec<Vec<Val>> {
    let serial = || {
        items
            .iter()
            .map(|it| eval_vec(graph, ctx, sc, &it.expr).into_vals())
            .collect()
    };
    #[cfg(feature = "parallel-query")]
    {
        // Threshold: only worth splitting once there's enough per-row work to
        // amortize chunk slicing + thread hand-off.
        const MIN_ROWS: usize = 16_384;
        let threads = rayon::current_num_threads();
        if sc.n >= MIN_ROWS && threads > 1 {
            let nchunks = threads.min(sc.n / 4096).max(1);
            if nchunks > 1 {
                let chunk = sc.n.div_ceil(nchunks);
                let ranges: Vec<(usize, usize)> = (0..nchunks)
                    .map(|c| (c * chunk, ((c + 1) * chunk).min(sc.n)))
                    .filter(|&(lo, hi)| lo < hi)
                    .collect();
                let parts: Vec<Vec<Vec<Val>>> = ranges
                    .par_iter()
                    .map(|&(lo, hi)| {
                        let sub = slice_rows(sc, lo, hi);
                        items
                            .iter()
                            .map(|it| eval_vec(graph, ctx, &sub, &it.expr).into_vals())
                            .collect()
                    })
                    .collect();
                let mut cols: Vec<Vec<Val>> =
                    (0..items.len()).map(|_| Vec::with_capacity(sc.n)).collect();
                for mut part in parts {
                    for (j, c) in part.drain(..).enumerate() {
                        cols[j].extend(c); // moves Vals (no clone), preserves order
                    }
                }
                return cols;
            }
        }
    }
    serial()
}

/// Drop the rows where `keep[i]` is false, compacting every slot column in place.
fn compact(sc: &mut ScanCols, keep: &[bool]) {
    for (_, v) in sc.slots.iter_mut().flatten() {
        let mut w = 0;
        for i in 0..v.len() {
            if keep[i] {
                v[w] = v[i];
                w += 1;
            }
        }
        v.truncate(w);
    }
    for v in sc.vals.iter_mut().flatten() {
        let mut w = 0;
        #[allow(
            clippy::needless_range_loop,
            reason = "bound by the column length; `i` indexes the keep mask and is the swap target"
        )]
        for i in 0..v.len() {
            if keep[i] {
                v.swap(w, i);
                w += 1;
            }
        }
        v.truncate(w);
    }
    sc.n = keep.iter().filter(|&&k| k).count();
}

/// Vectorized grouped / global aggregate over an already-matched (and WHERE-
/// filtered) row set. Supports a single direct-`Prop` group key over a typed
/// column (keys hash on raw ids, no string build) and non-distinct `count(*)` /
/// `count`/`sum`/`avg`/`min`/`max` over a column. Returns `None` (→ scalar) for
/// anything else (multi-key, expr keys, DISTINCT, collect, non-numeric min/max).
/// Raw key bits per row for a group-key item that is a direct `Prop` over a
/// typed column (string-id / f64-bits / bool). `None` per row = absent (its own
/// NULL group); `None` overall = the key isn't a typed direct property, so the
/// caller must fall back to the scalar path.
fn key_raw_col(
    graph: &Graph,
    ctx: &Ctx,
    sc: &ScanCols,
    item: &CReturnItem,
) -> Option<Vec<Option<u64>>> {
    let CExpr::Prop { var_slot, key_ref } = &item.expr else {
        return None;
    };
    let (elem, ids) = sc.slot(*var_slot)?;
    let (store, kid) = match elem {
        Elem::Node => (&graph.props, ctx.prop_keys[*key_ref].0),
        Elem::Edge => (&graph.edge_props, ctx.prop_keys[*key_ref].1),
    };
    let col = kid.and_then(|k| store.cols.get(k as usize));
    let bits = |i: usize, present: &crate::graph::BitSet, raw: u64| {
        present.get(ids[i] as usize).then_some(raw)
    };
    match col {
        Some(Column::Str { data, present }) => Some(
            (0..sc.n)
                .map(|i| bits(i, present, data[ids[i] as usize] as u64))
                .collect(),
        ),
        Some(Column::Num { data, present }) => Some(
            (0..sc.n)
                .map(|i| bits(i, present, data[ids[i] as usize].to_bits()))
                .collect(),
        ),
        Some(Column::Bool { data, present }) => Some(
            (0..sc.n)
                .map(|i| bits(i, present, data[ids[i] as usize] as u64))
                .collect(),
        ),
        _ => None, // Mixed / absent column — can't cheaply raw-key it
    }
}

/// Assign a dense group id per row by grouping on `key_items`. Multi-key grouping
/// is done by *refinement*: start with one group, then split each current group
/// by each key column's value in turn. Because the final pass numbers groups in
/// row order by first appearance of (prev-group, last-key) — which uniquely
/// identifies the full key tuple — this reproduces the scalar engine's first-seen
/// group order exactly. Each key must be a direct `Prop` over a typed column
/// (raw-id hashing, no string build); otherwise `None` → scalar fallback.
/// Returns `(gid per row, representative row per group, group count)`.
fn group_ids(
    graph: &Graph,
    ctx: &Ctx,
    sc: &ScanCols,
    key_items: &[&CReturnItem],
) -> Option<(Vec<usize>, Vec<usize>, usize)> {
    let n = sc.n;
    let mut gid_of_row = vec![0usize; n];
    let mut ngroups = 1; // global group (overwritten once any key column refines)
    for &item in key_items {
        let col = key_raw_col(graph, ctx, sc, item)?;
        let mut map: HashMap<(usize, Option<u64>), usize> = HashMap::new();
        let mut next = 0usize;
        let mut refined = vec![0usize; n];
        for i in 0..n {
            let g = *map.entry((gid_of_row[i], col[i])).or_insert_with(|| {
                let g = next;
                next += 1;
                g
            });
            refined[i] = g;
        }
        gid_of_row = refined;
        ngroups = next;
    }
    // Representative row per group (first occurrence).
    let mut rep_row = vec![usize::MAX; ngroups];
    #[allow(
        clippy::needless_range_loop,
        reason = "bound by row count `n`; `i` indexes gid_of_row and is stored as the representative row"
    )]
    for i in 0..n {
        let g = gid_of_row[i];
        if rep_row[g] == usize::MAX {
            rep_row[g] = i;
        }
    }
    Some((gid_of_row, rep_row, ngroups))
}

fn vectorized_aggregate(
    graph: &Graph,
    ctx: &Ctx,
    sc: &ScanCols,
    proj: &CProjection,
) -> Option<Vec<Vec<Val>>> {
    let key_items: Vec<&CReturnItem> = proj.items.iter().filter(|i| !i.is_agg).collect();
    let n = sc.n;
    let (gid_of_row, rep_row, ngroups) = group_ids(graph, ctx, sc, &key_items)?;

    // Fold each lifted aggregate into a per-group column.
    let mut agg_cols: Vec<Vec<Val>> = Vec::with_capacity(proj.aggs.len());
    for spec in &proj.aggs {
        if spec.distinct {
            return None;
        }
        let col: Vec<Val> = if spec.func == AggFn::Count && spec.star {
            let mut cnt = vec![0u64; ngroups];
            for &g in &gid_of_row {
                cnt[g] += 1;
            }
            cnt.into_iter().map(|c| Val::Num(c as f64)).collect()
        } else {
            let arg = spec.arg.as_ref()?;
            let av = eval_vec(graph, ctx, sc, arg);
            // min/max compare by value; only correct here for numeric columns.
            if matches!(spec.func, AggFn::Min | AggFn::Max) && !matches!(av, VVec::Num { .. }) {
                return None;
            }
            let (d, valid) = av.into_num();
            match spec.func {
                AggFn::Count => {
                    let mut c = vec![0u64; ngroups];
                    for i in 0..n {
                        if valid[i] {
                            c[gid_of_row[i]] += 1;
                        }
                    }
                    c.into_iter().map(|x| Val::Num(x as f64)).collect()
                }
                AggFn::Sum => {
                    let mut s = vec![0f64; ngroups];
                    for i in 0..n {
                        if valid[i] {
                            s[gid_of_row[i]] += d[i];
                        }
                    }
                    s.into_iter().map(Val::Num).collect()
                }
                AggFn::Avg => {
                    let mut s = vec![0f64; ngroups];
                    let mut c = vec![0u64; ngroups];
                    for i in 0..n {
                        if valid[i] {
                            let g = gid_of_row[i];
                            s[g] += d[i];
                            c[g] += 1;
                        }
                    }
                    (0..ngroups)
                        .map(|g| {
                            if c[g] == 0 {
                                Val::Null
                            } else {
                                Val::Num(s[g] / c[g] as f64)
                            }
                        })
                        .collect()
                }
                AggFn::Min | AggFn::Max => {
                    let is_min = spec.func == AggFn::Min;
                    let mut m: Vec<Option<f64>> = vec![None; ngroups];
                    for i in 0..n {
                        if valid[i] {
                            let g = gid_of_row[i];
                            m[g] = Some(match m[g] {
                                Some(x) => {
                                    if is_min {
                                        x.min(d[i])
                                    } else {
                                        x.max(d[i])
                                    }
                                }
                                None => d[i],
                            });
                        }
                    }
                    m.into_iter()
                        .map(|o| o.map_or(Val::Null, Val::Num))
                        .collect()
                }
                _ => return None, // CollectList etc.
            }
        };
        agg_cols.push(col);
    }

    // Build one output row per group (column-major): re-evaluate the item
    // expressions scalar (few groups), resolving group keys against the
    // representative row and `AggRef`s against this group's folded values.
    let start = proj.skip.unwrap_or(0).min(ngroups);
    let end = proj
        .limit
        .map(|l| (start + l).min(ngroups))
        .unwrap_or(ngroups);
    let mut out: Vec<Vec<Val>> = vec![Vec::with_capacity(end - start); proj.items.len()];
    let mut b = Binding(vec![None; sc.slots.len()]);
    for g in start..end {
        // `usize::MAX` = an empty global group (no input rows) — leave the
        // binding unbound; only pure aggregates (e.g. count = 0) reference it.
        if let Some(&ri) = rep_row.get(g).filter(|&&ri| ri != usize::MAX) {
            for (slot, col) in sc.slots.iter().enumerate() {
                if let Some((elem, ids)) = col {
                    let v = match elem {
                        Elem::Node => Val::Node(ids[ri]),
                        Elem::Edge => Val::Edge(ids[ri]),
                    };
                    b.set(slot, v);
                }
            }
        }
        let agg_values: Vec<Val> = agg_cols.iter().map(|c| c[g].clone()).collect();
        let env = Env {
            graph,
            ctx,
            binding: &b,
            group: None,
            agg_values: Some(&agg_values),
        };
        for (item_idx, item) in proj.items.iter().enumerate() {
            out[item_idx].push(eval(&env, &item.expr));
        }
    }
    Some(out)
}

/// Try the vectorized path for a single fresh `MATCH` of one fixed-length path,
/// producing the projection's output **as column-major `Val` columns** (each the
/// final output rows, in order, after WHERE / aggregate / DISTINCT / ORDER BY /
/// SKIP+LIMIT). The caller turns these into a terminal `RowSet` (flattening
/// elements to ids) or into carried `Binding`s for a `WITH` (preserving element
/// handles). Returns `None` (→ scalar driver) unless the shape qualifies: one
/// fresh `MATCH` of a buildable (non-var-length, no self-join) path, no `RETURN *`.
fn vectorized_cols(
    graph: &Graph,
    ctx: &Ctx,
    incoming: &[Binding],
    matches: &[&CClause],
    proj: &CProjection,
) -> Option<Vec<Vec<Val>>> {
    if incoming.len() != 1 || incoming[0].0.iter().any(|c| c.is_some()) {
        return None; // a prior WITH/INSERT already produced bindings
    }
    if matches.len() != 1 || proj.star {
        return None;
    }
    // ORDER BY only when the sort keys read input vars (not output aliases) and
    // it's a plain projection — grouped/global sort and DISTINCT+ORDER BY stay scalar.
    let has_order = !proj.order_by.is_empty();
    if has_order && (proj.aggregating || proj.distinct || proj.order_needs_output) {
        return None;
    }
    let CClause::Match {
        optional: false,
        patterns,
        where_,
        scope_len,
        ..
    } = matches[0]
    else {
        return None;
    };
    if patterns.len() != 1 {
        return None;
    }
    let path = &patterns[0];

    // A pure aggregate over a traversal with no WHERE stays scalar: the scalar
    // engine stream-folds the join without materializing it, and there's no
    // per-row expression to vectorize. With a WHERE, the batched build + masked
    // count can pay for itself.
    if !path.segments.is_empty() && proj.aggregating && where_.is_none() {
        return None;
    }

    // With no clause WHERE (and no aggregation/DISTINCT), a LIMIT lets us stop the
    // scan early — preserving the scalar path's streaming advantage for small
    // LIMITs. (DISTINCT/aggregation need every row before producing output.)
    let cap = (where_.is_none() && !proj.aggregating && !proj.distinct && !has_order)
        .then(|| proj.limit.map(|l| proj.skip.unwrap_or(0) + l))
        .flatten();
    // Seed an isolated-node scan from a property index when an indexed eq/range
    // hint applies (cap can't early-stop a seeded scan, so drop it then).
    // An index hint (vertex or edge) makes the scan a seek, so the LIMIT cap
    // can't early-stop it — drop the cap when a hint applies.
    let cap = if scan_is_hinted(graph, ctx, path, where_.as_ref()) {
        None
    } else {
        cap
    };
    let mut sc = build_scan(graph, ctx, path, *scope_len, cap, where_.as_ref())?;

    // Clause WHERE → keep mask (vectorized), compacting the row set.
    if let Some(w) = where_ {
        let keep: Vec<bool> = eval_vec(graph, ctx, &sc, w)
            .into_truth()
            .iter()
            .map(|t| *t == Some(true))
            .collect();
        compact(&mut sc, &keep);
    }

    project_frame_cols(graph, ctx, &sc, proj)
}

/// Project an already-built (and WHERE-filtered) frame `sc` to column-major output
/// — aggregate / ORDER BY / DISTINCT / plain projection + SKIP/LIMIT. Shared by
/// the single-scan entry ([`vectorized_cols`]) and a pipeline's terminal RETURN
/// (where `sc` may carry computed value columns from upstream `WITH`s).
fn project_frame_cols(
    graph: &Graph,
    ctx: &Ctx,
    sc: &ScanCols,
    proj: &CProjection,
) -> Option<Vec<Vec<Val>>> {
    let has_order = !proj.order_by.is_empty();
    if has_order && (proj.aggregating || proj.distinct || proj.order_needs_output) {
        return None;
    }
    if proj.aggregating {
        return vectorized_aggregate(graph, ctx, sc, proj);
    }

    // ORDER BY (input-keyed): evaluate the sort keys as columns, sort row indices,
    // then project only the SKIP/LIMIT window — so a small LIMIT never materializes
    // the full (e.g. string) output columns, just the keys.
    if has_order {
        // A sort-scope view of `sc`: alias each overlay input column at its
        // sort-scope slot (out_len + j), so the sort exprs resolve directly.
        let mut sort_sc = ScanCols::new(proj.out_len + proj.order_overlay.len());
        sort_sc.n = sc.n;
        for (j, &islot) in proj.order_overlay.iter().enumerate() {
            if let Some((elem, ids)) = &sc.slots[islot] {
                sort_sc.slots[proj.out_len + j] = Some((*elem, ids.clone()));
            } else if let Some(vals) = &sc.vals[islot] {
                sort_sc.vals[proj.out_len + j] = Some(vals.clone());
            }
        }
        let keycols: Vec<Vec<Val>> = proj
            .order_by
            .iter()
            .map(|s| eval_vec(graph, ctx, &sort_sc, &s.expr).into_vals())
            .collect();
        let mut idx: Vec<usize> = (0..sc.n).collect();
        idx.sort_by(|&i, &j| {
            for (k, s) in proj.order_by.iter().enumerate() {
                let o = compare_sort(&keycols[k][i], &keycols[k][j], s.descending, s.nulls_first);
                if o != Ordering::Equal {
                    return o;
                }
            }
            Ordering::Equal
        });
        let start = proj.skip.unwrap_or(0).min(idx.len());
        let end = proj
            .limit
            .map(|l| (start + l).min(idx.len()))
            .unwrap_or(idx.len());
        let sub = gather_rows(sc, &idx[start..end]);
        return Some(
            proj.items
                .iter()
                .map(|item| eval_vec(graph, ctx, &sub, &item.expr).into_vals())
                .collect(),
        );
    }

    // DISTINCT fast path: when every output item is a direct typed-Prop column,
    // DISTINCT ≡ group-by-all-columns with no aggregates — reuse the raw-id
    // grouping and emit one representative row per group (first-seen order, no
    // per-row string key). Falls through to the generic dedup otherwise.
    if proj.distinct {
        let all_items: Vec<&CReturnItem> = proj.items.iter().collect();
        if let Some((_, rep_row, ngroups)) = group_ids(graph, ctx, sc, &all_items) {
            let start = proj.skip.unwrap_or(0).min(ngroups);
            let end = proj
                .limit
                .map(|l| (start + l).min(ngroups))
                .unwrap_or(ngroups);
            let mut out: Vec<Vec<Val>> = vec![Vec::with_capacity(end - start); proj.items.len()];
            let mut b = Binding(vec![None; sc.slots.len()]);
            for &ri in &rep_row[start..end] {
                for (slot, col) in sc.slots.iter().enumerate() {
                    if let Some((elem, ids)) = col {
                        b.set(
                            slot,
                            match elem {
                                Elem::Node => Val::Node(ids[ri]),
                                Elem::Edge => Val::Edge(ids[ri]),
                            },
                        );
                    }
                }
                let env = Env::new(graph, ctx, &b);
                for (item_idx, item) in proj.items.iter().enumerate() {
                    out[item_idx].push(eval(&env, &item.expr));
                }
            }
            return Some(out);
        }
    }

    // Non-aggregating projection: evaluate each item as a column (parallel over
    // row-chunks for a large frame).
    let mut cols: Vec<Vec<Val>> = par_project(graph, ctx, sc, &proj.items);
    if proj.distinct {
        // Generic DISTINCT (expression / non-typed items): keep the first
        // occurrence of each row in scan order, dedup on a composite cell key.
        let mut seen: HashSet<String> = HashSet::new();
        let skip = proj.skip.unwrap_or(0);
        let mut seen_count = 0usize;
        let mut kept: Vec<usize> = Vec::new();
        for i in 0..sc.n {
            let mut key = String::new();
            for c in &cols {
                val_key(&c[i], &mut key);
                key.push('\u{1}');
            }
            if !seen.insert(key) {
                continue;
            }
            if seen_count >= skip {
                if proj.limit.is_some_and(|l| kept.len() >= l) {
                    break;
                }
                kept.push(i);
            }
            seen_count += 1;
        }
        Some(
            cols.iter()
                .map(|c| kept.iter().map(|&i| c[i].clone()).collect())
                .collect(),
        )
    } else {
        // Window each column to the SKIP/LIMIT row range (no ORDER BY ⇒ scan order).
        let start = proj.skip.unwrap_or(0).min(sc.n);
        let end = proj.limit.map(|l| (start + l).min(sc.n)).unwrap_or(sc.n);
        for c in &mut cols {
            c.truncate(end);
            c.drain(0..start);
        }
        Some(cols)
    }
}

/// Project a frame through a non-aggregating `WITH` into a new frame: bare element
/// variables are carried forward as fast element columns (so downstream prop reads
/// and filters stay vectorized), and every other item becomes a computed value
/// column. Returns `None` for shapes a mid-pipeline `WITH` shouldn't carry
/// (aggregate / DISTINCT / ORDER BY / SKIP / LIMIT / `*`) — those end the pipeline
/// or fall back to scalar.
fn with_frame(graph: &Graph, ctx: &Ctx, sc: &ScanCols, proj: &CProjection) -> Option<ScanCols> {
    if proj.aggregating
        || proj.distinct
        || !proj.order_by.is_empty()
        || proj.skip.is_some()
        || proj.limit.is_some()
        || proj.star
    {
        return None;
    }
    let mut out = ScanCols::new(proj.out_len);
    out.n = sc.n;
    for (i, item) in proj.items.iter().enumerate() {
        if let CExpr::Var(slot) = &item.expr {
            if let Some((elem, ids)) = sc.slot(*slot) {
                out.slots[i] = Some((elem, ids.to_vec())); // carry element column forward
                continue;
            }
            if let Some(vals) = sc.val_slot(*slot) {
                out.vals[i] = Some(vals.to_vec()); // carry a prior computed column
                continue;
            }
        }
        out.vals[i] = Some(eval_vec(graph, ctx, sc, &item.expr).into_vals());
    }
    Some(out)
}

/// Expand a frame by a `MATCH` whose start node is an already-bound element column
/// (e.g. `… WITH a MATCH (a)-[:KNOWS]->(b) …`): for each frame row, walk the
/// path's segments from that row's start vertex, fanning out to matching
/// neighbors and replicating the frame's other columns. Returns `None` for a
/// fresh/unbound start (cartesian), var-length, or a segment slot already bound.
fn expand_frame(
    graph: &Graph,
    ctx: &Ctx,
    sc: &ScanCols,
    path: &CPath,
    scope_len: usize,
) -> Option<ScanCols> {
    let start = &path.start;
    let start_slot = start.var_slot?;
    let start_ids: Vec<u32> = match sc.slot(start_slot) {
        Some((Elem::Node, ids)) => ids.to_vec(), // start must be a bound node column
        _ => return None,
    };
    if path.segments.iter().any(|s| s.rel.quantifier.is_some()) {
        return None;
    }
    // Segment-introduced slots must be fresh (not already bound) — no self-join.
    let mut seen = HashSet::new();
    for seg in &path.segments {
        for s in [seg.rel.var_slot, seg.node.var_slot].into_iter().flatten() {
            if !seen.insert(s) || sc.slot(s).is_some() || sc.val_slot(s).is_some() {
                return None;
            }
        }
    }
    let width = scope_len.max(sc.slots.len());

    // cur = the frame widened to `width`; endpoint = each row's start vertex.
    let mut cur = ScanCols::new(width);
    cur.n = sc.n;
    for s in 0..sc.slots.len() {
        if let Some((e, ids)) = &sc.slots[s] {
            cur.slots[s] = Some((*e, ids.clone()));
        } else if let Some(v) = &sc.vals[s] {
            cur.vals[s] = Some(v.clone());
        }
    }
    let mut endpoint = start_ids;

    // Sets a binding from `cur` at row `i` (for inline WHERE/props referencing
    // frame variables during constraint checks).
    let bind_row = |b: &mut Binding, cur: &ScanCols, i: usize| {
        for s in 0..cur.slots.len() {
            if let Some((e, ids)) = &cur.slots[s] {
                b.set(
                    s,
                    match e {
                        Elem::Node => Val::Node(ids[i]),
                        Elem::Edge => Val::Edge(ids[i]),
                    },
                );
            } else if let Some(v) = &cur.vals[s] {
                b.set(s, v[i].clone());
            }
        }
    };

    // The restated start node may add label/props/WHERE — filter rows by them.
    if start.label.is_some() || !start.props.is_empty() || start.where_.is_some() {
        let mut b = Binding(vec![None; width]);
        let mut keep = vec![false; cur.n];
        for i in 0..cur.n {
            bind_row(&mut b, &cur, i);
            keep[i] = matches_label(graph, ctx, endpoint[i], start.label.as_ref())
                && satisfies(
                    graph,
                    ctx,
                    &Val::Node(endpoint[i]),
                    &start.props,
                    start.where_.as_ref(),
                    &b,
                );
        }
        endpoint = endpoint
            .iter()
            .zip(&keep)
            .filter_map(|(&v, &k)| k.then_some(v))
            .collect();
        compact(&mut cur, &keep);
    }

    let mut nb = Binding(vec![None; width]);
    for seg in &path.segments {
        let rel = &seg.rel;
        let node = &seg.node;
        let rel_check = !rel.props.is_empty() || rel.where_.is_some();
        let node_check = !node.props.is_empty() || node.where_.is_some();
        let need_bind = rel_check || node_check;
        // Pre-init the next frame's columns: new rel/node slots + carried columns.
        let mut nxt = ScanCols::new(width);
        for s in 0..width {
            if Some(s) == rel.var_slot {
                nxt.slots[s] = Some((Elem::Edge, Vec::new()));
            } else if Some(s) == node.var_slot {
                nxt.slots[s] = Some((Elem::Node, Vec::new()));
            } else if let Some((e, _)) = &cur.slots[s] {
                nxt.slots[s] = Some((*e, Vec::new()));
            } else if cur.vals[s].is_some() {
                nxt.vals[s] = Some(Vec::new());
            }
        }
        let mut nxt_end: Vec<u32> = Vec::new();
        for i in 0..cur.n {
            if need_bind {
                bind_row(&mut nb, &cur, i);
            }
            for (eidx, nbr) in expand(graph, ctx, endpoint[i], rel.direction, rel.label.as_ref()) {
                if !matches_label(graph, ctx, nbr, node.label.as_ref()) {
                    continue;
                }
                if need_bind {
                    if let Some(s) = rel.var_slot {
                        nb.set(s, Val::Edge(eidx));
                    }
                    if let Some(s) = node.var_slot {
                        nb.set(s, Val::Node(nbr));
                    }
                    if rel_check
                        && !satisfies(
                            graph,
                            ctx,
                            &Val::Edge(eidx),
                            &rel.props,
                            rel.where_.as_ref(),
                            &nb,
                        )
                    {
                        continue;
                    }
                    if node_check
                        && !satisfies(
                            graph,
                            ctx,
                            &Val::Node(nbr),
                            &node.props,
                            node.where_.as_ref(),
                            &nb,
                        )
                    {
                        continue;
                    }
                }
                for s in 0..width {
                    if Some(s) == rel.var_slot {
                        nxt.slots[s].as_mut().unwrap().1.push(eidx);
                    } else if Some(s) == node.var_slot {
                        nxt.slots[s].as_mut().unwrap().1.push(nbr);
                    } else if let Some((_, ids)) = &cur.slots[s] {
                        nxt.slots[s].as_mut().unwrap().1.push(ids[i]);
                    } else if let Some(v) = &cur.vals[s] {
                        nxt.vals[s].as_mut().unwrap().push(v[i].clone());
                    }
                }
                nxt_end.push(nbr);
            }
        }
        nxt.n = nxt_end.len();
        cur = nxt;
        endpoint = nxt_end;
    }
    Some(cur)
}

/// O(1) shortcut for `MATCH (n:Label) RETURN count(*)`: no WHERE, no path, no
/// grouping / extra aggregate / DISTINCT / ORDER BY / SKIP / LIMIT. The result is
/// exactly the label bucket's size, so read `vertices_with_label(l).len()` instead
/// of materializing and counting the whole id column — turning an O(n) scan into
/// an O(1) read. Provably identical to the general path, which counts that same
/// bucket; the difference is `bucket.len()` vs `bucket.iter().count()`.
fn try_count_star(
    linear: &CLinear,
    graph: &Graph,
    plan: &CQuery,
    params: &[Val],
) -> Option<RowSet> {
    let [CClause::Match {
        optional: false,
        patterns,
        where_: None,
        ..
    }, CClause::Return(proj)] = linear.clauses.as_slice()
    else {
        return None;
    };
    // a single bare node `(n:Label)` — one pattern, no path segments, no inline
    // props / WHERE on the node.
    let [path] = patterns.as_slice() else {
        return None;
    };
    if !path.segments.is_empty() || !path.start.props.is_empty() || path.start.where_.is_some() {
        return None;
    }
    // exactly one label (no `|`, `!`, wildcard) — else the bucket isn't the count.
    let Some(CLabelExpr::Label(label_ref)) = &path.start.label else {
        return None;
    };
    // the projection is exactly `count(*)` and nothing else.
    if proj.distinct
        || !proj.order_by.is_empty()
        || proj.skip.is_some()
        || proj.limit.is_some()
        || proj.out_len != 1
        || proj.aggs.len() != 1
        || proj.items.len() != 1
        || !matches!(proj.items[0].expr, CExpr::AggRef(0))
    {
        return None;
    }
    let agg = &proj.aggs[0];
    if !agg.star || agg.distinct || !matches!(agg.func, AggFn::Count) {
        return None;
    }
    let ctx = resolve_ctx(graph, plan, params);
    let n = ctx.labels[*label_ref]
        .0
        .map_or(0, |lid| graph.vertices_with_label(lid).len());
    let mut rs = RowSet::new(proj.out_names.clone());
    rs.push_row(std::iter::once(Value::Num(n as f64)));
    Some(rs)
}

/// Vectorized executor for a whole linear pipeline: `MATCH <path> (WITH …)+
/// RETURN …`. Threads a single columnar frame stage-to-stage — carrying element
/// columns forward so prop reads/filters/ORDER BY past a `WITH` stay vectorized,
/// instead of round-tripping each stage through `Vec<Binding>`. Returns `None`
/// (→ scalar `run_linear`) unless: one leading non-optional single-path MATCH, at
/// least one intermediate (non-aggregating) WITH, a terminal RETURN, and nothing
/// else (no extra MATCH / mutation / subquery clause, no var-length, no self-join).
fn vectorized_linear(
    linear: &CLinear,
    graph: &Graph,
    plan: &CQuery,
    params: &[Val],
) -> Option<RowSet> {
    // O(1) shortcut for a bare `MATCH (n:Label) RETURN count(*)`.
    if let Some(rs) = try_count_star(linear, graph, plan, params) {
        return Some(rs);
    }
    // Validate the whole clause shape *before* any scan work, so a non-pipeline
    // query bails for free (no wasted build_scan) and keeps the entry path.
    let (first, rest) = linear.clauses.split_first()?;
    let CClause::Match {
        optional: false,
        patterns,
        where_,
        scope_len,
        ..
    } = first
    else {
        return None;
    };
    if patterns.len() != 1 {
        return None;
    }
    let (last, mid) = rest.split_last()?;
    let CClause::Return(last_proj) = last else {
        return None;
    };
    // Middle clauses are WITHs or expanding MATCHes.
    let mid_ok = mid.iter().all(|c| {
        matches!(
            c,
            CClause::With { .. }
                | CClause::Match {
                    optional: false,
                    ..
                }
        )
    });
    if !mid_ok {
        return None;
    }
    // A plain `MATCH … RETURN` (no intermediate WITH) normally stays on the scalar
    // entry path so a `RETURN … LIMIT n` keeps its row-by-row early-out. But an
    // aggregate (`count`/`sum`/`avg`/group-by) scans the whole match regardless —
    // there's no early-out to lose — so route it through the vectorized frame for
    // the de-boxed columnar win on filtered counts/sums. (The Arrow fast path
    // already covers non-aggregate plain `MATCH … RETURN`, but bars aggregates;
    // this fills exactly that gap.)
    if mid.is_empty() && !last_proj.aggregating {
        return None;
    }

    let ctx = resolve_ctx(graph, plan, params);
    let filter = |sc: &mut ScanCols, w: &CExpr| {
        let keep: Vec<bool> = eval_vec(graph, &ctx, sc, w)
            .into_truth()
            .iter()
            .map(|t| *t == Some(true))
            .collect();
        compact(sc, &keep);
    };
    let mut sc = build_scan(graph, &ctx, &patterns[0], *scope_len, None, where_.as_ref())?;
    if let Some(w) = where_ {
        filter(&mut sc, w);
    }
    for c in mid {
        match c {
            CClause::With {
                projection, where_, ..
            } => {
                sc = with_frame(graph, &ctx, &sc, projection)?;
                if let Some(w) = where_ {
                    filter(&mut sc, w);
                }
            }
            CClause::Match {
                patterns,
                where_,
                scope_len,
                ..
            } => {
                if patterns.len() != 1 {
                    return None;
                }
                sc = expand_frame(graph, &ctx, &sc, &patterns[0], *scope_len)?;
                if let Some(w) = where_ {
                    filter(&mut sc, w);
                }
            }
            _ => return None,
        }
    }
    let proj = last_proj;
    let cols = project_frame_cols(graph, &ctx, &sc, proj)?;
    let nrows = cols.first().map_or(0, |c| c.len());
    let mut rs = RowSet::new(proj.out_names.clone());
    for i in 0..nrows {
        rs.push_row(cols.iter().map(|c| val_to_value(graph, &c[i])));
    }
    // A data exception during vectorized eval can't return `Err` from here; fall
    // back to the scalar path (this query shape is read-only, so re-running is
    // safe), which re-evaluates and surfaces the `CodeError`.
    if ctx.faulted() {
        return None;
    }
    Some(rs)
}

/// Project a terminal RETURN directly to output `Value` rows. For the common
/// non-aggregating, non-ordered case this streams straight to one `Vec<Value>`
/// per row — no intermediate `Binding` and no later Val→Value conversion (the
/// dominant materialization cost). Aggregating/ordered fall back to the binding
/// accumulator (few/already-sorted rows) and convert.
fn project_to_rows(
    graph: &Graph,
    ctx: &Ctx,
    incoming: &[Binding],
    matches: &[&CClause],
    proj: &CProjection,
) -> RowSet {
    if USE_VEC {
        if let Some(cols) = vectorized_cols(graph, ctx, incoming, matches, proj) {
            // Terminal output: flatten element handles to their ids.
            let nrows = cols.first().map_or(0, |c| c.len());
            let mut rs = RowSet::new(proj.out_names.clone());
            for i in 0..nrows {
                rs.push_row(cols.iter().map(|c| val_to_value(graph, &c[i])));
            }
            return rs;
        }
    }
    let mut rs = RowSet::new(proj.out_names.clone());
    if proj.aggregating || !proj.order_by.is_empty() {
        // Few / already-sorted rows: reuse the binding accumulator, then pour
        // each projected binding's cells into the flat buffer.
        for b in project_matches(graph, ctx, incoming, matches, proj) {
            rs.push_row((0..proj.out_len).map(|i| {
                b.get(i)
                    .map(|v| val_to_value(graph, v))
                    .unwrap_or(Value::Null)
            }));
        }
        return rs;
    }
    // Fast path: project each row straight into the flat cell buffer — no
    // intermediate per-row Vec, no second conversion pass.
    let cap = proj.limit.map(|l| proj.skip.unwrap_or(0) + l);
    let mut seen: HashSet<String> = HashSet::new();
    let simple = single_simple_clause(matches);
    for inb in incoming {
        let mut work = inb.clone();
        // The row-pushing sink (shared by the monomorphized and dyn drivers).
        let mut push = |b: &Binding| -> bool {
            if proj.star {
                rs.push_row(proj.star_cols.iter().map(|&s| {
                    b.get(s)
                        .map(|v| val_to_value(graph, v))
                        .unwrap_or(Value::Null)
                }));
            } else {
                let env = Env::new(graph, ctx, b);
                rs.push_row(
                    proj.items
                        .iter()
                        .map(|item| val_to_value(graph, &eval_item(&env, item))),
                );
            }
            if proj.distinct && !seen.insert(value_row_key(rs.row(rs.nrows - 1))) {
                rs.pop_row();
                return true;
            }
            cap.is_none_or(|c| rs.nrows < c) // stop once enough collected
        };
        let cont = match simple {
            Some((path, cwhere, cwhere_prog, scope_len)) => {
                work.resize(scope_len);
                match_one_path(graph, ctx, path, &mut work, &mut |b| {
                    if !where_keep(&Env::new(graph, ctx, b), cwhere, cwhere_prog) {
                        return true;
                    }
                    push(b)
                })
            }
            None => drive_matches(graph, ctx, matches, 0, &mut work, &mut |b| push(b)),
        };
        if !cont {
            break;
        }
    }
    rs.apply_skip_limit(proj.skip.unwrap_or(0), proj.limit);
    rs
}

/// Materialize the binding stream from `incoming × pending matches` (needed
/// before a write clause, which mutates per row).
fn materialize_matches(
    graph: &Graph,
    ctx: &Ctx,
    incoming: &[Binding],
    matches: &[&CClause],
) -> Vec<Binding> {
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
fn cmp_keyed(
    a: &(Binding, Vec<Val>),
    b: &(Binding, Vec<Val>),
    order: &[super::plan::CSortItem],
) -> Ordering {
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
        // Null placement is absolute (independent of ASC/DESC). With no explicit
        // NULLS FIRST/LAST, nulls sort LAST — ISO GQL leaves the default
        // unspecified, so we pin one for cross-engine determinism.
        let first = nulls_first.unwrap_or(false);
        return if a_null == first {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let base = cmp_total(a, b);
    if descending {
        base.reverse()
    } else {
        base
    }
}

// --- linear query & set ops --------------------------------------------------

fn run_linear(
    linear: &CLinear,
    graph: &mut Graph,
    plan: &CQuery,
    params: &[Val],
) -> CodeResult<RowSet> {
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
            CClause::With {
                projection,
                where_,
                where_prog,
            } => {
                let projected = project_matches(graph, &ctx, &bindings, &pending, projection);
                pending.clear();
                bindings = if where_.is_none() {
                    projected
                } else {
                    projected
                        .into_iter()
                        .filter(|b| {
                            where_keep(
                                &Env::new(graph, &ctx, b),
                                where_.as_ref(),
                                where_prog.as_ref(),
                            )
                        })
                        .collect()
                };
            }
            CClause::For {
                list,
                alias_slot,
                ord,
                scope_len,
            } => {
                // FOR's list can reference a deferred MATCH var, so flush pending
                // first, then unwind: each incoming binding fans out to one row
                // per list element (ISO GQL's UNWIND). A list unwinds its
                // elements; null yields zero rows; any other scalar unwinds as a
                // one-element list.
                if !pending.is_empty() {
                    bindings = materialize_matches(graph, &ctx, &bindings, &pending);
                    pending.clear();
                }
                let mut out = Vec::new();
                for inb in &bindings {
                    let mut work = inb.clone();
                    work.resize(*scope_len);
                    let listv = {
                        let env = Env::new(graph, &ctx, &work);
                        eval(&env, list)
                    };
                    let elems = match listv {
                        Val::List(items) => items,
                        Val::Null => Vec::new(),
                        scalar => vec![scalar],
                    };
                    for (i, elem) in elems.into_iter().enumerate() {
                        work.set(*alias_slot, elem);
                        if let Some((is_ordinality, ord_slot)) = ord {
                            let counter = if *is_ordinality {
                                (i + 1) as f64
                            } else {
                                i as f64
                            };
                            work.set(*ord_slot, Val::Num(counter));
                        }
                        out.push(work.clone());
                    }
                }
                bindings = out;
                ctx.check_fault()?;
            }
            CClause::Return(proj) => {
                let rows = project_to_rows(graph, &ctx, &bindings, &pending, proj);
                ctx.check_fault()?;
                return Ok(rows);
            }
            CClause::Finish => return Ok(RowSet::new(Vec::new())),
            // Mutations run eagerly, exactly once per binding. Flush deferred
            // matches first, then re-resolve refs against the mutated graph.
            CClause::Insert(patterns) => {
                if !pending.is_empty() {
                    bindings = materialize_matches(graph, &ctx, &bindings, &pending);
                    pending.clear();
                }
                let mut inserted = Vec::with_capacity(bindings.len());
                for b in &bindings {
                    inserted.push(run_insert(graph, &mut ctx, plan, patterns, b));
                }
                bindings = inserted;
                ctx.check_fault()?;
                ctx = resolve_ctx(graph, plan, params);
            }
            CClause::Merge(m) => {
                if !pending.is_empty() {
                    bindings = materialize_matches(graph, &ctx, &bindings, &pending);
                    pending.clear();
                }
                let mut merged = Vec::with_capacity(bindings.len());
                for b in &bindings {
                    merged.push(run_merge(graph, &ctx, m, b));
                }
                bindings = merged;
                ctx.check_fault()?;
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
                ctx.check_fault()?;
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
    ctx.check_fault()?;
    Ok(RowSet::new(Vec::new())) // write-only / no RETURN
}

// --- write execution ---------------------------------------------------------

/// Concrete labels a (lowered) label expression names, for element creation;
/// resolves each ref back to its name. `|`/`!`/`%` can't name a creatable set.
/// Labels to CREATE for an INSERT element: `None` for no label expression
/// (a legitimately unlabelled node), the conjunction for `A`/`A&B`, and `None`
/// for a disjunction/negation/wildcard — an ambiguous form that can't be created
/// (the caller raises FAULT_BAD_LABEL). A non-INSERT (MATCH) label expression is
/// handled elsewhere; this deliberately refuses the ambiguous forms.
fn creatable_labels(expr: Option<&CLabelExpr>, names: &[String]) -> Option<Vec<String>> {
    match expr {
        None => Some(Vec::new()),
        Some(CLabelExpr::Label(r)) => Some(vec![names[*r].clone()]),
        Some(CLabelExpr::And(l, r)) => {
            let mut v = creatable_labels(Some(l), names)?;
            v.extend(creatable_labels(Some(r), names)?);
            Some(v)
        }
        Some(_) => None, // |, !, % — not a concrete label set
    }
}

/// Evaluate a pattern property map to concrete core `Value`s (for create/set).
fn eval_props(
    graph: &Graph,
    ctx: &Ctx,
    props: &[CPropConstraint],
    binding: &Binding,
) -> Vec<(String, Value)> {
    let env = Env::new(graph, ctx, binding);
    props
        .iter()
        .map(|pc| (pc.key.clone(), val_to_value(graph, &eval(&env, &pc.value))))
        .collect()
}

/// Create a node from a pattern, reusing an already-bound variable.
fn ensure_node(graph: &mut Graph, ctx: &Ctx, binding: &mut Binding, node: &CNode) -> u32 {
    if let Some(slot) = node.var_slot {
        if let Some(Val::Node(vi)) = binding.get(slot) {
            return *vi;
        }
    }
    // A node may be unlabelled, but a non-conjunction label expression
    // (`A|B`, `!A`, `%`) is ambiguous — reject it rather than silently create an
    // unlabelled node.
    let labels = creatable_labels(node.label.as_ref(), ctx.label_names).unwrap_or_else(|| {
        ctx.set_fault(FAULT_BAD_LABEL);
        Vec::new()
    });
    let props = eval_props(graph, ctx, &node.props, binding);
    // Reject a plain INSERT that would break a unique constraint (an `_MERGE`
    // reconciles instead; see docs/design/gql-extensions.md §3). The fault
    // surfaces as ConstraintViolation at the row boundary and aborts the write;
    // returning the existing offender keeps downstream code total (unused).
    if let Some((_, _, existing)) = graph.unique_conflict(&labels, &props, None) {
        ctx.set_fault(FAULT_CONSTRAINT);
        return existing;
    }
    let vi = graph.add_vertex(&labels, props);
    if let Some(slot) = node.var_slot {
        binding.set(slot, Val::Node(vi));
    }
    vi
}

fn run_insert(
    graph: &mut Graph,
    ctx: &mut Ctx,
    plan: &CQuery,
    patterns: &[CPath],
    binding: &Binding,
) -> Binding {
    let mut out = binding.clone();
    for pattern in patterns {
        // Refresh id resolution so this element's property expressions can read
        // a sibling created earlier in the same INSERT (forward reference).
        ctx.refresh_ids(graph, plan);
        let mut prev = ensure_node(graph, ctx, &mut out, &pattern.start);
        for CSegment { rel, node } in &pattern.segments {
            ctx.refresh_ids(graph, plan);
            let next = ensure_node(graph, ctx, &mut out, node);
            let (from, to) = if rel.direction == Direction::In {
                (next, prev)
            } else {
                (prev, next)
            };
            // An edge MUST carry exactly one type: reject a typeless edge or a
            // non-conjunction type expression (empty → FAULT_BAD_LABEL) instead
            // of silently creating an empty-type edge that won't round-trip.
            let etype = creatable_labels(rel.label.as_ref(), ctx.label_names)
                .and_then(|ls| ls.into_iter().next());
            let etype = etype.unwrap_or_else(|| {
                ctx.set_fault(FAULT_BAD_LABEL);
                String::new()
            });
            ctx.refresh_ids(graph, plan);
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

/// Infer the conflict key for `_MERGE`: the single unique-constrained key present
/// in the pattern's props. `None` if none apply (can't define the key) or if more
/// than one does (ambiguous) — both surface as `FAULT_MERGE_KEY`
/// (`InvalidGraphOp`), matching the TS engine's code. See gql-extensions.md §2.2.
fn infer_merge_key(
    graph: &Graph,
    labels: &[String],
    props: &[(String, Value)],
) -> Option<(String, String, Value)> {
    let mut found: Option<(String, String, Value)> = None;
    for label in labels {
        for key in graph.unique_keys(label) {
            if let Some((_, value)) = props.iter().find(|(k, _)| k == key) {
                if found.is_some() {
                    return None; // ambiguous — more than one constrained key present
                }
                found = Some((label.clone(), key.clone(), value.clone()));
            }
        }
    }
    found
}

/// Apply `_ON_CREATE` / `_ON_UPDATE` SET items to the node or edge bound in
/// `binding` (mirrors [`run_set`]).
fn apply_merge_sets(graph: &mut Graph, ctx: &Ctx, items: &[CSetItem], binding: &Binding) {
    for item in items {
        match item {
            CSetItem::Prop {
                var_slot,
                key,
                value,
            } => {
                let target = binding.get(*var_slot).cloned();
                let v = {
                    let env = Env::new(graph, ctx, binding);
                    val_to_value(graph, &eval(&env, value))
                };
                match target {
                    Some(Val::Node(vi)) => graph.set_vertex_prop(vi, key, v),
                    Some(Val::Edge(ei)) => graph.set_edge_prop(ei, key, v),
                    _ => {}
                }
            }
            CSetItem::Label { var_slot, label } => match binding.get(*var_slot).cloned() {
                Some(Val::Node(vi)) => graph.add_vertex_label(vi, label),
                Some(Val::Edge(ei)) => graph.add_edge_label(ei, label),
                _ => {}
            },
        }
    }
}

/// Resolve a `_MERGE` edge endpoint: the vertex matched by the endpoint's
/// unique-constraint key. `None` if no key can be inferred or no vertex matches
/// (surfaced as `FAULT_MERGE_KEY` by the caller).
fn resolve_merge_endpoint(
    graph: &Graph,
    ctx: &Ctx,
    node: &CNode,
    binding: &Binding,
) -> Option<u32> {
    let labels = creatable_labels(node.label.as_ref(), ctx.label_names)?;
    let props = eval_props(graph, ctx, &node.props, binding);
    let (label, key, value) = infer_merge_key(graph, &labels, &props)?;
    graph.unique_lookup(&label, &key, &value)
}

/// `_MERGE` edge form (v1): match both endpoints by key, then upsert the single
/// edge between them keyed structurally by `(from, to, type)`. Dispositions apply
/// to the edge (which has no key prop, so the default clobbers all its props).
/// Byte-identical to the TS `runMergeEdge`.
fn run_merge_edge(graph: &mut Graph, ctx: &Ctx, clause: &CMerge, binding: &Binding) -> Binding {
    let mut out = binding.clone();
    let seg = &clause.pattern.segments[0];

    let (Some(a), Some(b)) = (
        resolve_merge_endpoint(graph, ctx, &clause.pattern.start, binding),
        resolve_merge_endpoint(graph, ctx, &seg.node, binding),
    ) else {
        ctx.set_fault(FAULT_MERGE_KEY);
        return out;
    };

    let (from, to) = if seg.rel.direction == Direction::In {
        (b, a)
    } else {
        (a, b)
    };
    let Some(etype) = creatable_labels(seg.rel.label.as_ref(), ctx.label_names)
        .and_then(|ls| ls.into_iter().next())
    else {
        ctx.set_fault(FAULT_BAD_LABEL);
        return out;
    };
    let eprops = eval_props(graph, ctx, &seg.rel.props, binding);

    // Bind the resolved endpoints so the dispositions' expressions can read them.
    if let Some(s) = clause.pattern.start.var_slot {
        out.set(s, Val::Node(a));
    }
    if let Some(s) = seg.node.var_slot {
        out.set(s, Val::Node(b));
    }

    let ei = if let Some(ei) = graph.find_edge(from, to, &etype) {
        // Update path. An edge has no key prop → the default clobbers all props.
        match &clause.on_update {
            None => {
                for (k, v) in &eprops {
                    graph.set_edge_prop(ei, k, v.clone());
                }
            }
            Some(CMergeUpdate::Nothing) => {}
            Some(CMergeUpdate::Set { items, where_ }) => {
                if let Some(s) = seg.rel.var_slot {
                    out.set(s, Val::Edge(ei));
                }
                let passes = match where_ {
                    None => true,
                    Some(w) => {
                        let env = Env::new(graph, ctx, &out);
                        as_truth(&eval(&env, w)) == Some(true)
                    }
                };
                if passes {
                    apply_merge_sets(graph, ctx, items, &out);
                }
            }
        }
        ei
    } else {
        // Create path.
        let ei = graph.add_edge(from, to, &etype, eprops);
        if let Some(s) = seg.rel.var_slot {
            out.set(s, Val::Edge(ei));
        }
        if let Some(items) = &clause.on_create {
            apply_merge_sets(graph, ctx, items, &out);
        }
        ei
    };

    if let Some(s) = seg.rel.var_slot {
        out.set(s, Val::Edge(ei));
    }
    out
}

/// `_MERGE` keyed upsert (v1: node form). Match by the constraint key; on miss,
/// insert the pattern (key + payload) then `_ON_CREATE`; on hit, apply the update
/// disposition — default clobbers the non-key payload, `_ON_UPDATE SET … [WHERE]`
/// replaces it, `_ON_UPDATE_NOTHING` leaves it. Byte-identical to the TS
/// `runMerge`. (Edge form arrives in a later slice.)
fn run_merge(graph: &mut Graph, ctx: &Ctx, clause: &CMerge, binding: &Binding) -> Binding {
    let mut out = binding.clone();

    // Edge form = exactly one segment `(a)-(rel)->(b)`. Multi-hop compound
    // patterns are deferred (v2).
    match clause.pattern.segments.len() {
        0 => {}
        1 => return run_merge_edge(graph, ctx, clause, &out),
        _ => {
            ctx.set_fault(FAULT_MERGE_EDGE);
            return out;
        }
    }

    let node = &clause.pattern.start;
    let labels = creatable_labels(node.label.as_ref(), ctx.label_names).unwrap_or_else(|| {
        ctx.set_fault(FAULT_BAD_LABEL);
        Vec::new()
    });
    let props = eval_props(graph, ctx, &node.props, binding);

    let Some((label, key, value)) = infer_merge_key(graph, &labels, &props) else {
        ctx.set_fault(FAULT_MERGE_KEY);
        return out;
    };

    let vi = if let Some(vi) = graph.unique_lookup(&label, &key, &value) {
        // Update path.
        match &clause.on_update {
            None => {
                // Default clobber: write every non-key payload prop.
                for (k, v) in &props {
                    if *k != key {
                        graph.set_vertex_prop(vi, k, v.clone());
                    }
                }
            }
            Some(CMergeUpdate::Nothing) => {}
            Some(CMergeUpdate::Set { items, where_ }) => {
                if let Some(slot) = node.var_slot {
                    out.set(slot, Val::Node(vi));
                }
                let passes = match where_ {
                    None => true,
                    Some(w) => {
                        let env = Env::new(graph, ctx, &out);
                        as_truth(&eval(&env, w)) == Some(true)
                    }
                };
                if passes {
                    apply_merge_sets(graph, ctx, items, &out);
                }
            }
        }
        vi
    } else {
        // Create path: insert the pattern (key + payload), then `_ON_CREATE`.
        let vi = graph.add_vertex(&labels, props);
        if let Some(slot) = node.var_slot {
            out.set(slot, Val::Node(vi));
        }
        if let Some(items) = &clause.on_create {
            apply_merge_sets(graph, ctx, items, &out);
        }
        vi
    };

    if let Some(slot) = node.var_slot {
        out.set(slot, Val::Node(vi));
    }
    out
}

fn run_set(graph: &mut Graph, ctx: &Ctx, items: &[CSetItem], binding: &Binding) {
    for item in items {
        match item {
            CSetItem::Prop {
                var_slot,
                key,
                value,
            } => {
                let Some(el) = binding.get(*var_slot).cloned() else {
                    continue;
                };
                let v = {
                    let env = Env::new(graph, ctx, binding);
                    val_to_value(graph, &eval(&env, value))
                };
                match el {
                    // A SET that would collide under a unique constraint faults
                    // (ConstraintViolation) rather than silently duplicating.
                    Val::Node(vi) => {
                        if graph.unique_conflict_on_set(vi, key, &v).is_some() {
                            ctx.set_fault(FAULT_CONSTRAINT);
                        } else {
                            graph.set_vertex_prop(vi, key, v);
                        }
                    }
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

fn run_delete(
    graph: &mut Graph,
    ctx: &Ctx,
    detach: bool,
    targets: &[CExpr],
    binding: &Binding,
) -> CodeResult<()> {
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

/// Keep only rows whose key passes `keep`, into a fresh flat RowSet.
fn filter_rows(rs: RowSet, mut keep: impl FnMut(&str) -> bool) -> RowSet {
    let mut out = RowSet::new(rs.cols.clone());
    for r in rs.rows() {
        if keep(&value_row_key(r)) {
            out.push_row(r.iter().cloned());
        }
    }
    out
}

fn distinct_rows(rs: RowSet) -> RowSet {
    let mut seen = HashSet::new();
    filter_rows(rs, |k| seen.insert(k.to_string()))
}

fn combine(op: SetOp, left: RowSet, right: RowSet) -> RowSet {
    let right_keys: HashSet<String> = right.rows().map(value_row_key).collect();
    match op.op {
        SetOpKind::Union => {
            let mut all = RowSet::new(left.cols.clone());
            for r in left.rows().chain(right.rows()) {
                all.push_row(r.iter().cloned());
            }
            if op.all {
                all
            } else {
                distinct_rows(all)
            }
        }
        SetOpKind::Except => {
            let kept = filter_rows(left, |k| !right_keys.contains(k));
            if op.all {
                kept
            } else {
                distinct_rows(kept)
            }
        }
        SetOpKind::Intersect => {
            let kept = filter_rows(left, |k| right_keys.contains(k));
            if op.all {
                kept
            } else {
                distinct_rows(kept)
            }
        }
    }
}

/// Execute a lowered plan against a graph with positional params. `run_linear`
/// already produced the terminal RETURN's flat `RowSet` (cols + columnar cells).
fn run_cquery(plan: &CQuery, graph: &mut Graph, params: &[Val]) -> CodeResult<RowSet> {
    if has_nested_aggregate(plan) {
        return Err(CodeError::new(
            ErrorCode::Unsupported,
            "aggregate functions cannot be nested",
        ));
    }
    if has_argless_aggregate(plan) {
        return Err(CodeError::new(
            ErrorCode::Unsupported,
            "aggregate function requires an argument (only count(*) is argless)",
        ));
    }
    let first = plan
        .parts
        .first()
        .ok_or_else(|| CodeError::new(ErrorCode::Syntax, "empty query"))?;
    let mut rs = run_part(first, graph, plan, params)?;
    for (i, op) in plan.ops.iter().enumerate() {
        let right = run_part(&plan.parts[i + 1], graph, plan, params)?;
        rs = combine(*op, rs, right);
    }
    Ok(rs)
}

/// Run one linear part: try the fully-vectorized pipeline executor first (it
/// handles read-only `MATCH … WITH … RETURN` chains end-to-end), else the scalar
/// binding-based driver.
fn run_part(
    linear: &CLinear,
    graph: &mut Graph,
    plan: &CQuery,
    params: &[Val],
) -> CodeResult<RowSet> {
    if USE_VEC {
        if let Some(rs) = vectorized_linear(linear, graph, plan, params) {
            return Ok(rs);
        }
    }
    run_linear(linear, graph, plan, params)
}

/// Typed Arrow fast path: a single fresh `MATCH` + plain `RETURN` (no WITH /
/// aggregate / DISTINCT / ORDER BY / `*`). Produces Arrow columns straight from
/// the vectorized `VVec`s, so numeric/bool columns skip the `Val`→`Value` boxing
/// the RowSet path would do. Returns `(columns, nrows)` or `None` to fall back.
#[cfg(feature = "arrow")]
fn vectorized_arrow(
    graph: &Graph,
    ctx: &Ctx,
    matches: &[&CClause],
    proj: &CProjection,
) -> Option<(Vec<ArrowColumn>, usize)> {
    if matches.len() != 1
        || proj.star
        || proj.aggregating
        || proj.distinct
        || !proj.order_by.is_empty()
    {
        return None;
    }
    let CClause::Match {
        optional: false,
        patterns,
        where_,
        scope_len,
        ..
    } = matches[0]
    else {
        return None;
    };
    if patterns.len() != 1 {
        return None;
    }
    let path = &patterns[0];
    let cap = where_
        .is_none()
        .then(|| proj.limit.map(|l| proj.skip.unwrap_or(0) + l))
        .flatten();
    // An index hint (vertex or edge) makes the scan a seek, so the LIMIT cap
    // can't early-stop it — drop the cap when a hint applies.
    let cap = if scan_is_hinted(graph, ctx, path, where_.as_ref()) {
        None
    } else {
        cap
    };
    let mut sc = build_scan(graph, ctx, path, *scope_len, cap, where_.as_ref())?;
    if let Some(w) = where_ {
        let keep: Vec<bool> = eval_vec(graph, ctx, &sc, w)
            .into_truth()
            .iter()
            .map(|t| *t == Some(true))
            .collect();
        compact(&mut sc, &keep);
    }
    let start = proj.skip.unwrap_or(0).min(sc.n);
    let end = proj.limit.map(|l| (start + l).min(sc.n)).unwrap_or(sc.n);
    let cols = proj
        .items
        .iter()
        .map(|it| {
            eval_vec(graph, ctx, &sc, &it.expr)
                .slice(start, end)
                .into_arrow(graph)
        })
        .collect();
    Some((cols, end - start))
}

/// Execute a plan and return an Arrow columnar blob. Uses the typed boxing-free
/// fast path for a single-part `MATCH … RETURN`; otherwise runs the normal
/// executor and converts its `RowSet` (correct for aggregate / WITH / UNION /
/// scalar — just not boxing-free).
#[cfg(feature = "arrow")]
fn run_cquery_arrow(plan: &CQuery, graph: &mut Graph, params: &[Val]) -> CodeResult<Vec<u8>> {
    if has_nested_aggregate(plan) {
        return Err(CodeError::new(
            ErrorCode::Unsupported,
            "aggregate functions cannot be nested",
        ));
    }
    if has_argless_aggregate(plan) {
        return Err(CodeError::new(
            ErrorCode::Unsupported,
            "aggregate function requires an argument (only count(*) is argless)",
        ));
    }
    if USE_VEC && plan.ops.is_empty() && plan.parts.len() == 1 {
        let linear = &plan.parts[0];
        if let Some((CClause::Return(proj), rest)) = linear.clauses.split_last() {
            if rest.iter().all(|c| {
                matches!(
                    c,
                    CClause::Match {
                        optional: false,
                        ..
                    }
                )
            }) {
                let ctx = resolve_ctx(graph, plan, params);
                let matches: Vec<&CClause> = rest.iter().collect();
                if let Some((cols, nrows)) = vectorized_arrow(graph, &ctx, &matches, proj) {
                    // A recorded data exception can't return Err from the typed
                    // fast path; fall through to the scalar path (read-only shape,
                    // safe to re-run), which surfaces the CodeError.
                    if !ctx.faulted() {
                        return Ok(crate::arrow::to_arrow_cols(&proj.out_names, &cols, nrows));
                    }
                }
            }
        }
    }
    let rs = run_cquery(plan, graph, params)?;
    Ok(crate::arrow::to_arrow(&rs))
}

/// Bind named params into the plan's positional slot order. A `$name` the query
/// references but the caller didn't supply is an error (not a silent NULL) — a
/// missing binding is a programming mistake, so fail loud. Mirrors the TS
/// engine's eager check.
fn positional(param_names: &[String], params: &Params) -> CodeResult<Vec<Val>> {
    param_names
        .iter()
        .map(|n| {
            params.get(n).cloned().ok_or_else(|| {
                CodeError::new(
                    ErrorCode::MissingParameter,
                    format!("missing parameter: ${n}"),
                )
            })
        })
        .collect()
}

/// A prepared (lowered) query: compile once, execute many times with different
/// params against any graph. Parameters slot in positionally at execute time.
pub struct Prepared {
    plan: CQuery,
    /// param slot → name (the order positional args are bound in).
    param_names: Vec<String>,
}

impl Prepared {
    pub fn execute(&self, graph: &mut Graph, params: &Params) -> CodeResult<RowSet> {
        run_cquery(&self.plan, graph, &positional(&self.param_names, params)?)
    }
    /// Execute and return the result as an Apache Arrow columnar blob (see
    /// [`crate::arrow`]) — the zero-copy carrier for the FFI / wasm boundary.
    #[cfg(feature = "arrow")]
    pub fn execute_arrow(&self, graph: &mut Graph, params: &Params) -> CodeResult<Vec<u8>> {
        run_cquery_arrow(&self.plan, graph, &positional(&self.param_names, params)?)
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
    pub fn execute(&self, graph: &mut Graph, params: &Params) -> CodeResult<RowSet> {
        let (plan, param_names) = lower(self);
        run_cquery(&plan, graph, &positional(&param_names, params)?)
    }
    /// Lower and execute, returning an Apache Arrow columnar blob.
    #[cfg(feature = "arrow")]
    pub fn execute_arrow(&self, graph: &mut Graph, params: &Params) -> CodeResult<Vec<u8>> {
        let (plan, param_names) = lower(self);
        run_cquery_arrow(&plan, graph, &positional(&param_names, params)?)
    }
}
