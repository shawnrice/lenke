//! `ORDER BY`, paging and `DISTINCT BY` — everything that needs a comparison between rows.
//!
//! `row_cmp`/`sort_idx` are the comparison core and use a TOTAL order (NaN last, NaN == NaN) so
//! sorted output is byte-identical across engines, which is deliberately NOT the predicate
//! semantics (where NaN stays JS-unordered). `try_scan_top_k` and `try_late_materialize` are the
//! fast paths that avoid sorting whole rows; `order_page` applies SKIP/LIMIT.
//!
//! Tie order under `ORDER BY` is PINNED between the engines (measured), so a change to how ties
//! fall is a cross-engine divergence even though the ordering key is unchanged.

use super::*;
use crate::batch::{Batch, Col};
use crate::ir::Expr;
use crate::store::{Column, Store};
use crate::value::{self, Value};

/// Keep the rows of `batch` whose key (the `key_slots` tuple) is seen for the FIRST
/// time, threading the seen-set across calls (streamed dedup). A SINGLE node/edge key
/// slot (`typed`) deduplicates by raw `u32` id — no per-row byte-key serialization,
/// which dominated `dedup()` over a big fan-out; `value_at(Col::Nodes)` is `Node(id)`
/// so a node's group key IS its id, keeping it byte-identical.
/// A first-seen set over DENSE element ids: a bit per id, plus one flag for the `u32::MAX`
/// OPTIONAL sentinel (which would otherwise size the bitmap by four billion).
///
/// Replaces a `FnvSet<u32>`, whose hash-per-row WAS the cost of a typed `dedup` —
/// `plan_cost_by_operator` measured 15.58ns a row over 200,000 rows, 21x the scan floor and
/// indistinguishable from deduping the WHOLE row by serialized bytes (14.90ns). The byte keys
/// had already been removed here; the hash had not.
///
/// `insert` returns true when the id is NEWLY seen, exactly as `FnvSet::insert` does, so
/// first-seen order is unchanged. The bitmap grows on demand rather than being sized from the
/// store, so it is correct for a node frontier and an edge frontier alike without being told
/// which it has.
///
/// The sentinel flag is a RESOURCE guard, not a correctness one: keyed as a raw id, `u32::MAX`
/// gives the same ANSWER (fresh once, then seen) while resizing the bitmap to 67 million words
/// — 536 MB for one row. Removing the branch leaves every test green, which is why the thing
/// pinned below is the word count rather than the answer.
#[derive(Default)]
pub(super) struct SeenIds {
    bits: Vec<u64>,
    sentinel: bool,
}

impl SeenIds {
    /// How many 64-bit words the bitmap holds — the resource claim the sentinel flag makes.
    #[cfg(test)]
    pub(super) fn words(&self) -> usize {
        self.bits.len()
    }

    pub(super) fn insert(&mut self, id: u32) -> bool {
        if id == u32::MAX {
            return !std::mem::replace(&mut self.sentinel, true);
        }
        let (word, bit) = (id as usize / 64, id as usize % 64);
        if word >= self.bits.len() {
            self.bits.resize(word + 1, 0);
        }
        let mask = 1u64 << bit;
        let fresh = self.bits[word] & mask == 0;
        self.bits[word] |= mask;
        fresh
    }
}

pub(super) fn distinct_by_keep(
    batch: &Batch,
    key_slots: &[usize],
    typed: bool,
    seen_ids: &mut SeenIds,
    seen_bytes: &mut FnvSet<Vec<u8>>,
) -> Vec<usize> {
    let mut keep = Vec::new();
    if typed {
        let ids: &[u32] = match batch.slot(key_slots[0]) {
            Col::Nodes(v) | Col::Edges(v) => v,
            _ => unreachable!("typed only when the single key slot is Nodes/Edges"),
        };
        for (i, &id) in ids.iter().enumerate() {
            if seen_ids.insert(id) {
                keep.push(i);
            }
        }
    } else {
        let mut buf = Vec::new();
        for i in 0..batch.rows() {
            buf.clear();
            for &s in key_slots {
                value::group_key_into(&batch.slot(s).value_at(i), &mut buf);
            }
            if seen_bytes.insert(buf.clone()) {
                keep.push(i);
            }
        }
    }
    keep
}

/// Whether `batch`'s single key slot is a node/edge column (so `distinct_by_keep` can
/// key by raw `u32`).
pub(super) fn distinct_by_typed(batch: &Batch, key_slots: &[usize]) -> bool {
    key_slots.len() == 1 && matches!(batch.slot(key_slots[0]), Col::Nodes(_) | Col::Edges(_))
}

/// UNCAPPED `dedup` (`Plan::DistinctBy`) over a streamable chain with BOUNDED memory:
/// stream the source in blocks through the chain, deduping incrementally on `key_slots`
/// into a global key set and keeping only the first occurrence of each key. A high
/// fan-out (`both().both()…`) that dedups down to ≤ node_count distinct keys never
/// materializes the exploding frontier — the peak is one block's expansion plus the
/// distinct rows. Blocks run in source-id order, so first-occurrence order (hence the
/// result) is byte-identical to materialize-then-dedup. Gated to a large estimated
/// input and `!track` (lineage would need the full path); `None` otherwise.
pub(super) fn try_distinct_by_streamed(
    inner: &Plan,
    key_slots: &[usize],
    store: &Store,
    track: bool,
) -> Result<Option<Batch>, String> {
    if track {
        return Ok(None); // a path-reading dedup keeps the full lineage — slow path
    }
    if !crate::cost::prefer_bounded_memory(inner, store, &crate::cost::Budget::default_budget()) {
        return Ok(None); // small intermediate → materializing is cheaper than blocking
    }
    let Some((body, ids)) = streaming_chain(inner, store) else {
        return Ok(None);
    };
    if ids.is_empty() {
        return Ok(None);
    }
    // A fixed block bounds the peak intermediate (block × fan-out) without the
    // early-stop adaptive sizing the capped streamers need (here we scan everything).
    const BLOCK: usize = 2048;
    let mut seen_ids = SeenIds::default();
    let mut seen_bytes: FnvSet<Vec<u8>> = FnvSet::default();
    let mut typed: Option<bool> = None;
    let mut acc: Vec<Batch> = Vec::new();
    let mut start = 0usize;
    while start < ids.len() {
        let end = (start + BLOCK).min(ids.len());
        let b = pull_body(
            &body,
            store,
            &Batch::single(Col::Nodes(ids[start..end].to_vec())),
        )?;
        let t = *typed.get_or_insert_with(|| distinct_by_typed(&b, key_slots));
        let keep = distinct_by_keep(&b, key_slots, t, &mut seen_ids, &mut seen_bytes);
        acc.push(b.gather(&keep));
        start = end;
    }
    Ok(Some(concat_batches(&acc, store)))
}

// See the doc on the static inside.
#[cfg(test)]
thread_local! {
    /// Forces every key comparison through the boxed `value_at` path. Flipped by the tests so
    /// ONE process can sort the same data both ways, which is the only way to check that the
    /// in-place comparison agrees with the one it replaced (item 627).
    ///
    /// **THREAD-LOCAL, not a global**, for the reason spelled out on `exec::FORCE_PER_ROW`:
    /// `cargo test` runs tests in parallel threads, and a global switch is read by whatever else
    /// is running at the time.
    pub(crate) static FORCE_BOXED_CMP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether the boxed path has been forced on THIS thread -- a `const false` outside tests.
fn force_boxed_cmp() -> bool {
    #[cfg(test)]
    {
        FORCE_BOXED_CMP.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        false
    }
}

/// Compare row `a` to row `b` within ONE key column WITHOUT boxing either cell, or `None`
/// when that cannot be done faithfully and the caller must fall back to `value_at`.
///
/// Each arm is the same ordering `cmp_total` would reach for the `Value` that `value_at`
/// would have built, which is what makes the fast path byte-identical rather than merely
/// similar: `Col::Num` -> `Value::Num` -> `cmp_num_total`; `Col::Str` -> `Value::Str` ->
/// `Arc<str>::cmp`, which delegates to `str`; `Col::Bool` -> `Value::Bool` -> `bool::cmp`.
///
/// Two cases decline, and both are about NULL rather than about types:
/// - `Col::Gen` is the only column that can hold an arbitrary value, NULL among them, and
///   null PLACEMENT depends on `nulls_first` — which belongs to the key, not the column.
/// - `Col::Nodes`/`Col::Edges` carry the OPTIONAL `u32::MAX` sentinel, which `value_at` reads
///   back as NULL. A pair clear of the sentinel is an ordinary id comparison (`value_at`
///   would make two `Value::Num`s of the ids and `cmp_num_total` would order them exactly as
///   `u32::cmp` does); a pair touching it needs the null rule, so it declines.
fn cmp_cell(col: &Col, a: usize, b: usize) -> Option<std::cmp::Ordering> {
    if force_boxed_cmp() {
        return None;
    }
    Some(match col {
        Col::Num(v) => value::cmp_num_total(v[a], v[b]),
        Col::Str(v) => v[a].cmp(&v[b]),
        Col::Bool(v) => v[a].cmp(&v[b]),
        // No `Col::Nodes`/`Col::Edges` arm, and that is not an omission: a sort key that
        // resolves to a graph element is replaced by its EXTERNAL ID
        // (`element_col_to_ext_id`) before the comparator is reached, or faults under
        // Gremlin's `order()`. An arm here was written, measured as never once entered over
        // the whole differential fixture, and removed -- it would be dead code carrying an
        // untestable null-sentinel guard.
        _ => return None,
    })
}

/// Compare two rows by the sort keys only (`Equal` on a full tie). NULL placement
/// is the front-end's language contract (GQL last, Gremlin first), decided here
/// BEFORE the total order (not by reversing `cmp_total` under DESC).
#[inline]
fn row_cmp(
    key_cols: &[Col],
    keys: &[crate::ir::SortKey],
    a: usize,
    b: usize,
) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    for (kc, k) in key_cols.iter().zip(keys) {
        // IN PLACE first (item 627). `value_at` boxes a `Value` per cell -- two per column
        // per comparison, and for a `Col::Str` that is two `Arc` clones (an atomic
        // increment each) to answer a question about the bytes they point at. A typed
        // column can be compared without materializing anything, and `cmp_cell` returns
        // `None` for exactly the cases where that is not true.
        if let Some(o) = cmp_cell(kc, a, b) {
            let ord = if k.descending { o.reverse() } else { o };
            if ord != Ordering::Equal {
                return ord;
            }
            continue;
        }
        let (va, vb) = (kc.value_at(a), kc.value_at(b));
        let ord = match (va.is_null(), vb.is_null()) {
            (true, true) => Ordering::Equal,
            (true, false) => {
                if k.nulls_first {
                    Ordering::Less
                } else {
                    Ordering::Greater
                }
            }
            (false, true) => {
                if k.nulls_first {
                    Ordering::Greater
                } else {
                    Ordering::Less
                }
            }
            (false, false) => {
                let o = value::cmp_total(&va, &vb);
                if k.descending {
                    o.reverse()
                } else {
                    o
                }
            }
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    Ordering::Equal
}

/// Order `idx` (initially `0..idx.len()`) by `keys` so that `idx[..end]` are the
/// `end` rows the sort window needs, correctly ordered. When `end < n` only the
/// top-`end` are selected (partition + partial sort — O(n) + O(end log end)); the
/// full case keeps a stable sort (ties keep arrival order). A single numeric key
/// compares raw f64 via `cmp_num_total` (no per-comparison `value_at` boxing).
fn sort_idx(idx: &mut [usize], key_cols: &[Col], keys: &[crate::ir::SortKey], end: usize) {
    let n = idx.len();
    if keys.is_empty() {
        return;
    }
    if let [Col::Num(vals)] = key_cols {
        // Col::Num carries no nulls, so null placement is moot; an arrival-index
        // tiebreak makes the order total (deterministic, == the stable sort on ties).
        // Sort (key, index) PAIRS so each comparison reads the f64 INLINE — the index-only
        // sort loads `vals[a]`/`vals[b]` (random) on every compare and cache-misses; carrying
        // the key with the index does one gather, then compares locally. Same value-then-
        // index order → byte-identical.
        let desc = keys[0].descending;
        let mut pairs: Vec<(f64, usize)> = idx.iter().map(|&i| (vals[i], i)).collect();
        let cmp = |a: &(f64, usize), b: &(f64, usize)| {
            let o = if desc {
                value::cmp_num_total(b.0, a.0)
            } else {
                value::cmp_num_total(a.0, b.0)
            };
            o.then(a.1.cmp(&b.1))
        };
        if end < n {
            pairs.select_nth_unstable_by(end - 1, cmp);
            pairs[..end].sort_unstable_by(cmp);
        } else {
            pairs.sort_unstable_by(cmp);
        }
        for (slot, p) in idx.iter_mut().zip(&pairs) {
            *slot = p.1;
        }
    } else if let [Col::Str(vals)] = key_cols {
        // A single string key: compare the `Arc<str>` cells directly (lexicographic,
        // == `cmp_total` for strings) instead of boxing each cell through `value_at`.
        // Col::Str carries no nulls; the arrival-index tiebreak keeps it total/stable.
        let desc = keys[0].descending;
        let cmp = |&a: &usize, &b: &usize| {
            let o = if desc {
                vals[b].as_ref().cmp(vals[a].as_ref())
            } else {
                vals[a].as_ref().cmp(vals[b].as_ref())
            };
            o.then(a.cmp(&b))
        };
        if end < n {
            idx.select_nth_unstable_by(end - 1, cmp);
            idx[..end].sort_unstable_by(cmp);
        } else {
            idx.sort_unstable_by(cmp);
        }
    } else if end < n {
        let total = |&a: &usize, &b: &usize| row_cmp(key_cols, keys, a, b).then(a.cmp(&b));
        idx.select_nth_unstable_by(end - 1, total);
        idx[..end].sort_unstable_by(total);
    } else {
        idx.sort_by(|&a, &b| row_cmp(key_cols, keys, a, b));
    }
}

/// Below how many nodes the NUMERIC streaming top-K is not worth taking.
///
/// Item 867 measured it as a net LOSS at small-to-middling sizes and a win only once the data stops
/// being cache-resident — the transition this repo's bench notes already name as "between 200k and
/// 1M elements". Generic path vs streaming, min of alternated rounds, `ORDER BY p.age LIMIT 10`:
///
/// ```text
///   nodes      streaming   generic    winner
///     200,000      1.251     0.976    generic, 1.28x
///     300,000      1.898     1.466    generic, 1.29x
///     500,000      3.201     2.708    generic, 1.18x
///     600,000      4.068     4.382    streaming, 1.08x
///     700,000      4.399     5.529    streaming, 1.26x
///   1,000,000      6.324     6.648    streaming, 1.05x
///   4,000,000     25.780    30.825    streaming, 1.20x
/// ```
///
/// Taking the gap at ONE size would have deleted the path (it reads as a clean 1.28x loss at 200k)
/// or kept it everywhere (a clean 1.20x win at 4M). Both readings are wrong, and the sweep is the
/// only thing that shows it. The mechanism is the generic path's three N-sized allocations — the
/// frontier, an `f64` key column and a `usize` index array — which are cheaper than a streaming
/// buffer's per-row tuple plus a `select_nth` every 1024 pushes while they fit in cache, and more
/// expensive once they do not.
///
/// THE CONSTANT IS TUNED ON ONE MACHINE. The crossover is where ~N x 20 bytes stops fitting in
/// this box's L3, so a machine with a different cache will cross somewhere else. It is a
/// performance route and never an answer, so a mis-tuned value costs time and nothing else.
const NUM_TOP_K_MIN_NODES: usize = 600_000;

/// Whether a numeric streaming top-K beats the generic path at this size — see
/// [`NUM_TOP_K_MIN_NODES`] for the measurements. A pure predicate because the choice is
/// ANSWER-EQUIVALENT: both routes return identical rows, so no correctness test can tell which
/// ran, and item 866 watched a mutant disabling exactly this kind of route survive a whole suite.
/// Tested directly in `num_top_k_gate`.
fn num_top_k_worthwhile(node_count: usize) -> bool {
    node_count >= NUM_TOP_K_MIN_NODES
}

/// STREAMING TOP-K for `ORDER BY <numeric prop> [DESC] LIMIT k` over a bare `Scan`:
/// instead of materializing the whole frontier + key column + an index array and then
/// partial-sorting (what `order_page` does on a pulled batch), scan the nodes once,
/// reading the key sequentially, and keep only the best `skip+limit` in a bounded buffer
/// (periodically trimmed with `select_nth`). O(N) time, O(k) space — matching the TS engine's
/// streaming heap. Returns the top-K rows as the OrderPage output (a single `Col::Nodes`
/// in sort order), so a `Project` above it builds its columns for K rows, not N.
///
/// `None` (fall back to `order_page`) for anything outside the narrow shape: lineage
/// tracking, a non-`Scan` input, a multi-key / non-`Prop(slot 0)` sort, a non-numeric or
/// null-bearing key column (the ordering with nulls goes through the general path), or a
/// window that is not a small prefix (streaming buys nothing near a full sort).
pub(super) fn try_scan_top_k(
    input: &Plan,
    keys: &[crate::ir::SortKey],
    skip: Option<usize>,
    limit: Option<usize>,
    store: &Store,
    track: bool,
) -> Option<Batch> {
    if track {
        return None; // a path/lineage sort is not this shape
    }
    let limit = limit?;
    let [k] = keys else { return None };
    let Expr::Prop { slot: 0, key } = &k.expr else {
        return None;
    };
    let Plan::Scan { label } = input else {
        return None;
    };
    if !num_top_k_worthwhile(store.node_count()) {
        // Below the crossover the GENERIC path is faster; see `num_top_k_worthwhile`.
        return match store.column(key) {
            Some(Column::Num { .. }) => None,
            // Item 1020: a temporal column has its own streaming arm, for the reasons
            // `try_scan_top_k_temporal` documents.
            Some(Column::Temporal { data, present, .. }) => {
                try_scan_top_k_temporal(data, present, label, k, skip, limit, store)
            }
            Some(column) => try_scan_top_k_wide(column, label, k, skip, limit, store),
            None => None,
        };
    }
    let column = store.column(key)?;
    if let Column::Temporal { data, present, .. } = column {
        // Item 1020, placed BEFORE the numeric destructure so the numeric body below stays
        // byte-for-byte what item 864 left (its own note asks for exactly that).
        return try_scan_top_k_temporal(data, present, label, k, skip, limit, store);
    }
    let Column::Num { data, present, .. } = column else {
        // Item 864: every OTHER representation used to stop here, so a string or dictionary key
        // fell back to `order_page` — which decodes a `Dict` column into a whole `Col::Str`
        // (200,000 `Arc` clones to answer a question about ten rows). Handled separately rather
        // than by generalizing the numeric body: item 844 shipped a 1.6x regression on the `min`
        // CONTROL by giving two arms a shared live range, so the numeric path below is left
        // byte-for-byte alone.
        return try_scan_top_k_wide(column, label, k, skip, limit, store);
    };
    let kcap = skip.unwrap_or(0).checked_add(limit)?;
    if kcap == 0 {
        return Some(Batch::of(vec![Col::Nodes(Vec::new())]));
    }
    if kcap.saturating_mul(2) >= store.node_count() {
        return None; // window is not a small prefix — a full sort is as cheap
    }
    let desc = k.descending;
    // Sort order as `order_page`'s Col::Num path: key asc/desc, then arrival (row order)
    // ascending as a total tiebreak. `cmp` "less" = ranks earlier = keep.
    let cmp = |a: &(f64, u32, u32), b: &(f64, u32, u32)| {
        let o = if desc {
            value::cmp_num_total(b.0, a.0)
        } else {
            value::cmp_num_total(a.0, b.0)
        };
        o.then(a.1.cmp(&b.1))
    };
    let trim = kcap.saturating_mul(4).max(1024);
    let mut buf: Vec<(f64, u32, u32)> = Vec::with_capacity(trim);
    let mut arrival = 0u32;
    let mut has_null = false;
    scan_visit(store, label, |i| {
        if !present[i] {
            has_null = true; // key ordering with nulls → general path
            return;
        }
        buf.push((data[i], arrival, i as u32));
        arrival += 1;
        if buf.len() >= trim {
            buf.select_nth_unstable_by(kcap - 1, cmp);
            buf.truncate(kcap);
        }
    });
    if has_null {
        return None;
    }
    let end = kcap.min(buf.len());
    if end < buf.len() {
        buf.select_nth_unstable_by(end - 1, cmp);
        buf.truncate(end);
    }
    buf.sort_unstable_by(cmp);
    let start = skip.unwrap_or(0).min(buf.len());
    Some(Batch::of(vec![Col::Nodes(
        buf[start..].iter().map(|&(_, _, n)| n).collect(),
    )]))
}

/// STREAMING TOP-K for a `Str` or `Dict` key (item 864). Two different wins under one roof:
///
/// - **`Str`**: stream the key and keep a bounded buffer, exactly as the numeric path does. Saves
///   materializing the frontier, a 200,000-entry `Col::Str` (an `Arc` clone per row) and an index
///   array to return ten rows. Priced at 1.7x — the fallback already partial-sorts, so this is the
///   materialization only, NOT a sort that was being avoided.
/// - **`Dict`**: the key is replaced by its RANK in the sorted dictionary, which makes the top-K
///   bounded below (ASC) or above (DESC) by a value known before the scan starts. Once `skip+limit`
///   rows at that extreme rank have been seen — and the scan runs in arrival order, which is the
///   total order's own tiebreak — nothing later can displace them, so the scan STOPS. Priced at
///   15.4x on an 8-way column.
///
/// NULLs are skipped rather than disqualifying the whole path (the numeric arm bails on the first
/// one). That is sound only for a nulls-LAST key, so `nulls_first` declines: null placement is the
/// front-end's contract and is decided BEFORE the total order, so it is not reversed by `DESC`, and
/// a null that sorts FIRST could outrank rows this path would never look at. If the scan ends with
/// fewer than `skip+limit` non-null rows the nulls are inside the window after all, and it declines
/// so the general path can place them.
/// The streaming top-K for a packed TEMPORAL column (item 1020).
///
/// **Why this is a separate function and not an arm of `try_scan_top_k_wide`.** That function's
/// buffer is `(u32 rank, u32 arrival, u32 node)` and its comparator ranks on a `u32`; a temporal
/// has no bounded rank that fits one. It could be mapped to a wider integer, but then the ORDER
/// would be a re-derivation of `Temporal::cmp_total` rather than that function — and a sort key
/// that is subtly not the general path's order is a wrong ANSWER, not a slow one. So the buffer
/// carries the `Temporal` itself (`Copy`, at most 24 bytes) and compares with `cmp_total`
/// directly, which makes the order identical BY CONSTRUCTION.
///
/// Separate also because item 844 shipped a 1.6x regression on an unrelated `min` control by
/// giving two arms a shared live range, and item 864's numeric path carries a note to leave it
/// byte-for-byte alone for that reason. A new function shares nothing.
///
/// NO EARLY EXIT, unlike the dictionary arm. That arm knows the extreme rank from the dict and can
/// stop once `kcap` rows at it are seen; a temporal column has no such bound, exactly as the
/// numeric path has none. What it gets is the same stream-and-trim: O(N) time, O(kcap) space,
/// against `order_page`'s materialize-the-frontier-and-partial-sort.
///
/// Measured (`temporal_distinct_1015`'s `topk` column, 200,000 rows, 1,000 distinct):
///
/// ```text
///   kind        PRE (order_page)   num control   full-sort ceiling
///   date               5,962 us        1,239 us          56,760 us
///   datetime           6,013          (same)             56,269
/// ```
fn try_scan_top_k_temporal(
    data: &[crate::temporal::Temporal],
    present: &[bool],
    label: &Option<String>,
    k: &crate::ir::SortKey,
    skip: Option<usize>,
    limit: usize,
    store: &Store,
) -> Option<Batch> {
    if k.nulls_first {
        // Same precondition as `try_scan_top_k_wide`'s: skipping nulls is only sound when they
        // sort LAST. See that function for why the guard is unexercised rather than verified.
        return None;
    }
    let kcap = skip.unwrap_or(0).checked_add(limit)?;
    if kcap == 0 {
        return Some(Batch::of(vec![Col::Nodes(Vec::new())]));
    }
    if kcap.saturating_mul(2) >= store.node_count() {
        return None; // window is not a small prefix — a full sort is as cheap
    }
    let desc = k.descending;
    // `cmp_total` is the ordering `order_page` applies to a temporal (via `value::cmp_total`,
    // which only dispatches to it), then arrival ascending as the row-order tiebreak — the same
    // total order the other arms use.
    let cmp = |a: &(crate::temporal::Temporal, u32, u32),
               b: &(crate::temporal::Temporal, u32, u32)| {
        let o = if desc {
            b.0.cmp_total(&a.0)
        } else {
            a.0.cmp_total(&b.0)
        };
        o.then(a.1.cmp(&b.1))
    };
    let trim = kcap.saturating_mul(4).max(1024);
    let mut buf: Vec<(crate::temporal::Temporal, u32, u32)> = Vec::with_capacity(trim);
    let mut arrival = 0u32;
    let mut nulls_seen = false;

    fastpath::scan_visit(store, label, |i| {
        if !present[i] {
            nulls_seen = true;
            return;
        }
        buf.push((data[i], arrival, u32::try_from(i).unwrap_or(u32::MAX)));
        arrival += 1;
        if buf.len() >= trim {
            buf.select_nth_unstable_by(kcap - 1, cmp);
            buf.truncate(kcap);
        }
    });

    if nulls_seen && buf.len() < kcap {
        return None; // nulls are inside the window — the general path places them
    }
    let end = kcap.min(buf.len());
    if end < buf.len() {
        buf.select_nth_unstable_by(end - 1, cmp);
        buf.truncate(end);
    }
    buf.sort_unstable_by(cmp);
    let start = skip.unwrap_or(0).min(buf.len());
    Some(Batch::of(vec![Col::Nodes(
        buf[start..].iter().map(|&(_, _, n)| n).collect(),
    )]))
}

fn try_scan_top_k_wide(
    column: &Column,
    label: &Option<String>,
    k: &crate::ir::SortKey,
    skip: Option<usize>,
    limit: usize,
    store: &Store,
) -> Option<Batch> {
    if k.nulls_first {
        // A null outranks everything, including rows an early exit would never read. This guard
        // is DEFENSIVE, and item 864 says so with evidence rather than claiming a test: removing
        // it was the one mutant of six that survived, because no front end can currently reach
        // this plan shape with nulls-first. GQL places nulls LAST always; Gremlin places them
        // first but its `order().by(k).limit(n)` does not lower to `OrderPage{Scan}` at all (four
        // spellings checked against an instrumented build, none entered this function). The guard
        // stays because it is the precondition that makes skipping nulls sound, and it costs one
        // branch per query — but it is unexercised, not verified.
        return None;
    }
    let kcap = skip.unwrap_or(0).checked_add(limit)?;
    if kcap == 0 {
        return Some(Batch::of(vec![Col::Nodes(Vec::new())]));
    }
    if kcap.saturating_mul(2) >= store.node_count() {
        return None; // window is not a small prefix — a full sort is as cheap
    }
    let desc = k.descending;
    // Rank keys, so one comparator serves both representations: ASC by rank then arrival, which
    // is `order_page`'s Col::Str path (`GStr: Ord` delegates to `str`) plus its row-order tiebreak.
    let cmp = |a: &(u32, u32, u32), b: &(u32, u32, u32)| {
        let o = if desc { b.0.cmp(&a.0) } else { a.0.cmp(&b.0) };
        o.then(a.1.cmp(&b.1))
    };
    let trim = kcap.saturating_mul(4).max(1024);
    let mut buf: Vec<(u32, u32, u32)> = Vec::with_capacity(trim);
    let mut arrival = 0u32;
    let mut nulls_seen = false;

    match column {
        Column::Dict {
            dict,
            codes,
            present,
            ..
        } => {
            if dict.is_empty() {
                return None;
            }
            // `dict` is in FIRST-APPEARANCE order, not sorted, so the code is not the rank.
            // Sorting it is O(|dict| log |dict|) over at most `dict_max_distinct` entries,
            // against the O(N) scan it bounds.
            let mut order: Vec<u32> = (0..u32::try_from(dict.len()).ok()?).collect();
            order.sort_unstable_by(|&a, &b| dict[a as usize].cmp(&dict[b as usize]));
            let mut rank = vec![0u32; dict.len()];
            for (r, &c) in order.iter().enumerate() {
                rank[c as usize] = u32::try_from(r).ok()?;
            }
            // The extreme rank is a bound on the whole column whether or not it appears among
            // the scanned rows: if it never does, the early exit simply never fires.
            let best = if desc {
                u32::try_from(dict.len() - 1).ok()?
            } else {
                0
            };
            let mut at_best = 0usize;
            fastpath::scan_visit_while(store, label, |i| {
                if !present[i] {
                    nulls_seen = true;
                    return true;
                }
                let r = rank[codes[i] as usize];
                buf.push((r, arrival, u32::try_from(i).unwrap_or(u32::MAX)));
                arrival += 1;
                if r == best {
                    at_best += 1;
                    if at_best >= kcap {
                        return false; // settled: nothing later can displace these
                    }
                }
                if buf.len() >= trim {
                    buf.select_nth_unstable_by(kcap - 1, cmp);
                    buf.truncate(kcap);
                }
                true
            });
        }
        // NO `Column::Str` ARM, and that is a measured decision, not an omission. One was
        // written and REFUTED at item 864: streaming a string key means the surviving buffer
        // carries row INDICES and every comparison loads `data[idx]` at random, which is the
        // cache behaviour the numeric path's own comment warns about. Measured against the
        // fallback over three order-alternated rounds it was 1.22x the WRONG way on ASC
        // (1.726 ms -> 2.119) while nominally helping DESC, so it was dropped. A string key has
        // no bounded rank either, so it cannot have the early exit that makes the dictionary arm
        // worth having — there is nothing left for it to win.
        _ => return None,
    }

    if nulls_seen && buf.len() < kcap {
        return None; // nulls are inside the window — the general path places them
    }
    let end = kcap.min(buf.len());
    if end < buf.len() {
        buf.select_nth_unstable_by(end - 1, cmp);
        buf.truncate(end);
    }
    buf.sort_unstable_by(cmp);
    let start = skip.unwrap_or(0).min(buf.len());
    Some(Batch::of(vec![Col::Nodes(
        buf[start..].iter().map(|&(_, _, n)| n).collect(),
    )]))
}

/// LATE MATERIALIZATION for a sorted `LIMIT` over a `Project`: when the window is
/// a strict PREFIX of the rows (`skip+limit < n`) and every sort key is an output
/// alias (`Slot(i)` into the projection), evaluate ONLY the sort-key expressions
/// over the projection's input to find the top-K rows, then project the FULL item
/// list for just those K survivors — so the non-key columns (a `name` string per
/// row, say) are built for K rows, not all N. `Ok(None)` when the shape doesn't
/// fit (no limit, input not a Project, a key that isn't a projected alias, or the
/// window is the whole set so there is nothing to save).
/// Whether a clause-position sorted LIMIT can be answered by lifting the streaming top-K onto the
/// projection's INPUT (item 866). Extracted as a PURE predicate on purpose: the lift is
/// answer-equivalent — disabling it falls back to the generic path and returns the same rows — so
/// no correctness assertion can tell whether it fired. A mutant turning it off survived the whole
/// suite, and the only thing with teeth against a route CHOICE is a direct test of the route.
/// See `top_k_lift_route`.
///
/// `true` requires: a bare `Scan` under the projection, exactly ONE sort key, that key being a
/// plain property of the scanned element, and that property's column being DICTIONARY-encoded.
/// The last condition is measured rather than conservative — lifting a NUMERIC key was a 1.28x
/// REGRESSION (0.980 ms -> 1.255, DESC 0.941 -> 1.143), because for a numeric key the generic
/// path builds one plain `f64` key column and calls `select_nth` ONCE, where the streaming buffer
/// builds a 16-byte tuple per row and trims every 1024 pushes — about 195 partial sorts at 200k
/// rows. Only the dictionary arm has the rank-bounded early exit that pays for streaming.
fn top_k_liftable(pinput: &Plan, key_exprs: &[&Expr], store: &Store) -> bool {
    if !matches!(pinput, Plan::Scan { .. }) {
        return false;
    }
    let [Expr::Prop { slot: 0, key }] = key_exprs else {
        return false;
    };
    matches!(store.column(key), Some(Column::Dict { .. }))
}

pub(super) fn try_late_materialize(
    input: &Plan,
    keys: &[crate::ir::SortKey],
    skip: Option<usize>,
    limit: Option<usize>,
    store: &Store,
    track: bool,
) -> Result<Option<Batch>, String> {
    let Some(limit) = limit else { return Ok(None) };
    if keys.is_empty() {
        return Ok(None);
    }
    let Plan::Project {
        input: pinput,
        items,
    } = input
    else {
        return Ok(None);
    };
    // Every sort key must be an output alias `Slot(i)` — map it to that item's
    // expression, so it can be evaluated over the projection's INPUT.
    let key_exprs: Option<Vec<&Expr>> = keys
        .iter()
        .map(|k| match &k.expr {
            Expr::Slot(i) => items.get(*i).map(|(_, e)| e),
            _ => None,
        })
        .collect();
    let Some(key_exprs) = key_exprs else {
        return Ok(None);
    };

    // ITEM 866: the STATEMENT spelling (`ORDER BY k LIMIT n RETURN x`) leaves a bare `Scan`
    // under the sort and reaches the streaming top-K; this CLAUSE spelling
    // (`RETURN x ORDER BY k LIMIT n`) puts a `Project` in between and used to `pull` the whole
    // base before sorting it. After item 865 gave the dictionary key a rank-bounded early exit
    // that was a ~1785x gap between two ways of writing the same query — exactly the asymmetry
    // this repo refuses to ship. So try the streaming path on the projection's INPUT first: the
    // sort key has already been mapped through the aliases above, so if it is a bare property of
    // a bare scan the same machinery applies, and the projection then runs over the K survivors
    // just as it does below.
    if top_k_liftable(pinput, &key_exprs, store) {
        let lifted = [crate::ir::SortKey {
            expr: key_exprs[0].clone(),
            descending: keys[0].descending,
            nulls_first: keys[0].nulls_first,
        }];
        if let Some(top) = try_scan_top_k(pinput, &lifted, skip, Some(limit), store, track) {
            let cols = eval_all(items.iter().map(|(_, e)| e), store, &top)?;
            return Ok(Some(Batch::of(cols)));
        }
    }

    let base = pull(pinput, store, track)?;
    let n = base.rows();
    let start = skip.unwrap_or(0).min(n);
    let end = start.saturating_add(limit).min(n);
    if start == 0 && end >= n {
        // The window is the WHOLE set (no skip, and the limit reaches the end) — a full
        // projection is unavoidable; nothing to late-materialize. With a SKIP, though, the
        // prefix `[0, start)` is dropped, so the window is NOT the whole set: late-
        // materialize still projects only `[start, end)`, which also means a fallible
        // projection never runs for a paged-out row (the reason to keep this path here).
        return Ok(None);
    }
    if end <= start {
        return Ok(Some(Batch::of(
            items.iter().map(|_| Col::Nodes(vec![])).collect(),
        )));
    }

    // Sort by the key columns evaluated over the base, take the window's rows.
    let key_cols: Vec<Col> = key_exprs
        .iter()
        .map(|e| eval(e, store, &base))
        .collect::<Result<_, _>>()?;
    let key_cols = typed_key_cols(key_cols);
    let mut idx: Vec<usize> = (0..n).collect();
    sort_idx(&mut idx, &key_cols, keys, end);
    let sub = base.gather(&idx[start..end]);

    // NOW project every item, but only over the K surviving rows.
    let cols = eval_all(items.iter().map(|(_, e)| e), store, &sub)?;
    let mut out = Batch::of(cols);
    out.lineage = sub.lineage;
    Ok(Some(out))
}

/// Sort the batch by `keys`, then keep the window `[skip, skip+limit)`. Reorders
/// every slot together, so bound variables stay row-aligned.
pub(super) fn order_page(
    batch: &Batch,
    store: &Store,
    keys: &[crate::ir::SortKey],
    skip: Option<usize>,
    limit: Option<usize>,
    fault_on_element: bool,
) -> Result<Batch, String> {
    let n = batch.rows();
    let start = skip.unwrap_or(0).min(n);
    let end = limit.map_or(n, |l| start.saturating_add(l).min(n));
    if end <= start {
        return Ok(batch.gather(&[]));
    }
    let mut idx: Vec<usize> = (0..n).collect();
    if !keys.is_empty() {
        let key_cols: Vec<Col> = eval_all(keys.iter().map(|k| &k.expr), store, batch)?;
        // A sort KEY that resolves to a graph element (a vertex/edge) has no natural order.
        // Gremlin `order()` FAULTS (TinkerPop throws) — the runtime backstop for a MIXED/branch
        // frontier the parser could not classify (`both(...).inject(1).order()`). GQL `ORDER BY
        // <element>` instead sorts by the element's EXTERNAL ID (like Cypher / the pure-TS
        // `@lenke/gql`), so `CALL algo() YIELD node … ORDER BY node` orders by id, not faults.
        let key_cols = if key_cols.iter().any(col_has_element) {
            if fault_on_element {
                return Err(
                    "order() over graph elements is not supported — elements have no \
                            natural order; use order().by('<key>')"
                        .into(),
                );
            }
            key_cols
                .into_iter()
                .map(|c| element_col_to_ext_id(c, store))
                .collect()
        } else {
            key_cols
        };
        let key_cols = typed_key_cols(key_cols);
        sort_idx(&mut idx, &key_cols, keys, end);
    }
    Ok(batch.gather(&idx[start..end]))
}

/// Replace each graph-element cell in a sort-key column with its EXTERNAL ID (a string),
/// so a GQL `ORDER BY <element>` sorts by id — matching the pure-TS engine, which orders
/// nodes/edges by their id lexicographically. A missing external id falls back to the dense
/// id as a number (defensive; live elements always have one). Non-element columns pass through.
fn element_col_to_ext_id(col: Col, store: &Store) -> Col {
    let node_key = |id: u32| {
        store
            .node_ext_id(id)
            .map_or(Value::Num(f64::from(id)), Value::Str)
    };
    let edge_key = |eid: u32| {
        store
            .edge_ext_id(eid)
            .map_or(Value::Num(f64::from(eid)), Value::Str)
    };
    match col {
        Col::Nodes(ids) => Col::Gen(ids.iter().map(|&id| node_key(id)).collect()),
        Col::Edges(eids) => Col::Gen(eids.iter().map(|&eid| edge_key(eid)).collect()),
        Col::Gen(vs) => Col::Gen(
            vs.into_iter()
                .map(|v| match v {
                    Value::Node(id) => node_key(id),
                    Value::Edge(eid) => edge_key(eid),
                    other => other,
                })
                .collect(),
        ),
        other => other,
    }
}

/// A sort-key column that carries a graph element — a `Nodes`/`Edges` slot or a `Gen`
/// column holding any `Value::Node`/`Value::Edge`. Elements have no natural order, so
/// ordering by one faults (see [`order_page`]).
/// The `otherV` reference vertex for an edge `(src, dst)` given the row's node path: the vertex
/// the traverser ARRIVED from, i.e. the node just before the edge. When the path's last node is
/// the edge's own landed endpoint (an `outE`/`inE` recorded it), the arrival is the node before
/// it; otherwise the last node is the arrival. `None` for an edge with no prior vertex.
pub(super) fn otherv_reference(nodes: &[Value], src: u32, dst: u32) -> Option<u32> {
    match nodes.last().map(num_as_u32) {
        Some(last) if (last == src || last == dst) && nodes.len() >= 2 => {
            Some(num_as_u32(&nodes[nodes.len() - 2]))
        }
        other => other,
    }
}

fn col_has_element(col: &Col) -> bool {
    match col {
        Col::Nodes(_) | Col::Edges(_) => true,
        Col::Gen(vs) => vs
            .iter()
            .any(|v| matches!(v, Value::Node(_) | Value::Edge(_))),
        _ => false,
    }
}

/// Fold a homogeneous computed key column (`Col::Gen`) into a typed one so `sort_idx`'s
/// raw-f64 / `Arc<str>` arms fire — applied ONLY at a sort, so a plain computed projection
/// keeps the cheap boxed path and does not pay the fold for nothing.
fn typed_key_cols(cols: Vec<Col>) -> Vec<Col> {
    cols.into_iter()
        .map(|c| {
            if let Col::Gen(v) = c {
                typed_col_from_values(v)
            } else {
                c
            }
        })
        .collect()
}

/// Group `batch` by `keys` and compute `aggs` per group. Output slots are the key
/// columns (one value per group, taken from each group's first row) followed by
/// the aggregate columns. Group order is first-seen: a group's index is the
/// order its first row arrived, which is the order it is emitted.
///
/// Rows are labelled with a dense group id in a single pass ([`assign_groups`]),
/// then each aggregate is a single streaming pass over that labelling — so an
/// aggregate never materializes its group's rows, and `count(*)` is a tally, not
/// a bucketed list of row indices.
/// Frontier size below which the storage-direct fold/group loses to eval-then-fold on a
/// compact column (the random `store.column[node]` reads only pay off at scale).
pub(super) const FRONTIER_FOLD_MIN: usize = 50_000;

/// First-seen grouping for a SINGLE node-PROPERTY key over a materialized batch, via the
/// typed [`frontier_group_by`] (Str/Num/Bool/Dict read off storage) — the general-batch
/// analogue of [`try_dict_grouping`]. Unlike the chain-only `try_frontier_group_fold`, it
/// works on whatever batch the aggregate already pulled (a join, a filtered frontier), so a
/// grouped aggregate over ANY shape skips the `Col::Str` + byte-key `assign_groups` pays.
/// `None` unless the sole key is `Prop{slot, <plain col>}` over a `Col::Nodes` slot backed
/// by a Str/Num/Bool/Dict column.
pub(super) fn try_node_prop_grouping(
    keys: &[(String, Expr)],
    store: &Store,
    batch: &Batch,
) -> Option<(Vec<u32>, Col, usize)> {
    // Only worth it on a LARGE frontier, where skipping the key `Col` materialization pays.
    // On a small/filtered batch the random `store.column[node]` reads lose to eval'ing a
    // compact key column then grouping it (measured: filtered grouped-aggs regressed).
    if batch.rows() < FRONTIER_FOLD_MIN {
        return None;
    }
    let [(_, Expr::Prop { slot, key })] = keys else {
        return None;
    };
    if key.contains('.') {
        return None;
    }
    let Col::Nodes(frontier) = batch.slot(*slot) else {
        return None;
    };
    let (group_of, key_out, n_groups) = frontier_group_by(store, key, frontier)?;
    Some((group_of, Col::Gen(key_out), n_groups))
}

/// Item 866: the LIFT ROUTE, tested directly. `top_k_liftable` decides whether a clause-position
/// sorted LIMIT is answered by the streaming top-K or by the generic path, and both answer
/// identically — so this choice is invisible to every correctness test in the suite (a mutant
/// disabling the lift survived all of them). These assertions are the route's only teeth.
#[cfg(test)]
mod top_k_lift_route {
    use super::{top_k_liftable, Expr, Plan};
    use crate::store::Builder;
    use crate::value::Value;

    fn store() -> crate::store::Store {
        const CY: [&str; 3] = ["bb", "aa", "cc"];
        let mut b = Builder::default();
        for i in 0..40u32 {
            b.node(
                &["T"],
                &[
                    ("c", Value::Str(CY[(i % 3) as usize].into())),
                    ("s", Value::Str(format!("s{i}").into())),
                    ("a", Value::Num(f64::from(i))),
                ],
            );
        }
        b.build()
    }

    fn prop(key: &str, slot: usize) -> Expr {
        Expr::Prop {
            slot,
            key: key.into(),
        }
    }

    #[test]
    fn lifts_only_a_dict_prop_of_a_bare_scan() {
        let st = store();
        let scan = Plan::Scan {
            label: Some("T".into()),
        };
        let c = prop("c", 0);
        let a = prop("a", 0);
        let sx = prop("s", 0);

        // the one shape that pays: a dictionary key, one key, a bare scan
        assert!(top_k_liftable(&scan, &[&c], &st), "dict prop over a scan");

        // a NUMERIC key must NOT lift — measured as a 1.28x regression, so this is the assertion
        // that keeps the restriction from being "simplified" away later
        assert!(
            !top_k_liftable(&scan, &[&a], &st),
            "numeric key must not lift"
        );
        // a plain string column has no arm in the streaming path at all
        assert!(
            !top_k_liftable(&scan, &[&sx], &st),
            "string key must not lift"
        );
        // more than one key: the streaming path is single-key only
        assert!(
            !top_k_liftable(&scan, &[&c, &a], &st),
            "multi-key must not lift"
        );
        // zero keys
        assert!(!top_k_liftable(&scan, &[], &st), "no key must not lift");
        // a property of a slot OTHER than the scanned element is not this shape
        let c1 = prop("c", 1);
        assert!(!top_k_liftable(&scan, &[&c1], &st), "slot 1 must not lift");
        // an unknown property has no column
        let missing = prop("nope", 0);
        assert!(
            !top_k_liftable(&scan, &[&missing], &st),
            "absent column must not lift"
        );
        // not a bare scan: anything else under the projection keeps the generic path
        let other = Plan::Distinct {
            input: Box::new(scan.clone()),
        };
        assert!(
            !top_k_liftable(&other, &[&c], &st),
            "only a bare Scan is liftable"
        );
    }
}

/// Item 867: the numeric top-K SIZE GATE, tested directly. Both routes return identical rows, so
/// this choice is invisible to every correctness test — the same hole item 866 found. These
/// assertions pin the measured crossover so it cannot be "simplified" to always-on (a 1.28x loss
/// at 200k) or always-off (a 1.20x loss at 4M).
#[cfg(test)]
mod num_top_k_gate {
    use super::{num_top_k_worthwhile, NUM_TOP_K_MIN_NODES};

    #[test]
    fn gate_follows_the_measured_crossover() {
        // sizes where the GENERIC path measured faster
        for n in [0, 1, 1_000, 200_000, 300_000, 500_000] {
            assert!(
                !num_top_k_worthwhile(n),
                "{n} nodes: generic measured faster, must not stream"
            );
        }
        // sizes where STREAMING measured faster
        for n in [600_000, 700_000, 1_000_000, 4_000_000, usize::MAX] {
            assert!(
                num_top_k_worthwhile(n),
                "{n} nodes: streaming measured faster, must stream"
            );
        }
        // the boundary is exactly the documented constant, inclusive
        assert!(!num_top_k_worthwhile(NUM_TOP_K_MIN_NODES.saturating_sub(1)));
        assert!(num_top_k_worthwhile(NUM_TOP_K_MIN_NODES));
    }

    /// The gate turns the NUMERIC path off below the crossover; it must NOT turn the dictionary
    /// path off with it. Both routes return the same rows, so only calling the entry point and
    /// looking at whether it CLAIMED the query can tell — a mutant that dropped the dictionary
    /// branch below the gate survived the whole suite until this existed.
    #[test]
    fn gate_keeps_the_dictionary_path_below_the_crossover() {
        use super::{try_scan_top_k, Expr, Plan};
        use crate::store::Builder;
        use crate::value::Value;

        const CY: [&str; 3] = ["bb", "aa", "cc"];
        let mut b = Builder::default();
        for i in 0..400u32 {
            b.node(
                &["T"],
                &[
                    ("c", Value::Str(CY[(i % 3) as usize].into())),
                    ("a", Value::Num(f64::from(i))),
                ],
            );
        }
        let store = b.build();
        assert!(
            !num_top_k_worthwhile(store.node_count()),
            "fixture must sit BELOW the gate or this test proves nothing"
        );
        let scan = Plan::Scan {
            label: Some("T".into()),
        };
        let key = |k: &str| {
            [crate::ir::SortKey {
                expr: Expr::Prop {
                    slot: 0,
                    key: k.into(),
                },
                descending: false,
                nulls_first: false,
            }]
        };
        // the dictionary arm has a rank-bounded early exit, so it is worth taking at ANY size
        assert!(
            try_scan_top_k(&scan, &key("c"), None, Some(5), &store, false).is_some(),
            "a dictionary key must still stream below the gate"
        );
        // the numeric arm is the one the gate turns off here
        assert!(
            try_scan_top_k(&scan, &key("a"), None, Some(5), &store, false).is_none(),
            "a numeric key must fall to the generic path below the gate"
        );
    }
}
