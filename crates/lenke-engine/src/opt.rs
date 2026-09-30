//! The rewrite-rule optimizer: meaning-preserving `Plan -> Plan` transforms on
//! the neutral IR. This is the point of having one IR — a rule is written ONCE
//! and fires on plans from either front-end (GQL or Gremlin), because by the time
//! it runs the plan no longer knows which language produced it.
//!
//! Each rule is a pure function that either rewrites a node or leaves it. The
//! [`optimize`] driver rewrites children first (bottom-up), applies the local
//! rules, and repeats to a fixpoint. Every rule is tested two ways: the result
//! ROWS are unchanged (run original vs optimized, compare as bags) and the plan
//! SHAPE changed as intended.

use crate::ir::{CompareOp, Expr, Plan};
use crate::store::Store;
use crate::value::Value;

/// Frontier width of a PURE Scan/Expand chain — `Some(width)` when `plan` is only
/// seeds and expands (so every one of its slots is a bound node/edge element), else
/// `None`. Mirrors `exec::chain_width`; kept here so the optimizer can prove "every
/// slot is an element" without reaching into exec. A `bind_edge` Expand appends two
/// slots (edge then node); anything else (Filter/Project/Aggregate/…) is not a pure
/// chain, so a slot there might be a projected scalar — hence `None`.
fn pure_chain_width(plan: &Plan) -> Option<usize> {
    match plan {
        Plan::Scan { .. } | Plan::IndexSeek { .. } | Plan::RangeSeek { .. } => Some(1),
        Plan::Expand {
            input, bind_edge, ..
        } => Some(pure_chain_width(input)? + if *bind_edge { 2 } else { 1 }),
        _ => None,
    }
}

/// What the planner may know about the store's PHYSICAL indexes, so a seed rule can
/// prefer a conjunct backed by a real index over one that would only scan. Kept
/// abstract (not `&Store`) so the optimizer stays a pure `Plan -> Plan` transform and
/// so callers with no store (plan-shape tests) can pass [`NoIndexes`].
/// A seek only pays when the predicate actually SHRINKS the pool. E64 and E65 measured
/// where that turns over: a scan costs 1.88 ns per node scanned and a seek 12.2 ns per
/// row returned, both flat in selectivity, so a seek stops being worth it at
/// 1.88/12.2 = 15.4% of the graph.
///
/// Two rules consult this — whether to REVERSE a pattern onto its far-side predicate,
/// and whether to seed a `RangeSeek` at all — because it is the same question both
/// times: is an index cheaper than a scan here?
///
/// Above this, reversing is a measured REGRESSION rather than a smaller win —
/// `b.age > -1` (matching everything) went 788us to 3805us when orientation fired on
/// it, because the reversal buys nothing and still pays a residual label check above
/// the hop, which defeats the `count(*)` degree-sum shortcut.
const SEEK_MAX_FRACTION: f64 = 0.154;

pub trait IndexOracle {
    /// A hash index exists on the exact (possibly dotted) property path `key`.
    fn has_hash_index(&self, key: &str) -> bool;
    /// A range index exists on property `key`.
    fn has_range_index(&self, key: &str) -> bool;

    /// How many live nodes the store holds, when the oracle knows. `None` from an
    /// oracle with no store behind it, which then takes the planner's existing
    /// behaviour rather than a size-dependent one.
    fn live_nodes(&self) -> Option<usize> {
        None
    }

    /// Roughly what FRACTION of the graph `key <op> value` selects, or `None` when
    /// that cannot be answered cheaply (no index, or the answer is "a lot").
    ///
    /// Only orientation asks, and only to avoid a rewrite that is a win on a
    /// selective predicate and a LOSS on an unselective one. Defaults to `None`, so
    /// an oracle that cannot answer simply declines the rewrite.
    fn seed_fraction(&self, _key: &str, _op: crate::ir::CompareOp, _value: &Value) -> Option<f64> {
        None
    }
}

/// The "no physical indexes" oracle: every seed becomes a scan-fallback seek, which
/// is exactly the behavior before the optimizer could see indexes. Used by the
/// store-less [`optimize`] and by plan-shape tests.
pub struct NoIndexes;
impl IndexOracle for NoIndexes {
    fn has_hash_index(&self, _key: &str) -> bool {
        false
    }
    fn has_range_index(&self, _key: &str) -> bool {
        false
    }
}

impl IndexOracle for crate::store::Store {
    fn live_nodes(&self) -> Option<usize> {
        Some(self.live_node_count())
    }

    fn seed_fraction(&self, key: &str, op: crate::ir::CompareOp, value: &Value) -> Option<f64> {
        let live = self.live_node_count();
        if live == 0 {
            return None;
        }
        // Ask only up to the threshold the caller cares about, so an unselective
        // predicate costs a bounded probe instead of a full index walk.
        let cap = (live as f64 * SEEK_MAX_FRACTION).ceil() as usize;
        let n = match op {
            crate::ir::CompareOp::Eq => self.index_bucket_len(key, value)?,
            crate::ir::CompareOp::Lt
            | crate::ir::CompareOp::Le
            | crate::ir::CompareOp::Gt
            | crate::ir::CompareOp::Ge => self.range_count_capped(key, op, value, cap)?,
            crate::ir::CompareOp::Ne => return None,
        };
        Some(n as f64 / live as f64)
    }

    fn has_hash_index(&self, key: &str) -> bool {
        Store::has_hash_index(self, key)
    }
    fn has_range_index(&self, key: &str) -> bool {
        Store::has_range_index(self, key)
    }
}

/// Apply the rule set to a fixpoint, blind to any physical indexes — a seedable
/// predicate becomes a scan-fallback `IndexSeek`/`RangeSeek`. For index-aware
/// planning (which conjunct of a multi-predicate filter to seed), use
/// [`optimize_indexed`] with the store.
#[must_use]
pub fn optimize(plan: Plan) -> Plan {
    optimize_indexed(plan, &NoIndexes)
}

/// Apply the rule set to a fixpoint, letting `idx` steer index-sensitive rules (the
/// multi-predicate seed picks a conjunct backed by a real index when one exists —
/// otherwise it still seeds one conjunct onto the typed-scan fast path, since a
/// blind seek scans anyway). Bounded so a misbehaving rule cannot spin.
#[must_use]
pub fn optimize_indexed(plan: Plan, idx: &dyn IndexOracle) -> Plan {
    // Orientation runs BETWEEN two fixpoints, and both halves matter.
    //
    // AFTER the first: it needs the plan tidied. A pattern written `(a:L)-[:T]->(b:M)`
    // arrives as two stacked `Filter`s, which the local rules merge into one `And` —
    // and the orientation matcher wants a single filter over the hop. Running first
    // meant the labelled form (the idiomatic one) never matched at all.
    //
    // BEFORE a second: the reversal produces a fresh `Filter <- Scan` seed, and it is
    // the ordinary seeding rule that turns that into a `RangeSeek`. Without the
    // re-run the reversal saves the post-filter but still scans.
    //
    // It is also a whole-tree pass rather than a local rule, because renaming slots
    // requires seeing a pattern together with everything that reads it.
    let plan = fixpoint(plan, idx);
    let plan = match orient_eligible(&plan, idx) {
        Some(far) => fixpoint(orient_apply(plan, far).0, idx),
        None => plan,
    };
    let plan = drop_unread_group_binds(plan);
    set_path_need(plan)
}

/// A quantified subpath group appends one per-rep LIST column per inner variable it binds
/// (`group_binds`). Building those lists is the group executor's whole extra cost over a plain
/// var-length hop — measured on a 50,000-node degree-3 fixture, 599,998 rows: projecting a
/// literal over `((a)-[:R]->(b)){1,2}` took 82.3ms against 13.6ms for the same projection over
/// `(x)-[:R]->{1,2}(y)`, so the lists are **68.7ms** of it. When nothing reads them that is
/// paid for nothing, and with them gone a single-hop group IS a var-length hop, which also
/// unlocks the counting and frontier fast paths the group executor has none of (a bare
/// `count(*)` over a group went 64,655us -> 606us).
///
/// Conservative by construction, because the failure direction is asymmetric: dropping a
/// binding something reads is a WRONG ANSWER, whereas declining costs only time. So this walks
/// down from the root through a SHORT whitelist, accumulating the highest slot any expression
/// above reads via [`max_slot`] (itself exhaustive over `Expr`, and it already reports
/// `usize::MAX` for a path read and `outer_width - 1` for a correlated subquery), and rewrites
/// only when every one of the group's slots is above that high-water mark. Anything it does not
/// recognise stops the walk.
///
/// `Distinct` and `OrderPage` are deliberately NOT in the whitelist even though they are
/// harmless-looking: `Distinct` dedups on every column, so it reads the group lists whether or
/// not an expression names them, and a page below the output would carry them into the result.
fn drop_unread_group_binds(plan: Plan) -> Plan {
    fn expr_max<'a>(es: impl Iterator<Item = &'a Expr>) -> Option<usize> {
        es.fold(None, |acc, e| match (acc, max_slot(e)) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, b) => a.or(b),
        })
    }
    /// `read_above` is the highest slot index any expression ABOVE `p` reads.
    fn go(p: Plan, read_above: Option<usize>) -> Plan {
        match p {
            Plan::RepeatGroup {
                input,
                from,
                dir,
                edge_label,
                min,
                max,
                mode,
                endpoint_slot,
                group_binds,
                k,
                per_rep_pred,
            } => {
                let unread = !group_binds.is_empty()
                    && group_binds
                        .iter()
                        .all(|&(_, slot)| read_above.is_none_or(|hi| hi < slot));
                if !unread {
                    return Plan::RepeatGroup {
                        input,
                        from,
                        dir,
                        edge_label,
                        min,
                        max,
                        mode,
                        endpoint_slot,
                        group_binds,
                        k,
                        per_rep_pred,
                    };
                }
                // `k == 1` is required to flatten, and not incidentally: a multi-hop unit
                // emits only at rep BOUNDARIES where a var-length hop emits at every hop, and
                // the equivalent bounds would be `min * k ..= max * k` rather than
                // `min ..= max` — two separate ways the row count would change. A
                // `per_rep_pred` prunes hops the plain walk keeps, so it blocks too. Both
                // shapes still get the LISTS dropped, which is the larger cost.
                if k == 1 && per_rep_pred.is_none() && endpoint_slot == width(&input) {
                    return Plan::VarLength {
                        input,
                        from,
                        dir,
                        edge_label,
                        min,
                        max,
                        mode,
                        until: None,
                        body_filter: None,
                        double_loops: false,
                        path_need: crate::ir::PathNeed::Full,
                    };
                }
                Plan::RepeatGroup {
                    input,
                    from,
                    dir,
                    edge_label,
                    min,
                    max,
                    mode,
                    endpoint_slot,
                    group_binds: Vec::new(),
                    k,
                    per_rep_pred,
                }
            }
            // The multi-element-unit form of the same thing. A NESTED group appends one list
            // column per bound inner variable (`bind_slots`) exactly as a `RepeatGroup`
            // appends `group_binds`, and builds them whether or not anything reads them.
            // Measured on a 20,000-node fixture, 1,261,238 rows, `count(*)` over
            // `((x)-[:R]->(m)<-[:R]-(y)){1,2}`: 665.3ms -> 349.8ms, **1.90x**.
            //
            // Unlike `RepeatGroup` this never flattens to a var-length hop — a multi-element
            // unit emits only at rep boundaries, so the row counts differ — so the lists are
            // all that can go.
            //
            // A `per_rep_pred` does NOT block it. `bind_slots` only sizes the output columns
            // (exec/nested.rs), while the predicate is handed to the walker separately and
            // evaluated on a per-rep mini-scope built from the unit's own bindings — the parser
            // says as much ("Independent of the group list bindings", gql.rs). Item 50 blocked
            // it anyway, because the per-rep filter over a reversed hop returned zero rows for
            // any predicate and the safety was therefore untestable; that was a native-only bug
            // (the TS engine had the right answers) and it is fixed, so the guard is lifted and
            // `a_per_rep_filtered_nested_group_still_drops_unread_lists` pins the behaviour.
            Plan::NestedGroup {
                input,
                from,
                unit,
                min,
                max,
                mode,
                endpoint_slot,
                bind_slots,
                per_rep_pred,
            } => {
                let unread = !bind_slots.is_empty()
                    && bind_slots
                        .iter()
                        .all(|&slot| read_above.is_none_or(|hi| hi < slot));
                Plan::NestedGroup {
                    input,
                    from,
                    unit,
                    min,
                    max,
                    mode,
                    endpoint_slot,
                    bind_slots: if unread { Vec::new() } else { bind_slots },
                    per_rep_pred,
                }
            }
            Plan::Project { input, items } => {
                let hi = expr_max(items.iter().map(|(_, e)| e));
                let input = Box::new(go(*input, merge_max(read_above, hi)));
                Plan::Project { input, items }
            }
            Plan::Aggregate { input, keys, aggs } => {
                let hi = merge_max(
                    expr_max(keys.iter().map(|(_, e)| e)),
                    expr_max(aggs.iter().filter_map(|a| a.arg.as_ref())),
                );
                let input = Box::new(go(*input, merge_max(read_above, hi)));
                Plan::Aggregate { input, keys, aggs }
            }
            Plan::Filter { input, pred } => {
                let hi = max_slot(&pred);
                let input = Box::new(go(*input, merge_max(read_above, hi)));
                Plan::Filter { input, pred }
            }
            other => other,
        }
    }
    go(plan, None)
}

/// Mark every `ShortestPath` with how much of its path the plan reads. LAST, after every
/// rewrite: pushdown and orientation move expressions around, and the answer depends on what
/// reads the path in the FINAL tree.
///
/// The decision is plan-global rather than per-node. A plan with two path-producing hops has
/// one lineage sidecar flowing through it, so "only sizes are read" is a property of the whole
/// tree; deciding per node would let one hop suppress elements another hop's reader needs.
/// Conservative in the direction that matters: [`needs_path_elements`] returning true for
/// anything it cannot classify as a size leaves the elements materialized, which is merely
/// slower, whereas suppressing a path somebody reads is a wrong answer.
fn set_path_need(plan: Plan) -> Plan {
    use crate::exec::render::{needs_lineage, needs_path_elements};
    if !needs_lineage(&plan) || needs_path_elements(&plan) {
        return plan; // nothing reads the path, or something reads its elements
    }
    // Descend ONLY through operators that leave the path alone or merely GATHER it, and mark
    // the first `ShortestPath` reached that way. Anything else stops the descent, leaving the
    // `ShortestPath` below it `Full`.
    //
    // The allow-list is short on purpose, and it is a whitelist rather than a blacklist
    // because the failure direction is asymmetric: not marking costs performance, whereas
    // marking under an operator that MATERIALIZES the path is a wrong answer. A lineage whose
    // elements were suppressed has an empty `values`, so an operator that rebuilds the path
    // through `path_at` reads an empty prefix and silently drops everything the shortest path
    // contributed. That is exactly what the raw-vs-optimized fuzzer caught at seed 632
    // (`VarLength` sitting above a `ShortestPath`): `cardinality(p)` came back 3/5/7 raw and
    // 0/2 optimized, because only the `VarLength`'s own hops survived.
    //
    // `gather` is safe and therefore allowed: it reorders the counts when they are present
    // (see `Lineage::gather`). `extend` / `extend_nodes` handle suppression too, but the
    // operators that CALL them also build fresh lineage of their own, so they stay out.
    fn mark(p: &mut Plan) {
        match p {
            // The path-PRODUCING operators. Both stop the descent rather than continuing:
            // whatever feeds them materializes its input's path, so a lower producer stays
            // `Full`. (`VarLength` still WALKS its chain either way — the DFS stacks are the
            // traversal state — so what `CountOnly` saves there is copying them out, which
            // measured 58,891us -> 22,662us at 599,998 rows.)
            Plan::ShortestPath { path_need, .. } | Plan::VarLength { path_need, .. } => {
                *path_need = crate::ir::PathNeed::CountOnly;
            }
            Plan::Project { input, .. }
            | Plan::Filter { input, .. }
            | Plan::Aggregate { input, .. }
            | Plan::Distinct { input }
            | Plan::OrderPage { input, .. }
            | Plan::Tail { input, .. }
            | Plan::Enumerate { input, .. }
            | Plan::Sample { input, .. }
            | Plan::DistinctBy { input, .. } => mark(input),
            _ => {}
        }
    }
    let mut plan = plan;
    mark(&mut plan);
    plan
}

/// Run the local rewrite rules to a fixpoint (bounded, so a rule that oscillates
/// cannot hang the planner).
fn fixpoint(plan: Plan, idx: &dyn IndexOracle) -> Plan {
    let mut plan = plan;
    for _ in 0..64 {
        let (next, changed) = rewrite(plan, idx);
        plan = next;
        if !changed {
            break;
        }
    }
    plan
}

/// Output column count of a plan, when it is statically known — enough to locate the
/// slot a hop APPENDS (its endpoint). `None` for shapes whose width isn't obvious.
fn plan_out_width(p: &Plan) -> Option<usize> {
    Some(match p {
        Plan::Scan { .. }
        | Plan::IndexSeek { .. }
        | Plan::RangeSeek { .. }
        | Plan::NodeSeed { .. }
        | Plan::EdgeSeed { .. }
        | Plan::Row => 1,
        Plan::Expand {
            input, bind_edge, ..
        } => plan_out_width(input)? + usize::from(*bind_edge) + 1,
        Plan::VarLength { input, .. } | Plan::ShortestPath { input, .. } => {
            plan_out_width(input)? + 1
        }
        // A quantified group appends the endpoint plus one LIST column per bound inner
        // variable.
        Plan::RepeatGroup {
            input, group_binds, ..
        } => plan_out_width(input)? + 1 + group_binds.len(),
        Plan::NestedGroup {
            input, bind_slots, ..
        } => plan_out_width(input)? + 1 + bind_slots.len(),
        Plan::Filter { input, .. }
        | Plan::OrderPage { input, .. }
        | Plan::Distinct { input }
        | Plan::DistinctBy { input, .. } => plan_out_width(input)?,
        Plan::Project { items, .. } => items.len(),
        _ => return None,
    })
}

/// Is the value at `slot` in `p`'s output a NODE? Conservative: only shapes that provably
/// bind a node there return true (an edge slot / unknown shape → false, so we never turn
/// an EDGE label test into a node `IsLabeled`). A hop's appended endpoint (slot ==
/// input width) is a node when `bind_edge` is false; a bound edge lands one slot earlier.
fn slot_is_node(p: &Plan, slot: usize) -> bool {
    match p {
        Plan::Scan { .. }
        | Plan::IndexSeek { .. }
        | Plan::RangeSeek { .. }
        | Plan::NodeSeed { .. } => slot == 0,
        Plan::Expand {
            input, bind_edge, ..
        } => match plan_out_width(input) {
            // The endpoint node is the LAST appended slot; a bound edge sits one before it.
            Some(w) if slot == w + usize::from(*bind_edge) => true,
            _ => slot_is_node(input, slot),
        },
        Plan::VarLength { input, .. } | Plan::ShortestPath { input, .. } => {
            match plan_out_width(input) {
                Some(w) if slot == w => true, // the appended endpoint is a node
                _ => slot_is_node(input, slot),
            }
        }
        // A quantified group's endpoint is a node, and it carries the slot explicitly. The
        // trailing bind slots are LIST columns, so they fall through to the input, which does
        // not claim a slot beyond its own width.
        Plan::RepeatGroup {
            input,
            endpoint_slot,
            ..
        }
        | Plan::NestedGroup {
            input,
            endpoint_slot,
            ..
        } => slot == *endpoint_slot || slot_is_node(input, slot),
        Plan::Filter { input, .. }
        | Plan::OrderPage { input, .. }
        | Plan::Distinct { input }
        | Plan::DistinctBy { input, .. } => slot_is_node(input, slot),
        _ => false,
    }
}

/// Canonicalize a predicate so every fast-path sees ONE spelling of a label test:
/// `<label> IN labels(slot)` — the form GQL's `(b:Label)` pattern emits — becomes
/// `IsLabeled { slot, [label] }`, the same node Gremlin's `hasLabel` produces. Gated on
/// `slot` being a NODE (via `input`, the plan feeding the filter) because an EDGE's
/// `IS LABELED` lowers to the same `In(Lit, labels(slot))` form but means the edge's
/// type, which `IsLabeled` (node labels) would answer wrongly. Recurses through the
/// boolean combinators.
/// The three-valued negation of a comparison operator: `NOT (a <op> b) == a <neg> b`
/// for every present value pair (and both stay UNKNOWN on NULL, both throw on a
/// cross-type ordering). Eq↔Ne, Lt↔Ge, Le↔Gt.
fn negate_op(op: CompareOp) -> CompareOp {
    match op {
        CompareOp::Eq => CompareOp::Ne,
        CompareOp::Ne => CompareOp::Eq,
        CompareOp::Lt => CompareOp::Ge,
        CompareOp::Le => CompareOp::Gt,
        CompareOp::Gt => CompareOp::Le,
        CompareOp::Ge => CompareOp::Lt,
    }
}

fn normalize_pred(e: Expr, input: &Plan) -> Expr {
    match e {
        Expr::In { needle, haystack } => {
            if let (Expr::Lit(crate::value::Value::Str(l)), Expr::Call { name, args }) =
                (needle.as_ref(), haystack.as_ref())
            {
                if name == "labels" && args.len() == 1 {
                    if let Expr::Slot(s) = args[0] {
                        if slot_is_node(input, s) {
                            return Expr::IsLabeled {
                                slot: s,
                                labels: vec![l.to_string()],
                            };
                        }
                    }
                }
            }
            // `x IN [<literals>]` → `x = a OR x = b OR …`: the OR-chain vectorizes through
            // the fast compare path and lets the index-seed logic multi-seek, instead of
            // re-cloning the list value and scanning it per row. Identical 3VL — a NULL in
            // the list makes a non-matching row UNKNOWN exactly as `x = NULL` (→ NULL) does
            // inside the OR. Gated to a small literal list of a cheap needle (so the needle
            // isn't re-evaluated expensively) with at least one element.
            // The literal values, from a `Lit(List)` OR an `Expr::List` of literals (the
            // parser emits the latter for an inline `[20, 39, 107]`; without this the `IN`
            // stayed boxed in `eval_mask` — a nested `score IN […]` over a hop cost ~75x the
            // vectorized OR — and never index-seeded).
            let lits: Option<Vec<crate::value::Value>> = match haystack.as_ref() {
                Expr::Lit(crate::value::Value::List(items)) => Some(items.clone()),
                Expr::List { items } => items
                    .iter()
                    .map(|it| match it {
                        Expr::Lit(v) => Some(v.clone()),
                        _ => None,
                    })
                    .collect(),
                _ => None,
            };
            if let Some(items) = lits {
                let simple_needle = matches!(
                    needle.as_ref(),
                    Expr::Prop { .. } | Expr::Slot(_) | Expr::Lit(_)
                );
                if simple_needle && !items.is_empty() && items.len() <= 32 {
                    let eq = |v: &crate::value::Value| Expr::Compare {
                        op: CompareOp::Eq,
                        left: needle.clone(),
                        right: Box::new(Expr::Lit(v.clone())),
                    };
                    let mut it = items.iter().rev();
                    let mut acc = eq(it.next().expect("non-empty"));
                    for item in it {
                        acc = Expr::Or(Box::new(eq(item)), Box::new(acc));
                    }
                    return acc;
                }
            }
            Expr::In {
                needle: Box::new(normalize_pred(*needle, input)),
                haystack: Box::new(normalize_pred(*haystack, input)),
            }
        }
        Expr::Not(a) => {
            let a = normalize_pred(*a, input);
            match a {
                // NOT NOT x -> x (double negation; collapses the fuzzer's `NOT NOT NOT …`).
                Expr::Not(inner) => *inner,
                // NOT (l = r) -> l <> r, and the reverse. EQUALITY ONLY. Canonicalizes the
                // negated spelling onto the SAME fast/seed path as the positive one — so
                // `NOT d.name <> 'n929'` becomes the seekable `d.name = 'n929'` (the
                // equivalent-spellings rule: both must cost the same), which is the case this
                // rewrite exists for.
                //
                // NOT sound for the ORDERING operators, which is what it used to do too. A NULL
                // operand leaves both spellings UNKNOWN and cross-type ordering throws either
                // way — those were checked — but **NaN** was not, and under IEEE unordered
                // comparison a NaN operand makes `<`, `<=`, `>` and `>=` ALL false. So
                // `NOT (NaN >= 2)` is TRUE while `NaN < 2` is FALSE, and the rewrite turned a
                // matching row into no rows. Equality is unaffected because `NaN = x` is false
                // and `NaN <> x` is true — genuine complements.
                //
                // The projected form always had it right (`RETURN NOT (sin(1e400) >= 2)` gave
                // TRUE); only the filter went through here, so the two disagreed. Found by the
                // differential fuzzer once its predicate arms generated `NOT` over a comparison
                // at a realistic rate.
                Expr::Compare { op, left, right }
                    if matches!(op, CompareOp::Eq | CompareOp::Ne) =>
                {
                    Expr::Compare {
                        op: negate_op(op),
                        left,
                        right,
                    }
                }
                other => Expr::Not(Box::new(other)),
            }
        }
        Expr::And(a, b) => {
            let a = normalize_pred(*a, input);
            let b = normalize_pred(*b, input);
            // Flatten, then drop any OR-disjunct that a sibling numeric conjunct makes
            // unsatisfiable (`score < 26 AND (city = 'n546' OR score >= 71)` → the score>=71
            // branch is contradictory, leaving the seedable `... AND city = 'n546'`).
            let mut conj = Vec::new();
            flatten_and(a, &mut conj);
            flatten_and(b, &mut conj);
            let bounds: Vec<(usize, String, CompareOp, f64)> =
                conj.iter().filter_map(num_bound).collect();
            let simplified: Vec<Expr> = conj
                .into_iter()
                .map(|c| prune_or_branches(c, &bounds))
                .collect();
            and_all(simplified).expect("non-empty: at least the two original conjuncts")
        }
        Expr::Or(a, b) => Expr::Or(
            Box::new(normalize_pred(*a, input)),
            Box::new(normalize_pred(*b, input)),
        ),
        Expr::Xor(a, b) => Expr::Xor(
            Box::new(normalize_pred(*a, input)),
            Box::new(normalize_pred(*b, input)),
        ),
        other => other,
    }
}

/// Rewrite one node: optimize its children, then apply the local rules to it.
/// Returns the new plan and whether anything changed.
fn rewrite(plan: Plan, idx: &dyn IndexOracle) -> (Plan, bool) {
    let (plan, child_changed) = map_children(plan, idx);
    let (plan, local_changed) = apply_local(plan, idx);
    (plan, child_changed || local_changed)
}

/// Rebuild a node with its children individually rewritten.
fn map_children(plan: Plan, idx: &dyn IndexOracle) -> (Plan, bool) {
    match plan {
        // Leaves: no children to rewrite. (`Row` only lives inside an EXISTS body,
        // which the optimizer never descends into, but it is still a leaf.)
        // `InsertReturn`'s `tail` is a Row-seeded projection with nothing for the
        // read-side rewrites (index seeds, pushdown) to act on, so it is a leaf too.
        p @ (Plan::Scan { .. }
        | Plan::NodeSeed { .. }
        | Plan::EdgeScan
        | Plan::EdgeSeed { .. }
        | Plan::Row
        | Plan::IndexSeek { .. }
        | Plan::RangeSeek { .. }
        | Plan::Insert { .. }
        | Plan::InsertReturn { .. }
        | Plan::Merge { .. }
        | Plan::MergeEdge { .. }
        | Plan::AddEdge { .. }
        | Plan::AddEdgeStep { .. }
        | Plan::AddVertexStep { .. }
        | Plan::CallProcedure { .. }
        | Plan::TxControl { .. }) => (p, false),
        Plan::GroupToMap { input } => {
            let (i, c) = rewrite(*input, idx);
            (Plan::GroupToMap { input: Box::new(i) }, c)
        }
        Plan::PathRecord { input, value, tag } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::PathRecord {
                    input: Box::new(i),
                    value,
                    tag,
                },
                c,
            )
        }
        Plan::InsertFrom {
            input,
            nodes,
            edges,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::InsertFrom {
                    input: Box::new(i),
                    nodes,
                    edges,
                },
                c,
            )
        }
        Plan::Tree {
            input,
            by,
            leaf_value,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Tree {
                    input: Box::new(i),
                    by,
                    leaf_value,
                },
                c,
            )
        }
        Plan::MapSlot {
            input,
            slot,
            value,
            append,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::MapSlot {
                    input: Box::new(i),
                    slot,
                    value,
                    append,
                },
                c,
            )
        }
        Plan::EdgeVertex {
            input,
            edge_slot,
            which,
            other,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::EdgeVertex {
                    input: Box::new(i),
                    edge_slot,
                    which,
                    other,
                },
                c,
            )
        }
        Plan::Enumerate { input, slot } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Enumerate {
                    input: Box::new(i),
                    slot,
                },
                c,
            )
        }
        Plan::Sample { input, n } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Sample {
                    input: Box::new(i),
                    n,
                },
                c,
            )
        }
        Plan::Subgraph { input, edge_slot } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Subgraph {
                    input: Box::new(i),
                    edge_slot,
                },
                c,
            )
        }
        Plan::ShortestPathEnum {
            input,
            node_slot,
            target,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::ShortestPathEnum {
                    input: Box::new(i),
                    node_slot,
                    target,
                },
                c,
            )
        }
        Plan::AlgoAnnotate {
            input,
            algo,
            edge_label,
            node_slot,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::AlgoAnnotate {
                    input: Box::new(i),
                    algo,
                    edge_label,
                    node_slot,
                },
                c,
            )
        }
        Plan::Unwind {
            input,
            list,
            var_slot,
            ordinal,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Unwind {
                    input: Box::new(i),
                    list,
                    var_slot,
                    ordinal,
                },
                c,
            )
        }
        Plan::Expand {
            input,
            from,
            dir,
            edge_label,
            bind_edge,
            double_loops,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Expand {
                    input: Box::new(i),
                    from,
                    dir,
                    edge_label,
                    bind_edge,
                    double_loops,
                },
                c,
            )
        }
        Plan::OptionalExpand {
            input,
            from,
            dir,
            edge_label,
            keep_source,
            bind_edge,
            landing_pred,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::OptionalExpand {
                    input: Box::new(i),
                    from,
                    dir,
                    edge_label,
                    keep_source,
                    bind_edge,
                    landing_pred,
                },
                c,
            )
        }
        Plan::IntervalExpand {
            input,
            from,
            dir,
            edge_label,
            lo_key,
            hi_key,
            qlo,
            qhi,
            bind_edge,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::IntervalExpand {
                    input: Box::new(i),
                    from,
                    dir,
                    edge_label,
                    lo_key,
                    hi_key,
                    qlo,
                    qhi,
                    bind_edge,
                },
                c,
            )
        }
        Plan::VarLength {
            input,
            from,
            dir,
            edge_label,
            min,
            max,
            mode,
            until,
            body_filter,
            double_loops,
            path_need,
        } => {
            let (i, c) = rewrite(*input, idx);
            // `repeat(x).times(1)` — a VarLength of EXACTLY one hop with no until /
            // body_filter — IS a single Expand, which unlocks every frontier fast path
            // (counts, prop-agg, fused hops) the var-length executor lacks. Safe for
            // WALK/TRAIL (one hop reuses no node/edge, so a self-loop A->A is kept, as
            // Expand does); SIMPLE/ACYCLIC would drop that self-loop (revisits A), so they
            // keep the VarLength.
            if min == 1
                && max == 1
                && until.is_none()
                && body_filter.is_none()
                && matches!(mode, crate::ir::PathMode::Walk | crate::ir::PathMode::Trail)
            {
                return (
                    Plan::Expand {
                        input: Box::new(i),
                        from,
                        dir,
                        edge_label,
                        bind_edge: false,
                        double_loops,
                    },
                    c,
                );
            }
            (
                Plan::VarLength {
                    input: Box::new(i),
                    from,
                    dir,
                    edge_label,
                    min,
                    max,
                    mode,
                    until,
                    body_filter,
                    double_loops,
                    path_need,
                },
                c,
            )
        }
        Plan::RepeatGroup {
            input,
            from,
            dir,
            edge_label,
            min,
            max,
            mode,
            endpoint_slot,
            group_binds,
            k,
            per_rep_pred,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::RepeatGroup {
                    input: Box::new(i),
                    from,
                    dir,
                    edge_label,
                    min,
                    max,
                    mode,
                    endpoint_slot,
                    group_binds,
                    k,
                    per_rep_pred,
                },
                c,
            )
        }
        Plan::NestedGroup {
            input,
            from,
            unit,
            min,
            max,
            mode,
            endpoint_slot,
            bind_slots,
            per_rep_pred,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::NestedGroup {
                    input: Box::new(i),
                    from,
                    unit,
                    min,
                    max,
                    mode,
                    endpoint_slot,
                    bind_slots,
                    per_rep_pred,
                },
                c,
            )
        }
        Plan::ShortestPath {
            input,
            from,
            dir,
            edge_label,
            min,
            max,
            selector,
            edge_pred,
            path_need,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::ShortestPath {
                    input: Box::new(i),
                    from,
                    dir,
                    edge_label,
                    min,
                    max,
                    selector,
                    edge_pred,
                    path_need,
                },
                c,
            )
        }
        Plan::Filter { input, pred } => {
            let (i, c) = rewrite(*input, idx);
            let pred = normalize_pred(pred, &i);
            (
                Plan::Filter {
                    input: Box::new(i),
                    pred,
                },
                c,
            )
        }
        Plan::Aggregate {
            input,
            keys,
            mut aggs,
        } => {
            let (i, c) = rewrite(*input, idx);
            // `count(x)` over a bound ELEMENT is `count(*)`: a pattern variable bound
            // to a node/edge is never null, so counting it counts every row. When the
            // input is a pure Scan/Expand chain EVERY slot is such an element, so
            // rewrite a non-DISTINCT `count(Slot(k))` to the argument-free form — that
            // canonicalizes `count(n)`/`count(b)` onto the O(1) `count(*)` fast path,
            // closing a spelling perf cliff (`count(n)` was a full scan, `count(*)`
            // O(1)). DISTINCT is left alone (`count(DISTINCT n)` is distinct elements,
            // not the row count). A `count(n.prop)` argument is a `Prop`, not a `Slot`,
            // so it is untouched — it genuinely counts non-null property values.
            if pure_chain_width(&i).is_some() {
                for agg in &mut aggs {
                    if agg.func == crate::ir::AggFn::Count
                        && !agg.distinct
                        && matches!(agg.arg.as_ref(), Some(Expr::Slot(_)))
                    {
                        agg.arg = None;
                    }
                }
            }
            (
                Plan::Aggregate {
                    input: Box::new(i),
                    keys,
                    aggs,
                },
                c,
            )
        }
        Plan::OrderPage {
            input,
            keys,
            skip,
            limit,
            fault_on_element,
        } => {
            let (i, c) = rewrite(*input, idx);
            // Fuse a pure PAGE over a pure SORT into one OrderPage. Gremlin lowers
            // `order().by(k)` then `range(lo, hi)` to two stacked OrderPages — an inner
            // full sort (no page) and an outer page (no keys) — so the sort ran over
            // ALL rows and the top-K / late-materialization fast path (which needs the
            // sort and the limit on the SAME node) never fired: `order().by().range()`
            // was ~7x its GQL `ORDER BY … LIMIT` twin. "Sort by k, then take
            // [skip, skip+limit)" is exactly "sort by k with that page", so merging is
            // meaning-preserving — but ONLY when the outer adds no keys and the inner
            // has no page of its own (an inner limit would pre-truncate the rows).
            if keys.is_empty() {
                if let Plan::OrderPage {
                    input: inner,
                    keys: inner_keys,
                    skip: None,
                    limit: None,
                    fault_on_element: inner_fault,
                } = i
                {
                    if !inner_keys.is_empty() {
                        return (
                            // The merged node carries the KEYED (inner) sort, so keep its
                            // element-fault policy — the outer page had no keys.
                            Plan::OrderPage {
                                input: inner,
                                keys: inner_keys,
                                skip,
                                limit,
                                fault_on_element: inner_fault,
                            },
                            true, // merged two nodes into one — a real change
                        );
                    }
                    // Not mergeable after all — rebuild the inner OrderPage we moved out.
                    return (
                        Plan::OrderPage {
                            input: Box::new(Plan::OrderPage {
                                input: inner,
                                keys: inner_keys,
                                skip: None,
                                limit: None,
                                fault_on_element: inner_fault,
                            }),
                            keys,
                            skip,
                            limit,
                            fault_on_element,
                        },
                        c,
                    );
                }
            }
            (
                Plan::OrderPage {
                    input: Box::new(i),
                    keys,
                    skip,
                    limit,
                    fault_on_element,
                },
                c,
            )
        }
        Plan::Project { input, items } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Project {
                    input: Box::new(i),
                    items,
                },
                c,
            )
        }
        Plan::Distinct { input } => {
            let (i, c) = rewrite(*input, idx);
            (Plan::Distinct { input: Box::new(i) }, c)
        }
        Plan::Fail { input, message } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Fail {
                    input: Box::new(i),
                    message,
                },
                c,
            )
        }
        Plan::DistinctBy { input, key_slots } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::DistinctBy {
                    input: Box::new(i),
                    key_slots,
                },
                c,
            )
        }
        Plan::OptionalScan {
            input,
            label,
            filters,
            node_slot,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::OptionalScan {
                    input: Box::new(i),
                    label,
                    filters,
                    node_slot,
                },
                c,
            )
        }
        Plan::NullPadIfEmpty { input, width } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::NullPadIfEmpty {
                    input: Box::new(i),
                    width,
                },
                c,
            )
        }
        Plan::Tail { input, n } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Tail {
                    input: Box::new(i),
                    n,
                },
                c,
            )
        }
        Plan::SortLocal {
            input,
            descending,
            by_key,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::SortLocal {
                    input: Box::new(i),
                    descending,
                    by_key,
                },
                c,
            )
        }
        Plan::Update { input, ops } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Update {
                    input: Box::new(i),
                    ops,
                },
                c,
            )
        }
        // Rewrite the MATCH `input` (index seeds / pushdown apply to it); the tail is
        // a Row-seeded projection, a leaf like InsertReturn's.
        Plan::UpdateReturn { input, ops, tail } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::UpdateReturn {
                    input: Box::new(i),
                    ops,
                    tail,
                },
                c,
            )
        }
        Plan::Join { left, right, on } => {
            let (l, cl) = rewrite(*left, idx);
            let (r, cr) = rewrite(*right, idx);
            (
                Plan::Join {
                    left: Box::new(l),
                    right: Box::new(r),
                    on,
                },
                cl || cr,
            )
        }
        Plan::Union {
            left,
            right,
            all,
            op,
        } => {
            let (l, cl) = rewrite(*left, idx);
            let (r, cr) = rewrite(*right, idx);
            (
                Plan::Union {
                    left: Box::new(l),
                    right: Box::new(r),
                    all,
                    op,
                },
                cl || cr,
            )
        }
        // Optimize the outer `input`, but leave the correlated `body` alone: it is
        // rooted at `Plan::Row` and evaluated by `pull_body`, which expects the raw
        // Expand/Filter chain — a seed rule would rewrite it into an uneval-able
        // shape.
        Plan::CallInline {
            input,
            body,
            yields,
            outer_width,
            optional,
            parts,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::CallInline {
                    input: Box::new(i),
                    body,
                    yields,
                    outer_width,
                    optional,
                    parts,
                },
                c,
            )
        }
        // Rewrite the input; the correlated branch bodies are left as-is (like an
        // EXISTS/CALL body, the optimizer does not descend into them).
        Plan::Branch { input, bodies } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::Branch {
                    input: Box::new(i),
                    bodies,
                },
                c,
            )
        }
        // Like Branch: rewrite the input; the correlated cond/arms are left as-is.
        Plan::PerElementBranch {
            input,
            kind,
            cond,
            arms,
            source_slot,
        } => {
            let (i, c) = rewrite(*input, idx);
            (
                Plan::PerElementBranch {
                    input: Box::new(i),
                    kind,
                    cond,
                    arms,
                    source_slot,
                },
                c,
            )
        }
        Plan::Reconverge { input, slot } => {
            let (i, c) = rewrite(*input, idx);
            (i.reconverge(slot), c)
        }
    }
}

/// If `pred` is an equality between slot-0's property and a literal — in EITHER
/// spelling (`prop = v` or `v = prop`) — return `(key, value)` for an index seek.
/// Only `=` (not ranges), only slot 0 (the scanned node). Handling both spellings
/// is the load-bearing part: a missed spelling silently keeps scanning.
/// One seedable conjunct: an equality (→ `IndexSeek`) or a range (→ `RangeSeek`).
enum Seed {
    Index(String, Value),
    Range(String, CompareOp, Value),
}

/// Given a conjunction `a AND b AND …`, pick ONE conjunct to seed and return it
/// with the residual predicate (the remaining conjuncts, re-`AND`ed). The pick is
/// INDEX-AWARE: an equality/range conjunct backed by a real physical index wins,
/// because that seek reads the index instead of scanning; only when nothing is
/// indexed does it fall back to seeding an equality (then a range) onto the
/// typed-scan fast path — a blind seek would scan the whole label anyway, so which
/// unindexed conjunct is chosen changes no cost, just avoids the far slower
/// `Filter(And(…))(Scan)`. `None` if the predicate is not an `AND`, or no conjunct
/// is seekable.
fn seed_from_conjuncts(pred: &Expr, idx: &dyn IndexOracle) -> Option<(Seed, Option<Expr>)> {
    fn flatten<'a>(e: &'a Expr, out: &mut Vec<&'a Expr>) {
        match e {
            Expr::And(a, b) => {
                flatten(a, out);
                flatten(b, out);
            }
            other => out.push(other),
        }
    }
    let mut conjuncts = Vec::new();
    flatten(pred, &mut conjuncts);
    if conjuncts.len() < 2 {
        return None; // not a conjunction — the single-comparison arms handle it
    }
    // Selection priority (best first): an INDEXED equality worth seeking, then an
    // INDEXED range, then any UNINDEXED equality — whose seek degrades to a typed
    // column scan, which is the cheapest of the three remaining shapes.
    //
    // There is deliberately no "any range" rung. An unindexed range seed makes
    // `RangeSeek` fall back to scanning and BOXING every cell, which loses to leaving
    // the conjunction as a `Filter(Scan)`: measured 255.4us for `dept = 'eng' AND
    // age > 1` against 651.0us once an unindexed `age` range was seeded from it, and
    // 3456.9us against 3873.0us for a pure two-sided range (E75, E76). The
    // single-comparison arm in `apply` has gated its Range seed on `has_range_index`
    // for exactly this reason; this path used to disagree.
    let eq_worth_it = |c: &Expr| seek_target(c).is_some_and(|(k, v)| eq_seek_worth_it(idx, &k, &v));
    // Within a rung, take the MOST SELECTIVE conjunct, not the first one written. Taking
    // the first made conjunct ORDER change the plan: `age >= 30 AND age < 40` seeded the
    // 70% bound and `age < 40 AND age >= 30` the 40% one, two spellings of one range at
    // a measured 1.55x apart (`spelling_probe`, "range AND"). The Gremlin seed layer has
    // ranked by selectivity since `the_more_selective_of_two_filters_seeds`; this path
    // was the one still going by position.
    //
    // An oracle that declines to measure sorts last (`f64::MAX`) rather than dropping
    // out, so a parameterized or unmeasurable bound is still seedable — and `min_by`
    // keeps the first of equal ranks, so a store-less plan keeps its old pick.
    let eq_cand = |i: usize, c: &Expr| -> Option<(usize, f64)> {
        let (k, v) = seek_target(c)?;
        (idx.has_hash_index(&k) && seek_beats_scan(idx, &k, CompareOp::Eq, &v)).then(|| {
            (
                i,
                idx.seed_fraction(&k, CompareOp::Eq, &v).unwrap_or(f64::MAX),
            )
        })
    };
    let range_cand = |i: usize, c: &Expr| -> Option<(usize, f64)> {
        let (k, op, v) = range_seek_target(c)?;
        (idx.has_range_index(&k) && seek_beats_scan(idx, &k, op, &v))
            .then(|| (i, idx.seed_fraction(&k, op, &v).unwrap_or(f64::MAX)))
    };
    let most_selective = |ranked: &mut dyn Iterator<Item = (usize, f64)>| {
        ranked.min_by(|a, b| a.1.total_cmp(&b.1)).map(|(i, _)| i)
    };
    let pick = most_selective(
        &mut conjuncts
            .iter()
            .enumerate()
            .filter_map(|(i, c)| eq_cand(i, c)),
    )
    .or_else(|| {
        most_selective(
            &mut conjuncts
                .iter()
                .enumerate()
                .filter_map(|(i, c)| range_cand(i, c)),
        )
    })
    .or_else(|| conjuncts.iter().position(|c| eq_worth_it(c)))?;
    let seed = if let Some((k, v)) = seek_target(conjuncts[pick]) {
        Seed::Index(k, v)
    } else {
        let (k, op, v) = range_seek_target(conjuncts[pick])?;
        Seed::Range(k, op, v)
    };
    // Residual: the other conjuncts, re-`AND`ed (or `None` if the seed was the only
    // one besides itself — i.e. exactly two conjuncts leaves a lone residual).
    let residual = conjuncts
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != pick)
        .map(|(_, c)| (*c).clone())
        .reduce(|a, b| Expr::And(Box::new(a), Box::new(b)));
    Some((seed, residual))
}

fn seek_target(pred: &Expr) -> Option<(String, Value)> {
    let Expr::Compare {
        op: CompareOp::Eq,
        left,
        right,
    } = pred
    else {
        return None;
    };
    // One side must be a literal, the other a (possibly dotted) property PATH on
    // slot 0. Both spellings; a dotted `n.rec.sub` seeds a dotted IndexSeek.
    let (path_expr, v) = match (left.as_ref(), right.as_ref()) {
        (e, Expr::Lit(v)) => (e, v),
        (Expr::Lit(v), e) => (e, v),
        _ => return None,
    };
    prop_path(path_expr).map(|k| (k, v.clone()))
}

/// The dotted property path an expression reads on slot 0, or `None` if it is not
/// a slot-0 property/field chain. `n.age` → `"age"`, `n.meta.city` → `"meta.city"`.
fn prop_path(e: &Expr) -> Option<String> {
    match e {
        Expr::Prop { slot: 0, key } => Some(key.clone()),
        Expr::Field { base, key } => Some(format!("{}.{key}", prop_path(base)?)),
        _ => None,
    }
}

/// A range comparison with its operands swapped — used to normalize
/// `lit <op> prop` to `prop <op'> lit`.
fn flip_range(op: CompareOp) -> CompareOp {
    match op {
        CompareOp::Lt => CompareOp::Gt,
        CompareOp::Gt => CompareOp::Lt,
        CompareOp::Le => CompareOp::Ge,
        CompareOp::Ge => CompareOp::Le,
        // Not range ops; range_seek_target never reaches here.
        CompareOp::Eq | CompareOp::Ne => op,
    }
}

/// If `pred` is a RANGE comparison (`<`,`<=`,`>`,`>=`) between slot-0's property
/// and a literal — in either spelling — return `(key, op, value)` oriented with
/// the property on the left (`prop <op> value`). Flipping the op for the
/// `lit <op> prop` spelling is load-bearing: else `5 < n` never seeks.
fn range_seek_target(pred: &Expr) -> Option<(String, CompareOp, Value)> {
    let Expr::Compare { op, left, right } = pred else {
        return None;
    };
    if !matches!(
        op,
        CompareOp::Lt | CompareOp::Le | CompareOp::Gt | CompareOp::Ge
    ) {
        return None;
    }
    match (left.as_ref(), right.as_ref()) {
        (Expr::Prop { slot: 0, key }, Expr::Lit(v)) => Some((key.clone(), *op, v.clone())),
        (Expr::Lit(v), Expr::Prop { slot: 0, key }) => {
            Some((key.clone(), flip_range(*op), v.clone()))
        }
        _ => None,
    }
}

/// The local rules, tried in order at a single node.
fn apply_local(plan: Plan, idx: &dyn IndexOracle) -> (Plan, bool) {
    match plan {
        Plan::Filter { input, pred } => match *input {
            // filter-merge: `Filter(Filter(x, p2), p1)` -> `Filter(x, p1 AND p2)`.
            Plan::Filter {
                input: inner,
                pred: p_inner,
            } => (
                Plan::Filter {
                    input: inner,
                    pred: Expr::And(Box::new(pred), Box::new(p_inner)),
                },
                true,
            ),
            // predicate pushdown below an Expand: legal for any conjunct that reads
            // only slots existing BELOW the expand (i.e. not the slot the expand
            // appends, whose index equals the input's width).
            //
            // SPLIT, for the same reason VarLength splits below. An all-or-nothing
            // guard refuses a MIXED conjunction outright, and a mixed conjunction is
            // what the ordinary pattern `(a:L)-[:T]->(b:M) WHERE a.k > v` becomes:
            // the two labels lower to two stacked filters, the merge rule fuses them
            // into one `And` with the predicate, and from then on the slot-0 conjunct
            // that could have SEEDED the scan is trapped above the hop by the slot-1
            // label check sitting next to it. Measured (200k x 8, range index on
            // `age`): 9382us against 31.6us for the same query with the far node left
            // unlabelled — writing a label made it 300x slower.
            //
            // The `any_pushable` guard is load-bearing: without it this arm matches
            // EVERY Expand and starves the interval-overlap fusion arm below, whose
            // predicate reads the bound edge slot and is pushable by nothing.
            Plan::Expand {
                input: ein,
                from,
                dir,
                edge_label,
                bind_edge,
                double_loops,
            } if any_pushable(&pred, width(&ein)) => {
                let (below, above) = split_pushable(pred, width(&ein));
                let pushed = below.is_some();
                let input = match below {
                    Some(below) => Box::new(Plan::Filter {
                        input: ein,
                        pred: below,
                    }),
                    None => ein,
                };
                let ex = Plan::Expand {
                    input,
                    from,
                    dir,
                    edge_label,
                    bind_edge,
                    double_loops,
                };

                match above {
                    // Everything pushed.
                    None => (ex, true),
                    // A residual stays above. `changed` is true only when a conjunct
                    // actually moved — otherwise this rebuilds the same plan forever
                    // and the fixpoint spins to its iteration cap on every query.
                    Some(above) => (
                        Plan::Filter {
                            input: Box::new(ex),
                            pred: above,
                        },
                        pushed,
                    ),
                }
            }
            // predicate pushdown below a VarLength / ShortestPath: both append the
            // reached endpoint at slot `width(input)`, keeping every input slot in
            // place, so any conjunct that reads only those input slots (the classic
            // case: a filter on the traversal SOURCE, `WHERE a.age = 1`) filters the
            // input BEFORE the expansion. The predicate is SPLIT — the source part is
            // pushed, a residual on the target stays above — because otherwise a
            // mixed `a.age = 1 AND b.age = 2` refuses to push at all and the walk
            // runs from every node: catastrophic for an unbounded `->*` reach
            // (measured: a source-filtered ANY SHORTEST went from "does not finish"
            // to instant).
            Plan::VarLength {
                input: vin,
                from,
                dir,
                edge_label,
                min,
                max,
                mode,
                until,
                body_filter,
                double_loops,
                path_need,
            } => {
                let (below, above) = split_pushable(pred, width(&vin));
                match below {
                    // No conjunct reads only the input — rebuild unchanged.
                    None => {
                        let vl = Plan::VarLength {
                            input: vin,
                            from,
                            dir,
                            edge_label,
                            min,
                            max,
                            mode,
                            until,
                            body_filter,
                            double_loops,
                            path_need,
                        };
                        (
                            Plan::Filter {
                                input: Box::new(vl),
                                pred: above.expect("a filter predicate is non-empty"),
                            },
                            false,
                        )
                    }
                    Some(below) => {
                        let inner = Plan::VarLength {
                            input: Box::new(Plan::Filter {
                                input: vin,
                                pred: below,
                            }),
                            from,
                            dir,
                            edge_label,
                            min,
                            max,
                            mode,
                            until,
                            body_filter,
                            double_loops,
                            path_need,
                        };
                        match above {
                            Some(a) => (
                                Plan::Filter {
                                    input: Box::new(inner),
                                    pred: a,
                                },
                                true,
                            ),
                            None => (inner, true),
                        }
                    }
                }
            }
            Plan::ShortestPath {
                input: sin,
                from,
                dir,
                edge_label,
                min,
                max,
                selector,
                edge_pred,
                path_need,
            } => {
                let (below, above) = split_pushable(pred, width(&sin));
                match below {
                    None => {
                        let sp = Plan::ShortestPath {
                            input: sin,
                            from,
                            dir,
                            edge_label,
                            min,
                            max,
                            selector,
                            edge_pred,
                            path_need,
                        };
                        (
                            Plan::Filter {
                                input: Box::new(sp),
                                pred: above.expect("a filter predicate is non-empty"),
                            },
                            false,
                        )
                    }
                    Some(below) => {
                        let inner = Plan::ShortestPath {
                            input: Box::new(Plan::Filter {
                                input: sin,
                                pred: below,
                            }),
                            from,
                            dir,
                            edge_label,
                            min,
                            max,
                            selector,
                            edge_pred,
                            path_need,
                        };
                        match above {
                            Some(a) => (
                                Plan::Filter {
                                    input: Box::new(inner),
                                    pred: a,
                                },
                                true,
                            ),
                            None => (inner, true),
                        }
                    }
                }
            }
            // interval-overlap fusion: `Filter(r.lo <= X AND r.hi >= Y)` over a
            // bind_edge Expand → an `IntervalExpand` (seek-or-scan). The predicate
            // reads the bound EDGE slot (= the expand's input width), so the
            // pushdown arm above never fires for it; here it fuses into the hop so
            // an interval-indexed store can seek. Non-interval predicates on the
            // edge fall through unchanged.
            Plan::Expand {
                input: ein,
                from,
                dir,
                edge_label,
                bind_edge: true,
                double_loops,
            } => {
                let iw = width(&ein);
                if let Some((lo_key, hi_key, qlo, qhi)) = interval_pattern(&pred, iw) {
                    (
                        Plan::IntervalExpand {
                            input: ein,
                            from,
                            dir,
                            edge_label,
                            lo_key,
                            hi_key,
                            qlo: Box::new(qlo),
                            qhi: Box::new(qhi),
                            bind_edge: true,
                        },
                        true,
                    )
                } else {
                    (
                        Plan::Filter {
                            input: Box::new(Plan::Expand {
                                input: ein,
                                from,
                                dir,
                                edge_label,
                                bind_edge: true,
                                double_loops,
                            }),
                            pred,
                        },
                        false,
                    )
                }
            }
            // predicate pushdown into a Join's LEFT side: legal when the predicate
            // reads only left slots (indices < left width; the join keeps the left
            // slots' indices, so no remap is needed). Right-side pushdown would
            // need a slot remap and is deferred.
            Plan::Join { left, right, on } if refs_below(&pred, width(&left)) => (
                Plan::Join {
                    left: Box::new(Plan::Filter { input: left, pred }),
                    right,
                    on,
                },
                true,
            ),
            // index seed: `Filter(prop <op> literal) over Scan(label)` -> a seek.
            // `=` seeds an IndexSeek, a range op a RangeSeek; both are semantic
            // no-ops (the seek yields exactly Scan+Filter rows) and both spellings
            // are handled (see `seek_target`/`range_seek_target`) so neither
            // silently keeps scanning.
            // An UNLABELLED scan seeds too. The label was once required here, which
            // meant `MATCH (n) WHERE n.age > 98` could never touch an index —
            // measured 303us against 30.6us for the labelled spelling over the same
            // rows. Both property indexes are global, so the label was only ever a
            // post-filter on the seek's output (see `Plan::IndexSeek`).
            Plan::Scan { label: l } => {
                if let Some((key, value)) =
                    seek_target(&pred).filter(|(k, v)| eq_seek_worth_it(idx, k, v))
                {
                    (
                        Plan::IndexSeek {
                            label: l,
                            key,
                            value,
                        },
                        true,
                    )
                } else if let Some((key, op, value)) = range_seek_target(&pred)
                    .filter(|(k, _, _)| idx.has_range_index(k))
                    .filter(|(k, op, v)| seek_beats_scan(idx, k, *op, v))
                {
                    // Only seed a RangeSeek when a range index can actually serve it.
                    // Without one, RangeSeek's fallback SCANS and BOXES each cell, which
                    // is SLOWER than leaving a `Filter(Scan)` — that hits the vectorized
                    // raw-`&str`/raw-f64 compare in `try_filter_keep`. (A standalone
                    // range predicate here must match the conjunct path, which already
                    // gates its Range seed on `has_range_index`.)
                    (
                        Plan::RangeSeek {
                            label: l,
                            key,
                            op,
                            value,
                        },
                        true,
                    )
                } else if let Some((seed, residual)) = seed_from_conjuncts(&pred, idx) {
                    // `Filter(a = x AND …)(Scan)` — seed ONE conjunct and keep the rest
                    // as a residual filter over the seek, so `WHERE k = x AND …` costs
                    // the same as the inline `(n:L {k: x, …})` (which seeds because it
                    // lowers to stacked single filters). Without this a multi-predicate
                    // WHERE ran the whole conjunction over a full Scan — measured 34x
                    // its inline twin. The seek is semantically Scan+Filter(conjunct),
                    // so peeling one conjunct out is a no-op on the rows.
                    let seek = match seed {
                        Seed::Index(key, value) => Plan::IndexSeek {
                            label: l,
                            key,
                            value,
                        },
                        Seed::Range(key, op, value) => Plan::RangeSeek {
                            label: l,
                            key,
                            op,
                            value,
                        },
                    };
                    let out = match residual {
                        Some(pred) => Plan::Filter {
                            input: Box::new(seek),
                            pred,
                        },
                        None => seek,
                    };
                    (out, true)
                } else {
                    (
                        Plan::Filter {
                            input: Box::new(Plan::Scan { label: l }),
                            pred,
                        },
                        false,
                    )
                }
            }
            other => (
                Plan::Filter {
                    input: Box::new(other),
                    pred,
                },
                false,
            ),
        },
        other => (other, false),
    }
}

/// Does `expr` reference only slots `< bound` (so it can move below an operator
/// whose output starts at slot `bound`)? An expression that references no slots
/// (a constant, or a Path) trivially qualifies.
fn refs_below(expr: &Expr, bound: usize) -> bool {
    max_slot(expr).is_none_or(|m| m < bound)
}

/// Flatten a top-level AND tree into its conjuncts (order preserved).
fn flatten_and(e: Expr, out: &mut Vec<Expr>) {
    match e {
        Expr::And(a, b) => {
            flatten_and(*a, out);
            flatten_and(*b, out);
        }
        other => out.push(other),
    }
}

/// Rebuild a left-leaning AND-chain from conjuncts; `None` if empty.
fn and_all(conjs: Vec<Expr>) -> Option<Expr> {
    let mut it = conjs.into_iter();
    let first = it.next()?;
    Some(it.fold(first, |acc, e| Expr::And(Box::new(acc), Box::new(e))))
}

/// Flatten a top-level OR tree into its disjuncts (order preserved).
fn flatten_or(e: Expr, out: &mut Vec<Expr>) {
    match e {
        Expr::Or(a, b) => {
            flatten_or(*a, out);
            flatten_or(*b, out);
        }
        other => out.push(other),
    }
}

/// Rebuild a left-leaning OR-chain from disjuncts; `None` if empty.
fn or_all(disj: Vec<Expr>) -> Option<Expr> {
    let mut it = disj.into_iter();
    let first = it.next()?;
    Some(it.fold(first, |acc, e| Expr::Or(Box::new(acc), Box::new(e))))
}

/// A numeric bound `Prop{slot,key} <op> Num` (or the mirror) — the atom the
/// contradiction simplifier reasons over. `None` for anything else.
fn num_bound(e: &Expr) -> Option<(usize, String, CompareOp, f64)> {
    let Expr::Compare { op, left, right } = e else {
        return None;
    };
    match (left.as_ref(), right.as_ref()) {
        (Expr::Prop { slot, key }, Expr::Lit(crate::value::Value::Num(v))) => {
            Some((*slot, key.clone(), *op, *v))
        }
        (Expr::Lit(crate::value::Value::Num(v)), Expr::Prop { slot, key }) => {
            Some((*slot, key.clone(), flip_cmp(*op), *v))
        }
        _ => None,
    }
}

/// Are two numeric bounds on the SAME property jointly UNSATISFIABLE for every present
/// value (`x < 26` AND `x >= 71`)? Builds the feasible interval (tightest lower, tightest
/// upper) and reports it empty. Conservative: `Ne` bounds and any non-overlap it cannot
/// prove return `false` (keep the branch). NULL is irrelevant — a NULL cell makes both the
/// original and the simplified predicate UNKNOWN, so pruning a provably-false disjunct is
/// three-valued-safe.
fn bounds_contradict(a: (CompareOp, f64), b: (CompareOp, f64)) -> bool {
    let mut lo: Option<(f64, bool)> = None; // (value, inclusive)
    let mut hi: Option<(f64, bool)> = None;
    let tighten_lo = |lo: &mut Option<(f64, bool)>, v: f64, incl: bool| {
        if lo.is_none_or(|(cur, ci)| v > cur || (v == cur && !incl && ci)) {
            *lo = Some((v, incl));
        }
    };
    let tighten_hi = |hi: &mut Option<(f64, bool)>, v: f64, incl: bool| {
        if hi.is_none_or(|(cur, ci)| v < cur || (v == cur && !incl && ci)) {
            *hi = Some((v, incl));
        }
    };
    for (op, v) in [a, b] {
        match op {
            CompareOp::Gt => tighten_lo(&mut lo, v, false),
            CompareOp::Ge => tighten_lo(&mut lo, v, true),
            CompareOp::Lt => tighten_hi(&mut hi, v, false),
            CompareOp::Le => tighten_hi(&mut hi, v, true),
            CompareOp::Eq => {
                tighten_lo(&mut lo, v, true);
                tighten_hi(&mut hi, v, true);
            }
            CompareOp::Ne => return false, // a hole, not an interval bound
        }
    }
    match (lo, hi) {
        (Some((l, li)), Some((h, hii))) => l > h || (l == h && !(li && hii)),
        _ => false,
    }
}

/// `X AND (Y OR Z)` where `X ∧ Z` is numerically contradictory ⇒ `Z` can never hold for a
/// row that also satisfies `X`, so it drops out of the OR (`(X AND Y) OR (X AND false)` =
/// `X AND Y`). Given the AND's sibling numeric `bounds`, prune every disjunct of an OR
/// conjunct that a sibling contradicts; a fully-pruned OR is unsatisfiable under the AND
/// (Lit false). Non-OR conjuncts pass through. Logically exact → byte-identical.
fn prune_or_branches(e: Expr, bounds: &[(usize, String, CompareOp, f64)]) -> Expr {
    if !matches!(e, Expr::Or(_, _)) {
        return e;
    }
    let mut disj = Vec::new();
    flatten_or(e, &mut disj);
    let before = disj.len();
    disj.retain(|d| match num_bound(d) {
        Some((s, k, op, v)) => !bounds.iter().any(|(bs, bk, bop, bv)| {
            *bs == s && *bk == k && bounds_contradict((op, v), (*bop, *bv))
        }),
        None => true, // keep non-numeric disjuncts (unanalyzed)
    });
    if disj.len() == before {
        return or_all(disj).expect("non-empty: nothing was pruned");
    }
    or_all(disj).unwrap_or(Expr::Lit(crate::value::Value::Bool(false)))
}

/// Does ANY top-level conjunct of `pred` read only slots `< bound`? The cheap
/// non-consuming precheck [`split_pushable`] needs as a match guard, so an arm that
/// would push nothing declines and lets a later arm match the same operator.
fn any_pushable(e: &Expr, bound: usize) -> bool {
    match e {
        Expr::And(a, b) => any_pushable(a, bound) || any_pushable(b, bound),
        other => refs_below(other, bound),
    }
}

/// Split `pred`'s conjuncts into those referencing only slots `< bound` (pushable
/// below an operator that appends slots ≥ `bound`) and the rest. AND is symmetric
/// for the keep-TRUE filter, so re-grouping is exact. Returns `(below, above)`.
fn split_pushable(pred: Expr, bound: usize) -> (Option<Expr>, Option<Expr>) {
    let mut conj = Vec::new();
    flatten_and(pred, &mut conj);
    let (below, above): (Vec<Expr>, Vec<Expr>) =
        conj.into_iter().partition(|c| refs_below(c, bound));
    (and_all(below), and_all(above))
}

/// Classify one comparison against the edge in slot `edge_slot` as an interval
/// endpoint constraint: `Prop{edge_slot,k} <= bound` (the LO axis, `false`) or
/// `Prop{edge_slot,k} >= bound` (the HI axis, `true`), including the mirrored
/// spellings (`bound >= prop`, `bound <= prop`). Returns `(is_hi, key, bound)`.
fn interval_side(c: &Expr, edge_slot: usize) -> Option<(bool, String, Expr)> {
    let Expr::Compare { op, left, right } = c else {
        return None;
    };
    // Put the edge Prop on the left, flipping the operator if it was on the right.
    let (key, bound, op) = match (&**left, &**right) {
        (Expr::Prop { slot, key }, _) if *slot == edge_slot => {
            (key.clone(), (**right).clone(), *op)
        }
        (_, Expr::Prop { slot, key }) if *slot == edge_slot => {
            (key.clone(), (**left).clone(), flip_cmp(*op))
        }
        _ => return None,
    };
    match op {
        CompareOp::Le => Some((false, key, bound)), // prop <= bound → lo axis
        CompareOp::Ge => Some((true, key, bound)),  // prop >= bound → hi axis
        _ => None,                                  // strict/eq don't map to closed overlap
    }
}

/// Swap the operands' order of a comparison (so `a OP b` ⇔ `b flip(OP) a`).
fn flip_cmp(op: CompareOp) -> CompareOp {
    match op {
        CompareOp::Lt => CompareOp::Gt,
        CompareOp::Gt => CompareOp::Lt,
        CompareOp::Le => CompareOp::Ge,
        CompareOp::Ge => CompareOp::Le,
        CompareOp::Eq => CompareOp::Eq,
        CompareOp::Ne => CompareOp::Ne,
    }
}

/// Recognize `r.lo <= X AND r.hi >= Y` (in any spelling/order) on the edge bound
/// at slot `edge_slot` (which equals the expand's input width). Returns
/// `(lo_key, hi_key, qlo, qhi)` for an `IntervalExpand` (`qlo = Y`, `qhi = X`).
/// Both bounds must be evaluable over the input row (reference only slots below
/// the hop), so they never depend on the edge/node the hop appends.
fn interval_pattern(pred: &Expr, edge_slot: usize) -> Option<(String, String, Expr, Expr)> {
    let Expr::And(a, b) = pred else { return None };
    let sa = interval_side(a, edge_slot)?;
    let sb = interval_side(b, edge_slot)?;
    // Need exactly one lo-axis and one hi-axis constraint.
    let ((_, lo_key, qhi), (_, hi_key, qlo)) = match (sa.0, sb.0) {
        (false, true) => (sa, sb),
        (true, false) => (sb, sa),
        _ => return None,
    };
    if !refs_below(&qhi, edge_slot) || !refs_below(&qlo, edge_slot) {
        return None;
    }
    Some((lo_key, hi_key, qlo, qhi))
}

/// The highest slot index an expression reads, or `None` if it reads no slots.
fn max_slot(expr: &Expr) -> Option<usize> {
    match expr {
        Expr::Slot(n) => Some(*n),
        Expr::Prop { slot, .. } | Expr::IsLabeled { slot, .. } => Some(*slot),
        Expr::Lit(_) | Expr::Param(_) => None,
        // A path-reading expression (`simplePath`'s `not(path_has_dup(Path))`,
        // `path()` accessors) depends on EVERY hop taken, not on a fixed slot — so it
        // must never be pushed below an Expand / VarLength / ShortestPath that extends
        // the path. Claim it reads the topmost possible slot so `refs_below` is always
        // false. (Without this, filter-pushdown moved the simplePath filter below the
        // Expands that build the path, where it saw a one-node path and passed
        // everything — silently dropping the filter.)
        Expr::Path
        | Expr::PathAccess { .. }
        | Expr::GremlinPath { .. }
        | Expr::GremlinFullPath { .. } => Some(usize::MAX),
        Expr::Not(x) => max_slot(x),
        Expr::And(a, b)
        | Expr::Or(a, b)
        | Expr::Xor(a, b)
        | Expr::Arith {
            left: a, right: b, ..
        }
        | Expr::In {
            needle: a,
            haystack: b,
        } => merge_max(max_slot(a), max_slot(b)),
        Expr::Call { args, .. } | Expr::GraphPred { args, .. } | Expr::List { items: args } => {
            args.iter().fold(None, |acc, a| merge_max(acc, max_slot(a)))
        }
        Expr::Record { fields }
        | Expr::MapLit {
            entries: fields, ..
        } => fields
            .iter()
            .fold(None, |acc, (_, e)| merge_max(acc, max_slot(e))),
        Expr::Field { base, .. } => max_slot(base),
        Expr::Index { base, index, .. } => merge_max(max_slot(base), max_slot(index)),
        Expr::Case {
            branches,
            otherwise,
        } => {
            let mut m = otherwise.as_deref().and_then(max_slot);
            for (c, v) in branches {
                m = merge_max(m, merge_max(max_slot(c), max_slot(v)));
            }
            m
        }
        Expr::Compare { left, right, .. } => merge_max(max_slot(left), max_slot(right)),
        Expr::Cast { expr, .. } | Expr::IsNull { expr, .. } => max_slot(expr),
        Expr::PropertyExists { slot, .. } => Some(*slot),
        // EXISTS correlates on outer slots below `outer_width`; claim it reads up
        // to the topmost, so the predicate is never pushed below an operator that
        // binds a variable it might reference.
        Expr::Exists { outer_width, .. }
        | Expr::CountSubquery { outer_width, .. }
        | Expr::ScalarSubquery { outer_width, .. }
        | Expr::CollectSubquery { outer_width, .. }
        | Expr::AggSubquery { outer_width, .. } => outer_width.checked_sub(1),
        // An uncorrelated body reads no outer slot.
        Expr::UncorrelatedExists { .. }
        | Expr::UncorrelatedCount { .. }
        | Expr::UncorrelatedScalar { .. } => None,
    }
}

fn merge_max(a: Option<usize>, b: Option<usize>) -> Option<usize> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, None) | (None, x) => x,
    }
}

/// The number of slots a plan's output rows carry — used to know which slots
/// exist below an operator for pushdown legality.
pub(crate) fn width(plan: &Plan) -> usize {
    match plan {
        Plan::Scan { .. }
        | Plan::NodeSeed { .. }
        | Plan::EdgeScan
        | Plan::EdgeSeed { .. }
        | Plan::IndexSeek { .. }
        | Plan::RangeSeek { .. } => 1,
        // A named procedure yields exactly two columns: node id + its result.
        Plan::CallProcedure { .. } => 2,
        // `Row` never appears in an outer plan (it lives only in an EXISTS body,
        // which pushdown does not traverse); width is meaningless here.
        Plan::Row => 0,
        // Unwind appends the element and, optionally, an ordinal counter.
        Plan::Unwind { input, ordinal, .. } => width(input) + 1 + usize::from(ordinal.is_some()),
        // Writes carry no output row. `InsertReturn` is a write too — its RETURN
        // rows are produced by the executor, not by this read-side width pass.
        Plan::Insert { .. }
        | Plan::InsertFrom { .. }
        | Plan::InsertReturn { .. }
        | Plan::Update { .. }
        | Plan::UpdateReturn { .. }
        | Plan::Merge { .. }
        | Plan::MergeEdge { .. }
        | Plan::AddEdge { .. }
        | Plan::AddEdgeStep { .. }
        | Plan::AddVertexStep { .. }
        | Plan::TxControl { .. } => 0,

        // A bind_edge Expand appends TWO slots (edge then node).
        Plan::Expand {
            input, bind_edge, ..
        }
        | Plan::IntervalExpand {
            input, bind_edge, ..
        } => width(input) + if *bind_edge { 2 } else { 1 },
        Plan::VarLength { input, .. } | Plan::ShortestPath { input, .. } => width(input) + 1,
        // A Branch (union/coalesce/optional/choose) concatenates its bodies, each RECONVERGED
        // to a single frontier column — so its output is that body width (1), NOT
        // `width(input) + 1`. Over-counting it let filter-pushdown move a predicate that reads
        // the branch's frontier slot below an Expand that produces it (out-of-range at run).
        Plan::Branch { bodies, .. } => bodies.first().map_or(1, width),
        // Every arm reconverges to a single frontier column, so the output is width-1.
        Plan::PerElementBranch { .. } => 1,
        Plan::Reconverge { .. } => 1,
        // A bound-edge OPTIONAL MATCH appends the edge column too.
        Plan::OptionalExpand {
            input, bind_edge, ..
        } => width(input) + if *bind_edge { 2 } else { 1 },
        // The endpoint column plus one list column per group variable.
        Plan::RepeatGroup {
            input, group_binds, ..
        } => width(input) + 1 + group_binds.len(),
        // The endpoint column plus one (possibly nested) list column per bound var.
        Plan::NestedGroup {
            input, bind_slots, ..
        } => width(input) + 1 + bind_slots.len(),
        Plan::PathRecord { input, .. }
        | Plan::Filter { input, .. }
        | Plan::OrderPage { input, .. }
        | Plan::Distinct { input }
        | Plan::Fail { input, .. }
        | Plan::DistinctBy { input, .. }
        | Plan::Tail { input, .. }
        | Plan::Sample { input, .. }
        | Plan::SortLocal { input, .. } => width(input),
        // The padded null row carries exactly the pattern's columns.
        Plan::NullPadIfEmpty { width, .. } => *width,
        // A left-outer correlated scan appends the matched (or NULL) node.
        Plan::OptionalScan { input, .. } => width(input) + 1,
        Plan::Project { items, .. } => items.len(),
        Plan::Aggregate { keys, aggs, .. } => keys.len() + aggs.len(),
        Plan::GroupToMap { .. } => 1,
        Plan::Tree { .. } => 1,
        Plan::MapSlot { input, append, .. } => width(input) + usize::from(*append),
        Plan::EdgeVertex { input, .. } => width(input) + 1,
        Plan::Subgraph { .. } => 1,
        Plan::Enumerate { .. } => 1,
        Plan::ShortestPathEnum { .. } => 1,
        Plan::AlgoAnnotate { input, .. } => width(input) + 1,
        Plan::Join { left, right, .. } => width(left) + width(right),
        // UNION's result columns are the LEFT arm's.
        Plan::Union { left, .. } => width(left),
        // Outer slots kept, plus one column per yielded subquery expression.
        Plan::CallInline {
            outer_width,
            yields,
            ..
        } => outer_width + yields.len(),
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod rewrite_fuzz;

// ─────────────────────────────────────────────────────────── pattern orientation ───

/// Rewrite every slot index in an expression through `f`, or refuse.
///
/// Refuses (`None`) for anything whose slot references are not plainly local: a
/// correlated subquery carries its own `outer_width` and a body that reads outer
/// slots by index, and a path expression depends on the ORDER hops were taken, which
/// a reversal changes. Refusing keeps [`reverse_chain`] honest — it only reverses a
/// pattern when every consumer above it can be renamed exactly.
fn map_slots(e: &Expr, f: &dyn Fn(usize) -> usize) -> Option<Expr> {
    let rec = |x: &Expr| map_slots(x, f);
    let pair = |x: &Expr, y: &Expr| Some((Box::new(rec(x)?), Box::new(rec(y)?)));

    Some(match e {
        Expr::Slot(n) => Expr::Slot(f(*n)),
        Expr::Prop { slot, key } => Expr::Prop {
            slot: f(*slot),
            key: key.clone(),
        },
        Expr::IsLabeled { slot, labels } => Expr::IsLabeled {
            slot: f(*slot),
            labels: labels.clone(),
        },
        Expr::PropertyExists { slot, key } => Expr::PropertyExists {
            slot: f(*slot),
            key: key.clone(),
        },
        Expr::Lit(_) | Expr::Param(_) => e.clone(),
        Expr::Not(x) => Expr::Not(Box::new(rec(x)?)),
        Expr::And(x, y) => {
            let (l, r) = pair(x, y)?;
            Expr::And(l, r)
        }
        Expr::Or(x, y) => {
            let (l, r) = pair(x, y)?;
            Expr::Or(l, r)
        }
        Expr::Xor(x, y) => {
            let (l, r) = pair(x, y)?;
            Expr::Xor(l, r)
        }
        Expr::In { needle, haystack } => {
            let (l, r) = pair(needle, haystack)?;
            Expr::In {
                needle: l,
                haystack: r,
            }
        }
        Expr::Arith { op, left, right } => {
            let (l, r) = pair(left, right)?;
            Expr::Arith {
                op: *op,
                left: l,
                right: r,
            }
        }
        Expr::Compare { op, left, right } => {
            let (l, r) = pair(left, right)?;
            Expr::Compare {
                op: *op,
                left: l,
                right: r,
            }
        }
        Expr::Call { name, args } => Expr::Call {
            name: name.clone(),
            args: args.iter().map(rec).collect::<Option<Vec<_>>>()?,
        },
        Expr::GraphPred { op, args, negated } => Expr::GraphPred {
            op: *op,
            args: args.iter().map(rec).collect::<Option<Vec<_>>>()?,
            negated: *negated,
        },
        Expr::List { items } => Expr::List {
            items: items.iter().map(rec).collect::<Option<Vec<_>>>()?,
        },
        Expr::Cast { target, expr } => Expr::Cast {
            target: *target,
            expr: Box::new(rec(expr)?),
        },
        Expr::IsNull { expr, negated } => Expr::IsNull {
            expr: Box::new(rec(expr)?),
            negated: *negated,
        },
        Expr::Field { base, key } => Expr::Field {
            base: Box::new(rec(base)?),
            key: key.clone(),
        },
        // Everything else — records, maps, CASE, index reads, the subquery family,
        // every path expression — is either structurally awkward to rename or
        // order-dependent. A pattern carrying one simply does not get oriented.
        _ => return None,
    })
}

/// One hop of a fixed-length chain, peeled out so it can be re-emitted reversed.
struct Hop {
    dir: crate::ir::Dir,
    edge_label: Vec<String>,
    /// A predicate sitting immediately ABOVE this hop, reading the slot it appends
    /// (the classic case: the `(b:M)` label in the middle of a two-hop pattern).
    above: Option<Expr>,
}

/// Peel `Expand <- [Filter] <- Expand <- … <- Scan` into the seed's label and the hops
/// in WRITTEN order (first hop first). `None` unless every level is a plain forward
/// hop over the current frontier with no bound edge.
fn peel_hops(plan: &Plan) -> Option<(Option<String>, Vec<Hop>)> {
    match plan {
        Plan::Scan { label } => Some((label.clone(), Vec::new())),
        Plan::Filter { input, pred } => {
            // An intermediate filter belongs to the hop below it, and may only read
            // that hop's endpoint — otherwise reversing moves it across a slot it
            // constrains.
            let (label, mut hops) = peel_hops(input)?;
            let endpoint = hops.len();
            let last = hops.last_mut()?;
            if last.above.is_some() || !reads_only_slot(pred, endpoint) {
                return None;
            }
            last.above = Some(pred.clone());
            Some((label, hops))
        }
        Plan::Expand {
            input,
            from,
            dir,
            edge_label,
            bind_edge: false,
            double_loops: false,
        } => {
            let (label, mut hops) = peel_hops(input)?;
            // The hop must extend the CURRENT frontier: slot `hops.len()` is the last
            // one appended, and slot 0 is the seed.
            if *from != hops.len() {
                return None;
            }
            hops.push(Hop {
                dir: *dir,
                edge_label: edge_label.clone(),
                above: None,
            });
            Some((label, hops))
        }
        _ => None,
    }
}

/// Exchange two slot indices, leaving the rest alone.
fn swap_slots(e: &Expr, a: usize, b: usize) -> Option<Expr> {
    map_slots(e, &move |s| {
        if s == a {
            b
        } else if s == b {
            a
        } else {
            s
        }
    })
}

/// Does `e` read slot `s` and NO OTHER slot?
///
/// `max_slot(e) == Some(s)` is NOT this, and the difference is a shipped bug: a
/// predicate reading slots {1, 4} has a maximum of 4, so a check for "belongs to hop
/// 4" accepted it and then renamed it as though slot 1 were not there. `reverse_chain`
/// documents the same trap for the FAR predicate, where a maximum of 0 happens to be
/// sufficient because 0 is also the minimum — the middle of a chain has no such luck.
///
/// Implemented by probing: map every slot that is not `s` to `usize::MAX` and ask for
/// the maximum. Anything other than `s` present, or a path expression (which already
/// claims `usize::MAX`), pushes the answer past `s`.
fn reads_only_slot(e: &Expr, s: usize) -> bool {
    map_slots(e, &move |x| if x == s { s } else { usize::MAX })
        .is_some_and(|probe| max_slot(&probe) == Some(s))
}

/// The rename a reversal performs: slot `i` of an `n`-hop pattern becomes slot
/// `n - i`. The ends trade places and, for an odd-length chain, the middle stays put.
///
/// This replaced a single `swap_slots(_, 0, n)`, which is the same permutation only
/// while n <= 2 and silently the WRONG one above that — at three hops it would leave
/// slots 1 and 2 crossed. Expressing the whole permutation is what lifts the hop
/// limit, and three hops is where the largest measured gap on this branch lives
/// (263,502us written forwards against 37.4us written backwards, at 50k nodes).
fn reverse_slots(e: &Expr, far: usize) -> Option<Expr> {
    map_slots(e, &move |s| if s <= far { far - s } else { s })
}

/// Re-seed a fixed-length chain at slot `at`, walking OUTWARD from there — the
/// generalization of [`reverse_chain`], which is the case `at == far`.
///
/// When the selective predicate sits in the MIDDLE of a pattern, reversing the whole
/// chain does not help: whichever end you start from, the predicate is still somewhere
/// in the interior. Splitting does. `MATCH (a:L)-[:T]->(b:M)-[:T]->(c:N) WHERE b.k > v`
/// seeds `b` from its index, walks BACKWARDS to `a`, then forwards to `c`. Measured on
/// 100k nodes x 5 edges with a range index on `age`, `count(*)` with the predicate on the
/// middle node:
///
/// ```text
///   written forwards                678.8us   Filter <- Expand <- Filter <- Expand <- Scan
///   hand-split at the middle        209.7us   Filter <- Expand <- Filter <- Expand <- RangeSeek
/// ```
///
/// The `at == far` case is plain ORIENTATION — reverse the whole chain so a far-side
/// predicate seeds it — and carries its own measured history, on 200k nodes x 8 edges with a
/// range index on `age`, `count(*)` with the predicate on the far node:
///
/// ```text
///   1 hop    written forwards    1652us   reversed                  499us
///   2 hops   written forwards  178357us   reversed                 2148us     83x
///   3 hops   written forwards  263502us   hand-written backwards     37us   7045x
///            (3 hops measured at 50k nodes, the others at 200k)
/// ```
///
/// THE PERMUTATION IS THE SAME ONE. New position of original slot `s` is `at - s` for
/// `s <= at` and `s` above it — which is exactly [`reverse_slots`] with `at` as its
/// pivot. So every consumer rename in `orient_scan`/`orient_apply` works unchanged, and
/// there is one definition of the rename rather than two that can drift.
///
/// The emission order is the new positions in order: `at` first, then leftward to the
/// original seed, then rightward to the far end. The left hops are flipped, the right
/// hops keep their direction. The right branch expands from the SEED slot again (`from:
/// 0` at a width of `at + 1`), which the executor supports.
///
/// Deliberately narrow, exactly as `reverse_chain` was: a chain of plain hops over a
/// `Scan`, no bound edge, no `double_loops`, every predicate reading ONE slot, and a
/// pivot predicate that survives being renamed onto slot 0. Anything else is left as
/// written — a wrong slot rename is a silently wrong answer.
fn split_chain(plan: Plan, at: usize) -> Option<(Plan, usize)> {
    let (top_pred, chain) = match plan {
        Plan::Filter { input, pred } => (Some(pred), *input),
        other => (None, other),
    };
    let (seed_label, hops) = peel_hops(&chain)?;
    let far = hops.len();
    if far == 0 || at == 0 || at > far {
        return None; // nothing to re-seed, or it is already the seed
    }

    // Every predicate the pattern carries, keyed by the ORIGINAL slot it reads. One slot
    // may carry at most one: two would need merging, and merging is not this rewrite's
    // job.
    let mut by_slot: Vec<Option<Expr>> = (0..=far).map(|_| None).collect();
    if let Some(p) = top_pred {
        // A residual filter above the pattern must read exactly one slot, or the rename
        // cannot place it. `reads_only_slot` and not `max_slot` — see its docstring for
        // the shipped bug that distinction cost.
        let s = (0..=far).find(|&s| reads_only_slot(&p, s))?;
        by_slot[s] = Some(p);
    }
    for (h, hop) in hops.iter().enumerate() {
        if let Some(p) = &hop.above {
            // `peel_hops` already checked this reads only slot `h + 1`.
            if by_slot[h + 1].replace(p.clone()).is_some() {
                return None;
            }
        }
    }
    if let Some(l) = seed_label {
        // The original seed's label is just a predicate on slot 0; it travels with that
        // slot like any other. (`peel_hops` declines a Filter directly over the `Scan`,
        // so slot 0 cannot already be occupied — but a top-level filter reading slot 0
        // could, and that is a decline rather than a merge.)
        let lab = Expr::IsLabeled {
            slot: 0,
            labels: vec![l],
        };
        if by_slot[0].replace(lab).is_some() {
            return None;
        }
    }

    // The pivot's own predicate becomes the seed, renamed onto slot 0.
    let pivot = by_slot[at].take()?;
    let seed_pred = reverse_slots(&pivot, at)?;
    // Exact check that the pivot read ONLY its own slot: if it did, the renamed form
    // reads only slot 0. `max_slot` is sufficient here because 0 is also the minimum.
    if max_slot(&seed_pred) != Some(0) {
        return None;
    }
    // The pivot node's own label is lifted onto the seed `Scan` so the ordinary seeding
    // rule can emit a `RangeSeek`/`IndexSeek` over it.
    let (lifted, residual) = lift_seed_label(seed_pred);
    let mut out = match residual {
        Some(pred) => Plan::Filter {
            input: Box::new(Plan::Scan { label: lifted }),
            pred,
        },
        None => Plan::Scan { label: lifted },
    };

    // Everything else, renamed to the slot it will occupy. Placed by the slot it ENDS UP
    // reading, never by the hop it came from: deriving the position from a loop index is
    // what once put a two-hop pattern's middle label on its far end and silently dropped
    // rows.
    let new_pos = |s: usize| if s <= at { at - s } else { s };
    let mut placed: Vec<Option<Expr>> = (0..=far).map(|_| None).collect();
    for (s, p) in by_slot.into_iter().enumerate() {
        let Some(p) = p else { continue };
        let np = new_pos(s);
        let moved = shift_slot(&p, s, np)?;
        if placed[np].replace(moved).is_some() {
            return None;
        }
    }

    // LEFT: new slots 1..=at, walking the original hops from `at - 1` down to 0, flipped.
    for i in 0..at {
        let hop = &hops[at - 1 - i];
        out = Plan::Expand {
            input: Box::new(out),
            from: i,
            dir: flip_dir(hop.dir),
            edge_label: hop.edge_label.clone(),
            bind_edge: false,
            double_loops: false,
        };
        if let Some(p) = placed[i + 1].take() {
            out = Plan::Filter {
                input: Box::new(out),
                pred: p,
            };
        }
    }

    // RIGHT: new slots at+1..=far, walking the original hops from `at` up, unflipped.
    // The first of them expands from the seed slot, which the left branch left at 0.
    for j in 0..(far - at) {
        let hop = &hops[at + j];
        out = Plan::Expand {
            input: Box::new(out),
            from: new_pos(at + j),
            dir: hop.dir,
            edge_label: hop.edge_label.clone(),
            bind_edge: false,
            double_loops: false,
        };
        if let Some(p) = placed[at + j + 1].take() {
            out = Plan::Filter {
                input: Box::new(out),
                pred: p,
            };
        }
    }

    Some((out, at))
}

/// The slots of a fixed-length pattern that carry a predicate of their own, paired with
/// it — the pivots [`split_chain`] could re-seed at, FAR END FIRST.
///
/// Far-first is not arbitrary. Re-seeding at the far end leaves the chain linear, which
/// is the shape every count/degree fast path recognizes; an interior split gives the seed
/// two branches and some of those paths decline it. So a pattern that can orient the
/// classic way should, and a split is what happens when it cannot.
///
/// Slot 0 is never a candidate: it is already the seed, and the ordinary seeding rule has
/// had it since before orientation existed.
fn split_candidates(plan: &Plan) -> Vec<(usize, Expr)> {
    let (top_pred, chain) = match plan {
        Plan::Filter { input, pred } => (Some(pred.clone()), input.as_ref()),
        other => (None, other),
    };
    let Some((_, hops)) = peel_hops(chain) else {
        return Vec::new();
    };
    let far = hops.len();
    let mut out: Vec<(usize, Expr)> = Vec::new();
    if let Some(p) = top_pred {
        if let Some(s) = (1..=far).find(|&s| reads_only_slot(&p, s)) {
            out.push((s, p));
        }
    }
    for (h, hop) in hops.iter().enumerate() {
        if let Some(p) = &hop.above {
            out.push((h + 1, p.clone()));
        }
    }
    // Far end first, then inward. A slot appearing twice cannot happen: the top predicate
    // reads one slot and `peel_hops` gives each hop at most one `above`, and if both land
    // on the same slot `split_chain` declines anyway.
    out.sort_by_key(|(slot, _)| std::cmp::Reverse(*slot));
    out
}

/// Rewrite every reference to slot `from` as slot `to`, leaving all others alone.
/// Only valid when the expression reads NOTHING but `from`, which every caller checks.
fn shift_slot(e: &Expr, from: usize, to: usize) -> Option<Expr> {
    if !reads_only_slot(e, from) {
        return None;
    }
    // With only `from` present, exchanging `from` and `to` renames it and can touch
    // nothing else.
    swap_slots(e, from, to)
}

/// Split a single-label `IsLabeled(slot 0, [L])` out of a conjunction, returning the
/// label and whatever predicate remains. A multi-label check (`:A|B`) stays in the
/// predicate — `Scan` carries one label, not a set — and so does anything that is not
/// a top-level conjunct.
fn lift_seed_label(pred: Expr) -> (Option<String>, Option<Expr>) {
    match pred {
        Expr::IsLabeled { slot: 0, labels } if labels.len() == 1 => {
            (labels.into_iter().next(), None)
        }
        Expr::And(a, b) => {
            let (label, rest) = lift_seed_label(*a);

            if label.is_some() {
                return (
                    label,
                    Some(match rest {
                        Some(rest) => Expr::And(Box::new(rest), b),
                        None => *b,
                    }),
                );
            }

            // The left side kept its predicate whole (nothing was lifted), so it is
            // always `Some` here; try the right.
            let left = rest.expect("nothing lifted from the left, so it survives");
            let (label, rest) = lift_seed_label(*b);

            (
                label,
                Some(match rest {
                    Some(rest) => Expr::And(Box::new(left), Box::new(rest)),
                    None => left,
                }),
            )
        }
        other => (None, Some(other)),
    }
}

/// The other end of a hop.
fn flip_dir(d: crate::ir::Dir) -> crate::ir::Dir {
    match d {
        crate::ir::Dir::Out => crate::ir::Dir::In,
        crate::ir::Dir::In => crate::ir::Dir::Out,
        crate::ir::Dir::Both => crate::ir::Dir::Both,
    }
}

/// Is this predicate one the seeding rewrites can turn into an index seek? Mirrors
/// what the existing seed rules accept: a property compared against a constant, on a
/// key the oracle actually has an index for.
fn seedable(pred: &Expr, idx: &dyn IndexOracle) -> bool {
    match pred {
        Expr::Compare { op, left, right } => {
            let key = match (left.as_ref(), right.as_ref()) {
                (Expr::Prop { key, .. }, Expr::Lit(_) | Expr::Param(_))
                | (Expr::Lit(_) | Expr::Param(_), Expr::Prop { key, .. }) => key,
                _ => return false,
            };

            match op {
                crate::ir::CompareOp::Eq => idx.has_hash_index(key),
                crate::ir::CompareOp::Lt
                | crate::ir::CompareOp::Le
                | crate::ir::CompareOp::Gt
                | crate::ir::CompareOp::Ge => idx.has_range_index(key),
                crate::ir::CompareOp::Ne => false,
            }
        }
        // A conjunction seeds if either side does; the rest stays as a residual.
        Expr::And(a, b) => seedable(a, idx) || seedable(b, idx),
        _ => false,
    }
}

/// The estimated share of the graph selected by whichever conjunct would seed, or
/// `None` when nothing can be estimated — no index, a bound that is a PARAMETER rather
/// than a literal, or a count the oracle gave up on because it was large.
fn seed_fraction_of(pred: &Expr, idx: &dyn IndexOracle) -> Option<f64> {
    match pred {
        Expr::Compare { op, left, right } => {
            // The mirrored spelling (`98 < b.age`) means the same thing with the
            // operator flipped — the equivalent-spellings rule applies to the COST
            // model too, not just to which plan is chosen.
            let (key, value, op) = match (left.as_ref(), right.as_ref()) {
                (Expr::Prop { key, .. }, Expr::Lit(v)) => (key, v, *op),
                (Expr::Lit(v), Expr::Prop { key, .. }) => (key, v, flip_cmp(*op)),
                _ => return None,
            };
            idx.seed_fraction(key, op, value)
        }
        // Whichever side seeds; a conjunction only ever seeds from one of them.
        Expr::And(a, b) => seed_fraction_of(a, idx).or_else(|| seed_fraction_of(b, idx)),
        _ => None,
    }
}

/// Would a seek on `key <op> value` beat scanning?
///
/// `seed_fraction` measures the share of the graph the predicate selects, capped at
/// [`SEEK_MAX_FRACTION`] — so `Some(_)` already means "within the threshold" and `None`
/// means the probe gave up because the count ran past it. Parameters do not complicate
/// this: `bind_params` runs BEFORE the optimizer, so a `$name` bound is an ordinary
/// literal by the time this rule sees it.
///
/// A TINY graph always seeds, and that is not a fudge to keep plan-shape tests green.
/// Below a few thousand nodes neither choice is measurable — a full scan of 1,000 nodes
/// is 1.9us and the worst possible seek over them is ~6us — so the rule would be
/// deciding nothing while changing plans, and churning plans that nobody can measure is
/// how a planner acquires behaviour no one can explain.
fn seek_beats_scan(idx: &dyn IndexOracle, key: &str, op: CompareOp, value: &Value) -> bool {
    if idx.live_nodes().is_some_and(|n| n < SEEK_FLOOR_NODES) {
        return true;
    }
    idx.seed_fraction(key, op, value)
        .is_some_and(|frac| frac <= SEEK_MAX_FRACTION)
}

/// Should `key = value` seed an `IndexSeek`, or is a scan cheaper?
///
/// The two halves are NOT the same question, and only one of them needs the oracle:
///
///   * No hash index. Seed anyway, and not merely as the old behaviour: the seek
///     degrades to a typed column scan inside `index_seek_ids`, which is the FASTEST
///     of the three shapes here — 194.7us on a 20%-selectivity key, against 291.7us
///     for the `Filter(Scan)` the planner would otherwise leave (E75). So there is
///     nothing to decide, and declining would only give two spellings of one
///     predicate different plans.
///   * A hash index exists, on a key with few distinct values. Now it matters, and it
///     is the same cliff the range seed had: the bucket is 20% of the graph, so the
///     seek materializes 40k scattered ids and binary-searches each against the label
///     bucket, where a scan streams the column. Measured 194.7us unindexed against
///     526.5us seeded — declaring the index made the query 2.7x SLOWER, 2.9x under
///     GROUP BY (E75).
///
/// Declining leaves `Filter(Scan)` at 291.7us, so the seeded regression is gone but a
/// declared index still costs this query 1.5x. That residual is NOT an index problem:
/// `Filter(Scan)` materializes the whole 200k-row batch and then compacts a keep list,
/// where the seek's fallback filters as it walks the label bucket — about 0.5ns/row of
/// batch overhead. Closing it wants a scan that takes a pushed-down predicate (which
/// the scan-fallback seek effectively IS), not a different index decision; see E75.
fn eq_seek_worth_it(idx: &dyn IndexOracle, key: &str, value: &Value) -> bool {
    !idx.has_hash_index(key) || seek_beats_scan(idx, key, CompareOp::Eq, value)
}

/// Below this many live nodes the seek-vs-scan choice is unmeasurable, so the planner
/// keeps its existing behaviour rather than churning the plan.
const SEEK_FLOOR_NODES: usize = 4_096;

/// Is reversing this pattern worth it — does the far-side predicate actually shrink
/// the pool?
///
/// When the pool can be measured, [`SEEK_MAX_FRACTION`] decides, and that is the
/// whole answer. When it CANNOT — a parameterized bound, or an oracle that declined —
/// fall back to the older, blunter rule: reverse only if the far node carries a label
/// that lifts onto the seed. That rule was never really about selectivity, but it
/// correlates well enough, and keeping it means a parameterized query behaves exactly
/// as it did before rather than silently losing orientation altogether.
fn orient_is_worth_it(pred: &Expr, far: usize, idx: &dyn IndexOracle) -> bool {
    match seed_fraction_of(pred, idx) {
        Some(frac) => frac <= SEEK_MAX_FRACTION,
        None => reverse_slots(pred, far).is_some_and(|p| lift_seed_label(p).0.is_some()),
    }
}

/// Can this plan be oriented — pattern eligible AND every expression that reads the
/// pattern's slots renameable? Checked BEFORE anything is rewritten, because a
/// half-applied reversal leaves slot references pointing at the wrong node, and that
/// is a silently wrong answer rather than a failure.
///
/// The subtlety that matters: SLOT INDICES ARE NOT GLOBAL. They name the columns of
/// whatever operator produced them, so a `Project` or an `Aggregate` starts a fresh
/// namespace — `Slot(0)` above an `Aggregate` is its first OUTPUT column, nothing to
/// do with the pattern underneath. Only the operators between the pattern and the
/// nearest enclosing projection see the pattern's slots, and only their expressions
/// may be renamed. (Renaming past that boundary is how the first version of this
/// rewrite turned `count(*)` into a read of a column that does not exist.)
/// Returns the FAR SLOT to orient on, which is also the swap consumers are renamed
/// with, or `None` if the plan must be left alone.
fn orient_eligible(plan: &Plan, idx: &dyn IndexOracle) -> Option<usize> {
    // The namespace must be CLOSED by a projection before the root. If the pattern's
    // slots are still exposed at the top, they ARE the query's output columns —
    // reversing would hand the caller `(b, a)` where it asked for `(a, b)`. That
    // returns wrong rows rather than failing, which is the one outcome this rewrite
    // must never risk.
    match orient_scan(plan, idx)? {
        (false, far) => Some(far),
        (true, _) => None,
    }
}

/// Walk to the pattern, verifying as we go. The `bool` is whether the subtree still
/// exposes the pattern's slot namespace to its parent (`false` = already closed by a
/// projection); the `usize` is the pattern's far slot, which fixes the rename.
fn orient_scan(plan: &Plan, idx: &dyn IndexOracle) -> Option<(bool, usize)> {
    match plan {
        // A projection CLOSES the namespace: its own expressions read the pattern's
        // slots (so they must be renameable), but everything above reads its outputs.
        Plan::Project { input, items } => {
            let (open, far) = orient_scan(input, idx)?;

            if !open {
                return Some((false, far));
            }

            items
                .iter()
                .all(|(_, e)| reverse_slots(e, far).is_some())
                .then_some((false, far))
        }
        Plan::Aggregate { input, keys, aggs } => {
            let (open, far) = orient_scan(input, idx)?;

            if !open {
                return Some((false, far));
            }

            (keys.iter().all(|(_, e)| reverse_slots(e, far).is_some())
                && aggs.iter().all(|a| {
                    a.arg
                        .as_ref()
                        .is_none_or(|e| reverse_slots(e, far).is_some())
                }))
            .then_some((false, far))
        }
        // Pass-through operators keep the namespace open.
        Plan::Distinct { input } => orient_scan(input, idx),
        // A page keeps the namespace open (its slots are its input's) but its SORT KEYS
        // read them, so they have to be renameable like any other consumer. Without
        // this arm the whole plan declined, and a pattern under an `ORDER BY` never
        // oriented at all.
        //
        // Reversing changes the order rows reach the sort, which with TIED keys and a
        // stable sort changes their order out of it. That is already true of every
        // seeding rewrite on this page — a `RangeSeek` yields index order where a
        // `Scan` yields id order — so a tie's position was never a property of the
        // query, only of the chosen plan. What must not change is the row SET.
        Plan::OrderPage { input, keys, .. } => {
            let (open, far) = orient_scan(input, idx)?;

            if !open {
                return Some((false, far));
            }

            keys.iter()
                .all(|k| reverse_slots(&k.expr, far).is_some())
                .then_some((true, far))
        }
        // A page keeps the namespace open (its slots are its input's) but its SORT KEYS
        // read them, so they have to be renameable like any other consumer. Without
        // this arm the whole plan declined, and a pattern under an `ORDER BY` never
        // oriented at all.
        //
        // Reversing changes the order rows reach the sort, which with TIED keys and a
        // stable sort changes their order out of it. That is already true of every
        // seeding rewrite on this page — a `RangeSeek` yields index order where a
        // `Scan` yields id order — so a tie's position was never a property of the
        // plan, only of the chosen plan. What must not change is the row SET, and that
        // is what the fuzzer checks here.
        // The pattern itself, or a residual filter over it.
        Plan::Filter { input, pred } => {
            if let Some((open, far)) = orient_scan(input, idx) {
                // A filter ABOVE the pattern: renameable and keeps the namespace.
                return if open {
                    reverse_slots(pred, far).is_some().then_some((true, far))
                } else {
                    Some((false, far))
                };
            }

            // Otherwise this may BE the pattern — and the decision is a TRIAL REWRITE,
            // not a re-derivation of the rewrite's conditions. Those two drifted apart
            // once already (the decision said yes, the rewrite declined, and consumers
            // were renamed around a pattern that never reversed — a half-applied
            // rename, which is a silently wrong answer). Asking `reverse_chain` itself
            // cannot drift, at the cost of one clone per candidate at plan time.
            let pattern = Plan::Filter {
                input: input.clone(),
                pred: pred.clone(),
            };
            best_pivot(&pattern, idx).map(|slot| (true, slot))
        }
        // A pattern with NOTHING above its last hop is rooted here rather than at a
        // `Filter`. `MATCH (a:L)-[:T]->(b:M)-[:T]->(c) WHERE b.k > v` — far node written
        // without a label — is exactly that shape, and until this arm existed it was never
        // considered: 648.8us against the 203.0us the same query gets when `c` carries a
        // label (E81).
        Plan::Expand { .. } => best_pivot(plan, idx).map(|slot| (true, slot)),
        _ => None,
    }
}

/// The slot to re-seed this pattern at, or `None` to leave it as written.
///
/// Candidates come from [`split_candidates`], FAR END FIRST, and each is a TRIAL REWRITE
/// through [`split_chain`] rather than a re-derivation of its conditions. Those two were
/// once derived independently and drifted: the decision said yes, the rewrite declined,
/// and the consumers above were renamed around a pattern that never moved — a half-applied
/// rename, which is a silently wrong answer rather than a failure.
fn best_pivot(pattern: &Plan, idx: &dyn IndexOracle) -> Option<usize> {
    for (slot, p) in split_candidates(pattern) {
        if !seedable(&p, idx) || !orient_is_worth_it(&p, slot, idx) {
            continue;
        }
        if split_chain(pattern.clone(), slot).is_some() {
            return Some(slot);
        }
    }
    None
}

/// Apply the reversal, renaming only the expressions that read the pattern's slots.
/// Mirrors [`orient_scan`] exactly; `far` is the swap [`orient_eligible`] settled on,
/// and the returned bool is whether the rebuilt subtree still exposes the pattern's
/// namespace.
fn orient_apply(plan: Plan, far: usize) -> (Plan, bool) {
    match plan {
        Plan::Project { input, items } => {
            let (inner, open) = orient_apply(*input, far);
            let items = if open {
                items
                    .into_iter()
                    .map(|(n, e)| {
                        let e = reverse_slots(&e, far).expect("eligibility checked");
                        (n, e)
                    })
                    .collect()
            } else {
                items
            };

            (
                Plan::Project {
                    input: Box::new(inner),
                    items,
                },
                false,
            )
        }
        Plan::Aggregate { input, keys, aggs } => {
            let (inner, open) = orient_apply(*input, far);
            let (keys, aggs) = if open {
                (
                    keys.into_iter()
                        .map(|(n, e)| {
                            let e = reverse_slots(&e, far).expect("eligibility checked");
                            (n, e)
                        })
                        .collect(),
                    aggs.into_iter()
                        .map(|mut a| {
                            a.arg = a
                                .arg
                                .map(|e| reverse_slots(&e, far).expect("eligibility checked"));
                            a
                        })
                        .collect(),
                )
            } else {
                (keys, aggs)
            };

            (
                Plan::Aggregate {
                    input: Box::new(inner),
                    keys,
                    aggs,
                },
                false,
            )
        }
        Plan::Distinct { input } => {
            let (inner, open) = orient_apply(*input, far);

            (
                Plan::Distinct {
                    input: Box::new(inner),
                },
                open,
            )
        }
        Plan::OrderPage {
            input,
            keys,
            skip,
            limit,
            fault_on_element,
        } => {
            let (inner, open) = orient_apply(*input, far);
            let keys = if open {
                keys.into_iter()
                    .map(|mut k| {
                        k.expr = reverse_slots(&k.expr, far).expect("eligibility checked");
                        k
                    })
                    .collect()
            } else {
                keys
            };

            (
                Plan::OrderPage {
                    input: Box::new(inner),
                    keys,
                    skip,
                    limit,
                    fault_on_element,
                },
                open,
            )
        }
        Plan::Filter { input, pred } => {
            // The pattern is a Filter over the hop chain; anything else is a residual
            // filter sitting above it.
            // Re-seed at the pivot `orient_scan` settled on, rather than re-deriving one.
            // The two used to be derived independently and drifted apart once, which
            // renamed consumers around a pattern that never reversed.
            if let Some((reseeded, _)) = split_chain(
                Plan::Filter {
                    input: input.clone(),
                    pred: pred.clone(),
                },
                far,
            ) {
                return (reseeded, true);
            }

            let (inner, open) = orient_apply(*input, far);
            let pred = if open {
                reverse_slots(&pred, far).expect("eligibility checked")
            } else {
                pred
            };

            (
                Plan::Filter {
                    input: Box::new(inner),
                    pred,
                },
                open,
            )
        }
        // The `Expand`-rooted pattern, mirroring `orient_scan`'s arm for it.
        //
        // The boundary between "the pattern" and "a residual filter above it" is now
        // decided in opposite orders by the two functions — `orient_scan`'s `Filter` arm
        // recurses first and treats itself as the pattern only if that fails, while this
        // one tries the rewrite on itself first. That looked like a drift hazard worth
        // refusing the arm over, and it is not one: whichever side absorbs the filter, the
        // subtree comes back rebuilt with `open = true` and the parent renames only its OWN
        // expressions, so the two decompositions differ in where the residual predicate
        // sits and not in the rows or the rename. The fuzzer is the evidence, not this
        // paragraph — `optimizing_preserves_rows_with_indexes` is what would show a
        // mismatch, and a poisoned branch confirms it reaches here.
        plan @ Plan::Expand { .. } => match split_chain(plan.clone(), far) {
            Some((reseeded, _)) => (reseeded, true),
            None => (plan, false),
        },
        other => (other, false),
    }
}
