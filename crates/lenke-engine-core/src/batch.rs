//! The one batch type every operator produces and consumes.
//!
//! A batch is a columnar block of rows. Its `col` is the current value of each
//! row — unboxed where the type allows (`Num`/`Bool`/`Str`), node ids for a
//! frontier (`Nodes`), or a boxed fallback (`Gen`). Its `lineage` sidecar is
//! present only when the plan needs path/tags/sack; the first slice is
//! lineage-free, so the sidecar is scaffolded but always `None` here — the shape
//! is in place for the operators that will carry it.

use crate::gstr::GStr;

use crate::value::Value;

/// The current-value column of a batch. Unboxed variants are the fast path; the
/// bulk operator strategies read and write these without ever boxing a `Value`.
#[derive(Clone, Debug)]
pub enum Col {
    /// A frontier of node ids.
    Nodes(Vec<u32>),
    /// A frontier of edge ids (the traversed relationships), bound by an Expand
    /// that also binds its edge. A `Prop` on an edge slot reads an edge property.
    Edges(Vec<u32>),
    Num(Vec<f64>),
    Bool(Vec<bool>),
    Str(Vec<GStr>),
    /// Mixed or otherwise unboxable values.
    Gen(Vec<Value>),
}

impl Col {
    #[must_use]
    pub fn len(&self) -> usize {
        match self {
            Self::Nodes(v) | Self::Edges(v) => v.len(),
            Self::Num(v) => v.len(),
            Self::Bool(v) => v.len(),
            Self::Str(v) => v.len(),
            Self::Gen(v) => v.len(),
        }
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Row `i` as a boxed `Value`. The boxing edge — used by the boxed/`Gen`
    /// evaluation paths and by result materialization, not by the bulk kernels.
    #[must_use]
    pub fn value_at(&self, i: usize) -> Value {
        match self {
            // A node id surfaced as a value is still a node; there is no distinct
            // Value::Node yet in this slice, so it reads through as its id in Num
            // form only where a caller asked for a value column, never here — a
            // Nodes column is an element frontier, not a value. Callers that want
            // a value read a property off it instead.
            // `u32::MAX` is the OPTIONAL-MATCH null sentinel (never a real dense id)
            // — an unmatched optional element reads back as NULL.
            Self::Nodes(v) | Self::Edges(v) if v[i] == u32::MAX => Value::Null,
            Self::Nodes(v) | Self::Edges(v) => Value::Num(f64::from(v[i])),
            Self::Num(v) => Value::Num(v[i]),
            Self::Bool(v) => Value::Bool(v[i]),
            Self::Str(v) => Value::Str(v[i].clone()),
            Self::Gen(v) => v[i].clone(),
        }
    }

    /// Is row `i` NULL? Exactly `value_at(i).is_null()`, without boxing the value — which for
    /// a `Str` column meant an `Arc` clone per row to ask a question the representation already
    /// answers. The case analysis is the whole proof: `Num`, `Bool` and `Str` have no null
    /// representation (a column that would need one is built as `Gen`, since there is no
    /// nullable typed variant), so only the `u32::MAX` OPTIONAL-MATCH sentinel and a boxed
    /// `Value::Null` can be null.
    ///
    /// A `Num` cell holding NaN is NOT null, matching `value_at` — `Value::Num(NaN).is_null()`
    /// is false, and `count()` has always counted it.
    #[must_use]
    pub fn is_null_at(&self, i: usize) -> bool {
        match self {
            Self::Nodes(v) | Self::Edges(v) => v[i] == u32::MAX,
            Self::Num(_) | Self::Bool(_) | Self::Str(_) => false,
            Self::Gen(v) => v[i].is_null(),
        }
    }

    /// Gather the rows at `idx`, in that order — the primitive filter/reorder
    /// operators use to keep a subset without boxing.
    #[must_use]
    pub fn gather(&self, idx: &[usize]) -> Self {
        match self {
            Self::Nodes(v) => Self::Nodes(idx.iter().map(|&i| v[i]).collect()),
            Self::Edges(v) => Self::Edges(idx.iter().map(|&i| v[i]).collect()),
            Self::Num(v) => Self::Num(idx.iter().map(|&i| v[i]).collect()),
            Self::Bool(v) => Self::Bool(idx.iter().map(|&i| v[i]).collect()),
            Self::Str(v) => Self::Str(idx.iter().map(|&i| v[i].clone()).collect()),
            Self::Gen(v) => Self::Gen(idx.iter().map(|&i| v[i].clone()).collect()),
        }
    }
}

/// The lineage sidecar: the per-row path, present ONLY when the plan reads it.
/// This is the design's heart — the same batch carries lineage or not, decided
/// per plan, instead of a separate traverser type. Row `i`'s path is
/// `values[offsets[i]..offsets[i+1]]` (Arrow-style list layout: `offsets` has
/// `rows + 1` entries, `offsets[0] == 0`). Path elements are node ids as
/// `Value::Num` for now (there is no dedicated node value yet); tags and sack
/// join this struct when their operators do.
///
/// A path of *k* nodes has *k − 1* edges, carried in a PARALLEL list
/// (`edges`/`edge_offsets`) so `relationships(p)` / `elements(p)` can name the
/// traversed relationships, not just the nodes. Edge ids are `Value::Num` too
/// (no dedicated edge value yet). A single-node seed path has zero edges.
#[derive(Clone, Debug, Default)]
pub struct Lineage {
    pub values: Vec<Value>,
    pub offsets: Vec<usize>,
    pub edges: Vec<Value>,
    pub edge_offsets: Vec<usize>,
    /// The full per-step TRAVERSER HISTORY for Gremlin `path()`/`tree()` — the ordered
    /// sequence of values the traverser has been, one entry per value-producing step, exactly
    /// like the pure-TS engine's `Traverser.path`. Unlike `values`/`edges` (which are the
    /// GQL node/edge path — a pattern's bound elements), this interleaves vertices, edges AND
    /// projected scalars in the order the steps ran, so `V().values('name').path()` yields
    /// `[v, 'name']` and `E().path()` yields `[e]`. Row `i`'s history is
    /// `steps[step_off[i]..step_off[i+1]]`, each element tagged by `step_tag`
    /// (0 = node id, 1 = edge id, 2 = scalar value). Present only when a Gremlin full-path is
    /// read (see `needs_gremlin_path`); empty otherwise.
    pub steps: Vec<Value>,
    pub step_tag: Vec<u8>,
    pub step_off: Vec<usize>,
    /// Row `i`'s path SIZE as `(node count, edge count)` — present only when the path's
    /// elements were deliberately not materialized because the plan reads nothing but
    /// `path_length(p)` / `cardinality(p)`. EMPTY is the ordinary case, where the sizes are
    /// the `offsets` / `edge_offsets` spans and `values` / `edges` hold the elements.
    ///
    /// Read it through [`Lineage::node_count_at`] / [`Lineage::edge_count_at`], never
    /// directly: they are the single place that knows which of the two representations is
    /// in play, and every other reader should be unable to tell.
    ///
    /// Why an explicit count rather than carrying `offsets` as a length prefix-sum over an
    /// empty `values`: `gather` (and `extend`, and `concat`) rebuild the path through
    /// `path_at`, which slices `values[offsets[i]..offsets[i + 1]]`. Non-zero offsets over
    /// an empty `values` is an out-of-range slice, not a compact encoding — and
    /// `try_shortest_early_stop` gathers directly, so an ordinary `WHERE` after a shortest
    /// path would panic. The counts also cannot be derived from one another: a
    /// `seed_edges` lineage has neither a node nor an edge recorded, so "nodes == edges + 1"
    /// is not an invariant to lean on.
    pub elem_counts: Vec<(u32, u32)>,
}

/// Tag for a `Lineage::steps` history element.
pub const STEP_NODE: u8 = 0;
pub const STEP_EDGE: u8 = 1;
pub const STEP_SCALAR: u8 = 2;

impl Lineage {
    /// Seed one single-node path per node — what a lineage-tracking Scan produces. The
    /// Gremlin step-history is seeded with the same node (the source vertex is the first
    /// path element); `PathRecord` appends every subsequent value-producing step.
    #[must_use]
    pub fn seed(nodes: &[u32]) -> Self {
        Self {
            values: nodes.iter().map(|&n| Value::Num(f64::from(n))).collect(),
            offsets: (0..=nodes.len()).collect(),
            edges: Vec::new(),
            edge_offsets: vec![0; nodes.len() + 1], // each seed path has 0 edges
            steps: nodes.iter().map(|&n| Value::Num(f64::from(n))).collect(),
            step_tag: vec![STEP_NODE; nodes.len()],
            step_off: (0..=nodes.len()).collect(),
            // A seed materializes its own elements, so the sizes come from the spans.
            elem_counts: Vec::new(),
        }
    }

    /// Seed a single-element step-history per row from arbitrary VALUES with the given tag
    /// (`inject(v)` → each `v`'s path is `[v]`). The node/edge path stays empty.
    #[must_use]
    pub fn seed_steps(vals: &[Value], tag: u8) -> Self {
        Self {
            values: Vec::new(),
            offsets: vec![0; vals.len() + 1],
            edges: Vec::new(),
            edge_offsets: vec![0; vals.len() + 1],
            steps: vals.to_vec(),
            step_tag: vec![tag; vals.len()],
            step_off: (0..=vals.len()).collect(),
            // A seed materializes its own elements, so the sizes come from the spans.
            elem_counts: Vec::new(),
        }
    }

    /// Seed one single-EDGE step-history per edge — the `E()` source (`E().path()` yields
    /// `[e]`). The node/edge path stays empty (GQL does not read an edge-sourced lineage).
    #[must_use]
    pub fn seed_edges(edges: &[u32]) -> Self {
        Self {
            values: Vec::new(),
            offsets: vec![0; edges.len() + 1],
            edges: Vec::new(),
            edge_offsets: vec![0; edges.len() + 1],
            steps: edges.iter().map(|&e| Value::Num(f64::from(e))).collect(),
            step_tag: vec![STEP_EDGE; edges.len()],
            step_off: (0..=edges.len()).collect(),
            // A seed materializes its own elements, so the sizes come from the spans.
            elem_counts: Vec::new(),
        }
    }

    /// An empty sidecar (zero rows) — for a lineage-tracking operator that
    /// produced nothing.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            values: Vec::new(),
            offsets: vec![0],
            edges: Vec::new(),
            edge_offsets: vec![0],
            steps: Vec::new(),
            step_tag: Vec::new(),
            step_off: vec![0],
            // A seed materializes its own elements, so the sizes come from the spans.
            elem_counts: Vec::new(),
        }
    }

    /// Row `i`'s Gremlin step-history slice, paired with the per-element tags. Empty when the
    /// row has no history recorded (a lineage that carried no `steps`, or a row index past the
    /// recorded offsets — e.g. a path read inside a branch whose arm did not record steps).
    #[must_use]
    pub fn steps_at(&self, i: usize) -> (&[Value], &[u8]) {
        if i + 1 >= self.step_off.len() {
            return (&[], &[]);
        }
        let (a, b) = (self.step_off[i], self.step_off[i + 1]);
        (&self.steps[a..b], &self.step_tag[a..b])
    }

    /// Append one value per row to the step-history (what `PathRecord` produces): row `i`'s
    /// history grows by `(vals[i], tag)`. Preserves the node/edge path unchanged.
    #[must_use]
    pub fn push_step(&self, vals: &[Value], tag: u8) -> Self {
        let rows = self.offsets.len().saturating_sub(1);
        let mut steps = Vec::with_capacity(self.steps.len() + rows);
        let mut step_tag = Vec::with_capacity(self.step_tag.len() + rows);
        let mut step_off = vec![0usize];
        for (i, v) in vals.iter().enumerate().take(rows) {
            let (sv, st) = self.steps_at(i);
            steps.extend_from_slice(sv);
            step_tag.extend_from_slice(st);
            steps.push(v.clone());
            step_tag.push(tag);
            step_off.push(steps.len());
        }
        Self {
            values: self.values.clone(),
            offsets: self.offsets.clone(),
            edges: self.edges.clone(),
            edge_offsets: self.edge_offsets.clone(),
            steps,
            step_tag,
            step_off,
            // Appends to the STEP history only; the node/edge path is unchanged.
            elem_counts: self.elem_counts.clone(),
        }
    }

    /// Row `i`'s node path.
    #[must_use]
    pub fn path_at(&self, i: usize) -> &[Value] {
        &self.values[self.offsets[i]..self.offsets[i + 1]]
    }

    /// Row `i`'s edge path (the relationships traversed).
    #[must_use]
    pub fn edges_at(&self, i: usize) -> &[Value] {
        &self.edges[self.edge_offsets[i]..self.edge_offsets[i + 1]]
    }

    /// How many NODES row `i`'s path has — from the materialized span, or from
    /// `elem_counts` when the elements were suppressed. Prefer this over
    /// `path_at(i).len()` anywhere only the size is wanted: it is correct in both
    /// representations, and it is what makes the suppressed one invisible.
    #[must_use]
    pub fn node_count_at(&self, i: usize) -> usize {
        if self.elem_counts.is_empty() {
            self.offsets[i + 1] - self.offsets[i]
        } else {
            self.elem_counts[i].0 as usize
        }
    }

    /// How many EDGES row `i`'s path traversed — the hop count. See
    /// [`Lineage::node_count_at`].
    #[must_use]
    pub fn edge_count_at(&self, i: usize) -> usize {
        if self.elem_counts.is_empty() {
            self.edge_offsets[i + 1] - self.edge_offsets[i]
        } else {
            self.elem_counts[i].1 as usize
        }
    }

    /// Reorder/subset the paths by `idx` (parallel to a slot gather).
    #[must_use]
    pub fn gather(&self, idx: &[usize]) -> Self {
        let mut values = Vec::new();
        let mut offsets = vec![0usize];
        let mut edges = Vec::new();
        let mut edge_offsets = vec![0usize];
        let mut steps = Vec::new();
        let mut step_tag = Vec::new();
        let mut step_off = vec![0usize];
        let has_steps = self.step_off.len() > 1;
        // Suppressed paths carry their sizes rather than their elements, so the gather
        // reorders the counts instead of copying spans. `path_at` would slice an empty
        // `values` here, which is why this branch exists rather than falling through.
        let suppressed = !self.elem_counts.is_empty();
        let mut elem_counts = Vec::new();
        for &i in idx {
            if suppressed {
                elem_counts.push(self.elem_counts[i]);
            } else {
                values.extend_from_slice(self.path_at(i));
                edges.extend_from_slice(self.edges_at(i));
            }
            offsets.push(values.len());
            edge_offsets.push(edges.len());
            if has_steps {
                let (sv, st) = self.steps_at(i);
                steps.extend_from_slice(sv);
                step_tag.extend_from_slice(st);
            }
            step_off.push(steps.len());
        }
        Self {
            values,
            offsets,
            edges,
            edge_offsets,
            steps,
            step_tag,
            step_off,
            elem_counts,
        }
    }

    /// One output path per `(keep[k], new_nodes[k], new_edges[k])`: the input row
    /// `keep[k]`'s path extended by the node reached over the edge traversed —
    /// what a lineage-tracking Expand produces.
    #[must_use]
    pub fn extend(&self, keep: &[usize], new_nodes: &[u32], new_edges: &[u32]) -> Self {
        let mut values = Vec::new();
        let mut offsets = vec![0usize];
        let mut edges = Vec::new();
        let mut edge_offsets = vec![0usize];
        // The Gremlin step-history is carried through UNCHANGED (gathered by `keep`); the new
        // node/edge is recorded into it by a following `PathRecord`, not here — an Expand
        // serves both a GQL pattern (edge in the path) and a Gremlin `out()` (edge NOT in the
        // path), so the step append is decided by the lowering, per step.
        let mut steps = Vec::new();
        let mut step_tag = Vec::new();
        let mut step_off = vec![0usize];
        let has_steps = self.step_off.len() > 1;
        let suppressed = !self.elem_counts.is_empty();
        let mut elem_counts = Vec::new();
        for (i, &k) in keep.iter().enumerate() {
            if suppressed {
                // One node and one edge added to the row's size; the elements stay unstored.
                let (n, e) = self.elem_counts[k];
                elem_counts.push((n + 1, e + 1));
            } else {
                values.extend_from_slice(self.path_at(k));
                values.push(Value::Num(f64::from(new_nodes[i])));
                edges.extend_from_slice(self.edges_at(k));
                edges.push(Value::Num(f64::from(new_edges[i])));
            }
            offsets.push(values.len());
            edge_offsets.push(edges.len());
            if has_steps {
                let (sv, st) = self.steps_at(k);
                steps.extend_from_slice(sv);
                step_tag.extend_from_slice(st);
            }
            step_off.push(steps.len());
        }
        Self {
            values,
            offsets,
            edges,
            edge_offsets,
            steps,
            step_tag,
            step_off,
            elem_counts,
        }
    }

    /// One output path per `(keep[k], new_nodes[k])`: the input row `keep[k]`'s
    /// node path extended by the landed VERTEX, with the edge path and step-history
    /// carried through unchanged. This is what an endpoint move (`outV`/`inV`/
    /// `otherV`/`bothV` off an edge frontier) produces: unlike [`extend`] it traverses
    /// no new edge, it just moves the traverser onto an endpoint vertex — so the node
    /// path records that vertex (a following `otherV` reads it as the reference), but
    /// the edge path does not gain an entry. Without it a branch arm's
    /// `outV().inE(..)` loses the pre-edge vertex and a post-branch `otherV` resolves
    /// against the wrong endpoint.
    #[must_use]
    pub fn extend_nodes(&self, keep: &[usize], new_nodes: &[u32]) -> Self {
        let mut values = Vec::new();
        let mut offsets = vec![0usize];
        let mut edges = Vec::new();
        let mut edge_offsets = vec![0usize];
        let mut steps = Vec::new();
        let mut step_tag = Vec::new();
        let mut step_off = vec![0usize];
        let has_steps = self.step_off.len() > 1;
        let suppressed = !self.elem_counts.is_empty();
        let mut elem_counts = Vec::new();
        for (i, &k) in keep.iter().enumerate() {
            if suppressed {
                // An endpoint MOVE: a node joins the path, no edge is traversed.
                let (n, e) = self.elem_counts[k];
                elem_counts.push((n + 1, e));
            } else {
                values.extend_from_slice(self.path_at(k));
                values.push(Value::Num(f64::from(new_nodes[i])));
                edges.extend_from_slice(self.edges_at(k));
            }
            offsets.push(values.len());
            edge_offsets.push(edges.len());
            if has_steps {
                let (sv, st) = self.steps_at(k);
                steps.extend_from_slice(sv);
                step_tag.extend_from_slice(st);
            }
            step_off.push(steps.len());
        }
        Self {
            values,
            offsets,
            edges,
            edge_offsets,
            steps,
            step_tag,
            step_off,
            elem_counts,
        }
    }

    /// Concatenate several sidecars row-wise (union/coalesce branch output): each
    /// input's paths in order, so the result is row-aligned with concatenated slot
    /// columns.
    #[must_use]
    pub fn concat(parts: &[&Lineage]) -> Self {
        let mut values = Vec::new();
        let mut offsets = vec![0usize];
        let mut edges = Vec::new();
        let mut edge_offsets = vec![0usize];
        let mut steps = Vec::new();
        let mut step_tag = Vec::new();
        let mut step_off = vec![0usize];
        // Branch arms can disagree about whether their paths are materialized. If ANY arm
        // suppressed, the result is suppressed uniformly, taking the materialized arms'
        // sizes from their spans through the accessors — mixing the two representations in
        // one sidecar is what would make a later reader's answer depend on which arm a row
        // came from.
        let suppressed = parts.iter().any(|l| !l.elem_counts.is_empty());
        let mut elem_counts = Vec::new();
        for lin in parts {
            let rows = lin.offsets.len().saturating_sub(1);
            let has_steps = lin.step_off.len() > 1;
            for i in 0..rows {
                if suppressed {
                    elem_counts.push((
                        u32::try_from(lin.node_count_at(i)).unwrap_or(u32::MAX),
                        u32::try_from(lin.edge_count_at(i)).unwrap_or(u32::MAX),
                    ));
                } else {
                    values.extend_from_slice(lin.path_at(i));
                    edges.extend_from_slice(lin.edges_at(i));
                }
                offsets.push(values.len());
                edge_offsets.push(edges.len());
                if has_steps {
                    let (sv, st) = lin.steps_at(i);
                    steps.extend_from_slice(sv);
                    step_tag.extend_from_slice(st);
                }
                step_off.push(steps.len());
            }
        }
        Self {
            values,
            offsets,
            edges,
            edge_offsets,
            steps,
            step_tag,
            step_off,
            elem_counts,
        }
    }
}

/// One batch flowing between operators. A batch is a set of row-aligned SLOT
/// columns — row `i` is the tuple `(slots[0][i], slots[1][i], …)`. Scan binds
/// slot 0; each Expand appends a slot for the node it lands on; a multi-variable
/// pattern like `(a)-[:R]->(b)` is two slots. This is the uniform binding the IR
/// relies on — a GQL variable and a Gremlin `as()` label are both "slot N".
#[derive(Clone, Debug)]
pub struct Batch {
    pub slots: Vec<Col>,
    pub lineage: Option<Lineage>,
    /// The PROVENANCE sidecar: `prov[i]` is the row of some earlier frontier that output row
    /// `i` descends from. Present ONLY while a caller is tracking it — today the whole-stream
    /// branch router in `exec`, which seeds it with `0..rows` and reads it back to regroup an
    /// arm's output by the input row that produced it.
    ///
    /// It rides in the sidecar rather than in a slot on purpose. A branch arm is compiled over
    /// an input of a known width and appends its own slots at that width, so a prov COLUMN
    /// would shift every slot the arm appends; a sidecar moves nothing. `gather` carries it,
    /// which is the single funnel every row-local operator already passes through, and an
    /// operator that builds a fresh `Batch` drops it — the fall-back signal, for free.
    ///
    /// **Carrying it is not a licence to use it.** `OrderPage`, `Distinct` and `Tail` all
    /// gather, so prov survives them while the rows it describes have been reordered or
    /// dropped by looking at OTHER rows. A reader must check the plan shape as well
    /// (`arm_is_row_local`), never the sidecar's presence alone.
    pub prov: Option<Vec<u32>>,
}

impl Batch {
    /// A one-slot, lineage-free batch (the output of a Scan).
    #[must_use]
    pub fn single(col: Col) -> Self {
        Self {
            slots: vec![col],
            lineage: None,
            prov: None,
        }
    }

    /// A lineage-free batch of several slots.
    #[must_use]
    pub fn of(slots: Vec<Col>) -> Self {
        Self {
            slots,
            lineage: None,
            prov: None,
        }
    }

    /// Row count (every slot has the same length).
    #[must_use]
    pub fn rows(&self) -> usize {
        self.slots.first().map_or(0, Col::len)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rows() == 0
    }

    #[must_use]
    pub fn slot(&self, i: usize) -> &Col {
        &self.slots[i]
    }

    /// Gather every slot AND the lineage by the same row indices — the primitive
    /// Filter, OrderPage, and Distinct use to keep/reorder rows while staying
    /// row-aligned. The lineage must be gathered too, or a reorder would
    /// desynchronize paths from their rows.
    #[must_use]
    pub fn gather(&self, idx: &[usize]) -> Self {
        Self {
            slots: self.slots.iter().map(|c| c.gather(idx)).collect(),
            lineage: self.lineage.as_ref().map(|l| l.gather(idx)),
            prov: self
                .prov
                .as_ref()
                .map(|p| idx.iter().map(|&i| p[i]).collect()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * Item 2552: `batch.rs` is "the one batch type every operator produces and consumes" — 584
     * lines — and it had ZERO tests. It was also outside every sweep this session ran, because
     * those were scoped to `crates/lenke-engine/src` and this module lives in a SEPARATE crate,
     * re-exported by one line of `lib.rs`:
     *
     *     pub use lenke_engine_core::{batch, error_codes, gstr, temporal, value};
     *
     * It was found by chasing `try_distinct_typed(batch: &Batch)` to its type.
     *
     * ## WHY THESE PROPERTIES
     *
     * `gather` is how every filter, distinct and sort operator subsets a batch, and it is written
     * once per `Col` variant — six near-identical arms, which is where an off-by-one or a swapped
     * index lives. So it is pinned as SELECT-BY-INDEX over all six.
     *
     * And `value_at` carries the `u32::MAX` OPTIONAL-MATCH null sentinel. This repo has already
     * shipped one WRONG ANSWER from that sentinel: `hash_join` put it in a bucket a real node id
     * could reach, inventing rows, and only a 500,000-seed `rewrite_fuzz` sweep found it (audit
     * items 1148-1150). A sentinel with that history, in a module with no tests, is the thing to
     * pin first — including that it SURVIVES a gather, since gather is what a join's build side
     * runs on.
     *
     * Every expectation was measured by printing the matrix first.
     */
    fn all_six() -> Vec<(&'static str, Col)> {
        vec![
            // The sentinel sits at index 1 in both element variants, deliberately.
            ("Nodes", Col::Nodes(vec![7, u32::MAX, 9])),
            ("Edges", Col::Edges(vec![7, u32::MAX, 9])),
            ("Num", Col::Num(vec![1.0, 2.0, 3.0])),
            ("Bool", Col::Bool(vec![true, false, true])),
            (
                "Str",
                Col::Str(vec![GStr::from("a"), GStr::from("b"), GStr::from("c")]),
            ),
            (
                "Gen",
                Col::Gen(vec![Value::Num(1.0), Value::Null, Value::Bool(true)]),
            ),
        ]
    }

    #[test]
    fn gather_is_select_by_index_for_every_column_variant() {
        // A reorder, a subset, a repeat and an empty selection — `gather` is not a permutation.
        for idx in [vec![2, 1, 0], vec![2, 0], vec![1, 1, 1], Vec::new()] {
            for (tag, col) in all_six() {
                let got = col.gather(&idx);

                assert_eq!(
                    got.len(),
                    idx.len(),
                    "{tag}: gather({idx:?}) must produce exactly one row per index",
                );

                for (k, &src) in idx.iter().enumerate() {
                    assert_eq!(
                        format!("{:?}", got.value_at(k)),
                        format!("{:?}", col.value_at(src)),
                        "{tag}: gather({idx:?})[{k}] must be the original row {src}",
                    );
                }
            }
        }
    }

    #[test]
    fn the_optional_match_sentinel_reads_null_in_both_element_variants_and_survives_a_gather() {
        for (tag, col) in all_six() {
            if tag != "Nodes" && tag != "Edges" {
                continue;
            }

            assert!(
                !col.is_null_at(0) && !col.is_null_at(2),
                "{tag}: a real dense id must not read as NULL",
            );
            assert!(
                col.is_null_at(1),
                "{tag}: u32::MAX is the OPTIONAL-MATCH sentinel and must read as NULL",
            );
            assert_eq!(format!("{:?}", col.value_at(1)), "Null", "{tag}");

            // The join build side gathers before probing, so the sentinel has to survive it —
            // this is the shape of audit items 1148-1150.
            let moved = col.gather(&[1, 0]);

            assert!(
                moved.is_null_at(0),
                "{tag}: the sentinel stopped reading as NULL after a gather moved it",
            );
            assert!(
                !moved.is_null_at(1),
                "{tag}: a real id became NULL after a gather"
            );
        }
    }

    /// `is_null_at` must agree with `value_at` on every variant, including a `Gen` column holding
    /// a real `Value::Null` — which is a PRESENT value under this repo's null policy, not an
    /// absent one, and still reads as null here.
    #[test]
    fn is_null_at_agrees_with_value_at_on_every_variant() {
        for (tag, col) in all_six() {
            for i in 0..col.len() {
                let is_null_value = format!("{:?}", col.value_at(i)) == "Null";

                assert_eq!(
                    col.is_null_at(i),
                    is_null_value,
                    "{tag}[{i}]: is_null_at disagrees with value_at ({:?})",
                    col.value_at(i),
                );
            }
        }
    }

    #[test]
    fn a_batch_gathers_every_slot_in_parallel() {
        let batch = Batch::of(vec![
            Col::Num(vec![1.0, 2.0, 3.0]),
            Col::Bool(vec![true, false, true]),
        ]);

        assert_eq!(batch.rows(), 3);

        let got = batch.gather(&[2, 0]);

        assert_eq!(got.rows(), 2, "the gathered batch has one row per index");
        // Both slots must move together, or a row's columns come from different source rows —
        // which no row-level assertion elsewhere would catch.
        assert_eq!(format!("{:?}", got.slot(0)), "Num([3.0, 1.0])");
        assert_eq!(format!("{:?}", got.slot(1)), "Bool([true, true])");
    }

    #[test]
    fn a_single_column_batch_is_one_slot_wide() {
        let batch = Batch::single(Col::Num(vec![1.0, 2.0]));

        assert_eq!(batch.rows(), 2);
        assert!(!batch.is_empty());
        assert!(
            Batch::of(Vec::new()).is_empty(),
            "no slots is an empty batch"
        );
    }

    /// `Lineage::gather` must move paths in step with the slot gather, or a row's path belongs to
    /// a different row.
    #[test]
    fn lineage_gather_reorders_paths_in_step_with_the_slots() {
        let lineage = Lineage::seed(&[1, 2, 3]);

        assert_eq!(format!("{:?}", lineage.path_at(0)), "[Num(1.0)]");
        assert_eq!(
            lineage.node_count_at(0),
            1,
            "a seed path holds its own node"
        );
        assert_eq!(
            lineage.edge_count_at(0),
            0,
            "a seed path has traversed no edge"
        );

        let got = lineage.gather(&[2, 0]);

        assert_eq!(format!("{:?}", got.path_at(0)), "[Num(3.0)]");
        assert_eq!(format!("{:?}", got.path_at(1)), "[Num(1.0)]");
    }

    /// An EDGE-sourced lineage leaves the node/edge PATH empty on purpose, and keeps the edge in
    /// the Gremlin STEP history instead — `seed_edges`'s docstring says "GQL does not read an
    /// edge-sourced lineage". Measured and pinned here so the asymmetry is not read as a bug and
    /// "fixed": filling `edges` would make `E().path()` report a traversal that never happened.
    #[test]
    fn an_edge_seeded_lineage_keeps_the_edge_in_the_step_history_not_the_edge_path() {
        let lineage = Lineage::seed_edges(&[4, 5]);

        assert_eq!(
            format!("{:?}", lineage.edges_at(0)),
            "[]",
            "the edge PATH stays empty for an edge-sourced lineage",
        );
        assert_eq!(lineage.edge_count_at(0), 0, "and so does the hop count");

        // The edge is not lost — it is the row's single step, tagged as an edge.
        let (vals, tags) = lineage.steps_at(0);

        assert_eq!(
            format!("{vals:?}"),
            "[Num(4.0)]",
            "the edge IS the step history"
        );
        assert_eq!(tags.len(), 1, "one step, tagged");
    }
}
