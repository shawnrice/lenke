//! THE AGGREGATE AND PROJECTION FAST PATHS — ~50 `try_*` entries, each answering one plan shape
//! without materializing the batch the general path would build.
//!
//! Every entry is a pure function of `(&Plan, &Store)` plus the aggregate spec, returns
//! `Option<Batch>` (or `Option<u64>`), and must be ANSWER-EQUIVALENT to the general path — a fast
//! path is a performance decision, never a semantic one. They are dispatched from the
//! `Plan::Aggregate` arm of [`super::try_run_inner`] as one lazy `or_else` ladder.
//!
//! # The families
//!
//! | family | entries | the shape |
//! |---|---|---|
//! | fused hop | `try_fused_hop_*`, `try_edge_filtered_count`, `try_edge_cross_count` | one hop, predicate tested inline against the neighbour's column |
//! | dict / streaming | `try_stream_*`, `try_*_dict_*`, `case_dict_lookup`, `try_filter_keep_dict` | a dictionary-encoded column, answered from the dictionary |
//! | degree algebra | `try_degree_algebra`, `walk_levels_total`, `degree_algebra_total`, `reused_trails_at_3` | a deep COUNT as a level recurrence over degrees |
//! | var-length | `try_varlen_*`, `varlen_*` | quantified paths, counted without enumerating |
//! | frontier | `try_frontier_*` | an expand chain, folded without the wide intermediate |
//! | scan | `try_scan_*`, `try_filtered_scan_*`, `try_indexed_*` | a bare or filtered `Scan`, folded columnar |
//! | chain / n-hop | `try_3hop_product_count`, `try_nhop_sweep_count`, `try_fused_count`, `peel_*` | a hop chain as a degree inner product |
//! | Gremlin helpers | `GremlinTree`, `root_ext_id`, `distinct_with_mult` | shapes only the Gremlin lowering produces |
//!
//! # THE LADDER'S ORDER IS NOT FREE
//!
//! Entries are tried in source order and `or_else` is lazy, so an entry placed below one that
//! CLAIMS its shape is dead code that still passes every test it has — both paths return the same
//! answer, so no differential test can see the difference, and the bench row simply reads 1.0x.
//! That has happened three times (items 371, 375, 422), each found by an `eprintln` at function
//! entry rather than by a test.
//!
//! The rule that follows, and the reason the call site carries a comment per contended entry:
//!
//! 1. **Prefer DISJOINT gates.** Two entries that cannot both claim a shape can be read in any
//!    order, and "these never contend" is then checkable by reading rather than by measuring.
//! 2. **Where gates DO contend, pin it with a direct assertion on the function**, not with a
//!    comment. Items 369 and 376 do this — see `the_frontier_count_prop_fast_path_declines_a_bare_scan`
//!    in [`super::tests`]. A gate that the ladder keeps unreachable is still asserted directly,
//!    so it is tested code rather than merely dead code.
//! 3. **A bare `Scan` is a trivial frontier**, which is the specific trap: every `try_frontier_*`
//!    entry will claim a scan aggregate unless its scan twin sits above it.
//!
//! Correctness lives in [`super::tests`] and in `fastpath_fuzz` (generated plans, fast path vs
//! general path, compared as multisets). A passing integration probe is NOT evidence here: the
//! probe fixtures give every node the same label and ask for `count(*)`, which is invisible to a
//! rewrite that permutes which slot holds which node.

use super::aggregation::*;
use super::evaluator::*;
use super::*;
use crate::batch::{Batch, Col};
use crate::gstr::GStr;
use crate::ir::{Expr, Plan};
use crate::store::{Column, Store};
use crate::value::{self, Value};

/// A SCALAR aggregate — no group keys and exactly one aggregate — or `None`.
///
/// Twenty-five entries in this module open with exactly this test, which is what makes it worth
/// a name: the slice pattern `[agg]` says "exactly one" in the type system rather than as a
/// length check beside an index, and the concept the ladder keeps re-spelling ("this entry only
/// answers a scalar aggregate") gets somewhere to be documented.
///
/// The arity half of this is load-bearing for ladder ORDER as well as for correctness — see the
/// module header, and `try_frontier_multi_agg`, which is the one entry that wants `len() >= 2`
/// and therefore sits below every caller of this.
#[inline(always)]
fn sole_agg<'a>(keys: &[(String, Expr)], aggs: &'a [Agg]) -> Option<&'a Agg> {
    match (keys.is_empty(), aggs) {
        (true, [agg]) => Some(agg),
        _ => None,
    }
}

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
    // A SINGLE BOUND MATCHES THE OPERATOR ONCE, instead of per edge (item 1224).
    //
    // `bounds.iter().all(|&(op, t)| num_pred(op, data[j], t))` pays three things PER EDGE that do
    // not depend on the edge: an iterator over `bounds`, a closure call, and `num_pred`'s six-way
    // match on `op`. One bound is the overwhelmingly common case, and hoisting the match hands
    // `hop_num_count` a MONOMORPHIC comparison that inlines into the sweep — the same move
    // `stream_single_bound_count` makes for the scan family, and the one item 451 measured there.
    //
    // The multi-bound arm is left exactly as it was: it would need its own measurement, and item
    // 451 found a range sweep 3.9x its single-bound twin for reasons that did not transfer.
    if let [(op, t)] = bounds.as_slice() {
        let t = *t;

        return match op {
            CompareOp::Eq => hop_num_count(store, label, w, data, present, |x| x == t),
            CompareOp::Ne => hop_num_count(store, label, w, data, present, |x| x != t),
            CompareOp::Lt => hop_num_count(store, label, w, data, present, |x| x < t),
            CompareOp::Le => hop_num_count(store, label, w, data, present, |x| x <= t),
            CompareOp::Gt => hop_num_count(store, label, w, data, present, |x| x > t),
            CompareOp::Ge => hop_num_count(store, label, w, data, present, |x| x >= t),
        };
    }

    // TWO OR MORE BOUNDS reduce to ONE RANGE, so the hop arm gets what the scan family has had
    // since items 1213/1214 (item 1227). `canonical_num_conj` is the SAME reduction, reused rather
    // than reimplemented: it already declines the cases that are not a range — an empty
    // conjunction (a bare `has(k)` presence atom, which counts stored present-nulls the range
    // sweep would miss) and a NaN literal (which does not fold into a `min`/`max` at all, because
    // this repo's predicates keep NaN JS-unordered). A `<>` bound lands in `ne`, which this arm
    // declines too — answering an exclusion over a CSR hop would need the two-pass trick item 1213
    // used on a sequential column, and that needs its own measurement.
    //
    // ⚠️ ITEM 1224 MEASURED WHAT THIS IS WORTH BEFORE IT WAS BUILT, as its own control: the
    // two-bound spelling read 4887.7us against the one-bound arm's 772.4 on the identical fixture,
    // 6.3x, purely because it still walked `bounds` and dispatched `num_pred` per EDGE.
    if let Some(c) = canonical_num_conj(&bounds) {
        if c.ne.is_empty() {
            let (lo, hi) = (c.lo, c.hi);

            return match (c.lo_incl, c.hi_incl) {
                (false, false) => {
                    hop_num_count(store, label, w, data, present, |x| (x > lo) & (x < hi))
                }
                (false, true) => {
                    hop_num_count(store, label, w, data, present, |x| (x > lo) & (x <= hi))
                }
                (true, false) => {
                    hop_num_count(store, label, w, data, present, |x| (x >= lo) & (x < hi))
                }
                (true, true) => {
                    hop_num_count(store, label, w, data, present, |x| (x >= lo) & (x <= hi))
                }
            };
        }
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

/// Count the typed-out neighbours whose column cell is present and satisfies `cmp`, with `cmp`
/// MONOMORPHIC so it inlines into the edge sweep — [`sweep_num_count`]'s hop twin (item 1224).
///
/// The accumulation is branchless for the reason item 1220 established on the scan family: this is
/// an `f64` compare, so evaluating it on an absent cell's slot is a free lane rather than wasted
/// work, and the `&` is what lets the increment be masked. (Item 1222's string arm keeps its
/// short-circuit, because a `memcmp` is not free; item 1223's date sweep got no gain at all,
/// because a 40-byte column is memory-bound. Which of the three applies depends on the cost of the
/// operation being guarded.)
fn hop_num_count<F: Fn(f64) -> bool>(
    store: &Store,
    label: &Option<String>,
    w: u32,
    data: &[f64],
    present: &[bool],
    cmp: F,
) -> Option<u64> {
    let mut count = 0u64;

    if data.len() >= present.len() {
        for_each_typed_out(store, label, w, |nbr| {
            let j = nbr as usize;

            count += u64::from(present[j] & cmp(data[j]));
        })?;
    } else {
        // Defensive, and unreached: both slices come from one column. Without it the
        // unconditional `data[j]` could panic where the short-circuit skipped it.
        for_each_typed_out(store, label, w, |nbr| {
            let j = nbr as usize;

            if present[j] && cmp(data[j]) {
                count += 1;
            }
        })?;
    }
    Some(count)
}

/// Collect the typed-out neighbours whose column cell is present and satisfies `cmp`, in expand
/// order — [`hop_num_count`]'s projecting twin (item 1243).
///
/// ⚠️ THE BRANCHLESS MOVE IS A COMPACTION HERE, NOT AN ACCUMULATION, and that is why it had to be
/// measured separately rather than read off item 1224. A `count += 1` can be masked outright; a
/// `Vec::push` cannot, because the write's ADDRESS depends on the predicate. What can be masked is
/// the INDEX: write the candidate unconditionally and advance the cursor by the mask, so a rejected
/// edge is simply overwritten by the next one. The branch that remains is the capacity grow
/// (`n == out.len()`), taken a logarithmic number of times and predicted every other time.
///
/// The buffer therefore still ends up proportional to the SURVIVORS (rounded up to a power of two),
/// not to the edge count — which is the property this whole arm exists for, so the branchless form
/// is not bought back with the memory the general path was avoiding.
fn hop_num_survivors<F: Fn(f64) -> bool>(
    store: &Store,
    label: &Option<String>,
    w: u32,
    data: &[f64],
    present: &[bool],
    cmp: F,
) -> Option<Vec<u32>> {
    if data.len() < present.len() {
        // Defensive, and unreached: both slices come from one column. Without it the
        // unconditional `data[j]` could panic where the short-circuit skipped it.
        let mut out: Vec<u32> = Vec::new();

        for_each_typed_out(store, label, w, |nbr| {
            let j = nbr as usize;
            if present[j] && cmp(data[j]) {
                out.push(nbr);
            }
        })?;
        return Some(out);
    }

    let mut out: Vec<u32> = vec![0; 64];
    let mut n = 0usize;

    for_each_typed_out(store, label, w, |nbr| {
        let j = nbr as usize;

        if n == out.len() {
            out.resize(n * 2, 0);
        }
        out[n] = nbr;
        n += usize::from(present[j] & cmp(data[j]));
    })?;
    out.truncate(n);
    Some(out)
}

/// `V().out(T).has(k).count()` for a column of ANY type — item 1143.
///
/// The sibling above, [`try_fused_hop_num_count`], already answers this shape when `k` is a packed
/// `Num` column, by STREAMING the per-type CSR and testing a bit per neighbour. It declines every
/// other column type, because its bound test needs the packed `f64` data — and a BARE presence
/// test has no bounds, so that gate excludes nothing the question depends on. Item 1142 measured
/// the cost of that at 200,000 nodes, degree 1, both keys in one process:
///
/// ```text
///   out().has(age).count()     116.1 us    numeric — the streaming sibling
///   out().has(name).count()   2481.5       string  — the SAME question, via the frontier fold
/// ```
///
/// 21.4x for a presence test over the same hop, decided by a property's storage type. The fold
/// builds a `frontier_counts` map first; this streams and tests a bit, exactly as the numeric
/// sibling does.
///
/// A SEPARATE FUNCTION rather than a branch inside that loop. The numeric one is tuned and its
/// per-element test is monomorphic; item 1133 shipped a plan simplification that measured 1.12x
/// SLOWER for perturbing a tuned path, and this file records (item 934) that a per-row branch is
/// the whole of an arity step.
///
/// THE TWO ARE NOT DISJOINT, and the dispatch order in `exec.rs` is therefore load-bearing: the
/// numeric sibling accepts a `Column::Num` with ANY bound list, the EMPTY one included, so a bare
/// `has(k)` on a numeric column is claimed by whichever is consulted first. This entry is placed
/// FIRST because it is cheaper on that shared shape — 81.4us against 105.2 at 200,000 nodes — since
/// the numeric one still drives `bounds.iter().all(..)` over an empty list per neighbour.
///
/// `present_at` semantics, via [`Column::presence_bits`] hoisted ONCE: `PropertyExists` counts a
/// STORED PRESENT-NULL (`present || nulls`), which `has_value_at` does not. Item 1142 established
/// that the numeric sibling's bare `present[i]` is sound only because storing a present-null
/// PROMOTES the column to `Gen`; this entry does not lean on that invariant at all, since it reads
/// the presence bits the accessor defines.
pub(super) fn try_fused_hop_present_count(input: &Plan, store: &Store) -> Option<u64> {
    // SEE THROUGH a row-preserving projection — item 1144, the same move item 1135 made for
    // `try_frontier_count` and for the same reason: Gremlin's `values('k')` lowers to a
    // present-filter plus a `Project` of the value, so the filter this entry needs sits one level
    // too deep and `values(k).count()` fell to the fold. Measured at 200,000 nodes, degree 1:
    //
    // ```text
    //   out().has(k).count()        81 us    this entry
    //   out().values(k).count()   2290       the fold, for want of this unwrap
    // ```
    //
    // Sound because the caller's gate is a keyless `count(*)` with no arg and no `distinct`, so
    // nothing reads the projected column — and the admission set is `Prop`/`Slot` ONLY, which is
    // exactly what `values('k')` emits and is total by construction, so skipping it cannot turn a
    // faulting plan into a counting one. Item 1135 records why that is deliberately narrower than
    // opt's `can_raise`.
    //
    // NOT inside `fused_hop_shape`, which several entries share: `try_fused_hop_project` IS a
    // projection path, and swallowing its `Project` there would be a wrong answer rather than a
    // faster one.
    let input = match input {
        Plan::Project {
            input: inner,
            items,
        } if items
            .iter()
            .all(|(_, e)| matches!(e, Expr::Prop { .. } | Expr::Slot(_))) =>
        {
            &**inner
        }
        other => other,
    };
    let (label, w, pred, exp) = fused_hop_shape(input, store)?;
    // EITHER SPELLING (item 1261). `PropertyExists` counts a stored present-null; `IS NOT NULL`
    // does not — so the spelling decides the mask, and `nulls_count` carries that decision into
    // the sweep below instead of the sweep guessing.
    let (key, nulls_count) = match num_conj_on_slot(pred, 1) {
        Some((key, bounds)) => {
            if !bounds.is_empty() {
                return None; // a bounded conjunction belongs to the numeric sibling
            }
            (key, true)
        }
        None => (is_not_null_on_slot(pred, 1)?, false),
    };
    let col = store.column(&key)?; // absent everywhere -> no rows; the general path answers 0
                                   // ⚠️ `IS NOT NULL` DECLINES A `Gen` COLUMN, and this cost a WRONG ANSWER before it was here.
                                   // The sweep below reads the `present` BIT, and `has_value_at`'s own note says why that is only
                                   // the right question for a TYPED variant: "for every typed variant the `present` bit IS this
                                   // question; only `Gen` keeps its null in `data` and has to look." So on a `Gen` column
                                   // `present[j]` is true for a stored present-null, and counting it answered 3 where
                                   // `IS NOT NULL` must answer 2 — caught by the hop half of
                                   // `property_exists_and_is_not_null_differ_on_a_present_null`, which exists because merging the
                                   // masks SURVIVED the suite while only the scan half was asserted.
                                   //
                                   // `PropertyExists` needs no such gate: a present-null IS a present property, so `present[j]`
                                   // is exactly its question on every variant.
    if !nulls_count && matches!(col, Column::Gen { .. }) {
        return None;
    }
    if reverse_seed_decide(pred, exp, store, false).is_some() {
        return None;
    }
    // THE `nulls` HALF BELOW IS DEFENSIVE, AND ITS MUTANT SURVIVES — labelled rather than left
    // for someone to find. Item 1142 established that storing a present-null PROMOTES the column
    // to `Gen`, and `presence_bits` returns an EMPTY `nulls` for `Gen`, so today `has_nulls` is
    // false for exactly the columns that could have needed it: the half is unreachable and no
    // fixture can distinguish keeping it from dropping it (verified — a three-column fixture with
    // present-nulls reports `Gen` for all three, and the drop-the-nulls mutant survived the whole
    // suite). It is KEPT because it costs nothing measurable (81.1us with it, which is the shipped
    // number) and because it makes THIS entry correct without depending on that cross-module
    // invariant — the dependency item 1142 flagged as a latent silent wrong answer in the numeric
    // sibling. Same disposition as item 1118's `pop_last_node`.
    let (present, nulls) = col.presence_bits();
    let has_nulls = !nulls.is_empty();
    let mut count = 0u64;
    for_each_typed_out(store, label, w, |nbr| {
        let j = nbr as usize;
        if present[j] || (nulls_count && has_nulls && nulls[j]) {
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
    //
    // THE OPERATOR IS MATCHED ONCE AND THE COMPACTION IS BRANCHLESS (item 1243) — the same two
    // moves items 1224 and 1227 made for the COUNT twin, reusing `canonical_num_conj` for the
    // multi-bound reduction rather than reimplementing it. The arms are spelled out rather than
    // factored into one closure-returning helper, because two `match` arms are two closure TYPES
    // and unifying them costs the monomorphic comparison this exists to get.
    //
    // ⚠️ THE SECOND MOVE IS THE LARGER ONE HERE, which item 1243 measured BEFORE building either:
    // at 200,000 nodes the half-selective spelling (`age > 50`, 6544.0us) was SLOWER than the one
    // that keeps every edge (`age >= 0`, 5503.2us). No amount of survivor work explains that
    // ordering and a mispredicted branch per edge does — so the count twin's result does not
    // transfer here, it is a different lever that happens to live in the same loop.
    let survivors = if let [(op, t)] = bounds.as_slice() {
        let t = *t;

        match op {
            CompareOp::Eq => hop_num_survivors(store, label, w, data, present, |x| x == t)?,
            CompareOp::Ne => hop_num_survivors(store, label, w, data, present, |x| x != t)?,
            CompareOp::Lt => hop_num_survivors(store, label, w, data, present, |x| x < t)?,
            CompareOp::Le => hop_num_survivors(store, label, w, data, present, |x| x <= t)?,
            CompareOp::Gt => hop_num_survivors(store, label, w, data, present, |x| x > t)?,
            CompareOp::Ge => hop_num_survivors(store, label, w, data, present, |x| x >= t)?,
        }
    } else if let Some(c) = canonical_num_conj(&bounds).filter(|c| c.ne.is_empty()) {
        let (lo, hi) = (c.lo, c.hi);

        match (c.lo_incl, c.hi_incl) {
            (false, false) => {
                hop_num_survivors(store, label, w, data, present, |x| (x > lo) & (x < hi))?
            }
            (false, true) => {
                hop_num_survivors(store, label, w, data, present, |x| (x > lo) & (x <= hi))?
            }
            (true, false) => {
                hop_num_survivors(store, label, w, data, present, |x| (x >= lo) & (x < hi))?
            }
            (true, true) => {
                hop_num_survivors(store, label, w, data, present, |x| (x >= lo) & (x <= hi))?
            }
        }
    } else {
        // A `<>` bound, a NaN literal, or a bare presence atom — the forms `canonical_num_conj`
        // declines, left on the general test exactly as the count twin leaves them.
        let mut survivors: Vec<u32> = Vec::new();

        for_each_typed_out(store, label, w, |nbr| {
            let j = nbr as usize;
            if present[j] && bounds.iter().all(|&(op, t)| num_pred(op, data[j], t)) {
                survivors.push(nbr);
            }
        })?;
        survivors
    };
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
/// Does this one-hop aggregate belong to the frontier fold rather than the materialized mask?
/// (item 1137)
///
/// EXTRACTED as a pure predicate on purpose. The decision it encodes is a ROUTE choice, and both
/// routes return the same count — so a mutation of the condition written inline survives every
/// differential and end-to-end test there is, which is item 1122's rule ("a perf gate needs its
/// own observable") and the reason item 1136's own M2 verdict is unresolvable. As a total function
/// of two arguments it can be asserted directly, so a mutant has somewhere to fail.
/// Does this NON-NUMERIC extremum belong to the frontier fold rather than the materialized mask?
/// (item 1190)
///
/// ⚠️ MEASURED, and it is a regression this very item nearly shipped. A far-endpoint LABEL compiles
/// to `Filter{IsLabeled{slot: 1}, Expand}` — so `MATCH (a:L)-[:T]->(b:L) RETURN min(b.k)` is a
/// FILTERED hop and reaches `try_fused_hop_mask_agg` at exec.rs:1650, SIXTY-TWO LINES BEFORE
/// `try_frontier_prop_agg` at 1712. Before item 1190 the fused arm declined non-numeric columns
/// and the shape fell through to item 1182's frontier collapse; widening it diverted the shape
/// onto the mask, which materializes every out-neighbour plus a dummy column:
///
/// ```text
///   LABELLED hop min, three alternated rounds
///     str    frontier collapse 3064.0   fused mask 4480.8   0.68x — 1.47x SLOWER
///     dict                     1865.7              1985.8   0.94x
///     bool                     1909.4              1854.0   1.03x
///     num    [fused served it in BOTH arms]                 1.43x FASTER
/// ```
///
/// That is item 375's rule in reverse: widening an EARLIER arm steals shapes a LATER, better arm
/// was serving. So a bare frontier `IsLabeled` under a non-numeric extremum declines here, exactly
/// as item 1137 declined a bare `PropertyExists` under `count(*)` for the same reason.
///
/// `num` is EXCLUDED from the decline because the mask is genuinely better for it — the fused arm
/// served it before and after, and the refactor made it 1.43x faster.
///
/// EXTRACTED as a pure predicate on purpose, for item 1137's stated reason: the decision is a
/// ROUTE choice and both routes return the same answer, so a mutation of the condition written
/// inline survives every differential and end-to-end test there is (item 1122). As a total
/// function it can be asserted directly, so a mutant has somewhere to fail.
pub(super) fn nonnumeric_extremum_belongs_to_the_frontier_fold(
    agg: &Agg,
    pred: &Expr,
    numeric: bool,
) -> bool {
    matches!(agg.func, AggFn::Min | AggFn::Max)
        && !numeric
        && matches!(pred, Expr::IsLabeled { slot: 1, .. })
}

pub(super) fn bare_present_count_belongs_to_the_frontier_fold(agg: &Agg, pred: &Expr) -> bool {
    matches!(agg.func, AggFn::Count)
        && agg.arg.is_none()
        && !agg.distinct
        && matches!(pred, Expr::PropertyExists { slot: 1, .. })
}

/// The masked extremum behind [`try_fused_hop_mask_agg`], shared by every representation
/// (item 1190).
///
/// ONE copy of the loop for all five arms, with each supplying the cheapest comparable KEY for its
/// representation — the same shape as item 1186's `hop_top_k_window`, and for the same two
/// reasons: a `Str` column would otherwise clone a `GStr` per surviving row, and a second copy of
/// a selection loop is a second home for the class of bug item 1185 shipped in one.
///
/// Returns the winning TARGET NODE index, or `None` when no surviving row has a present cell.
fn mask_extremum<K, G, F>(
    targets: &[u32],
    mask: &[Option<bool>],
    present: &[bool],
    want_min: bool,
    key_of: G,
    cmp: F,
) -> Option<usize>
where
    G: Fn(u32) -> K,
    F: Fn(&K, &K) -> std::cmp::Ordering,
{
    let mut best: Option<(usize, K)> = None;
    for (i, &tgt) in targets.iter().enumerate() {
        let j = tgt as usize;
        if mask.get(i) != Some(&Some(true)) || !present[j] {
            continue;
        }
        let k = key_of(tgt);
        let take = match &best {
            None => true,
            Some((_, b)) => {
                let ord = cmp(&k, b);
                (want_min && ord.is_lt()) || (!want_min && ord.is_gt())
            }
        };
        if take {
            best = Some((j, k));
        }
    }
    best.map(|(j, _)| j)
}

pub(super) fn try_fused_hop_mask_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
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
    // DECLINE a bare frontier `PropertyExists` under `count(*)` — item 1137.
    //
    // This entry answers a one-hop aggregate by MATERIALIZING every out-neighbour: a `Vec<u32>`
    // of all 1,000,000 of them at 200k x degree 5, plus a second column of the same length that
    // is a pure dummy (slot 0, which an endpoint-only predicate never reads), and then an
    // `eval_mask` over all of it. For `has('k')` that is the wrong instrument — the frontier
    // fold item 1136 shipped answers the same question with one O(1) presence test per DISTINCT
    // node, folded against the path multiplicity.
    //
    // Measured, 200,000 nodes / degree 5, the two shapes being the SAME question (both answer
    // 1,000,000) and differing only in which arm claims them:
    //
    // ```text
    //   out().has('name').count()      6133.7us   here, via the materialized mask
    //   out().values('name').count()   1930.7     the frontier fold (a `Project` diverts it)
    // ```
    //
    // The claim trace is what found this: `out().has(k).count()` never reached
    // `try_frontier_count` because this arm sits four places above it and says yes. Declining is
    // the right correction rather than REORDERING the chain — items 371 and 375 both record an
    // arm going silently DEAD when it was moved below one that could claim its shape.
    //
    // Narrow on purpose: only `count(*)`, and only a predicate that is EXACTLY a frontier
    // `PropertyExists`. `sum`/`min`/`max` still need the mask (they read a value per row), and a
    // compound predicate still needs the evaluator.
    if bare_present_count_belongs_to_the_frontier_fold(agg, pred) {
        return None;
    }
    // Its NON-NUMERIC extremum sibling (item 1190), declined for the same reason and measured at
    // 1.47x on `str` before this guard existed.
    if nonnumeric_extremum_belongs_to_the_frontier_fold(
        agg,
        pred,
        matches!(
            arg_key.map(|k| store.column(k)),
            Some(Some(Column::Num { .. }))
        ),
    ) {
        return None;
    }
    // The agg property must be a plain Num column (min/max/sum semantics; a NULL cell is
    // skipped, matching the general aggregate).
    // One variant per representation. `Sum` is numeric BY NATURE and keeps its own arm below;
    // `Min`/`Max` are served for all five (item 1190). `Gen` declines: a mixed column's extremum
    // crosses type ranks and belongs to the general fold, as in every other arm.
    //
    // WIDENING IN PLACE IS SAFE HERE, unlike item 1184's frontier multi-agg: that function's
    // `match` sat INSIDE the per-node loop, so extra arms taxed every row (1.10x on a control).
    // This one is a `sole_agg` path whose tail matches ONCE per query and whose arms each own
    // their loop, so the dispatch cost is paid once. Measured below with `num` as the control
    // rather than argued.
    enum AggCol<'a> {
        Rows,
        Num(&'a [f64], &'a [bool]),
        Str(&'a [GStr], &'a [bool]),
        Dict(&'a [GStr], &'a [u32], &'a [bool]),
        Bool(&'a [bool], &'a [bool]),
        Temporal(&'a [crate::temporal::Temporal], &'a [bool]),
    }
    let acol = match arg_key {
        Some(k) => match store.column(k)? {
            Column::Num { data, present, .. } => AggCol::Num(data, present),
            Column::Str { data, present, .. } => AggCol::Str(data, present),
            Column::Dict {
                dict,
                codes,
                present,
                ..
            } => AggCol::Dict(dict, codes, present),
            Column::Bool { data, present, .. } => AggCol::Bool(data, present),
            Column::Temporal { data, present, .. } => AggCol::Temporal(data, present),
            Column::Gen { .. } => return None,
        },
        None => AggCol::Rows,
    };
    // `Sum` reads a value per row and only a numeric column can answer it.
    if matches!(agg.func, AggFn::Sum) && !matches!(acol, AggCol::Num(..)) {
        return None;
    }
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
    match (&agg.func, &acol) {
        (AggFn::Count, _) => {
            let c = (0..targets.len()).filter(|&i| is_true(i)).count();
            Some(scalar_num(c as f64))
        }
        (AggFn::Sum, AggCol::Num(data, present)) => {
            let mut total = 0f64;
            for (i, &t) in targets.iter().enumerate() {
                let j = t as usize;
                if is_true(i) && present[j] {
                    total += data[j];
                }
            }
            Some(scalar_num(total))
        }
        // ONE extremum shape per representation, each handing `mask_extremum` the cheapest
        // comparable key: the f64, the dictionary RANK (integer compares, no string compares),
        // the value, or the node id for `Str` where caching a `GStr` would clone an Arc per
        // surviving row.
        (AggFn::Min | AggFn::Max, _) => {
            let want_min = matches!(agg.func, AggFn::Min);
            let v = match &acol {
                AggCol::Rows => return None,
                AggCol::Num(data, present) => mask_extremum(
                    targets,
                    &mask,
                    present,
                    want_min,
                    |n| data[n as usize],
                    |a: &f64, b: &f64| value::cmp_num_total(*a, *b),
                )
                .map_or(Value::Null, |j| Value::Num(data[j])),
                AggCol::Str(data, present) => mask_extremum(
                    targets,
                    &mask,
                    present,
                    want_min,
                    |n| n,
                    |a: &u32, b: &u32| data[*a as usize].cmp(&data[*b as usize]),
                )
                .map_or(Value::Null, |j| Value::Str(data[j].clone())),
                AggCol::Dict(dict, codes, present) => {
                    // RANKS over the dictionary, computed once, so the fold compares integers.
                    let mut order: Vec<u32> = (0..dict.len() as u32).collect();
                    order.sort_unstable_by(|x, y| dict[*x as usize].cmp(&dict[*y as usize]));
                    let mut rank = vec![0u32; dict.len()];
                    for (r, c) in order.iter().enumerate() {
                        rank[*c as usize] = r as u32;
                    }
                    mask_extremum(
                        targets,
                        &mask,
                        present,
                        want_min,
                        |n| rank[codes[n as usize] as usize],
                        u32::cmp,
                    )
                    .map_or(Value::Null, |j| Value::Str(dict[codes[j] as usize].clone()))
                }
                AggCol::Bool(data, present) => mask_extremum(
                    targets,
                    &mask,
                    present,
                    want_min,
                    |n| data[n as usize],
                    bool::cmp,
                )
                .map_or(Value::Null, |j| Value::Bool(data[j])),
                AggCol::Temporal(data, present) => mask_extremum(
                    targets,
                    &mask,
                    present,
                    want_min,
                    |n| data[n as usize],
                    |a: &crate::temporal::Temporal, b: &crate::temporal::Temporal| a.cmp_total(b),
                )
                .map_or(Value::Null, |j| Value::Temporal(data[j])),
            };
            Some(Batch::single(Col::Gen(vec![v])))
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
/// `<slot>.<key> IS NOT NULL` as a presence gate — the OTHER spelling of "this element carries a
/// usable value for `key`" (item 1261).
///
/// ⚠️ IT IS NOT `PropertyExists`, AND THE DIFFERENCE IS THE MASK. `ir.rs` states it: `PropertyExists`
/// is true for a PRESENT value "regardless of that value", and it is "the one predicate that
/// separates an absent property from a present `Null` … which `<var>.<key> IS NOT NULL` cannot". So
/// `PropertyExists` counts `present || nulls` and this counts `present` ALONE. Admitting one as the
/// other would miscount a stored present-null.
///
/// WHY THIS EXISTS: `has(k)` lowers to `PropertyExists` and reached the presence fast paths, while
/// the GQL spelling lowered to `IsNull { negated: true }` and did not — so it fell to the general
/// path and the same question cost ~4x more (item 1260, 200,000 nodes / 800,000 edges, identical
/// answers):
///
/// ```text
///   GQL   scan  WHERE age IS NOT NULL     890.3 us      GREM  scan  has('age')   228.9 us   3.89x
///   GQL   hop   WHERE b.age IS NOT NULL  1216.5         GREM  hop   has('age')   286.4     4.25x
/// ```
///
/// A SEPARATE matcher rather than an arm inside `num_conj_on_slot`, because that function has five
/// callers and returns `(key, bounds)` with no room to say which spelling produced an empty bound
/// list — and the mask has to follow the SPELLING, not the call site.
fn is_not_null_on_slot(pred: &Expr, slot: usize) -> Option<String> {
    let Expr::IsNull {
        expr,
        negated: true,
    } = pred
    else {
        return None;
    };

    match expr.as_ref() {
        Expr::Prop { slot: s, key } if *s == slot => Some(key.clone()),
        _ => None,
    }
}

pub(super) fn num_conj_on_slot(
    pred: &Expr,
    slot: usize,
) -> Option<(String, Vec<(CompareOp, f64)>)> {
    // An atom on `slot` is either a numeric compare (a bound) or a `PropertyExists`
    // presence gate (NO bound — redundant with the streaming count's own `present[i]`
    // check, and implied by any compare on the same key).
    //
    // WHY THAT `present[i]` IS SOUND, which the line above asserts without saying (item 1142).
    // `PropertyExists` is `present_at` — `present || nulls`, counting a STORED PRESENT-NULL —
    // while a packed column's `present[i]` is `has_value_at`, which does not. Those differ, so
    // dropping the atom in favour of `present[i]` looks like an undercount. It is not, and the
    // reason is a REPRESENTATION INVARIANT rather than anything in this function: storing a
    // present-null PROMOTES the column to `Column::Gen`, so a `Column::Num` cannot contain one
    // and the two accessors coincide there. Verified by building such a fixture and printing the
    // variant (`Gen`), not by reading the writer.
    //
    // CONSEQUENCE IF THE PACKED COLUMNS EVER TRACK NULLS IN PLACE: this shortcut becomes a wrong
    // answer, silently, on a shape that returns a plausible count. The caller gates on
    // `Column::Num`, so the invariant is load-bearing at exactly one line. `has(k, pred)` desugars to
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
    let agg = sole_agg(keys, aggs)?;
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

/// `slot.key IN [nums]` UNDESUGARED, as the numbers it selects (item 1264).
///
/// `opt::normalize_pred` rewrites `x IN [literals]` to an OR-chain at 32 items or fewer and LEAVES
/// it as `Expr::In` above that, so [`eq_disjunction_on_slot`] — which matches only the desugared
/// form — sees nothing above 32. For a `Num` column that meant no streaming arm at all there, and
/// it is worth 4.2-5.4x (item 1264's sweep: k=48 6.557ms -> 1.206, k=64 6.766 -> 1.622).
///
/// ⚠️ NUMERIC ONLY, AND SEPARATE FROM THE SHARED MATCHER FOR A MEASURED REASON. Teaching
/// `eq_disjunction_on_slot` itself to accept `Expr::In` was written first, on the theory that 32
/// against 33 was a PLAN boundary for every column kind — this engine's named bug class. For
/// strings that theory is FALSE and the change was a REGRESSION, because a dict column already has
/// a fallback that the numeric one does not: `try_stream_dict_pred_count` evaluates an arbitrary
/// predicate ONCE PER DISTINCT VALUE, which is strictly better than a per-row membership test, and
/// it claims the undesugared `In` perfectly well. Diverting that shape to the membership arm cost
/// up to 2.4x, on identical answers, with the k <= 32 rows flat as expected (200,000 nodes, a
/// 100-value `Str` column):
///
/// ```text
///   k            8     31     32     33     40
///   shared     0.704  1.022  0.477  0.496  0.739   ms   <- the REJECTED form
///   separate   0.626  1.062  0.428  0.281  0.306        <- unchanged, and faster at 33 and 40
/// ```
///
/// So there was never a string cliff to fix — the string cost is not even monotonic in k — and the
/// numbers above are why this matcher is numeric and why [`eq_disjunction_on_slot`] is untouched.
fn num_in_list_on_slot(pred: &Expr, slot: usize) -> Option<(String, Vec<f64>)> {
    let Expr::In { needle, haystack } = pred else {
        return None;
    };

    let Expr::Prop { slot: s, key } = needle.as_ref() else {
        return None;
    };

    if *s != slot {
        return None;
    }

    // A literal list only: a parameter or an expression haystack is not a known value set here.
    let Expr::Lit(Value::List(items)) = haystack.as_ref() else {
        return None;
    };

    if items.is_empty() {
        return None; // `k IN []` is FALSE for every row; the general path answers 0 by rule
    }

    let mut vals = Vec::with_capacity(items.len());

    for v in items {
        match v {
            // A NULL term makes the non-matching rows UNKNOWN rather than FALSE, which is the same
            // reason `eq_disjunction_on_slot` declines one. Any non-number cannot equal a packed
            // `Num` cell, and a count is the wrong place to re-derive cross-type comparison.
            Value::Num(n) => vals.push(*n),
            _ => return None,
        }
    }

    Some((key.clone(), vals))
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
/// Count nodes of `label` whose single-property predicate holds over a `Column::Bool`, by folding
/// the predicate ONCE for each of the column's three possible readings and then sweeping a lookup
/// (item 1208).
///
/// This is `try_stream_dict_pred_count`'s twin, and the dictionary case already explains why the
/// shape works: a predicate over a column with few distinct values can be evaluated per DISTINCT
/// VALUE instead of per row. A boolean column has the fewest possible — `true`, `false`, and
/// absent — so the fold is three evaluations whatever the row count, and the sweep is a table
/// lookup.
///
/// ⚠️ WHY IT EXISTS AT ALL: `try_filtered_count`'s chain had arms for num, membership, dict and
/// date but NONE for bool, so `WHERE flag = true RETURN count(*)` fell through to materializing a
/// batch and running `try_filter_keep` over it. Item 1207 priced that at **3.97x on unpredictable
/// data** (166.2us against 660.1 at 200,000 nodes), measured by the periodic-vs-random detector
/// item 1206 established — the corpus's own fixture hid it, because a predictable column makes the
/// fallback's branch almost free.
///
/// The accumulation is `count += u64::from(hit)` and NOT `if hit { count += 1 }`: the whole point
/// is to stop paying a mispredict per row, and a branch here would hand it straight back.
pub(super) fn try_stream_bool_count(
    store: &Store,
    label: &Option<String>,
    pred: &Expr,
) -> Option<u64> {
    let key = sole_prop_key(pred, 0)?;
    let Some(Column::Bool { data, present, .. }) = store.column(&key) else {
        return None;
    };
    // Fold the predicate for each reading the column can present. `None` from any of the three
    // means the predicate is not a constant-foldable single-property one (it faults, or yields a
    // non-boolean), and the caller's general path stays the only implementation of that.
    let eval_const = |v: &Value| -> Option<bool> {
        let e = subst_prop(pred, 0, &key, v);
        let col = eval(&e, store, &Batch::single(Col::Num(vec![0.0]))).ok()?;
        Some(matches!(col.value_at(0), Value::Bool(true)))
    };
    let on_true = eval_const(&Value::Bool(true))?;
    let on_false = eval_const(&Value::Bool(false))?;
    let on_null = eval_const(&Value::Null)?;
    let mut count = 0u64;

    scan_visit(store, label, |i| {
        let hit = if present[i] {
            if data[i] {
                on_true
            } else {
                on_false
            }
        } else {
            on_null
        };

        count += u64::from(hit);
    });

    Some(count)
}

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
    // ⚠️ TWO BRANCHLESS REWRITES OF THE SWEEP BELOW HAVE BEEN TRIED AND BOTH MEASURED NOTHING.
    // Item 1207's periodic-vs-random detector prices this arm at 1.66x — it IS data-dependent —
    // and the obvious causes are both now ruled out:
    //
    //   item 1208  `count += u64::from(hit)` instead of `if hit { count += 1 }`   1.66x -> 1.66x
    //   item 1209  the absent reading as the table's LAST SLOT, so `present[i]`
    //              becomes an index computation rather than a branch                1.66x -> 1.64x
    //
    // The identical pair of rewrites took the BOOLEAN twin (`try_stream_bool_count`) from 3.97x to
    // 1.00x, so the mechanism is real and this arm's data-dependence is somewhere else: the
    // `codes[i]` indirection the boolean lookup does not need is the remaining suspect, and the
    // bounds check on a runtime-sized `matches` is another. Both rewrites were REVERTED rather
    // than kept as neutral changes carrying a claim they did not earn.
    let mut count = 0u64;
    scan_visit(store, label, |i| {
        let hit = if present[i] {
            matches[codes[i] as usize]
        } else {
            null_match
        };
        // ⚠️ `count += u64::from(hit)` WAS TRIED HERE AND MEASURED NOTHING (item 1208). This arm
        // reads 1.66x slower on random values than on the corpus's periodic ones (201.4us against
        // 335.2), so it IS data-dependent — but the accumulation is not where that comes from, and
        // rewriting it branchless left the ratio at exactly 1.66x. The same rewrite was decisive
        // for the boolean twin, so the difference is elsewhere in this arm (the `present[i]`
        // branch, or the `codes[i]` indirection the lookup needs and the boolean one does not).
        // Left as it was; the 1.66x stays open with that one cause ruled out.
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
    // THE UNDESUGARED `Expr::In`, NUMERIC ONLY (item 1264) — its own early return rather than a
    // widening of the shared matcher, because widening that matcher regressed the string path by
    // up to 2.4x. `num_in_list_on_slot` carries the measurement.
    if let Some((key, nums)) = num_in_list_on_slot(pred, 0) {
        let Some(Column::Num { data, present, .. }) = store.column(&key) else {
            return None;
        };

        return Some(stream_eq_set_count(store, label, data, present, &nums));
    }

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
            // ⚠️ THIS IS WHERE THE DICT-EQUALITY ROW LIVES, and items 1208 and 1209 both looked
            // in the wrong function (item 1215). Item 1207's detector prices `d = 'g3' RETURN
            // count(*)` at 1.66-1.70x on random values against the corpus's periodic ones, and
            // both of those items rewrote `try_stream_dict_pred_count` and measured the ratio
            // UNCHANGED — correctly, because `= 'g3'` never reaches that function: THIS arm runs
            // before it in `try_filtered_count`'s chain and claims the shape. Confirmed by
            // instrumenting both: the dict arm is entered only by the 100-distinct STRING
            // column's range rows (`dict.len()=100`). So those two refutations were vacuous, not
            // informative, and the ruled-out list for this row is now:
            //
            //   1208  branchless accumulation            (in the WRONG function)
            //   1209  absent reading as a table slot     (in the WRONG function)
            //   1215  single-target code compare + branchless accumulation, HERE — no change
            //         (187.9/319.9 against 201.4/335.9, inside this session's noise), so neither
            //         the `Vec::contains` scan nor the branch is the cause
            //
            // What is left is whatever differs between a periodic and a random code sequence for
            // two sequential loads and a branchless add — not a branch, not a dependent load, and
            // not the membership test. Unmeasured, so unclaimed.
            // A SINGLE target needs no membership test: the code is in a register, so
            // `codes[i] == want` replaces a `Vec::contains` call — a loop with a bounds check —
            // per row, and the accumulation is branchless.
            //
            // ⚠️ ITEM 1215 WROTE THIS SAME SPECIALIZATION AND RECORDED IT AS MEASURING NOTHING.
            // That verdict was VACUOUS: it was measured on the census fixture, which has no index,
            // so the planner emits an `IndexSeek` and THIS FUNCTION NEVER RUNS. Instrumenting the
            // chain against an INDEXED store shows it serving the equality 18 times (item 1219) —
            // because with an index the planner declines to seed above ~1.6% and emits
            // `Filter+Scan`, which is what reaches here.
            if let [want] = targets.as_slice() {
                let want = *want;

                scan_visit(store, label, |i| {
                    count += u64::from(present[i] && codes[i] == want);
                });
            } else {
                scan_visit(store, label, |i| {
                    count += u64::from(present[i] && targets.contains(&codes[i]));
                });
            }
        }
        Column::Str { data, present, .. } => {
            let mut targets: Vec<&str> = Vec::with_capacity(vals.len());
            for v in &vals {
                let Value::Str(s) = v else { return None };
                targets.push(s.as_ref());
            }
            // Small target sets get the comparison UNROLLED, so the common membership pays no
            // iterator and no closure per row (item 1222).
            //
            // ⚠️ THE SHORT-CIRCUIT STAYS HERE, unlike `sweep_num_count`'s (item 1220). There the
            // branch cost more than the `f64` compare it guarded, so evaluating unconditionally
            // won. A string compare is a length test plus a `memcmp`: running it on an absent
            // cell is real wasted work, not a free lane, so `&&` is correct for this column type.
            //
            // ⚠️ AND A SINGLE TARGET IS UNREACHABLE FROM A QUERY, which is why `[a]` is written
            // for completeness rather than for speed. A lone string equality - `= 'x'` and
            // `IN ['x']` alike - is planned as an `IndexSeek`, whose third arm degrades to a label
            // scan when no index exists; it never enters this function. Measured: the arm serves
            // `IN [a, b]` and `= a OR = b`, and nothing with one target.
            match targets.as_slice() {
                [a] => {
                    let a = *a;

                    scan_visit(store, label, |i| {
                        if present[i] && data[i].as_ref() == a {
                            count += 1;
                        }
                    });
                }
                [a, b] => {
                    let (a, b) = (*a, *b);

                    scan_visit(store, label, |i| {
                        if present[i] {
                            let s = data[i].as_ref();

                            if s == a || s == b {
                                count += 1;
                            }
                        }
                    });
                }
                _ => {
                    scan_visit(store, label, |i| {
                        if present[i] && targets.iter().any(|t| data[i].as_ref() == *t) {
                            count += 1;
                        }
                    });
                }
            }
        }
        // THE NUMERIC SIBLING (item 1264). This function's own header calls itself "the string
        // sibling of `try_stream_num_count`", and a `Num` column fell through to `_` — so a
        // NUMERIC membership count had no streaming arm while the string one had two.
        // `num_conj_on_slot` cannot cover it: it returns a CONJUNCTION of bounds, all of which
        // must hold, and a disjunction has no such shape.
        //
        // Measured at 200,000 nodes, all three spellings answering an identical 6000:
        //
        // ```text
        //   scan IN [1,2,3]           0.85 ms  ->  0.07      scan >= 1 AND <= 3   0.03 ms
        //   scan = 1 OR = 2 OR = 3    0.84     ->  0.07                            12.1x
        // ```
        //
        // The conjunction is what showed the gap: on a contiguous set `k >= 1 AND k <= 3` selects
        // the IDENTICAL rows as `k IN [1,2,3]`, so the 28x could not be selectivity — which is
        // the trap item 1263 retracted a whole target for.
        Column::Num { data, present, .. } => {
            let mut targets: Vec<f64> = Vec::with_capacity(vals.len());

            for v in &vals {
                match v {
                    Value::Num(n) => targets.push(*n),
                    _ => return None,
                }
            }

            count = stream_eq_set_count(store, label, data, present, &targets);
        }
        _ => return None,
    }
    Some(count)
}

/// `k IN {vals}` over a packed `Num` column, as ONE VECTORIZED PASS PER DISTINCT VALUE.
///
/// The mirror of the k-exclusion arm in [`try_stream_num_count`], and item 1231's measured rule in
/// a new place: k passes that each auto-vectorize beat one closure carrying k terms, because a
/// third term is enough to stop LLVM vectorizing it (item 451 named the mechanism; item 1229
/// measured the cliff — one exclusion 51.2us, two 608.8, 11.9x for one more literal).
///
/// NO ARITY CAP, and that is measured rather than assumed. k passes must eventually lose to the
/// general path's single k-term pass, so the crossover was looked for and is not in range: the
/// general path grows with k too, so this wins at every arity tried — 12.7x at k=2 down to 4.2x at
/// k=64 — with identical answers at every k.
///
/// ```text
///   k          2      4      8     16     32     64
///   before  0.709  1.131  1.735  2.752  4.735  6.766   ms, 200,000 nodes
///   after   0.056  0.107  0.209  0.415  0.830  1.622
/// ```
///
/// ⚠️ DISTINCT VALUES, OR IT DOUBLE-COUNTS. `k IN [7, 7]` and `k = 7 OR k = 7` are each one row
/// set, and two passes over `7` would report twice its size — a WRONG ANSWER, not a slow one.
/// Neither `normalize_pred` nor either matcher deduplicates (they have no reason to: the general
/// arm is idempotent in the disjunction), so it happens here, with the same `contains` the
/// k-exclusion arm uses — `PartialEq` on `f64`, the SAME `==` the counting pass applies, so a
/// signed zero cannot slip between the dedup and the count.
///
/// NaN NEEDS NO SPECIAL CASE, unlike the range reductions in this file. `k = NaN` is never TRUE,
/// and the pass is `x == v`, false for every `x` when `v` is NaN and false for a NaN cell against
/// every `v` — so a NaN in the list contributes exactly 0, which is the answer. (The dedup's
/// `contains` never folds two NaNs, and does not need to: each contributes 0.)
/// `canonical_num_conj` must decline a NaN literal because it folds literals into a RANGE; nothing
/// is folded here.
///
/// Its own `#[inline(never)]` function for the reason `try_stream_range_count` is one: this file
/// has measured a fast path costing a shape it never runs, through code layout alone, when an arm
/// was written inline and the enclosing function grew.
#[inline(never)]
fn stream_eq_set_count(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
    vals: &[f64],
) -> u64 {
    let mut count = 0u64;
    let mut counted: Vec<f64> = Vec::with_capacity(vals.len());

    for &v in vals {
        if counted.contains(&v) {
            continue;
        }

        counted.push(v);
        count += sweep_num_count(store, label, data, present, |x| x == v);
    }

    count
}

/// `DISTINCT`/`dedup()` over `values(<col>)`: emit the distinct values in FIRST-SEEN order,
/// deduping on the column's own representation — never boxing a `Value` or building a key
/// string per row. Byte-identical to the general first-seen dedup, because each arm's key is
/// injective on that column's values (see the per-arm notes). Bails (→ general path) on a
/// null-sentinel id, or on an absent value unless the plan's own `PropertyExists` filter says
/// absent rows are dropped.
///
/// WAS DICT-ONLY UNTIL ITEM 854. The shape was recognized for a `Dict` column and nothing else,
/// so `values('score').dedup()` over a `Num` column went to the general path. Item 853 measured
/// that at 200,000 rows, same store, against the GQL spelling of the same question:
///
/// ```text
///   count(DISTINCT p.score)   gql 411us   gremlin 5326us   12.96x
///   DISTINCT p.score rows     gql 421     gremlin 5327     12.65x
///   count(DISTINCT p.hired)   gql 596     gremlin 22613    37.92x
///   min(p.hired)              gql 568     gremlin  569      1.00x  <- already surface-neutral
/// ```
///
/// The `min` row is why this is a lowering gap and not a surface tax: `values(k).min()` reaches
/// item 841's arm at ratio 1.00, so the machinery is shared and only this gate was narrow.
pub(super) fn try_distinct_value_col(input: &Plan, store: &Store) -> Option<Batch> {
    let Plan::Project { input: pin, items } = input else {
        return None;
    };
    let [(_, Expr::Prop { slot, key })] = items.as_slice() else {
        return None;
    };
    let col = store.column(key)?;
    // Admit before the PULL, which is the expensive part — a column type with no arm below must
    // decline here rather than after materializing the frontier.
    if !matches!(
        col,
        Column::Dict { .. }
            | Column::Num { .. }
            | Column::Str { .. }
            | Column::Bool { .. }
            | Column::Temporal { .. }
    ) {
        return None; // Gen
    }
    // A temporal column is admitted here for ANY kind, and the per-kind decision is made ONCE, by
    // the dedup arms below: an unkeyable kind (`Duration`) falls to their `_` arm and declines.
    // A second `temporal_kind_keyable` check here was written first and REMOVED (item 1016) —
    // removing it is answer-equivalent and its mutant survived the suite, which is the same
    // two-gates-one-decision shape item 1015 had to undo in `distinct.rs`. One decision, one
    // place; a test cannot give teeth to a branch that cannot be reached.
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
    // One loop per representation. They are deliberately separate rather than one loop behind a
    // key closure: this function's neighbours in this file record (items 375, 844) that sharing a
    // body across typed arms taxes the arm that was already fast.
    macro_rules! dedup {
        ($present:expr, $nulls:expr, $new_seen:expr, $key:expr, $val:expr, $col:expr) => {{
            let present = $present;
            let nulls = $nulls;
            let mut seen = $new_seen;
            let mut out = Vec::new();

            for &id in ids {
                if id == u32::MAX {
                    return None; // a NULL value in the dedup — let the general path handle it
                }

                let i = id as usize;

                if !present[i] {
                    // A STORED PRESENT NULL is a VALUE, not an absent cell, and `values(k)` KEEPS
                    // it where it DROPS an absent one (`by_absent_property_filters_present_null
                    // _kept` in the gremlin tests states that rule). Both read `!present[i]`, so
                    // only `nulls[i]` tells them apart — and this path cannot emit a NULL into the
                    // dedup, so a present null goes to the general path.
                    //
                    // THIS IS THE BUG ITEM 858 FIXES. Item 854 widened this arm from `Dict` to
                    // every representation, inherited the `!present[i]` test unchanged, and so
                    // silently dropped present nulls for the newly admitted types. The
                    // cross-engine fuzzer caught it on `g.V().values('age').dedup().count()` —
                    // one engine 1, the other 5 — on a commit that changed no code.
                    if nulls[i] {
                        return None;
                    }

                    if absent_dropped {
                        continue;
                    }

                    return None;
                }

                if $key(&mut seen, i) {
                    out.push($val(i));
                }
            }

            return Some(Batch::of(vec![$col(out)]));
        }};
    }
    match col {
        // A distinct value IS a distinct code, so a `dict.len()` bitset needs no hash and no
        // string decode. The original arm, unchanged.
        Column::Dict {
            dict,
            codes,
            present,
            nulls,
        } => dedup!(
            present,
            nulls,
            vec![false; dict.len()],
            |seen: &mut Vec<bool>, i: usize| {
                let c = codes[i] as usize;
                let fresh = !seen[c];
                seen[c] = true;
                fresh
            },
            |i: usize| dict[codes[i] as usize].clone(),
            Col::Str
        ),
        // `num_group_bits` is the equivalence the value contract defines (-0.0 with 0.0, NaN
        // with itself), so this is the general path's grouping and not a stricter one.
        Column::Num {
            data,
            present,
            nulls,
        } => dedup!(
            present,
            nulls,
            FnvSet::<u64>::default(),
            |seen: &mut FnvSet<u64>, i: usize| seen.insert(value::num_group_bits(data[i])),
            |i: usize| data[i],
            Col::Num
        ),
        // Keyed on the BORROWED `&str` — no per-row copy. Written as its own loop rather than
        // through the macro above: a closure annotated `&mut FnvSet<&str>` infers `'static` for
        // that borrow and the key cannot outlive `store`, so the macro's typed-closure form does
        // not express this arm. Keying on an owned `GStr` clone would compile and costs a clone
        // per row for nothing.
        Column::Str {
            data,
            present,
            nulls,
        } => {
            let mut seen: FnvSet<&str> = FnvSet::default();
            let mut out: Vec<GStr> = Vec::new();

            for &id in ids {
                if id == u32::MAX {
                    return None;
                }

                let i = id as usize;

                if !present[i] {
                    // A stored present null is a VALUE — see the macro above (item 858).
                    if nulls[i] {
                        return None;
                    }

                    if absent_dropped {
                        continue;
                    }

                    return None;
                }

                if seen.insert(data[i].as_ref()) {
                    out.push(data[i].clone());
                }
            }

            Some(Batch::of(vec![Col::Str(out)]))
        }
        Column::Bool {
            data,
            present,
            nulls,
        } => dedup!(
            present,
            nulls,
            [false; 2],
            |seen: &mut [bool; 2], i: usize| {
                let b = usize::from(data[i]);
                let fresh = !seen[b];
                seen[b] = true;
                fresh
            },
            |i: usize| data[i],
            Col::Bool
        ),
        // A DATE keys on its epoch-day count, which items 843/847/848 established is in bijection
        // with its rendering — so two dates dedup together iff the general path groups them.
        Column::Temporal {
            kind: crate::temporal::TemporalKind::Date,
            data,
            present,
            nulls,
        } => dedup!(
            present,
            nulls,
            FnvSet::<i32>::default(),
            |seen: &mut FnvSet<i32>, i: usize| match data[i] {
                crate::temporal::Temporal::Date(d) => seen.insert(d.days),
                // Unreachable: a column holds one kind. Treated as NOT fresh rather than pushed,
                // so a broken invariant loses a row loudly in a test instead of emitting a value
                // this arm never keyed.
                _ => false,
            },
            |i: usize| Value::Temporal(data[i]),
            Col::Gen
        ),
        // The other kinds (item 1016), on the same argument as the aggregate above. `Date` keeps
        // the narrower `i32` arm; this column read **40,387 us for `datetime` against `Date`'s
        // 740**.
        Column::Temporal {
            kind,
            data,
            present,
            nulls,
        } if super::distinct::temporal_kind_keyable(*kind) => dedup!(
            present,
            nulls,
            FnvSet::<(i64, u32, i16)>::default(),
            |seen: &mut FnvSet<(i64, u32, i16)>, i: usize| {
                match super::distinct::temporal_struct_key(data[i]) {
                    Some(k) => seen.insert(k),
                    // Unreachable: the gate above admits only keyable kinds and a column holds one.
                    // NOT fresh rather than pushed, so a broken invariant loses a row loudly.
                    None => false,
                }
            },
            |i: usize| Value::Temporal(data[i]),
            Col::Gen
        ),
        _ => None,
    }
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
    let agg = sole_agg(keys, aggs)?;
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
    // THE OPERATOR IS MATCHED ONCE, not per edge (item 1225). `num_pred(*op, ..)` is a six-way
    // match, and `op` is fixed for the whole query — so every edge paid a jump table and lost the
    // chance to inline the comparison. Item 1224 measured that exact substitution at 5.28x on the
    // hop count; this is the endpoint-compare twin.
    let count = match op {
        CompareOp::Eq => cross_count(
            store,
            label,
            *dir,
            &want,
            &nbr_bits,
            (*ls, *rs),
            (ld, lp),
            (rd, rp),
            |a, b| a == b,
        ),
        CompareOp::Ne => cross_count(
            store,
            label,
            *dir,
            &want,
            &nbr_bits,
            (*ls, *rs),
            (ld, lp),
            (rd, rp),
            |a, b| a != b,
        ),
        CompareOp::Lt => cross_count(
            store,
            label,
            *dir,
            &want,
            &nbr_bits,
            (*ls, *rs),
            (ld, lp),
            (rd, rp),
            |a, b| a < b,
        ),
        CompareOp::Le => cross_count(
            store,
            label,
            *dir,
            &want,
            &nbr_bits,
            (*ls, *rs),
            (ld, lp),
            (rd, rp),
            |a, b| a <= b,
        ),
        CompareOp::Gt => cross_count(
            store,
            label,
            *dir,
            &want,
            &nbr_bits,
            (*ls, *rs),
            (ld, lp),
            (rd, rp),
            |a, b| a > b,
        ),
        CompareOp::Ge => cross_count(
            store,
            label,
            *dir,
            &want,
            &nbr_bits,
            (*ls, *rs),
            (ld, lp),
            (rd, rp),
            |a, b| a >= b,
        ),
    };
    Some(scalar_num(count as f64))
}

/// [`try_edge_cross_count`]'s per-edge sweep, with `cmp` MONOMORPHIC so the endpoint comparison
/// inlines instead of going through `num_pred`'s six-way match on every edge (item 1225).
///
/// `slots` is `(ls, rs)`, each 0 for the source or 1 for the neighbour. Those are loop-invariant
/// too, and the `if` on them is LEFT IN PLACE deliberately: it is perfectly predicted, and
/// monomorphizing over them as well would be 2 x 2 x 6 = 24 instantiations of this body for a
/// branch the predictor already gets right. The dispatch is the part that is never free
/// (item 1224's ranking: a per-row DISPATCH outranks a per-row BRANCH).
#[allow(clippy::too_many_arguments)]
fn cross_count<F: Fn(f64, f64) -> bool>(
    store: &Store,
    label: &Option<String>,
    dir: crate::ir::Dir,
    want: &[u32],
    nbr_bits: &Option<Vec<bool>>,
    slots: (usize, usize),
    left: (&[f64], &[bool]),
    right: (&[f64], &[bool]),
    cmp: F,
) -> u64 {
    let (ls, rs) = slots;
    let (ld, lp) = left;
    let (rd, rp) = right;
    let mut count = 0u64;

    scan_visit(store, label, |src| {
        let src = src as u32;

        for_each_nbr(store, src, dir, want, false, |nbr, _| {
            if let Some(bits) = nbr_bits {
                if !bits[nbr as usize] {
                    return; // neighbour fails its `(b:Label)` constraint
                }
            }

            let li = if ls == 0 { src } else { nbr } as usize;
            let ri = if rs == 0 { src } else { nbr } as usize;

            if lp[li] && rp[ri] && cmp(ld[li], rd[ri]) {
                count += 1;
            }
        });
    });
    count
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

    // ⚠️ THE ACCUMULATION IS BRANCHLESS, AND THAT IS THE POINT (item 1220). Written as
    // `if present[i] && cmp(data[i]) { count += 1 }` this sweep vectorizes only when LLVM
    // chooses to mask the increment, and WHETHER IT DOES DEPENDS ON THE CLOSURE: the header of
    // `stream_single_bound_count` records a 6.6-7.4x gap between two closures handed to THIS
    // function, with the cause unfound and the caller routing ordering bounds through the
    // two-bound arm to dodge it. Accumulating unconditionally removes the choice for all eleven
    // call sites at once.
    //
    // `&` not `&&`: the short-circuit is what reintroduces the branch. It costs an evaluation of
    // `cmp` on an absent cell's slot, which is a well-formed `f64` (zero or stale, never
    // uninitialized) whose verdict is then ANDed away — so the answer is unchanged, and `cmp` is a
    // pure comparison at every call site.
    if data.len() >= present.len() {
        scan_visit(store, label, |i| {
            count += u64::from(present[i] & cmp(data[i]));
        });
    } else {
        // Defensive: a shorter `data` would make the unconditional `data[i]` panic where the
        // short-circuit skipped it. No caller does this (both slices come from one column), so
        // this arm is unreached - but the cost of keeping it is one loop-invariant test.
        scan_visit(store, label, |i| {
            if present[i] && cmp(data[i]) {
                count += 1;
            }
        });
    }
    count
}

/// `num_conj_on_slot`'s TEMPORAL twin: a conjunction of comparisons against DATE literals on one
/// property of `slot`, reduced to that key plus its bounds in RAW DAYS. Mirrors the numeric
/// version exactly, including the FLIPPED spelling (`DATE '...' >= p.k` is `p.k <= DATE '...'`) and
/// the `PropertyExists` presence atom that `has(k, pred)` desugars to — two spellings that mean the
/// same thing must reach the same path, and the numeric one already honours both.
fn date_conj_on_slot(pred: &Expr, slot: usize) -> Option<(String, Vec<(CompareOp, i32)>)> {
    let atom = |e: &Expr| -> Option<(String, Option<(CompareOp, i32)>)> {
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
                    Value::Temporal(crate::temporal::Temporal::Date(d)) => {
                        Some((key, Some((op, d.days))))
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    };
    let mut conjuncts = Vec::new();
    flatten_and(pred, &mut conjuncts);
    let mut key0: Option<String> = None;
    let mut bounds: Vec<(CompareOp, i32)> = Vec::with_capacity(conjuncts.len());
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

/// ⚠️ REJECTED HERE: ITEM 1220'S BRANCHLESS ACCUMULATION, WHICH IS 1.04x SLOWER ON THIS SWEEP
/// (item 1223). Folding the three nested branches into one match yielding a `(is_date, days)` pair
/// plus `count += u64::from(present[i] & is_date & cmp(days))` measured, over three
/// order-alternated rounds with the binaries hash-asserted and the numeric control flat at
/// 30.7-31.1 us:
///
/// ```text
///   PRE   113.1  113.5  114.5
///   POST  118.1  118.2  118.6      disjoint, consistently worse
/// ```
///
/// The mechanism, and why the transfer fails: `size_of::<Temporal>()` is **40 bytes** against an
/// `f64`'s 8, because the enum is sized by its largest variant while a `Date` payload is 4. At
/// 200,000 rows this sweep streams 8 MB to read 800 KB of days, and it costs 102.9 us against the
/// numeric twin's 29.2 on the IDENTICAL row count — a 3.5x ratio BELOW the 5x width ratio, which is
/// the signature of a loop already bound by memory rather than by branches. Item 1220's rewrite
/// wins where the compare is the cost; here it only adds an unconditional `cmp` call.
///
/// THE REAL LEVER IS THE COLUMN, not the loop: `Column::Temporal` is already homogeneous by
/// `kind` (the caller checks it once), so it could store the PAYLOAD rather than the enum — 4 bytes
/// a row instead of 40, which would put 200,000 dates in L2. That is a storage change and needs its
/// own measurement; it is not inherited from this one.
fn sweep_date_count<F: Fn(i32) -> bool>(
    store: &Store,
    label: &Option<String>,
    data: &[crate::temporal::Temporal],
    present: &[bool],
    cmp: F,
) -> u64 {
    let mut count = 0u64;
    scan_visit(store, label, |i| {
        if present[i] {
            if let crate::temporal::Temporal::Date(d) = &data[i] {
                if cmp(d.days) {
                    count += 1;
                }
            }
        }
    });
    count
}

/// STREAM a DATE predicate over the label bucket, counting matches with raw `i32` day compares.
///
/// Item 871 censused the filter family by column representation and found this missing. A date
/// predicate fell to the general evaluator, and the numbers say it was not merely un-specialized
/// but actively expensive — 200,000 nodes, min of 9:
///
/// ```text
///   Num  = 7                 147.3 us      the reference, already streamed
///   WHERE true               731.1         the filter machinery with NO column read
///   Date = DATE '...'      2,753.5         18.7x the numeric, and 3.8x WHERE TRUE
///   Date >= DATE '...'     1,293.6         12.7x the numeric `>`
/// ```
///
/// Costing MORE than `WHERE true` is the tell: `WHERE true` reads no property at all, so the ~10 ns
/// a row above it was the per-row boxing of a `Value::Temporal` plus a generic `cmp_total`, to
/// answer a question about one `i32`. `Date` is in bijection with `days` (item 840), so the compare
/// is an integer compare and the column is homogeneous by construction — `kind` is checked once
/// here rather than per row.
///
/// Single bound only. The two-bound range arm is deliberately absent: item 451 measured the numeric
/// range sweep at 3.9x its single-bound twin and traced it to lost VECTORIZATION rather than to the
/// extra compare, so a range arm here would need its own measurement rather than inheriting this
/// one's.
pub(super) fn try_stream_date_count(
    store: &Store,
    label: &Option<String>,
    pred: &Expr,
) -> Option<u64> {
    let (key, bounds) = date_conj_on_slot(pred, 0)?;
    let Some(Column::Temporal {
        kind,
        data,
        present,
        ..
    }) = store.column(&key)
    else {
        return None;
    };
    if *kind != crate::temporal::TemporalKind::Date {
        // A BAIL, not a correctness guard, and that was checked rather than assumed: removing it
        // is answer-equivalent (its mutant survives). A cross-kind comparison is INCOMPARABLE, so
        // the general path yields UNKNOWN and the row drops — measured at 0 rows for a Date
        // column against DATETIME, TIME and even a string literal, so nothing throws here. With
        // the check gone the sweep's `if let Temporal::Date` simply never matches and returns the
        // same 0. It stays to skip a scan that cannot produce a row.
        return None;
    }
    let [(op, t)] = bounds.as_slice() else {
        return None; // no bound (a bare presence gate) or a range — the general path
    };
    let t = *t;
    let count = match op {
        CompareOp::Eq => sweep_date_count(store, label, data, present, |x| x == t),
        CompareOp::Ne => sweep_date_count(store, label, data, present, |x| x != t),
        CompareOp::Lt => sweep_date_count(store, label, data, present, |x| x < t),
        CompareOp::Le => sweep_date_count(store, label, data, present, |x| x <= t),
        CompareOp::Gt => sweep_date_count(store, label, data, present, |x| x > t),
        CompareOp::Ge => sweep_date_count(store, label, data, present, |x| x >= t),
    };

    Some(count)
}

/// The SINGLE-BOUND arm of [`try_stream_num_count`] — reached by `Eq`/`Ne`, which have no range
/// form, and as the fallback when the paired range declines (item 1205).
///
/// Item 451 measured this arm at **0.459 ms per 1,000,000 nodes** and said why: "the single-bound
/// sweep's monomorphic closure auto-vectorizes". Item 453 then brought the RANGE to 0.431 ms,
/// "landing exactly on the single-bound cost". Those two figures scale to ~92 us at 200,000 nodes,
/// and the range still measures 91.6-102 us there — but the single bound measured **609-680 us**,
/// 6.6x the range and 7.4x its own recorded cost, with the two spellings returning the identical
/// count. So the arm had lost its vectorization while the arm beside it kept it.
///
/// ⚠️ NOT CAUSED BY THE GROWTH OF THIS FILE DURING THIS SESSION, which was the first suspicion:
/// measured at `84f50e5f`, the commit before this session's first `fastpath.rs` widening, the same
/// probe reads 6.65x (609.0 us against 91.6). The regression is long-standing.
///
/// ⚠️ ITEM 453'S FIX WAS TRIED HERE FIRST AND DID NOTHING: a separate `#[inline(never)]` function
/// left the ratio at 6.75x, unchanged. So this is NOT the layout hazard that comment describes, and
/// the caller routes an ORDERING bound through the two-bound arm instead — see the note there.
///
/// ⚠️ ITEM 1220 IS THE FIRST MECHANISM THAT FITS, THOUGH IT IS NOT YET PROVEN TO BE THIS ONE.
/// `sweep_num_count` accumulated with `if present[i] && cmp(data[i]) { count += 1 }`, which
/// vectorizes only when LLVM elects to mask the increment — and that election is per-closure, which
/// is exactly the shape of a gap between two closures handed to the same function. Making the
/// accumulation unconditional took the filtered count from 101.8us to 30.8 (3.30x isolated, 3.19x
/// and 3.17x on the GQL and Gremlin corpus rows). NOT VERIFIED as the cause of the 6.75x, because
/// this caller still routes ordering bounds through the two-bound arm, so the arm that exhibited it
/// is still bypassed. Removing that workaround and re-measuring is the open follow-up.
#[inline(never)]
fn stream_single_bound_count(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
    op: CompareOp,
    t: f64,
) -> u64 {
    match op {
        CompareOp::Eq => sweep_num_count(store, label, data, present, |x| x == t),
        CompareOp::Ne => sweep_num_count(store, label, data, present, |x| x != t),
        CompareOp::Lt => sweep_num_count(store, label, data, present, |x| x < t),
        CompareOp::Le => sweep_num_count(store, label, data, present, |x| x <= t),
        CompareOp::Gt => sweep_num_count(store, label, data, present, |x| x > t),
        CompareOp::Ge => sweep_num_count(store, label, data, present, |x| x >= t),
    }
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
    // ⚠️ REJECTED HERE: ITEM 1227'S `&&` -> `&`, WHICH MEASURES NOTHING ON THIS SWEEP (item 1228).
    // Item 1227 found a `&&` inside the closure worth 4.0x on the HOP sweep, by blocking the
    // vectorization item 1220's branchless accumulation exists to enable. The same substitution on
    // these four arms, three order-alternated rounds with the binaries hash-asserted: PRE
    // 30.8-30.9 us against POST 30.6-31.2 — flat and overlapping. Reverted.
    //
    // WHY IT DOES NOT TRANSFER, which is the useful half: `sweep_num_count` walks a CONTIGUOUS
    // label bucket, so the index is sequential and LLVM folds the `&&` into the mask anyway — at
    // 28-31 us for 200,000 rows (0.15 ns a row) this loop is already vectorized. `hop_num_count`
    // walks a per-type CSR, where the indices are a GATHER, and there the branch stops it.
    let count = match (lo_incl, hi_incl) {
        (false, false) => sweep_num_count(store, label, data, present, |x| x > lo && x < hi),
        (false, true) => sweep_num_count(store, label, data, present, |x| x > lo && x <= hi),
        (true, false) => sweep_num_count(store, label, data, present, |x| x >= lo && x < hi),
        (true, true) => sweep_num_count(store, label, data, present, |x| x >= lo && x <= hi),
    };

    Some(count)
}

/// A conjunction of numeric bounds on ONE column, reduced to its canonical shape (item 1213).
///
/// `lo`/`hi` are the tightest surviving range and `ne` the values excluded by `<>`. Every
/// conjunction of `<`, `<=`, `>`, `>=`, `=` and `<>` on one column reduces to this, which is what
/// lets a THREE-bound predicate reach a monomorphic sweep instead of the general arm's
/// `bounds.iter().all(|&(op, t)| num_pred(op, data[i], t))` — a `Vec` walk plus a runtime op match
/// PER BOUND PER ROW, which is item 451's own diagnosis of the cost it left in place above two
/// bounds. Measured: `k > 50 AND k < 100 AND k <> 73` counted in 1074.9us where the two-bound
/// spelling of the same scan costs 92.8, about 11.6x for one extra comparison.
#[derive(Debug, PartialEq)]
pub(super) struct NumConj {
    pub lo: f64,
    pub lo_incl: bool,
    pub hi: f64,
    pub hi_incl: bool,
    pub ne: Vec<f64>,
}

/// Reduce `bounds` to a [`NumConj`], or `None` when the reduction is not sound.
///
/// ⚠️ A NaN LITERAL DECLINES, and that is the one case worth stating. `num_pred(Gt, x, NaN)` is
/// false for every `x`, and `num_pred(Ne, x, NaN)` is TRUE for every `x` (this repo's predicates
/// keep NaN JS-unordered — item 1205), so a NaN bound does not fold into a `min`/`max` at all:
/// tightening `hi` with it would silently admit or reject the whole column. The general arm stays
/// the only implementation of that.
///
/// `=` collapses to `[t, t]` inclusive, so `k = 5 AND k > 0` canonicalizes to a range and reaches
/// the range sweep too — a shape the old arm also walked per row.
pub(super) fn canonical_num_conj(bounds: &[(CompareOp, f64)]) -> Option<NumConj> {
    // ⚠️ AN EMPTY CONJUNCTION DECLINES, AND A TEST CAUGHT THIS. `num_conj_on_slot` returns NO
    // bounds for a bare presence atom (`has(k)`), and the general arm then counts
    // `present[i] || nulls[i]` — a STORED PRESENT-NULL included. The canonical form of no bounds
    // is the full range `[-inf, +inf]`, which the range sweep gates on `present[i]` ALONE and so
    // undercounts exactly those cells. A different question, so not this one.
    if bounds.is_empty() {
        return None;
    }

    let mut c = NumConj {
        lo: f64::NEG_INFINITY,
        lo_incl: true,
        hi: f64::INFINITY,
        hi_incl: true,
        ne: Vec::new(),
    };

    for &(op, t) in bounds {
        if t.is_nan() {
            return None;
        }

        match op {
            // Tighten the lower bound. An EQUAL threshold that is EXCLUSIVE wins over an
            // inclusive one (`k >= 5 AND k > 5` is `k > 5`), which is why the `==` case updates
            // the flag rather than being skipped.
            CompareOp::Gt | CompareOp::Ge => {
                let incl = op == CompareOp::Ge;

                if t > c.lo {
                    c.lo = t;
                    c.lo_incl = incl;
                } else if t == c.lo && !incl {
                    c.lo_incl = false;
                }
            }
            CompareOp::Lt | CompareOp::Le => {
                let incl = op == CompareOp::Le;

                if t < c.hi {
                    c.hi = t;
                    c.hi_incl = incl;
                } else if t == c.hi && !incl {
                    c.hi_incl = false;
                }
            }
            // `=` is a range of one point. Two different equalities leave `lo > hi`, which the
            // sweep then matches nothing for — the same answer the per-row conjunction gives.
            CompareOp::Eq => {
                if t > c.lo {
                    c.lo = t;
                    c.lo_incl = true;
                } else if t == c.lo {
                    c.lo_incl = true;
                }

                if t < c.hi {
                    c.hi = t;
                    c.hi_incl = true;
                } else if t == c.hi {
                    c.hi_incl = true;
                }
            }
            CompareOp::Ne => c.ne.push(t),
        }
    }

    Some(c)
}

pub(super) fn try_stream_num_count(
    store: &Store,
    label: &Option<String>,
    pred: &Expr,
) -> Option<u64> {
    // EITHER SPELLING (item 1261) — see `is_not_null_on_slot`. `nulls_count` is false for the
    // `IS NOT NULL` form, whose mask is `present` alone.
    let (key, bounds, nulls_count) = match num_conj_on_slot(pred, 0) {
        Some((key, bounds)) => (key, bounds, true),
        None => (is_not_null_on_slot(pred, 0)?, Vec::new(), false),
    };
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
        // ⚠️ A SINGLE ORDERING BOUND IS ROUTED THROUGH THE TWO-BOUND ARM, by pairing it with a
        // VACUOUS companion (item 1205). That looks backwards — the range closure does strictly
        // MORE work — and it is what the measurement says: `x >= 500000` cost 618.4us where
        // `x >= 500000 AND x < 1000000` over the identical 99,835 matching rows cost 91.6, a
        // 6.75x gap between two closures handed to the SAME `sweep_num_count`. Both arms were
        // confirmed to fire by instrumenting them, both plans are identical, and the gap is
        // present at `84f50e5f` too, so it is neither a route problem nor new.
        //
        // Item 451 named the mechanism when it built this arm — "the single-bound sweep's
        // monomorphic closure auto-vectorizes" — and that is what has stopped being true for it
        // while remaining true for its neighbour: `scan_visit` is monomorphized per closure TYPE,
        // so whether LLVM vectorizes is decided per arm. Extracting this arm into its own
        // `#[inline(never)]` function (item 453's fix for the range) was tried FIRST and changed
        // nothing — 6.75x before, 6.75x after — so the fix is not layout.
        //
        // THE PAIRING IS EXACT FOR EVERY f64, which is the only reason this is sound rather than
        // nearly sound: `x >= lo` <=> `x >= lo && x <= f64::INFINITY` (an infinite upper bound,
        // INCLUSIVE, so `+inf` still matches; NaN fails both sides either way), and `x < hi` <=>
        // `x >= f64::NEG_INFINITY && x < hi`. `Eq`/`Ne` have no range form and keep the arm below.
        let paired = match op {
            CompareOp::Gt | CompareOp::Ge => Some([(*op, *t), (CompareOp::Le, f64::INFINITY)]),
            CompareOp::Lt | CompareOp::Le => Some([(CompareOp::Ge, f64::NEG_INFINITY), (*op, *t)]),
            CompareOp::Eq | CompareOp::Ne => None,
        };

        if let Some(pair) = paired {
            if let Some(count) = try_stream_range_count(store, label, &pair, data, present) {
                return Some(count);
            }
        }

        return Some(stream_single_bound_count(
            store, label, data, present, *op, *t,
        ));
    }
    if let Some(count) = try_stream_range_count(store, label, &bounds, data, present) {
        return Some(count);
    }
    // THREE OR MORE BOUNDS, reduced to a canonical range plus exclusions (item 1213), so they reach
    // a monomorphic sweep instead of the general arm below. `canonical_num_conj` declines a NaN
    // literal, which is the one reduction that would not be sound; everything else folds.
    if let Some(c) = canonical_num_conj(&bounds) {
        // NO exclusions: the canonical range IS a two-bound predicate, so hand it to the arm that
        // already vectorizes. `k = 5 AND k > 0` lands here too, as `[5, 5]`.
        if c.ne.is_empty() {
            let pair = [
                (
                    if c.lo_incl {
                        CompareOp::Ge
                    } else {
                        CompareOp::Gt
                    },
                    c.lo,
                ),
                (
                    if c.hi_incl {
                        CompareOp::Le
                    } else {
                        CompareOp::Lt
                    },
                    c.hi,
                ),
            ];

            if let Some(count) = try_stream_range_count(store, label, &pair, data, present) {
                return Some(count);
            }
        }
        // ONE exclusion, as TWO VECTORIZED PASSES rather than one three-term closure: count the
        // range, then subtract the excluded value's own count.
        //
        // ⚠️ THE OBVIOUS FORM WAS BUILT FIRST AND MEASURED, which is why this one exists. A single
        // closure `|v| v > lo && v < hi && v != x` took the periodic fixture from 386.9us to 112.4
        // (3.44x) but left the RANDOM one at 680.7 — still 6.1x data-dependent, where the plain
        // two-bound range arm beside it is FLAT at 92.5/92.9. A third term breaks the
        // auto-vectorization the two-term closure gets, and item 451 already named that mechanism
        // ("the single-bound sweep's monomorphic closure auto-vectorizes").
        //
        // So the predicate is split into two closures that each vectorize. That is item 471's
        // measured rule — N passes over one column each BEAT one interleaved pass — applied to a
        // predicate instead of to a set of aggregates.
        //
        // SOUND BECAUSE THE RANGE ALREADY EXCLUDES NaN: within `[lo, hi]` every value is non-NaN,
        // so `v != x` is exactly `!(v == x)` there and the subtraction cannot over-count. A NaN
        // cell fails the range test itself (every ordering comparison is false for it), so it is
        // in neither count. `-0.0 == 0.0` holds in both directions, so a signed zero is treated
        // identically by the two passes.
        // ⚠️ k EXCLUSIONS, NOT ONE (item 1231). `[x]` admitted exactly one and everything else fell
        // to the general arm, which walks `bounds` and dispatches `num_pred` PER ROW — measured at
        // item 1229 as a cliff: one exclusion 51.2us, TWO exclusions 608.8us, 11.9x, for one more
        // literal. k+1 passes is the same trick with the same soundness argument, which does not
        // depend on k.
        //
        // ⚠️ DUPLICATES MUST BE SUBTRACTED ONCE, which is new at k > 1 and is a WRONG ANSWER if
        // missed: `k <> 73 AND k <> 73` reduces to `ne = [73, 73]`, and two subtractions would
        // under-count by the number of 73s. `canonical_num_conj` does not deduplicate (it has no
        // reason to — the general arm is idempotent in `ne`), so this does. The comparison used for
        // dedup is `contains`, i.e. `PartialEq` on `f64` — the SAME `==` the counting pass uses, so
        // a signed zero is treated identically by both and cannot slip between them. (NaN cannot
        // appear in `ne` at all: `canonical_num_conj` declines a NaN literal outright.)
        if !c.ne.is_empty() {
            let pair = [
                (
                    if c.lo_incl {
                        CompareOp::Ge
                    } else {
                        CompareOp::Gt
                    },
                    c.lo,
                ),
                (
                    if c.hi_incl {
                        CompareOp::Le
                    } else {
                        CompareOp::Lt
                    },
                    c.hi,
                ),
            ];

            if let Some(total) = try_stream_range_count(store, label, &pair, data, present) {
                let mut excluded = 0u64;
                let mut counted: Vec<f64> = Vec::with_capacity(c.ne.len());

                for &x in &c.ne {
                    // An excluded value only needs counting when it is INSIDE the range; outside
                    // it the range count already omits it and the pass would be pure cost.
                    let inside = (if c.lo_incl { x >= c.lo } else { x > c.lo })
                        && (if c.hi_incl { x <= c.hi } else { x < c.hi });

                    if inside && !counted.contains(&x) {
                        counted.push(x);
                        excluded += sweep_num_count(store, label, data, present, |v| v == x);
                    }
                }

                return Some(total - excluded);
            }
        }
    }
    let mut count = 0u64;
    scan_visit(store, label, |i| {
        // A bare presence gate (`has(k)`, no bounds) counts PRESENCE — a stored
        // present-null included (`present || nulls`). A bounded compare counts only
        // typed values (`present`): a null satisfies no numeric predicate.
        if bounds.is_empty() {
            if present[i] || (nulls_count && nulls[i]) {
                count += 1;
            }
        } else if present[i] && bounds.iter().all(|&(op, t)| num_pred(op, data[i], t)) {
            count += 1;
        }
    });
    Some(count)
}

/// Count the emitted paths of a bounded OUT walk by DEGREE ARITHMETIC — O(V+E) — instead of
/// enumerating them, with up to three independent filters folded in.
///
/// Extracted from [`try_varlen_count`] at item 572 so the quantified-GROUP count can reach it
/// too. `Some(n)` answered; `None` declined, and a decliner must be able to fall back.
///
/// The three filters apply at DIFFERENT places, which is the whole reason they are three:
///
/// - `end_pred` is the ENDPOINT filter: a path's last node only. A `{0,n}`'s zero-length path
///   has the source as its endpoint, so this is the only filter that touches it.
/// - `body` is a per-LANDING node filter (item 570): every node past the source, pruning.
/// - `trav` is a `k = 1` per-REPETITION predicate (item 572), a function of one
///   `(source, edge, target)` triple. Under `Dir::Out` an edge id fixes all three.
///
/// So a 2-hop path `s -> y -> z` over edges `a`, `b` is counted when
/// `trav(a) && body(y) && trav(b) && body(z) && end(z)`, a 1-hop `s -> y` when
/// `trav(a) && body(y) && end(y)`. Collapsing any two of the masks would apply one of them at
/// the other's position.
#[allow(clippy::too_many_arguments)]
fn try_degree_algebra(
    store: &Store,
    src: &[u32],
    want: &[u32],
    min: u32,
    max: u32,
    mode: PathMode,
    dir: Dir,
    end_pred: Option<(&Expr, usize)>,
    body: Option<(&Expr, usize)>,
    trav: Option<&Expr>,
    // `seed`: a `k = 1` per-repetition predicate reading nothing but the PATH SOURCE
    // (mini-scope slot `2k+1`), item 575. It gates the HOP terms only — see below.
    seed: Option<&Expr>,
) -> Option<u64> {
    let is_trail = matches!(mode, PathMode::Trail);
    // BOTH DIRECTIONS (item 586). The algebra is a statement about degrees and nothing in it
    // prefers out-degree: `Dir::In` is the same arithmetic over `store.inc`. It was gated to
    // `Dir::Out` since item 64 and the refusal cost 9.0x for an IDENTICAL count — 35.99ms
    // against 3.99 at 200,000 vertices / 1,000,000 edges, both answering 5,999,996 — while a
    // single IN hop costs exactly what a single OUT hop does (0.51ms each), so the in-adjacency
    // was never the reason.
    //
    // `Dir::Both` stays refused and cannot be added this way: from one node an undirected edge
    // is traversable in two directions, so a single edge-indexed traversal mask cannot represent
    // both, and a self-loop sits in both adjacency lists at once. It is a different shape, not a
    // third branch of this one.
    let inward = matches!(dir, Dir::In);
    // DEPTH (item 587). The bound was `max <= 2` because of the TRAIL correction: at two hops
    // there is exactly ONE way to reuse an edge (a self-loop taken twice) and the arithmetic
    // subtracts it, while at three there are several interacting ways and no single term.
    //
    // A WALK forbids nothing, so its count obeys a clean recurrence instead — see
    // `walk_levels_total`. That is the GREMLIN-facing mode: `repeat()` lowers to `PathMode::Walk`
    // ("Gremlin allows revisiting edges", gremlin.rs), so depth past 2 is not a niche ISO
    // spelling. Priced at 200,000 vertices / 600,000 edges:
    //
    //   WALK {1,2}  (already accepted)               2.80 ms
    //   WALK {1,3}                                  40.36
    //   WALK {1,4}                                 107.45
    //   g.V().repeat(out()).times(3).count()        38.18
    //   g.V().repeat(out()).times(4).count()       104.96
    //
    // TRAIL AT EXACTLY 3 is now accepted too (item 602). It needed "its own inclusion-exclusion
    // over edge-reuse shapes", which is what this comment said for two items and what
    // `reused_trails_at_3` now is: at depth 3 the walks to exclude are exactly those where two of
    // `e0, e1, e2` coincide, and each case collapses to a countable term. Item 600 derived it and
    // validated it 400/400 against brute-force triple enumeration over random graphs admitting
    // self-loops and parallel edges; item 601 shipped it in the TS engine at 40.79x.
    //
    // A TRAIL AT 4 is now accepted too (item 693), by a different route from depth 3's: items
    // 687-689 avoided the interacting-pairs problem entirely rather than deriving it. Every 4-trail
    // is an edge followed by a 3-trail from its head AVOIDING that edge, so
    //
    //   T4(s) = Σ_{e0: s→b} [ t3(b) − u3(b, s) ]
    //
    // and `u3` — the 3-trails from `b` that USE `e0` — splits into THREE DISJOINT cases, because a
    // trail uses each edge at most once and so `e0` sits in exactly one position. No intersection
    // terms, which is what replaces the 63-term expansion item 600 declined. Validated 600/600
    // against brute force with 8/8 mutants (689), shipped in TS at 190x (692).
    //
    // DEPTH 4 REQUIRES EVERY MASK ABSENT, and that is the one real asymmetry with depth 3. This
    // algebra FOLDS an endpoint predicate in (the per-node out-degree becomes a per-node PASSING
    // out-degree), but the depth-4 terms were derived for a TRIVIAL mask and nothing validates them
    // against a filtered one. The TS side refuses on the syntax for the same reason (692).
    //
    // A TRAIL AT 5 OR MORE is still refused. The identity is recursive — `u4` would be four
    // disjoint cases — but what those cases need from the adjacency has not been priced, which is
    // item 686's rule.
    let deep_walk = max >= 3 && matches!(mode, PathMode::Walk);
    let unmasked = end_pred.is_none() && body.is_none() && trav.is_none() && seed.is_none();
    let deep_trail = is_trail && (max == 3 || (max == 4 && unmasked));
    if matches!(dir, Dir::Out | Dir::In)
        && ((1..=2).contains(&max) || deep_walk || deep_trail)
        && matches!(mode, PathMode::Trail | PathMode::Walk)
    {
        let (nc, ec) = (store.node_count(), store.edge_count());
        let avg_deg = if nc == 0 { 0.0 } else { ec as f64 / nc as f64 };
        let est_paths = src.len() as f64 * avg_deg.powi(max as i32);
        // The threshold GENERALIZES the old constant rather than replacing it: the algebra costs
        // one pass over the graph per level, so enumeration has to be worth more than that.
        // `max.max(2)` keeps it at exactly `2 * (nodes + edges)` for every depth the gate already
        // accepted, so no query that took this route before changes route now.
        if est_paths > f64::from(max.max(2)) * (nc + ec) as f64 {
            // An endpoint predicate folds INTO the algebra rather than defeating it: a node's
            // contribution as a hop TARGET is either counted or not, so the per-node out-degree
            // becomes a per-node PASSING out-degree.
            //
            // The labelled block is the fallback. Unlike the per-endpoint sink, this asks the
            // predicate about EVERY node rather than only the reached ones, so it can fail where
            // the walk would not — see `an_endpoint_predicate_is_evaluated_only_for_reached_nodes`.
            // On that it breaks out and the enumeration below answers.
            'algebra: {
                let ok: Option<Vec<bool>> = match end_pred {
                    None => None,
                    Some((p, slot)) => match crate::exec::varlen::node_pass_mask(p, slot, store) {
                        Ok(o) => Some(o),
                        Err(_) => break 'algebra,
                    },
                };
                // The BODY mask is a second, independent question from the endpoint one, and
                // the two apply at different places: the endpoint predicate asks only about a
                // path's LAST node, the body filter about EVERY node past the source. A 2-hop
                // path `s -> y -> z` needs `body(y) && body(z) && end(z)`; a 1-hop `s -> y`
                // needs `body(y) && end(y)`; the zero-length path has no landing at all, so
                // only `end(s)` applies to it. Collapsing them into one mask would silently
                // apply the endpoint predicate to the intermediate node.
                let body_ok: Option<Vec<bool>> = match body {
                    None => None,
                    Some((p, slot)) => match crate::exec::varlen::node_pass_mask(p, slot, store) {
                        Ok(o) => Some(o),
                        Err(_) => break 'algebra,
                    },
                };
                // The TRAVERSAL mask (item 572). A `k = 1` per-repetition predicate is a
                // function of ONE `(source, edge, target)` triple, and under `Dir::Out` the edge
                // id fixes all three — so a single edge-indexed mask carries a target test, an
                // edge test, a source test and any conjunction of them. Separate node and edge
                // masks could not: `WHERE y.age > 50 AND e.w > 5` does not factor into them.
                let trav_ok: Option<Vec<bool>> = match trav {
                    None => None,
                    Some(p) => match crate::exec::varlen::traversal_pass_mask(p, store, dir) {
                        Ok(o) => Some(o),
                        Err(_) => break 'algebra,
                    },
                };
                let trav_fn = |eid: u32| trav_ok.as_ref().is_none_or(|o| o[eid as usize]);
                // The SEED mask (item 575). A per-rep predicate reading only the PATH SOURCE is
                // constant along a path, so it either admits every repetition from that source
                // or none — a filter on the source ROW, not on a traversal.
                let seed_ok: Option<Vec<bool>> = match seed {
                    None => None,
                    // Slot 3 is the path source at `k = 1` (`2k+1`), and `node_pass_mask` puts
                    // the node it asks about at the slot it is given.
                    Some(p) => match crate::exec::varlen::node_pass_mask(p, 3, store) {
                        Ok(o) => Some(o),
                        Err(_) => break 'algebra,
                    },
                };
                let seed_fn = |v: u32| seed_ok.as_ref().is_none_or(|o| o[v as usize]);
                let passes = |v: u32| ok.as_ref().is_none_or(|o| o[v as usize]);
                let body_fn = |v: u32| body_ok.as_ref().is_none_or(|o| o[v as usize]);
                let plain =
                    want.is_empty() && ok.is_none() && body_ok.is_none() && trav_ok.is_none();

                // MONOMORPHIZED PER DIRECTION. The direction has to reach the two hot loops
                // somehow, and the OUT path — which this item did not set out to touch — is
                // sensitive to HOW. Five shapes, each measured in its own isolated probe over
                // four alternated rounds, one case per process, min-of-min:
                //
                //   closure `|v| if inward { inc } else { out }`      3.89 -> 4.45   1.144x
                //   the same as a `macro_rules!`, expanded inline     3.99 -> 4.41   1.105x
                //   const INWARD + masks as generic params           3.91 -> 4.35   1.113x
                //   const INWARD + masks as `&dyn Fn`                3.93 -> 4.13   1.051x
                //   ... plus `#[inline(always)]`  <-- KEPT            3.96 -> 4.11   1.038x
                //
                // TWO MECHANISM STORIES WERE REFUTED ON THE WAY, which is why the numbers are
                // here instead of a tidy explanation:
                //
                //   1. "the closure is opaque to the inliner, so `store.out` stopped being an
                //      inlined slice access." Expanding the identical code through a macro
                //      changed essentially nothing (1.105x), so no.
                //   2. "`&dyn Fn` masks are a virtual call per edge, so generic parameters will
                //      reach parity." They were WORSE than the `&dyn` version (1.113x against
                //      1.051x), so no — and the `&dyn` shape is kept against the obvious reading
                //      of the code because of it.
                //
                // The residual ~4% has NO identified mechanism. It sits inside the band
                // [[pull-alignment-is-load-bearing]] records for `exec::pull` ("any edit costs
                // the filtered-count cluster 1.08-1.24x, never gains; that's the toll"), so the
                // honest description is that this engine's hot loops charge for being edited and
                // 1.04x is the cheapest shape found, not that the cost was explained away.
                //
                // NOT TRIED: duplicating the whole body so the OUT arm is literally untouched
                // source in untouched position. That is the only shape that could plausibly reach
                // 1.000x, and it means two copies of the trail correction and the zero-length
                // term — arithmetic subtle enough that items 64, 570, 572 and 575 each needed
                // their own mutation run. A 4% toll on a 4ms query is the cheaper risk.
                //
                // A `const INWARD: bool` leaves no runtime test in the loop: each monomorphization
                // const-folds `if INWARD` away, so the OUT instantiation compiles from the code it
                // compiled from before 586 and the IN one is its mirror.
                let args = DegreeArgs {
                    store,
                    src,
                    want,
                    min,
                    max,
                    is_trail,
                    nc,
                    plain,
                };
                // `max <= 2` keeps the closed form it has always used, UNTOUCHED. Only depth 3+
                // takes the level recurrence, so no query that worked before changes code path —
                // item 586 measured this engine's hot loops charging ~4% for being edited at all,
                // and these are two different algorithms rather than two spellings of one.
                let counted = if max <= 2 {
                    Some(if inward {
                        degree_algebra_total::<true>(args, &passes, &body_fn, &trav_fn, &seed_fn)
                    } else {
                        degree_algebra_total::<false>(args, &passes, &body_fn, &trav_fn, &seed_fn)
                    })
                } else if inward {
                    walk_levels_total::<true>(args, &passes, &body_fn, &trav_fn, &seed_fn)
                } else {
                    walk_levels_total::<false>(args, &passes, &body_fn, &trav_fn, &seed_fn)
                };

                match counted {
                    Some(n) => return Some(n),
                    // The level counts OVERFLOWED u64, so there is no answer to return. Falling
                    // through to enumeration is the honest outcome: it refuses on the resource cap
                    // rather than handing back a wrapped number.
                    None => break 'algebra,
                }
            }
        }
    }

    None
}

/// `count(*)` over a bounded WALK of ANY depth, counted by LEVELS (item 587).
///
/// `u[v]` is the number of admissible walks of the current length starting at `v`:
///
///   u_0(v) = 1 if the endpoint test passes v, else 0
///   u_j(v) = sum over admissible traversals v -> y of u_{j-1}(y)
///
/// so the answer is `sum over sources s, over j in min..=max, of u_j(s)` — one pass over the graph
/// per level, O(max * (V + E)) instead of O(paths).
///
/// The three masks sit exactly where they sit in the closed form, and that placement IS the
/// correctness argument: the ENDPOINT test folds into `u_0` because a walk's endpoint is where it
/// stops; the BODY filter and the TRAVERSAL mask gate each step, because they apply at every
/// landing and every traversal; `seed_fn` gates the SOURCE where its contribution is collected.
/// Specialize this to max = 2 by hand and it is `degree_algebra_total` term for term — `u_1(s)` is
/// the filtered out-degree and `u_2(s)` the sum of neighbours' filtered out-degrees.
///
/// WALK ONLY. A trail forbids reusing an edge, which is not a function of the current level: `u_j`
/// would have to know which edges the walk already used, making the vector one over walks rather
/// than over vertices.
#[inline(always)]
fn walk_levels_total<const INWARD: bool>(
    args: DegreeArgs<'_>,
    passes: &dyn Fn(u32) -> bool,
    body_fn: &dyn Fn(u32) -> bool,
    trav_fn: &dyn Fn(u32) -> bool,
    seed_fn: &dyn Fn(u32) -> bool,
) -> Option<u64> {
    // `plain` is deliberately unused: it says a degree is a slice LENGTH, which holds at level 1
    // only — `u_1(v)` is `adj.len()` when nothing filters, but `u_2(v)` is a sum of neighbours'
    // counts and no length can stand in for it.
    let DegreeArgs {
        store,
        src,
        want,
        min,
        max,
        is_trail,
        nc,
        plain: _,
    } = args;

    // A TRAIL is admitted only at EXACTLY depth 3, where `reused_trails_at_3` corrects the
    // recurrence. Every other depth must be a walk — the recurrence alone counts walks.
    debug_assert!(
        !is_trail || max == 3 || max == 4,
        "the level recurrence counts WALKS; a trail is corrected only at depths 3 and 4"
    );
    let trail3 = is_trail && max == 3;
    // Depth 4 (item 693) reuses every depth-3 table and adds three of its own. Gated so no
    // shallower depth pays for them.
    let trail4 = is_trail && max == 4;
    let trail_corr = trail3 || trail4;

    let adj = |v: u32| if INWARD { store.inc(v) } else { store.out(v) };
    let mut u: Vec<u64> = (0..nc as u32).map(|v| u64::from(passes(v))).collect();
    let mut next = vec![0u64; nc];
    let mut total: u64 = 0;
    // THE TRAIL CORRECTION'S PRECOMPUTED FACTORS (item 602). `pass` is `u_0` — the endpoint mask
    // as 0/1 — captured before the level loop overwrites `u`. `self_loops[v]` counts the WANTED,
    // traversable `v -> v` edges and `pass_deg[v]` is the PASSING out-degree, both built with the
    // same three mask tests the level loop uses so a correction can never count an edge the walk
    // would not have traversed.
    let tables = if trail_corr {
        let pass: Vec<u64> = u.clone();
        let mut self_loops = vec![0u64; nc];
        let mut pass_deg = vec![0u64; nc];

        for v in 0..nc {
            for a in adj(v as u32) {
                if edge_carries_wanted(store, a, want) && body_fn(a.nbr) && trav_fn(a.eid) {
                    if a.nbr as usize == v {
                        self_loops[v] += 1;
                    }

                    pass_deg[v] += pass[a.nbr as usize];
                }
            }
        }

        Trail3Tables {
            pass,
            self_loops,
            pass_deg,
        }
    } else {
        Trail3Tables {
            pass: Vec::new(),
            self_loops: Vec::new(),
            pass_deg: Vec::new(),
        }
    };

    // The ZERO-LENGTH path, whose endpoint is the SOURCE — one row per source row, and NOT gated
    // by `seed_fn`, which has no repetition to run for. The closed form's subtlety, unchanged.
    if min == 0 {
        // The same sentinel guard. A zero-length path's endpoint is the SOURCE, so a null source
        // would have the endpoint mask asked about a node that does not exist; enumeration
        // evaluates that predicate on NULL and keeps no row, which is what excluding it gives.
        total = src
            .iter()
            .filter(|&&s| (s as usize) < nc && passes(s))
            .count() as u64;
    }

    // DEPTH 4's extra state (item 693), built only when `trail4`.
    //
    // `pairs` is the ordered-pair edge multiplicity m(u,v) in ONE pass over the adjacency — the
    // "auxiliary O(E) structure" item 600b named and declined to assume. With it depth 4's
    // expensive term costs Σ_b in(b)·out(b) = the TWO-walk count in lookups, where probing the
    // adjacency for the same number costs the THREE-walk count (686 priced the probing version at
    // ~78x; 689 measured the map version at 197x on a prototype).
    let pairs: Option<std::collections::HashMap<u64, u32>> = if trail4 {
        let mut m = std::collections::HashMap::with_capacity(store.edge_count());

        for v in 0..nc {
            for a in adj(v as u32) {
                if edge_carries_wanted(store, a, want) {
                    *m.entry((v as u64) << 32 | u64::from(a.nbr)).or_insert(0) += 1;
                }
            }
        }

        Some(m)
    } else {
        None
    };
    let mult = |x: u32, y: u32| -> u64 {
        pairs
            .as_ref()
            .and_then(|m| m.get(&(u64::from(x) << 32 | u64::from(y))))
            .map_or(0, |&c| u64::from(c))
    };
    // `u` is swapped per level, so without these the depth-4 terms would read a vector that has
    // already been overwritten.
    let mut walk2: Vec<u64> = Vec::new();
    let mut t3: Vec<u64> = Vec::new();

    for len in 1..=max {
        for (v, slot) in next.iter_mut().enumerate() {
            let mut acc: u64 = 0;

            for a in adj(v as u32) {
                if edge_carries_wanted(store, a, want) && body_fn(a.nbr) && trav_fn(a.eid) {
                    // CHECKED, because this is the one route whose counts can genuinely exceed
                    // u64: an unbounded `repeat()` caps at 100 levels, and a degree-3 graph passes
                    // 1.8e19 somewhere around level 40. `None` falls back to enumeration, which
                    // refuses on the resource cap instead of returning a wrapped number.
                    acc = acc.checked_add(u[a.nbr as usize])?;
                }
            }

            *slot = acc;
        }

        std::mem::swap(&mut u, &mut next);

        // OUTSIDE the `len >= min` gate on purpose: the recurrence runs at every level whatever
        // `min` is, and `{4,4}` needs the level-2 and level-3 vectors even though neither is
        // emitted. `t3` is built at level 3 — where `u` still holds walk_3 — with
        // `reused_trails_at_3` called once per VERTEX rather than once per edge, since the identity
        // needs it at every landing and a landing is reached by `in(b)` different edges.
        if trail4 {
            if len == 2 {
                walk2 = u.clone();
            } else if len == 3 {
                t3 = (0..nc)
                    .map(|v| {
                        let bad = reused_trails_at_3::<INWARD>(
                            v as u32, store, want, &tables, body_fn, trav_fn,
                        );

                        u[v].saturating_sub(bad)
                    })
                    .collect();
            }
        }

        if len >= min {
            for &s in src {
                // A NULL SOURCE is the `u32::MAX` sentinel a Nodes column uses for a null node,
                // and it reaches here: the optimizer fuzzer found it at 200,000 seeds — a plan
                // whose source slot holds one — by panicking on this index. A null node has no
                // adjacency, so it contributes no hop paths at any level. The bounds test comes
                // BEFORE `seed_fn`, which would index its own mask with the same sentinel.
                let Some(&walks) = u.get(s as usize) else {
                    continue;
                };

                if seed_fn(s) {
                    total = total.checked_add(walks)?;
                }
            }

            if trail_corr {
                // LEVEL 2's correction is the one the `max <= 2` closed form already applies: the
                // single path that reuses a self-loop, `s -> s -> s`, and only when the endpoint
                // passes. Level 1 needs none — one edge cannot repeat. Level 3 is the four-term
                // form. A correction applied once for the whole RANGE rather than per level
                // answers `{3,3}` correctly and `{1,3}` wrongly.
                for &s in src {
                    if (s as usize) >= nc || !seed_fn(s) {
                        continue;
                    }

                    let v = s as usize;
                    let bad = match len {
                        2 => tables.self_loops[v] * tables.pass[v],
                        3 => {
                            reused_trails_at_3::<INWARD>(s, store, want, &tables, body_fn, trav_fn)
                        }
                        // LEVEL 4 (item 693): `walk4(s) − T4(s)`, by the identity items 687/689
                        // derived and validated and item 692 shipped in TS.
                        4 => u[v].saturating_sub(trails_at_4_from::<INWARD>(
                            s,
                            &Trail4Ctx {
                                store,
                                want,
                                t: &tables,
                                walk2: &walk2,
                                t3: &t3,
                                mult: &mult,
                            },
                        )),
                        _ => 0,
                    };

                    total = total.checked_sub(bad)?;
                }
            }
        }
    }

    Some(total)
}

/// The depth-3 trail correction's precomputed tables — bundled for the same reason
/// [`DegreeArgs`] is: clippy caps a function at seven arguments and the alternative is positional
/// soup. All three are indexed by node id and built with the SAME mask tests the level loop uses,
/// so a correction can never count an edge the walk would not have traversed.
struct Trail3Tables {
    /// `u_0` — the endpoint mask as 0/1, captured before the level loop overwrites `u`.
    pass: Vec<u64>,
    /// Wanted, traversable `v -> v` edges at each node.
    self_loops: Vec<u64>,
    /// The PASSING out-degree: wanted, traversable edges whose target passes the endpoint test.
    pass_deg: Vec<u64>,
}

/// Everything depth 4 needs beyond [`Trail3Tables`] — bundled for the same reason that struct and
/// [`DegreeArgs`] are: clippy caps a function at seven arguments and the alternative is positional
/// soup (item 693).
struct Trail4Ctx<'a> {
    store: &'a Store,
    want: &'a [u32],
    t: &'a Trail3Tables,
    /// `walk_2(v)`, snapshotted before the level loop overwrote it.
    walk2: &'a [u64],
    /// `t3(v) = walk_3(v) − reused_trails_at_3(v)`, the per-source depth-3 count.
    t3: &'a [u64],
    /// `m(u,v)` — the ordered-pair edge multiplicity, O(1) off an O(E) map.
    mult: &'a dyn Fn(u32, u32) -> u64,
}

/// The walks of length 3 from `v` that REUSE an edge — subtracted from `u_3(v)` to turn a walk
/// count into a trail count (item 602, the native twin of `shortcuts.ts`'s `reusedTrailsAt3`).
///
/// At depth 3 the walks a trail forbids are exactly those where two of `e0, e1, e2` coincide:
///
///   `e0 == e1` forces `a == b == c`, a SELF-LOOP at the source, then any passing edge out of it
///   `e1 == e2` is its mirror: an edge out, then a self-loop at the landing taken twice
///   `e0 == e2` forces `a == c` and `b == d` — the 2-cycle `a -> b -> a` reusing the first edge
///   all three equal is a self-loop used three times, removed by each term above, so it returns
///   with coefficient 2
///
/// Each endpoint test applies at the walk's LAST node, which is why the terms carry different
/// `pass` factors: `e0 == e1` ends at the third edge's target (hence the PASSING out-degree),
/// `e1 == e2` and `e0 == e2` end at the landing `b`, and the triple case ends back at the source.
///
/// COST. The first two terms are O(1) per source off the precomputed tables. The `e0 == e2` term
/// is not: it needs the multiplicity of an ORDERED PAIR and this adjacency is in edge-insertion
/// order (`rebuild_csr` does `extend_from_slice`, no sort), so it probes the landing's segment and
/// costs the TWO-WALK count. That is a factor of the average degree below enumerating three-walks,
/// which is the win — item 600b corrects an earlier claim that it was O(V + E).
#[inline(always)]
/// `u3(b, a)` — the 3-trails STARTING AT `b` that USE a given edge `a -> b` (item 693).
///
/// A trail uses each edge at most once, so that edge sits in exactly ONE of the three positions.
/// The cases are therefore DISJOINT and simply add, which is what replaces inclusion-exclusion over
/// depth 4's six equality events and its 63 intersections — item 600 declined to derive those and
/// item 687 sidestepped them. Validated 600/600 against brute force with 8/8 mutants (689).
///
/// EDGE-IDENTITY-FREE, which is what makes it implementable over an adjacency that is a flat list
/// of `Adj`: an `f != e0` test would need to know WHICH slot `e0` is, and every such exclusion
/// instead reduces to a ±1 correction keyed on whether the edge LEAVES `b` — i.e. on `a == b`.
///
/// Derived for a TRIVIAL mask, which is why `try_degree_algebra` admits depth 4 only when every
/// predicate is absent.
fn used_trails_at_3<const INWARD: bool>(b: u32, a: u32, x: &Trail4Ctx<'_>) -> u64 {
    let Trail4Ctx {
        store,
        want,
        t,
        walk2,
        mult,
        ..
    } = x;
    let adj = |n: u32| if INWARD { store.inc(n) } else { store.out(n) };
    let bi = b as usize;
    // i64 THROUGHOUT, not u64 with saturating subtraction. The terms are only non-negative in
    // TOTAL — `(L-1)` and `(od-2)` are each fine where they are reached, but `walk2 - L·od` is not
    // guaranteed to be — and `saturating_sub` would silently clamp a negative intermediate to zero,
    // turning a sign error into a plausible wrong answer rather than a visible one. The final value
    // is a count, so it is non-negative by construction and the cast back is checked.
    let loops = t.self_loops[bi] as i64;
    let od = adj(b)
        .iter()
        .filter(|x| edge_carries_wanted(store, x, want))
        .count() as i64;
    let mut total: i64 = 0;
    let mut acc: i64 = 0;

    if a == b {
        // The edge is a SELF-LOOP at `b`, so it leaves `b` and competes with f1 and f2.
        //   f0 = e0: e0, then a 2-trail from b avoiding e0
        //   f1 = e0: a self-loop f0 != e0, then e0, then f2 not in {f0, e0}
        total += walk2[bi] as i64 - loops * od + (loops - 1) * (od - 2);
        total += (loops - 1) * (od - 2);

        // f2 = e0: a 2-trail b->c->b, then e0. The one f0 that IS e0 is removed AFTER the sum
        // rather than skipped inside it — that is what keeps this free of edge identities.
        for x in adj(b) {
            if !edge_carries_wanted(store, x, want) {
                continue;
            }

            acc += if x.nbr == b {
                loops - 2
            } else {
                mult(x.nbr, b) as i64
            };
        }

        total += acc - (loops - 2);
    } else {
        // The edge does not leave `b`, so it can be neither f0 nor f2 and only the landings matter.
        total += mult(b, a) as i64 * (od - 1);

        for x in adj(b) {
            if edge_carries_wanted(store, x, want) {
                acc += mult(x.nbr, a) as i64;
            }
        }

        total += acc;
    }

    debug_assert!(total >= 0, "u3({b}, {a}) went negative: {total}");

    u64::try_from(total).unwrap_or(0)
}

/// `T4(s)` — the 4-trails starting at `s`, as `Σ_{e0: s->b} [ t3(b) - u3(b, s) ]` (item 693).
fn trails_at_4_from<const INWARD: bool>(s: u32, x: &Trail4Ctx<'_>) -> u64 {
    let Trail4Ctx {
        store, want, t3, ..
    } = x;
    let adj = |n: u32| if INWARD { store.inc(n) } else { store.out(n) };
    let mut total: u64 = 0;

    for a in adj(s) {
        if !edge_carries_wanted(store, a, want) {
            continue;
        }

        let b = a.nbr;
        let used = used_trails_at_3::<INWARD>(b, s, x);

        total += t3[b as usize].saturating_sub(used);
    }

    total
}

fn reused_trails_at_3<const INWARD: bool>(
    v: u32,
    store: &Store,
    want: &[u32],
    t: &Trail3Tables,
    body_fn: &dyn Fn(u32) -> bool,
    trav_fn: &dyn Fn(u32) -> bool,
) -> u64 {
    let Trail3Tables {
        pass,
        self_loops,
        pass_deg,
    } = t;
    let adj = |n: u32| if INWARD { store.inc(n) } else { store.out(n) };
    let vi = v as usize;
    // e0 == e1: a self-loop at `v`, then any passing edge out of `v`.
    let mut bad = self_loops[vi] * pass_deg[vi];

    for a in adj(v) {
        if !(edge_carries_wanted(store, a, want) && body_fn(a.nbr) && trav_fn(a.eid)) {
            continue;
        }

        let b = a.nbr as usize;

        if pass[b] == 0 {
            continue; // both remaining cases end at `b`
        }

        // e1 == e2: a self-loop at the landing, taken twice.
        bad += self_loops[b];

        // e0 == e2: an edge back from `b` to `v`, then THIS edge again. COUNTED, not a boolean —
        // two parallel `v -> b` edges make `e0, b -> v, e2` a valid trail when `e0 != e2`, so
        // there is one bad walk per reverse edge and "does a reverse edge exist" is the wrong
        // question.
        for back in adj(a.nbr) {
            if back.nbr == v
                && edge_carries_wanted(store, back, want)
                && body_fn(back.nbr)
                && trav_fn(back.eid)
            {
                bad += 1;
            }
        }
    }

    // All three equal: a self-loop at `v` used three times, ending back at `v`. Each of the three
    // terms above removed it once, so it comes back twice.
    bad - 2 * self_loops[vi] * pass[vi]
}

/// Everything `degree_algebra_total` needs that is not a predicate — bundled because the
/// alternative is twelve positional parameters, the same reason `DegreeCountSpec` exists on the
/// TypeScript side.
struct DegreeArgs<'a> {
    store: &'a Store,
    src: &'a [u32],
    want: &'a [u32],
    min: u32,
    max: u32,
    is_trail: bool,
    nc: usize,
    /// No wanted type and no mask, so a degree is a slice LENGTH rather than a filtered walk.
    plain: bool,
}

/// The degree algebra's two hot loops, specialized on direction (item 586).
///
/// `INWARD` is a const parameter and not a value so that `if INWARD` const-folds: the OUT
/// instantiation compiles from the same source the pre-586 code did, which is the only shape of
/// this that did not cost the OUT path ~1.1x. See the call site for the two that did.
///
/// The four masks arrive as `&dyn Fn`, which looks like the wrong choice and MEASURED as the right
/// one. Each is read once per edge, so dynamic dispatch there is a virtual call in the hot loop;
/// making them generic parameters — which monomorphizes exactly twice, since the four closures are
/// concrete types fixed at the one call site — was tried and is WORSE. See the call site for all
/// five shapes and their numbers.
#[inline(always)]
fn degree_algebra_total<const INWARD: bool>(
    args: DegreeArgs<'_>,
    passes: &dyn Fn(u32) -> bool,
    body_fn: &dyn Fn(u32) -> bool,
    trav_fn: &dyn Fn(u32) -> bool,
    seed_fn: &dyn Fn(u32) -> bool,
) -> u64 {
    let DegreeArgs {
        store,
        src,
        want,
        min,
        max,
        is_trail,
        nc,
        plain,
    } = args;
    let adj = |v: u32| if INWARD { store.inc(v) } else { store.out(v) };
    let mut outdeg = vec![0u64; nc];

    for (v, d) in outdeg.iter_mut().enumerate() {
        let adj = adj(v as u32);
        // The O(1) read stays for the common case; a wanted-type or predicate filter is what
        // forces the walk over the adjacency.
        *d = if plain {
            adj.len() as u64
        } else {
            adj.iter()
                .filter(|a| {
                    edge_carries_wanted(store, a, want)
                        && passes(a.nbr)
                        && body_fn(a.nbr)
                        && trav_fn(a.eid)
                })
                .count() as u64
        };
    }

    let mut total: u64 = 0;

    // A ZERO-LENGTH path: `{0,n}` emits the source itself as an endpoint, one row per source row,
    // and the degree algebra counted only paths that traverse an edge (item 64). Its endpoint is
    // the SOURCE, so an endpoint predicate applies to that. NOT gated by `seed_fn`, and that is
    // the whole subtlety. A zero-length path has NO REPETITIONS, so a per-repetition predicate
    // never runs for it and the row is emitted whatever the predicate says. Measured on a 4-node
    // ring where `a.age > 25` admits two of four sources:
    //
    //   -[e:T WHERE a.age > 25]->{0,2}(y)   8 = 4 filtered hop paths + 4 zero-length
    //   -[e:T WHERE a.age > 25]->{0,0}(y)   4, the predicate irrelevant
    //
    // Gating this term too would answer 6 and 2. Both engines agree on 8 and 4.
    if min == 0 {
        total += src.iter().filter(|&&s| passes(s)).count() as u64;
    }

    for &s in src {
        if !seed_fn(s) {
            continue; // every repetition from this source fails the predicate
        }

        for a in adj(s) {
            if !edge_carries_wanted(store, a, want) {
                continue;
            }

            if min <= 1 && passes(a.nbr) && body_fn(a.nbr) && trav_fn(a.eid) {
                total += 1; // the 1-hop path s -> a.nbr
            }

            // The body filter PRUNES, so a failing `a.nbr` kills the 2-hop paths through it as
            // well as the 1-hop path to it.
            if max >= 2 && body_fn(a.nbr) && trav_fn(a.eid) {
                // 2-hop paths s -> a.nbr -> z
                total += outdeg[a.nbr as usize];

                // A trail excludes the one path that reuses this edge, `s -> s -> s`, which
                // `outdeg[s]` counted — and only if that endpoint passes. No `body(s)` term: this
                // arm is already inside `body(a.nbr)` and `a.nbr == s`, so the body mask is known
                // true here. It was written with one, and mutation showed the condition
                // UNKILLABLE — provably dead rather than untested, so it is gone instead of
                // pinned.
                if is_trail && a.nbr == s && passes(s) {
                    total -= 1;
                }
            }
        }
    }

    total
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
    let agg = sole_agg(keys, aggs)?;
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
            // ITEM 572: the per-repetition predicate folds into the DEGREE ALGEBRA as a
            // TRAVERSAL mask, when it is a function of one traversal. At `k = 1` the mini-scope
            // `rep_pred_ok` builds is node `2p` / edge `2p+1`, so slots 0, 1 and 2 are the rep's
            // source, edge and target — all three fixed by an edge id under `Dir::Out`. `max_slot
            // <= 2` is therefore the test, and it admits any conjunction of the three, which is
            // what item 570's node-only `body_filter` route could NOT do:
            //
            //   WHERE y.age > 50            37.29ms -> 2.00  (570, via body_filter)
            //   WHERE e.w > 5               37.29        the EDGE, no node mask expresses it
            //   WHERE x.age > 50            32.61        the rep SOURCE
            //   WHERE y.age > 50 AND e.w>5  43.81        does not factor into two masks at all
            //
            // Slot `2k+1` is the PATH SOURCE, which varies per path rather than per edge, so
            // `max_slot <= 2` is what excludes it. A subquery is excluded outright: `max_slot`
            // already reports `outer_width - 1` for one, but relying on that is fragile, and a
            // correlated subquery run once per EDGE IN THE STORE would cost more than the
            // enumeration this is replacing.
            //
            // `k > 1` is not a traversal question at all — a multi-hop unit's predicate reads
            // several edges — so it keeps the walk.
            // A `k = 1` per-repetition predicate splits by WHICH SLOT it reads, and the two
            // cases fold into the algebra at different places:
            //
            //   slots 0..=2  the rep's source, edge and target — ONE TRAVERSAL, so an
            //                edge-indexed mask (item 572).
            //   slot 3       the PATH SOURCE (`2k+1`), constant along a path, so a filter on
            //                the source ROW (item 575). `query_bench` priced this at
            //                304,725us against the traversal case's 7,978 — 38x — because it
            //                was the one position still enumerating.
            //
            // A predicate reading BOTH would need the conjunction split into the two positions;
            // `refs_only_slot` admits neither then, and it stays on the walk.
            // No `*k == 1` here: the branch below already requires it, so a second test is
            // UNKILLABLE — its mutant survived the whole suite. Dead rather than untested, so
            // it is gone, exactly as item 570's `body(s)` term was.
            let eligible = per_rep_pred
                .as_deref()
                .filter(|p| !crate::exec::contains_subquery(p));
            let trav = eligible.filter(|p| crate::opt::max_slot(p).is_none_or(|m| m <= 2));
            let seed = eligible.filter(|p| crate::exec::fastpath::refs_only_slot(p, 3));

            // `k == 1` gates the WHOLE route, not just the mask. A multi-hop unit emits only
            // at rep BOUNDARIES, so its equivalent hop bounds are `min * k ..= max * k` and this
            // algebra's `max <= 2` arithmetic counts the wrong thing — `opt`'s flatten refuses
            // `k > 1` for exactly that reason. Gating only `trav` on it let a k=2 group with NO
            // predicate through, and `a_two_hop_group_count_agrees_with_its_rows_for_an_unknown_edge_type`
            // caught it immediately.
            if *k == 1 && (per_rep_pred.is_none() || trav.is_some() || seed.is_some()) {
                if let Col::Nodes(ids) = batch.slot(*from) {
                    let want = match want_etypes(store, edge_label) {
                        Ok(w) => w,
                        Err(()) => vec![u32::MAX],
                    };

                    if let Some(n) = try_degree_algebra(
                        store, ids, &want, *min, *max, *mode, *dir, endpoint, None, trav, seed,
                    ) {
                        return Some(scalar_num(n as f64));
                    }
                }
            }

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
    let agg = sole_agg(keys, aggs)?;
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
    // The ALGEBRAIC count, extracted at item 572 and shared with the quantified-GROUP count.
    if let Some(n) = try_degree_algebra(
        store,
        src,
        &want,
        *min,
        *max,
        *mode,
        *dir,
        endpoint,
        body_filter.as_deref().map(|p| (p, batch.slots.len())),
        None,
        None,
    ) {
        return Some(scalar_num(n as f64));
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
/// DISTINCT endpoint set is the nodes ENCOUNTERED at any hop in `min..=max` from the source set.
/// Note "encountered", not "at shortest distance": the `min <= 1` arm marks `reached` on every
/// neighbour it sees and uses `visited` only to gate RE-EXPANSION, and the `min >= 2` arm walks
/// level sets. Both therefore admit a node arrived at by a longer walk than its shortest path,
/// which is what WALK semantics require. The count is a set size, so it is byte-identical to the
/// TS engine's regardless of visitation order.
///
/// 🛑 THIS IS WALK REACHABILITY, AND IT DOES NOT COINCIDE WITH A TRAIL'S AT `min <= 1` — an
/// earlier version of this comment argued that it did, and item 757 measured the counterexample.
/// Two nodes, one edge, `(x:S)-[:R]-{1,3}(y)`:
///
/// | spelling        | distinct endpoints | rows |
/// | --------------- | -----------------: | ---: |
/// | `MATCH WALK`     |              **2** |    3 |
/// | default (TRAIL)  |              **1** |    1 |
///
/// A WALK returns to `x` by re-crossing the single edge; a TRAIL cannot, so `x` is a walk endpoint
/// and not a trail one. The old argument — "the shortest path is simple, so it is a trail" — holds
/// only when that shortest path has length `>= min`, and for a SOURCE on a cycle it has length 0.
/// So `max <= 1` is the trail region, NOT `min <= 1`: at one hop no edge can be reused and the two
/// semantics coincide, which the same fixture confirms (both answer 1 at `{1,1}`).
///
/// Pinned by `a_trail_distinct_endpoint_count_is_not_the_walks_at_min_one`, because the attractive
/// widening is a wrong ANSWER and only a test can refuse it.
pub(super) fn try_varlen_distinct_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
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
    if !set_reachability_is_exact(*mode, *min, *max) {
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
    let agg = sole_agg(keys, aggs)?;
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
            // See the note on `set_reachability_is_exact`: a TRAIL is safe here at one hop, or
            // with an OPEN upper bound and `min <= 1` (item 1256).
            if until.is_some()
                || body_filter.is_some()
                || !set_reachability_is_exact(*mode, *min, *max)
            {
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
/// `Walk` at any bound. `Simple` and `Acyclic` forbid node reuse, which a BFS frontier permits, so
/// they never qualify — and `Acyclic` is not merely unproven there: one node with one self-loop
/// answers 0 for `ACYCLIC (x)-[:R]->+(y)` (the loop repeats a node) where a BFS says 1.
///
/// ⚠️ A TRAIL IS ALSO EXACT WHEN THE UPPER BOUND IS OPEN AND `min <= 1` (item 1256), which the
/// previous `max <= 1` refused. The reasoning that produced `max <= 1` is right about edge reuse
/// but priced only the BOUNDED case: with at most one hop no edge can repeat, and above that "the
/// walk set can strictly contain the trail set" — true when a LENGTH constraint is in play.
///
/// With no upper bound and `min <= 1` there is no length constraint left to violate, and the two
/// sets COINCIDE: take any walk from `x` to `y`, delete its cycles, and what remains is a path
/// visiting each node at most once — so it reuses no edge, and it is a trail of length >= 1 >= min.
/// Hence walk-reachable implies trail-reachable, and the converse is immediate.
///
/// `min >= 2` stays refused, and the counterexample is the same self-loop: `a -> a -> a` is a
/// 2-hop WALK, while a 2-hop trail would need two distinct edges, so the trail answer is 0 and the
/// BFS says 1. That is the shape the TS engine got WRONG until item 1252, which is why the bound is
/// spelled out here rather than left to the caller.
///
/// WHAT THIS IS WORTH: `MATCH (x)-[:R]->*(y) RETURN count(DISTINCT y)` over 400 nodes / 2,000 edges
/// THREW `E_RESOURCE_EXHAUSTED` before this — the pattern fell to enumeration and exhausted the
/// trail budget — where the TS engine answered 400 from its own BFS. So this is an
/// answer-instead-of-an-error, and it CLOSES that cross-engine divergence (item 1255's parity
/// table).
pub(super) fn set_reachability_is_exact(mode: PathMode, min: u32, max: u32) -> bool {
    match mode {
        PathMode::Walk => true,
        // SIMPLE shares TRAIL's condition (item 1257). It forbids NODE reuse where a trail
        // forbids EDGE reuse, but the cycle-removal argument is the same and lands on the same
        // place: strip the cycles from any walk and what remains visits each node at most once,
        // which is a SIMPLE path. The closed case resolves too — a closed walk decomposes into
        // simple cycles, at least one through the source — so reaching the source itself at
        // `min = 1` agrees as well. Checked against a bounded oracle on nine shapes (self-loop,
        // 2-cycle, 3-cycle, chain, chain+back-edge, lollipop, two joined cycles, in-tree,
        // diamond) at both `->*` and `->+`: 18 of 18 agreed.
        PathMode::Trail | PathMode::Simple => max <= 1 || (max == u32::MAX && min <= 1),
        // ⚠️ ACYCLIC ALONE STAYS REFUSED, and it is the one that genuinely diverges: it forbids
        // first = last, so one node with one self-loop answers 0 for `ACYCLIC (x)-[:R]->+(y)`
        // where every other mode — and a BFS — answers 1.
        PathMode::Acyclic => false,
    }
}

/// How many levels the `min >= 2` frontier walk must run — `max`, or `min + n` when `max` is open.
///
/// ⚠️ ITS OWN FUNCTION SO THE ARITHMETIC CAN BE TESTED, because reverting the cap is
/// ANSWER-EQUIVALENT: it only makes the query slower, and no result assertion can see that. Item
/// 1253 is why this is not a timing test instead — a verdict that depends on how fast the machine
/// runs is not a verdict. This is the "extract the decision and unit-test it" pattern the repo
/// already uses for route choices no output reveals.
///
/// See the call site for the proof that `min + n` loses nothing.
pub(super) fn level_cap(min: u32, max: u32, nodes: usize) -> u32 {
    max.min(min.saturating_add(u32::try_from(nodes).unwrap_or(u32::MAX)))
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
        // ⚠️ THE LEVEL COUNT IS CAPPED AT `min + n`, AND WITHOUT IT AN UNBOUNDED PATTERN SPINS
        // (item 1258). The loop's only exit was an EMPTY frontier, which on a cyclic graph never
        // happens — so `max = u32::MAX` meant 4.29 BILLION levels. Measured on one node with one
        // self-loop: `MATCH WALK (x)-[:R]->{2,}(y) RETURN count(DISTINCT y)` took **29,253 ms**,
        // against 0 ms for the bounded `{2,9}` and for `->*`. The answer was right; the cost was
        // four billion iterations over a one-edge graph.
        //
        // WHY `min + n` IS EXACT, not a heuristic: if `y` has a walk of length `h >= min`, take
        // the SHORTEST such walk. Suppose `h > min + n`. A walk with more than `n - 1` edges must
        // repeat a node, so it contains a cycle of length `c <= n`; excising that cycle leaves a
        // walk of length `h - c > min`, which is still `>= min` and shorter — contradicting
        // minimality. So the smallest qualifying length is at most `min + n`, and unioning the
        // level-sets past that can add no node the union does not already hold.
        //
        // A BOUNDED pattern is untouched: `max` is smaller than the cap whenever it is real.
        let cap = level_cap(min, max, n);
        for hop in 1..=cap {
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
    let agg = sole_agg(keys, aggs)?;
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
    let agg = sole_agg(keys, aggs)?;
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None; // count(*) only
    }
    // SEE THROUGH a row-preserving projection — item 1135.
    //
    // Gremlin's `values('k')` lowers to a present-filter plus a `Project` of the value, and
    // `count()` wraps a keyless `count(*)`, so the filter this entry needs is one level too
    // deep and the whole shape fell to the general aggregate. A `count(*)` reads no column,
    // so skipping the projection cannot change the answer — PROVIDED no projected item can
    // fault, or a plan that used to raise would start returning a number.
    //
    // The admission set is `Prop`/`Slot` ONLY, which is exactly what `values('k')` emits and
    // is total by construction (a missing property reads NULL, it does not raise). This is
    // deliberately narrower than opt's `can_raise`: that predicate lives in another module and
    // reasoning about an arbitrary expression's totality is a much bigger claim than this entry
    // needs. Anything else declines and keeps the general path.
    //
    // Item 1133 removed this projection in the OPTIMIZER instead and measured 1.12x SLOWER
    // across three alternated rounds — the projection narrows the batch to one column before
    // the aggregate, so dropping it without also reaching this fast path just moves the plan
    // from one slow form to another. Seeing through it HERE gains the fastpath and leaves the
    // plan alone, which is the combination item 1134 priced at 33.57x.
    let input = match input {
        Plan::Project {
            input: inner,
            items,
        } if items
            .iter()
            .all(|(_, e)| matches!(e, Expr::Prop { .. } | Expr::Slot(_))) =>
        {
            &**inner
        }
        other => other,
    };
    // Only worth the frontier fold when a plain filter/hop chain would otherwise
    // materialize — i.e. there IS a frontier filter (the bare-chain counts already have
    // their own fast-paths). Require a top-level IsLabeled or PropertyExists filter.
    if !matches!(
        input,
        Plan::Filter {
            pred: Expr::IsLabeled { .. } | Expr::PropertyExists { .. },
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
    let agg = sole_agg(keys, aggs)?;
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
    let col = store.column(key)?;
    // The column gate sits BEFORE `frontier_counts` deliberately: an unserved representation
    // must not pay to build a frontier it then declines. `Column::Gen` is the one that reaches
    // here (a mixed column), and building the frontier first cost it ~6% on the hop `min` row
    // for nothing (item 1182).
    if matches!(col, Column::Gen { .. }) {
        return None; // a mixed column's extremum crosses type ranks → general fold
    }
    let counts = frontier_counts(input, store)?;
    let want_min = agg.func == AggFn::Min;
    // ONE arm per representation, each mirroring its bare-`Scan` twin
    // (`try_scan_num_agg`/`str`/`bool`/`temporal`) so the hop and scan spellings of one
    // question cannot disagree. The frontier is collapsed to DISTINCT nodes, which is what
    // makes this cheaper than the general fold: min/max over a multiset equals min/max over
    // its distinct set, so per-node multiplicity is irrelevant (and is exactly why `sum`/`avg`
    // stay on `try_frontier_aggregate` — see this function's note above).
    let v = match col {
        Column::Num { data, present, .. } => {
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
            best.map_or(Value::Null, Value::Num)
        }
        // The extremum is tracked as an INDEX, not a borrow: `for_each` takes an `FnMut` and a
        // `&GStr` cannot be held across iterations. Same reason `try_scan_str_agg` does it.
        Column::Str { data, present, .. } => {
            let mut best_i: Option<usize> = None;
            counts.for_each(|v, _c| {
                let i = v as usize;
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
            best_i.map_or(Value::Null, |i| Value::Str(data[i].clone()))
        }
        // Two passes, and the second is over `dict.len()` rather than the frontier — the whole
        // point of the dictionary arm. No string is compared per node.
        Column::Dict {
            dict,
            codes,
            present,
            ..
        } => {
            let mut seen = vec![false; dict.len()];
            counts.for_each(|v, _c| {
                let i = v as usize;
                if present[i] {
                    seen[codes[i] as usize] = true;
                }
            });
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
            best_c.map_or(Value::Null, |c| Value::Str(dict[c].clone()))
        }
        // `try_scan_bool_agg`'s SHORT CIRCUIT does not transfer: `Counts::for_each` has no
        // early exit, and the frontier has to be built before any value is read anyway. The
        // win here is the distinct-node collapse, not stopping early.
        Column::Bool { data, present, .. } => {
            let want = !want_min;
            let mut saw_want = false;
            let mut saw_other = false;
            counts.for_each(|v, _c| {
                let i = v as usize;
                if present[i] {
                    if data[i] == want {
                        saw_want = true;
                    } else {
                        saw_other = true;
                    }
                }
            });
            if saw_want {
                Value::Bool(want)
            } else if saw_other {
                Value::Bool(!want)
            } else {
                Value::Null
            }
        }
        Column::Temporal { data, present, .. } => {
            let mut best_i: Option<usize> = None;
            counts.for_each(|v, _c| {
                let i = v as usize;
                if present[i] {
                    best_i = Some(match best_i {
                        None => i,
                        Some(b) => {
                            let ord = data[i].cmp_total(&data[b]);
                            if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                                i
                            } else {
                                b
                            }
                        }
                    });
                }
            });
            best_i.map_or(Value::Null, |i| Value::Temporal(data[i]))
        }
        // DEFENSIVE: the `matches!` above already sent `Gen` to the general fold, so this is
        // unreachable today. It is kept so that a representation added to `Column` later
        // declines here rather than being served by whichever arm its fields happen to fit.
        _ => return None,
    };
    Some(Batch::single(Col::Gen(vec![v])))
}

/// Answer a scalar `count(*)` over a bare labelled/unlabelled `Scan` in O(1) (a
/// label bucket length — buckets hold only live ids) or a single tombstone-bitmap
/// sweep (unlabelled), WITHOUT materializing the id vector. `None` for any other
/// shape (a WHERE seed, an Expand, `count(arg)`), which the other paths handle.
/// The number of type-`T` edges, when `MATCH (a)-[:T]->() RETURN count(*)` can be answered
/// from a size instead of a walk. `None` whenever anything would make that unequal to the
/// path count — a decliner falls back to the general aggregate.
///
/// Every gate here is a way the size and the path count come apart:
///
/// - **`Dir::Out` only.** The flat partition exists for out-edges (`out_typed_flat`); there
///   is no `in_typed_flat` to answer the IN twin, and `Dir::Both` is a different count
///   anyway (an undirected self-loop is traversable twice, which `double_loops` selects —
///   that flag has no effect on a directed hop, so it is deliberately not consulted).
/// - **Exactly ONE edge type.** A `want` list of several types would need a sum, and an edge
///   carrying two of them would be counted twice while the walk counts it once.
/// - **No multi-label edges.** `Adj.etype` holds an edge's PRIMARY type only; a secondary
///   type lives in `edge_extra`. So the partition misses an edge whose secondary type is
///   `T`, and the size would UNDERCOUNT. `for_each_nbr` makes the same choice — with
///   multi-label edges it takes the flat scan plus the secondary-label probe.
/// - **A WHOLE-GRAPH `Scan` source** — unlabelled, or labelled with a label every live vertex
///   carries (item 876). A label that restricts the sources declines; one that does not is the
///   same scan written differently, and `whole_graph_scan` is that test.
/// - **No `bind_edge`, no `DISTINCT`.** Binding the edge adds a slot the count ignores, but
///   `count(DISTINCT *)` is a different question entirely.
/// - **No fresh-overlay requirement any more (item 1118).** This read `out_typed_flat(t)?.len()`,
///   which returns `None` once any adjacency write has invalidated the overlay — so the whole fast
///   path declined for the rest of the session after one `add_edge`, measured at **85x** on this
///   very shape (items 680/851/852, where both automatic repairs were refused). It now reads
///   `live_etype_count(t)`, maintained at every mutation.
///
///   The staleness was also doing CORRECTNESS work, and that argument has to be replaced rather
///   than dropped: a stale partition can contain a DETACHED edge, and declining was what kept a
///   delete from being counted. The maintained count carries that instead — decremented at
///   `delete_edge`, at `delete_node_inner`'s cascade (both the node's own OUT list and its mirrors
///   in neighbours) and at `pop_last_node`, incremented on both `Undo` restore arms — which
///   `the_maintained_etype_counts_match_a_recount_after_every_mutation_kind` pins against a recount
///   from `out_adj` after each of those.
fn typed_hop_count_from_size(input: &Plan, agg: &Agg, store: &Store) -> Option<usize> {
    let Plan::Expand {
        input: src,
        from,
        dir,
        edge_label,
        bind_edge,
        double_loops,
    } = input
    else {
        return None;
    };
    // IN IS THE SAME COUNT AS OUT, and used to be refused — item 1153.
    //
    // Over a WHOLE-GRAPH scan every edge is an out-edge of exactly one source AND an in-edge of
    // exactly one target, so both expansions emit one row per edge and the answer is identical.
    // The gate read `*dir != Dir::Out`, so the mirror spelling took no shortcut at all. Measured
    // at 200,000 nodes / 1,000,000 KNOWS edges, both answering 1,000,000:
    //
    // ```text
    //   MATCH (a:Person)-[:KNOWS]->(x) RETURN count(*)     0.3 us
    //   MATCH (a:Person)<-[:KNOWS]-(x) RETURN count(*)   453.1        1510x
    // ```
    //
    // This is the repo's named bug class — one spelling recognized, an identical-meaning one
    // scanned for — and the answers agreed the whole time, so only a timing row could see it.
    // Item 744 fixed the same asymmetry on the TS side for a QUANTIFIED mirror (47.4x there) and
    // recorded that native's var-length gate already accepted `Dir::Out | Dir::In`; this entry,
    // the plain 1-hop one, was still Out-only.
    //
    // `Dir::Both` is NOT admitted here: it emits a row per edge END, so the answer is
    // `2*|E_t| - loops(t)` (a self-loop is counted once), which needs a per-type self-loop count
    // the store does not maintain. Measured at 2576.8 us against this 0.3, answering 1,999,998 on
    // a fixture with two self-loops — priced, and left to its own item rather than guessed at.
    //
    // `live_etype_count` is direction-free (it counts EDGES of a type), so the arms below need no
    // change, and `type_ever_secondary` guards the in-partition for the same reason it guards the
    // out one.
    // BOTH is admitted only when it DOUBLES a self-loop — item 1154.
    //
    // A both-expansion emits a row per edge END, so its count is `2*|E_t|` with a self-loop
    // contributing either two rows or one, and `double_loops` is exactly which. The two surface
    // spellings differ, so this is not a corner:
    //
    //   - Gremlin `both(T)` sets `double_loops: true` and counts a self-loop TWICE. TinkerPop
    //     ground truth, run in a console rather than recalled: on a 2-edge graph where one edge
    //     is a self-loop, `out(K)` is 2 and `both(K)` is 4. lenke agrees — 2,000,000 on a
    //     1,000,000-edge fixture holding two self-loops, i.e. exactly `2*|E_t|`.
    //   - GQL `-[:T]-` sets `double_loops: false` and counts it ONCE: 1,999,998 on that same
    //     fixture, i.e. `2*|E_t| - loops(t)`.
    //
    // The doubling case therefore needs NOTHING the store does not already maintain, and is taken
    // here. The other needs a per-type SELF-LOOP count, which the store does not keep; it is
    // priced at 2576.8us (item 1153) and left declining, with the `1-hop UNDIRECTED` bench row as
    // its guard. Admitting it on `2*|E_t|` alone would be a wrong answer of exactly `loops(t)`.
    // BOTH is now admitted for EITHER flag — item 1155 closed the non-doubling half.
    //
    // The two differ by exactly the self-loops: `double_loops` counts one twice, so the answer is
    // `2*|E_t|`, and the other counts it once, so it is `2*|E_t| - loops(t)`. Item 1154 shipped
    // the first (no new fact needed) and left the second declining for want of `loops(t)`;
    // `Store::live_etype_loops` supplies it, computed lazily from the OUT adjacency and dropped by
    // `invalidate_csr` — one maintenance site rather than the eight a maintained count would need.
    let both = matches!(dir, Dir::Both);
    if agg.distinct || *bind_edge || *from != 0 || !matches!(dir, Dir::Out | Dir::In | Dir::Both) {
        return None;
    }
    // Each edge is counted from BOTH ends when the direction is undirected, and from exactly one
    // in the directed cases; a self-loop is then counted twice or once per `double_loops`.
    let per_edge = if both { 2 } else { 1 };
    let loop_adjust = |t: Option<u32>| -> usize {
        if !both || *double_loops {
            return 0;
        }

        match t {
            Some(t) => store.live_etype_loops(t),
            // UNTYPED: every type's self-loops, since the hop matches every edge.
            None => store
                .all_etype_ids()
                .iter()
                .map(|&t| store.live_etype_loops(t))
                .sum(),
        }
    };
    if !whole_graph_scan(src, store) {
        return None;
    }
    match edge_label.as_slice() {
        // UNTYPED (item 877): an out-expansion from every vertex yields one row per edge — each
        // edge is an out-edge of exactly one source — so the answer is the live edge count, with
        // no partition and no type filter involved. `MATCH ()-[]->() RETURN count(*)` measured
        // 0.6070 ms against 0.0003 for the typed spelling of the same shape, because this arm
        // required exactly ONE type and an empty list fell through to the degree sum.
        //
        // No multi-label guard here and none needed: that guard exists because a partition holds
        // an edge's PRIMARY type only, and this arm reads no partition.
        [] => Some(per_edge * store.live_edge_count() - loop_adjust(None)),
        [ty] => {
            let t = store.etype_id(ty)?;
            // PER-TYPE, not global (item 1004). The partition for `t` is complete unless some
            // edge carries `t` as a SECONDARY label; whether an UNRELATED type is doubled up
            // says nothing about this one. The old global guard cost 0.3 -> 368.6 us on
            // `-[:KNOWS]->` the moment any edge gained a second label.
            if store.type_ever_secondary(t) {
                return None;
            }
            Some(per_edge * store.live_etype_count(t) - loop_adjust(Some(t)))
        }
        // SEVERAL TYPES — item 1157. This arm used to decline, and it is the third variant of a
        // label-ARITY enum whose other two were already O(1); items 1153-1155 found exactly that
        // shape in the DIRECTION enum. Measured at 200,000 nodes, degree 4 over two types:
        //
        // ```text
        //   -[:KNOWS]->            0.4 us   400,000
        //   -[:FOLLOWS]->          0.4      400,000
        //   -[:KNOWS|FOLLOWS]->  482.0      800,000     <- 1205x, and exactly the SUM
        //
        // A hop matching several types emits one row per edge of ANY of them, so the answer is
        // the sum of the per-type answers — each already available and each needing its own
        // `type_ever_secondary` guard, for the reason item 1004 gives: a partition holds an
        // edge's PRIMARY type only, so a type carried as a SECONDARY label elsewhere has an
        // incomplete partition and must decline. Guarding every listed type is what keeps the sum
        // from counting an edge that carries two of them twice.
        //
        // DEDUPED, because `-[:KNOWS|KNOWS]->` is one wanted type and not two: the general path
        // builds a SET of wanted types and emits one row per matching edge, so summing a repeated
        // name would double it. (Checked rather than assumed — `want_etypes` is set-valued.)
        //
        // An UNKNOWN type name contributes zero rather than declining the query: a hop on a type
        // no edge carries matches nothing, which is an answer and not an absence.
        //
        // THAT LAST CHOICE IS A ROUTE AND NOT A SEMANTIC, so its mutant necessarily SURVIVES —
        // labelled rather than left for someone to find. Declining instead sends
        // `-[:KNOWS|NOSUCH]->` to the general path, which returns the SAME count; only the cost
        // differs. Item 1122's rule ("a perf gate needs its own observable") is why no answer test
        // can pin it, and item 1137 is the precedent for extracting such a decision as a pure
        // predicate when it is standalone — this one is a `continue` inside the sum loop, where
        // extraction would cost more clarity than the pin is worth.
        tys => {
            let mut seen: Vec<u32> = Vec::with_capacity(tys.len());
            let mut total = 0usize;

            for ty in tys {
                let Some(t) = store.etype_id(ty) else {
                    continue; // no edge carries this type, so it contributes no rows
                };

                if store.type_ever_secondary(t) {
                    return None;
                }

                if seen.contains(&t) {
                    continue; // a repeated name is one wanted type
                }

                seen.push(t);
                total += per_edge * store.live_etype_count(t) - loop_adjust(Some(t));
            }

            Some(total)
        }
    }
}

/// `count(*)` over an EDGE SCAN filtered by edge label — Gremlin's `E().hasLabel(T, …).count()` —
/// answered from the CSR partitions' lengths instead of materializing every edge and filtering.
///
/// Item 877. This is the same question as GQL's `MATCH ()-[:T]->() RETURN count(*)`, which
/// `typed_hop_count_from_size` already answers from a size, and the two spellings were
/// **61,000x** apart at 200,000 vertices x degree 5 (750,000 matching edges both):
///
/// ```text
///   MATCH ()-[:KNOWS]->() RETURN count(*)       0.0003 ms
///   g.E().hasLabel('KNOWS').count()            18.4041
/// ```
///
/// The Gremlin form lowers to `Aggregate{Filter{EdgeScan, IsLabeled}}`, which no fast path
/// claimed, so it built the whole edge id vector and ran the label test per edge.
///
/// A LABEL SET IS AN OR, verified rather than assumed: `E().hasLabel('KNOWS','LIKES').count()`
/// returns every edge on a fixture carrying only those two types, and `hasLabel('NOPE')` returns
/// 0. So the answer is the SUM of the named types' partitions — exact only because an edge has one
/// primary type, which is what `has_multi_label_edges` declines. Duplicate labels are deduped, or
/// `hasLabel('K', 'K')` would count that partition twice.
pub(super) fn try_edge_label_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
    if agg.func != AggFn::Count || agg.arg.is_some() || agg.distinct {
        return None;
    }
    let Plan::Filter { input: edges, pred } = input else {
        return None;
    };
    if !matches!(**edges, Plan::EdgeScan) {
        return None;
    }
    let Expr::IsLabeled { slot: 0, labels } = pred else {
        return None;
    };
    let mut seen: Vec<&str> = Vec::with_capacity(labels.len());
    let mut total = 0usize;
    for l in labels {
        if seen.contains(&l.as_str()) {
            continue; // `hasLabel('K', 'K')` is one partition, not two
        }
        seen.push(l.as_str());
        // An unknown edge type matches nothing and contributes 0 — it must not decline the
        // whole path, or `hasLabel('KNOWS', 'NOPE')` would fall off it.
        if let Some(t) = store.etype_id(l) {
            // PER-TYPE, not global (item 1004). A partition holds the PRIMARY type only, so the
            // sum undercounts exactly when one of the NAMED types is carried secondarily
            // somewhere. With none of them secondary every named partition is complete, and an
            // edge sits in at most one of them (it has one primary), so the sum is exact.
            if store.type_ever_secondary(t) {
                return None;
            }
            total += store.live_etype_count(t);
        }
    }
    Some(scalar_num(total as f64))
}

/// Whether this plan scans EVERY LIVE VERTEX — an unlabelled scan, or one whose label every live
/// vertex carries.
///
/// Item 876. The second case is why this exists. `typed_hop_count_from_size` required
/// `Scan { label: None }` literally, and its own doc gives the reason as "a label would RESTRICT
/// the sources" — but a label every vertex has restricts nothing, and writing it is the natural
/// spelling. The cost of the literal check, at 200,000 vertices x degree 5, both answering
/// 1,000,000:
///
/// ```text
///   g.V().out('KNOWS').count()                     0.0003 ms   the CSR partition's length
///   g.V().hasLabel('Person').out('KNOWS').count()  0.5573      1857x, degree-summed over 200k
///   MATCH ()-[:KNOWS]->() RETURN count(*)          0.0003      the GQL spelling, same split
///   MATCH (p:Person)-[:KNOWS]->() ...              0.5387
/// ```
///
/// Both front ends, and the TS engine answers both at 0.0 because it HAS this elision
/// (`vacuousLabel` in `shortcuts.ts`) — so this was also a cross-engine spelling gap.
///
/// THE CONDITION IS AGAINST THE LIVE COUNT, and it is deliberately NOT `scan_visit`'s `whole`
/// test even though that function asks a similar-sounding question. `whole` justifies iterating
/// the dense range `0..node_count` directly, which needs there to be no tombstones at all; this
/// needs only "every LIVE vertex carries the label", which is the weaker and correct property
/// here. My first version copied `whole` anyway and was wrong twice over: it added a redundant
/// `live_node_count == node_count` conjunct, and it compared coverage against `node_count`, so a
/// graph with a single deleted vertex declined a label that genuinely did cover every live one.
///
/// `delete_node` REMOVES the id from the label's list — measured, not assumed (100 nodes, one
/// deleted: `node_count` 100, live 99, the `Person` list 99). So a list whose length equals the
/// live count contains exactly the live vertices, and the comparison needs nothing else.
///
/// Deletes are additionally safe for a reason outside this function: `out_typed_flat` returns
/// `None` once the CSR overlay is stale, and an adjacency write invalidates it — so the caller
/// declines on a mutated graph regardless of what this says.
pub(super) fn whole_graph_scan(plan: &Plan, store: &Store) -> bool {
    let Plan::Scan { label } = plan else {
        return false;
    };
    match label {
        None => true,
        Some(l) => store.nodes_with_label(l).len() == store.live_node_count(),
    }
}

/// Count the rows an UNINDEXED `IndexSeek { key, value }` would produce over a `Num` column, by
/// sweeping the column — no id vector (item 1267).
///
/// Equality semantics match `value::equals`, which is what the seek itself applies: a present cell
/// of the literal's type matches, a NULL cell never does. `sweep_num_count` masks on `present[i]`,
/// and a `Column::Num` cannot hold a stored present-null (writing one promotes the column to
/// `Gen`), so `present` IS "has a usable number here" — the same representation invariant
/// `num_conj_on_slot` documents at length. A `Gen` or `Temporal` column declines and keeps the
/// boxed path.
///
/// DECLINES a dotted key (the column is the record, not the path) and a NaN literal. NaN would in
/// fact answer 0 either way — `x == NaN` is false for every cell and `index_seek_ids` returns empty
/// for a NaN value at its first line — but the agreement is a coincidence of two separate rules, so
/// it is not relied on here.
///
/// ⚠️ THE STRING CASE IS NOT DONE, deliberately. A `Str`/`Dict` column under an unindexed `k = 'v'`
/// seek materializes ids exactly the same way and is presumably the same 4x; it needs its own
/// measurement and its own equality argument (`Arc<str>` compare, dict code resolution), so it is
/// recorded rather than guessed at here.
fn seek_eq_num_count(
    store: &Store,
    label: &Option<String>,
    key: &str,
    value: &Value,
) -> Option<u64> {
    if key.contains('.') {
        return None;
    }

    let Value::Num(v) = value else {
        return None;
    };

    if v.is_nan() {
        return None;
    }

    let Some(Column::Num { data, present, .. }) = store.column(key) else {
        return None;
    };

    Some(stream_eq_set_count(store, label, data, present, &[*v]))
}

pub(super) fn try_scan_count(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
    if agg.func != AggFn::Count || agg.arg.is_some() {
        return None; // count(*) only; count(arg)/DISTINCT need the values
    }
    let n = match input {
        Plan::Scan { label: Some(l) } => store.nodes_with_label(l).len(),
        Plan::Scan { label: None } => store.live_node_count(),
        // The HOP twin, and the same idea one level up (item 682): a single-type OUT hop
        // off the WHOLE graph counts one path per type-`T` edge, which is the size of that
        // type's CSR partition. Measured 172 µs walking 50,000 edges to return a length at
        // 3.4 ns/edge — and NO fast path claimed the shape at all: instrumenting all seven
        // `try_*_count` entries showed every one of them entered and declined, so it fell
        // through to the general materializing aggregate.
        Plan::Expand { .. } => typed_hop_count_from_size(input, agg, store)?,
        // The EDGE twin, which this had never had: `E().count()` built the whole 1,000,000-id
        // vector in `all_edges` and SORTED it, 12.12 ms, to return its length — while the TS
        // engine answered from a size. `live_edge_count` is that length by construction
        // (audit item 412).
        Plan::EdgeScan => store.live_edge_count(),
        // THE SEEK TWIN (item 1267). A bare `k = v` is rewritten by the optimizer into an
        // `IndexSeek`, NOT a `Filter` over a `Scan` — so `try_filtered_count`'s whole chain is
        // unreachable for it and the shape fell to the general materializing aggregate, which
        // gathers the survivors' columns into a Batch and immediately discards them for a count.
        //
        // That is the entire cost of the 4.1x item 1265 chased into the wrong function: `= 50` read
        // 0.145 ms where its own explicit range spelling `>= 50 AND <= 50` — strictly more work, and
        // a `Filter(Scan)` that DOES reach a streaming count — read 0.035, on identical answers.
        //
        // `index_seek_ids` is the seek's row producer and already does the right thing per store
        // (a hash bucket intersected with the label, else a range index's point probe, else a typed
        // column scan), so the count is its length and nothing here needs to know which. Reached
        // through `super::`: a child module sees its parent's private items.
        Plan::IndexSeek { label, key, value } => {
            // ⚠️ WITH NO INDEX, DO NOT ASK FOR THE IDS. Calling `index_seek_ids` and taking its
            // length was the first cut and measured NOTHING (0.145 ms -> 0.140, inside noise):
            // the cost is not the Batch the general aggregate gathers, it is the seek
            // MATERIALIZING a `Vec<u32>` of matches — a push per hit, through the label's id list
            // — where a count needs no id at all. `seek_eq_num_count` sweeps the typed column
            // instead, which is the same primitive item 1264's membership passes use.
            //
            // THE REAL INDEX WINS WHEN THERE IS ONE, so it is asked first: a hash bucket is
            // O(matches) and a sweep is O(label), and the indexed row must not get slower. Only
            // the SCAN FALLBACK is replaced.
            if store.has_hash_index(key) || store.has_range_index(key) {
                super::index_seek_ids(store, label.as_deref(), key, value).len()
            } else if let Some(c) = seek_eq_num_count(store, label, key, value) {
                c as usize
            } else {
                super::index_seek_ids(store, label.as_deref(), key, value).len()
            }
        }
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
    let agg = sole_agg(keys, aggs)?;
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
    // ONE LOOP PER AGGREGATE FAMILY (item 1209), because the single loop below did every
    // aggregate's work for every aggregate. A `sum` maintained `best` through an `Option<f64>`
    // match it then discarded, AND compared `agg.func` against `Min` and `Max` ONCE PER ROW —
    // loop-invariant tests of the kind items 457 and 459 hoisted out of the scalar paths for the
    // same reason. An extremum, conversely, accumulated a `total` nothing reads.
    //
    // Exactly equivalent rather than nearly so: `Sum`/`Count`/`Avg` read only `total` and `cnt`,
    // and `Min`/`Max` read only `best`, so neither loop drops anything its own result depends on.
    // The `present[i]` skip and the `cmp_num_total` ordering are unchanged in both, which is what
    // keeps the answer (and the NaN placement that ordering defines) identical.
    let (mut total, mut cnt, mut best): (f64, u64, Option<f64>) = (0.0, 0, None);
    let want_extremum = matches!(agg.func, AggFn::Min | AggFn::Max);

    if want_extremum {
        let want_min = agg.func == AggFn::Min;

        for &row in &keep {
            let i = sids[row] as usize;

            if !present[i] {
                continue; // the agg's own prop may be NULL even when the filter passed
            }

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
    } else {
        for &row in &keep {
            let i = sids[row] as usize;

            if !present[i] {
                continue; // the agg's own prop may be NULL even when the filter passed
            }

            total += data[i];
            cnt += 1;
        }
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
    let agg = sole_agg(keys, aggs)?;
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
    let agg = sole_agg(keys, aggs)?;
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
/// The NON-NUMERIC twin of [`try_frontier_multi_agg`], for a two-or-more-aggregate frontier whose
/// `min`/`max` argument is a `Str`, `Dict`, `Bool` or `Temporal` column (item 1184).
///
/// WHY A SEPARATE FUNCTION, and it is a MEASUREMENT rather than taste. Widening the entry above
/// in place served the same shapes and cost its own `count(*), count(b.k)` control **1.10x** over
/// three order-alternated rounds — a path that reads none of the new arms. Two causes, found in
/// order: the shared accumulator grew from `(f64, Option<f64>)` to a struct carrying an index,
/// two flags and a `Vec`, so the count arms indexed a far larger stride for state they never read
/// (1.16x); splitting that into side state recovered part of it (1.10x); and the residue is the
/// DISPATCH — `match spec` grew from three arms to seven, which every query through the function
/// pays. The control moved 1.10x on four representations and only 0.98x on `mixed`, whose per-node
/// work is the most expensive, which is what a fixed per-node cost looks like.
///
/// So this is item 375's "a shared body taxes both folds" a third time, and the structural answer
/// is item 1162's: a separate function, reached only by the shapes it serves. The entry above is
/// left BYTE-IDENTICAL, so its control is untouched by construction rather than by re-measurement.
///
/// Placed AFTER it in the chain. That entry already declines when a `min`/`max` column is not
/// `Column::Num`, so this one receives exactly those shapes and no others — and it re-checks every
/// gate itself, so it cannot serve something the chain did not intend.
pub(super) fn try_frontier_multi_agg_wide(
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
    //
    // ONE VARIANT PER REPRESENTATION rather than a column-type test inside `MinMax` (item 1184).
    // The fold already dispatches on `spec` once per (node, agg), so extra variants cost the
    // existing `Num` arm nothing — the same jump table gains entries. A shared body behind a
    // type test would tax every arm, which is what item 375 measured at 1.09x on its `sum`
    // control before splitting the folds restored parity.
    enum FSpec<'a> {
        Rows,
        CountProp(&'a Column),
        MinMax(&'a [f64], &'a [bool], bool),
        MinMaxStr(&'a [GStr], &'a [bool], bool),
        MinMaxDict(&'a [GStr], &'a [u32], &'a [bool], bool),
        MinMaxBool(&'a [bool], &'a [bool], bool),
        MinMaxTemporal(&'a [crate::temporal::Temporal], &'a [bool], bool),
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
                    let want_min = agg.func == AggFn::Min;
                    // Each arm mirrors its single-aggregate twin in `try_frontier_prop_agg`
                    // (item 1182), so the one-aggregate and two-aggregate spellings of one
                    // question cannot disagree. `Gen` declines: a mixed column's extremum
                    // crosses type ranks and belongs to the general fold.
                    specs.push(match store.column(key)? {
                        Column::Num { data, present, .. } => {
                            FSpec::MinMax(data.as_slice(), present.as_slice(), want_min)
                        }
                        Column::Str { data, present, .. } => {
                            FSpec::MinMaxStr(data.as_slice(), present.as_slice(), want_min)
                        }
                        Column::Dict {
                            dict,
                            codes,
                            present,
                            ..
                        } => FSpec::MinMaxDict(
                            dict.as_slice(),
                            codes.as_slice(),
                            present.as_slice(),
                            want_min,
                        ),
                        Column::Bool { data, present, .. } => {
                            FSpec::MinMaxBool(data.as_slice(), present.as_slice(), want_min)
                        }
                        Column::Temporal { data, present, .. } => {
                            FSpec::MinMaxTemporal(data.as_slice(), present.as_slice(), want_min)
                        }
                        Column::Gen { .. } => return None,
                    });
                }
            }
            _ => return None, // sum/avg (item 376) and everything else
        }
    }
    let counts = frontier_counts(input, store)?;
    // (weighted total, best) per agg — one or the other is used, never both.
    let mut acc: Vec<(f64, Option<f64>)> = vec![(0.0, None); specs.len()];
    // SIDE STATE for the non-numeric extremum arms, deliberately NOT folded into `acc`
    // (item 1184). Widening the shared accumulator to carry an index, two flags and a `Vec`
    // measured **1.16x on the `count(*), count(k)` control** — consistently across all five
    // representations — because the `Rows`/`CountProp`/`MinMax` arms then index a far larger
    // stride for state they never read. That is item 375's "a shared body taxes both folds"
    // expressed in the DATA rather than the code, and splitting it restores the control. Keeping
    // `acc` byte-identical is what makes the numeric path provably unchanged.
    #[derive(Clone, Default)]
    struct Ext {
        best_i: Option<usize>,
        saw_want: bool,
        saw_other: bool,
        // The dictionary arm's per-code mark. Every other arm leaves it empty, and an empty
        // `Vec` does not allocate, so this is one allocation per DICT agg and none otherwise.
        seen: Vec<bool>,
    }
    let mut ext: Vec<Ext> = specs
        .iter()
        .map(|s| match s {
            FSpec::MinMaxDict(dict, ..) => Ext {
                seen: vec![false; dict.len()],
                ..Ext::default()
            },
            _ => Ext::default(),
        })
        .collect();
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
                // Tracked as an INDEX rather than a borrow: `for_each` takes an `FnMut`, and a
                // `&GStr` is not a borrow the closure can hold across iterations.
                FSpec::MinMaxStr(data, present, want_min) => {
                    if present[i] {
                        ext[k].best_i = Some(match ext[k].best_i {
                            None => i,
                            Some(b) => {
                                let ord = data[i].cmp(&data[b]);
                                if (*want_min && ord.is_lt()) || (!*want_min && ord.is_gt()) {
                                    i
                                } else {
                                    b
                                }
                            }
                        });
                    }
                }
                // Pass one of two: WHICH codes the frontier reaches. No string is compared per
                // node; the extremum over `dict` is taken once, below.
                FSpec::MinMaxDict(_, codes, present, _) => {
                    if present[i] {
                        ext[k].seen[codes[i] as usize] = true;
                    }
                }
                FSpec::MinMaxBool(data, present, want_min) => {
                    if present[i] {
                        // `want` — the value that ENDS the search — is `!want_min`: `min` seeks
                        // `false`, `max` seeks `true`. So "is this cell the sought value" is
                        // `data[i] == !want_min`, which is the same predicate as this one and is
                        // how the finish stage below still spells it.
                        if data[i] != *want_min {
                            ext[k].saw_want = true;
                        } else {
                            ext[k].saw_other = true;
                        }
                    }
                }
                FSpec::MinMaxTemporal(data, present, want_min) => {
                    if present[i] {
                        ext[k].best_i = Some(match ext[k].best_i {
                            None => i,
                            Some(b) => {
                                let ord = data[i].cmp_total(&data[b]);
                                if (*want_min && ord.is_lt()) || (!*want_min && ord.is_gt()) {
                                    i
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
        .enumerate()
        .map(|(k, spec)| {
            let (total, best) = acc[k];
            let a = &ext[k];
            let v = match spec {
                FSpec::Rows | FSpec::CountProp(_) => Value::Num(total),
                FSpec::MinMax(..) => best.map_or(Value::Null, Value::Num),
                FSpec::MinMaxStr(data, ..) => a
                    .best_i
                    .map_or(Value::Null, |i| Value::Str(data[i].clone())),
                // Pass two: over `dict.len()` rather than over the frontier, which is the point
                // of the dictionary arm.
                FSpec::MinMaxDict(dict, _, _, want_min) => {
                    let mut best_c: Option<usize> = None;
                    for (c, &used) in a.seen.iter().enumerate() {
                        if used {
                            best_c = Some(match best_c {
                                None => c,
                                Some(b) => {
                                    let ord = dict[c].cmp(&dict[b]);
                                    if (*want_min && ord.is_lt()) || (!*want_min && ord.is_gt()) {
                                        c
                                    } else {
                                        b
                                    }
                                }
                            });
                        }
                    }
                    best_c.map_or(Value::Null, |c| Value::Str(dict[c].clone()))
                }
                FSpec::MinMaxBool(_, _, want_min) => {
                    let want = !*want_min;

                    if a.saw_want {
                        Value::Bool(want)
                    } else if a.saw_other {
                        Value::Bool(!want)
                    } else {
                        Value::Null
                    }
                }
                FSpec::MinMaxTemporal(data, ..) => {
                    a.best_i.map_or(Value::Null, |i| Value::Temporal(data[i]))
                }
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
    let agg = sole_agg(keys, aggs)?;
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

/// One extremum over a `Num` column, branch-free in the loop: returns `(best, cnt, nan_cnt)`
/// where `best` is the plain `<`/`>` extremum, `cnt` the present values and `nan_cnt` how many
/// of those were NaN. The caller turns that into the contract's answer — see the long note in
/// [`try_scan_num_agg`] for why NaN is counted rather than compared, and why the sentinel start
/// needs no special case for a stored ±INFINITY.
///
/// `MIN` is a const parameter, not a runtime flag: the direction is loop-invariant, and the fold
/// this replaced tested it per row. `#[inline(never)]` for the reason items 453, 459 and 462 each
/// measured — an arm inlined into this chain perturbs the shapes that never enter it.
#[inline(never)]
fn scan_extremum<const MIN: bool>(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
    whole: bool,
) -> (f64, u64, u64) {
    let mut best = if MIN {
        f64::INFINITY
    } else {
        f64::NEG_INFINITY
    };
    let (mut cnt, mut nan_cnt) = (0u64, 0u64);
    let mut take = |x: f64| {
        cnt += 1;
        nan_cnt += u64::from(x.is_nan());
        if MIN {
            if x < best {
                best = x;
            }
        } else if x > best {
            best = x;
        }
    };
    if whole {
        // The raw-slice walk: no per-row id indirection, so this is the arm that vectorizes.
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
    (best, cnt, nan_cnt)
}

/// `MATCH (n:L) RETURN percentile_cont(n.k, f)` over a `Num` column — the ordered-set aggregate
/// `try_scan_num_agg`'s gate declines, answered with ONE order statistic instead of a sort.
///
/// WHY THIS IS A TARGET AT ALL, measured before it was built (item 1162). Item 1161 priced the
/// aggregate-kind enum and left both percentiles at 3674us against `sum`'s 122 on the same
/// column — 30x — and DECLINED to call it a target, because a percentile needs an order statistic
/// and `sum` does not. `percentile_floor_probe` separated the three costs and the inference drawn
/// from item 844's recorded numbers (that the per-row `Value` boxing owned the ratio) was WRONG:
///
/// ```text
///   sum                       122.0 us   the scan+column floor
///   columnar gather alone     156.6      so a boxing-free gather is nearly free
///   gather + select_nth       397.8      the SELECTION costs ~241
///   gather + full sort       3602.8      the SORT costs ~3446
///   percentile_disc          3717.4      the full sort is 97% of it
/// ```
///
/// So the sort owns it, the gather does not, and the floor is 9.3x. Item 234 is why that was
/// measured rather than argued — a floor per shape retracted two of three targets there.
///
/// EXACTNESS, which decides the one guard here. `percentile_of` sorts with
/// `partial_cmp(..).unwrap_or(Equal)` and indexes the result, so this must return the value that
/// sort would have put at the same index. For finite f64 "equal under `partial_cmp`" implies
/// IDENTICAL BITS — with exactly one exception, `-0.0` and `0.0`, which tie under `partial_cmp`
/// and differ in bits. A stable sort keeps such a tied run in input order; an unstable selection
/// may return either member. So a negative zero is DETECTED IN THE GATHER and the whole path
/// DECLINES, which leaves those columns answering exactly as before. Same shape as item 1161's
/// `nan_cnt`: note the fact in the loop, decide at the finish.
///
/// NaN and ±INFINITY need no guard because the gather DROPS them, which is not a choice made here
/// — `percentile_of` keeps only `x.is_finite()` values, and a fast path that kept them would be
/// answering a different question.
///
/// A SEPARATE FUNCTION rather than another block inside `try_scan_num_agg`, deliberately. That
/// function's own notes record what a shared live range cost twice (item 844's stddev draft moved
/// the `min` control 1.6x, and item 1161's extremum block returns early for the same reason), and
/// its sum/avg/min/max arms were just measured flat. Nothing here can reach them.
pub(super) fn try_scan_percentile(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
    if agg.distinct || !matches!(agg.func, AggFn::PercentileCont | AggFn::PercentileDisc) {
        return None;
    }
    let Plan::Scan { label } = input else {
        return None;
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    let Some(Column::Num { data, present, .. }) = store.column(key) else {
        return None; // a non-numeric column raises in the general path; let it
    };

    let mut vals: Vec<f64> = Vec::with_capacity(data.len());
    let mut saw_neg_zero = false;
    scan_visit(store, label, |i| {
        if present[i] {
            let x = data[i];
            if x.is_finite() {
                saw_neg_zero |= x == 0.0 && x.is_sign_negative();
                vals.push(x);
            }
        }
    });
    if saw_neg_zero {
        // LOAD-BEARING, and measured rather than assumed. A standalone search over both
        // algorithms found 1,454,911 of 5,916,000 (input, index) pairs differ in bits, the
        // minimal case being `n = 2, idx = 1` over `[-0.0, 0.0]`: the stable sort gives `0.0`,
        // the selection `-0.0`. A mutant removing this line first SURVIVED, because the test
        // guarding it used three values and `select_nth_unstable_by` insertion-sorts a slice
        // that short — stably. See the test's own note.
        return None;
    }
    if vals.is_empty() {
        return Some(Batch::of(vec![Col::Gen(vec![Value::Null])])); // percentile of nothing
    }

    // CLAMPED AT THE POINT OF USE, exactly as `percentile_of` does and for its recorded reason:
    // an unclamped fraction indexed past the end and PANICKED (item 530). The two must agree for
    // every fraction, in range or not.
    let frac = agg.frac.unwrap_or(0.0).clamp(0.0, 1.0);
    let n = vals.len();
    // The comparator is `percentile_of`'s, not `total_cmp`: `total_cmp` orders `-0.0` BEFORE
    // `0.0` where this ties them, which would be a different order statistic on a column the
    // gate above has already refused — but keeping the comparators identical means the two paths
    // cannot drift apart if that gate is ever loosened.
    let cmp = |a: &f64, b: &f64| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal);

    let result = if agg.func == AggFn::PercentileCont {
        let rn = frac * (n - 1) as f64;
        let lo = rn.floor() as usize;
        let hi = rn.ceil() as usize;
        let (_, nth, right) = vals.select_nth_unstable_by(lo, cmp);
        let lo_val = *nth;
        if lo == hi {
            lo_val
        } else {
            // `select_nth_unstable_by` leaves everything `>= nth` in `right`, so the NEXT order
            // statistic is its minimum — O(n), no second selection. `right` cannot be empty
            // here: `lo != hi` forces `rn` off an integer, so `lo < n - 1`.
            let hi_val = right.iter().copied().fold(f64::INFINITY, f64::min);
            lo_val + (rn - lo as f64) * (hi_val - lo_val)
        }
    } else {
        // `.min(n - 1)` is DEFENSIVE and measured so: `frac` is clamped to `<= 1` above, hence
        // `ceil(frac * n) - 1 <= n - 1` always, and a mutant removing it SURVIVES the suite
        // (item 1162, M6). Kept because it is what `percentile_of` does and the two must not
        // drift, but the clamp is the load-bearing guard — removing THAT is caught (M3).
        let idx = ((frac * n as f64).ceil() as usize)
            .saturating_sub(1)
            .min(n - 1);
        let (_, nth, _) = vals.select_nth_unstable_by(idx, cmp);
        *nth
    };
    Some(Batch::of(vec![Col::Gen(vec![Value::Num(result)])]))
}

pub(super) fn try_scan_num_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
    // `Count` is NOT here: it does not read the values, so `try_scan_count_prop` answers it
    // for a column of ANY type rather than this arm answering it for `Num` alone.
    //
    // `Min`/`Max` ARE here (item 375), and this entry moved ABOVE `try_frontier_prop_agg` to
    // make that reachable. A bare `Scan` is a trivial frontier, so the frontier path was
    // claiming scan min/max and answering them at 6.4x what this columnar fold charges for
    // `sum` over the SAME column — 180.5us vs 28.1us at 50k. Nothing was wrong with either
    // path; the aggregate set was split across two of them and each covered only half of it.
    //
    // `StddevPop`/`StddevSamp` joined at item 844, in a SEPARATE early-return block below rather
    // than as another arm of the fold — see the note there for what sharing a live range cost the
    // `min` control.
    if agg.distinct
        || !matches!(
            agg.func,
            AggFn::Sum
                | AggFn::Avg
                | AggFn::Min
                | AggFn::Max
                | AggFn::StddevPop
                | AggFn::StddevSamp
        )
    {
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
    let all_live_sd = store.live_node_count() == store.node_count();
    let whole_sd = all_live_sd
        && match label {
            None => true,
            Some(l) => store.nodes_with_label(l).len() == store.node_count(),
        };

    // THE STDDEV PATH IS WHOLLY SEPARATE, and the reason is measured rather than stylistic.
    //
    // An `AggFn` census put `Count` at 38 matches in this file, `Min` 36, `Max` 24, `Sum` 17,
    // `Avg` 12 — and `Collect`, `CollectList`, both stddevs and both percentiles at ZERO, six of
    // eleven variants falling to the general grouped fold. At 200,000 rows against `sum`'s 110us
    // on the SAME column: `stddev_pop` 777 and `stddev_samp` 790 (7.1x), `collect_list` 2,999
    // (27x), `percentile_cont` 5,588 and `percentile_disc` 5,816 (51x). The stddevs are taken
    // here because their own doc says they are one-pass moments — `sum`'s loop plus one
    // multiply-accumulate — so the 7.1x was the fold and nothing else. The percentiles need a
    // SORT, so most of their 51x is inherent, and `collect_list` must materialize the list.
    //
    // The first draft added `sum_sq` beside `total` and a third arm to the existing fold. It
    // worked and it REGRESSED A CONTROL: `min` went 394us -> 632us, 1.6x the wrong way, disjoint
    // across three alternated rounds, because an accumulator declared at that scope stays live
    // across the min/max loop that never reads it. This function's own comment records the same
    // hazard one level in, for a shared loop BODY; a shared live RANGE is the same tax collected
    // somewhere else. Returning early leaves every byte of the fold below untouched, so the
    // question cannot arise — and the `min`/`sum`/`avg` controls then measured flat.
    //
    // BYTE-IDENTICAL BY CONSTRUCTION. The general fold's moments are exactly
    // `sum += x; sum_sq += x * x; cnt += 1` over the group's rows with nulls skipped, finishing
    // with `stddev_of` — which this calls rather than repeating its formula. Float addition is
    // order-dependent, so the ORDER is as load-bearing as the arithmetic: a bare `Scan`'s group
    // rows arrive in scan order, which is the order these loops accumulate in.
    if matches!(agg.func, AggFn::StddevPop | AggFn::StddevSamp) {
        let (mut sd_total, mut sd_sq, mut sd_cnt) = (0f64, 0f64, 0u64);

        if whole_sd {
            for (i, &x) in data.iter().enumerate() {
                if present[i] {
                    sd_total += x;
                    sd_sq += x * x;
                    sd_cnt += 1;
                }
            }
        } else {
            let mut visit = |i: usize| {
                if present[i] {
                    let x = data[i];
                    sd_total += x;
                    sd_sq += x * x;
                    sd_cnt += 1;
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

        return Some(Batch::of(vec![Col::Gen(vec![stddev_of(
            sd_cnt,
            sd_total,
            sd_sq,
            agg.func == AggFn::StddevSamp,
        )])]));
    }

    // THE MIN/MAX PATH IS ALSO WHOLLY SEPARATE, and for the reason the stddev block above
    // records: an accumulator declared at the shared scope stays live across the loop that
    // never reads it. `best: Option<f64>` used to sit beside `total`/`cnt` here and the fold
    // below carried a `matches!(Min | Max)` arm; returning early leaves the sum/avg loop
    // byte-for-byte what it was, so that question cannot arise rather than being answered.
    //
    // WHY THE `Option` HAD TO GO (item 1161). Pricing the `AggFn` enum put `min` at 435us and
    // `max` at 472 against `sum`/`avg`/`stddev_pop` at 122 on the SAME column at 200,000 nodes —
    // 3.6-3.9x, and the variants with the MOST matches in this file were the slow ones, so the
    // mention census that found the stddev gap at item 844 would never have found this one. The
    // cost was not `cmp_num_total`: it was carrying an `Option` through the loop, whose per-row
    // `match` on `None` stops it auto-vectorizing, plus a per-row `want_min` test. Both are
    // loop-invariant facts evaluated per element.
    //
    // THE SENTINELS ARE THE IDENTITY, SO PLAIN `<`/`>` IS EXACT — and this is the one thing here
    // that is subtle. `cmp_num_total` is `partial_cmp` for two non-NaN operands (it ties -0.0
    // with 0.0 deliberately), so for everything but NaN a plain comparison IS the contract's
    // order, and `<`/`>` keeping the incumbent on a tie preserves first-wins. ±INFINITY needs no
    // special case either: a stored +∞ is a present value (`stored_infinity_is_a_value`), and
    // `mn` starting at +∞ returns it correctly because the sentinel is the fold's identity.
    //
    // NaN IS THE EXCEPTION AND IT IS COUNTED, NOT COMPARED. Under `cmp_num_total` NaN is
    // GREATEST and all NaNs tie, so `max` over a group containing one must BE NaN. A plain
    // `x > mx` skips it silently — which is exactly the WRONG ANSWER item 1161 found in
    // `scan_fold_minmax`, whose comment claimed "stored Nums are finite". They are not: `SET
    // n.v = sqrt(0 - 1)` stores one from the surface language. So the loop counts NaNs with
    // `nan_cnt += u64::from(x.is_nan())` — a compare-and-add that vectorizes with the rest — and the
    // finish reads the count:
    //
    //   min: NaN never wins unless EVERY value is one   -> `cnt == nan_cnt` => NaN
    //   max: any NaN wins outright                      -> `nan_cnt > 0`    => NaN
    //
    // That is the contract's answer with no branch in the loop, so correctness here costs one
    // add per row rather than the `Option` it replaces.
    if matches!(agg.func, AggFn::Min | AggFn::Max) {
        let want_min = agg.func == AggFn::Min;
        // Specialized on the direction OUTSIDE the loop: `want_min` is loop-invariant, and the
        // old fold tested it per row inside the closure that also unwrapped the `Option`.
        let (best, cnt, nan_cnt) = if want_min {
            scan_extremum::<true>(store, label, data, present, whole_sd)
        } else {
            scan_extremum::<false>(store, label, data, present, whole_sd)
        };
        let v = if cnt == 0 {
            Value::Null // an empty set has no extremum (distinct from sum's 0.0, K0a)
        } else if if want_min {
            cnt == nan_cnt
        } else {
            nan_cnt > 0
        } {
            Value::Num(f64::NAN)
        } else {
            Value::Num(best)
        };
        return Some(Batch::of(vec![Col::Gen(vec![v])]));
    }

    let (mut total, mut cnt) = (0f64, 0u64);
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
    if whole {
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
/// `MATCH (n:L) RETURN min(n.flag)` over a `Column::Bool` — the representation the extremum enum
/// did not serve, and the only one that can answer WITHOUT finishing the scan.
///
/// WHY IT IS A TARGET (item 1172). Pricing `min`/`max` across all six column representations at
/// 200,000 nodes, against `count(<key>)` on the SAME column as the per-representation floor (it
/// reads only the presence mask, so it should be flat everywhere):
///
/// ```text
///   column   min(us)   count(k)(us)   min/count
///   num       111.9       101.5          1.10
///   dict      178.9       202.3          0.88
///   date      112.0       101.4          1.10
///   bool     1016.2       101.4         10.0x     <- this
///   str      1524.3       101.6         15.0x     (comparing unique strings is real work)
///   mixed    3162.5       147.9         21.4x     (`Gen` holds boxed `Value`s; not a target)
/// ```
///
/// `Bool` is the SIMPLEST representation in the store — a `Vec<bool>` beside its masks — and it was
/// the slowest of the three that should be trivial, at 9x the numeric arm and 10x its own floor,
/// because it had no arm at all and fell to the general grouped fold, which boxes every cell into a
/// `Value::Bool` and compares through `cmp_total` (200,000 boxed comparisons at ~5 ns).
///
/// THE SHORT CIRCUIT, which is why this is not merely "one more arm". `bool::cmp` gives
/// `false < true` (checked in `value.rs`, not assumed), so over a boolean column:
///
///   - `min` is `false` the moment ANY present `false` is seen — nothing later can beat it;
///   - `max` is `true` the moment ANY present `true` is seen.
///
/// So the answer is usually available in the first few cells and the walk stops, which no other
/// representation permits. The fallback when the sought value never appears is one pass, and it
/// still beats the boxed fold.
///
/// NULL is the same contract the numeric arm uses: an empty or all-null group has no extremum, so
/// NULL — distinct from `sum`'s 0.0 (K0a). A present-null does not participate (`present[i]` is
/// false for one), matching `count(<key>)` and every other extremum arm.
pub(super) fn try_scan_bool_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
    if agg.distinct || !matches!(agg.func, AggFn::Min | AggFn::Max) {
        return None;
    }
    let Plan::Scan { label } = input else {
        return None;
    };
    let Some(Expr::Prop { slot: 0, key }) = agg.arg.as_ref() else {
        return None;
    };
    let Some(Column::Bool { data, present, .. }) = store.column(key) else {
        return None;
    };

    // `want` is the value that ENDS the search: `false` for `min`, `true` for `max`.
    let want = agg.func == AggFn::Max;
    let mut saw_want = false;
    let mut saw_other = false;

    scan_visit_while(store, label, |i| {
        if present[i] {
            if data[i] == want {
                saw_want = true;

                return false; // the extremum cannot be beaten — stop the walk
            }

            saw_other = true;
        }

        true
    });

    let v = if saw_want {
        Value::Bool(want)
    } else if saw_other {
        // Every present cell was the OTHER value, so that is the extremum.
        Value::Bool(!want)
    } else {
        Value::Null // no present cell at all
    };

    Some(Batch::of(vec![Col::Gen(vec![v])]))
}

pub(super) fn try_scan_str_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
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

/// `MATCH (n:L) RETURN min(n.hired)` over a packed TEMPORAL column — the arm the string twin's
/// own comment left open: "`Bool` and `Temporal` have their own orders and are simply not
/// measured here, so they are left where they were rather than extended on a guess."
///
/// Item 840 supplied the measurement that comment was waiting for. Over 200,000 nodes carrying a
/// `Date` and a `Num` of the same cardinality, `min` cost **1,925us against the number column's
/// 438 — 4.4x** (and `max` 1,923 against 472, 4.1x), because the general fold boxes a `Value` per
/// row and compares through `cmp_total`'s dispatch.
///
/// BYTE-IDENTICAL BY CONSTRUCTION: the comparator here IS the general fold's. `cmp_total` on two
/// `Value::Temporal`s is exactly `x.cmp_total(y)` — one line of dispatch — so this calls the same
/// function on the same values and can only agree with it.
///
/// Unlike the numeric and string arms there is no second encoding to handle: a temporal column is
/// `Temporal` or it is `Gen`, and a `Gen` one is mixed-kind (a stored `Value::Null` beside dates
/// is enough to promote it, item 840), where the extremum can cross type ranks and belongs to the
/// general fold.
///
/// `agg.numeric_only` (Gremlin) is deliberately NOT checked, matching the string twin: the general
/// path's cross-type fault needs a group holding both a number and a non-number, and a packed
/// temporal column's scanned values are all `Value::Temporal`, so the fault it would raise cannot
/// arise for this shape either way.
pub(super) fn try_scan_temporal_agg(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    let agg = sole_agg(keys, aggs)?;
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
    let Some(Column::Temporal { data, present, .. }) = store.column(key) else {
        return None; // Gen / non-temporal / absent-everywhere -> general path
    };
    let want_min = agg.func == AggFn::Min;
    // The extremum is tracked as an INDEX, like the string arm: `scan_visit` takes an `FnMut`.
    let mut best_i: Option<usize> = None;
    scan_visit(store, label, |i| {
        if present[i] {
            best_i = Some(match best_i {
                None => i,
                Some(b) => {
                    let ord = data[i].cmp_total(&data[b]);
                    if (want_min && ord.is_lt()) || (!want_min && ord.is_gt()) {
                        i
                    } else {
                        b
                    }
                }
            });
        }
    });
    // An empty set has no extremum, so NULL — the answer the numeric and string arms give.
    Some(Batch::of(vec![Col::Gen(vec![
        best_i.map_or(Value::Null, |i| Value::Temporal(data[i]))
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

/// `scan_visit`, but `f` returns `false` to STOP the scan. Needed by the rank-bounded top-K
/// path (item 864): a dictionary key has a lower bound on every value in the column, so once
/// `k` rows at the extreme rank have been seen in arrival order the answer is settled and the
/// remaining nodes cannot change it. `scan_visit`'s `for_each` has no way to say that, and
/// walking N anyway is the entire cost being removed.
pub(super) fn scan_visit_while<F: FnMut(usize) -> bool>(
    store: &Store,
    label: &Option<String>,
    mut f: F,
) {
    let all_live = store.live_node_count() == store.node_count();
    let whole = all_live
        && match label {
            None => true,
            Some(l) => store.nodes_with_label(l).len() == store.node_count(),
        };
    if whole {
        for i in 0..store.node_count() {
            if !f(i) {
                return;
            }
        }
    } else {
        match label {
            Some(l) => {
                for &id in store.nodes_with_label(l) {
                    if !f(id as usize) {
                        return;
                    }
                }
            }
            None => {
                for i in 0..store.node_count() {
                    if store.is_alive(i as u32) && !f(i) {
                        return;
                    }
                }
            }
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
    let agg = sole_agg(keys, aggs)?;
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
    let agg = sole_agg(keys, aggs)?;
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
    let agg = sole_agg(keys, aggs)?;
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
        // A DATE column dedups on its `days`, which is the whole value (item 840). Measured at
        // 200,000 rows: this shape cost 21,730us against a `Num` column's 441 — 49x, and linear
        // in N (2,955 / 6,043 / 11,647 / 21,730 at 25k/50k/100k/200k), so a per-row constant
        // rather than a complexity defect. The general aggregate byte-keys every row through
        // `group_key`, which for a temporal is `t.format()` — an allocated ISO String per row.
        //
        // WHY ONLY `Date`, AND WHY THIS IS NOT A LOOSER MATCH. `group_key`'s equivalence is
        // RENDER equality ("two temporals group together iff they render identically AND are the
        // same kind"), while `Temporal` derives STRUCTURAL equality. Those are the same relation
        // only where `format` is injective. For `Date` it demonstrably is: `format` is
        // `civil_from_days(days)` through `fmt_year`, which pads to four digits but never
        // truncates, so distinct `days` render distinctly and dedup on `days` yields exactly the
        // general path's classes. For the kinds carrying a sub-second or zone part that is an
        // argument still to be made, so they keep the general path rather than being swept in by
        // a wider pattern — the cost of being wrong here is a wrong COUNT, not a slow one.
        Column::Temporal {
            kind: crate::temporal::TemporalKind::Date,
            data,
            present,
            ..
        } => {
            let mut seen: FnvSet<i32> = FnvSet::default();
            // A column holds exactly one kind (see `TemporalKind`), so this match always takes
            // the `Date` arm — but the assumption is CHECKED rather than trusted, because the
            // failure mode if it ever breaks is a silently wrong count.
            let mut foreign = false;
            scan_visit(store, label, |i| {
                if present[i] {
                    match data[i] {
                        crate::temporal::Temporal::Date(d) => {
                            seen.insert(d.days);
                        }
                        _ => foreign = true,
                    }
                }
            });
            if foreign {
                return None;
            }
            seen.len()
        }
        // THE OTHER KINDS (item 1016). The arm above's own comment said their injectivity was
        // "an argument still to be made"; item 1015 made it from `temporal.rs` and shipped the
        // same extension on the `RETURN DISTINCT` side, where this column read **38,119 us for
        // `datetime` against `Date`'s 581** — 66x, and untouched by that item because the
        // aggregate is a different path. `Date` KEEPS ITS NARROWER ARM above: item 1015 measured
        // folding it into this tuple at 2.0x on the date column alone.
        Column::Temporal {
            kind,
            data,
            present,
            ..
        } if super::distinct::temporal_kind_keyable(*kind) => {
            let mut seen: FnvSet<(i64, u32, i16)> = FnvSet::default();
            // Same CHECKED invariant as the `Date` arm: a column holds one kind, so every cell
            // keys — and a silently wrong count is the failure mode if that ever breaks.
            let mut foreign = false;
            scan_visit(store, label, |i| {
                if present[i] {
                    match super::distinct::temporal_struct_key(data[i]) {
                        Some(k) => {
                            seen.insert(k);
                        }
                        None => foreign = true,
                    }
                }
            });
            if foreign {
                return None;
            }
            seen.len()
        }
        _ => return None, // Duration / Gen → the general aggregate
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
    let agg = sole_agg(keys, aggs)?;
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
) -> (f64, u64, f64, f64, u64, u64) {
    let (mut cnt, mut rows) = (0u64, 0u64);
    scan_visit(store, label, |i| {
        rows += 1;
        if present[i] {
            cnt += 1;
        }
    });
    (0.0, cnt, f64::INFINITY, f64::NEG_INFINITY, rows, 0)
}

#[inline(never)]
fn scan_fold_sum(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
) -> (f64, u64, f64, f64, u64, u64) {
    let (mut sum, mut cnt, mut rows) = (0.0f64, 0u64, 0u64);
    scan_visit(store, label, |i| {
        rows += 1;
        if present[i] {
            sum += data[i];
            cnt += 1;
        }
    });
    (sum, cnt, f64::INFINITY, f64::NEG_INFINITY, rows, 0)
}

#[inline(never)]
fn scan_fold_minmax(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
) -> (f64, u64, f64, f64, u64, u64) {
    let (mut cnt, mut mn, mut mx, mut rows, mut nan_cnt) =
        (0u64, f64::INFINITY, f64::NEG_INFINITY, 0u64, 0u64);
    scan_visit(store, label, |i| {
        rows += 1;
        if present[i] {
            let x = data[i];
            cnt += 1;
            nan_cnt += u64::from(x.is_nan());
            if x < mn {
                mn = x;
            }
            if x > mx {
                mx = x;
            }
        }
    });
    (0.0, cnt, mn, mx, rows, nan_cnt)
}

#[inline(never)]
fn scan_fold_all(
    store: &Store,
    label: &Option<String>,
    data: &[f64],
    present: &[bool],
) -> (f64, u64, f64, f64, u64, u64) {
    let (mut sum, mut cnt, mut mn, mut mx, mut rows, mut nan_cnt) =
        (0.0f64, 0u64, f64::INFINITY, f64::NEG_INFINITY, 0u64, 0u64);
    scan_visit(store, label, |i| {
        rows += 1;
        if present[i] {
            let x = data[i];
            sum += x;
            cnt += 1;
            nan_cnt += u64::from(x.is_nan());
            if x < mn {
                mn = x;
            }
            if x > mx {
                mx = x;
            }
        }
    });
    (sum, cnt, mn, mx, rows, nan_cnt)
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
        let folded: Vec<(f64, u64, f64, f64, u64)> = groups
            .iter()
            .map(|&(ptr, want_sum, want_minmax)| {
                let (data, present) = specs
                    .iter()
                    .find_map(|(c, _)| c.filter(|(d, _)| d.as_ptr() == ptr))
                    .expect("group came from a spec");
                let (sum, cnt, mn, mx, r, nan_cnt) = match (want_sum, want_minmax) {
                    (false, false) => scan_fold_cnt(store, label, present),
                    (true, false) => scan_fold_sum(store, label, data, present),
                    (false, true) => scan_fold_minmax(store, label, data, present),
                    (true, true) => scan_fold_all(store, label, data, present),
                };
                rows = r;
                (sum, cnt, mn, mx, nan_cnt)
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
                let (sum, cnt, mn, mx, nan_cnt) = folded[i];
                // NaN is COUNTED, not compared — `try_scan_num_agg`'s long note has the whole
                // argument. Until item 1161 these two arms read `mn`/`mx` straight out of a
                // plain `<`/`>` fold whose comment claimed "stored Nums are finite", and a
                // stored NaN (`SET n.v = sqrt(0 - 1)`) was silently skipped: `max` answered 5.0
                // where the single-agg spelling of the same query answered NaN.
                let v = match func {
                    AggFn::Count => Value::Num(cnt as f64),
                    AggFn::Sum => Value::Num(sum),
                    AggFn::Avg if cnt == 0 => Value::Null,
                    AggFn::Avg => Value::Num(sum / cnt as f64),
                    AggFn::Min if cnt == 0 => Value::Null,
                    // All NaN and nothing else: every NaN ties, so the min IS NaN.
                    AggFn::Min if cnt == nan_cnt => Value::Num(f64::NAN),
                    AggFn::Min => Value::Num(mn),
                    AggFn::Max if cnt == 0 => Value::Null,
                    // One NaN is enough: NaN is the greatest value in the total order.
                    AggFn::Max if nan_cnt > 0 => Value::Num(f64::NAN),
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

/// The NON-NUMERIC twin of [`try_scan_multi_agg`] (item 1188): two or more aggregates over a bare
/// `Scan` where at least one `min`/`max` reads a `Str`, `Dict`, `Bool` or `Temporal` column.
///
/// WHY IT EXISTS. The entry above admits `Min`/`Max` beside `Sum`/`Avg` and destructures
/// `Column::Num` alone, so adding a second extremum to a query made it **3.40x (str) / 7.39x
/// (date) / 31.80x (dict) / 8332x (bool)** the SINGLE-aggregate `min(k)` that items 1172/1175/841
/// already answer fast (item 1187 measured it). Same answer either way — the shape of every
/// index-seeding bug the spelling probe exists to catch.
///
/// HOW: by DISPATCHING each aggregate to the single-aggregate arm that already serves it, then
/// assembling the columns. No new fold code at all, which matters twice over — those arms are
/// already covered by their own oracles and mutation passes, and item 471 measured that **N passes
/// over one column each BEAT one interleaved pass** (5.6 ms against 0.6 for `sum(age), max(w2)` at
/// 1,000,000 nodes), because each pass is a sequential walk of a single slice whose work is known
/// before it starts. So splitting is the faster shape here as well as the cheaper one to write.
///
/// A SEPARATE FUNCTION rather than a widening of the entry above, for item 1184's measured reason:
/// widening in place grows that function's `match` and taxes the numeric path even for queries
/// that use none of the new arms — 1.10x on a control the change could not reach. Placed AFTER it
/// in the chain, and it requires at least one NON-numeric extremum so the two never contend.
pub(super) fn try_scan_multi_agg_wide(
    input: &Plan,
    keys: &[(String, Expr)],
    aggs: &[Agg],
    store: &Store,
) -> Option<Batch> {
    if !keys.is_empty() || aggs.len() < 2 || !matches!(input, Plan::Scan { .. }) {
        return None;
    }
    // `any_wide` is the gate that keeps this off the numeric entry's shapes: an all-numeric pair
    // is answered above, in one pass per distinct column.
    let mut any_wide = false;
    for agg in aggs {
        if agg.distinct {
            return None;
        }
        match (agg.func, agg.arg.as_ref()) {
            (AggFn::Count, None) => {} // count(*)
            (AggFn::Count | AggFn::Min | AggFn::Max, Some(Expr::Prop { slot: 0, key })) => {
                match store.column(key)? {
                    Column::Num { .. } => {}
                    // A mixed column's extremum crosses type ranks and belongs to the general
                    // fold, exactly as in the single-aggregate arms.
                    Column::Gen { .. } => return None,
                    _ => any_wide = true,
                }
            }
            // `Sum`/`Avg` are numeric BY NATURE, so they stay with the entry above rather than
            // being declined for a representation reason.
            _ => return None,
        }
    }
    if !any_wide {
        return None;
    }
    let mut cols: Vec<Col> = Vec::with_capacity(aggs.len());
    for agg in aggs {
        let one = [agg.clone()];
        let b = try_scan_num_agg(input, keys, &one, store)
            .or_else(|| try_scan_str_agg(input, keys, &one, store))
            .or_else(|| try_scan_bool_agg(input, keys, &one, store))
            .or_else(|| try_scan_temporal_agg(input, keys, &one, store))
            .or_else(|| try_scan_count_prop(input, keys, &one, store))
            .or_else(|| try_scan_count(input, keys, &one, store))?;
        // Each arm answers a SOLE aggregate, so a batch of any other width means an arm changed
        // shape under us; decline rather than assemble something misaligned.
        if b.slots.len() != 1 {
            return None;
        }
        cols.push(b.slots.into_iter().next()?);
    }
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
    let agg = sole_agg(keys, aggs)?;
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
    let agg = sole_agg(keys, aggs)?;
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
    // **0.74x SLOWER** than the arm that already answers it. Three hops gains at both (4.21 ->
    // 0.77 at the end, 1.21 -> 0.73 at an interior). Same shape of answer as item 301's.
    //
    // 🛑 AND THE FIRST POSITION IS ADMITTED TOO (item 748), which item 306 never measured. Its
    // table has rows for UNGATED and for a gate at the LAST position only, and the condition it
    // produced — `gates[hops].is_some()` — excluded the start and the interior TOGETHER. But item
    // 309, nine items later, established that a start gate is this sweep's BEST case: it reverses
    // a chain precisely to turn an end gate into a start one, 0.80ms against 0.29. So the excluded
    // case was the good one.
    //
    // The cost of that omission, read off `bun run bench`'s own row: `count 2-hop + start filter`
    // was **3.3x SLOWER than the 3-hop with the same filter** — 5x the work in a fifth of the time,
    // an ordering impossible on its face (item 699's rule for reading a sweep). Admitting it:
    // three alternated rounds **13.6/15.7/14.6 -> 3.3/3.3/3.3, 4.12x, disjoint**, with the mid-gate
    // row (16.5-17.2 both arms) and the end-gate row (3.3-3.4 both arms) flat as the controls that
    // matter — the first is the case still excluded, the second the case already taken.
    //
    // A WIN AT EVERY SIZE, which is what distinguishes this from inverting 306's verdict rather
    // than completing it. In-process, 2-hop + start filter, before -> after: 5,000 vertices
    // 0.6 -> 0.1; 20,000 1.8 -> 0.4; 50,000 6.3 -> 1.0; 200,000 26.3 -> 4.1. The interior case
    // keeps 306's exclusion, because 306 measured it and this does not.
    let take = match hops {
        0 | 1 => false,
        2 | 3 => chain.gates.iter().any(Option::is_some),
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
    let agg = sole_agg(keys, aggs)?;
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
    let agg = sole_agg(keys, aggs)?;
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
