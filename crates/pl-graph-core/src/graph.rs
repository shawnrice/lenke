//! Mutable columnar LPG: dense u32 vertex indices, dictionary-encoded
//! labels/keys/edge-types, typed property columns (contiguous — SIMD-scannable),
//! and per-vertex adjacency lists.
//!
//! This is a **working** in-memory graph, not a build-once artifact: vertices
//! and edges can be added, relabelled, re-propertied, and deleted at runtime
//! (deletes leave tombstones; live counts are tracked). Bulk decode still builds
//! it in one pass; the SIMD CSR builder (`crate::build_csr`) and the contiguous
//! property columns the SIMD predicate scan reads are unchanged.
//!
//! Property model: a key's column is typed by its first non-null value
//! (Num=f64, Str=interned, Bool); a value that doesn't fit promotes the column
//! to a `Mixed` fallback so nothing is ever lost. Absent slots use a presence
//! bitset. Vertices and edges share the same [`Properties`] store type.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::error::{CodeError, CodeResult};
use crate::error_codes::ErrorCode;

/// String interner backed by `Arc<str>`: `intern` is amortized O(1), `text`
/// reverses, and `arc` hands out a cheap shared clone (refcount bump, no alloc).
/// The interned `Arc` flows column → `Val` → output `Value` as refcount bumps,
/// so a string property is never re-allocated end to end. `Arc` (not `Rc`) keeps
/// the graph `Send` — needed for the parallel ndjson decode and a shared
/// read-only graph on the server.
#[derive(Default, Debug)]
pub struct Dict {
    map: HashMap<Arc<str>, u32>,
    pub strings: Vec<Arc<str>>,
}

impl Dict {
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.map.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        let arc: Arc<str> = Arc::from(s);
        self.strings.push(arc.clone());
        self.map.insert(arc, id);
        id
    }
    pub fn get(&self, s: &str) -> Option<u32> {
        self.map.get(s).copied()
    }
    pub fn text(&self, id: u32) -> &str {
        &self.strings[id as usize]
    }
    /// A shared clone of the interned string (refcount bump, no allocation).
    pub fn arc(&self, id: u32) -> Arc<str> {
        self.strings[id as usize].clone()
    }
    pub fn len(&self) -> usize {
        self.strings.len()
    }
    pub fn is_empty(&self) -> bool {
        self.strings.is_empty()
    }
}

/// Compact presence bitset (1 bit/element). Auto-grows on `set`; `get` is
/// bounds-safe (a slot never written reads as absent), which is what lets the
/// property columns grow one element at a time under mutation.
#[derive(Debug, Clone, Default)]
pub struct BitSet {
    words: Vec<u64>,
}

impl BitSet {
    pub fn zeros(n: usize) -> Self {
        BitSet {
            words: vec![0u64; n.div_ceil(64)],
        }
    }
    #[inline]
    pub fn set(&mut self, i: usize) {
        let w = i >> 6;
        if w >= self.words.len() {
            self.words.resize(w + 1, 0);
        }
        self.words[w] |= 1u64 << (i & 63);
    }
    #[inline]
    pub fn clear(&mut self, i: usize) {
        if let Some(word) = self.words.get_mut(i >> 6) {
            *word &= !(1u64 << (i & 63));
        }
    }
    #[inline]
    pub fn get(&self, i: usize) -> bool {
        self.words
            .get(i >> 6)
            .is_some_and(|w| (w >> (i & 63)) & 1 == 1)
    }
}

/// A JSON-ish scalar/list value, matching the vendor-neutral LPG value model.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(Arc<str>),
    List(Vec<Value>),
}

/// A typed property column. Length == its store's element count.
#[derive(Debug)]
pub enum Column {
    /// Numbers as f64 (absent = NaN, also flagged in `present`).
    Num {
        data: Vec<f64>,
        present: BitSet,
    },
    /// Interned string ids (absent = u32::MAX).
    Str {
        data: Vec<u32>,
        present: BitSet,
    },
    Bool {
        data: Vec<bool>,
        present: BitSet,
    },
    /// Heterogeneous / list / mixed-type keys: keep the raw values.
    Mixed {
        data: Vec<Option<Value>>,
    },
}

impl Column {
    /// Append one absent slot (grows the column by one element).
    fn push_absent(&mut self) {
        match self {
            Column::Num { data, .. } => data.push(f64::NAN),
            Column::Str { data, .. } => data.push(u32::MAX),
            Column::Bool { data, .. } => data.push(false),
            Column::Mixed { data } => data.push(None),
        }
    }
    fn element_len(&self) -> usize {
        match self {
            Column::Num { data, .. } => data.len(),
            Column::Str { data, .. } => data.len(),
            Column::Bool { data, .. } => data.len(),
            Column::Mixed { data } => data.len(),
        }
    }
}

/// A columnar property store: typed columns keyed by property-key id, each of
/// length `len` elements. Vertices and edges use this **identically** — a
/// property is a property regardless of whether its element is a node or a
/// relationship. The graph holds two: one indexed by vertex, one by edge.
#[derive(Debug, Default)]
pub struct Properties {
    pub keys: Dict,
    /// Columns indexed by **dense key id** (`keys.intern` order), so a resolved
    /// id is an array index — no per-access hash. Every interned key has a column
    /// (an all-null key gets an empty `Mixed`).
    pub cols: Vec<Column>,
    /// Element count the columns are sized to (vertex count, or edge count).
    pub len: usize,
}

impl Properties {
    /// The column for `key`, if any.
    pub fn col(&self, key: &str) -> Option<&Column> {
        self.keys.get(key).map(|kid| &self.cols[kid as usize])
    }

    /// Value at element `idx` for `key` as a core [`Value`] (absent → `Null`).
    /// `strs` is the graph-wide interner backing `Column::Str`.
    pub fn value(&self, idx: usize, key: &str, strs: &Dict) -> Value {
        match self.keys.get(key) {
            Some(kid) => self.value_id(idx, kid, strs),
            None => Value::Null,
        }
    }

    /// Value at element `idx` for the already-resolved key id `kid` — the hot
    /// path: an array index, no hashing.
    pub fn value_id(&self, idx: usize, kid: u32, strs: &Dict) -> Value {
        match self.cols.get(kid as usize) {
            Some(Column::Num { data, present }) if present.get(idx) => Value::Num(data[idx]),
            Some(Column::Bool { data, present }) if present.get(idx) => Value::Bool(data[idx]),
            Some(Column::Str { data, present }) if present.get(idx) => {
                Value::Str(strs.arc(data[idx]))
            }
            Some(Column::Mixed { data }) => data[idx].clone().unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }

    /// Append one element slot (absent in every existing column).
    fn push_element(&mut self) {
        for col in &mut self.cols {
            col.push_absent();
        }
        self.len += 1;
    }

    /// Set element `idx`'s `key` to `v`, creating the column if needed and
    /// promoting it to `Mixed` if `v`'s type disagrees with the existing one.
    /// Setting `Null` removes the property (ISO `SET x.k = null`).
    pub fn set_value(&mut self, idx: usize, key: &str, v: Value, strs: &mut Dict) {
        if matches!(v, Value::Null) {
            self.remove_value(idx, key);
            return;
        }
        let kid = self.keys.intern(key) as usize;
        if kid >= self.cols.len() {
            // brand-new key: a column of `len` absent slots, then set below.
            self.cols.push(empty_col_for(&v, self.len));
        }
        let col = &mut self.cols[kid];
        if !col_set(col, idx, &v, strs) {
            // type mismatch — promote the column to Mixed, then set.
            *col = to_mixed(col, strs);
            col_set(col, idx, &v, strs);
        }
    }

    /// Remove element `idx`'s `key` (no-op if absent).
    pub fn remove_value(&mut self, idx: usize, key: &str) {
        if let Some(kid) = self.keys.get(key) {
            if let Some(col) = self.cols.get_mut(kid as usize) {
                match col {
                    Column::Num { present, .. }
                    | Column::Str { present, .. }
                    | Column::Bool { present, .. } => present.clear(idx),
                    Column::Mixed { data } => data[idx] = None,
                }
            }
        }
    }
}

/// One adjacency slot yielded while expanding a vertex: the edge's index, the
/// vertex on the other end, and the edge type id.
#[derive(Clone, Copy, Debug)]
pub struct Adj {
    pub eidx: u32,
    pub nbr: u32,
    pub etype: u32,
}

/// The mutable columnar graph.
pub struct Graph {
    /// Vertex slots (including tombstoned). Index space for queries is `0..n`.
    pub n: usize,
    live_n: usize,
    v_live: Vec<bool>,
    /// external string id <-> dense index
    pub vid: Dict,
    pub labels: Dict,
    pub etype: Dict,
    /// graph-wide string interner backing every `Column::Str` (vertex and edge)
    pub strs: Dict,
    /// per-vertex label ids
    vlabels: Vec<Vec<u32>>,
    /// inverted index: label id -> live vertices (query seeds)
    by_label: HashMap<u32, Vec<u32>>,
    /// vertex property columns (indexed by vertex)
    pub props: Properties,
    /// edge property columns (indexed by edge) — same store type as `props`
    pub edge_props: Properties,
    /// edges (parallel arrays); `e_live` tombstones deletions
    pub e_src: Vec<u32>,
    pub e_dst: Vec<u32>,
    pub e_type: Vec<u32>,
    /// inverted index: edge type id -> live edges. The edge analogue of
    /// `by_label`; seeds `()-[:T]->()` patterns from the type directly instead
    /// of scanning every edge. Always on (same as `by_label`), maintained by the
    /// edge mutations.
    by_etype: HashMap<u32, Vec<u32>>,
    /// Optional external edge ids — a **lazy** overlay so edges can round-trip a
    /// user-assigned string id. The dense edge index is the canonical identity;
    /// these maps are empty unless ids are supplied (codecs / `set_edge_id`), so
    /// the common in-memory path pays nothing. `eid_fwd`: edge index -> id (for
    /// encode); `eid_rev`: id -> edge index (for lookup / addressability).
    eid_fwd: HashMap<u32, Arc<str>>,
    eid_rev: HashMap<Arc<str>, u32>,
    /// Reactive change tracking (for `useSyncExternalStore`-style snapshots):
    /// `version` is a monotonic counter bumped on every mutation — an O(1)
    /// "did anything change?" signal. `epochs` is per-token (label / edge-type /
    /// property-key name) for *finer* invalidation: topology changes bump the
    /// element's labels/types and keys; a property write bumps only that key. So
    /// `epoch("Person")` moves iff Person membership changed, `epoch("age")` iff
    /// some age value changed. Keyed by name, so it's bounded by schema size.
    version: u64,
    epochs: HashMap<String, u64>,
    e_live: Vec<bool>,
    live_e: usize,
    /// per-vertex out / in adjacency (the mutable replacement for CSR)
    out: Vec<Vec<Adj>>,
    in_: Vec<Vec<Adj>>,
    /// counter for synthesized ids of vertices created at runtime
    synth: u64,
    /// Opt-in secondary indexes over vertex / edge property values: key name →
    /// ordered map (value → live element ids). A `BTreeMap` answers both equality
    /// (`get`) and range (`range`) from one structure. Keyed by name (not key-id)
    /// so an index can be declared and maintained even before any element carries
    /// the key. Built via [`Graph::create_vertex_index`]; kept current by the
    /// mutation methods. Absent key ⇒ no index (full scan).
    vidx: PropIndex,
    eidx: PropIndex,
}

/// A set of property indexes (key name → ordered value buckets).
type PropIndex = HashMap<String, std::collections::BTreeMap<IdxKey, Vec<u32>>>;

/// Add or remove element `id` from `map`'s bucket for `key`=`value`. No-op if the
/// key isn't indexed or the value isn't indexable (null/list).
fn idx_apply(map: &mut PropIndex, key: &str, id: u32, value: &Value, add: bool) {
    let Some(bt) = map.get_mut(key) else { return };
    let Some(k) = IdxKey::from_value(value) else {
        return;
    };
    if add {
        bt.entry(k).or_default().push(id);
    } else if let Some(bucket) = bt.get_mut(&k) {
        bucket.retain(|&x| x != id);
        if bucket.is_empty() {
            bt.remove(&k);
        }
    }
}

/// Backfill an index for `key` over a property store (vertex or edge).
fn build_prop_index(
    store: &Properties,
    live: &[bool],
    strs: &Dict,
    key: &str,
    n: usize,
) -> std::collections::BTreeMap<IdxKey, Vec<u32>> {
    let mut map: std::collections::BTreeMap<IdxKey, Vec<u32>> = std::collections::BTreeMap::new();
    let Some(kid) = store.keys.get(key) else {
        return map;
    };
    for id in 0..n as u32 {
        if !live.get(id as usize).copied().unwrap_or(false) {
            continue;
        }
        if let Some(k) = IdxKey::from_value(&store.value_id(id as usize, kid, strs)) {
            map.entry(k).or_default().push(id);
        }
    }
    map
}

/// Union the buckets of one key's ordered index that fall within `bound`. Bounds
/// carry a type (e.g. `Num(30)`), so the scan stays within that type block —
/// `{gt: 30}` never bleeds into string values.
fn range_seek(
    map: &std::collections::BTreeMap<IdxKey, Vec<u32>>,
    bound: &RangeBound,
) -> Option<Vec<u32>> {
    use std::ops::Bound;
    let lo = match (&bound.gte, &bound.gt) {
        (Some(k), _) => Bound::Included(k.clone()),
        (None, Some(k)) => Bound::Excluded(k.clone()),
        (None, None) => Bound::Unbounded,
    };
    let rank = [&bound.gt, &bound.gte, &bound.lt, &bound.lte]
        .into_iter()
        .flatten()
        .next()
        .map(IdxKey::rank);
    let mut out = Vec::new();
    for (k, ids) in map.range((lo, Bound::Unbounded)) {
        if let Some(r) = rank {
            if k.rank() < r {
                continue;
            }
            if k.rank() > r {
                break;
            }
        }
        if bound.lt.as_ref().is_some_and(|b| k >= b) || bound.lte.as_ref().is_some_and(|b| k > b) {
            break;
        }
        out.extend_from_slice(ids);
    }
    Some(out)
}

/// A totally-ordered key for the property index: type rank (Bool < Num < Str)
/// then value, so a numeric range seek never bleeds into string values.
#[derive(Clone, Debug)]
pub enum IdxKey {
    Bool(bool),
    Num(f64),
    Str(Arc<str>),
}

impl IdxKey {
    fn rank(&self) -> u8 {
        match self {
            IdxKey::Bool(_) => 0,
            IdxKey::Num(_) => 1,
            IdxKey::Str(_) => 2,
        }
    }
    /// Build from a core [`Value`] (absent / list → not indexable).
    fn from_value(v: &Value) -> Option<IdxKey> {
        match v {
            Value::Bool(b) => Some(IdxKey::Bool(*b)),
            Value::Num(n) => Some(IdxKey::Num(*n)),
            Value::Str(s) => Some(IdxKey::Str(s.clone())),
            _ => None,
        }
    }
}

impl PartialEq for IdxKey {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == std::cmp::Ordering::Equal
    }
}
impl Eq for IdxKey {}
impl PartialOrd for IdxKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for IdxKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (IdxKey::Bool(a), IdxKey::Bool(b)) => a.cmp(b),
            (IdxKey::Num(a), IdxKey::Num(b)) => a.total_cmp(b),
            (IdxKey::Str(a), IdxKey::Str(b)) => a.as_ref().cmp(b.as_ref()),
            _ => self.rank().cmp(&other.rank()),
        }
    }
}

/// Inclusive/exclusive range bounds for a property-index range seek.
#[derive(Clone, Debug, Default)]
pub struct RangeBound {
    pub gt: Option<IdxKey>,
    pub gte: Option<IdxKey>,
    pub lt: Option<IdxKey>,
    pub lte: Option<IdxKey>,
}

impl Graph {
    // --- reads -------------------------------------------------------------

    pub fn vertex_count(&self) -> usize {
        self.live_n
    }
    pub fn edge_count(&self) -> usize {
        self.live_e
    }
    /// Total edge slots (including tombstoned) — for encoders that scan them.
    pub fn edge_slots(&self) -> usize {
        self.e_src.len()
    }
    pub fn is_vertex_live(&self, v: u32) -> bool {
        self.v_live.get(v as usize).copied().unwrap_or(false)
    }
    pub fn is_edge_live(&self, e: u32) -> bool {
        self.e_live.get(e as usize).copied().unwrap_or(false)
    }
    /// Live vertex indices (skips tombstones) — the full candidate seed set.
    pub fn vertex_indices(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.n as u32).filter(move |&v| self.v_live[v as usize])
    }

    // --- property indexes (opt-in secondary indexes over property values) --

    /// Declare (and backfill) a secondary index over a **vertex** property. An
    /// eq/range filter on this key can then seed from the index instead of a full
    /// scan. Kept current by the mutation methods. Idempotent.
    pub fn create_vertex_index(&mut self, key: &str) {
        let map = build_prop_index(&self.props, &self.v_live, &self.strs, key, self.n);
        self.vidx.insert(key.to_string(), map);
    }
    /// Declare (and backfill) a secondary index over an **edge** property.
    pub fn create_edge_index(&mut self, key: &str) {
        let map = build_prop_index(
            &self.edge_props,
            &self.e_live,
            &self.strs,
            key,
            self.e_src.len(),
        );
        self.eidx.insert(key.to_string(), map);
    }
    /// Drop a vertex index.
    pub fn drop_vertex_index(&mut self, key: &str) {
        self.vidx.remove(key);
    }
    /// Drop an edge index.
    pub fn drop_edge_index(&mut self, key: &str) {
        self.eidx.remove(key);
    }

    pub fn vertex_indexed(&self, key: &str) -> bool {
        self.vidx.contains_key(key)
    }
    pub fn edge_indexed(&self, key: &str) -> bool {
        self.eidx.contains_key(key)
    }

    /// Equality seek over vertices: live vertices whose `key` == `value` (None = no index).
    pub fn vertices_by_prop(&self, key: &str, value: &IdxKey) -> Option<&[u32]> {
        Some(
            self.vidx
                .get(key)?
                .get(value)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )
    }
    /// Equality seek over edges.
    pub fn edges_by_prop(&self, key: &str, value: &IdxKey) -> Option<&[u32]> {
        Some(
            self.eidx
                .get(key)?
                .get(value)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        )
    }
    /// Cardinality of a vertex equality seek (for cardinality-based seed selection).
    pub fn count_by_prop(&self, key: &str, value: &IdxKey) -> Option<usize> {
        Some(self.vidx.get(key)?.get(value).map_or(0, Vec::len))
    }
    /// Range seek over vertices (union of buckets in `bound`, type-block bounded).
    pub fn vertices_by_prop_range(&self, key: &str, bound: &RangeBound) -> Option<Vec<u32>> {
        range_seek(self.vidx.get(key)?, bound)
    }
    /// Range seek over edges.
    pub fn edges_by_prop_range(&self, key: &str, bound: &RangeBound) -> Option<Vec<u32>> {
        range_seek(self.eidx.get(key)?, bound)
    }

    /// Out-edges of `v` as adjacency slots.
    pub fn out_adj(&self, v: u32) -> impl Iterator<Item = Adj> + '_ {
        self.out[v as usize].iter().copied()
    }
    /// In-edges of `v` as adjacency slots (the reverse index).
    pub fn in_adj(&self, v: u32) -> impl Iterator<Item = Adj> + '_ {
        self.in_[v as usize].iter().copied()
    }
    /// Out-neighbors of `v` whose edge type is `etype` (or all if `None`).
    pub fn out_neighbors(&self, v: u32, etype: Option<u32>) -> impl Iterator<Item = u32> + '_ {
        self.out[v as usize]
            .iter()
            .filter_map(move |a| match etype {
                Some(t) if a.etype != t => None,
                _ => Some(a.nbr),
            })
    }

    /// Labels carried by vertex `v`, as label ids.
    pub fn vertex_labels(&self, v: u32) -> &[u32] {
        &self.vlabels[v as usize]
    }
    /// Does vertex `v` carry label id `l`?
    pub fn has_label(&self, v: u32, l: u32) -> bool {
        self.vlabels[v as usize].contains(&l)
    }
    /// Live vertices carrying label `l`.
    pub fn vertices_with_label(&self, l: u32) -> &[u32] {
        self.by_label.get(&l).map_or(&[], |v| v.as_slice())
    }
    /// Live edges of type id `t` (the seed for `()-[:T]->()` patterns).
    pub fn edges_with_etype(&self, t: u32) -> &[u32] {
        self.by_etype.get(&t).map_or(&[], |e| e.as_slice())
    }
    /// Live edges of type `name`, or `None` if the type was never interned.
    pub fn edges_with_etype_name(&self, name: &str) -> Option<&[u32]> {
        self.etype.get(name).map(|t| self.edges_with_etype(t))
    }

    /// The external string id of edge `eidx`, if one was assigned (`None` ⇒ the
    /// edge is identified only by its index). Used by codecs to round-trip ids.
    pub fn edge_id(&self, eidx: u32) -> Option<&str> {
        self.eid_fwd.get(&eidx).map(|s| s.as_ref())
    }
    /// The edge carrying external id `id`, if any — the reverse of [`Graph::edge_id`].
    pub fn edge_by_id(&self, id: &str) -> Option<u32> {
        self.eid_rev.get(id).copied()
    }
    // --- reactive change tracking ----------------------------------------

    /// Monotonic mutation counter. An unchanged value means nothing has mutated
    /// since it was last read — the O(1) check a `getSnapshot` uses to return a
    /// referentially-stable snapshot.
    pub fn version(&self) -> u64 {
        self.version
    }
    /// Per-token change epoch for a label / edge-type / property-key `name`
    /// (0 if never touched). Lets a live query recompute only when one of its
    /// declared dependencies actually changed.
    pub fn epoch(&self, name: &str) -> u64 {
        self.epochs.get(name).copied().unwrap_or(0)
    }
    /// Bump the global version (called by every mutation).
    fn bump(&mut self) {
        self.version = self.version.wrapping_add(1);
    }
    /// Bump one token's epoch.
    fn touch(&mut self, name: &str) {
        *self.epochs.entry(name.to_string()).or_insert(0) += 1;
    }

    /// Assign (or replace) edge `eidx`'s external id. No-op for a dead edge.
    pub fn set_edge_id(&mut self, eidx: u32, id: &str) {
        if !self.is_edge_live(eidx) {
            return;
        }
        self.bump();
        // Drop any prior id for this edge (and its reverse entry) before re-binding.
        if let Some(old) = self.eid_fwd.remove(&eidx) {
            self.eid_rev.remove(&old);
        }
        let arc: Arc<str> = Arc::from(id);
        self.eid_fwd.insert(eidx, arc.clone());
        self.eid_rev.insert(arc, eidx);
    }

    // --- mutation ----------------------------------------------------------

    fn fresh_id(&mut self) -> String {
        loop {
            let id = format!("_n{}", self.synth);
            self.synth += 1;
            if self.vid.get(&id).is_none() {
                return id;
            }
        }
    }

    /// Add a vertex with the given labels and properties; returns its index.
    pub fn add_vertex(&mut self, labels: &[String], props: Vec<(String, Value)>) -> u32 {
        let id = self.fresh_id();
        let vi = self.vid.intern(&id);
        debug_assert_eq!(vi as usize, self.n);
        self.v_live.push(true);
        self.live_n += 1;
        let lids: Vec<u32> = labels.iter().map(|l| self.labels.intern(l)).collect();
        for &lid in &lids {
            self.by_label.entry(lid).or_default().push(vi);
        }
        self.vlabels.push(lids);
        self.out.push(Vec::new());
        self.in_.push(Vec::new());
        self.props.push_element();
        for (k, v) in props {
            if self.vidx.contains_key(&k) {
                idx_apply(&mut self.vidx, &k, vi, &v, true);
            }
            self.touch(&k);
            self.props.set_value(vi as usize, &k, v, &mut self.strs);
        }
        self.n += 1;
        // Topology change: bump the global version and the new vertex's labels.
        self.bump();
        for l in labels {
            self.touch(l);
        }
        vi
    }

    /// Add an edge `from -> to` of `etype` with properties; returns its index.
    pub fn add_edge(
        &mut self,
        from: u32,
        to: u32,
        etype: &str,
        props: Vec<(String, Value)>,
    ) -> u32 {
        let ei = self.e_src.len() as u32;
        let tid = self.etype.intern(etype);
        self.e_src.push(from);
        self.e_dst.push(to);
        self.e_type.push(tid);
        self.by_etype.entry(tid).or_default().push(ei);
        self.e_live.push(true);
        self.live_e += 1;
        self.out[from as usize].push(Adj {
            eidx: ei,
            nbr: to,
            etype: tid,
        });
        self.in_[to as usize].push(Adj {
            eidx: ei,
            nbr: from,
            etype: tid,
        });
        self.edge_props.push_element();
        for (k, v) in props {
            if self.eidx.contains_key(&k) {
                idx_apply(&mut self.eidx, &k, ei, &v, true);
            }
            self.touch(&k);
            self.edge_props
                .set_value(ei as usize, &k, v, &mut self.strs);
        }
        // Topology change: bump the global version and the new edge's type.
        self.bump();
        self.touch(etype);
        ei
    }

    pub fn set_vertex_prop(&mut self, vi: u32, key: &str, v: Value) {
        if self.vidx.contains_key(key) {
            let old = self.props.value(vi as usize, key, &self.strs);
            idx_apply(&mut self.vidx, key, vi, &old, false);
        }
        self.props.set_value(vi as usize, key, v, &mut self.strs);
        if self.vidx.contains_key(key) {
            let new = self.props.value(vi as usize, key, &self.strs);
            idx_apply(&mut self.vidx, key, vi, &new, true);
        }
        // Value change: bump only this key (not the element's labels), so a
        // label-only/topology query isn't invalidated by an unrelated edit.
        self.bump();
        self.touch(key);
    }
    pub fn remove_vertex_prop(&mut self, vi: u32, key: &str) {
        if self.vidx.contains_key(key) {
            let old = self.props.value(vi as usize, key, &self.strs);
            idx_apply(&mut self.vidx, key, vi, &old, false);
        }
        self.props.remove_value(vi as usize, key);
        self.bump();
        self.touch(key);
    }
    pub fn set_edge_prop(&mut self, ei: u32, key: &str, v: Value) {
        if self.eidx.contains_key(key) {
            let old = self.edge_props.value(ei as usize, key, &self.strs);
            idx_apply(&mut self.eidx, key, ei, &old, false);
        }
        self.edge_props
            .set_value(ei as usize, key, v, &mut self.strs);
        if self.eidx.contains_key(key) {
            let new = self.edge_props.value(ei as usize, key, &self.strs);
            idx_apply(&mut self.eidx, key, ei, &new, true);
        }
        self.bump();
        self.touch(key);
    }
    pub fn remove_edge_prop(&mut self, ei: u32, key: &str) {
        if self.eidx.contains_key(key) {
            let old = self.edge_props.value(ei as usize, key, &self.strs);
            idx_apply(&mut self.eidx, key, ei, &old, false);
        }
        self.edge_props.remove_value(ei as usize, key);
        self.bump();
        self.touch(key);
    }

    pub fn add_vertex_label(&mut self, vi: u32, name: &str) {
        let lid = self.labels.intern(name);
        if !self.vlabels[vi as usize].contains(&lid) {
            self.vlabels[vi as usize].push(lid);
            self.by_label.entry(lid).or_default().push(vi);
            self.bump();
            self.touch(name);
        }
    }
    pub fn remove_vertex_label(&mut self, vi: u32, name: &str) {
        if let Some(lid) = self.labels.get(name) {
            self.vlabels[vi as usize].retain(|&x| x != lid);
            if let Some(bucket) = self.by_label.get_mut(&lid) {
                bucket.retain(|&x| x != vi);
            }
            self.bump();
            self.touch(name);
        }
    }

    /// An edge carries a single type; relabelling replaces it (last wins).
    pub fn add_edge_label(&mut self, ei: u32, name: &str) {
        let tid = self.etype.intern(name);
        let i = ei as usize;
        // Move the edge between type buckets when its type actually changes.
        let old = self.e_type[i];
        if old != tid {
            if let Some(bucket) = self.by_etype.get_mut(&old) {
                bucket.retain(|&x| x != ei);
            }
            if self.is_edge_live(ei) {
                self.by_etype.entry(tid).or_default().push(ei);
            }
        }
        self.e_type[i] = tid;
        let (src, dst) = (self.e_src[i] as usize, self.e_dst[i] as usize);
        for a in self.out[src].iter_mut().filter(|a| a.eidx == ei) {
            a.etype = tid;
        }
        for a in self.in_[dst].iter_mut().filter(|a| a.eidx == ei) {
            a.etype = tid;
        }
        if old != tid {
            // Both the old and new type's membership changed.
            let old_name = self.etype.text(old).to_string();
            self.bump();
            self.touch(&old_name);
            self.touch(name);
        }
    }
    pub fn remove_edge_label(&mut self, ei: u32, _name: &str) {
        // Single-type edges: removing the label clears the type to empty.
        self.add_edge_label(ei, "");
    }

    /// Delete an edge (tombstone + unlink from both endpoints' adjacency).
    pub fn remove_edge(&mut self, ei: u32) {
        let i = ei as usize;
        if !self.is_edge_live(ei) {
            return;
        }
        // Drop the edge from every edge property index before tombstoning.
        if !self.eidx.is_empty() {
            for key in self.eidx.keys().cloned().collect::<Vec<_>>() {
                let val = self.edge_props.value(i, &key, &self.strs);
                idx_apply(&mut self.eidx, &key, ei, &val, false);
            }
        }
        // Invalidate the edge's type and every property key it carried.
        let mut touched: Vec<String> = vec![self.etype.text(self.e_type[i]).to_string()];
        for kid in 0..self.edge_props.cols.len() as u32 {
            if !matches!(self.edge_props.value_id(i, kid, &self.strs), Value::Null) {
                touched.push(self.edge_props.keys.text(kid).to_string());
            }
        }
        self.e_live[i] = false;
        self.live_e -= 1;
        if let Some(bucket) = self.by_etype.get_mut(&self.e_type[i]) {
            bucket.retain(|&x| x != ei);
        }
        // Drop any external id overlay for this edge.
        if let Some(old) = self.eid_fwd.remove(&ei) {
            self.eid_rev.remove(&old);
        }
        let (src, dst) = (self.e_src[i] as usize, self.e_dst[i] as usize);
        self.out[src].retain(|a| a.eidx != ei);
        self.in_[dst].retain(|a| a.eidx != ei);
        self.bump();
        for name in touched {
            self.touch(&name);
        }
    }

    /// Delete a vertex. Without `detach`, a vertex that still has edges is an
    /// error (ISO/Cypher semantics); with `detach`, incident edges go first.
    pub fn remove_vertex(&mut self, vi: u32, detach: bool) -> CodeResult<()> {
        let i = vi as usize;
        if !self.is_vertex_live(vi) {
            return Ok(());
        }
        let incident: Vec<u32> = self.out[i]
            .iter()
            .chain(self.in_[i].iter())
            .map(|a| a.eidx)
            .collect();
        if !detach && !incident.is_empty() {
            return Err(CodeError::new(
                ErrorCode::InvalidGraphOp,
                "cannot delete a vertex that still has relationships; use DETACH DELETE",
            ));
        }
        for ei in incident {
            self.remove_edge(ei);
        }
        // Invalidate the vertex's labels and every property key it carried
        // (gathered before the columns/labels are cleared below).
        let mut touched: Vec<String> = self.vlabels[i]
            .iter()
            .map(|&l| self.labels.text(l).to_string())
            .collect();
        for kid in 0..self.props.cols.len() as u32 {
            if !matches!(self.props.value_id(i, kid, &self.strs), Value::Null) {
                touched.push(self.props.keys.text(kid).to_string());
            }
        }
        for lid in self.vlabels[i].clone() {
            if let Some(bucket) = self.by_label.get_mut(&lid) {
                bucket.retain(|&x| x != vi);
            }
        }
        // Drop the vertex from every vertex property index.
        if !self.vidx.is_empty() {
            for key in self.vidx.keys().cloned().collect::<Vec<_>>() {
                let val = self.props.value(i, &key, &self.strs);
                idx_apply(&mut self.vidx, &key, vi, &val, false);
            }
        }
        self.vlabels[i].clear();
        self.out[i].clear();
        self.in_[i].clear();
        self.v_live[i] = false;
        self.live_n -= 1;
        self.bump();
        for name in touched {
            self.touch(&name);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Column construction / promotion helpers (shared by build + mutation).
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Num,
    Str,
    Bool,
    Mixed,
}

fn value_kind(v: &Value) -> Option<Kind> {
    match v {
        Value::Num(_) => Some(Kind::Num),
        Value::Str(_) => Some(Kind::Str),
        Value::Bool(_) => Some(Kind::Bool),
        Value::Null => None, // nulls don't determine a column's type
        Value::List(_) => Some(Kind::Mixed),
    }
}

/// A fresh, all-absent column sized to `len`, typed for a (non-null) value.
fn empty_col_for(v: &Value, len: usize) -> Column {
    match value_kind(v) {
        Some(Kind::Num) => Column::Num {
            data: vec![f64::NAN; len],
            present: BitSet::zeros(len),
        },
        Some(Kind::Str) => Column::Str {
            data: vec![u32::MAX; len],
            present: BitSet::zeros(len),
        },
        Some(Kind::Bool) => Column::Bool {
            data: vec![false; len],
            present: BitSet::zeros(len),
        },
        _ => Column::Mixed {
            data: vec![None; len],
        },
    }
}

/// Set element `idx` in a column; returns `false` if the value's type doesn't
/// fit the column (the caller then promotes to `Mixed`).
fn col_set(col: &mut Column, idx: usize, v: &Value, strs: &mut Dict) -> bool {
    match (col, v) {
        (Column::Num { data, present }, Value::Num(x)) => {
            data[idx] = *x;
            present.set(idx);
            true
        }
        (Column::Str { data, present }, Value::Str(s)) => {
            data[idx] = strs.intern(s);
            present.set(idx);
            true
        }
        (Column::Bool { data, present }, Value::Bool(b)) => {
            data[idx] = *b;
            present.set(idx);
            true
        }
        (Column::Mixed { data }, val) => {
            data[idx] = Some(val.clone());
            true
        }
        _ => false,
    }
}

/// Materialize any column into a `Mixed` column (loses no values).
fn to_mixed(col: &Column, strs: &Dict) -> Column {
    let len = col.element_len();
    let mut data: Vec<Option<Value>> = Vec::with_capacity(len);
    for i in 0..len {
        let v = match col {
            Column::Num { data, present } if present.get(i) => Some(Value::Num(data[i])),
            Column::Bool { data, present } if present.get(i) => Some(Value::Bool(data[i])),
            Column::Str { data, present } if present.get(i) => Some(Value::Str(strs.arc(data[i]))),
            Column::Mixed { data } => data[i].clone(),
            _ => None,
        };
        data.push(v);
    }
    Column::Mixed { data }
}

// ---------------------------------------------------------------------------
// Builder: accumulate node/edge records, then finalize into the columnar form.
// ---------------------------------------------------------------------------

pub struct NodeRec {
    pub id: String,
    pub labels: Vec<String>,
    pub props: Vec<(String, Value)>,
}

pub struct EdgeRec {
    pub src: String,
    pub dst: String,
    pub etype: String,
    pub props: Vec<(String, Value)>,
    /// Optional external string id. The dense edge index is the edge's canonical
    /// identity; this is an opt-in overlay (set by codecs that carry edge ids) so
    /// a user-assigned id survives a serialization round-trip. `None` ⇒ id-less.
    pub id: Option<String>,
}

#[derive(Default)]
pub struct Builder {
    pub nodes: Vec<NodeRec>,
    pub edges: Vec<EdgeRec>,
}

/// Build a typed property store for `len` elements from `(index, props)` items.
/// A key's column type is inferred from its first non-null value; values that
/// disagree land in `Mixed` (lossless). Shared by the vertex and edge builds.
fn build_props(len: usize, items: &[(usize, &[(String, Value)])], strs: &mut Dict) -> Properties {
    let mut props = Properties {
        keys: Dict::default(),
        cols: Vec::new(),
        len,
    };
    // Infer a kind per key (by dense key id) from its first non-null value.
    let mut kinds: HashMap<u32, Kind> = HashMap::new();
    for (_, item) in items {
        for (k, v) in *item {
            let kid = props.keys.intern(k);
            if let Some(vk) = value_kind(v) {
                kinds
                    .entry(kid)
                    .and_modify(|cur| {
                        if *cur != vk {
                            *cur = Kind::Mixed;
                        }
                    })
                    .or_insert(vk);
            }
        }
    }
    // One column per interned key (dense by id); an all-null key gets an empty Mixed.
    props.cols = (0..props.keys.len() as u32)
        .map(|kid| match kinds.get(&kid) {
            Some(Kind::Num) => Column::Num {
                data: vec![f64::NAN; len],
                present: BitSet::zeros(len),
            },
            Some(Kind::Str) => Column::Str {
                data: vec![u32::MAX; len],
                present: BitSet::zeros(len),
            },
            Some(Kind::Bool) => Column::Bool {
                data: vec![false; len],
                present: BitSet::zeros(len),
            },
            _ => Column::Mixed {
                data: vec![None; len],
            },
        })
        .collect();
    for (idx, item) in items {
        for (k, v) in *item {
            if !matches!(v, Value::Null) {
                let kid = props.keys.get(k).unwrap() as usize;
                let col = &mut props.cols[kid];
                if !col_set(col, *idx, v, strs) {
                    *col = to_mixed(col, strs);
                    col_set(col, *idx, v, strs);
                }
            }
        }
    }
    props
}

impl Builder {
    /// Like [`finalize`](Self::finalize), but enforces a **declared-nodes**
    /// contract: every edge endpoint must be a declared node. Returns
    /// `MissingVertex` instead of silently fabricating a phantom vertex (the
    /// lenient `finalize` behavior, kept for streaming NDJSON where endpoints are
    /// legitimately created on demand). The JSON document codecs (pg-json,
    /// graphson) use this so a dangling edge is an error, mirroring the TS codecs.
    pub fn finalize_strict(self) -> CodeResult<Graph> {
        let declared: HashSet<&str> = self.nodes.iter().map(|n| n.id.as_str()).collect();
        for e in &self.edges {
            let missing = if !declared.contains(e.src.as_str()) {
                Some(&e.src)
            } else if !declared.contains(e.dst.as_str()) {
                Some(&e.dst)
            } else {
                None
            };
            if let Some(id) = missing {
                return Err(CodeError::new(
                    ErrorCode::MissingVertex,
                    format!(
                        "edge references a non-existent vertex '{id}' (from='{}', to='{}')",
                        e.src, e.dst
                    ),
                ));
            }
        }
        Ok(self.finalize())
    }

    pub fn finalize(self) -> Graph {
        let Builder { nodes, edges } = self;
        let mut vid = Dict::default();

        // (1) Dense indices: declared nodes first (in order), then edge endpoints.
        for node in &nodes {
            vid.intern(&node.id);
        }
        for e in &edges {
            vid.intern(&e.src);
            vid.intern(&e.dst);
        }
        let n = vid.len();

        // (2) Labels: per-vertex list + inverted (label -> live vertices).
        let mut vlabels: Vec<Vec<u32>> = vec![Vec::new(); n];
        let mut labels = Dict::default();
        let mut by_label: HashMap<u32, Vec<u32>> = HashMap::new();
        for node in &nodes {
            let vi = vid.get(&node.id).unwrap();
            for l in &node.labels {
                let lid = labels.intern(l);
                vlabels[vi as usize].push(lid);
                by_label.entry(lid).or_default().push(vi);
            }
        }

        // (3) Vertex property columns. `strs` is graph-wide, shared with edges.
        let mut strs = Dict::default();
        let node_items: Vec<(usize, &[(String, Value)])> = nodes
            .iter()
            .map(|nd| (vid.get(&nd.id).unwrap() as usize, nd.props.as_slice()))
            .collect();
        let props = build_props(n, &node_items, &mut strs);

        // (4) Edges: parallel arrays + per-vertex out/in adjacency.
        let mut etype = Dict::default();
        let e = edges.len();
        let mut e_src = vec![0u32; e];
        let mut e_dst = vec![0u32; e];
        let mut e_type = vec![0u32; e];
        let mut out: Vec<Vec<Adj>> = vec![Vec::new(); n];
        let mut in_: Vec<Vec<Adj>> = vec![Vec::new(); n];
        let mut by_etype: HashMap<u32, Vec<u32>> = HashMap::new();
        // Lazy external-id overlay: only edges that carry an id land here.
        let mut eid_fwd: HashMap<u32, Arc<str>> = HashMap::new();
        let mut eid_rev: HashMap<Arc<str>, u32> = HashMap::new();
        for (i, ed) in edges.iter().enumerate() {
            let s = vid.get(&ed.src).unwrap();
            let d = vid.get(&ed.dst).unwrap();
            let t = etype.intern(&ed.etype);
            e_src[i] = s;
            e_dst[i] = d;
            e_type[i] = t;
            by_etype.entry(t).or_default().push(i as u32);
            out[s as usize].push(Adj {
                eidx: i as u32,
                nbr: d,
                etype: t,
            });
            in_[d as usize].push(Adj {
                eidx: i as u32,
                nbr: s,
                etype: t,
            });
            if let Some(id) = &ed.id {
                let arc: Arc<str> = Arc::from(id.as_str());
                eid_fwd.insert(i as u32, arc.clone());
                eid_rev.insert(arc, i as u32);
            }
        }

        // (5) Edge property columns — same machinery, indexed by edge index.
        let edge_items: Vec<(usize, &[(String, Value)])> = edges
            .iter()
            .enumerate()
            .map(|(i, ed)| (i, ed.props.as_slice()))
            .collect();
        let edge_props = build_props(e, &edge_items, &mut strs);

        Graph {
            n,
            live_n: n,
            v_live: vec![true; n],
            vid,
            labels,
            etype,
            strs,
            vlabels,
            by_label,
            props,
            edge_props,
            e_src,
            e_dst,
            e_type,
            by_etype,
            eid_fwd,
            eid_rev,
            version: 0,
            epochs: HashMap::new(),
            e_live: vec![true; e],
            live_e: e,
            out,
            in_,
            synth: 0,
            vidx: HashMap::new(),
            eidx: HashMap::new(),
        }
    }
}
