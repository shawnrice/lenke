//! Mutable columnar LPG: dense u32 vertex indices, dictionary-encoded
//! labels/keys/edge-types, typed contiguous property columns, and per-vertex
//! adjacency lists.
//!
//! This is a **working** in-memory graph, not a build-once artifact: vertices
//! and edges can be added, relabelled, re-propertied, and deleted at runtime
//! (deletes leave tombstones; live counts are tracked). Bulk decode builds it in
//! one pass. The property columns are contiguous so the GQL engine's vectorized
//! filter path (`gql::eval`) reads them without per-row `Val` boxing.
//!
//! Property model: a key's column is typed by its first non-null value
//! (Num=f64, Str=interned, Bool); a value that doesn't fit promotes the column
//! to a `Mixed` fallback so nothing is ever lost. Absent slots use a presence
//! bitset. `null` is a **first-class stored value** — present and distinct from
//! an absent slot (a stored null lives in a `Mixed` column as `Some(Null)`);
//! use [`Properties::is_present`] for presence, not "value == Null". Vertices
//! and edges share the same [`Properties`] store type.

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
        Self {
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
    /// An ISO temporal scalar (`DATE`/`LOCAL DATETIME`/`DURATION`). A stored
    /// property value, like Num/Str/Bool.
    Temporal(crate::temporal::Temporal),
    List(Vec<Self>),
    /// An ordered key→value object. NOT a stored property value (a property is
    /// only ever a scalar or list) — it appears only in query results, as the
    /// serialized form of a returned node/edge reference (`{id, labels,
    /// properties}`), so `RETURN n` yields something useful rather than a bare
    /// id. Keys are emitted sorted, for a deterministic, engine-agnostic shape.
    Map(Vec<(Arc<str>, Self)>),
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
            Self::Num { data, .. } => data.push(f64::NAN),
            Self::Str { data, .. } => data.push(u32::MAX),
            Self::Bool { data, .. } => data.push(false),
            Self::Mixed { data } => data.push(None),
        }
    }
    fn element_len(&self) -> usize {
        match self {
            Self::Num { data, .. } => data.len(),
            Self::Str { data, .. } => data.len(),
            Self::Bool { data, .. } => data.len(),
            Self::Mixed { data } => data.len(),
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

    /// Does element `idx` HAVE property `key` — regardless of whether its value
    /// is a stored `Null`? This is the true presence test. `value(...) == Null`
    /// is NOT presence: it's also true for an absent key, because `Null` is a
    /// first-class stored value here (see [`set_value`](Self::set_value)) that a
    /// read cannot distinguish from absence. Enumeration/serialization must gate
    /// on this, not on the value.
    pub fn is_present(&self, idx: usize, key: &str) -> bool {
        self.keys
            .get(key)
            .is_some_and(|kid| self.is_present_id(idx, kid))
    }

    /// [`is_present`](Self::is_present) for an already-resolved key id.
    pub fn is_present_id(&self, idx: usize, kid: u32) -> bool {
        match self.cols.get(kid as usize) {
            Some(
                Column::Num { present, .. }
                | Column::Str { present, .. }
                | Column::Bool { present, .. },
            ) => present.get(idx),
            Some(Column::Mixed { data }) => data[idx].is_some(),
            None => false,
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
    ///
    /// `Null` is a FIRST-CLASS stored value: `set_value(idx, key, Null)` stores a
    /// *present* null (promoting the column to `Mixed`) — it does NOT remove the
    /// property. A stored null and an absent key are distinct (`is_present`
    /// tells them apart), though both read back as `Null` and are `IS NULL`
    /// (SQL/GQL three-valued logic). Removal is explicit: [`remove_value`], GQL
    /// `REMOVE`, or Gremlin `.properties(k).drop()`. This mirrors the TS engine
    /// and GQL's null-typed value model — and is a deliberate divergence from
    /// Cypher/TinkerPop, where `SET x = null` (and null property values) mean
    /// removal.
    pub fn set_value(&mut self, idx: usize, key: &str, v: Value, strs: &mut Dict) {
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
    /// UNIQUE constraints over vertex properties: label name → the sorted
    /// property keys that must be unique among live vertices carrying that label.
    /// Each constrained key is index-backed (declaring the constraint creates the
    /// vertex index), so enforcement and `_MERGE` key lookups seek rather than
    /// scan. Null/list values are exempt (SQL semantics — NULLs are distinct),
    /// which also matches what the value index can hold. See
    /// `docs/design/gql-extensions.md` §3.
    v_unique: HashMap<String, Vec<String>>,
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
            Self::Bool(_) => 0,
            Self::Num(_) => 1,
            Self::Str(_) => 2,
        }
    }
    /// Build from a core [`Value`] (absent / list → not indexable).
    fn from_value(v: &Value) -> Option<Self> {
        match v {
            Value::Bool(b) => Some(Self::Bool(*b)),
            Value::Num(n) => Some(Self::Num(*n)),
            Value::Str(s) => Some(Self::Str(s.clone())),
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
            (Self::Bool(a), Self::Bool(b)) => a.cmp(b),
            (Self::Num(a), Self::Num(b)) => a.total_cmp(b),
            (Self::Str(a), Self::Str(b)) => a.as_ref().cmp(b.as_ref()),
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

    /// The first live edge of type `etype` from `from` to `to`, if any — the
    /// structural key `_MERGE`'s edge form upserts on (ensures at most one such
    /// edge). First-by-adjacency-order, matching the TS engine.
    pub fn find_edge(&self, from: u32, to: u32, etype: &str) -> Option<u32> {
        let tid = self.etype.get(etype)?;
        self.out.get(from as usize)?.iter().find_map(|a| {
            (a.nbr == to && a.etype == tid && self.e_live[a.eidx as usize]).then_some(a.eidx)
        })
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

    /// The vertex property keys that currently carry a secondary index, sorted
    /// for a deterministic listing.
    pub fn vertex_indexes(&self) -> Vec<String> {
        let mut ks: Vec<String> = self.vidx.keys().cloned().collect();
        ks.sort();
        ks
    }
    /// The edge property keys that currently carry a secondary index, sorted.
    pub fn edge_indexes(&self) -> Vec<String> {
        let mut ks: Vec<String> = self.eidx.keys().cloned().collect();
        ks.sort();
        ks
    }

    // --- unique constraints (declared over `(label, property key)`) ---------
    // At most one live vertex carrying `label` may hold a given non-null value
    // for `key`. Backed by the vertex property index (so lookups seek). This is
    // the Pattern-B primitive `_MERGE` keys on; see `docs/design/gql-extensions.md`.

    /// Declare a UNIQUE constraint on `(label, key)`. Creates the backing vertex
    /// index if absent, then registers the constraint. Idempotent. Fails with
    /// [`ErrorCode::ConstraintViolation`] if the *current* data already violates
    /// it — an already-broken constraint is meaningless (SQL rejects the unique
    /// index build the same way).
    pub fn create_unique_constraint(&mut self, label: &str, key: &str) -> CodeResult<()> {
        if !self.vertex_indexed(key) {
            self.create_vertex_index(key);
        }
        if self.first_label_prop_duplicate(label, key).is_some() {
            return Err(CodeError::new(
                ErrorCode::ConstraintViolation,
                "existing data already violates the unique constraint being declared",
            ));
        }
        let keys = self.v_unique.entry(label.to_string()).or_default();
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
            keys.sort();
        }
        Ok(())
    }

    /// Drop a unique constraint. The backing index is left in place (drop it via
    /// [`Graph::drop_vertex_index`] if unwanted). Idempotent.
    pub fn drop_unique_constraint(&mut self, label: &str, key: &str) {
        if let Some(keys) = self.v_unique.get_mut(label) {
            keys.retain(|k| k != key);
            if keys.is_empty() {
                self.v_unique.remove(label);
            }
        }
    }

    /// Property keys under a unique constraint for `label` (sorted; empty if
    /// none). `_MERGE` intersects this with the pattern to infer the conflict key.
    pub fn unique_keys(&self, label: &str) -> &[String] {
        self.v_unique.get(label).map_or(&[], Vec::as_slice)
    }

    /// True iff `(label, key)` carries a unique constraint.
    pub fn has_unique_constraint(&self, label: &str, key: &str) -> bool {
        self.v_unique
            .get(label)
            .is_some_and(|ks| ks.iter().any(|k| k == key))
    }

    /// Every declared unique constraint as sorted `(label, key)` pairs — a
    /// deterministic listing for host introspection.
    pub fn unique_constraints(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .v_unique
            .iter()
            .flat_map(|(l, ks)| ks.iter().map(move |k| (l.clone(), k.clone())))
            .collect();
        out.sort();
        out
    }

    /// The single live vertex carrying `label` whose `key == value`, if any (≤1
    /// under the constraint). The `_MERGE` create-vs-update decision. A non-null
    /// scalar `value` seeks the index; null/list yield `None` (exempt).
    pub fn unique_lookup(&self, label: &str, key: &str, value: &Value) -> Option<u32> {
        self.vertices_with_label_value(label, key, value)
            .into_iter()
            .next()
    }

    /// If adding a vertex with `labels` + `props` would break a unique constraint,
    /// the offending `(label, key, existing vertex)`. Drives INSERT enforcement;
    /// `exclude` skips one vertex (itself, for a re-check). Only constrained keys
    /// present in `props` are checked; null/list values are exempt.
    pub fn unique_conflict(
        &self,
        labels: &[String],
        props: &[(String, Value)],
        exclude: Option<u32>,
    ) -> Option<(String, String, u32)> {
        for label in labels {
            for key in self.unique_keys(label) {
                let Some((_, value)) = props.iter().find(|(k, _)| k == key) else {
                    continue;
                };
                let hit = self
                    .vertices_with_label_value(label, key, value)
                    .into_iter()
                    .find(|&v| Some(v) != exclude);
                if let Some(existing) = hit {
                    return Some((label.clone(), key.clone(), existing));
                }
            }
        }
        None
    }

    /// If setting `vi.key = value` would break a unique constraint on one of
    /// `vi`'s labels, the offending `(label, existing vertex)`.
    pub fn unique_conflict_on_set(
        &self,
        vi: u32,
        key: &str,
        value: &Value,
    ) -> Option<(String, u32)> {
        for (label, keys) in &self.v_unique {
            if !keys.iter().any(|k| k == key) {
                continue;
            }
            let Some(lid) = self.labels.get(label) else {
                continue;
            };
            if !self.vlabels[vi as usize].contains(&lid) {
                continue;
            }
            if let Some(existing) = self
                .vertices_with_label_value(label, key, value)
                .into_iter()
                .find(|&v| v != vi)
            {
                return Some((label.clone(), existing));
            }
        }
        None
    }

    /// Live vertices carrying `label` whose property `key == value`. Seeks the
    /// backing index (a constraint always creates one), falling back to a scan if
    /// somehow unindexed. Non-indexable values (null/list) yield an empty set —
    /// exempt from uniqueness (SQL: NULLs distinct), matching the value index.
    fn vertices_with_label_value(&self, label: &str, key: &str, value: &Value) -> Vec<u32> {
        let Some(idxk) = IdxKey::from_value(value) else {
            return Vec::new();
        };
        let Some(lid) = self.labels.get(label) else {
            return Vec::new();
        };
        match self.vertices_by_prop(key, &idxk) {
            Some(ids) => ids
                .iter()
                .copied()
                .filter(|&v| self.vlabels[v as usize].contains(&lid))
                .collect(),
            None => self
                .vertex_indices()
                .filter(|&v| {
                    self.vlabels[v as usize].contains(&lid)
                        && self.props.value(v as usize, key, &self.strs) == *value
                })
                .collect(),
        }
    }

    /// The first pair of live `label`-vertices that share a value for `key` — for
    /// validating a unique constraint against existing data at declare time.
    /// Reuses the (freshly built) backing index; null/list values are exempt.
    fn first_label_prop_duplicate(&self, label: &str, key: &str) -> Option<(u32, u32)> {
        let lid = self.labels.get(label)?;
        let bt = self.vidx.get(key)?;
        for ids in bt.values() {
            let mut with_label = ids
                .iter()
                .copied()
                .filter(|&v| self.vlabels[v as usize].contains(&lid));
            if let (Some(a), Some(b)) = (with_label.next(), with_label.next()) {
                return Some((a, b));
            }
        }
        None
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

    /// The id of edge `eidx`: its assigned external id, or — since every edge has
    /// an id — the canonical `e{index}` derived from its dense index. The
    /// synthetic id is computed on demand, so the id overlay stays lazy and the
    /// load path pays nothing. Used by codecs (which always emit it) and the
    /// engines' `id()` step.
    pub fn edge_id(&self, eidx: u32) -> std::borrow::Cow<'_, str> {
        match self.eid_fwd.get(&eidx) {
            Some(s) => std::borrow::Cow::Borrowed(s.as_ref()),
            None => std::borrow::Cow::Owned(format!("e{eidx}")),
        }
    }
    /// The edge carrying id `id` — the reverse of [`Graph::edge_id`]. Resolves an
    /// assigned external id first, then the canonical `e{index}` form of a live,
    /// id-less edge (an explicit id shadows a colliding `e{n}`).
    pub fn edge_by_id(&self, id: &str) -> Option<u32> {
        if let Some(&e) = self.eid_rev.get(id) {
            return Some(e);
        }
        let n: u32 = id.strip_prefix('e')?.parse().ok()?;
        self.is_edge_live(n).then_some(n)
    }

    /// The dense index of the vertex with external `id`, or `None`. Non-mutating
    /// (unlike `vid.intern`) — used to detect id clashes on bulk append.
    pub fn vertex_by_id(&self, id: &str) -> Option<u32> {
        self.vid.get(id)
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
    /// Reject a graph holding a malformed label / edge type / property key (see
    /// [`validate_label`] / [`validate_prop_key`]). One cheap pass over the
    /// interned name dictionaries (distinct names, not per-element). Called at
    /// the codec ingestion boundary so loaded data can't smuggle in a name that
    /// won't round-trip through every codec.
    pub fn validate_wellformed(&self) -> CodeResult<()> {
        for name in self.labels.strings.iter().chain(self.etype.strings.iter()) {
            validate_label(name)?;
        }
        for name in self
            .props
            .keys
            .strings
            .iter()
            .chain(self.edge_props.keys.strings.iter())
        {
            validate_prop_key(name)?;
        }
        Ok(())
    }

    pub fn add_vertex(&mut self, labels: &[String], props: Vec<(String, Value)>) -> u32 {
        let id = self.fresh_id();
        self.add_vertex_with_id(&id, labels, props)
    }

    /// Append a vertex carrying an **explicit** external id (vs `add_vertex`,
    /// which mints one). The id must be fresh — a caller that might collide
    /// checks `vid.get(id)` first (bulk append / merge does). The building block
    /// for id-preserving bulk ingest into a live graph.
    pub fn add_vertex_with_id(
        &mut self,
        id: &str,
        labels: &[String],
        props: Vec<(String, Value)>,
    ) -> u32 {
        let vi = self.vid.intern(id);
        debug_assert_eq!(vi as usize, self.n, "add_vertex_with_id expects a fresh id");
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
            // Presence, not value: a stored-null key is present and its epoch
            // must still be bumped on delete.
            if self.edge_props.is_present_id(i, kid) {
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
            // Presence, not value (stored null is present) — see remove_edge.
            if self.props.is_present_id(i, kid) {
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
        // Temporals live in a Mixed (boxed-Value) column for now — no dedicated
        // typed column (that's a later perf phase alongside the temporal index).
        Value::Temporal(_) => Some(Kind::Mixed),
        Value::List(_) => Some(Kind::Mixed),
        Value::Map(_) => {
            unreachable!("Value::Map is a query-result value, never a stored property")
        }
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
            // Store every value, `Null` included — a present null promotes the
            // column to `Mixed` (mirrors `set_value`; null is a first-class value).
            let kid = props.keys.get(k).unwrap() as usize;
            let col = &mut props.cols[kid];
            if !col_set(col, *idx, v, strs) {
                *col = to_mixed(col, strs);
                col_set(col, *idx, v, strs);
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
        let Self { nodes, edges } = self;
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

        // Duplicate-id semantics, matching the TS core's idempotent add: a node
        // id is **first-wins** (later records with the same id are ignored), and
        // an edge with an already-seen *assigned* id is **dropped** (its endpoints
        // are still interned above, as TS ensures them before the dedup check).
        // Borrowed-`&str` sets keep this allocation-free on the common path.
        let keep_node: Vec<bool> = {
            let mut seen: HashSet<&str> = HashSet::with_capacity(nodes.len());
            nodes.iter().map(|nd| seen.insert(nd.id.as_str())).collect()
        };
        let kept_edges: Vec<&EdgeRec> = {
            let mut seen: HashSet<&str> = HashSet::with_capacity(edges.len());
            edges
                .iter()
                .filter(|e| match &e.id {
                    Some(id) => seen.insert(id.as_str()),
                    None => true, // id-less edges get a unique e{index}; never dup
                })
                .collect()
        };

        // (2) Labels: per-vertex list + inverted (label -> live vertices).
        let mut vlabels: Vec<Vec<u32>> = vec![Vec::new(); n];
        let mut labels = Dict::default();
        let mut by_label: HashMap<u32, Vec<u32>> = HashMap::new();
        for (idx, node) in nodes.iter().enumerate() {
            if !keep_node[idx] {
                continue; // first-wins: ignore a duplicate node id's labels
            }
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
            .enumerate()
            .filter(|(idx, _)| keep_node[*idx])
            .map(|(_, nd)| (vid.get(&nd.id).unwrap() as usize, nd.props.as_slice()))
            .collect();
        let props = build_props(n, &node_items, &mut strs);

        // (4) Edges: parallel arrays + per-vertex out/in adjacency.
        let mut etype = Dict::default();
        let e = kept_edges.len();
        let mut e_src = vec![0u32; e];
        let mut e_dst = vec![0u32; e];
        let mut e_type = vec![0u32; e];
        let mut out: Vec<Vec<Adj>> = vec![Vec::new(); n];
        let mut in_: Vec<Vec<Adj>> = vec![Vec::new(); n];
        let mut by_etype: HashMap<u32, Vec<u32>> = HashMap::new();
        // Lazy external-id overlay: only edges that carry an id land here.
        let mut eid_fwd: HashMap<u32, Arc<str>> = HashMap::new();
        let mut eid_rev: HashMap<Arc<str>, u32> = HashMap::new();
        for (i, ed) in kept_edges.iter().enumerate() {
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
        let edge_items: Vec<(usize, &[(String, Value)])> = kept_edges
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
            v_unique: HashMap::new(),
        }
    }
}

/// A **well-formed label** (node label or edge type): non-empty and free of the
/// `::` sequence. GraphSON joins a node's labels with `::`, so a `::` inside one
/// label is ambiguous/unrepresentable there (and bare GQL can't name it either).
/// An empty label collapses to "no labels" in GraphSON/CSV. Constraining the
/// model to well-formed labels keeps every codec's round-trip unambiguous.
pub fn validate_label(name: &str) -> CodeResult<()> {
    if name.is_empty() {
        return Err(CodeError::new(
            ErrorCode::InvalidValue,
            "a label / edge type must be non-empty",
        ));
    }
    if name.contains("::") {
        return Err(CodeError::new(
            ErrorCode::InvalidValue,
            format!("a label / edge type cannot contain '::' (the GraphSON multi-label separator): {name:?}"),
        ));
    }
    Ok(())
}

/// A **well-formed property key**: non-empty (an empty key has no CSV column
/// header / no `key:value` pg-text form, and is meaningless).
pub fn validate_prop_key(name: &str) -> CodeResult<()> {
    if name.is_empty() {
        return Err(CodeError::new(
            ErrorCode::InvalidValue,
            "a property key must be non-empty",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod wellformed_names {
    //! Labels/edge-types must be non-empty and `::`-free (GraphSON's multi-label
    //! separator); property keys must be non-empty. Enforced at ingestion.
    use super::*;

    #[test]
    fn label_rules() {
        assert!(validate_label("Person").is_ok());
        assert!(validate_label("a:b").is_ok()); // a single colon is fine
        assert!(validate_label("").is_err()); // empty collapses to "no labels"
        assert!(validate_label("a::b").is_err()); // GraphSON multi-label separator
        assert!(validate_label("::").is_err());
    }

    #[test]
    fn key_rules() {
        assert!(validate_prop_key("name").is_ok());
        assert!(validate_prop_key("a::b").is_ok()); // keys are never `::`-joined
        assert!(validate_prop_key("").is_err());
    }
}

#[cfg(test)]
mod null_is_first_class {
    //! `null` is a stored, present property value — NOT sugar for removal. These
    //! lock in the semantics `set_value`/`is_present`/`remove_value` agree on,
    //! and guard against a regression back to the old "SET null removes" model
    //! (a deliberate divergence from Cypher/TinkerPop).
    use super::*;

    fn props(len: usize) -> Properties {
        let mut p = Properties::default();
        for _ in 0..len {
            p.push_element();
        }
        p
    }

    #[test]
    fn a_stored_null_is_present_and_distinct_from_absent() {
        let mut strs = Dict::default();
        let mut p = props(2);
        p.set_value(0, "k", Value::Null, &mut strs); // row 0: present null; row 1: untouched

        assert!(p.is_present(0, "k"), "a stored null is present");
        assert!(
            matches!(p.value(0, "k", &strs), Value::Null),
            "and reads back as Null"
        );
        assert!(!p.is_present(1, "k"), "an unset key is absent");
        assert!(
            matches!(p.value(1, "k", &strs), Value::Null),
            "absent also reads as Null"
        );
    }

    #[test]
    fn setting_null_stores_it_without_disturbing_a_typed_column() {
        // A Num key set to null on another row keeps both — the column promotes
        // to Mixed rather than the null vanishing.
        let mut strs = Dict::default();
        let mut p = props(2);
        p.set_value(0, "k", Value::Num(5.0), &mut strs);
        p.set_value(1, "k", Value::Null, &mut strs);

        assert!(matches!(p.value(0, "k", &strs), Value::Num(n) if n == 5.0));
        assert!(p.is_present(1, "k"));
        assert!(matches!(p.value(1, "k", &strs), Value::Null));
    }

    #[test]
    fn remove_value_deletes_even_a_stored_null() {
        let mut strs = Dict::default();
        let mut p = props(1);
        p.set_value(0, "k", Value::Null, &mut strs);
        assert!(p.is_present(0, "k"));

        p.remove_value(0, "k"); // explicit removal is the ONLY way to unset it
        assert!(!p.is_present(0, "k"));
    }
}
