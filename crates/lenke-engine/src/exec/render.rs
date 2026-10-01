use super::*;
use crate::batch::Col;
use crate::gstr::GStr;
use crate::ir::Plan;
use crate::store::Store;
use crate::value::Value;

/// Whether any cell in a result is boolean `false` — the invariant-violation test.
pub(super) fn rows_have_false(rows: &Rows) -> bool {
    rows.rows
        .iter()
        .any(|r| r.iter().any(|c| matches!(c, Value::Bool(false))))
}

/// The grouping-key bytes of `keys`, reading each key's value via `get`.
pub(super) fn key_bytes(keys: &[String], mut get: impl FnMut(&str) -> Value) -> Vec<u8> {
    let mut buf = Vec::new();
    for k in keys {
        value::group_key_into(&get(k), &mut buf);
    }
    buf
}

/// A pattern property's value by key (NULL if the pattern does not name it).
pub(super) fn pattern_value(props: &[(String, Value)], key: &str) -> Value {
    props
        .iter()
        .find(|(k, _)| k == key)
        .map_or(Value::Null, |(_, v)| v.clone())
}

/// Render a batch cell (slot `col`, row `i`) to a result `Value`. A NODE frontier
/// slot renders as the TS engine's element MAP `{id, labels, properties}` (not its bare id),
/// so `RETURN n` / `RETURN *` match the TS engine byte-for-byte. Everything else materializes
/// as its plain value. (Edge frontier rendering — `{id, from, to, labels,
/// properties}` — needs an eid→endpoints accessor and is a separate step.)
/// Like [`render_cell`] but keeps a graph element UNBOXED — `Value::Node`/`Value::Edge`
/// carrying the dense id, NOT the rendered element map. Used when a node/edge flows into a
/// heterogeneous `Col::Gen` (a mixed branch or `inject`) that a downstream step still has to
/// traverse; egress resolves the ref to its map via [`render_cell`]. This is the un-boxed
/// alternative to eagerly rendering the map (which lost node identity, so `out()`/`hasLabel()`
/// on the result yielded nothing).
pub(super) fn cell_value(col: &Col, i: usize, _store: &Store) -> Value {
    match col {
        Col::Nodes(ids) if ids[i] == u32::MAX => Value::Null,
        Col::Edges(eids) if eids[i] == u32::MAX => Value::Null,
        Col::Nodes(ids) => Value::Node(ids[i]),
        Col::Edges(eids) => Value::Edge(eids[i]),
        _ => col.value_at(i),
    }
}

pub(super) fn render_cell(col: &Col, i: usize, store: &Store) -> Value {
    match col {
        // `u32::MAX` is the OPTIONAL-MATCH null sentinel → NULL, not an element map.
        Col::Nodes(ids) if ids[i] == u32::MAX => Value::Null,
        Col::Edges(eids) if eids[i] == u32::MAX => Value::Null,
        Col::Nodes(ids) => node_result_value(store, ids[i]),
        Col::Edges(eids) => edge_result_value(store, eids[i]),
        // A Gen cell may carry an UNBOXED element ref (Value::Node/Edge from a heterogeneous
        // branch/inject) — resolve it to its element map at egress, the same map a Nodes/Edges
        // cell renders. (SPIKE: top-level only; a ref nested in a list/map is not yet resolved.)
        _ => match col.value_at(i) {
            Value::Node(id) => node_result_value(store, id),
            Value::Edge(id) => edge_result_value(store, id),
            v => v,
        },
    }
}

/// The `id` field of a bare-VERTEX element map (`{id, labels, properties}`), or `None`.
pub(super) fn vertex_map_ext_id(v: &Value) -> Option<&str> {
    let Value::Map(pairs) = v else { return None };
    let keys: std::collections::BTreeSet<&str> = pairs
        .iter()
        .filter_map(|(k, _)| match k {
            Value::Str(s) => Some(s.as_ref()),
            _ => None,
        })
        .collect();
    if keys.len() != pairs.len() || keys != ["id", "labels", "properties"].into_iter().collect() {
        return None;
    }
    pairs.iter().find_map(|(k, val)| match (k, val) {
        (Value::Str(k), Value::Str(id)) if k.as_ref() == "id" => Some(id.as_ref()),
        _ => None,
    })
}

/// The `id` field of a bare-EDGE element map (`{id, from, to, labels, properties}`).
pub(super) fn edge_map_ext_id(v: &Value) -> Option<&str> {
    let Value::Map(pairs) = v else { return None };
    let keys: std::collections::BTreeSet<&str> = pairs
        .iter()
        .filter_map(|(k, _)| match k {
            Value::Str(s) => Some(s.as_ref()),
            _ => None,
        })
        .collect();
    if keys.len() != pairs.len()
        || keys
            != ["from", "id", "labels", "properties", "to"]
                .into_iter()
                .collect()
    {
        return None;
    }
    pairs.iter().find_map(|(k, val)| match (k, val) {
        (Value::Str(k), Value::Str(id)) if k.as_ref() == "id" => Some(id.as_ref()),
        _ => None,
    })
}

/// Reconstitute an `unfold`ed element column: when every element is a resolvable
/// bare VERTEX (or EDGE) element map (the fold().unfold() round-trip), resolve each
/// `id` back to a live dense id and return a `Col::Nodes` (or `Col::Edges`) so
/// downstream steps operate on the elements again. Otherwise keep the raw `Col::Gen`.
pub(super) fn reunfold_elements(elems: &[Value], store: &Store) -> Col {
    if elems.is_empty() {
        return Col::Gen(Vec::new());
    }
    let nodes: Option<Vec<u32>> = elems
        .iter()
        .map(|v| vertex_map_ext_id(v).and_then(|ext| store.node_by_ext(ext)))
        .collect();
    if let Some(ids) = nodes {
        return Col::Nodes(ids);
    }
    // Try edges — build a lazy ext→edge map (no reverse map is stored).
    if elems.iter().all(|v| edge_map_ext_id(v).is_some()) {
        let mut by_ext: std::collections::HashMap<GStr, u32> = std::collections::HashMap::new();
        for e in store.all_edges() {
            if let Some(x) = store.edge_ext_id(e) {
                by_ext.entry(x).or_insert(e);
            }
        }
        let eids: Option<Vec<u32>> = elems
            .iter()
            .map(|v| edge_map_ext_id(v).and_then(|ext| by_ext.get(ext).copied()))
            .collect();
        if let Some(eids) = eids {
            return Col::Edges(eids);
        }
    }
    Col::Gen(elems.to_vec())
}

/// The canonical result map for an edge — `{id, from, to, labels(sorted),
/// properties(sorted by key)}`, byte-identical to the TS engine's `val_to_value(Edge)`.
/// `from`/`to` are the endpoint EXTERNAL ids.
pub(super) fn edge_result_value(store: &Store, eid: u32) -> Value {
    use std::sync::Arc;
    let id = store
        .edge_ext_id(eid)
        .unwrap_or_else(|| GStr::from(format!("e{eid}")));
    let (src, dst) = store.edge_endpoints(eid).unwrap_or((0, 0));
    let ext = |n: u32| {
        store
            .node_ext_id(n)
            .unwrap_or_else(|| GStr::from(n.to_string()))
    };
    // ALL of the edge's labels, sorted — mirroring `node_result_value`. A
    // multi-label edge (`[KNOWS, CREATED]`) must render its whole label set
    // regardless of which type it was reached through; `edge_type_name` returns
    // only the primary type, which silently dropped the rest.
    let mut labels = store.edge_labels_of(eid);
    labels.sort_unstable();
    let labels = Value::List(labels.into_iter().map(|t| Value::Str(t.into())).collect());
    // The node renderer's three savings, applied here: the key list comes from the cached
    // `Arc<str>` slice (ALREADY sorted, so the filtered subset stays sorted and the per-row
    // `Vec<String>` + sort go away), each key resolves to its per-eid map ONCE instead of being
    // hashed by `has_edge_prop` and again by `edge_prop`, and the field names are not rebuilt.
    let props_map = Value::Map(Arc::new(
        store
            .edge_prop_keys_arc()
            .iter()
            .filter_map(|k| {
                let m = store.edge_prop_map(k)?;
                m.get(&eid)
                    .map(|v| (Value::Str(Arc::clone(k).into()), v.clone()))
            })
            .collect(),
    ));
    Value::Map(Arc::new(vec![
        (field_key(Field::Id), Value::Str(id)),
        (field_key(Field::From), Value::Str(ext(src))),
        (field_key(Field::To), Value::Str(ext(dst))),
        (field_key(Field::Labels), labels),
        (field_key(Field::Properties), props_map),
    ]))
}

/// Render one element of an interleaved Gremlin `path()` per its (cycled) `by`
/// modulator. A vertex or an edge (`is_edge`); `Element` → the element map,
/// `Prop` → a property value, `Id`/`Label` → the ext-id / label string.
// Extract a dense id (`Value::Num`) as `u32` for path element rendering.
pub(super) fn num_as_u32(v: &Value) -> u32 {
    match v {
        Value::Num(n) => *n as u32,
        _ => 0,
    }
}

pub(super) fn render_gpath_elem(
    store: &Store,
    id: u32,
    is_edge: bool,
    by: &crate::ir::GPathBy,
) -> Value {
    use crate::ir::GPathBy;
    match by {
        GPathBy::Element => {
            if is_edge {
                edge_result_value(store, id)
            } else {
                node_result_value(store, id)
            }
        }
        GPathBy::Prop(k) => {
            if is_edge {
                store.edge_prop(id, k)
            } else {
                store.prop(id, k)
            }
        }
        GPathBy::Id => {
            let ext = if is_edge {
                store.edge_ext_id(id)
            } else {
                store.node_ext_id(id)
            };
            ext.map_or(Value::Null, Value::Str)
        }
        GPathBy::Label => {
            if is_edge {
                store
                    .edge_type_name(id)
                    .map_or(Value::Null, |t| Value::Str(t.into()))
            } else {
                store
                    .labels_of(id)
                    .into_iter()
                    .next()
                    .map_or(Value::Null, |l| Value::Str(l.into()))
            }
        }
    }
}

/// Render MANY nodes to their result maps, resolving the property columns ONCE for the
/// whole batch instead of two HashMap-by-key lookups per node per key (what calling
/// [`node_result_value`] per node costs). Byte-identical to per-node rendering: the
/// property map keeps `prop_keys` (sorted) order, filtered to present, and labels stay
/// sorted. The big win for element-materializing shapes — `fold()`, `path`, `valueMap`,
/// `elementMap`, and a bare `g.V()` frontier — where the per-node column re-resolution
/// dominated.
pub(super) fn render_nodes(store: &Store, ids: &[u32]) -> Vec<Value> {
    use crate::store::Column;
    use std::sync::Arc;
    let keys = store.prop_keys_arc();
    let cols: Vec<(&Arc<str>, &Column)> = keys
        .iter()
        .filter_map(|k| store.column(k).map(|c| (k, c)))
        .collect();
    ids.iter()
        .map(|&id| {
            if id == u32::MAX {
                return Value::Null;
            }
            let i = id as usize;
            let ext = store
                .node_ext_id(id)
                .unwrap_or_else(|| GStr::from(id.to_string()));
            // `labels_of_refs` borrows each name and sorts once, where `labels_of` cloned a
            // `String` per label and sorted, and then this sorted again. Same order: both sort
            // the same names by the same byte ordering.
            let labels_list = Value::List(
                store
                    .labels_of_refs(id)
                    .into_iter()
                    .map(|l| Value::Str(l.into()))
                    .collect(),
            );
            let props: Vec<(Value, Value)> = cols
                .iter()
                .filter(|(_, c)| c.present_at(i))
                .map(|(k, c)| (Value::Str(Arc::clone(k).into()), c.read(i)))
                .collect();
            Value::Map(Arc::new(vec![
                (field_key(Field::Id), Value::Str(ext)),
                (field_key(Field::Labels), labels_list),
                (field_key(Field::Properties), Value::Map(Arc::new(props))),
            ]))
        })
        .collect()
}

/// Resolve the node property columns an element/value map reads, in the SAME order and
/// membership the per-node path produced — sorted keys (every present property, or the
/// `filter` list sorted), each paired with its column. Hoists the per-node
/// `prop_keys()` clone+sort and per-key HashMap probes out of the row loop; the caller
/// then does one `present_at`/`read` per column per node. Byte-identical: `prop_keys_arc`
/// is already sorted, a filter list is sorted here, and a filtered-then-sorted present
/// subset is the same set in the same order.
pub(super) fn resolve_node_cols<'a>(
    store: &'a Store,
    filter: &[String],
) -> Vec<(std::sync::Arc<str>, &'a crate::store::Column)> {
    use std::sync::Arc;
    if filter.is_empty() {
        store
            .prop_keys_arc()
            .iter()
            .filter_map(|k| store.column(k).map(|c| (Arc::clone(k), c)))
            .collect()
    } else {
        let mut keys = filter.to_vec();
        keys.sort();
        keys.into_iter()
            .filter_map(|k| store.column(&k).map(|c| (Arc::from(k.as_str()), c)))
            .collect()
    }
}

/// The canonical result map for a node — `{id, labels(sorted), properties(sorted by
/// key)}`, byte-identical to the TS engine's `val_to_value(Node)`.
/// Map a lineage node-id slice (`Value::Num(dense_id)` entries) to full vertex
/// element maps — the materialization behind `nodes(p)` and a Path's `vertices`.
pub(super) fn path_node_values(store: &Store, ids: &[Value]) -> Vec<Value> {
    ids.iter()
        .map(|v| match v {
            Value::Num(n) => node_result_value(store, *n as u32),
            other => other.clone(),
        })
        .collect()
}

/// Map a lineage edge-id slice to full edge element maps — behind `edges(p)` and a
/// Path's `edges`.
pub(super) fn path_edge_values(store: &Store, ids: &[Value]) -> Vec<Value> {
    ids.iter()
        .map(|v| match v {
            Value::Num(n) => edge_result_value(store, *n as u32),
            other => other.clone(),
        })
        .collect()
}

pub(super) fn node_result_value(store: &Store, id: u32) -> Value {
    use std::sync::Arc;
    let ext = store
        .node_ext_id(id)
        .unwrap_or_else(|| GStr::from(id.to_string()));
    // `labels_of_refs` BORROWS each name and sorts once; `labels_of` cloned a `String` per label
    // and sorted, and then this sorted the result again. Same order either way — both sort the
    // same names by the same byte ordering.
    let labels_list = Value::List(
        store
            .labels_of_refs(id)
            .into_iter()
            .map(|l| Value::Str(l.into()))
            .collect(),
    );
    // Present properties on this node, keyed in `prop_keys()` order — which is ALREADY
    // sorted, so the filtered subset stays sorted (the TS engine's props_map ordering) with no
    // re-sort and no intermediate Vec.
    //
    // ONE key lookup per property, not two: `has_prop` and `prop` each re-hash the key, and this
    // runs for every key on every row. `present_at`/`read` on the resolved column answer exactly
    // what they did — `has_prop` IS `present_at`, so a stored present-null still counts as
    // present and still renders as NULL.
    let props_map = Value::Map(Arc::new(
        store
            .prop_keys_arc()
            .iter()
            .filter_map(|k| {
                let col = store.column(k)?;
                col.present_at(id as usize)
                    .then(|| (Value::Str(Arc::clone(k).into()), col.read(id as usize)))
            })
            .collect(),
    ));
    Value::Map(Arc::new(vec![
        (field_key(Field::Id), Value::Str(ext)),
        (field_key(Field::Labels), labels_list),
        (field_key(Field::Properties), props_map),
    ]))
}

/// A field name in an element map.
#[derive(Copy, Clone)]
pub(super) enum Field {
    Id,
    Labels,
    Properties,
    From,
    To,
}

/// The element maps' field names, built ONCE for the process. `Value::Str` wraps a `GStr`, so
/// cloning one is a refcount bump, while `Value::Str("id".into())` allocates — and that was
/// three allocations per node row and five per edge row. Measured over 200,000 nodes it was
/// 34.9ns of a node element's 275.8ns, the single largest removable share.
pub(super) fn field_key(f: Field) -> Value {
    static KEYS: std::sync::OnceLock<[Value; 5]> = std::sync::OnceLock::new();
    KEYS.get_or_init(|| {
        [
            Value::Str("id".into()),
            Value::Str("labels".into()),
            Value::Str("properties".into()),
            Value::Str("from".into()),
            Value::Str("to".into()),
        ]
    })[f as usize]
        .clone()
}

/// A self-describing edge record `{id, label, outV, inV, properties}` — the shape
/// the TS engine's `subgraph_edge` builds (single `label` string; endpoints as external ids;
/// properties sorted by key).
pub(super) fn subgraph_edge_value(store: &Store, eid: u32) -> Value {
    use std::sync::Arc;
    let ext = |id: u32| store.node_ext_id(id).map_or(Value::Null, Value::Str);
    let (src, dst) = store.edge_endpoints(eid).unwrap_or((0, 0));
    let mut keys: Vec<String> = store
        .edge_prop_keys()
        .into_iter()
        .filter(|k| store.has_edge_prop(eid, k))
        .collect();
    keys.sort();
    let props: Vec<(Value, Value)> = keys
        .into_iter()
        .map(|k| {
            let v = store.edge_prop(eid, &k);
            (Value::Str(k.into()), v)
        })
        .collect();
    Value::Map(Arc::new(vec![
        (
            Value::Str("id".into()),
            store.edge_ext_id(eid).map_or(Value::Null, Value::Str),
        ),
        (
            Value::Str("label".into()),
            store
                .edge_type_name(eid)
                .map_or(Value::Null, |s| Value::Str(s.into())),
        ),
        (Value::Str("outV".into()), ext(src)),
        (Value::Str("inV".into()), ext(dst)),
        (Value::Str("properties".into()), Value::Map(Arc::new(props))),
    ]))
}

/// The empty result a write statement returns (no columns, no rows).
pub(super) fn empty_rows() -> Rows {
    Rows {
        names: Vec::new(),
        rows: Flat::default(),
    }
}

/// The output column names a plan produces, seen through row-shape-preserving
/// operators (`Distinct`, `OrderPage`) down to the naming one. `None` means no
/// explicit projection — the row is the raw slot-0 frontier.
pub(super) fn output_names(plan: &Plan) -> Option<Vec<String>> {
    match plan {
        Plan::Project { items, .. } => Some(items.iter().map(|(n, _)| n.clone()).collect()),
        Plan::Aggregate { keys, aggs, .. } => {
            let mut names: Vec<String> = keys.iter().map(|(n, _)| n.clone()).collect();
            names.extend(aggs.iter().map(|a| a.name.clone()));
            Some(names)
        }
        Plan::Distinct { input }
        | Plan::OrderPage { input, .. }
        | Plan::SortLocal { input, .. } => output_names(input),
        // UNION names come from the LEFT arm (the TS engine's rule).
        Plan::Union { left, .. } => output_names(left),
        _ => None,
    }
}

/// Whether any expression in the plan reads the path (`Expr::Path`) — the signal
/// that lineage must be tracked. Computed once, for the whole plan.
fn scan_path(plan: &Plan, leaf: &dyn Fn(&Expr) -> bool) -> bool {
    fn reads_path_inner(e: &Expr, leaf: &dyn Fn(&Expr) -> bool) -> bool {
        if leaf(e) {
            return true;
        }
        match e {
            // Which path reads COUNT is the caller's `leaf`, checked above.
            Expr::Path
            | Expr::PathAccess { .. }
            | Expr::GremlinPath { .. }
            | Expr::GremlinFullPath { .. } => false,
            Expr::Compare { left, right, .. }
            | Expr::In {
                needle: left,
                haystack: right,
            } => reads_path_inner(left, leaf) || reads_path_inner(right, leaf),
            Expr::Not(x) => reads_path_inner(x, leaf),
            Expr::And(a, b)
            | Expr::Or(a, b)
            | Expr::Xor(a, b)
            | Expr::Arith {
                left: a, right: b, ..
            } => reads_path_inner(a, leaf) || reads_path_inner(b, leaf),
            Expr::Call { args, .. } | Expr::GraphPred { args, .. } | Expr::List { items: args } => {
                args.iter().any(|e| reads_path_inner(e, leaf))
            }
            Expr::Record { fields }
            | Expr::MapLit {
                entries: fields, ..
            } => fields.iter().any(|(_, e)| reads_path_inner(e, leaf)),
            Expr::Field { base, .. } => reads_path_inner(base, leaf),
            Expr::Index { base, index, .. } => {
                reads_path_inner(base, leaf) || reads_path_inner(index, leaf)
            }
            Expr::Case {
                branches,
                otherwise,
            } => {
                branches
                    .iter()
                    .any(|(c, v)| reads_path_inner(c, leaf) || reads_path_inner(v, leaf))
                    || otherwise
                        .as_deref()
                        .is_some_and(|e| reads_path_inner(e, leaf))
            }
            Expr::Cast { expr, .. } | Expr::IsNull { expr, .. } => reads_path_inner(expr, leaf),
            // An EXISTS body reads its OWN (sub-)path, never the outer one, and the
            // seed is built without lineage — so it never forces outer tracking.
            Expr::Slot(_)
            | Expr::Prop { .. }
            | Expr::Lit(_)
            | Expr::Param(_)
            | Expr::PropertyExists { .. }
            | Expr::IsLabeled { .. }
            | Expr::Exists { .. }
            | Expr::CountSubquery { .. }
            | Expr::ScalarSubquery { .. }
            | Expr::CollectSubquery { .. }
            | Expr::AggSubquery { .. }
            | Expr::UncorrelatedExists { .. }
            | Expr::UncorrelatedCount { .. }
            | Expr::UncorrelatedScalar { .. } => false,
        }
    }
    match plan {
        Plan::Scan { .. }
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
        | Plan::TxControl { .. }
        | Plan::InsertFrom { .. } => false,
        // otherV off a bare edge reads the lineage reference vertex.
        Plan::EdgeVertex { input, other, .. } => *other || scan_path(input, leaf),
        Plan::Sample { input, .. }
        | Plan::Enumerate { input, .. }
        | Plan::Expand { input, .. }
        | Plan::OptionalExpand { input, .. }
        | Plan::VarLength { input, .. }
        | Plan::RepeatGroup { input, .. }
        | Plan::NestedGroup { input, .. }
        | Plan::ShortestPath { input, .. }
        | Plan::Distinct { input }
        | Plan::Fail { input, .. }
        | Plan::DistinctBy { input, .. }
        | Plan::Tail { input, .. }
        | Plan::NullPadIfEmpty { input, .. }
        | Plan::GroupToMap { input }
        | Plan::AlgoAnnotate { input, .. }
        | Plan::SortLocal { input, .. } => scan_path(input, leaf),
        // tree() reads the path lineage itself, so its INPUT must track it.
        Plan::Tree { .. } => true,
        Plan::MapSlot { input, value, .. } => {
            reads_path_inner(value, leaf) || scan_path(input, leaf)
        }
        Plan::Subgraph { input, .. } => scan_path(input, leaf),
        Plan::ShortestPathEnum { input, .. } => scan_path(input, leaf),
        Plan::OptionalScan { input, filters, .. } => {
            filters.iter().any(|(_, e)| reads_path_inner(e, leaf)) || scan_path(input, leaf)
        }
        Plan::Unwind { input, list, .. } => reads_path_inner(list, leaf) || scan_path(input, leaf),
        Plan::Branch { input, bodies } => {
            scan_path(input, leaf) || bodies.iter().any(|p| scan_path(p, leaf))
        }
        Plan::PerElementBranch {
            input, cond, arms, ..
        } => {
            scan_path(input, leaf)
                || cond.as_deref().is_some_and(|p| scan_path(p, leaf))
                || arms.iter().any(|p| scan_path(p, leaf))
        }
        Plan::Reconverge { input, .. } => scan_path(input, leaf),
        Plan::IntervalExpand {
            input, qlo, qhi, ..
        } => reads_path_inner(qlo, leaf) || reads_path_inner(qhi, leaf) || scan_path(input, leaf),
        Plan::Filter { input, pred } => reads_path_inner(pred, leaf) || scan_path(input, leaf),
        // A `PathRecord` writes the step-history, so the plan must track lineage; the `input`
        // is walked for the same reason `Filter` walks its own (the decision is plan-global).
        Plan::PathRecord { .. } => true,
        Plan::Project { input, items } => {
            items.iter().any(|(_, e)| reads_path_inner(e, leaf)) || scan_path(input, leaf)
        }
        Plan::Aggregate { input, keys, aggs } => {
            keys.iter().any(|(_, e)| reads_path_inner(e, leaf))
                || aggs
                    .iter()
                    .any(|a| a.arg.as_ref().is_some_and(|e| reads_path_inner(e, leaf)))
                || scan_path(input, leaf)
        }
        Plan::OrderPage { input, keys, .. } => {
            keys.iter().any(|k| reads_path_inner(&k.expr, leaf)) || scan_path(input, leaf)
        }
        Plan::Join { left, right, .. } | Plan::Union { left, right, .. } => {
            scan_path(left, leaf) || scan_path(right, leaf)
        }
        // The subquery yields append columns; whether the OUTER plan needs a path
        // depends on its input (a path read inside the subquery is not surfaced).
        Plan::CallInline { input, yields, .. } => {
            scan_path(input, leaf) || yields.iter().any(|(_, e)| reads_path_inner(e, leaf))
        }
        Plan::Update { input, ops } => {
            scan_path(input, leaf)
                || ops.iter().any(|op| match op {
                    crate::ir::SetOp::Set { value, .. } => reads_path_inner(value, leaf),
                    crate::ir::SetOp::Remove { .. }
                    | crate::ir::SetOp::AddLabel { .. }
                    | crate::ir::SetOp::RemoveLabel { .. }
                    | crate::ir::SetOp::Delete { .. } => false,
                })
        }
        Plan::UpdateReturn { input, ops, tail } => {
            scan_path(input, leaf)
                || scan_path(tail, leaf)
                || ops.iter().any(|op| match op {
                    crate::ir::SetOp::Set { value, .. } => reads_path_inner(value, leaf),
                    crate::ir::SetOp::Remove { .. }
                    | crate::ir::SetOp::AddLabel { .. }
                    | crate::ir::SetOp::RemoveLabel { .. }
                    | crate::ir::SetOp::Delete { .. } => false,
                })
        }
    }
}

/// Whether any expression in the plan reads the path (`Expr::Path`) — the signal that
/// lineage must be tracked. Computed once, for the whole plan.
pub(crate) fn needs_lineage(plan: &Plan) -> bool {
    scan_path(plan, &|e| {
        matches!(
            e,
            Expr::Path
                | Expr::PathAccess { .. }
                | Expr::GremlinPath { .. }
                | Expr::GremlinFullPath { .. }
        )
    })
}

/// Whether any expression reads a path ELEMENT, as opposed to only its size. This is the
/// complement of `path_length(p)` / `cardinality(p)`: false means every path read in the
/// plan is a size, so the traversal can record sizes and skip building the chains.
///
/// It shares `scan_path` with [`needs_lineage`] deliberately. That walk enumerates every
/// `Plan` and every `Expr` variant with no wildcard arm, so a variant added later fails to
/// compile until it is classified here too — a second hand-written walk would instead go on
/// silently returning "no element read" for the new shape, and suppressing a path somebody
/// reads is a wrong answer, not a crash.
pub(crate) fn needs_path_elements(plan: &Plan) -> bool {
    scan_path(plan, &|e| match e {
        Expr::PathAccess { part } => !matches!(
            part,
            crate::ir::PathPart::Length | crate::ir::PathPart::Cardinality
        ),
        // A bare path, and both Gremlin path forms, hand back the elements themselves.
        Expr::Path | Expr::GremlinPath { .. } | Expr::GremlinFullPath { .. } => true,
        _ => false,
    })
}
