//! Bind query parameters into a PREPARED plan: replace every unbound
//! [`Expr::Param`] with the supplied [`Expr::Lit`] value, in place, before the
//! plan is optimized and executed.
//!
//! A prepared statement is parsed ONCE ([`crate::gql::parse_prepared`], which
//! leaves `$name` as `Expr::Param`) and then, per run, its plan is cloned and
//! bound here with fresh values — so the parse cost is paid once across a loop of
//! executions. Binding before `opt` keeps the value typed (never spliced into
//! query text) and lets the planner seed indexes on the now-literal predicate,
//! exactly as a direct parameterized query does.
//!
//! Both walks are EXHAUSTIVE (no `_` arm), so a new `Plan`/`Expr` variant fails to
//! compile until it is handled here. A `Param` that still slips through to
//! evaluation is a loud unbound-parameter error (the `eval` safety net), never a
//! wrong result.

use crate::ir::{Expr, Plan};
use crate::value::Value;

/// Replace every `Expr::Param($name)` in `plan` with its bound value. Errors on
/// the first parameter with no supplied value.
pub fn bind_params(plan: &mut Plan, params: &[(String, Value)]) -> Result<(), String> {
    // THE SLICE IS THE LOOKUP TABLE. This used to `collect` a `HashMap<&str, &Value>` first,
    // which is a heap allocation plus a SipHash-1-3 insert per parameter and a SipHash per
    // `$name` occurrence — for what a serving query typically has ONE of. There is exactly one
    // lookup site (`bind_expr`'s `Expr::Param` arm), so the table bought nothing but its own
    // construction.
    //
    // MEASURED ACROSS THE WHOLE RANGE, because a scan is O(P) per lookup against the map's O(1)
    // and the interesting question is where it stops winning. It does not, up to 32 parameters
    // with 16 occurrences (`examples/bind_probe.rs`): the map's BUILD cost dominates throughout.
    //
    //   params x lookups    hashmap     scan
    //   1 x 1                 32.9       2.0 ns
    //   4 x 4                 94.1      18.8
    //   8 x 16               238.9     137.5
    //   32 x 1               386.7       2.0
    //   32 x 16              526.8     153.1
    //
    // HONEST SIZE: ~30ns on the one-param serving call, which is ~1.5% of it and BELOW
    // `bench:usage`'s ~±6% floor (item 597 priced that floor). Taken for the isolated measurement
    // and the removed allocation, not on the strength of a bench row — no bench row moved.
    bind_plan(plan, params)
}

fn bind_plan(plan: &mut Plan, params: &[(String, Value)]) -> Result<(), String> {
    match plan {
        // Leaves — no child plan, no bindable expression. (Insert / AddEdge /
        // CallProcedure carry only literal values; a prepared statement cannot put a
        // parameter in a literal-only position, so none hold an `Expr::Param`.)
        Plan::Scan { .. }
        | Plan::NodeSeed { .. }
        | Plan::EdgeScan
        | Plan::EdgeSeed { .. }
        | Plan::Row
        | Plan::IndexSeek { .. }
        | Plan::RangeSeek { .. }
        | Plan::Insert { .. }
        | Plan::AddEdge { .. }
        | Plan::AddEdgeStep { .. }
        | Plan::AddVertexStep { .. }
        | Plan::CallProcedure { .. }
        | Plan::TxControl { .. } => {}

        // Single-input wrappers with no expression of their own.
        Plan::Sample { input, .. }
        | Plan::Enumerate { input, .. }
        | Plan::EdgeVertex { input, .. }
        | Plan::GroupToMap { input }
        | Plan::Subgraph { input, .. }
        | Plan::Tree { input, .. }
        | Plan::AlgoAnnotate { input, .. }
        | Plan::Tail { input, .. }
        | Plan::Distinct { input }
        | Plan::Fail { input, .. }
        | Plan::DistinctBy { input, .. }
        | Plan::NullPadIfEmpty { input, .. }
        | Plan::ShortestPathEnum { input, .. }
        | Plan::Expand { input, .. }
        | Plan::SortLocal { input, .. } => bind_plan(input, params)?,

        // A left-outer hop with an optional landing predicate (`OPTIONAL MATCH (a)-[:R]->(b
        // WHERE b.k = $x)`): bind the input and any `$param` in the landing predicate.
        Plan::OptionalExpand {
            input,
            landing_pred,
            ..
        } => {
            bind_plan(input, params)?;
            if let Some(p) = landing_pred {
                bind_expr(p, params)?;
            }
        }

        // Single-input + one or more expressions.
        Plan::Unwind { input, list, .. } => {
            bind_plan(input, params)?;
            bind_expr(list, params)?;
        }
        Plan::ShortestPath {
            input, edge_pred, ..
        } => {
            bind_plan(input, params)?;
            if let Some(p) = edge_pred {
                bind_expr(p, params)?;
            }
        }
        Plan::IntervalExpand {
            input, qlo, qhi, ..
        } => {
            bind_plan(input, params)?;
            bind_expr(qlo, params)?;
            bind_expr(qhi, params)?;
        }
        Plan::VarLength {
            input,
            until,
            body_filter,
            ..
        } => {
            bind_plan(input, params)?;
            if let Some(p) = until {
                bind_expr(p, params)?;
            }
            if let Some(p) = body_filter {
                bind_expr(p, params)?;
            }
        }
        Plan::RepeatGroup {
            input,
            per_rep_pred,
            ..
        }
        | Plan::NestedGroup {
            input,
            per_rep_pred,
            ..
        } => {
            bind_plan(input, params)?;
            if let Some(p) = per_rep_pred {
                bind_expr(p, params)?;
            }
        }
        Plan::Filter { input, pred } => {
            bind_plan(input, params)?;
            bind_expr(pred, params)?;
        }
        Plan::PathRecord { input, value, .. } => {
            bind_plan(input, params)?;
            bind_expr(value, params)?;
        }
        Plan::Aggregate { input, keys, aggs } => {
            bind_plan(input, params)?;
            for (_, e) in keys {
                bind_expr(e, params)?;
            }
            for agg in aggs {
                if let Some(arg) = &mut agg.arg {
                    bind_expr(arg, params)?;
                }
            }
        }
        Plan::MapSlot { input, value, .. } => {
            bind_plan(input, params)?;
            bind_expr(value, params)?;
        }
        Plan::OrderPage { input, keys, .. } => {
            bind_plan(input, params)?;
            for k in keys {
                bind_expr(&mut k.expr, params)?;
            }
        }
        Plan::Project { input, items } => {
            bind_plan(input, params)?;
            for (_, e) in items {
                bind_expr(e, params)?;
            }
        }
        Plan::OptionalScan { input, filters, .. } => {
            bind_plan(input, params)?;
            for (_, e) in filters {
                bind_expr(e, params)?;
            }
        }
        Plan::CallInline {
            input,
            body,
            yields,
            ..
        } => {
            bind_plan(input, params)?;
            bind_plan(body, params)?;
            for (_, e) in yields {
                bind_expr(e, params)?;
            }
        }
        Plan::InsertReturn { tail, .. } => bind_plan(tail, params)?,
        // Write ops: SET `value` expressions and the _MERGE on-create/on-update
        // assignments can carry a parameter (an upsert loop with $-values).
        Plan::Update { input, ops } => {
            bind_plan(input, params)?;
            for op in ops {
                if let crate::ir::SetOp::Set { value, .. } = op {
                    bind_expr(value, params)?;
                }
            }
        }
        Plan::UpdateReturn { input, ops, tail } => {
            bind_plan(input, params)?;
            for op in ops {
                if let crate::ir::SetOp::Set { value, .. } = op {
                    bind_expr(value, params)?;
                }
            }
            bind_plan(tail, params)?;
        }
        Plan::InsertFrom {
            input,
            nodes,
            edges,
        } => {
            bind_plan(input, params)?;
            for n in nodes {
                for (_, e) in &mut n.props {
                    bind_expr(e, params)?;
                }
            }
            for ed in edges {
                for (_, e) in &mut ed.props {
                    bind_expr(e, params)?;
                }
            }
        }
        Plan::Merge {
            on_create,
            on_update,
            tail,
            ..
        } => {
            for (_, e) in on_create {
                bind_expr(e, params)?;
            }
            if let crate::ir::MergeUpdate::Set { assigns, filter } = on_update {
                for (_, e) in assigns {
                    bind_expr(e, params)?;
                }
                if let Some(f) = filter {
                    bind_expr(f, params)?;
                }
            }
            if let Some(tail) = tail {
                bind_plan(tail, params)?;
            }
        }
        Plan::MergeEdge {
            on_create,
            on_update,
            ..
        } => {
            for (_, _, e) in on_create {
                bind_expr(e, params)?;
            }
            if let crate::ir::MergeEdgeUpdate::Set { assigns, filter } = on_update {
                for (_, _, e) in assigns {
                    bind_expr(e, params)?;
                }
                if let Some(f) = filter {
                    bind_expr(f, params)?;
                }
            }
        }

        // Multi-input.
        Plan::Union { left, right, .. } | Plan::Join { left, right, .. } => {
            bind_plan(left, params)?;
            bind_plan(right, params)?;
        }
        Plan::Branch { input, bodies } => {
            bind_plan(input, params)?;
            for b in bodies {
                bind_plan(b, params)?;
            }
        }
        Plan::PerElementBranch {
            input, cond, arms, ..
        } => {
            bind_plan(input, params)?;
            if let Some(c) = cond {
                bind_plan(c, params)?;
            }
            for a in arms {
                bind_plan(a, params)?;
            }
        }
        Plan::Reconverge { input, .. } => bind_plan(input, params)?,
    }

    // RE-LOWER A BOUND PARAMETERIZED INSERT TO THE CONSTANT PATH (item 596).
    //
    // The parser already lowers `InsertFrom { input: Row }` to `Plan::Insert` when every property
    // is a literal, but it runs while `$n` is still an `Expr::Param`, so a parameterized INSERT
    // fails that test. The `InsertFrom` arm above has just made those same templates literal, so
    // the lowering applies now.
    //
    // IT HAS TO BE IN BIND, which cost a wrong placement to learn. `parse_cache`'s
    // `prepared_equivalent` admits a text only if the bound PREPARED plan renders identically to
    // what the DIRECT path produces — and it compares them UNOPTIMIZED, so an equivalent rewrite
    // in `opt.rs` runs too late to be seen. Placed there first, it made `prepared_parity_probe`
    // (which compares OPTIMIZED plans) report "SAME plan" while the cache went on refusing the
    // text. The cache's own `stats().refused` is what showed it; the probe could not.
    //
    // WHAT IT IS WORTH: the direct path substitutes params during the parse and so gets
    // `Plan::Insert`, while prepared mode got `InsertFrom`. Item 319 recorded that divergence as
    // benign — "the INSERT case excludes itself" — and for correctness it is. But self-exclusion
    // means every parameterized INSERT is REFUSED by the cache and re-parses on every call, then
    // pays parameter marshalling on top, which is why `bench:usage` shows params SLOWER than
    // interpolation on the same write.
    //
    // AFTER the match rather than inside the arm, because the arm holds `&mut` borrows of the
    // plan's own fields and cannot assign through `plan` while they live. The replacement is
    // computed first so the immutable borrow ends before the assignment.
    //
    // `Plan::Row` ONLY. A `FOR … INSERT` or `MATCH … INSERT` has real input rows and must evaluate
    // per row; collapsing one to `Plan::Insert` would insert ONCE instead of once per row.
    //
    // Mutation testing made that guard's status precise, and it is not what it looks like. A
    // mutant deleting it SURVIVED twice, including against `MATCH (u:User) INSERT (:Audit {kind:
    // 'seen'})` — input rows and every property a literal, so nothing else refuses it. The reason
    // is that `parse_cache::prepared_equivalent` compares the bound prepared plan against the
    // UNBOUND direct parse, which no re-lowering touches: without the guard the two disagree, the
    // text is REFUSED, and every call falls through to the direct path. The answer is identical
    // and what is lost is the caching. So this is a PERF guard whose correctness backstop is the
    // admission check, and the test that catches its removal has to assert on `stats()`, not on
    // the returned plan (`a_row_driven_insert_keeps_the_per_row_operator`).
    let relowered = match &*plan {
        Plan::InsertFrom {
            input,
            nodes,
            edges,
        } if matches!(**input, Plan::Row) => crate::ir::lower_insert_literal(nodes, edges),
        _ => None,
    };

    if let Some((nodes, edges)) = relowered {
        *plan = Plan::Insert { nodes, edges };
    }

    Ok(())
}

fn bind_expr(e: &mut Expr, params: &[(String, Value)]) -> Result<(), String> {
    match e {
        Expr::Param(name) => {
            // `.rev()` is NOT a style choice. A repeated parameter name is LAST-WINS — the
            // convention `ndjson` uses for any repeated JSON key (item 333) and what both engines
            // must agree on, since a JS object literal and `JSON.parse` both keep the last
            // spelling. `HashMap::collect` gave that for free; a FORWARD scan would silently make
            // it first-wins, which is the same rows by a different value.
            //
            // Reachable: `Json::Obj` is a `Vec<(String, Json)>` whose parser pushes, so
            // `params_from_obj` can hand two entries under one name. `g.query(text, obj)` cannot
            // produce one, but `lnk_query` takes the params as a raw JSON string, so an ABI caller
            // can. Pinned by `a_repeated_parameter_name_is_last_wins`.
            let v = params
                .iter()
                .rev()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v)
                .ok_or_else(|| format!("unbound parameter `${name}`"))?;
            *e = Expr::Lit(v.clone());
        }
        // Leaves — nothing to bind. `GremlinPath` is Gremlin-only and its `bys` are
        // render modulators, not expressions, so no GQL `$param` can appear there.
        Expr::Slot(_)
        | Expr::IsLabeled { .. }
        | Expr::Prop { .. }
        | Expr::Lit(_)
        | Expr::Path
        | Expr::PropertyExists { .. }
        | Expr::PathAccess { .. }
        | Expr::GremlinPath { .. }
        | Expr::GremlinFullPath { .. } => {}

        Expr::Not(a) => bind_expr(a, params)?,
        Expr::And(a, b) | Expr::Or(a, b) | Expr::Xor(a, b) => {
            bind_expr(a, params)?;
            bind_expr(b, params)?;
        }
        Expr::Compare { left, right, .. } | Expr::Arith { left, right, .. } => {
            bind_expr(left, params)?;
            bind_expr(right, params)?;
        }
        Expr::In { needle, haystack } => {
            bind_expr(needle, params)?;
            bind_expr(haystack, params)?;
        }
        Expr::Call { args, .. } | Expr::GraphPred { args, .. } | Expr::List { items: args } => {
            for a in args {
                bind_expr(a, params)?;
            }
        }
        Expr::Record { fields }
        | Expr::MapLit {
            entries: fields, ..
        } => {
            for (_, v) in fields {
                bind_expr(v, params)?;
            }
        }
        Expr::Case {
            branches,
            otherwise,
        } => {
            for (c, v) in branches {
                bind_expr(c, params)?;
                bind_expr(v, params)?;
            }
            if let Some(o) = otherwise {
                bind_expr(o, params)?;
            }
        }
        Expr::Field { base, .. } => bind_expr(base, params)?,
        Expr::Index { base, index, .. } => {
            bind_expr(base, params)?;
            bind_expr(index, params)?;
        }
        Expr::Cast { expr, .. } | Expr::IsNull { expr, .. } => bind_expr(expr, params)?,

        // Subqueries — recurse the nested plan (and any scalar it yields).
        Expr::Exists { body, .. }
        | Expr::CountSubquery { body, .. }
        | Expr::UncorrelatedExists { body, .. }
        | Expr::UncorrelatedCount { body, .. } => bind_plan(body, params)?,
        Expr::ScalarSubquery { body, scalar, .. }
        | Expr::CollectSubquery { body, scalar, .. }
        | Expr::AggSubquery { body, scalar, .. } => {
            bind_plan(body, params)?;
            bind_expr(scalar, params)?;
        }
        Expr::UncorrelatedScalar { body, .. } => bind_plan(body, params)?,
    }
    Ok(())
}

#[cfg(test)]
mod tests;
