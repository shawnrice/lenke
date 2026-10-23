//! `eval` — the expression evaluator, plus the whole-batch shortcuts that avoid it.
//!
//! `eval` is the per-row fallback. Everything above it exists to not call it: `in_set` keeps a
//! prepared membership set, `eval_case_masked` evaluates a `CASE` over a column rather than a
//! row, `arith_general` is the slow arithmetic arm, and `degree_chain_count`/
//! `degree_count_subquery` answer a `COUNT{}` subquery from degrees instead of a traversal.
//!
//! The evaluator reads a property through the BINDING, not by re-resolving the element — that is
//! what makes a projection cheap, and it is why a slot remap has to go through
//! [`super::fastpath::remap_slot`] rather than being spelled by hand.
//!
//! `LabelMode` is a per-call policy (`with_label_mode`), and the two `label_mode_*` predicates
//! are `#[cfg(test)]`/`#[cfg(not(test))]` PAIRS — the shortcut and bitset choices are forced in
//! test builds, so a test exercises the route it means to. The corollary: a route decision read
//! off a test build is not the production one.

use super::scalar::*;
use super::*;
use crate::batch::{Batch, Col};
use crate::gstr::GStr;
use crate::ir::Expr;
use crate::store::{Column, Store};
use crate::value::{self, Value};

/// A bare node-LABEL test over one slot, in either spelling the lowering produces.
///
/// `IsLabeled` is the canonical node, but GQL's `(x:L)` pattern lowers to `'L' IN labels(slot)`
/// and the canonicalizer that rewrites one into the other (`opt::normalize_pred`) runs over
/// TOP-LEVEL plans only. **A correlated subquery body is a `Plan` nested inside an `Expr`, and
/// `opt` never descends into one** — so a body's label test arrives in the pre-canonical form
/// and this has to read both (item 500). That is also why a subquery body gets no filter
/// pushdown and no index seeding, which is a larger open question than this one call site.
fn label_test_of(e: &Expr) -> Option<(usize, Vec<String>)> {
    match e {
        Expr::IsLabeled { slot, labels } => Some((*slot, labels.clone())),
        Expr::In { needle, haystack } => match (needle.as_ref(), haystack.as_ref()) {
            (Expr::Lit(Value::Str(l)), Expr::Call { name, args }) if name == "labels" => {
                match args.as_slice() {
                    [Expr::Slot(s)] => Some((*s, vec![l.to_string()])),
                    _ => None,
                }
            }
            _ => None,
        },
        _ => None,
    }
}

/// One recognized hop of a correlated `COUNT { … }` body, with its type set resolved once.
struct DegreeHop {
    dir: Dir,
    want: Vec<u32>,
    double_loops: bool,
    /// Whether `want` matches EVERY edge, so a degree is a slice length (see `matching_degree`).
    all_types: bool,
}

/// The number of hop-chain paths out of `v`, by DEGREE rather than by enumeration.
///
/// The last hop is a `matching_degree` — one number per node, read off a contiguous adjacency
/// slice when it can be. Every earlier hop walks, because the next hop's degree depends on WHICH
/// neighbour was landed on. So an `h`-hop chain costs `degree^(h-1)` adjacency steps and a degree
/// read at each, where materializing the rows costs `degree^h`.
fn degree_chain_count(store: &Store, v: u32, hops: &[DegreeHop], far: &[&[u32]]) -> f64 {
    let h = &hops[0];
    if hops.len() == 1 {
        // No landing filter: the degree IS the answer, read off a contiguous slice when the
        // adjacency can give one.
        if far.is_empty() {
            return matching_degree(store, v, h.dir, &h.want, h.double_loops, h.all_types);
        }
        // With one, the last hop has to WALK — a degree cannot say which of a vertex's edges
        // land somewhere that passes (items 219, 290). It is still the adjacency walk the
        // general path would do, without materializing a row per path: each label's id bucket
        // is resolved ONCE for the whole batch and binary-searched per neighbour, which is the
        // `IsLabeled` evaluator's own probe arm.
        let mut n = 0f64;
        for_each_nbr(store, v, h.dir, &h.want, h.double_loops, |nbr, _| {
            if far.iter().any(|b| b.binary_search(&nbr).is_ok()) {
                n += 1.0;
            }
        });
        return n;
    }
    let mut n = 0f64;
    for_each_nbr(store, v, h.dir, &h.want, h.double_loops, |nbr, _| {
        n += degree_chain_count(store, nbr, &hops[1..], far);
    });
    n
}

/// The most hops this answers. Beyond it the walk is `degree^(h-1)` adjacency steps against
/// `degree^h` materialized rows — still a win on paper, but the ratio tends to 1 and the
/// recursion depth is unbounded by anything in the query, so it stops here and the general
/// pull takes over.
const DEGREE_CHAIN_MAX_HOPS: usize = 3;

/// A correlated `COUNT { MATCH (u)-[:T]->(x)… }` whose body is a chain of UNFILTERED node-only
/// hops is a DEGREE question, and the degrees are already in the adjacency.
///
/// The general path tags each outer row with a provenance id, runs the body, and tallies the
/// sub-rows by that id — so it MATERIALIZES every path. Measured on the repo's own 200,000-vertex
/// degree-5 fixture (`route-cost-probe`, one case per process, min of 9): the one-hop form 14.6ms,
/// the two-hop 75.0ms, the three-hop 270.9ms — ~11-15ns per SUB-ROW at 1M, 5M and 25M of them,
/// which is the enumeration and nothing else. The same engine answers the whole-graph two-hop
/// count (`MATCH (:P)-[:T]->(b)-[:T]->(c) RETURN count(*)`, the same total edge work, just not
/// partitioned by anchor) in 2.7ms, because THAT shape has had a degree product since item 221.
///
/// Admission is deliberately narrow, and every refusal is a position where a degree cannot
/// answer: a `Filter` anywhere in the body (a node label, an inline property, a sub-`WHERE`) is
/// not a chain of `Expand`s and declines, because a degree cannot say which of a vertex's edges
/// land somewhere that passes — items 219 and 290's rule, one level in. A bound edge
/// (`bind_edge`) declines for the same reason the TS twin does: the edge is a VALUE the body may
/// read. And the slot chain is checked rather than assumed: hop 0 must read an OUTER slot and hop
/// `k` must read the slot hop `k-1` landed in, so a body that re-expands an earlier position
/// (a self-join, not a degree) is refused.
fn degree_count_subquery(
    body: &Plan,
    outer_width: usize,
    store: &Store,
    batch: &Batch,
) -> Option<Vec<f64>> {
    // The provenance column the general path appends sits at `batch.slots.len()`, and the body
    // was lowered against an outer width of `outer_width` — so the two must agree before any
    // landing slot computed from `outer_width` means anything.
    if batch.slots.len() != outer_width {
        return None;
    }

    // One `Filter` may sit outermost, and only if it is a bare LABEL test on what the last hop
    // landed in — `COUNT { (u)-[:T]->(x:L) }`, the single most common filtered degree. Anything
    // else (a property, a sub-`WHERE`, a filter BETWEEN hops) is a different question and
    // declines as before, because a degree cannot say which of a vertex's edges land somewhere
    // that passes. The slot it tests is checked against the chain's own last landing below, so
    // a filter on a MIDDLE position cannot be mistaken for one on the end.
    let (body, far_labels) = match body {
        Plan::Filter { input, pred } => match label_test_of(pred) {
            Some(test) => (input.as_ref(), Some(test)),
            None => (body, None),
        },
        other => (other, None),
    };

    // Unwind outermost-first: the body is `Expand(Expand(… Row))`.
    let mut chain: Vec<(Dir, &[String], bool)> = Vec::new();
    let mut froms: Vec<usize> = Vec::new();
    let mut cur = body;
    loop {
        match cur {
            Plan::Expand {
                input,
                from,
                dir,
                edge_label,
                bind_edge: false,
                double_loops,
            } => {
                if chain.len() == DEGREE_CHAIN_MAX_HOPS {
                    return None;
                }
                chain.push((*dir, edge_label, *double_loops));
                froms.push(*from);
                cur = input;
            }
            Plan::Row => break,
            _ => return None,
        }
    }
    if chain.is_empty() {
        return None;
    }
    chain.reverse();
    froms.reverse();

    // Hop `k` (k ≥ 1) must expand what hop `k-1` landed in. The seed is the outer row plus the
    // provenance column, so its width is `outer_width + 1` and hop `k-1` lands at
    // `outer_width + k`.
    for (k, &from) in froms.iter().enumerate().skip(1) {
        if from != outer_width + k {
            return None;
        }
    }
    // Both of the remaining guards are DEFENSIVE, and their mutants survive the suite — recorded
    // here rather than implied, because a survivor nobody explains is indistinguishable from a
    // missing test. Removing the slot-chain check above changes no answer because `extend_chain`
    // carries `from` forward hop by hop, so a GQL body is a single chain by construction and
    // there is no comma/branching body to lower; and this one is subsumed by the slot read
    // immediately below, which returns `None` for any index past the batch's width anyway.
    let anchor_slot = froms[0];
    if anchor_slot >= outer_width {
        return None; // hop 0 must read an OUTER slot: the correlated variable
    }
    let Some(Col::Nodes(anchors)) = batch.slots.get(anchor_slot) else {
        return None;
    };

    let mut hops: Vec<DegreeHop> = Vec::with_capacity(chain.len());
    for (dir, edge_label, double_loops) in chain {
        // An unknown edge type matches no edge, so every count is 0 — the same answer the
        // general path gives by matching nothing, reached without walking.
        let Ok(want) = want_etypes(store, edge_label) else {
            return Some(vec![0f64; anchors.len()]);
        };
        let all_types = want_covers_all_etypes(store, &want);
        hops.push(DegreeHop {
            dir,
            want,
            double_loops,
            all_types,
        });
    }

    // The label test must be on the LAST landing: hop `k` lands at `outer_width + 1 + k`, so the
    // final one is `outer_width + hops.len()`.
    let far: Vec<&[u32]> = match &far_labels {
        None => Vec::new(),
        Some((slot, labels)) => {
            if *slot != outer_width + hops.len() {
                return None;
            }
            // An unknown label matches NOTHING (never everything) — `nodes_with_label` returns
            // an empty slice for it, and an all-empty set makes every count 0, which is the
            // answer the general path gives by matching nothing.
            labels.iter().map(|l| store.nodes_with_label(l)).collect()
        }
    };

    Some(
        anchors
            .iter()
            .map(|&v| {
                // The OPTIONAL sentinel is not a node, so nothing expands from it (the general
                // path's `Expand` drops such a row and the tally stays 0).
                if v == u32::MAX {
                    0f64
                } else {
                    degree_chain_count(store, v, &hops, &far)
                }
            })
            .collect(),
    )
}

/// Smallest haystack worth hashing. Below it the linear scan wins: building the set costs a
/// `group_key` per element, and a two- or three-element scan is two or three `equals` calls.
/// Measured in audit item 185.
const fn items_min() -> usize {
    8
}

/// A hashed membership set over a constant `IN` haystack, with the three-valued answer baked in.
///
/// Equivalence with the linear scan it replaces is the whole point, so the construction is
/// deliberately narrow. `group_key` is a canonical hashable key, but it is NOT `equals`: it
/// groups two NaNs together and `-0.0` with `0.0`, where predicate equality makes NaN equal to
/// nothing. `-0.0 == 0.0` agrees with `equals` already; NaN does not, and a NaN nested inside a
/// list or record element would differ too. So the set is built ONLY from `Bool`, `Str` and
/// FINITE `Num` elements — the types an `IN` list actually carries — and ANY other element kind
/// (a non-finite number, a list, record, map, temporal or element ref) makes the whole batch fall
/// back to the scan. For the covered types `group_key` equality and `equals` coincide exactly.
pub(super) struct InSet {
    keys: std::collections::HashSet<Vec<u8>>,
    /// Whether any element was null: with no match, that is the difference between FALSE and
    /// UNKNOWN, which is the part of the three-valued answer a membership test cannot see.
    has_null: bool,
}

impl InSet {
    /// The three-valued answer for one needle: NULL if the needle is null (nothing can equal it),
    /// TRUE on a hit, else NULL when the haystack held a null and FALSE otherwise.
    fn contains(&self, needle: &Value, key: &mut Vec<u8>) -> Value {
        if needle.is_null() {
            return Value::Null;
        }
        // No NaN check here, deliberately. `group_key` hashes two NaNs alike where `equals`
        // makes NaN equal to nothing — but a NaN ELEMENT makes `in_set` refuse the whole list,
        // so `keys` can never hold one and a NaN needle simply misses, reaching the same answer.
        // An explicit early return was DEAD CODE: a mutant deleting it changed nothing, which is
        // how it was found.
        key.clear();
        value::group_key_into(needle, key);
        if self.keys.contains(key) {
            Value::Bool(true)
        } else if self.has_null {
            Value::Null
        } else {
            Value::Bool(false)
        }
    }
}

/// Build an [`InSet`] when `haystack` is a literal list of at least `min` elements whose every
/// element is a type `group_key` and `equals` agree on. `None` leaves the caller on its scan.
///
/// `pub(super)` ONLY so the choice can be asserted directly. Taking the hashed path changes no
/// answer — that is the point of it — so a mutant that never takes it passes every result-based
/// test; the same wall items 172/173 hit, and the same escape.
pub(super) fn in_set(haystack: &Expr, min: usize) -> Option<InSet> {
    let Expr::Lit(Value::List(items)) = haystack else {
        return None;
    };
    if items.len() < min {
        return None;
    }
    let mut keys = std::collections::HashSet::with_capacity(items.len());
    let mut has_null = false;
    for el in items.iter() {
        match el {
            Value::Null => has_null = true,
            Value::Bool(_) | Value::Str(_) => {
                keys.insert(value::group_key(el));
            }
            // Only NaN disagrees. `equals` compares `Num`s with `==`, which makes `Inf == Inf`
            // TRUE and NaN equal to nothing, and `group_key` agrees on both except NaN — so
            // excluding every non-finite would be over-conservative, and was: a mutant
            // accepting them changed no answer.
            Value::Num(x) if !x.is_nan() => {
                keys.insert(value::group_key(el));
            }
            // Anything else: hand the whole batch back to the scan rather than reason about
            // whether `group_key` and `equals` agree on it.
            _ => return None,
        }
    }
    Some(InSet { keys, has_null })
}

/// Elementwise `l OP r` over two already-evaluated columns — the general arithmetic
/// body, shared by `Expr::Arith` and its scalar fast path's non-numeric fallback.
/// Raw f64 when both are `Col::Num`; otherwise per-cell via the value contract (a
/// NULL / non-numeric operand → NULL, a temporal operand → `temporal_arith`). Div/Rem
/// by a zero divisor (the RIGHT operand) throws, matching the TS engine's DataException.
fn arith_general(op: crate::ir::ArithOp, l: &Col, r: &Col) -> Result<Col, String> {
    use crate::ir::ArithOp::{Add, Div, Mul, Rem, Sub};
    if let (Col::Num(xs), Col::Num(ys)) = (l, r) {
        let n = xs.len().min(ys.len());
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let (x, y) = (xs[i], ys[i]);
            if matches!(op, Div | Rem) && y == 0.0 {
                return Err("division by zero".into());
            }
            out.push(match op {
                Add => x + y,
                Sub => x - y,
                Mul => x * y,
                Div => x / y,
                Rem => x % y,
            });
        }
        return Ok(Col::Num(out));
    }
    let n = l.len().min(r.len());
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let a = l.value_at(i);
        let b = r.value_at(i);
        let v = if matches!(a, Value::Temporal(_)) || matches!(b, Value::Temporal(_)) {
            if a.is_null() || b.is_null() {
                Value::Null
            } else {
                temporal_arith(op, &a, &b)?
            }
        } else {
            match (value::num_of(&a), value::num_of(&b)) {
                (Some(x), Some(y)) => {
                    if matches!(op, Div | Rem) && y == 0.0 {
                        return Err("division by zero".into());
                    }
                    Value::Num(match op {
                        Add => x + y,
                        Sub => x - y,
                        Mul => x * y,
                        Div => x / y,
                        Rem => x % y,
                    })
                }
                // A NULL operand → NULL (three-valued). A NON-null NON-numeric operand
                // (string/bool/list/record) is a DATA EXCEPTION — arithmetic never
                // implicitly coerces; use an explicit CAST (`CAST('1' AS INT) * n`). This
                // is the TS engine's SQL-style rule (`'abc' + 1` throws; `1 + null` is null).
                _ if a.is_null() || b.is_null() => Value::Null,
                _ => return Err("arithmetic requires a number".into()),
            }
        };
        out.push(v);
    }
    Ok(Col::Gen(out))
}

/// Evaluate `expr` over every row of `batch`, producing a column.
/// Lazy (SQL-standard) CASE evaluation — the fallback when the inline eager path throws,
/// because a type error may live in a branch a row never actually reaches. Each condition
/// is evaluated only over the rows still UNRESOLVED at that branch, and each value only
/// over the rows that select it, via a gathered sub-batch. So a branch's type error
/// surfaces ONLY if a row that genuinely reaches that condition (or takes that value) is
/// ill-typed — matching TS and SQL, where `CASE WHEN c THEN safe ELSE risky END` never
/// evaluates `risky` for a row where `c` holds. Slower (per-branch gather), so it runs only
/// on the error path; the eager path stays fully vectorized.
/// A `CASE` whose branch values and `ELSE` are all LITERALS: select between constants
/// (audit item 464).
///
/// Item 463 priced a CASE in an AGGREGATE ARGUMENT at ~55x the floor — `count(a.k)` 0.448 ms
/// against `count(CASE WHEN a.k > 3 THEN 1 ELSE 0 END)` 26.0 at 1,000,000 rows — and found all
/// four variants within 15% of each other whatever their arms held. That is item 442's tell: the
/// cost is `Expr::Case` itself, not the arms, exactly as item 450 found one position over.
///
/// What the eager path does that this does not: `eval_all` over the branch VALUES materializes a
/// column per branch (N `f64`s to represent the constant `1`), `else_col` materializes another,
/// and the row loop then calls `value_at` once per branch per row to pick one, boxing as it
/// goes. With literal arms every one of those is avoidable — the values are already `Value`s and
/// the only per-row work is deciding WHICH.
///
/// It returns a `Col::Num` when every arm is a non-null number, so an aggregate folds raw `f64`s
/// instead of unboxing; otherwise a `Col::Gen` of cloned literals (a `Value` clone is a copy for
/// `Num`/`Bool` and a refcount bump for `Str`).
///
/// SEMANTICS are the eager path's, not a re-derivation: the first branch whose condition is
/// literally TRUE wins, a FALSE or NULL condition falls through, and a non-null non-boolean
/// condition is `TRUTH_TYPE_ERR`. Returning `Err` here lands on the same masked fallback the
/// eager path uses, so an error in a branch nobody reaches still behaves as it did.
///
/// `#[inline(never)]` and its own function for the reason items 453, 459 and 462 each measured:
/// a fast path written inline costs the shapes it never serves.
#[inline(never)]
fn case_literal_arms(
    branches: &[(Expr, Expr)],
    otherwise: Option<&Expr>,
    store: &Store,
    batch: &Batch,
) -> Result<Option<Col>, String> {
    if branches.is_empty() || !branches.iter().all(|(_, v)| matches!(v, Expr::Lit(_))) {
        return Ok(None);
    }

    let els: &Value = match otherwise {
        None => &Value::Null,
        Some(Expr::Lit(v)) => v,
        Some(_) => return Ok(None),
    };
    let lits: Vec<&Value> = branches
        .iter()
        .map(|(_, v)| match v {
            Expr::Lit(x) => x,
            _ => unreachable!("guarded above"),
        })
        .collect();
    let conds = eval_all(branches.iter().map(|(c, _)| c), store, batch)?;
    let n = batch.rows();
    // Which arm each row takes: `None` is the `ELSE`. Decided once, so the two output loops
    // below differ only in how they build their column.
    let mut pick: Vec<Option<usize>> = Vec::with_capacity(n);

    for i in 0..n {
        let mut taken = None;

        for (bi, c) in conds.iter().enumerate() {
            match c.value_at(i) {
                Value::Bool(true) => {
                    taken = Some(bi);
                    break;
                }
                Value::Bool(false) | Value::Null => {}
                // The eager path's error, so the masked fallback runs exactly as before.
                _ => return Err(TRUTH_TYPE_ERR.to_string()),
            }
        }

        pick.push(taken);
    }

    // ALL-NUMERIC arms stay a `Col::Num`, which is what lets an aggregate fold raw `f64`s. A
    // NULL anywhere forces the boxed column, because `Col::Num` has no null representation —
    // the same rule item 458 relies on from the other direction.
    let nums: Option<Vec<f64>> = lits
        .iter()
        .chain(std::iter::once(&els))
        .map(|v| match v {
            Value::Num(x) => Some(*x),
            _ => None,
        })
        .collect();

    if let Some(nums) = nums {
        let (arms, fallback) = nums.split_at(lits.len());
        let else_num = fallback[0];

        return Ok(Some(Col::Num(
            pick.iter()
                .map(|p| p.map_or(else_num, |bi| arms[bi]))
                .collect(),
        )));
    }

    Ok(Some(Col::Gen(
        pick.iter()
            .map(|p| p.map_or_else(|| els.clone(), |bi| lits[bi].clone()))
            .collect(),
    )))
}

fn eval_case_masked(
    branches: &[(Expr, Expr)],
    otherwise: Option<&Expr>,
    store: &Store,
    batch: &Batch,
) -> Result<Col, String> {
    let n = batch.rows();
    let mut out = vec![Value::Null; n];
    // Original row indices not yet resolved by an earlier branch.
    let mut pending: Vec<usize> = (0..n).collect();
    for (cond, val) in branches {
        if pending.is_empty() {
            break;
        }
        // The condition, evaluated ONLY over the rows that still reach this branch.
        let cond_col = eval(cond, store, &batch.gather(&pending))?;
        let mut taken: Vec<usize> = Vec::new();
        let mut still: Vec<usize> = Vec::with_capacity(pending.len());
        for (k, &orig) in pending.iter().enumerate() {
            match cond_col.value_at(k) {
                Value::Bool(true) => taken.push(orig),
                Value::Bool(false) | Value::Null => still.push(orig),
                _ => return Err(TRUTH_TYPE_ERR.to_string()),
            }
        }
        if !taken.is_empty() {
            // The value, evaluated ONLY over the rows that took this branch.
            let vcol = eval(val, store, &batch.gather(&taken))?;
            for (k, &orig) in taken.iter().enumerate() {
                out[orig] = vcol.value_at(k);
            }
        }
        pending = still;
    }
    // Rows that matched no branch → ELSE (over just those rows) or NULL.
    if !pending.is_empty() {
        if let Some(e) = otherwise {
            let ecol = eval(e, store, &batch.gather(&pending))?;
            for (k, &orig) in pending.iter().enumerate() {
                out[orig] = ecol.value_at(k);
            }
        }
    }
    Ok(Col::Gen(out))
}

// `IsLabeled` on a node column has THREE implementations — a tautology short-circuit, a
// membership bitset, and a per-row bucket probe — and which one runs is a cost decision. All
// three must produce identical answers, and nothing forced a comparison: the fuzzer simply
// ran whichever the estimate picked. Under `cfg(test)` the choice can be forced, so the same
// plan can be run down each path and the results compared. Same technique as `with_dense_cut`
// for the count frontier, and for the same reason.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum LabelMode {
    /// Whatever the cost estimate picks.
    Auto,
    /// Skip the tautology short-circuit and force the bitset.
    Bitset,
    /// Skip the short-circuit and force the per-row probe.
    Probe,
}

#[cfg(test)]
thread_local! {
    static LABEL_MODE: std::cell::Cell<LabelMode> = const { std::cell::Cell::new(LabelMode::Auto) };
}

/// Run `f` with the `IsLabeled` implementation forced.
#[cfg(test)]
pub(crate) fn with_label_mode<T>(mode: LabelMode, f: impl FnOnce() -> T) -> T {
    let prev = LABEL_MODE.with(|c| c.replace(mode));
    let out = f();
    LABEL_MODE.with(|c| c.set(prev));
    out
}

#[cfg(test)]
fn label_mode_allows_shortcut() -> bool {
    LABEL_MODE.with(|c| c.get()) == LabelMode::Auto
}

#[cfg(not(test))]
fn label_mode_allows_shortcut() -> bool {
    true
}

#[cfg(test)]
fn label_mode_prefers_bitset(probe_cost: usize, bitset_cost: usize) -> bool {
    match LABEL_MODE.with(|c| c.get()) {
        LabelMode::Auto => probe_cost >= bitset_cost,
        LabelMode::Bitset => true,
        LabelMode::Probe => false,
    }
}

#[cfg(not(test))]
fn label_mode_prefers_bitset(probe_cost: usize, bitset_cost: usize) -> bool {
    probe_cost >= bitset_cost
}

pub(super) fn eval(expr: &Expr, store: &Store, batch: &Batch) -> Result<Col, String> {
    // No rows → no values to produce, and nothing to evaluate: a constant faulting
    // expression (`1/0` under `… LIMIT 0 RETURN 1/0`) must not error over an empty
    // batch. Short-circuit before any per-expression work.
    if batch.rows() == 0 {
        return Ok(Col::Gen(Vec::new()));
    }
    Ok(match expr {
        Expr::Slot(n) => batch.slot(*n).clone(),
        Expr::Lit(v) => broadcast(v.clone(), batch.rows()),
        // A `Param` must be substituted by `bind::bind_params` before eval; if one
        // survives, fail loudly rather than mis-evaluate (the safety net).
        Expr::Param(name) => {
            return Err(format!(
                "unbound parameter `${name}` (internal: not bound before evaluation)"
            ))
        }
        Expr::Prop { slot, key } => read_property(store, batch.slot(*slot), key),
        // `<base>.key` — evaluate the base to a column, then read the field/property
        // from it (the general form of `Prop`).
        Expr::Field { base, key } => {
            let col = eval(base, store, batch)?;
            read_property(store, &col, key)
        }
        // `base[index]` — 0-based list element or record/map field. Out of range /
        // negative / non-integer index → NULL; null-safe. Mirrors the TS engine.
        //
        // Special case: `nodes(p)[i]` / relationships(p)[i]` (an Index over a path
        // accessor) must keep the ELEMENT typing so a following `.prop` resolves the
        // node/edge property (`edges(p)[0].w`). The path lists carry ids as `Num`,
        // which a generic list-index would flatten to an untyped scalar. Emit a typed
        // `Col::Nodes`/`Col::Edges` instead (out-of-range → `u32::MAX` null sentinel).
        Expr::Index { base, index, .. }
            if matches!(
                base.as_ref(),
                Expr::PathAccess {
                    part: crate::ir::PathPart::Nodes | crate::ir::PathPart::Relationships
                }
            ) =>
        {
            let is_nodes = matches!(
                base.as_ref(),
                Expr::PathAccess {
                    part: crate::ir::PathPart::Nodes
                }
            );
            let icol = eval(index, store, batch)?;
            let ids: Vec<u32> = match &batch.lineage {
                Some(lin) => (0..batch.rows())
                    .map(|i| {
                        let elems = if is_nodes {
                            lin.path_at(i)
                        } else {
                            lin.edges_at(i)
                        };
                        match icol.value_at(i) {
                            Value::Num(n)
                                if n >= 0.0 && n.fract() == 0.0 && (n as usize) < elems.len() =>
                            {
                                match elems[n as usize] {
                                    Value::Num(x) => x as u32,
                                    _ => u32::MAX,
                                }
                            }
                            _ => u32::MAX,
                        }
                    })
                    .collect(),
                None => vec![u32::MAX; batch.rows()],
            };
            if is_nodes {
                Col::Nodes(ids)
            } else {
                Col::Edges(ids)
            }
        }
        Expr::Index { base, index, elem } => {
            // FUSED `<node>.<key>[<i>]`: read ONE element off the STORED list, instead of
            // evaluating the base into a `Col::Gen` of CLONED lists and indexing that.
            //
            // The change item 641 named as the real target after refuting the borrow at the
            // indexing site: that borrow removed the SECOND copy and left the dominant one —
            // `eval(base)` materializes a cloned `Value::List` PER ROW, O(rows x len), before
            // any index happens. 641 measured the shape at 1360 ns/row against 7.1 for a plain
            // property read at length 64, which is 191x.
            //
            // NOT the shape item 645 refuted. That BORROWED a list in order to SCAN it and lost,
            // because the clone was also compacting scattered storage into a contiguous buffer.
            // Here exactly ONE element is read, so there is no scan for locality to help.
            //
            // The PRE-SCAN is the same device `size()`/`cardinality()` use a few arms up: a
            // discriminant check per row with no allocation, so a column holding records, maps
            // or scalars costs one pass and then takes the general path below — which stays the
            // single implementation of every case this does not answer.
            if let (crate::ir::ElemKind::Plain, Expr::Prop { slot, key }) = (elem, base.as_ref()) {
                if let Col::Nodes(ids) = batch.slot(*slot) {
                    let all_lists = ids.iter().all(|&id| {
                        id != u32::MAX && matches!(store.prop_ref(id, key), Some(Value::List(_)))
                    });

                    if all_lists {
                        let icol = eval(index, store, batch)?;
                        let out: Vec<Value> = (0..batch.rows())
                            .map(|i| {
                                let Some(Value::List(items)) = store.prop_ref(ids[i], key) else {
                                    return Value::Null; // the pre-scan proved this cannot happen
                                };

                                match icol.value_at(i) {
                                    Value::Num(x)
                                        if x >= 0.0
                                            && x.fract() == 0.0
                                            && (x as usize) < items.len() =>
                                    {
                                        items[x as usize].clone()
                                    }
                                    _ => Value::Null,
                                }
                            })
                            .collect();

                        return Ok(Col::Gen(out));
                    }
                }
            }

            let bcol = eval(base, store, batch)?;
            let icol = eval(index, store, batch)?;
            // Index into the per-row list/record/map → the element value (or NULL).
            //
            // 🛑 BORROWING THE ROW INSTEAD OF `value_at` WAS TRIED AND REFUTED (item 641).
            // `value_at` returns an OWNED `Value`, so reading ONE element copies the WHOLE
            // container first — an O(1) read doing O(len) work, and the same pattern
            // `size()`/`cardinality()` borrows around just below. Replacing this with a
            // `match &bcol { Col::Gen(v) => Some(v), _ => None }` borrow measured, min of
            // three each side, 100,000 rows grouped on the expression:
            //
            //        len 1    len 8     len 64
            //   now   56.2     88.2     1345.4   ns/row
            //   borrow 45.3    200.0    1249.6
            //         1.24x   2.25x SLOWER  1.08x
            //
            // NON-MONOTONIC, with a 2.25x REGRESSION in the middle. Measuring only len 64
            // would have shipped it as a 1.08x win.
            //
            // And the clone removed is not the dominant one: `eval(base)` already
            // materialized a `Col::Gen` holding a CLONED `Value::List` per row before any
            // indexing happens, which is O(rows × len). That is the real target — a fused
            // read that pulls one element out of the stored list without building the column
            // — and it is open. The cost it would recover is large: at len 64 an index is
            // 1360 ns/row against 7.1 for a plain property read on the same node, 191x.
            let at = |i: usize| match bcol.value_at(i) {
                Value::List(items) => match icol.value_at(i) {
                    Value::Num(n) if n >= 0.0 && n.fract() == 0.0 && (n as usize) < items.len() => {
                        items[n as usize].clone()
                    }
                    _ => Value::Null,
                },
                Value::Record(fields) => match icol.value_at(i) {
                    Value::Str(k) => fields
                        .iter()
                        .find(|(fk, _)| fk.as_ref() == k.as_str())
                        .map_or(Value::Null, |(_, v)| v.clone()),
                    _ => Value::Null,
                },
                Value::Map(entries) => match icol.value_at(i) {
                    Value::Str(k) => entries
                        .iter()
                        .find(|(ek, _)| matches!(ek, Value::Str(s) if *s == k))
                        .map_or(Value::Null, |(_, v)| v.clone()),
                    _ => Value::Null,
                },
                _ => Value::Null,
            };
            match elem {
                // A group-variable list element keeps NODE/EDGE typing so a following
                // `.prop` resolves — mirror the path-subscript case: emit a typed
                // `Col::Nodes`/`Col::Edges` (out-of-range / non-node → u32::MAX null).
                crate::ir::ElemKind::Node | crate::ir::ElemKind::Edge => {
                    let ids: Vec<u32> = (0..batch.rows())
                        .map(|i| match at(i) {
                            Value::Num(x) if x >= 0.0 && x.fract() == 0.0 => x as u32,
                            _ => u32::MAX,
                        })
                        .collect();
                    if matches!(elem, crate::ir::ElemKind::Node) {
                        Col::Nodes(ids)
                    } else {
                        Col::Edges(ids)
                    }
                }
                crate::ir::ElemKind::Plain => Col::Gen((0..batch.rows()).map(at).collect()),
            }
        }
        Expr::Path => match &batch.lineage {
            // A bound path RETURNs as a rich Path object `{vertices, edges, length}`
            // (key order matches the pure-TS Path serialization), each vertex/edge a
            // full element map. NULL when the plan tracks no lineage (which
            // `needs_lineage` prevents when Path is actually read).
            Some(lin) => Col::Gen(
                (0..batch.rows())
                    .map(|i| {
                        let vertices = path_node_values(store, lin.path_at(i));
                        let edges = path_edge_values(store, lin.edges_at(i));
                        let len = edges.len() as f64;
                        Value::Map(std::sync::Arc::new(vec![
                            (Value::Str("vertices".into()), Value::List(vertices)),
                            (Value::Str("edges".into()), Value::List(edges)),
                            (Value::Str("length".into()), Value::Num(len)),
                        ]))
                    })
                    .collect(),
            ),
            None => Col::Gen(vec![Value::Null; batch.rows()]),
        },
        Expr::GremlinPath { ends_on_edge, bys } => match &batch.lineage {
            Some(lin) => Col::Gen(
                (0..batch.rows())
                    .map(|i| {
                        let nodes = lin.path_at(i);
                        let edges = lin.edges_at(i);
                        // Interleave v0,e0,v1,e1,… ; each entry is (id, is_edge).
                        let mut elems: Vec<(u32, bool)> = Vec::new();
                        for j in 0..edges.len() {
                            if let (Some(Value::Num(nv)), Some(Value::Num(ev))) =
                                (nodes.get(j), edges.get(j))
                            {
                                elems.push((*nv as u32, false));
                                elems.push((*ev as u32, true));
                            }
                        }
                        // The final vertex, unless the path stops on the edge (`outE`
                        // with no following `inV` — the recorded target is premature).
                        if !ends_on_edge {
                            if let Some(Value::Num(nv)) = nodes.get(edges.len()) {
                                elems.push((*nv as u32, false));
                            }
                        }
                        let out: Vec<Value> = elems
                            .iter()
                            .enumerate()
                            .map(|(p, &(id, is_edge))| {
                                let by = if bys.is_empty() {
                                    &crate::ir::GPathBy::Element
                                } else {
                                    &bys[p % bys.len()]
                                };
                                render_gpath_elem(store, id, is_edge, by)
                            })
                            .collect();
                        Value::List(out)
                    })
                    .collect(),
            ),
            None => Col::Gen(vec![Value::Null; batch.rows()]),
        },
        Expr::GremlinFullPath { bys } => match &batch.lineage {
            Some(lin) => Col::Gen(
                (0..batch.rows())
                    .map(|i| {
                        let (svals, stags) = lin.steps_at(i);
                        let out: Vec<Value> = svals
                            .iter()
                            .zip(stags)
                            .enumerate()
                            .map(|(p, (v, &tag))| {
                                let by = if bys.is_empty() {
                                    &crate::ir::GPathBy::Element
                                } else {
                                    &bys[p % bys.len()]
                                };
                                match tag {
                                    crate::batch::STEP_NODE => {
                                        render_gpath_elem(store, num_as_u32(v), false, by)
                                    }
                                    crate::batch::STEP_EDGE => {
                                        render_gpath_elem(store, num_as_u32(v), true, by)
                                    }
                                    // A projected scalar is its own path element (no `by`).
                                    _ => v.clone(),
                                }
                            })
                            .collect();
                        Value::List(out)
                    })
                    .collect(),
            ),
            None => Col::Gen(vec![Value::Null; batch.rows()]),
        },
        Expr::PathAccess { part } => {
            use crate::ir::PathPart;
            match &batch.lineage {
                Some(lin) => Col::Gen(
                    (0..batch.rows())
                        .map(|i| {
                            let nodes = lin.path_at(i);
                            let edges = lin.edges_at(i);
                            match part {
                                // `nodes(p)` / `edges(p)` materialize the full element
                                // maps (a vertex/edge object each), not bare ids.
                                PathPart::Nodes => Value::List(path_node_values(store, nodes)),
                                PathPart::Relationships => {
                                    Value::List(path_edge_values(store, edges))
                                }
                                // Hops == number of relationships. Read through the
                                // accessor, not `edges.len()`: when the plan reads only
                                // sizes the elements are never materialized, and the
                                // accessor is the one place that knows which of the two
                                // representations a lineage is in.
                                PathPart::Length => Value::Num(lin.edge_count_at(i) as f64),
                                // ISO cardinality of a path: every element (nodes + edges).
                                PathPart::Cardinality => {
                                    Value::Num((lin.node_count_at(i) + lin.edge_count_at(i)) as f64)
                                }
                                PathPart::Elements => {
                                    // n0, e0, n1, e1, …, nk — each a full element map.
                                    let ns = path_node_values(store, nodes);
                                    let es = path_edge_values(store, edges);
                                    let mut items = Vec::with_capacity(ns.len() + es.len());
                                    for (j, node) in ns.iter().enumerate() {
                                        items.push(node.clone());
                                        if let Some(e) = es.get(j) {
                                            items.push(e.clone());
                                        }
                                    }
                                    Value::List(items)
                                }
                            }
                        })
                        .collect(),
                ),
                None => Col::Gen(vec![Value::Null; batch.rows()]),
            }
        }
        // The BOOLEAN connectives route through `eval_mask`, which carries typed comparison
        // paths this one does not, and now also narrows an operand to the rows the other left
        // undecided. Measured per row over 200,000 rows, the same expression through each:
        //
        //   Compare Num/lit      eval 7.93ns   eval_mask 0.90ns    8.8x
        //   Compare Str/lit          15.68          3.17           4.9x
        //   And(Cmp,Cmp)             21.88          1.78          12.3x
        //
        // Two evaluators were answering "does this row pass" and only one had been taught.
        // `truth_to_col` produces the same representation `zip_bool` did — `Col::Bool` when every
        // row is decided, `Col::Gen` with NULLs otherwise.
        //
        // These arms may delegate the WHOLE expression because `eval_mask` handles each of them
        // itself and never falls back for them. `Compare` may NOT: `eval_mask`'s fallback is
        // `eval`, so delegating a comparison would recurse forever. It tries the same typed masks
        // inline instead and keeps the boxed path as its own fallback.
        Expr::Not(_) | Expr::And(..) | Expr::Or(..) | Expr::Xor(..) => {
            crate::exec::truth_to_col(crate::exec::eval_mask(expr, store, batch)?)
        }
        Expr::Compare { op, left, right } => {
            if let Some(m) = crate::exec::typed_num_mask(*op, left, right, store, batch) {
                crate::exec::truth_to_col(m)
            } else if let Some(m) = crate::exec::typed_str_mask(*op, left, right, store, batch) {
                crate::exec::truth_to_col(m)
            } else {
                let l = eval(left, store, batch)?;
                let r = eval(right, store, batch)?;
                compare(*op, &l, &r)
            }
        }
        Expr::In { needle, haystack } => {
            // Runtime three-valued membership (a literal list desugars to an
            // OR-chain instead; this matches its semantics). Per row: TRUE if any
            // element equals the needle; else UNKNOWN (NULL) if the needle or any
            // element is null (the answer can't be decided); else FALSE. A
            // non-list haystack is NULL.
            let nd = eval(needle, store, batch)?;
            let n = batch.rows();
            // A haystack that is the SAME list for every row gets a hashed membership
            // set built ONCE, instead of a linear scan of it per row.
            //
            // The set path must be taken BEFORE the haystack is evaluated, and that is most of
            // the win. `eval` on a `Lit` list BROADCASTS it across the batch — a 20,000-row
            // batch gets 20,000 clones of the 100-element list, 2,000,000 `Value` clones — so
            // evaluating it and then ignoring it left the cost exactly where it was. The first
            // version of this fix did that and measured no change at all.
            //
            // `IN $names` reaches here as a `Lit` list — the parser substitutes params before
            // `opt`/`exec`, and only a LITERAL list desugars to an OR-chain, so this arm is
            // exactly the bound-array spelling. It was O(rows x list): a 100-name list over
            // 20,000 users is 2,000,000 `equals` calls, measured at 38.1ms and identical with
            // and without an index (audit item 185).
            if let Some(set) = in_set(haystack, items_min()) {
                let mut key = Vec::new();
                let out: Vec<Value> = (0..n)
                    .map(|i| set.contains(&nd.value_at(i), &mut key))
                    .collect();
                return Ok(Col::Gen(out));
            }
            // FUSED `<needle> IN <node>.<key>`: scan the STORED list, so `eval(haystack)` never
            // materializes a `Col::Gen` of cloned lists at all. Item 648's technique applied to
            // the one other site whose base is a bare property.
            //
            // 🛑 WHETHER THIS WINS WAS NOT OBVIOUS, which is why it is measured rather than
            // assumed. Item 645 (below) refuted BORROWING the evaluated column here — 2.5x
            // SLOWER at length 8 — and attributed it to the clone COMPACTING: a freshly copied
            // local `Vec` scans faster than one allocated during `eval` among 100,000 others.
            // This path keeps that risk, since the stored list is scattered too, while removing
            // the O(rows x len) materialization entirely. Item 648 won because its read was O(1)
            // and had no scan for locality to help; here the read IS the scan, so the two
            // effects pull in opposite directions.
            if let Expr::Prop { slot, key } = haystack.as_ref() {
                if let Col::Nodes(ids) = batch.slot(*slot) {
                    let all_lists = ids.iter().all(|&id| {
                        id != u32::MAX && matches!(store.prop_ref(id, key), Some(Value::List(_)))
                    });

                    if all_lists {
                        let out: Vec<Value> = (0..n)
                            .map(|i| {
                                let needle = nd.value_at(i);
                                let Some(Value::List(items)) = store.prop_ref(ids[i], key) else {
                                    return Value::Null; // the pre-scan proved this cannot happen
                                };
                                let mut saw_unknown = needle.is_null();

                                for el in items.iter() {
                                    if el.is_null() || needle.is_null() {
                                        saw_unknown = true;
                                    } else if value::equals(&needle, el) {
                                        return Value::Bool(true);
                                    }
                                }

                                if saw_unknown {
                                    Value::Null
                                } else {
                                    Value::Bool(false)
                                }
                            })
                            .collect();

                        return Ok(Col::Gen(out));
                    }
                }
            }

            let hs = eval(haystack, store, batch)?;
            // 🛑 BORROWING THE HAYSTACK INSTEAD OF `value_at` WAS TRIED AND REFUTED (item 645),
            // and it is the SECOND site to refute it the same way (item 641 was `Expr::Index`).
            //
            // `value_at` returns an OWNED `Value`, so every row copies the WHOLE list before
            // scanning it — and the scan needs a reference, not a copy. The cost is real: with a
            // needle at index 0, where the scan exits immediately, a length-64 haystack still
            // cost 1362 ns/row against the full scan's 1495, so ~91% is paid regardless of how
            // far the scan runs. A plain property read is ~7 ns.
            //
            // Borrowing it measured, 100,000 rows, min of three on the baseline:
            //
            //        len 1    len 8     len 64
            //   now   47.8     89.4     1494.6   ns/row
            //   borrow 36.6    229.4    1390.2
            //         1.33x   2.5x SLOWER 1.08x
            //
            // Hoisting the `Col::Gen` match out of the loop (so no per-row `Option`) changed
            // nothing — 229.4 either way — so the per-row branch is not the cause.
            //
            // WHY, and it is the useful part: the BORROWED version is LINEAR in length
            // (36.6 / 229.4 / 1390.2 is ~6x per 8x) which is what the scan should be, while the
            // BASELINE is sublinear then explosive (47.8 / 89.4 / 1494.6). The clone is not pure
            // waste — it COMPACTS the list into fresh contiguous memory, and each stored
            // `Value::List`'s `Vec` was allocated at insert time among other allocations. At mid
            // lengths that locality is worth more than the copy; only at 64 does the copy win,
            // and then by 1.08x.
            //
            // So this is not a tuning miss at one call site: the `value_at`-clones-a-list pattern
            // item 640 named at four sites is NOT uniformly a defect. `unwind_rows` (640) gained
            // 1.34x from a MOVE — which keeps the contiguous buffer — where both BORROWS lost.
            // Any future attempt here should move or compact, not borrow.
            let out: Vec<Value> = (0..n)
                .map(|i| {
                    let needle = nd.value_at(i);
                    let Value::List(items) = hs.value_at(i) else {
                        return Value::Null;
                    };
                    let mut saw_unknown = needle.is_null();
                    for el in items.iter() {
                        if el.is_null() || needle.is_null() {
                            saw_unknown = true;
                        } else if value::equals(&needle, el) {
                            return Value::Bool(true);
                        }
                    }
                    if saw_unknown {
                        Value::Null
                    } else {
                        Value::Bool(false)
                    }
                })
                .collect();
            Col::Gen(out)
        }
        Expr::Arith { op, left, right } => {
            // f64 math via the value contract's `as_num` (finite Num only); any
            // NULL / non-numeric / non-finite operand OR result yields NULL. When
            // either operand is a temporal, `temporal_arith` takes over (and may
            // THROW on a result out of the representable range).
            use crate::ir::ArithOp::{Add, Div, Mul, Rem, Sub};
            // Scalar-literal fast path: `col OP num` / `num OP col`. Evaluate ONLY the
            // non-literal operand and fold the constant into the loop — never
            // materializing an n-length broadcast column for the literal. A chain like
            // `age * 2 + 1` then costs one gather + two scalar passes instead of two
            // 8 MB constant columns plus a boxed intermediate; at 1M that alloc traffic
            // was the whole gap (proj/arith 0.55x). Semantics match the general arm
            // below: div/rem by a zero DIVISOR throws (the divisor is the RIGHT
            // operand), every other f64 result is kept.
            let lit_num = |e: &Expr| match e {
                Expr::Lit(Value::Num(t)) if t.is_finite() => Some(*t),
                _ => None,
            };
            let scalar = match (lit_num(left), lit_num(right)) {
                (_, Some(t)) => Some((t, false)), // col OP num (num is the divisor)
                (Some(t), None) => Some((t, true)), // num OP col (col is the divisor)
                _ => None,
            };
            if let Some((t, num_on_left)) = scalar {
                let other = if num_on_left { right } else { left };
                let col = eval(other, store, batch)?;
                if let Col::Num(xs) = col {
                    let mut out = Vec::with_capacity(xs.len());
                    if matches!(op, Div | Rem) && num_on_left {
                        // num OP col → the COLUMN is the divisor; a zero cell throws.
                        for &x in &xs {
                            if x == 0.0 {
                                return Err("division by zero".into());
                            }
                            out.push(if matches!(op, Div) { t / x } else { t % x });
                        }
                    } else if matches!(op, Div | Rem) {
                        // col OP num → the LITERAL is the divisor; throw once if zero.
                        if t == 0.0 {
                            return Err("division by zero".into());
                        }
                        for &x in &xs {
                            out.push(if matches!(op, Div) { x / t } else { x % t });
                        }
                    } else {
                        for &x in &xs {
                            let (a, b) = if num_on_left { (t, x) } else { (x, t) };
                            out.push(match op {
                                Add => a + b,
                                Sub => a - b,
                                Mul => a * b,
                                _ => unreachable!(),
                            });
                        }
                    }
                    return Ok(Col::Num(out));
                }
                // The non-literal side is not a raw Num column (a null / boxed / temporal
                // operand): reuse the evaluated `col` and a broadcast literal through the
                // general loop rather than re-evaluating.
                let lit_col = broadcast(Value::Num(t), col.len());
                let (l, r) = if num_on_left {
                    (lit_col, col)
                } else {
                    (col, lit_col)
                };
                return arith_general(*op, &l, &r);
            }
            let l = eval(left, store, batch)?;
            let r = eval(right, store, batch)?;
            return arith_general(*op, &l, &r);
        }
        Expr::Call { name, args } => {
            // A call that is a pure function of one dict column (`upper(city)`, …) is
            // computed per distinct value, not per row. (Element functions take a Slot
            // arg, not a Prop, so `sole_prop_ref` rejects them — no conflict below.)
            if let Some(col) = try_eval_dict_scalar(expr, store, batch) {
                return Ok(col);
            }
            // `element_id(node|edge)` → the element's PRESERVED external id string.
            //
            // ⚠️ PRICED (item 619), NOT FIXED: this materializes the id PER ROW — a `GStr`
            // clone and a boxed `Value::Str` each — where reading a typed property column
            // does neither. Over the same 100,000-edge walk, `WHERE element_id(r) = $x`
            // costs **2,274 µs against 196 µs** for `WHERE r.w = $w` (TS: 28,888 against
            // 2,449), so the id materialization is ~12x the comparison it feeds, in BOTH
            // engines. A comparison against a literal does not need the string at all: see
            // `opt::id_seek_target`'s header for the shape that avoids it without making the
            // optimized plan store-dependent.
            if name == "element_id" {
                let arg = eval(&args[0], store, batch)?;
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| match arg.value_at(i) {
                        Value::Num(id) if matches!(arg, Col::Nodes(_)) => {
                            store.node_ext_id(id as u32).map_or(Value::Null, Value::Str)
                        }
                        Value::Num(eid) if matches!(arg, Col::Edges(_)) => store
                            .edge_ext_id(eid as u32)
                            .map_or(Value::Null, Value::Str),
                        // A branch/mixed frontier carries elements UNBOXED in a Gen column.
                        Value::Node(id) => store.node_ext_id(id).map_or(Value::Null, Value::Str),
                        Value::Edge(e) => store.edge_ext_id(e).map_or(Value::Null, Value::Str),
                        _ => Value::Null,
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // `type(edge)` needs the store + the edge identity (an eid), so it is
            // handled here (off the evaluated arg column), not in `call_scalar`.
            if name == "type" {
                let arg = eval(&args[0], store, batch)?;
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| match arg.value_at(i) {
                        Value::Num(eid) if matches!(arg, Col::Edges(_)) => store
                            .edge_type_name(eid as u32)
                            .map_or(Value::Null, |t| Value::Str(t.into())),
                        Value::Edge(e) => store
                            .edge_type_name(e)
                            .map_or(Value::Null, |t| Value::Str(t.into())),
                        _ => Value::Null,
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // `element_label(node|edge)` → a SINGLE label string (Gremlin `label()`):
            // a vertex's label, an edge's type. Not user-callable from GQL (which has
            // list-valued `labels()` and `type()`); emitted only by the Gremlin
            // front-end. A vertex with several labels yields the first in the store's
            // canonical (sorted) order, consistent with GQL `labels()`; a vertex with
            // no label yields Null.
            if name == "element_label" {
                let arg = eval(&args[0], store, batch)?;
                let n = batch.rows();
                // Large node frontier (`V().label()`): resolve labels through the
                // store's one-pass forward map (O(total membership) + O(1)/row) rather
                // than probing every label bucket per node (O(labels·log n)/row, cache-
                // hostile). Small frontiers keep the per-node path — inverting the whole
                // store would cost more than a handful of probes.
                if let Col::Nodes(ids) = &arg {
                    if n >= store.node_count() / 4 {
                        let map = store.min_label_map();
                        let (names, code_of) = &*map;
                        // Gather codes in one pass; if EVERY node is labelled, emit a
                        // typed `Col::Str` — no per-row `Value::Str` box, and the JSON
                        // writer takes its string fast path. A single unlabelled node
                        // (needs a NULL, which `Col::Str` cannot hold) falls to `Col::Gen`.
                        let mut labels: Vec<GStr> = Vec::with_capacity(ids.len());
                        let mut all_labelled = true;
                        for &id in ids {
                            match code_of.get(id as usize) {
                                Some(&c) if c != u32::MAX => {
                                    labels.push(names[c as usize].clone().into())
                                }
                                _ => {
                                    all_labelled = false;
                                    break;
                                }
                            }
                        }
                        if all_labelled {
                            return Ok(Col::Str(labels));
                        }
                        let out: Vec<Value> = ids
                            .iter()
                            .map(|&id| match code_of.get(id as usize) {
                                Some(&c) if c != u32::MAX => {
                                    Value::Str(names[c as usize].clone().into())
                                }
                                _ => Value::Null,
                            })
                            .collect();
                        return Ok(Col::Gen(out));
                    }
                }
                // Intern each distinct label ONCE for the whole column, so a big
                // `V().label()` frontier allocates one Arc per label, not per row.
                let mut cache: Vec<(&str, std::sync::Arc<str>)> = Vec::new();
                let mut out: Vec<Value> = Vec::with_capacity(n);
                for i in 0..n {
                    out.push(match arg.value_at(i) {
                        Value::Num(id) if matches!(arg, Col::Nodes(_)) => {
                            match store.min_label_name(id as u32) {
                                Some(nm) => {
                                    let arc = match cache.iter().find(|(c, _)| *c == nm) {
                                        Some((_, a)) => a.clone(),
                                        None => {
                                            let a: std::sync::Arc<str> = std::sync::Arc::from(nm);
                                            cache.push((nm, a.clone()));
                                            a
                                        }
                                    };
                                    Value::Str(arc.into())
                                }
                                None => Value::Null,
                            }
                        }
                        Value::Num(eid) if matches!(arg, Col::Edges(_)) => store
                            .edge_type_name(eid as u32)
                            .map_or(Value::Null, |t| Value::Str(t.into())),
                        // A branch/mixed frontier carries elements UNBOXED in a Gen column.
                        Value::Node(id) => store
                            .min_label_name(id)
                            .map_or(Value::Null, |nm| Value::Str(nm.into())),
                        Value::Edge(e) => store
                            .edge_type_name(e)
                            .map_or(Value::Null, |t| Value::Str(t.into())),
                        _ => Value::Null,
                    });
                }
                return Ok(Col::Gen(out));
            }
            // `element_map(element[, 'k1', …])` → Gremlin `elementMap()`: the TS engine's FLAT
            // shape — `{id, label, <props…>}` for a node, plus `IN`/`OUT` endpoint
            // stubs for an edge — where `label` is SINGULAR (the first label / edge
            // type) and the present properties are flattened alongside the tokens
            // (so a property named `id`/`label` would shadow one; that's the lossy
            // flat form, distinct from the nested `{id, labels, properties}` render).
            // An optional trailing key list filters the properties. Gremlin-only.
            if name == "element_map" {
                let filter: Vec<String> = args[1..]
                    .iter()
                    .filter_map(|e| match e {
                        Expr::Lit(Value::Str(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect();
                // The first (sorted) label of a node, or an edge's type.
                let node_label = |id: u32| -> Value {
                    let mut ls = store.labels_of(id);
                    ls.sort();
                    ls.into_iter()
                        .next()
                        .map_or(Value::Null, |l| Value::Str(l.into()))
                };
                let node_id = |id: u32| store.node_ext_id(id).map_or(Value::Null, Value::Str);
                let arg = eval(&args[0], store, batch)?;
                let n = batch.rows();
                // Resolve the node columns ONCE (sorted, present-filtered per node below)
                // instead of re-cloning+sorting the key list and HashMap-probing per node.
                let node_cols = resolve_node_cols(store, &filter);
                // Key `Value`s hoisted out of the row loop (item 391): rebuilding one per cell
                // ran `GStr::new`, a byte copy that HEAP-ALLOCATES above `INLINE_CAP` = 12,
                // where a `GStr` clone is one relaxed `fetch_add`. The render twin measured
                // 597.1 -> 453.4 ns/row at a 20-character key.
                let key_vals: Vec<Value> = node_cols
                    .iter()
                    .map(|(k, _)| Value::Str(Arc::clone(k).into()))
                    .collect();
                let out: Vec<Value> = (0..n)
                    .map(|i| {
                        let mut entries: Vec<(Value, Value)> = Vec::new();
                        match arg.value_at(i) {
                            Value::Num(id) if matches!(arg, Col::Nodes(_)) => {
                                let id = id as u32;
                                let ni = id as usize;
                                entries.push((Value::Str("id".into()), node_id(id)));
                                entries.push((Value::Str("label".into()), node_label(id)));
                                for (j, (_, col)) in node_cols.iter().enumerate() {
                                    if col.present_at(ni) {
                                        entries.push((key_vals[j].clone(), col.read(ni)));
                                    }
                                }
                            }
                            Value::Num(eid) if matches!(arg, Col::Edges(_)) => {
                                let eid = eid as u32;
                                entries.push((
                                    Value::Str("id".into()),
                                    store.edge_ext_id(eid).map_or(Value::Null, Value::Str),
                                ));
                                entries.push((
                                    Value::Str("label".into()),
                                    store
                                        .edge_type_name(eid)
                                        .map_or(Value::Null, |t| Value::Str(t.into())),
                                ));
                                if let Some((src, dst)) = store.edge_endpoints(eid) {
                                    let stub = |v: u32| {
                                        Value::Map(Arc::new(vec![
                                            (Value::Str("id".into()), node_id(v)),
                                            (Value::Str("label".into()), node_label(v)),
                                        ]))
                                    };
                                    // Core: IN is the destination, OUT the source.
                                    entries.push((Value::Str("IN".into()), stub(dst)));
                                    entries.push((Value::Str("OUT".into()), stub(src)));
                                }
                                let keys = if filter.is_empty() {
                                    store.edge_prop_keys()
                                } else {
                                    filter.clone()
                                };
                                let mut props: Vec<(String, Value)> = keys
                                    .into_iter()
                                    .filter(|k| store.has_edge_prop(eid, k))
                                    .map(|k| {
                                        let v = store.edge_prop(eid, &k);
                                        (k, v)
                                    })
                                    .collect();
                                props.sort_by(|a, b| a.0.cmp(&b.0));
                                for (k, v) in props {
                                    entries.push((Value::Str(k.into()), v));
                                }
                            }
                            _ => return Value::Null,
                        }
                        Value::Map(Arc::new(entries))
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // `value_map(element[, 'k1', …])` → Gremlin `valueMap()`: a Value::Map of
            // the element's PRESENT properties (no id/label tokens), with SCALAR
            // values (the TS engine's `propertyMap()`, not built here, is the list-wrapped
            // form). An optional trailing key list filters; no keys = every present
            // property. Keys are sorted (the engine's element-map convention; map key
            // order is set-based per policy). Gremlin-only — not in the GQL whitelist.
            if name == "value_map" || name == "property_map" {
                // `property_map` is `value_map` with each value wrapped in a single-
                // element LIST (a TinkerPop property is multi-valued; lenke is single).
                let wrap = name == "property_map";
                // A leading Bool arg (valueMap(true)) → also prepend id + label tokens,
                // never list-wrapped. Byte-identical to the json_out fast path's tokens.
                let tokens = args[1..]
                    .iter()
                    .any(|e| matches!(e, Expr::Lit(Value::Bool(true))));
                // The filter keys are constant string literals after the element arg.
                let filter: Vec<String> = args[1..]
                    .iter()
                    .filter_map(|e| match e {
                        Expr::Lit(Value::Str(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect();
                let arg = eval(&args[0], store, batch)?;
                let n = batch.rows();
                // Node columns resolved ONCE (sorted); the node arm reads straight from
                // them, skipping the per-node key clone+sort and per-key HashMap probes.
                let node_cols = resolve_node_cols(store, &filter);
                // Key `Value`s hoisted out of the row loop (item 391): rebuilding one per cell
                // ran `GStr::new`, a byte copy that HEAP-ALLOCATES above `INLINE_CAP` = 12,
                // where a `GStr` clone is one relaxed `fetch_add`. The render twin measured
                // 597.1 -> 453.4 ns/row at a 20-character key.
                let key_vals: Vec<Value> = node_cols
                    .iter()
                    .map(|(k, _)| Value::Str(Arc::clone(k).into()))
                    .collect();
                let out: Vec<Value> = (0..n)
                    .map(|i| match arg.value_at(i) {
                        Value::Num(id) if matches!(arg, Col::Nodes(_)) => {
                            let ni = id as usize;
                            let nid = id as u32;
                            let mut entries: Vec<(Value, Value)> = Vec::new();
                            if tokens {
                                entries.push((
                                    Value::Str(GStr::from("id")),
                                    store.node_ext_id(nid).map_or(Value::Null, Value::Str),
                                ));
                                entries.push((
                                    Value::Str(GStr::from("label")),
                                    store.labels_of(nid).first().map_or(Value::Null, |l| {
                                        Value::Str(GStr::from(l.as_str()))
                                    }),
                                ));
                            }
                            // node_cols are already sorted; the token pairs stay ahead.
                            entries.extend(
                                node_cols
                                    .iter()
                                    .enumerate()
                                    .filter(|(_, (_, col))| col.present_at(ni))
                                    .map(|(j, (_, col))| {
                                        let v = col.read(ni);
                                        let v = if wrap { Value::List(vec![v]) } else { v };
                                        (key_vals[j].clone(), v)
                                    }),
                            );
                            Value::Map(Arc::new(entries))
                        }
                        Value::Num(eid) if matches!(arg, Col::Edges(_)) => {
                            let eid = eid as u32;
                            let keys = if filter.is_empty() {
                                store.edge_prop_keys()
                            } else {
                                filter.clone()
                            };
                            let mut pairs: Vec<(String, Value)> = keys
                                .into_iter()
                                .filter(|k| store.has_edge_prop(eid, k))
                                .map(|k| {
                                    let v = store.edge_prop(eid, &k);
                                    (k, v)
                                })
                                .collect();
                            pairs.sort_by(|a, b| a.0.cmp(&b.0));
                            let mut entries: Vec<(Value, Value)> = Vec::new();
                            if tokens {
                                entries.push((
                                    Value::Str(GStr::from("id")),
                                    store.edge_ext_id(eid).map_or(Value::Null, Value::Str),
                                ));
                                entries.push((
                                    Value::Str(GStr::from("label")),
                                    store.edge_type_name(eid).map_or(Value::Null, |t| {
                                        Value::Str(GStr::from(t.as_str()))
                                    }),
                                ));
                            }
                            entries.extend(pairs.into_iter().map(|(k, v)| {
                                let v = if wrap { Value::List(vec![v]) } else { v };
                                (Value::Str(k.into()), v)
                            }));
                            Value::Map(Arc::new(entries))
                        }
                        _ => Value::Null,
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // `path_nodes(path)` → Gremlin `path()` over a vertex-hop chain: render
            // each node id in the lineage path as its element map, so the path is a
            // list of vertex elements (not bare ids). The argument is `Expr::Path`
            // (a per-row list of node-id Nums); a Null row (no lineage) stays Null.
            // Gremlin-only — not in the GQL whitelist.
            if name == "path_nodes" {
                // The Gremlin vertex path: each hop's node as its full element map.
                // Read the node-id lineage DIRECTLY — `args[0]` is `Expr::Path` (kept so
                // `needs_lineage` fires), but its GQL value is now a rich Path object.
                let n = batch.rows();
                let out: Vec<Value> = match &batch.lineage {
                    Some(lin) => (0..n)
                        .map(|i| Value::List(path_node_values(store, lin.path_at(i))))
                        .collect(),
                    None => vec![Value::Null; n],
                };
                return Ok(Col::Gen(out));
            }
            // `path_values(path, 'k')` → Gremlin `path().by('k')`: render each path
            // element as its `k` property instead of the whole vertex element map.
            if name == "path_values" {
                let key = match &args[1] {
                    Expr::Lit(Value::Str(s)) => s.clone(),
                    _ => return Err("path().by(...) key must be a literal string".into()),
                };
                let n = batch.rows();
                // Sentinel keys from `path().by(id|label)`: the element's ext-id / label.
                let map_elem = |id: u32| -> Value {
                    match key.as_ref() {
                        "\u{0}id" => store.node_ext_id(id).map_or(Value::Null, Value::Str),
                        "\u{0}label" => store
                            .labels_of(id)
                            .into_iter()
                            .next()
                            .map_or(Value::Null, |l| Value::Str(l.into())),
                        _ => store.prop(id, &key),
                    }
                };
                // Read the node-id lineage directly (see `path_nodes`).
                let out: Vec<Value> = match &batch.lineage {
                    Some(lin) => (0..n)
                        .map(|i| {
                            Value::List(
                                lin.path_at(i)
                                    .iter()
                                    .map(|v| match v {
                                        Value::Num(id) => map_elem(*id as u32),
                                        other => other.clone(),
                                    })
                                    .collect(),
                            )
                        })
                        .collect(),
                    None => vec![Value::Null; n],
                };
                return Ok(Col::Gen(out));
            }
            // `path_has_dup(path)` → Gremlin `cyclicPath`/`simplePath` support: TRUE if
            // the lineage node path repeats any vertex, FALSE if all distinct. The
            // argument is `Expr::Path` (a per-row list of node-id Nums); a Null row
            // (no lineage) is Null. Gremlin-only — not in the GQL whitelist.
            if name == "path_has_dup" {
                // Read the node-id lineage directly (see `path_nodes`): TRUE if a vertex
                // repeats, FALSE if all distinct, NULL when no lineage is tracked.
                let n = batch.rows();
                let out: Vec<Value> = match &batch.lineage {
                    Some(lin) => (0..n)
                        .map(|i| {
                            let mut seen: std::collections::HashSet<u64> =
                                std::collections::HashSet::new();
                            let dup = lin.path_at(i).iter().any(|v| match v {
                                Value::Num(id) => !seen.insert(id.to_bits()),
                                _ => false,
                            });
                            Value::Bool(dup)
                        })
                        .collect(),
                    None => vec![Value::Null; n],
                };
                return Ok(Col::Gen(out));
            }
            // `list_{sum,mean,min,max}(list)` → Gremlin's scope-LOCAL aggregates over
            // a list cell (e.g. after `fold()`): reduce the list's NUMERIC elements
            // (nulls/non-numerics skipped), yielding Null for a list with no number —
            // matching the TS engine's `local_num`/`local_extreme` on the numeric case.
            // Gremlin-only. (Mixed numeric+non-numeric lists are the held cross-type
            // territory; here the non-numerics are simply skipped.)
            // `list_count(list)` → Gremlin `count(local)`: the number of local
            // elements (a list's length, or 1 for a scalar cell — the TS engine's
            // `local_elems(v).len()`). Gremlin-only.
            if name == "list_count" {
                let arg = eval(&args[0], store, batch)?;
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| match arg.value_at(i) {
                        Value::List(items) => Value::Num(items.len() as f64),
                        _ => Value::Num(1.0),
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // `list_tail(list, k)` → Gremlin `tail(local, k)`: the LAST k elements of
            // each list cell (a scalar cell is a 1-element list → itself when k>=1,
            // else empty). Gremlin-only.
            if name == "list_tail" {
                let arg = eval(&args[0], store, batch)?;
                let k = match &args[1] {
                    Expr::Lit(Value::Num(n)) => *n as usize,
                    _ => return Err("tail(local, k): k must be a literal integer".into()),
                };
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| match arg.value_at(i) {
                        Value::List(items) => {
                            let start = items.len().saturating_sub(k);
                            Value::List(items[start..].to_vec())
                        }
                        other => {
                            if k >= 1 {
                                other
                            } else {
                                Value::List(vec![])
                            }
                        }
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // `list_range(list, lo, hi)` → Gremlin `range(local, lo, hi)`: the
            // half-open slice `[lo, hi)` of each list cell (a scalar cell is a
            // 1-element list). Gremlin-only.
            if name == "list_range" {
                let arg = eval(&args[0], store, batch)?;
                let bound = |e: &Expr| match e {
                    Expr::Lit(Value::Num(n)) => Ok(*n as usize),
                    _ => Err("range(local, …): bounds must be literal integers".to_string()),
                };
                let lo = bound(&args[1])?;
                let hi = bound(&args[2])?;
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| {
                        let items = match arg.value_at(i) {
                            Value::List(items) => items,
                            other => vec![other],
                        };
                        let a = lo.min(items.len());
                        let b = hi.min(items.len()).max(a);
                        Value::List(items[a..b].to_vec())
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // `list_none(value, op, cmp)` → Gremlin `none(pred)`: true iff NO element of
            // `value` (a list cell, or a scalar treated as a 1-element list) satisfies
            // `op(element, cmp)`. Vacuously true over an empty list.
            if name == "list_none" {
                let arg = eval(&args[0], store, batch)?;
                let op = match &args[1] {
                    Expr::Lit(Value::Str(s)) => s.to_string(),
                    _ => return Err("none(pred): internal op tag missing".into()),
                };
                let cmp = match &args[2] {
                    Expr::Lit(v) => v.clone(),
                    _ => return Err("none(pred): bound must be a literal".into()),
                };
                let matches_pred = |el: &Value| -> bool {
                    match op.as_str() {
                        "eq" => value::equals(el, &cmp),
                        "neq" => !value::equals(el, &cmp),
                        "gt" => value::cmp_partial(el, &cmp).is_some_and(std::cmp::Ordering::is_gt),
                        "gte" => {
                            value::cmp_partial(el, &cmp).is_some_and(std::cmp::Ordering::is_ge)
                        }
                        "lt" => value::cmp_partial(el, &cmp).is_some_and(std::cmp::Ordering::is_lt),
                        "lte" => {
                            value::cmp_partial(el, &cmp).is_some_and(std::cmp::Ordering::is_le)
                        }
                        _ => false,
                    }
                };
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| {
                        let none_match = match arg.value_at(i) {
                            Value::List(items) => !items.iter().any(&matches_pred),
                            other => !matches_pred(&other),
                        };
                        Value::Bool(none_match)
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // `list_skip(list, n)` → Gremlin `skip(local, n)`: each list cell WITHOUT
            // its first n elements. Gremlin-only.
            if name == "list_skip" {
                let arg = eval(&args[0], store, batch)?;
                let k = match &args[1] {
                    Expr::Lit(Value::Num(n)) => *n as usize,
                    _ => return Err("skip(local, n): n must be a literal integer".into()),
                };
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| {
                        let items = match arg.value_at(i) {
                            Value::List(items) => items,
                            other => vec![other],
                        };
                        let a = k.min(items.len());
                        Value::List(items[a..].to_vec())
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            if matches!(
                name.as_str(),
                "list_sum" | "list_mean" | "list_min" | "list_max"
            ) {
                let arg = eval(&args[0], store, batch)?;
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| {
                        let nums: Vec<f64> = match arg.value_at(i) {
                            Value::List(items) => items
                                .iter()
                                .filter_map(|v| match v {
                                    Value::Num(x) => Some(*x),
                                    _ => None,
                                })
                                .collect(),
                            // A scalar cell is a one-element local list.
                            Value::Num(x) => vec![x],
                            _ => Vec::new(),
                        };
                        if nums.is_empty() {
                            return Value::Null;
                        }
                        let v = match name.as_str() {
                            "list_sum" => nums.iter().sum(),
                            "list_mean" => nums.iter().sum::<f64>() / nums.len() as f64,
                            "list_min" => nums.iter().copied().fold(f64::INFINITY, f64::min),
                            _ => nums.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                        };
                        Value::Num(v)
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // Element functions need the STORE and the element identity (a node/edge
            // slot), which the pure-value `call_scalar` cannot see — handle them
            // here off the evaluated argument column.
            // `map_keys`/`map_values` → Gremlin `select(Column.keys|values)` on a Map:
            // the entry keys or values AS A LIST, in the Map's current (post-order)
            // order. A non-Map cell passes through.
            if matches!(name.as_str(), "map_keys" | "map_values") {
                let arg = eval(&args[0], store, batch)?;
                let want_keys = name == "map_keys";
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| match arg.value_at(i) {
                        Value::Map(pairs) => Value::List(
                            pairs
                                .iter()
                                .map(|(k, v)| if want_keys { k.clone() } else { v.clone() })
                                .collect(),
                        ),
                        other => other,
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            if matches!(name.as_str(), "keys" | "labels" | "property_names") {
                let arg = eval(&args[0], store, batch)?;
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| match arg.value_at(i) {
                        // A node surfaces as Num(id); its keys / property_names are
                        // the SORTED present property keys, its labels the SORTED
                        // labels — both as string lists (matching the TS engine).
                        Value::Num(id) if matches!(arg, Col::Nodes(_)) => {
                            let id = id as u32;
                            let mut items: Vec<Value> = if name == "labels" {
                                let mut ls = store.labels_of(id);
                                ls.sort();
                                ls.into_iter().map(|l| Value::Str(l.into())).collect()
                            } else {
                                store
                                    .prop_keys()
                                    .into_iter()
                                    .filter(|k| store.has_prop(id, k))
                                    .map(|k| Value::Str(k.into()))
                                    .collect()
                            };
                            items.sort_by(value::cmp_total);
                            Value::List(items)
                        }
                        // An edge: `labels(e)` is its label list (type first, then any
                        // secondary labels); `keys`/`property_names` its present edge
                        // property keys, sorted.
                        Value::Num(id) if matches!(arg, Col::Edges(_)) => {
                            let eid = id as u32;
                            let mut items: Vec<Value> = if name == "labels" {
                                store
                                    .edge_labels_of_refs(eid)
                                    .into_iter()
                                    .map(|l| Value::Str(l.into()))
                                    .collect()
                            } else {
                                store
                                    .edge_prop_keys()
                                    .into_iter()
                                    .filter(|k| store.has_edge_prop(eid, k))
                                    .map(|k| Value::Str(k.into()))
                                    .collect()
                            };
                            if name == "labels" {
                                // Edge labels keep TYPE-first order (not sorted).
                            } else {
                                items.sort_by(value::cmp_total);
                            }
                            Value::List(items)
                        }
                        _ => Value::Null,
                    })
                    .collect();
                return Ok(Col::Gen(out));
            }
            // Vectorized unary numeric functions that map finite→finite over a raw
            // `Num` column stay a `Num` column (no per-row boxing), so a downstream
            // aggregate/compare keeps the f64 fast path — e.g. `sum(abs(x - k))`.
            if args.len() == 1 {
                if let Some(f) = unary_finite_num_fn(name) {
                    if let Col::Num(xs) = eval(&args[0], store, batch)? {
                        return Ok(Col::Num(xs.iter().map(|&x| f(x)).collect()));
                    }
                    // A non-`Num` arg (nulls / mixed) falls through to the boxed path.
                }
            }
            // `coalesce` over COLUMNS, resolved once (item 458).
            //
            // Two wins, and they are different things — the first is not available to any
            // general fix, which is why this arm exists despite item 457's warning against
            // special-casing one function:
            //
            //   - **A first argument that CANNOT be null makes `coalesce` the identity.**
            //     `Col::Num`, `Col::Bool` and `Col::Str` have no null representation — a column
            //     with nulls is a `Col::Gen` — so if the first argument evaluates to one of
            //     those, no later argument is reachable and the result IS that column.
            //     `count(coalesce(a.k, 0))` goes 31.2 ms to 4.81 at 1,000,000 rows, **6.5x**,
            //     landing exactly on the vectorized floor (`count(abs(a.k))` is 4.73).
            //     `Nodes`/`Edges` are excluded: the `u32::MAX` OPTIONAL-miss sentinel IS a null
            //     in those, so the identity does not hold.
            //   - **Otherwise, merge the columns without the per-row dispatch.** The generic
            //     path below calls `call_scalar_checked(name, …)` per row, which matches the
            //     function NAME as a STRING against dozens of arms; resolving it once leaves a
            //     null check. `count(coalesce(a.missing, a.k))` goes 37.0 to 21.8, **1.67x** —
            //     and that 1.67x is the part a general resolver would give EVERY non-vectorized
            //     function, which item 457 priced at ~33-45 ns a row and is still open.
            //
            // EVERY argument is evaluated first, exactly as the generic path does. `coalesce`
            // is lazy in the value sense and this arm keeps that, but it must NOT become lazy in
            // the RAISE sense: the path below materializes all argument columns before the row
            // loop, so a later argument that faults raises there, and skipping it here would be
            // a divergence rather than an optimization.
            if name == "coalesce" && !args.is_empty() {
                let cols = args
                    .iter()
                    .map(|a| eval(a, store, batch))
                    .collect::<Result<Vec<_>, String>>()?;

                if matches!(cols[0], Col::Num(_) | Col::Bool(_) | Col::Str(_)) {
                    return Ok(cols.into_iter().next().unwrap_or(Col::Gen(Vec::new())));
                }

                let n = batch.rows();
                let mut out: Vec<Value> = Vec::with_capacity(n);

                for i in 0..n {
                    let mut v = Value::Null;

                    for c in &cols {
                        let cand = c.value_at(i);

                        if !cand.is_null() {
                            v = cand;
                            break;
                        }
                    }

                    out.push(v);
                }

                return Ok(Col::Gen(out));
            }
            // EVERY OTHER unary numeric function, with the NAME resolved once (item 459).
            //
            // The arm above keeps a `Col::Num` and so admits only the six functions that cannot
            // make a NaN or an infinity from a finite input. The other fifteen — `sqrt`, `ln`,
            // `exp`, the trig family, `degrees`/`radians` — fell through to the generic path
            // below, which matches the function NAME as a STRING against dozens of arms ONCE PER
            // ROW. That dispatch is ~20 ns a row: bypassing it for `sqrt` alone, with the per-row
            // boxing and the boxed output both still in place, measured 32.4 -> 12.5 ms at
            // 1,000,000 rows (**2.6x**), while `power` (still generic) and `abs` (already
            // vectorized) stayed flat.
            //
            // The output stays BOXED on purpose. These functions can produce a NaN or an
            // infinity from finite input, and a stored `Num` column is all-finite — which is the
            // invariant the arm above exists to protect. This one removes the dispatch and
            // nothing else, so it inherits no such obligation.
            //
            // `scalar_num_fn` delegates to the same `unary_num_fn`, so the two readings of every
            // function are one body. A NULL or non-numeric argument yields NULL here exactly as
            // it does there, through the same `num_of`.
            if args.len() == 1 {
                if let Some(f) = super::scalar::unary_num_fn(name) {
                    return super::scalar::eval_unary_num(f, name, eval(&args[0], store, batch)?);
                }
            }
            // `size`/`cardinality` over a BOXED column, read by REFERENCE. The generic
            // path below materializes each argument with `Col::value_at`, and
            // `Col::Gen(v) => v[i].clone()` on a `Value::List(Vec<Value>)` DEEP-COPIES the
            // whole list — allocating a fresh `Vec`, copying every element, reading `len()`,
            // then dropping it. Measured on a quantified group's per-rep lists, 599,998 rows:
            // 44.1ms, about 73ns a call, to read a length.
            //
            // The arms below must match `call_scalar_checked` EXACTLY, including that a
            // non-null non-string non-list is an ERROR and not a null: `size()` on one throws
            // `E_INVALID_VALUE: size() requires a string or list`. Returning null there would
            // be a silent behaviour change that no perf test would notice.
            if matches!(name.as_str(), "size" | "cardinality") && args.len() == 1 {
                // BORROW the column when the argument is a bare slot. `eval` on an
                // `Expr::Slot` is `batch.slot(n).clone()`, and cloning a `Col::Gen` of
                // `Value::List` is one `Vec` allocation and copy PER ROW — so evaluating the
                // argument at all cost more than the function does. (That clone is on the
                // path of every function over a boxed column, not just this one.)
                let owned;
                let arg: &Col = if let Expr::Slot(k) = &args[0] {
                    batch.slot(*k)
                } else {
                    owned = eval(&args[0], store, batch)?;
                    &owned
                };
                if let Col::Gen(vals) = arg {
                    // LISTS and nulls only. Anything else in the column — a string boxed into
                    // a `Gen`, or a value that must raise `E_INVALID_VALUE` — falls through to
                    // the generic path, which stays the single implementation of those cases.
                    // Duplicating them here bought two arms that no query shape reached:
                    // mutating the string length to count BYTES, and turning the type error
                    // into a null, both survived the whole suite. The pre-scan is a
                    // discriminant check per row with no allocation, against the ~42ns a row
                    // the clone costs.
                    if vals
                        .iter()
                        .all(|v| matches!(v, Value::List(_)) || v.is_null())
                    {
                        let out: Vec<Value> = vals
                            .iter()
                            .map(|v| match v {
                                Value::List(l) => Value::Num(l.len() as f64),
                                _ => Value::Null,
                            })
                            .collect();
                        return Ok(Col::Gen(out));
                    }
                }
                // Any other column kind falls through too: a `Col::Str` clones a cheap
                // `Arc<str>`, so the generic path costs it nothing.
            }
            // Evaluate each argument to a column, then dispatch per row. Arity is
            // validated at parse time, so `call_scalar` can index its args. The row
            // count is the BATCH's, not the min over args — a niladic function
            // (`pi()`, `e()`) has no arg columns yet still yields one value per row.
            // BORROW an argument that is a bare slot. `eval` on an `Expr::Slot` is
            // `batch.slot(n).clone()` — a whole-column copy, which for a `Col::Gen` of
            // `Value::List` or `Value::Map` is one `Vec` allocation PER ROW, paid before the
            // function does anything. Measured over a group-bound list column, 599,998 rows:
            // `head(b)` 142.1ms -> 97.8ms, `reverse(b)` 141.1ms -> 100.0ms, `last(b)`
            // 136.9ms -> 100.8ms, `tail(b)` 120.3ms -> 102.5ms.
            //
            // `Cow` rather than an all-or-nothing check so a MIXED argument list still borrows
            // the slots in it (`substring(s, n)` with one slot and one literal, say) — the
            // per-argument decision costs nothing and the all-Slots form would have skipped
            // every such call.
            //
            // Borrowing is observationally identical: the `Slot` arm of `eval` does nothing
            // but clone that column, and `batch.slot` is the same accessor either way, so a
            // missing slot still panics in the same place.
            let cols: Vec<std::borrow::Cow<'_, Col>> = args
                .iter()
                .map(|a| match a {
                    Expr::Slot(k) => Ok(std::borrow::Cow::Borrowed(batch.slot(*k))),
                    other => eval(other, store, batch).map(std::borrow::Cow::Owned),
                })
                .collect::<Result<_, String>>()?;
            let n = batch.rows();
            // Reuse ONE argument buffer across rows instead of heap-allocating a fresh
            // `Vec<Value>` per row — a general win for every multi-arg scalar function
            // (concat, substring, replace, …), which otherwise paid `n` allocations.
            let mut buf: Vec<Value> = Vec::with_capacity(cols.len());
            let mut out: Vec<Value> = Vec::with_capacity(n);
            for i in 0..n {
                buf.clear();
                buf.extend(cols.iter().map(|c| c.value_at(i)));
                out.push(call_scalar_checked(name, &buf)?);
            }
            // Stays boxed here — a plain computed projection must not pay the typed-fold
            // cost for no benefit (measured: RETURN trim()/substring() regressed). The SORT
            // path converts a homogeneous key column to typed on demand (see order_page).
            Col::Gen(out)
        }
        Expr::List { items } => {
            // Per row, build a Value::List of each element's value. A VERTEX/EDGE element
            // renders as its element map (render_cell), consistent with a top-level one.
            let cols = eval_all(items, store, batch)?;
            let n = batch.rows();
            Col::Gen(
                (0..n)
                    .map(|i| Value::List(cols.iter().map(|c| render_cell(c, i, store)).collect()))
                    .collect(),
            )
        }
        Expr::Record { fields } => {
            // Per row, evaluate each field then canonicalize into a Value::Record
            // (keys sorted, last-wins) via the value contract.
            //
            // `render_cell`, NOT `value_at` (audit item 344). `value_at` on an element column
            // yields the INTERNAL DENSE ID as a number, so `RETURN {n: p}` rendered
            // `{"n":0}` — a wrong value, an internal identifier leaking to the caller, and a
            // silent divergence from the TS engine, which returns the element map. The `List`
            // arm directly above has always used `render_cell` and says why ("consistent with
            // a top-level one"); this arm simply never got it. The two are now the same.
            let cols = eval_all(fields.iter().map(|(_, e)| e), store, batch)?;
            let n = batch.rows();
            Col::Gen(
                (0..n)
                    .map(|i| {
                        let pairs = fields
                            .iter()
                            .zip(&cols)
                            .map(|((k, _), c)| (GStr::from(k.as_str()), render_cell(c, i, store)))
                            .collect();
                        value::make_record(pairs)
                    })
                    .collect(),
            )
        }
        Expr::MapLit {
            entries,
            omit_absent,
        } => {
            // Per row, an insertion-ordered Value::Map with string keys. A VERTEX/EDGE
            // value renders as its element map (via render_cell), not a raw dense id, so
            // a project()/select() map of elements canonicalizes like a top-level one.
            let cols = eval_all(entries.iter().map(|(_, e)| e), store, batch)?;
            let n = batch.rows();
            // Gremlin project(): a bare-property entry that is ABSENT for a row is DROPPED
            // from that row's map (`project('a').by('age')` → `{}`, not `{a:null}`). A
            // present null is kept; non-property entries are always kept. `None` = keep-all.
            let present: Vec<Option<Vec<bool>>> = if *omit_absent {
                entries
                    .iter()
                    .enumerate()
                    .map(|(j, (_, e))| match e {
                        // A first-result subquery (project `by(<hop>.values('k'))`) is ABSENT
                        // when the sub-traversal produced nothing — it evaluates to NULL, and
                        // the key is OMITTED (TinkerPop `project` drops an empty by-result),
                        // not kept as `{k: null}`. Derived from the already-computed value.
                        Expr::ScalarSubquery { .. } => Some(
                            (0..n)
                                .map(|i| !matches!(cols[j].value_at(i), Value::Null))
                                .collect(),
                        ),
                        _ => prop_present_mask(e, store, batch),
                    })
                    .collect()
            } else {
                Vec::new()
            };
            Col::Gen(
                (0..n)
                    .map(|i| {
                        let pairs = entries
                            .iter()
                            .zip(&cols)
                            .enumerate()
                            .filter(|(j, _)| {
                                !*omit_absent || present[*j].as_ref().is_none_or(|m| m[i])
                            })
                            .map(|(_, ((k, _), c))| {
                                (Value::Str(GStr::from(k.as_str())), render_cell(c, i, store))
                            })
                            .collect();
                        Value::Map(Arc::new(pairs))
                    })
                    .collect(),
            )
        }
        Expr::Case {
            branches,
            otherwise,
        } => {
            let otherwise = otherwise.as_deref();
            // Eager fast path over the FULL batch, INLINE so it keeps the plain-CASE codegen
            // (fully vectorized). On ANY error a branch may hold a type error for a row that
            // never actually takes it, so fall back to the lazy (SQL-standard) masked
            // evaluation, which evaluates each condition/value only over the rows that reach
            // it — an unreached branch's type error cannot surface (`CASE WHEN true THEN 1
            // ELSE (2 + 'abc') END` is 1). The masked path runs ONLY on the error.
            let eager: Result<Col, String> = (|| {
                // Categorical remap fast path: every branch is `<dict col> = <str literal>`.
                // Select by code without evaluating a full compare column per branch.
                if let Some((slot, key, code_to_branch)) = case_dict_lookup(branches, store) {
                    if let (Some(Column::Dict { codes, present, .. }), Col::Nodes(ids)) =
                        (store.column(&key), batch.slot(slot))
                    {
                        let vals = eval_all(branches.iter().map(|(_, v)| v), store, batch)?;
                        let else_col = otherwise.map(|e| eval(e, store, batch)).transpose()?;
                        let out: Vec<Value> = ids
                            .iter()
                            .enumerate()
                            .map(|(i, &id)| {
                                let bi = (id != u32::MAX && present[id as usize])
                                    .then(|| code_to_branch[codes[id as usize] as usize])
                                    .flatten();
                                match bi {
                                    Some(b) => vals[b].value_at(i),
                                    None => {
                                        else_col.as_ref().map_or(Value::Null, |c| c.value_at(i))
                                    }
                                }
                            })
                            .collect();
                        return Ok(Col::Gen(out));
                    }
                }
                // LITERAL ARMS: select between constants (item 464). `eval_all(vals)` below
                // materializes a FULL COLUMN per branch even when the branch value is a
                // constant — N `f64`s to say "1" — and then `vals[bi].value_at(i)` boxes one
                // `Value` per row per branch on top of it. When every arm is a literal there is
                // nothing to materialize and nothing to read: the answer is one of a handful of
                // values already in hand.
                if let Some(col) = case_literal_arms(branches, otherwise, store, batch)? {
                    return Ok(col);
                }

                let conds = eval_all(branches.iter().map(|(c, _)| c), store, batch)?;
                let vals = eval_all(branches.iter().map(|(_, v)| v), store, batch)?;
                let else_col = otherwise.map(|e| eval(e, store, batch)).transpose()?;
                let n = batch.rows();
                let out: Vec<Value> = (0..n)
                    .map(|i| {
                        // First branch whose condition is TRUE (three-valued). A non-null
                        // non-boolean condition is a data exception (a WHEN must be boolean).
                        for (bi, c) in conds.iter().enumerate() {
                            match c.value_at(i) {
                                Value::Bool(true) => return Ok(vals[bi].value_at(i)),
                                Value::Bool(false) | Value::Null => {}
                                _ => return Err(TRUTH_TYPE_ERR.to_string()),
                            }
                        }
                        Ok(else_col.as_ref().map_or(Value::Null, |c| c.value_at(i)))
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(Col::Gen(out))
            })();
            match eager {
                Ok(col) => col,
                Err(_) => eval_case_masked(branches, otherwise, store, batch)?,
            }
        }
        Expr::Cast { target, expr } => {
            // Evaluate the input, then cast per row via the value contract. A
            // failed conversion aborts the whole evaluation (E_INVALID_VALUE) —
            // the read pipeline is fallible precisely so this can throw.
            let col = eval(expr, store, batch)?;
            let t = (*target).to_value();
            let mut out = Vec::with_capacity(col.len());
            for i in 0..col.len() {
                // `cell_value`, NOT `value_at` (audit item 353). `value_at` on an element column
                // yields the INTERNAL DENSE ID as a number, so `CAST(p AS STRING)` answered `"0"`
                // and `CAST(p AS INTEGER)` answered `0` — a leaked internal identifier, and a
                // silent divergence from TS. `cell_value` keeps the element UNBOXED so
                // `value::cast` can see what it is and refuse. Same shape as item 345's fix to
                // the `Record` arm, which read `value_at` where its sibling read `render_cell`.
                out.push(value::cast(&cell_value(&col, i, store), t)?);
            }
            Col::Gen(out)
        }
        Expr::IsNull { expr, negated } => {
            // FAST PATH: `<slot>.<key> IS [NOT] NULL` over a node frontier is a PRESENCE
            // question, and `Column::has_value_at` answers it straight off the `present`
            // bitset — the column's doc records why that bit IS the predicate: a stored
            // present-null is `present = false, nulls = true`, so a value read sees NULL
            // exactly as an absent slot does. The general path below instead materializes a
            // whole `Col` through `eval`, which for a partially-present column is boxed:
            // 200,000 `Value`s, 198,000 of them `Value::Null`, built only to ask
            // `is_null_at`. `count(prop)`'s fast path has used this same bitset since item
            // 267 — the mechanism was already here, on the sibling path (audit item 405).
            if let Expr::Prop { slot, key } = expr.as_ref() {
                if let Col::Nodes(ids) = batch.slot(*slot) {
                    // No column for the key at all: every row reads NULL.
                    let Some(column) = store.column(key) else {
                        return Ok(Col::Bool(vec![!*negated; ids.len()]));
                    };
                    return Ok(Col::Bool(
                        ids.iter()
                            .map(|&id| {
                                // The `u32::MAX` OPTIONAL-miss sentinel carries no property,
                                // so it reads NULL — and must be tested BEFORE indexing the
                                // column, which it would run past (the same guard
                                // `read_property`'s `gather` needs).
                                let non_null = id != u32::MAX && column.has_value_at(id as usize);

                                non_null == *negated
                            })
                            .collect(),
                    ));
                }
            }
            // A definite Bool per row (never NULL): `IS NULL` is TRUE exactly when
            // the value is Null; `IS NOT NULL` flips it.
            let col = eval(expr, store, batch)?;
            Col::Bool(
                (0..col.len())
                    .map(|i| col.is_null_at(i) != *negated)
                    .collect(),
            )
        }
        Expr::IsLabeled { slot, labels } => {
            // Membership via the label buckets: resolve each label's sorted id bucket
            // ONCE, then binary-search per row (nodes) — no per-row list build or string
            // hashing. Edges compare the type name (rarer path). A non-element is false.
            let node_buckets: Vec<&[u32]> =
                labels.iter().map(|l| store.nodes_with_label(l)).collect();
            match batch.slot(*slot) {
                Col::Nodes(ids) => {
                    // `IsLabeled` is ANY-of, so a label that every LIVE node carries makes
                    // this a tautology: no bitset, no probe, just the sentinel check that
                    // an OPTIONAL miss (`u32::MAX`) is still not labelled. Buckets hold
                    // only live ids, so the test is a length comparison. Measured
                    // projecting a hop's frontier on a 100k-node graph where every node is
                    // a `Person`: 148.7us -> 63.9us at a 1%-selective seed, 1194.0us ->
                    // 508.1us at 10% (E78).
                    let live = store.live_node_count();
                    if label_mode_allows_shortcut()
                        && live > 0
                        && node_buckets.iter().any(|b| b.len() == live)
                    {
                        return Ok(Col::Bool(ids.iter().map(|&id| id != u32::MAX).collect()));
                    }
                    // Otherwise: a membership BITSET, built once and tested O(1) a row,
                    // against a `binary_search` of the label buckets per row. Which is
                    // cheaper depends on three measured costs, not one ratio — the old rule
                    // was `rows >= total_bucket`, which priced a probe as ONE fill entry and
                    // so declined the bitset on frontiers where it wins by 2.2x:
                    //
                    //   ```text
                    //   label covering 50%, 5,000-row frontier    122.4us -> 61.6us  2.0x
                    //   label covering 50%, 45,000-row frontier  1393.7us -> 454.8us 3.1x
                    //   label covering 1%, 55-row frontier         28.9us -> 29.6us  flat
                    //   ```
                    //
                    // The 55-row row is the guard, not a win: it must keep probing. Forcing
                    // the bitset there costs ~3us, which is the `vec![false; node_count]`
                    // allocation alone — so the node count has to be in the estimate.
                    // Costs below are in TENTHS of a nanosecond, each read off the rows
                    // above at 100k nodes: a probe ~19ns a row; the allocation ~2.5us per
                    // 100k nodes; a fill ~0.34ns an id.
                    let total_bucket: usize = node_buckets.iter().map(|b| b.len()).sum();
                    let probe_cost = ids.len().saturating_mul(190);
                    let bitset_cost = store.node_count() / 4 + total_bucket.saturating_mul(3);
                    if label_mode_prefers_bitset(probe_cost, bitset_cost) {
                        let mut member = vec![false; store.node_count()];
                        for b in &node_buckets {
                            for &id in *b {
                                member[id as usize] = true;
                            }
                        }
                        Col::Bool(
                            ids.iter()
                                .map(|&id| id != u32::MAX && member[id as usize])
                                .collect(),
                        )
                    } else {
                        Col::Bool(
                            ids.iter()
                                .map(|&id| {
                                    id != u32::MAX
                                        && node_buckets.iter().any(|b| b.binary_search(&id).is_ok())
                                })
                                .collect(),
                        )
                    }
                }
                Col::Edges(eids) => {
                    // Match ANY of the wanted labels against the edge's WHOLE label set
                    // (primary OR secondary) — a multi-label edge `[KNOWS, CREATED]` is
                    // `hasLabel('CREATED')` too. `edge_type_name` alone saw only the
                    // primary type and missed the rest. Resolve the wanted type ids once.
                    let want: Vec<u32> = labels.iter().filter_map(|l| store.etype_id(l)).collect();
                    Col::Bool(
                        eids.iter()
                            .map(|&e| {
                                e != u32::MAX && want.iter().any(|&t| store.edge_carries_type(e, t))
                            })
                            .collect(),
                    )
                }
                // A heterogeneous Col::Gen (a mixed branch / inject) carries UNBOXED element
                // refs: test the label per Node/Edge cell; a scalar cell is false (has no label),
                // matching the pure-TS heterogeneous stream.
                Col::Gen(cells) => {
                    let want_e: Vec<u32> =
                        labels.iter().filter_map(|l| store.etype_id(l)).collect();
                    Col::Bool(
                        cells
                            .iter()
                            .map(|c| match c {
                                Value::Node(id) => {
                                    node_buckets.iter().any(|b| b.binary_search(id).is_ok())
                                }
                                Value::Edge(e) => {
                                    want_e.iter().any(|&t| store.edge_carries_type(*e, t))
                                }
                                _ => false,
                            })
                            .collect(),
                    )
                }
                other => Col::Bool(vec![false; other.len()]),
            }
        }
        Expr::PropertyExists { slot, key } => {
            // Presence, not value: TRUE iff the element carries a stored value for
            // `key`, FALSE if not — but on a NON-element (the OPTIONAL null sentinel
            // `u32::MAX`, or a computed value) the answer is NULL, matching the TS engine's
            // `prop_present` (`_ => Val::Null`). A column with no sentinel keeps the
            // unboxed `Col::Bool` fast path; a sentinel forces the null-carrying `Gen`.
            // A slot past the runtime width (a branch/inject collapsed the layout) has no
            // element to test — the presence is NULL, like a non-element frontier.
            if *slot >= batch.slots.len() {
                return Ok(Col::Gen(vec![Value::Null; batch.rows()]));
            }
            match batch.slot(*slot) {
                Col::Nodes(ids) if !ids.contains(&u32::MAX) => {
                    Col::Bool(ids.iter().map(|&id| store.has_prop(id, key)).collect())
                }
                Col::Nodes(ids) => Col::Gen(
                    ids.iter()
                        .map(|&id| {
                            if id == u32::MAX {
                                Value::Null
                            } else {
                                Value::Bool(store.has_prop(id, key))
                            }
                        })
                        .collect(),
                ),
                Col::Edges(eids) if !eids.contains(&u32::MAX) => {
                    Col::Bool(eids.iter().map(|&e| store.has_edge_prop(e, key)).collect())
                }
                Col::Edges(eids) => Col::Gen(
                    eids.iter()
                        .map(|&e| {
                            if e == u32::MAX {
                                Value::Null
                            } else {
                                Value::Bool(store.has_edge_prop(e, key))
                            }
                        })
                        .collect(),
                ),
                // A heterogeneous column (e.g. post-union `Gen` of boxed element maps):
                // presence reads through a boxed vertex/edge's `properties`; a genuine
                // non-element value has no property and stays NULL (the TS engine's `_ => Null`).
                other => {
                    Col::Gen(
                        (0..other.len())
                            .map(|i| match other.value_at(i) {
                                // An UNBOXED element ref reads presence off the store.
                                Value::Node(id) => Value::Bool(store.has_prop(id, key)),
                                Value::Edge(e) => Value::Bool(store.has_edge_prop(e, key)),
                                Value::Map(pairs) => match boxed_element_props(&pairs) {
                                    Some(props) => Value::Bool(props.iter().any(
                                        |(k, _)| matches!(k, Value::Str(s) if s.as_ref() == key),
                                    )),
                                    None => Value::Null,
                                },
                                _ => Value::Null,
                            })
                            .collect(),
                    )
                }
            }
        }
        Expr::Exists { body, .. } => {
            // Fast path: a bare vertex-hop existence semi-join (`where(out/in/both)`)
            // only asks "does this row have ANY matching neighbour?" — check the
            // adjacency per row and short-circuit, instead of expanding EVERY neighbour
            // of the whole frontier and back-mapping via a provenance column.
            if let Plan::Expand {
                input,
                from,
                dir,
                edge_label,
                bind_edge: false,
                double_loops: _,
            } = body.as_ref()
            {
                if matches!(**input, Plan::Row) {
                    if let Col::Nodes(ids) = batch.slot(*from) {
                        let want = match want_etypes(store, edge_label) {
                            Ok(w) => w,
                            Err(()) => return Ok(Col::Bool(vec![false; ids.len()])),
                        };
                        return Ok(Col::Bool(
                            ids.iter()
                                .map(|&v| v != u32::MAX && node_has_nbr(store, v, *dir, &want))
                                .collect(),
                        ));
                    }
                }
            }
            // Filtered semijoin: `where(out().has(k,v))` / GQL `EXISTS { (n)->(m:L) WHERE
            // … }` — a CHAIN of `Filter`s over `Expand over Row`. Check the neighbour
            // predicates per source with early-stop, instead of expanding every neighbour
            // of the frontier then filtering + back-mapping. Only SIMPLE leaves on the
            // neighbour (compares / presence / label tests).
            {
                let mut cur = body.as_ref();
                let mut filter_preds: Vec<&Expr> = Vec::new();
                while let Plan::Filter { input, pred } = cur {
                    filter_preds.push(pred);
                    cur = input.as_ref();
                }
                if let Plan::Expand {
                    input,
                    from,
                    dir,
                    edge_label,
                    bind_edge: false,
                    double_loops: _,
                } = cur
                {
                    if !filter_preds.is_empty() && matches!(**input, Plan::Row) {
                        let preds: Option<Vec<NbrPred>> = filter_preds
                            .iter()
                            .map(|p| simple_nbr_preds(p, *from))
                            .collect::<Option<Vec<_>>>()
                            .map(|v| v.into_iter().flatten().collect());
                        if let (Col::Nodes(ids), Some(preds)) = (batch.slot(*from), preds) {
                            let want = match want_etypes(store, edge_label) {
                                Ok(w) => w,
                                Err(()) => return Ok(Col::Bool(vec![false; ids.len()])),
                            };
                            // Raw-column fast path for a lone numeric neighbour compare:
                            // resolve the column ONCE, not per neighbour via `store.prop`.
                            if let [NbrPred::Cmp(k, op, Value::Num(t))] = preds.as_slice() {
                                if let Some(Column::Num { data, present, .. }) = store.column(k) {
                                    return Ok(Col::Bool(
                                        ids.iter()
                                            .map(|&v| {
                                                v != u32::MAX
                                                    && node_has_num_nbr(
                                                        store,
                                                        v,
                                                        *dir,
                                                        &want,
                                                        (data, present),
                                                        (*op, *t),
                                                    )
                                            })
                                            .collect(),
                                    ));
                                }
                            }
                            return Ok(Col::Bool(
                                ids.iter()
                                    .map(|&v| {
                                        v != u32::MAX
                                            && node_has_matching_nbr(store, v, *dir, &want, &preds)
                                    })
                                    .collect(),
                            ));
                        }
                    }
                }
            }
            // Correlated existence: run the sub-pattern over ALL outer rows at once,
            // tagging each with a unique provenance id so surviving sub-rows point
            // back to the outer row they came from. An outer row is TRUE iff at
            // least one sub-row carries its id.
            let n = batch.rows();
            let prov = batch.slots.len(); // provenance rides at the first free slot
            let mut slots = batch.slots.clone();
            slots.push(Col::Num((0..n).map(|i| i as f64).collect()));
            // The body reads no path (EXISTS discards lineage), so seed without one.
            let seed = Batch::of(slots);
            let survivors = pull_body(body, store, &seed)?;
            let mut hit = vec![false; n];
            if let Some(Col::Num(ids)) = survivors.slots.get(prov) {
                for &id in ids {
                    let i = id as usize;
                    if i < n {
                        hit[i] = true;
                    }
                }
            }
            Col::Bool(hit)
        }
        Expr::CountSubquery { body, outer_width } => {
            // An unfiltered hop chain is a DEGREE, not a set of rows to tally.
            if let Some(counts) = degree_count_subquery(body, *outer_width, store, batch) {
                return Ok(Col::Num(counts));
            }
            // Correlated count: same provenance-tagged sub-run as EXISTS, but TALLY
            // the sub-rows per outer row instead of a boolean any().
            let n = batch.rows();
            let prov = batch.slots.len();
            let mut slots = batch.slots.clone();
            slots.push(Col::Num((0..n).map(|i| i as f64).collect()));
            let seed = Batch::of(slots);
            let survivors = pull_body(body, store, &seed)?;
            let mut counts = vec![0f64; n];
            if let Some(Col::Num(ids)) = survivors.slots.get(prov) {
                for &id in ids {
                    let i = id as usize;
                    if i < n {
                        counts[i] += 1.0;
                    }
                }
            }
            Col::Num(counts)
        }
        Expr::CollectSubquery { body, scalar, .. } => {
            // Correlated collect (Gremlin local(<hop>.fold())): the same provenance-
            // tagged sub-run, gathering `scalar` per outer row into a list (empty when
            // nothing matched). Vertices/edges render as element maps (render_cell).
            let n = batch.rows();
            let prov = batch.slots.len();
            let mut slots = batch.slots.clone();
            slots.push(Col::Num((0..n).map(|i| i as f64).collect()));
            let seed = Batch::of(slots);
            let survivors = pull_body(body, store, &seed)?;
            let vals = eval(scalar, store, &survivors)?;
            let mut out: Vec<Vec<Value>> = vec![Vec::new(); n];
            if let Some(Col::Num(ids)) = survivors.slots.get(prov).cloned() {
                for (j, &id) in ids.iter().enumerate() {
                    let i = id as usize;
                    if i < n {
                        out[i].push(render_cell(&vals, j, store));
                    }
                }
            }
            Col::Gen(out.into_iter().map(Value::List).collect())
        }
        Expr::AggSubquery {
            body, scalar, func, ..
        } => {
            // Correlated scalar aggregate: the same provenance-tagged sub-run as
            // CollectSubquery, but REDUCE `scalar` per outer row under `func` instead of
            // gathering into a list. Empty / all-null group → NULL (SQL aggregate-of-
            // nothing) for sum/avg/min/max.
            let n = batch.rows();
            let prov = batch.slots.len();
            let mut slots = batch.slots.clone();
            slots.push(Col::Num((0..n).map(|i| i as f64).collect()));
            let seed = Batch::of(slots);
            let survivors = pull_body(body, store, &seed)?;
            let vals = eval(scalar, store, &survivors)?;
            // Per outer row: (running total, count of numeric values, best for min/max).
            let mut acc: Vec<(f64, u64, Option<f64>)> = vec![(0.0, 0, None); n];
            if let Some(Col::Num(ids)) = survivors.slots.get(prov).cloned() {
                for (j, &id) in ids.iter().enumerate() {
                    let i = id as usize;
                    if i >= n {
                        continue;
                    }
                    let Value::Num(x) = vals.value_at(j) else {
                        continue; // NULL / non-numeric args are ignored (SQL sum/avg/min/max)
                    };
                    let (total, cnt, best) = &mut acc[i];
                    *total += x;
                    *cnt += 1;
                    *best = Some(match *best {
                        None => x,
                        Some(b) => {
                            let take_new = (*func == AggFn::Min
                                && value::cmp_num_total(x, b).is_lt())
                                || (*func == AggFn::Max && value::cmp_num_total(x, b).is_gt());
                            if take_new {
                                x
                            } else {
                                b
                            }
                        }
                    });
                }
            }
            let out: Vec<Value> = acc
                .into_iter()
                .map(|(total, cnt, best)| match func {
                    // GQL `SUM` of an empty / all-null set is 0 (not SQL's NULL) — matching
                    // pure-TS and the engine's ordinary aggregate.
                    AggFn::Sum => Value::Num(total),
                    // AVG / MIN / MAX of nothing → NULL.
                    AggFn::Avg if cnt == 0 => Value::Null,
                    AggFn::Avg => Value::Num(total / cnt as f64),
                    _ => best.map_or(Value::Null, Value::Num),
                })
                .collect();
            Col::Gen(out)
        }
        Expr::ScalarSubquery { body, scalar, .. } => {
            // Correlated scalar: same provenance-tagged sub-run, but project `scalar`
            // over the surviving sub-rows and return each outer row's single value
            // (NULL when the body matched nothing). A VALUE subquery must return AT
            // MOST one row per outer row — more than one is an error (matching the TS engine).
            let n = batch.rows();
            let prov = batch.slots.len();
            let mut slots = batch.slots.clone();
            slots.push(Col::Num((0..n).map(|i| i as f64).collect()));
            let seed = Batch::of(slots);
            let survivors = pull_body(body, store, &seed)?;
            let vals = eval(scalar, store, &survivors)?;
            let mut out = vec![Value::Null; n];
            let mut seen = vec![false; n];
            if let Some(Col::Num(ids)) = survivors.slots.get(prov).cloned() {
                for (j, &id) in ids.iter().enumerate() {
                    let i = id as usize;
                    if i < n {
                        if seen[i] {
                            return Err("a VALUE subquery returned more than one row".into());
                        }
                        seen[i] = true;
                        out[i] = vals.value_at(j);
                    }
                }
            }
            Col::Gen(out)
        }
        Expr::UncorrelatedExists { body } => {
            // The body references no outer variable — run it ONCE (a self-contained
            // scan/join/filter plan) and broadcast whether it produced any row.
            let exists = pull(body, store, false)?.rows() > 0;
            Col::Bool(vec![exists; batch.rows()])
        }
        Expr::UncorrelatedCount { body } => {
            // Run the self-contained body once; broadcast its count.
            //
            // The body is an `Aggregate` holding `count(*)` (the GQL lowering wraps it), so the
            // count comes out of the plan as ONE value rather than as a row per match — which
            // is what lets the `count(*)` degree products answer it without walking a path at
            // all (item 501). A body that is NOT a single-row count still answers correctly
            // through the row tally, which is what every other producer of this node emits.
            let out = pull(body, store, false)?;
            // The count is READ as a value, not matched on `Col::Num`: an `Aggregate`'s output
            // column is whatever the fold produced, and for `count(*)` that arrives as a
            // general column, not a numeric one. Matching the representation instead of the
            // VALUE made `COUNT { (x:P) }` answer 1 — the row count of the counted plan —
            // where 3 is right, and the top-level twin in `uncorrelated_subquery_bodies_…`
            // caught it.
            let n = match (out.rows(), out.slots.first()) {
                (1, Some(col)) => match col.value_at(0) {
                    Value::Num(x) => x,
                    // A one-row body that is not a count: the row tally, as before.
                    _ => 1.0,
                },
                (rows, _) => rows as f64,
            };
            Col::Num(vec![n; batch.rows()])
        }
        Expr::UncorrelatedScalar { body } => {
            // Run the self-contained body (its own RETURN) once; the VALUE is its
            // single value (NULL if empty, an error if more than one row).
            let b = pull(body, store, false)?;
            let v = match b.rows() {
                0 => Value::Null,
                1 => b.slot(0).value_at(0),
                _ => return Err("a VALUE subquery returned more than one row".into()),
            };
            broadcast(v, batch.rows())
        }
        Expr::GraphPred { op, args, negated } => {
            use crate::ir::GraphPredOp;
            // Each operand as a column; per row, its element IDENTITY (kind + id) or
            // None (a NULL / non-element). The predicate is three-valued: any None
            // operand yields NULL.
            let cols: Vec<Col> = args
                .iter()
                .map(|a| eval(a, store, batch))
                .collect::<Result<_, _>>()?;
            let ident = |c: &Col, i: usize| -> Option<(u8, u32)> {
                match c {
                    Col::Nodes(v) if v[i] != u32::MAX => Some((0, v[i])),
                    Col::Edges(v) if v[i] != u32::MAX => Some((1, v[i])),
                    _ => None,
                }
            };
            let out: Vec<Value> = (0..batch.rows())
                .map(|i| {
                    let idents: Vec<Option<(u8, u32)>> = cols.iter().map(|c| ident(c, i)).collect();
                    let r: Option<bool> = match op {
                        GraphPredOp::IsDirected => match idents[0] {
                            Some((1, _)) => Some(true), // an edge is directed
                            Some(_) => Some(false),     // a node is not
                            None => None,
                        },
                        GraphPredOp::IsSourceOf | GraphPredOp::IsDestinationOf => {
                            match (idents[0], idents[1]) {
                                (Some((0, node)), Some((1, eid))) => {
                                    store.edge_endpoints(eid).map(|(s, d)| {
                                        node == if matches!(op, GraphPredOp::IsSourceOf) {
                                            s
                                        } else {
                                            d
                                        }
                                    })
                                }
                                (None, _) | (_, None) => None,
                                _ => Some(false), // wrong kinds (e.g. edge IS SOURCE OF)
                            }
                        }
                        GraphPredOp::AllDifferent | GraphPredOp::Same => {
                            if idents.iter().any(Option::is_none) {
                                None
                            } else {
                                let all_same = idents.windows(2).all(|w| w[0] == w[1]);
                                let all_diff = (0..idents.len())
                                    .all(|a| (a + 1..idents.len()).all(|b| idents[a] != idents[b]));
                                Some(if matches!(op, GraphPredOp::Same) {
                                    all_same
                                } else {
                                    all_diff
                                })
                            }
                        }
                    };
                    match r.map(|b| b ^ *negated) {
                        Some(b) => Value::Bool(b),
                        None => Value::Null,
                    }
                })
                .collect();
            Col::Gen(out)
        }
    })
}
