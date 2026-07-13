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

/// The scalar type a TYPE constraint (R-CONSTRAINTS) can require of a property
/// value. Mirrors the TS `ScalarTypeName`; `number` maps to `Num` (the f64 model
/// has no integer/float split), `list` is "an array" (elements unconstrained).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PropType {
    Str,
    Num,
    Bool,
    Date,
    DateTime,
    Duration,
    List,
}

impl PropType {
    fn from_name(s: &str) -> Option<Self> {
        match s {
            "string" => Some(Self::Str),
            "number" => Some(Self::Num),
            "boolean" => Some(Self::Bool),
            "date" => Some(Self::Date),
            "datetime" => Some(Self::DateTime),
            "duration" => Some(Self::Duration),
            "list" => Some(Self::List),
            _ => None,
        }
    }
}

/// The scalar type of a stored value, or `None` for null / a non-stored `Map`
/// (both type-exempt — a null has no type).
fn value_type(v: &Value) -> Option<PropType> {
    use crate::temporal::Temporal;
    match v {
        Value::Null | Value::Map(_) => None,
        Value::Bool(_) => Some(PropType::Bool),
        Value::Num(_) => Some(PropType::Num),
        Value::Str(_) => Some(PropType::Str),
        Value::Temporal(Temporal::Date(_)) => Some(PropType::Date),
        Value::Temporal(Temporal::DateTime(_)) => Some(PropType::DateTime),
        Value::Temporal(Temporal::Duration(_)) => Some(PropType::Duration),
        Value::List(_) => Some(PropType::List),
    }
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
    /// REQUIRED constraints: `label` → the property keys that must be present and
    /// non-null on every live vertex carrying that label (R-CONSTRAINTS). Unlike
    /// `v_unique` these need no backing index — enforcement is a presence check.
    v_required: HashMap<String, Vec<String>>,
    /// TYPE constraints: `label` → (`key` → the scalar type its present, non-null
    /// values must be). Null/absent are exempt (R-CONSTRAINTS).
    v_type: HashMap<String, HashMap<String, PropType>>,
    /// UNIQUE constraints over **edge** properties: edge-type name → the sorted
    /// property keys that must be unique among live edges of that type. The edge
    /// analogue of `v_unique`, backed by the edge property index (`eidx`).
    e_unique: HashMap<String, Vec<String>>,
    /// REQUIRED constraints over edges: edge-type → the keys that must be present
    /// and non-null on every live edge of that type. The edge analogue of `v_required`.
    e_required: HashMap<String, Vec<String>>,
    /// TYPE constraints over edges: edge-type → (`key` → scalar type). The edge
    /// analogue of `v_type` (named `e_type_constraints` because `e_type: Vec<u32>`
    /// already holds the per-edge type ids).
    e_type_constraints: HashMap<String, HashMap<String, PropType>>,
    /// CARDINALITY constraints: bound the DEGREE of every vertex carrying `label`
    /// over `etype` in `direction` (0 = out / the vertex is the edge source, 1 =
    /// in / the target) to `min..=max` (`max: None` unbounded). A small flat list
    /// (schema-sized), searched linearly; keyed by `(label, etype, direction)` for
    /// declare-replace and drop. Max is checked at commit against touched
    /// endpoints; min is commit-time only (unsatisfiable by a single write). A
    /// self-loop counts once for out and once for in. See `docs/design/r-tx.md`.
    v_cardinality: Vec<CardinalityRule>,
    /// VALIDATOR constraints: a custom GQL boolean predicate per label (a vertex
    /// label OR an edge type — one string namespace). Every element carrying the
    /// label must satisfy the predicate at the mutation boundary; SQL-`CHECK`
    /// semantics — rejected only on a *definite* `false`, a null/unknown result
    /// passes. Keyed by label; a label may carry several. The predicate is parsed
    /// and lowered once at declare time (into a `CPredicate`) and evaluated in the
    /// GQL evaluator against each touched element at the commit boundary and in the
    /// declare-time scan. Byte-identical with the TS `createValidator`.
    v_validators: HashMap<String, Vec<ValidatorRule>>,
    /// Graph-level INVARIANTS (cross-write assertions): a whole-graph GQL query
    /// that must hold after every transaction that wrote something. Unlike a
    /// per-element validator, an invariant is evaluated ONCE per commit against
    /// the fully-staged graph — it is VIOLATED iff any cell in its result set is
    /// boolean `false` (everything else — `true`/`null`/non-boolean/empty — holds).
    /// Each entry stores the query source (for messaging/introspection) and the
    /// query parsed+lowered once at declare time. Byte-identical with the TS
    /// `createInvariant`. Keyed insertion order is irrelevant; `invariants()`
    /// sorts by name.
    v_invariants: Vec<InvariantRule>,
    /// Transaction state (R-TX). `tx_depth > 0` means an open transaction: writes
    /// still apply eagerly to the live store (read-your-writes with no overlay),
    /// but each mutation records an inverse op in `tx_undo`, the built-in
    /// constraint checks defer to commit (the touched vertex ids collect in
    /// `tx_touched`), and a rollback replays the undo log newest-first. Nesting is
    /// flat (a depth counter): the outermost frame owns commit/rollback, matching
    /// the TS core. `applying_undo` is true only while a rollback replays inverse
    /// ops, which must neither re-record undo nor re-note touched vertices. The
    /// undo `Vec` allocates lazily (empty until the first in-tx mutation), so an
    /// auto-commit frame around a read-only statement costs nothing.
    tx_depth: usize,
    tx_undo: Vec<Undo>,
    tx_touched: Vec<u32>,
    /// Edge analogue of `tx_touched`: edge indices whose built-in edge constraints
    /// must be re-checked at commit (R-TX deferral for edge writes).
    tx_touched_edges: Vec<u32>,
    applying_undo: bool,
    /// Access mode of the active explicit transaction opened by ISO GQL
    /// `START TRANSACTION READ ONLY` (see the gql eval layer). Set true by that
    /// statement, cleared on commit/rollback. Only the GQL statement executor reads
    /// it — the core mutators are access-mode agnostic; a read-only write is
    /// rejected at the statement boundary before any mutation applies.
    tx_read_only: bool,
}

/// One inverse op recorded by a mutation while a transaction frame is open, to be
/// replayed (newest-first) on rollback. The tombstone-based delete model makes
/// these cheap: undo of an insert = tombstone the slot; undo of a delete =
/// un-tombstone it (the columns are never cleared on delete, so property values
/// survive in place); undo of a property write = restore the prior columnar value.
enum Undo {
    /// An inserted vertex — undo by tombstoning it (`remove_vertex`, detach).
    InsertVertex(u32),
    /// An inserted edge — undo by tombstoning it (`remove_edge`).
    InsertEdge(u32),
    /// A vertex property write — restore the prior value (`Some`) or absence (`None`).
    VProp(u32, String, Option<Value>),
    /// An edge property write — restore the prior value (`Some`) or absence (`None`).
    EProp(u32, String, Option<Value>),
    /// A label newly added to a vertex — undo by removing it.
    VLabelAdd(u32, String),
    /// A label removed from a vertex — undo by re-adding it.
    VLabelRemove(u32, String),
    /// An edge type replaced (edges carry a single type) — restore the prior type name.
    EType(u32, String),
    /// A deleted vertex — undo by un-tombstoning the slot and restoring its labels
    /// (its incident edges are restored by their own `DeleteEdge` inverses, which
    /// were recorded during the delete cascade and so replay after this one).
    DeleteVertex { vi: u32, labels: Vec<u32> },
    /// A deleted edge — undo by un-tombstoning it and restoring any external-id overlay.
    DeleteEdge { ei: u32, eid: Option<Arc<str>> },
}

/// A declared CARDINALITY constraint: every live vertex carrying `label` must
/// have `min <= degree <= max` over `etype` in `direction` (0 = out, 1 = in).
/// `max: None` is unbounded. The Rust analogue of the TS `CardinalityConstraint`.
#[derive(Clone, Debug)]
struct CardinalityRule {
    label: String,
    etype: String,
    direction: u8,
    min: u32,
    max: Option<u32>,
}

/// A registered VALIDATOR: its bind variable name, its GQL predicate source (for
/// messaging / introspection), and the predicate parsed+lowered once at declare
/// time. The Rust analogue of the TS `{ varName, src, fn }` validator entry.
struct ValidatorRule {
    var: String,
    src: String,
    pred: crate::gql::plan::CPredicate,
}

/// A registered graph-level INVARIANT: its name, its GQL query source (for
/// messaging / introspection), and the query parsed+lowered once at declare time
/// into a reusable [`crate::gql::Prepared`] plan. Evaluated against the fully-
/// staged graph at commit; VIOLATED iff any result cell is boolean `false`. The
/// Rust analogue of the TS `{ src, fn }` invariant entry.
struct InvariantRule {
    name: String,
    src: String,
    plan: crate::gql::Prepared,
}

/// Which deferred constraint check failed at commit. All surface to the caller as
/// `ConstraintViolation`, but are kept distinct for messaging / FFI codes.
pub enum TxCommitError {
    /// `commit_tx` was called with no open transaction.
    NoTx,
    /// A required-property constraint is unsatisfied on a touched vertex.
    Required,
    /// A type constraint is violated on a touched vertex.
    Type,
    /// A unique constraint is violated on a touched vertex.
    Unique,
    /// A cardinality (degree-bound) constraint is violated on a touched vertex.
    Cardinality,
    /// A custom VALIDATOR predicate failed on a touched vertex/edge, or the
    /// predicate itself faulted while evaluating (e.g. an unknown function). The
    /// carried [`CodeError`] is surfaced verbatim — a `ConstraintViolation` for a
    /// definite-`false` predicate, or the evaluation fault's own code.
    Validator(CodeError),
    /// A graph-level INVARIANT query returned a `false` cell (a cross-write
    /// assertion failed), or the query itself faulted while evaluating. The
    /// carried [`CodeError`] is surfaced verbatim — a `ConstraintViolation` for a
    /// definite-`false` result cell, or the evaluation fault's own code.
    Invariant(CodeError),
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
        if self.v_unique.is_empty() {
            return None;
        }
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

    // --- required constraints (R-CONSTRAINTS) --------------------------------
    // Every live vertex carrying `label` must hold a present, non-null value for
    // each required `key`. Enforced in the write path (INSERT/SET/REMOVE) like
    // `unique`; declarative (no closures), so it is byte-identical to the TS core.
    // No backing index is needed — enforcement is a presence check.

    /// Declare a REQUIRED constraint on `(label, key)`. Idempotent. Fails with
    /// [`ErrorCode::ConstraintViolation`] if any live vertex with `label` lacks a
    /// present, non-null `key` — an already-violated constraint is meaningless.
    pub fn create_required_constraint(&mut self, label: &str, key: &str) -> CodeResult<()> {
        if let Some(lid) = self.labels.get(label) {
            for vi in self.vertex_indices() {
                if self.vlabels[vi as usize].contains(&lid)
                    && matches!(self.props.value(vi as usize, key, &self.strs), Value::Null)
                {
                    return Err(CodeError::new(
                        ErrorCode::ConstraintViolation,
                        "existing data already violates the required constraint being declared",
                    ));
                }
            }
        }
        let keys = self.v_required.entry(label.to_string()).or_default();
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
            keys.sort();
        }
        Ok(())
    }

    /// Drop a required constraint. Idempotent.
    pub fn drop_required_constraint(&mut self, label: &str, key: &str) {
        if let Some(keys) = self.v_required.get_mut(label) {
            keys.retain(|k| k != key);
            if keys.is_empty() {
                self.v_required.remove(label);
            }
        }
    }

    /// Property keys required for `label` (sorted; empty if none).
    pub fn required_keys(&self, label: &str) -> &[String] {
        self.v_required.get(label).map_or(&[], Vec::as_slice)
    }

    /// True iff `(label, key)` carries a required constraint.
    pub fn has_required_constraint(&self, label: &str, key: &str) -> bool {
        self.v_required
            .get(label)
            .is_some_and(|ks| ks.iter().any(|k| k == key))
    }

    /// Every declared required constraint as sorted `(label, key)` pairs.
    pub fn required_constraints(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .v_required
            .iter()
            .flat_map(|(l, ks)| ks.iter().map(move |k| (l.clone(), k.clone())))
            .collect();
        out.sort();
        out
    }

    /// The first `(label, key)` a new vertex with these `labels`/`props` would
    /// violate by omitting a required key (absent or null value), or `None`.
    pub fn missing_required(
        &self,
        labels: &[String],
        props: &[(String, Value)],
    ) -> Option<(String, String)> {
        if self.v_required.is_empty() {
            return None;
        }
        for label in labels {
            for key in self.required_keys(label) {
                let present = props
                    .iter()
                    .any(|(k, v)| k == key && !matches!(v, Value::Null));
                if !present {
                    return Some((label.clone(), key.clone()));
                }
            }
        }
        None
    }

    /// True iff `key` is required by a label currently on vertex `vi` (so it can't
    /// be removed or set to null).
    pub fn is_required_key(&self, vi: u32, key: &str) -> bool {
        for (label, keys) in &self.v_required {
            if keys.iter().any(|k| k == key) {
                if let Some(lid) = self.labels.get(label) {
                    if self.vlabels[vi as usize].contains(&lid) {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// If adding `label` to vertex `vi` would violate a required key the vertex
    /// lacks (absent or null), that key; else `None`.
    pub fn required_missing_for_label(&self, vi: u32, label: &str) -> Option<String> {
        for key in self.required_keys(label) {
            if matches!(self.props.value(vi as usize, key, &self.strs), Value::Null) {
                return Some(key.clone());
            }
        }
        None
    }

    // --- type constraints (R-CONSTRAINTS) ------------------------------------
    // Every present, non-null value under a constrained `key` on a vertex with
    // `label` must be of the declared scalar type. Null/absent are exempt.
    // Enforced in the write path; byte-identical to the TS core.

    /// Declare a TYPE constraint on `(label, key)` requiring `type_name` (one of
    /// string/number/boolean/date/datetime/duration/list). Fails with
    /// `InvalidValue` for an unknown type name, or `ConstraintViolation` if any
    /// existing vertex holds a present, non-null `key` of a different type.
    pub fn create_type_constraint(
        &mut self,
        label: &str,
        key: &str,
        type_name: &str,
    ) -> CodeResult<()> {
        let Some(ty) = PropType::from_name(type_name) else {
            return Err(CodeError::new(
                ErrorCode::InvalidValue,
                "unknown scalar type name for a type constraint",
            ));
        };
        if let Some(lid) = self.labels.get(label) {
            for vi in self.vertex_indices() {
                if self.vlabels[vi as usize].contains(&lid) {
                    if let Some(got) = value_type(&self.props.value(vi as usize, key, &self.strs)) {
                        if got != ty {
                            return Err(CodeError::new(
                                ErrorCode::ConstraintViolation,
                                "existing data already violates the type constraint being declared",
                            ));
                        }
                    }
                }
            }
        }
        self.v_type
            .entry(label.to_string())
            .or_default()
            .insert(key.to_string(), ty);
        Ok(())
    }

    /// Drop a type constraint. Idempotent.
    pub fn drop_type_constraint(&mut self, label: &str, key: &str) {
        if let Some(keys) = self.v_type.get_mut(label) {
            keys.remove(key);
            if keys.is_empty() {
                self.v_type.remove(label);
            }
        }
    }

    /// The first `(label, key)` a new vertex with these `labels`/`props` would
    /// violate by holding a wrong-typed value, or `None`.
    pub fn type_violation(
        &self,
        labels: &[String],
        props: &[(String, Value)],
    ) -> Option<(String, String)> {
        if self.v_type.is_empty() {
            return None;
        }
        for label in labels {
            if let Some(cs) = self.v_type.get(label) {
                for (key, ty) in cs {
                    if let Some((_, v)) = props.iter().find(|(k, _)| k == key) {
                        if let Some(got) = value_type(v) {
                            if got != *ty {
                                return Some((label.clone(), key.clone()));
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// True iff setting `vi.key = value` would break a type constraint on one of
    /// `vi`'s labels. A null value is exempt.
    pub fn type_conflict_on_set(&self, vi: u32, key: &str, value: &Value) -> bool {
        let Some(got) = value_type(value) else {
            return false;
        };
        for (label, cs) in &self.v_type {
            if let Some(ty) = cs.get(key) {
                if let Some(lid) = self.labels.get(label) {
                    if self.vlabels[vi as usize].contains(&lid) && got != *ty {
                        return true;
                    }
                }
            }
        }
        false
    }

    // --- edge constraints (R-CONSTRAINTS, edge types) -----------------------
    // Direct mirror of the vertex unique/required/type constraints, keyed by edge
    // TYPE instead of node label, enforced against the edge property store
    // (`edge_props`) and the edge property index (`eidx`). Byte-identical to the
    // TS edge constraints. Enforcement is deferred to commit (see
    // `run_deferred_checks`), exactly like the vertex ones.

    /// Declare a UNIQUE constraint on `(edge_type, key)`. Creates the backing edge
    /// index if absent. Fails with `ConstraintViolation` if the current data
    /// already violates it. Idempotent.
    pub fn create_edge_unique_constraint(&mut self, etype: &str, key: &str) -> CodeResult<()> {
        if !self.edge_indexed(key) {
            self.create_edge_index(key);
        }
        if self.first_etype_prop_duplicate(etype, key).is_some() {
            return Err(CodeError::new(
                ErrorCode::ConstraintViolation,
                "existing data already violates the edge unique constraint being declared",
            ));
        }
        let keys = self.e_unique.entry(etype.to_string()).or_default();
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
            keys.sort();
        }
        Ok(())
    }

    /// Drop an edge unique constraint. The backing index is left in place. Idempotent.
    pub fn drop_edge_unique_constraint(&mut self, etype: &str, key: &str) {
        if let Some(keys) = self.e_unique.get_mut(etype) {
            keys.retain(|k| k != key);
            if keys.is_empty() {
                self.e_unique.remove(etype);
            }
        }
    }

    /// Property keys under a unique constraint for `etype` (sorted; empty if none).
    pub fn edge_unique_keys(&self, etype: &str) -> &[String] {
        self.e_unique.get(etype).map_or(&[], Vec::as_slice)
    }

    /// True iff `(edge_type, key)` carries a unique constraint.
    pub fn has_edge_unique_constraint(&self, etype: &str, key: &str) -> bool {
        self.e_unique
            .get(etype)
            .is_some_and(|ks| ks.iter().any(|k| k == key))
    }

    /// Every declared edge unique constraint as sorted `(edge_type, key)` pairs.
    pub fn edge_unique_constraints(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .e_unique
            .iter()
            .flat_map(|(t, ks)| ks.iter().map(move |k| (t.clone(), k.clone())))
            .collect();
        out.sort();
        out
    }

    /// If adding an edge of `etypes` with `props` would break a unique constraint,
    /// the offending `(edge_type, key, existing edge)`. `exclude` skips one edge.
    pub fn edge_unique_conflict(
        &self,
        etypes: &[String],
        props: &[(String, Value)],
        exclude: Option<u32>,
    ) -> Option<(String, String, u32)> {
        if self.e_unique.is_empty() {
            return None;
        }
        for etype in etypes {
            for key in self.edge_unique_keys(etype) {
                let Some((_, value)) = props.iter().find(|(k, _)| k == key) else {
                    continue;
                };
                let hit = self
                    .edges_with_etype_value(etype, key, value)
                    .into_iter()
                    .find(|&e| Some(e) != exclude);
                if let Some(existing) = hit {
                    return Some((etype.clone(), key.clone(), existing));
                }
            }
        }
        None
    }

    /// Declare a REQUIRED constraint on `(edge_type, key)`. Fails with
    /// `ConstraintViolation` if any live edge of `etype` lacks a present, non-null
    /// `key`. Idempotent.
    pub fn create_edge_required_constraint(&mut self, etype: &str, key: &str) -> CodeResult<()> {
        if let Some(edges) = self.edges_with_etype_name(etype) {
            for &ei in edges {
                if matches!(
                    self.edge_props.value(ei as usize, key, &self.strs),
                    Value::Null
                ) {
                    return Err(CodeError::new(
                        ErrorCode::ConstraintViolation,
                        "existing data already violates the edge required constraint being declared",
                    ));
                }
            }
        }
        let keys = self.e_required.entry(etype.to_string()).or_default();
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
            keys.sort();
        }
        Ok(())
    }

    /// Drop an edge required constraint. Idempotent.
    pub fn drop_edge_required_constraint(&mut self, etype: &str, key: &str) {
        if let Some(keys) = self.e_required.get_mut(etype) {
            keys.retain(|k| k != key);
            if keys.is_empty() {
                self.e_required.remove(etype);
            }
        }
    }

    /// Property keys required for edge type `etype` (sorted; empty if none).
    pub fn edge_required_keys(&self, etype: &str) -> &[String] {
        self.e_required.get(etype).map_or(&[], Vec::as_slice)
    }

    /// True iff `(edge_type, key)` carries a required constraint.
    pub fn has_edge_required_constraint(&self, etype: &str, key: &str) -> bool {
        self.e_required
            .get(etype)
            .is_some_and(|ks| ks.iter().any(|k| k == key))
    }

    /// Every declared edge required constraint as sorted `(edge_type, key)` pairs.
    pub fn edge_required_constraints(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .e_required
            .iter()
            .flat_map(|(t, ks)| ks.iter().map(move |k| (t.clone(), k.clone())))
            .collect();
        out.sort();
        out
    }

    /// The first `(edge_type, key)` a new edge with these `etypes`/`props` would
    /// violate by omitting a required key (absent or null value), or `None`.
    pub fn edge_missing_required(
        &self,
        etypes: &[String],
        props: &[(String, Value)],
    ) -> Option<(String, String)> {
        if self.e_required.is_empty() {
            return None;
        }
        for etype in etypes {
            for key in self.edge_required_keys(etype) {
                let present = props
                    .iter()
                    .any(|(k, v)| k == key && !matches!(v, Value::Null));
                if !present {
                    return Some((etype.clone(), key.clone()));
                }
            }
        }
        None
    }

    /// Declare a TYPE constraint on `(edge_type, key)` requiring `type_name`. Fails
    /// with `InvalidValue` for an unknown type name, or `ConstraintViolation` if
    /// any existing edge holds a present, non-null `key` of a different type.
    pub fn create_edge_type_constraint(
        &mut self,
        etype: &str,
        key: &str,
        type_name: &str,
    ) -> CodeResult<()> {
        let Some(ty) = PropType::from_name(type_name) else {
            return Err(CodeError::new(
                ErrorCode::InvalidValue,
                "unknown scalar type name for an edge type constraint",
            ));
        };
        if let Some(edges) = self.edges_with_etype_name(etype) {
            for &ei in edges {
                if let Some(got) = value_type(&self.edge_props.value(ei as usize, key, &self.strs))
                {
                    if got != ty {
                        return Err(CodeError::new(
                            ErrorCode::ConstraintViolation,
                            "existing data already violates the edge type constraint being declared",
                        ));
                    }
                }
            }
        }
        self.e_type_constraints
            .entry(etype.to_string())
            .or_default()
            .insert(key.to_string(), ty);
        Ok(())
    }

    /// Drop an edge type constraint. Idempotent.
    pub fn drop_edge_type_constraint(&mut self, etype: &str, key: &str) {
        if let Some(keys) = self.e_type_constraints.get_mut(etype) {
            keys.remove(key);
            if keys.is_empty() {
                self.e_type_constraints.remove(etype);
            }
        }
    }

    /// The declared type for edge `(edge_type, key)`, or `None`.
    pub fn edge_type_constraint(&self, etype: &str, key: &str) -> Option<PropType> {
        self.e_type_constraints.get(etype)?.get(key).copied()
    }

    /// Every declared edge type constraint as sorted `(edge_type, key)` pairs.
    pub fn edge_type_constraints(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .e_type_constraints
            .iter()
            .flat_map(|(t, ks)| ks.keys().map(move |k| (t.clone(), k.clone())))
            .collect();
        out.sort();
        out
    }

    /// The first `(edge_type, key)` a new edge with these `etypes`/`props` would
    /// violate by holding a wrong-typed value, or `None`.
    pub fn edge_type_violation(
        &self,
        etypes: &[String],
        props: &[(String, Value)],
    ) -> Option<(String, String)> {
        if self.e_type_constraints.is_empty() {
            return None;
        }
        for etype in etypes {
            if let Some(cs) = self.e_type_constraints.get(etype) {
                for (key, ty) in cs {
                    if let Some((_, v)) = props.iter().find(|(k, _)| k == key) {
                        if let Some(got) = value_type(v) {
                            if got != *ty {
                                return Some((etype.clone(), key.clone()));
                            }
                        }
                    }
                }
            }
        }
        None
    }

    /// Live edges of type `etype` whose property `key == value`. Seeks the backing
    /// edge index (a constraint always creates one), falling back to a scan.
    /// Non-indexable values (null/list) yield an empty set — exempt from uniqueness.
    fn edges_with_etype_value(&self, etype: &str, key: &str, value: &Value) -> Vec<u32> {
        let Some(idxk) = IdxKey::from_value(value) else {
            return Vec::new();
        };
        let Some(tid) = self.etype.get(etype) else {
            return Vec::new();
        };
        match self.edges_by_prop(key, &idxk) {
            Some(ids) => ids
                .iter()
                .copied()
                .filter(|&e| self.is_edge_live(e) && self.e_type[e as usize] == tid)
                .collect(),
            None => (0..self.e_src.len() as u32)
                .filter(|&e| {
                    self.is_edge_live(e)
                        && self.e_type[e as usize] == tid
                        && self.edge_props.value(e as usize, key, &self.strs) == *value
                })
                .collect(),
        }
    }

    /// The first pair of live `etype`-edges that share a value for `key` — for
    /// validating an edge unique constraint against existing data at declare time.
    fn first_etype_prop_duplicate(&self, etype: &str, key: &str) -> Option<(u32, u32)> {
        let tid = self.etype.get(etype)?;
        let bt = self.eidx.get(key)?;
        for ids in bt.values() {
            let mut with_type = ids
                .iter()
                .copied()
                .filter(|&e| self.is_edge_live(e) && self.e_type[e as usize] == tid);
            if let (Some(a), Some(b)) = (with_type.next(), with_type.next()) {
                return Some((a, b));
            }
        }
        None
    }

    /// The single type name an edge carries (empty vec for a type-less edge) — the
    /// edge analogue of a vertex's label list (an edge has exactly one type).
    fn edge_type_names(&self, ei: u32) -> Vec<String> {
        let name = self.etype.text(self.e_type[ei as usize]).to_string();
        if name.is_empty() {
            Vec::new()
        } else {
            vec![name]
        }
    }

    /// A live edge's present properties as `(key, value)` pairs — the shape the edge
    /// constraint predicates consume. Edge analogue of `vertex_props`.
    fn edge_props_of(&self, ei: u32) -> Vec<(String, Value)> {
        let i = ei as usize;
        let mut out = Vec::new();
        for kid in 0..self.edge_props.cols.len() as u32 {
            if self.edge_props.is_present_id(i, kid) {
                let key = self.edge_props.keys.text(kid).to_string();
                let val = self.edge_props.value_id(i, kid, &self.strs);
                out.push((key, val));
            }
        }
        out
    }

    // --- cardinality constraints (R-CONSTRAINTS, degree bounds) --------------
    // Bound the degree of every vertex carrying `label` over `etype` in
    // `direction` (0 = out / the vertex is the edge source, 1 = in / the target).
    // Max is deferred to commit against touched endpoints (the GQL layer runs
    // every statement in an auto-commit frame, so a single over-max edge INSERT is
    // caught there); min is commit-time only (unsatisfiable by a single write).
    // The edge write paths note both endpoints as touched; `run_deferred_checks`
    // re-checks them. Byte-identical to the TS core.

    /// Number of live `etype` edges for which `vi` is the SOURCE (out-degree). The
    /// adjacency lists hold only live edges, so this is a filtered count. A
    /// self-loop appears in `out` once, so it counts once here (and once for `in`).
    pub fn out_degree(&self, vi: u32, etype: &str) -> u32 {
        let Some(tid) = self.etype.get(etype) else {
            return 0;
        };
        self.out[vi as usize]
            .iter()
            .filter(|a| a.etype == tid)
            .count() as u32
    }

    /// Number of live `etype` edges for which `vi` is the TARGET (in-degree).
    pub fn in_degree(&self, vi: u32, etype: &str) -> u32 {
        let Some(tid) = self.etype.get(etype) else {
            return 0;
        };
        self.in_[vi as usize]
            .iter()
            .filter(|a| a.etype == tid)
            .count() as u32
    }

    /// Degree of `vi` over `etype` in `direction` (0 = out, 1 = in).
    fn degree_dir(&self, vi: u32, etype: &str, direction: u8) -> u32 {
        if direction == 0 {
            self.out_degree(vi, etype)
        } else {
            self.in_degree(vi, etype)
        }
    }

    /// Declare a CARDINALITY constraint bounding the degree of every vertex
    /// carrying `label` over `etype` in `direction` (0 = out, 1 = in) to
    /// `min..=max` (`max: None` unbounded). Re-declaring `(label, etype,
    /// direction)` replaces the bounds. Fails with `ConstraintViolation` if any
    /// existing vertex already violates it (mirrors unique/required declare-time).
    pub fn create_cardinality_constraint(
        &mut self,
        label: &str,
        etype: &str,
        direction: u8,
        min: u32,
        max: Option<u32>,
    ) -> CodeResult<()> {
        if let Some(lid) = self.labels.get(label) {
            for vi in self.vertex_indices() {
                if !self.vlabels[vi as usize].contains(&lid) {
                    continue;
                }
                let d = self.degree_dir(vi, etype, direction);
                if d < min || max.is_some_and(|m| d > m) {
                    return Err(CodeError::new(
                        ErrorCode::ConstraintViolation,
                        "existing data already violates the cardinality constraint being declared",
                    ));
                }
            }
        }
        let rule = CardinalityRule {
            label: label.to_string(),
            etype: etype.to_string(),
            direction,
            min,
            max,
        };
        if let Some(existing) = self.v_cardinality.iter_mut().find(|c| {
            c.label == rule.label && c.etype == rule.etype && c.direction == rule.direction
        }) {
            *existing = rule;
        } else {
            self.v_cardinality.push(rule);
        }
        Ok(())
    }

    /// Drop a cardinality constraint on `(label, etype, direction)`. Idempotent.
    pub fn drop_cardinality_constraint(&mut self, label: &str, etype: &str, direction: u8) {
        self.v_cardinality
            .retain(|c| !(c.label == label && c.etype == etype && c.direction == direction));
    }

    /// Every declared cardinality constraint as sorted `(label, etype, direction,
    /// min, max)` tuples — introspection, sorted for a deterministic listing.
    pub fn cardinality_constraints(&self) -> Vec<(String, String, u8, u32, Option<u32>)> {
        let mut out: Vec<(String, String, u8, u32, Option<u32>)> = self
            .v_cardinality
            .iter()
            .map(|c| (c.label.clone(), c.etype.clone(), c.direction, c.min, c.max))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        out
    }

    // --- VALIDATORS (custom GQL-predicate constraints) -----------------------

    /// Declare a VALIDATOR on `label` (a vertex label OR an edge type): every
    /// element carrying `label` must satisfy the GQL boolean `predicate`, with the
    /// element bound to `var`. Appends (a label may carry several). The predicate
    /// is parsed+lowered once here. Two failure modes, distinguished by error code
    /// so the FFI can map them: an unparseable predicate returns
    /// `ErrorCode::Syntax`; existing data that already evaluates to a definite
    /// `false` returns `ErrorCode::ConstraintViolation` (the declare-time scan).
    /// SQL-`CHECK` semantics — a null/unknown result passes.
    pub fn create_validator(&mut self, label: &str, var: &str, predicate: &str) -> CodeResult<()> {
        let expr = crate::gql::parser::parse_predicate(predicate)
            .map_err(|e| CodeError::new(ErrorCode::Syntax, e.message))?;
        let pred = crate::gql::plan::lower_predicate(var, &expr);

        // Declare-time scan: reject if any existing element carrying `label` (a
        // vertex OR an edge — one namespace) currently evaluates to a definite
        // false. An already-violated validator is meaningless (mirrors the other
        // constraints). A predicate evaluation fault (e.g. an unknown function)
        // surfaces verbatim via `?`.
        if let Some(lid) = self.labels.get(label) {
            for vi in self.vertex_indices() {
                if self.vlabels[vi as usize].contains(&lid)
                    && crate::gql::eval::eval_predicate(
                        self,
                        &pred,
                        crate::gql::eval::Val::Node(vi),
                    )? == Some(false)
                {
                    return Err(CodeError::new(
                        ErrorCode::ConstraintViolation,
                        "existing data already violates the validator being declared",
                    ));
                }
            }
        }

        if let Some(tid) = self.etype.get(label) {
            // `edges_with_etype` borrows `self.by_etype`; copy the indices out so the
            // per-edge `eval_predicate(self, …)` isn't a second overlapping borrow.
            let eids: Vec<u32> = self.edges_with_etype(tid).to_vec();
            for ei in eids {
                if self.is_edge_live(ei)
                    && crate::gql::eval::eval_predicate(
                        self,
                        &pred,
                        crate::gql::eval::Val::Edge(ei),
                    )? == Some(false)
                {
                    return Err(CodeError::new(
                        ErrorCode::ConstraintViolation,
                        "existing data already violates the validator being declared",
                    ));
                }
            }
        }

        self.v_validators
            .entry(label.to_string())
            .or_default()
            .push(ValidatorRule {
                var: var.to_string(),
                src: predicate.to_string(),
                pred,
            });
        Ok(())
    }

    /// Drop every validator declared on `label`. Idempotent.
    pub fn drop_validator(&mut self, label: &str) {
        self.v_validators.remove(label);
    }

    /// Every declared validator as `(label, var, src)`, sorted by `(label, src)`.
    /// The compiled predicate is internal. Introspection for tests/tooling.
    pub fn validators(&self) -> Vec<(String, String, String)> {
        let mut out: Vec<(String, String, String)> = self
            .v_validators
            .iter()
            .flat_map(|(label, rules)| {
                rules
                    .iter()
                    .map(move |r| (label.clone(), r.var.clone(), r.src.clone()))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0).then(a.2.cmp(&b.2)));
        out
    }

    /// Check every validator declared on a touched vertex `vi`. `Ok(())` if all
    /// pass (a null/unknown result passes); `Err` on a definite `false` or an
    /// evaluation fault. The commit-time check (the eager per-write gate is the
    /// statement's auto-commit, which runs this via `run_deferred_checks`).
    fn check_validators_vertex(&self, vi: u32) -> CodeResult<()> {
        if self.v_validators.is_empty() {
            return Ok(());
        }
        for &lid in &self.vlabels[vi as usize] {
            let name = self.labels.text(lid);
            if let Some(rules) = self.v_validators.get(name) {
                for rule in rules {
                    if crate::gql::eval::eval_predicate(
                        self,
                        &rule.pred,
                        crate::gql::eval::Val::Node(vi),
                    )? == Some(false)
                    {
                        return Err(CodeError::new(
                            ErrorCode::ConstraintViolation,
                            format!("validator '{}' on '{}' violated", rule.src, name),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Edge analogue of [`Graph::check_validators_vertex`].
    fn check_validators_edge(&self, ei: u32) -> CodeResult<()> {
        if self.v_validators.is_empty() {
            return Ok(());
        }
        for name in self.edge_type_names(ei) {
            if let Some(rules) = self.v_validators.get(&name) {
                for rule in rules {
                    if crate::gql::eval::eval_predicate(
                        self,
                        &rule.pred,
                        crate::gql::eval::Val::Edge(ei),
                    )? == Some(false)
                    {
                        return Err(CodeError::new(
                            ErrorCode::ConstraintViolation,
                            format!("validator '{}' on '{}' violated", rule.src, name),
                        ));
                    }
                }
            }
        }
        Ok(())
    }

    /// Declare a graph-level INVARIANT `name` = a whole-graph GQL `query` that must
    /// hold after every write transaction. The query is parsed+lowered once here;
    /// an unparseable query returns [`ErrorCode::Syntax`] (mapped to `-2` at the
    /// FFI). VIOLATED iff any cell in its result set is boolean `false` (everything
    /// else — `true`/`null`/non-boolean/empty — holds). A declare-time run rejects
    /// with [`ErrorCode::ConstraintViolation`] if the current graph already
    /// violates it (an already-broken invariant is meaningless, mirroring the
    /// validators/constraints). Re-declaring the same `name` replaces the prior
    /// query. Byte-identical with the TS `createInvariant`.
    pub fn create_invariant(&mut self, name: &str, query: &str) -> CodeResult<()> {
        let plan =
            crate::gql::prepare(query).map_err(|e| CodeError::new(ErrorCode::Syntax, e.message))?;

        // Declare-time run against the current graph: reject on a definite-`false`
        // cell (or surface an evaluation fault verbatim via `?`).
        let rows = crate::gql::run_invariant(&plan, self)?;
        if Self::invariant_violated(&rows) {
            return Err(CodeError::new(
                ErrorCode::ConstraintViolation,
                format!("existing data already violates the invariant '{name}'"),
            ));
        }

        // Replace any prior invariant of the same name (declare is idempotent-ish:
        // last query wins), then append.
        self.v_invariants.retain(|r| r.name != name);
        self.v_invariants.push(InvariantRule {
            name: name.to_string(),
            src: query.to_string(),
            plan,
        });
        Ok(())
    }

    /// Drop the graph-level invariant named `name`. Idempotent.
    pub fn drop_invariant(&mut self, name: &str) {
        self.v_invariants.retain(|r| r.name != name);
    }

    /// Every declared invariant as `(name, src)`, sorted by name. The compiled
    /// query plan is internal. Introspection for tests/tooling.
    pub fn invariants(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .v_invariants
            .iter()
            .map(|r| (r.name.clone(), r.src.clone()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// `false`-only-fails: a result set VIOLATES an invariant iff any cell is a
    /// boolean `false`. A `true`, a `null`, a non-boolean value (number/string/
    /// list/map/temporal), or an empty result set all HOLD. Byte-identical to the
    /// TS `invariantViolated` (`cell === false`).
    fn invariant_violated(rows: &crate::query::RowSet) -> bool {
        rows.data.iter().any(|v| matches!(v, Value::Bool(false)))
    }

    /// Run every declared invariant against the fully-staged graph. Called from
    /// [`Graph::commit_tx`] only when the transaction actually wrote something.
    /// `Ok(())` if all hold; `Err` carrying the failing invariant's error (a
    /// `ConstraintViolation` for a `false` cell, or an evaluation fault's own code).
    fn check_invariants(&mut self) -> CodeResult<()> {
        if self.v_invariants.is_empty() {
            return Ok(());
        }
        // Move the rules out so the read-only `run_invariant(&plan, self)` can take
        // `&mut self` without overlapping the borrow; the run never mutates the
        // registry, so restoring the same Vec afterwards is exact.
        let rules = std::mem::take(&mut self.v_invariants);
        let mut failure: Option<CodeError> = None;
        for rule in &rules {
            match crate::gql::run_invariant(&rule.plan, self) {
                Ok(rows) if Self::invariant_violated(&rows) => {
                    failure = Some(CodeError::new(
                        ErrorCode::ConstraintViolation,
                        format!("invariant '{}' violated", rule.name),
                    ));
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        self.v_invariants = rules;
        match failure {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// True iff a touched vertex `vi` violates any cardinality constraint on one of
    /// its labels (degree below `min` or above `max`). The commit-time check.
    fn cardinality_violation(&self, vi: u32) -> bool {
        if self.v_cardinality.is_empty() {
            return false;
        }
        let lids = &self.vlabels[vi as usize];
        for c in &self.v_cardinality {
            let Some(lid) = self.labels.get(&c.label) else {
                continue;
            };
            if !lids.contains(&lid) {
                continue;
            }
            let d = self.degree_dir(vi, &c.etype, c.direction);
            if d < c.min || c.max.is_some_and(|m| d > m) {
                return true;
            }
        }
        false
    }

    /// Note both endpoints of edge `ei` as touched for the commit-time cardinality
    /// recheck (their degree changed). No-op outside a transaction / during a
    /// rollback replay, or when no cardinality constraint is declared. Called by
    /// the edge write paths (`add_edge` / `remove_edge`), so a vertex-delete
    /// cascade re-checks the surviving neighbor too — mirrors the TS core, whose
    /// `insertEdge` / `removeEdge` note endpoints at the same core boundary.
    fn cardinality_note_endpoints(&mut self, ei: u32) {
        if self.v_cardinality.is_empty() || !self.tx_active() {
            return;
        }
        let i = ei as usize;
        let (from, to) = (self.e_src[i], self.e_dst[i]);
        self.tx_touched.push(from);
        self.tx_touched.push(to);
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

    // --- transactions (R-TX) -----------------------------------------------
    // An atomic mutation boundary with rollback + deferred constraint checks.
    // Mechanism: eager-apply + undo-log + deferred-check-at-commit. Writes apply
    // immediately (read-your-writes), each recording an inverse op; the built-in
    // constraint checks defer to commit, run once against the fully-staged graph;
    // on failure the whole transaction rolls back via the undo log. The engine is
    // single-writer and synchronous — no concurrency, MVCC, or isolation levels.
    // Byte-identical to the TS core (`packages/core/src/core/Graph.ts`).

    /// True while a transaction is open and recording writes (not during a
    /// rollback replay). Mutations consult this to decide whether to record undo /
    /// note a touched vertex.
    #[inline]
    pub fn tx_active(&self) -> bool {
        self.tx_depth > 0 && !self.applying_undo
    }

    /// Is a transaction currently open (at any nesting depth)?
    #[inline]
    pub fn in_transaction(&self) -> bool {
        self.tx_depth > 0
    }

    /// Is the active explicit transaction READ ONLY? Set by ISO GQL
    /// `START TRANSACTION READ ONLY`, cleared on commit/rollback. The GQL statement
    /// executor consults this to reject a write statement in a read-only transaction.
    #[inline]
    pub fn tx_read_only(&self) -> bool {
        self.tx_read_only
    }

    /// Set/clear the active transaction's READ ONLY access mode (see [`Graph::tx_read_only`]).
    #[inline]
    pub fn set_tx_read_only(&mut self, read_only: bool) {
        self.tx_read_only = read_only;
    }

    /// Open a transaction frame. Nesting increments depth; the outermost frame
    /// owns commit/rollback (flat, savepoint-less), matching the TS core.
    pub fn begin_tx(&mut self) {
        self.tx_depth += 1;
    }

    /// Close the current frame. An inner commit just decrements depth. The
    /// outermost commit runs the deferred constraint checks against the fully
    /// staged graph — on failure it rolls the whole transaction back via the undo
    /// log and returns the failure — then discards the undo/touched state.
    pub fn commit_tx(&mut self) -> Result<(), TxCommitError> {
        if self.tx_depth == 0 {
            return Err(TxCommitError::NoTx);
        }
        self.tx_depth -= 1;
        if self.tx_depth > 0 {
            return Ok(()); // an inner commit — the outermost frame finalizes
        }
        if let Err(e) = self.run_deferred_checks() {
            self.apply_undo_and_reset();
            return Err(e);
        }
        // Graph-level invariants (cross-write assertions): run ONCE against the
        // fully-staged graph, AFTER the per-element deferred checks, but only if
        // this transaction actually wrote something — a pure-read commit skips
        // them (no spurious cost/throw). The undo log is non-empty iff a write was
        // recorded during the frame. On failure, roll the whole transaction back.
        if !self.tx_undo.is_empty() {
            if let Err(e) = self.check_invariants() {
                self.apply_undo_and_reset();
                return Err(TxCommitError::Invariant(e));
            }
        }
        self.tx_undo.clear();
        self.tx_touched.clear();
        self.tx_touched_edges.clear();
        Ok(())
    }

    /// Roll the current transaction back: replay the undo log in reverse, discard
    /// the touched set. A no-op if no transaction is open. Idempotent.
    pub fn rollback_tx(&mut self) {
        if self.tx_depth == 0 {
            return;
        }
        self.apply_undo_and_reset();
    }

    /// Record an inverse op to replay on rollback (no-op outside a transaction or
    /// during an undo replay).
    #[inline]
    fn record_undo(&mut self, inverse: Undo) {
        if self.tx_active() {
            self.tx_undo.push(inverse);
        }
    }

    /// Note a vertex whose built-in constraints must be re-checked at commit. The
    /// per-write gates (in the GQL eval layer) call this instead of throwing
    /// immediately while a transaction is open, so an intermediate state — a node
    /// added before its mandatory property, two rows that momentarily collide —
    /// doesn't trip a constraint the final state satisfies.
    #[inline]
    pub fn tx_note_touched(&mut self, vi: u32) {
        if self.tx_active() {
            self.tx_touched.push(vi);
        }
    }

    /// Note an edge whose built-in edge constraints must be re-checked at commit —
    /// the edge analogue of [`Graph::tx_note_touched`] (R-TX deferral for edges).
    #[inline]
    pub fn tx_note_touched_edge(&mut self, ei: u32) {
        if self.tx_active() {
            self.tx_touched_edges.push(ei);
        }
    }

    /// Replay the undo log newest-first and reset all transaction state to closed.
    fn apply_undo_and_reset(&mut self) {
        self.applying_undo = true;
        let undo = std::mem::take(&mut self.tx_undo);
        for u in undo.into_iter().rev() {
            self.apply_one_undo(u);
        }
        self.applying_undo = false;
        self.tx_depth = 0;
        self.tx_undo.clear();
        self.tx_touched.clear();
        self.tx_touched_edges.clear();
    }

    /// Apply a single inverse op. Runs with `applying_undo == true`, so the
    /// mutation methods it calls neither re-record undo nor re-note touched
    /// vertices — they only restore known-good state and keep the indexes current.
    fn apply_one_undo(&mut self, u: Undo) {
        match u {
            Undo::InsertVertex(vi) => {
                let _ = self.remove_vertex(vi, true);
            }
            Undo::InsertEdge(ei) => self.remove_edge(ei),
            Undo::VProp(vi, key, Some(v)) => self.set_vertex_prop(vi, &key, v),
            Undo::VProp(vi, key, None) => self.remove_vertex_prop(vi, &key),
            Undo::EProp(ei, key, Some(v)) => self.set_edge_prop(ei, &key, v),
            Undo::EProp(ei, key, None) => self.remove_edge_prop(ei, &key),
            Undo::VLabelAdd(vi, name) => self.remove_vertex_label(vi, &name),
            Undo::VLabelRemove(vi, name) => self.add_vertex_label(vi, &name),
            Undo::EType(ei, name) => self.add_edge_label(ei, &name),
            Undo::DeleteVertex { vi, labels } => self.untombstone_vertex(vi, &labels),
            Undo::DeleteEdge { ei, eid } => self.untombstone_edge(ei, eid),
        }
    }

    /// Re-run the built-in vertex constraints (required / type / unique) against
    /// every vertex touched during the transaction, now that all writes are
    /// staged. A vertex added then removed within the transaction is skipped.
    fn run_deferred_checks(&self) -> Result<(), TxCommitError> {
        for &vi in &self.tx_touched {
            if !self.is_vertex_live(vi) {
                continue; // added then removed within the transaction — nothing to check
            }
            let labels: Vec<String> = self.vlabels[vi as usize]
                .iter()
                .map(|&l| self.labels.text(l).to_string())
                .collect();
            let props = self.vertex_props(vi);
            if self.missing_required(&labels, &props).is_some() {
                return Err(TxCommitError::Required);
            }
            if self.type_violation(&labels, &props).is_some() {
                return Err(TxCommitError::Type);
            }
            if self.unique_conflict(&labels, &props, Some(vi)).is_some() {
                return Err(TxCommitError::Unique);
            }
            // Cardinality: a vertex is touched when added OR when an incident edge
            // is added/removed (either endpoint's degree changed). This commit is
            // where BOTH bounds land — max (also caught eagerly for a direct
            // addEdge on the TS side) and min (commit-time only, since a single
            // write can't satisfy a positive lower bound).
            if self.cardinality_violation(vi) {
                return Err(TxCommitError::Cardinality);
            }
            // Custom validators (a definite-false predicate, or an evaluation fault
            // like an unknown function) — surfaced with their own carried error.
            if let Err(e) = self.check_validators_vertex(vi) {
                return Err(TxCommitError::Validator(e));
            }
        }
        // Edge constraints: re-check every edge touched during the transaction
        // against the fully-staged graph (edge analogue of the vertex loop above).
        for &ei in &self.tx_touched_edges {
            if !self.is_edge_live(ei) {
                continue; // added then removed within the transaction — nothing to check
            }
            let etypes = self.edge_type_names(ei);
            let props = self.edge_props_of(ei);
            if self.edge_missing_required(&etypes, &props).is_some() {
                return Err(TxCommitError::Required);
            }
            if self.edge_type_violation(&etypes, &props).is_some() {
                return Err(TxCommitError::Type);
            }
            if self
                .edge_unique_conflict(&etypes, &props, Some(ei))
                .is_some()
            {
                return Err(TxCommitError::Unique);
            }
            if let Err(e) = self.check_validators_edge(ei) {
                return Err(TxCommitError::Validator(e));
            }
        }
        Ok(())
    }

    /// A live vertex's present properties as `(key, value)` pairs — the shape the
    /// constraint predicates consume. A stored null is present (and included).
    fn vertex_props(&self, vi: u32) -> Vec<(String, Value)> {
        let i = vi as usize;
        let mut out = Vec::new();
        for kid in 0..self.props.cols.len() as u32 {
            if self.props.is_present_id(i, kid) {
                let key = self.props.keys.text(kid).to_string();
                let val = self.props.value_id(i, kid, &self.strs);
                out.push((key, val));
            }
        }
        out
    }

    /// Reverse a vertex delete: un-tombstone the slot in place (its columns were
    /// never cleared on delete, so property values survive) and rebuild its label
    /// membership + property indexes. Adjacency is repopulated by the incident
    /// edges' own `DeleteEdge` inverses (replayed after this one).
    fn untombstone_vertex(&mut self, vi: u32, labels: &[u32]) {
        let i = vi as usize;
        if self.is_vertex_live(vi) {
            return;
        }
        self.v_live[i] = true;
        self.live_n += 1;
        self.vlabels[i] = labels.to_vec();
        for &lid in labels {
            self.by_label.entry(lid).or_default().push(vi);
        }
        if !self.vidx.is_empty() {
            for key in self.vidx.keys().cloned().collect::<Vec<_>>() {
                let val = self.props.value(i, &key, &self.strs);
                idx_apply(&mut self.vidx, &key, vi, &val, true);
            }
        }
        self.bump();
        let mut names: Vec<String> = labels
            .iter()
            .map(|&l| self.labels.text(l).to_string())
            .collect();
        for kid in 0..self.props.cols.len() as u32 {
            if self.props.is_present_id(i, kid) {
                names.push(self.props.keys.text(kid).to_string());
            }
        }
        for name in names {
            self.touch(&name);
        }
    }

    /// Reverse an edge delete: un-tombstone it in place and restore its type
    /// bucket, both endpoints' adjacency, property indexes, and external-id overlay.
    fn untombstone_edge(&mut self, ei: u32, eid: Option<Arc<str>>) {
        let i = ei as usize;
        if self.is_edge_live(ei) {
            return;
        }
        self.e_live[i] = true;
        self.live_e += 1;
        let tid = self.e_type[i];
        let (src, dst) = (self.e_src[i], self.e_dst[i]);
        self.by_etype.entry(tid).or_default().push(ei);
        self.out[src as usize].push(Adj {
            eidx: ei,
            nbr: dst,
            etype: tid,
        });
        self.in_[dst as usize].push(Adj {
            eidx: ei,
            nbr: src,
            etype: tid,
        });
        if !self.eidx.is_empty() {
            for key in self.eidx.keys().cloned().collect::<Vec<_>>() {
                let val = self.edge_props.value(i, &key, &self.strs);
                idx_apply(&mut self.eidx, &key, ei, &val, true);
            }
        }
        if let Some(arc) = eid {
            self.eid_fwd.insert(ei, arc.clone());
            self.eid_rev.insert(arc, ei);
        }
        self.bump();
        let mut names: Vec<String> = vec![self.etype.text(tid).to_string()];
        for kid in 0..self.edge_props.cols.len() as u32 {
            if self.edge_props.is_present_id(i, kid) {
                names.push(self.edge_props.keys.text(kid).to_string());
            }
        }
        for name in names {
            self.touch(&name);
        }
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
        // Undo of an insert = tombstone the slot (detach removes any edges added
        // to it later — but on reverse replay those are already undone).
        self.record_undo(Undo::InsertVertex(vi));
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
        self.record_undo(Undo::InsertEdge(ei));
        // Both endpoints' degree changed — note them for the commit-time
        // cardinality recheck (no-op unless inside a transaction with a
        // cardinality constraint declared).
        self.cardinality_note_endpoints(ei);
        ei
    }

    pub fn set_vertex_prop(&mut self, vi: u32, key: &str, v: Value) {
        if self.tx_active() {
            let prior = if self.props.is_present(vi as usize, key) {
                Some(self.props.value(vi as usize, key, &self.strs))
            } else {
                None
            };
            self.record_undo(Undo::VProp(vi, key.to_string(), prior));
        }
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
        if self.tx_active() {
            let prior = if self.props.is_present(vi as usize, key) {
                Some(self.props.value(vi as usize, key, &self.strs))
            } else {
                None
            };
            self.record_undo(Undo::VProp(vi, key.to_string(), prior));
        }
        if self.vidx.contains_key(key) {
            let old = self.props.value(vi as usize, key, &self.strs);
            idx_apply(&mut self.vidx, key, vi, &old, false);
        }
        self.props.remove_value(vi as usize, key);
        self.bump();
        self.touch(key);
    }
    pub fn set_edge_prop(&mut self, ei: u32, key: &str, v: Value) {
        if self.tx_active() {
            let prior = if self.edge_props.is_present(ei as usize, key) {
                Some(self.edge_props.value(ei as usize, key, &self.strs))
            } else {
                None
            };
            self.record_undo(Undo::EProp(ei, key.to_string(), prior));
        }
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
        if self.tx_active() {
            let prior = if self.edge_props.is_present(ei as usize, key) {
                Some(self.edge_props.value(ei as usize, key, &self.strs))
            } else {
                None
            };
            self.record_undo(Undo::EProp(ei, key.to_string(), prior));
        }
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
            self.record_undo(Undo::VLabelAdd(vi, name.to_string()));
        }
    }
    pub fn remove_vertex_label(&mut self, vi: u32, name: &str) {
        if let Some(lid) = self.labels.get(name) {
            let had = self.vlabels[vi as usize].contains(&lid);
            self.vlabels[vi as usize].retain(|&x| x != lid);
            if let Some(bucket) = self.by_label.get_mut(&lid) {
                bucket.retain(|&x| x != vi);
            }
            self.bump();
            self.touch(name);
            if had {
                self.record_undo(Undo::VLabelRemove(vi, name.to_string()));
            }
        }
    }

    /// An edge carries a single type; relabelling replaces it (last wins).
    pub fn add_edge_label(&mut self, ei: u32, name: &str) {
        let tid = self.etype.intern(name);
        let i = ei as usize;
        // Move the edge between type buckets when its type actually changes.
        let old = self.e_type[i];
        // Capture the prior type name (for the rollback inverse) before it changes.
        if old != tid && self.tx_active() {
            let old_name = self.etype.text(old).to_string();
            self.record_undo(Undo::EType(ei, old_name));
        }
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
        // Both endpoints' degree will drop — note them for the commit-time
        // cardinality recheck (min may now be unmet). Endpoints read from the
        // still-intact e_src/e_dst; no-op outside a transaction / rollback replay.
        self.cardinality_note_endpoints(ei);
        // Record the inverse (un-tombstone) before tombstoning: capture any
        // external-id overlay, which the removal below drops.
        if self.tx_active() {
            let eid = self.eid_fwd.get(&ei).cloned();
            self.record_undo(Undo::DeleteEdge { ei, eid });
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
        // Capture the labels for the rollback inverse before clearing them (the
        // columns are left intact, so property values survive the tombstone).
        let undo_labels: Vec<u32> = if self.tx_active() {
            self.vlabels[i].clone()
        } else {
            Vec::new()
        };
        self.vlabels[i].clear();
        self.out[i].clear();
        self.in_[i].clear();
        self.v_live[i] = false;
        self.live_n -= 1;
        self.bump();
        for name in touched {
            self.touch(&name);
        }
        // Recorded last (after the cascade's per-edge `DeleteEdge` inverses), so a
        // reverse replay un-tombstones the vertex first, then re-adds its edges.
        self.record_undo(Undo::DeleteVertex {
            vi,
            labels: undo_labels,
        });
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
            v_required: HashMap::new(),
            v_type: HashMap::new(),
            e_unique: HashMap::new(),
            e_required: HashMap::new(),
            e_type_constraints: HashMap::new(),
            v_cardinality: Vec::new(),
            v_validators: HashMap::new(),
            v_invariants: Vec::new(),
            tx_depth: 0,
            tx_undo: Vec::new(),
            tx_touched: Vec::new(),
            tx_touched_edges: Vec::new(),
            applying_undo: false,
            tx_read_only: false,
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

#[cfg(test)]
mod transactions {
    //! R-TX: an explicit transaction over the GQL eval mutation path must roll
    //! back to byte-identical prior state, and commit must persist. The eval layer
    //! wraps each statement in its own auto-commit frame, so these tests exercise
    //! the *nested* case (explicit begin → statements → rollback/commit), where
    //! the inner per-statement frames join the outer one.
    use super::*;
    use crate::gql::eval::Params;
    use crate::gql::parse;
    use crate::ndjson;

    fn run(g: &mut Graph, q: &str) {
        parse(q)
            .unwrap()
            .execute(g, &Params::new())
            .unwrap_or_else(|e| panic!("query failed: {q}: {e:?}"));
    }

    #[test]
    fn rollback_restores_exact_prior_state() {
        let mut g = ndjson::decode("").unwrap();
        // Seed committed data (outside any explicit transaction).
        run(&mut g, "INSERT (:User {name: 'Seed', age: 1})");
        let before = ndjson::encode(&g);
        let vc_before = g.vertex_count();

        g.begin_tx();
        // A brand-new vertex (insert) and a mutation of the seed (property write).
        run(&mut g, "INSERT (:User {name: 'A'})");
        run(
            &mut g,
            "MATCH (u:User {name: 'Seed'}) SET u.name = 'Changed', u.age = 99",
        );
        // Read-your-writes: the staged inserts are visible inside the transaction.
        assert_eq!(g.vertex_count(), vc_before + 1);

        g.rollback_tx();

        assert_eq!(g.vertex_count(), vc_before, "vertex_count restored");
        assert_eq!(ndjson::encode(&g), before, "serialization byte-identical");
        // The seed's property values are exactly as before.
        let rows = parse("MATCH (u:User {name: 'Seed'}) RETURN u.age")
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap();
        assert_eq!(
            rows.rows().count(),
            1,
            "the changed-then-rolled-back seed is back"
        );
    }

    #[test]
    fn commit_persists() {
        let mut g = ndjson::decode("").unwrap();
        g.begin_tx();
        run(&mut g, "INSERT (:User {name: 'A'})");
        assert!(matches!(g.commit_tx(), Ok(())));
        assert_eq!(g.vertex_count(), 1, "the committed insert persists");
        assert!(!g.in_transaction());
    }

    #[test]
    fn rollback_restores_deleted_vertex_and_its_edge() {
        // DETACH DELETE cascades an edge removal; rollback must un-tombstone both
        // the vertex and the edge in place (byte-identical serialization).
        let mut g = ndjson::decode("").unwrap();
        run(
            &mut g,
            "INSERT (:User {name: 'A'})-[:KNOWS {since: 2020}]->(:User {name: 'B'})",
        );
        let before = ndjson::encode(&g);
        let (vc, ec) = (g.vertex_count(), g.edge_count());

        g.begin_tx();
        run(&mut g, "MATCH (u:User {name: 'A'}) DETACH DELETE u");
        assert_eq!(g.vertex_count(), vc - 1);
        assert_eq!(g.edge_count(), ec - 1);

        g.rollback_tx();

        assert_eq!(g.vertex_count(), vc, "vertex restored");
        assert_eq!(g.edge_count(), ec, "cascaded edge restored");
        assert_eq!(ndjson::encode(&g), before, "serialization byte-identical");
    }

    #[test]
    fn per_statement_atomicity_leaves_no_partial_write() {
        // A single INSERT of two rows whose second collides under a unique
        // constraint must leave ZERO rows — the whole statement rolls back.
        let mut g = ndjson::decode("").unwrap();
        g.create_unique_constraint("Acct", "email").unwrap();
        let err = parse("INSERT (:Acct {email: 'a@x.io'}), (:Acct {email: 'a@x.io'})")
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        assert_eq!(g.vertex_count(), 0, "the faulting statement left no trace");
    }
}

#[cfg(test)]
mod cardinality {
    //! R-CONSTRAINTS cardinality (degree bounds), exercised over the GQL eval
    //! path (each statement is an auto-commit frame, so max AND min land at the
    //! per-statement commit). Byte-identical to the TS core.
    use super::*;
    use crate::gql::eval::Params;
    use crate::gql::parse;
    use crate::ndjson;

    fn run(g: &mut Graph, q: &str) -> CodeResult<()> {
        parse(q).unwrap().execute(g, &Params::new()).map(|_| ())
    }

    #[test]
    fn exactly_one_via_gql_commit() {
        let mut g = ndjson::decode("").unwrap();
        g.create_cardinality_constraint("Purchase", "PLACED_BY", 0, 1, Some(1))
            .unwrap();

        // Node + mandatory edge in one INSERT (one auto-commit frame) satisfies it.
        run(
            &mut g,
            "INSERT (:Purchase {id: 'o1'})-[:PLACED_BY]->(:Customer {id: 'c1'})",
        )
        .unwrap();
        assert_eq!(g.vertex_count(), 2);

        // A bare Purchase with no PLACED_BY out-edge is degree 0 < min → rejected, and
        // the statement rolls back (no trace).
        let err = run(&mut g, "INSERT (:Purchase {id: 'o2'})").unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        assert_eq!(g.vertex_count(), 2, "the rejected INSERT left no trace");
    }

    #[test]
    fn over_max_is_rejected_at_commit() {
        let mut g = ndjson::decode("").unwrap();
        g.create_cardinality_constraint("Purchase", "PLACED_BY", 0, 0, Some(1))
            .unwrap();
        run(
            &mut g,
            "INSERT (:Purchase {id: 'o1'})-[:PLACED_BY]->(:Customer {id: 'c1'})",
        )
        .unwrap();
        // A second PLACED_BY out-edge from o1 pushes its out-degree to 2 > max 1.
        let err = run(
            &mut g,
            "MATCH (o:Purchase {id: 'o1'}), (c:Customer {id: 'c1'}) INSERT (o)-[:PLACED_BY]->(c)",
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        assert_eq!(g.edge_count(), 1, "the over-max edge rolled back");
    }

    #[test]
    fn remove_edge_below_min_rolls_back() {
        let mut g = ndjson::decode("").unwrap();
        run(
            &mut g,
            "INSERT (:Purchase {id: 'o1'})-[:PLACED_BY]->(:Customer {id: 'c1'})",
        )
        .unwrap();
        g.create_cardinality_constraint("Purchase", "PLACED_BY", 0, 1, Some(1))
            .unwrap();
        // Deleting the only PLACED_BY edge drops o1 to degree 0 < min → rejected.
        let err = run(&mut g, "MATCH (:Purchase)-[r:PLACED_BY]->() DELETE r").unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        assert_eq!(g.edge_count(), 1, "the delete rolled back");
    }

    #[test]
    fn declare_time_scan_and_self_loop_degree() {
        let mut g = ndjson::decode("").unwrap();
        run(&mut g, "INSERT (:Purchase {id: 'o1'})").unwrap(); // degree 0
                                                               // min:1 over existing degree-0 data → rejected at declare time.
        let err = g
            .create_cardinality_constraint("Purchase", "PLACED_BY", 0, 1, Some(1))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);

        // A self-loop counts once for out and once for in.
        run(
            &mut g,
            "MATCH (o:Purchase {id: 'o1'}) INSERT (o)-[:SELF]->(o)",
        )
        .unwrap();
        // The sole Purchase vertex is index 0 (first inserted); `id` is a property,
        // not the external vertex identity, so degree is read by index here.
        assert_eq!(g.out_degree(0, "SELF"), 1);
        assert_eq!(g.in_degree(0, "SELF"), 1);
    }

    #[test]
    fn drop_and_introspection() {
        let mut g = ndjson::decode("").unwrap();
        g.create_cardinality_constraint("Purchase", "PLACED_BY", 0, 1, Some(1))
            .unwrap();
        g.create_cardinality_constraint("Customer", "PRIMARY", 1, 0, Some(1))
            .unwrap();
        assert_eq!(
            g.cardinality_constraints(),
            vec![
                ("Customer".into(), "PRIMARY".into(), 1, 0, Some(1)),
                ("Purchase".into(), "PLACED_BY".into(), 0, 1, Some(1)),
            ]
        );
        // Re-declaring replaces the bounds (not a second entry).
        g.create_cardinality_constraint("Purchase", "PLACED_BY", 0, 0, None)
            .unwrap();
        assert_eq!(g.cardinality_constraints().len(), 2);
        g.drop_cardinality_constraint("Purchase", "PLACED_BY", 0);
        assert_eq!(
            g.cardinality_constraints(),
            vec![("Customer".into(), "PRIMARY".into(), 1, 0, Some(1))]
        );
        g.drop_cardinality_constraint("Purchase", "PLACED_BY", 0); // idempotent
    }
}

#[cfg(test)]
mod validator {
    //! R-CONSTRAINTS custom validators (a GQL boolean predicate per label),
    //! exercised over the GQL eval path (each statement is an auto-commit frame,
    //! so the predicate is re-checked against every touched element at the
    //! per-statement commit). SQL-`CHECK` semantics — a definite `false` fails, a
    //! null/unknown passes. Byte-identical to the TS `createValidator`.
    use super::*;
    use crate::gql::eval::Params;
    use crate::gql::parse;
    use crate::ndjson;

    fn run(g: &mut Graph, q: &str) -> CodeResult<()> {
        parse(q).unwrap().execute(g, &Params::new()).map(|_| ())
    }

    #[test]
    fn per_write_reject_accept_and_null_passes() {
        let mut g = ndjson::decode("").unwrap();
        g.create_validator("User", "u", "u.age >= 0 AND u.age < 150")
            .unwrap();

        let err = run(&mut g, "INSERT (:User {age: -5})").unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        assert_eq!(g.vertex_count(), 0, "the rejected INSERT left no trace");

        run(&mut g, "INSERT (:User {age: 20})").unwrap();
        // No `age` → `u.age` is null → predicate UNKNOWN → passes (SQL-CHECK).
        run(&mut g, "INSERT (:User {name: 'Ada'})").unwrap();
        run(&mut g, "INSERT (:User {age: null, name: 'Bo'})").unwrap();
        assert_eq!(g.vertex_count(), 3);
    }

    #[test]
    fn declare_time_scan_rejects_violating_data() {
        let mut g = ndjson::decode("").unwrap();
        run(&mut g, "INSERT (:User {age: -5})").unwrap();

        let err = g.create_validator("User", "u", "u.age >= 0").unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        // The rejected declaration registered nothing.
        assert!(g.validators().is_empty());
    }

    #[test]
    fn deferred_within_a_transaction() {
        // Briefly-invalid-then-fixed across an explicit multi-statement frame → the
        // final state satisfies the validator, so the transaction commits.
        let mut g2 = ndjson::decode("").unwrap();
        g2.create_validator("User", "u", "u.age >= 0").unwrap();
        g2.begin_tx();
        parse("INSERT (:User {id: 'a', age: -5})")
            .unwrap()
            .execute(&mut g2, &Params::new())
            .unwrap();
        parse("MATCH (u:User {id: 'a'}) SET u.age = 5")
            .unwrap()
            .execute(&mut g2, &Params::new())
            .unwrap();
        assert!(g2.commit_tx().is_ok(), "final state valid → commits");
        assert_eq!(g2.vertex_count(), 1);

        // Left invalid across the frame → the whole transaction rolls back.
        let mut g3 = ndjson::decode("").unwrap();
        g3.create_validator("User", "u", "u.age >= 0").unwrap();
        g3.begin_tx();
        parse("INSERT (:User {id: 'b', age: -1})")
            .unwrap()
            .execute(&mut g3, &Params::new())
            .unwrap();
        let err = g3.commit_tx().unwrap_err();
        assert!(matches!(err, TxCommitError::Validator(_)));
        g3.rollback_tx();
        assert_eq!(g3.vertex_count(), 0, "rolled back");
    }

    #[test]
    fn edge_validator() {
        let mut g = ndjson::decode("").unwrap();
        g.create_validator("KNOWS", "r", "r.weight >= 0").unwrap();

        let err = run(
            &mut g,
            "INSERT (:P {name: 'a'})-[:KNOWS {weight: -1}]->(:P {name: 'b'})",
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        assert_eq!(g.edge_count(), 0, "rejected edge left no trace");

        run(
            &mut g,
            "INSERT (:P {name: 'a'})-[:KNOWS {weight: 5}]->(:P {name: 'b'})",
        )
        .unwrap();
        assert_eq!(g.edge_count(), 1);
    }

    #[test]
    fn drop_and_introspection() {
        let mut g = ndjson::decode("").unwrap();
        g.create_validator("User", "u", "u.age >= 0").unwrap();
        g.create_validator("User", "u", "u.age < 150").unwrap();

        assert_eq!(
            g.validators(),
            vec![
                ("User".into(), "u".into(), "u.age < 150".into()),
                ("User".into(), "u".into(), "u.age >= 0".into()),
            ]
        );

        g.drop_validator("User");
        assert!(g.validators().is_empty());
        // No validator left → a previously-rejected write now succeeds.
        run(&mut g, "INSERT (:User {age: -5})").unwrap();
        assert_eq!(g.vertex_count(), 1);
    }

    #[test]
    fn unparseable_predicate_is_a_syntax_error() {
        let mut g = ndjson::decode("").unwrap();
        assert_eq!(
            g.create_validator("User", "u", "u.age >>>")
                .unwrap_err()
                .code,
            ErrorCode::Syntax
        );
        assert_eq!(
            g.create_validator("User", "u", "").unwrap_err().code,
            ErrorCode::Syntax
        );
        // A predicate smuggling in an extra clause is rejected too.
        assert_eq!(
            g.create_validator("User", "u", "true RETURN 1")
                .unwrap_err()
                .code,
            ErrorCode::Syntax
        );
    }
}

#[cfg(test)]
mod invariant {
    //! Graph-level INVARIANTS (cross-write assertions): a whole-graph GQL query
    //! run ONCE per write transaction against the fully-staged graph. `false`-only
    //! -fails — VIOLATED iff a result cell is boolean `false`; everything else
    //! (`true`/`null`/non-boolean/empty) holds. Enforced in `commit_tx` after the
    //! per-element deferred checks, and only when the transaction wrote something.
    //! Byte-identical to the TS `createInvariant`.
    use super::*;
    use crate::gql::eval::Params;
    use crate::gql::parse;
    use crate::ndjson;

    fn run(g: &mut Graph, q: &str) -> CodeResult<()> {
        parse(q).unwrap().execute(g, &Params::new()).map(|_| ())
    }

    // Two accounts summing to zero; the classic double-entry ledger. The `name`
    // property (not the ndjson node id) is what MATCH patterns key on.
    const LEDGER: &str = "\
{\"type\":\"node\",\"id\":\"a\",\"labels\":[\"Acct\"],\"properties\":{\"name\":\"a\",\"balance\":100}}
{\"type\":\"node\",\"id\":\"b\",\"labels\":[\"Acct\"],\"properties\":{\"name\":\"b\",\"balance\":-100}}";

    #[test]
    fn balanced_transfer_commits_unbalanced_rolls_back() {
        let mut g = ndjson::decode(LEDGER).unwrap();
        g.create_invariant("balanced", "MATCH (a:Acct) RETURN sum(a.balance) = 0")
            .unwrap();

        // A transfer that keeps the sum at zero commits.
        g.begin_tx();
        run(&mut g, "MATCH (a:Acct {name: 'a'}) SET a.balance = 70").unwrap();
        run(&mut g, "MATCH (b:Acct {name: 'b'}) SET b.balance = -70").unwrap();
        assert!(g.commit_tx().is_ok(), "sum still 0 → commits");

        // An unbalanced half-transfer rolls the whole transaction back.
        g.begin_tx();
        run(&mut g, "MATCH (a:Acct {name: 'a'}) SET a.balance = 999").unwrap();
        let err = g.commit_tx().unwrap_err();
        assert!(matches!(err, TxCommitError::Invariant(_)));
        g.rollback_tx();

        // The balances are unchanged from the last good commit (70 / -70).
        let rows = parse("MATCH (a:Acct) RETURN sum(a.balance) AS s")
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap();
        assert_eq!(rows.row(0)[0], Value::Num(0.0));
    }

    #[test]
    fn single_statement_unbalanced_write_rejected() {
        // Every GQL statement auto-commits, so a single unbalanced SET trips the
        // invariant at its own commit boundary (no explicit transaction needed).
        let mut g = ndjson::decode(LEDGER).unwrap();
        g.create_invariant("balanced", "MATCH (a:Acct) RETURN sum(a.balance) = 0")
            .unwrap();

        let err = run(&mut g, "MATCH (a:Acct {name: 'a'}) SET a.balance = 5").unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        // Rolled back — the balance is still 100.
        let rows = parse("MATCH (a:Acct {name: 'a'}) RETURN a.balance AS b")
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap();
        assert_eq!(rows.row(0)[0], Value::Num(100.0));
    }

    #[test]
    fn declare_time_rejects_already_violating_graph() {
        let mut g = ndjson::decode(LEDGER).unwrap();
        run(&mut g, "MATCH (a:Acct {name: 'a'}) SET a.balance = 5").ok(); // no invariant yet → fine
                                                                          // Now the sum is -95, so declaring the invariant must reject.
        let err = g
            .create_invariant("balanced", "MATCH (a:Acct) RETURN sum(a.balance) = 0")
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        assert!(
            g.invariants().is_empty(),
            "rejected declaration stored nothing"
        );
    }

    #[test]
    fn count_invariant_at_least_one_admin() {
        let seed = "\
{\"type\":\"node\",\"id\":\"u1\",\"labels\":[\"User\"],\"properties\":{\"name\":\"u1\",\"role\":\"Admin\"}}
{\"type\":\"node\",\"id\":\"u2\",\"labels\":[\"User\"],\"properties\":{\"name\":\"u2\",\"role\":\"Member\"}}";
        let mut g = ndjson::decode(seed).unwrap();
        g.create_invariant(
            "has_admin",
            "MATCH (u:User) WHERE u.role = 'Admin' RETURN count(u) > 0",
        )
        .unwrap();

        // Demote the member → still one admin → holds.
        run(&mut g, "MATCH (u:User {name: 'u2'}) SET u.role = 'Guest'").unwrap();
        // Demote the last admin → count drops to 0 → violated, rolled back.
        let err = run(&mut g, "MATCH (u:User {name: 'u1'}) SET u.role = 'Guest'").unwrap_err();
        assert_eq!(err.code, ErrorCode::ConstraintViolation);
        let rows = parse("MATCH (u:User {role: 'Admin'}) RETURN count(u) AS n")
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap();
        assert_eq!(rows.row(0)[0], Value::Num(1.0));
    }

    #[test]
    fn pure_read_transaction_does_not_run_the_invariant() {
        // The gate proof: with the graph in a state that VIOLATES the invariant, a
        // pure-read transaction must still commit (the invariant is not run), while
        // a transaction that writes anything trips it. We break the sum via the
        // direct store API (which bypasses the GQL auto-commit that would catch it)
        // to set up a violating-but-committed state.
        let mut g = ndjson::decode(LEDGER).unwrap();
        g.create_invariant("balanced", "MATCH (a:Acct) RETURN sum(a.balance) = 0")
            .unwrap();

        // Directly skew one balance so the sum is now -50 (invariant would fail).
        let vi = g.vertex_indices().next().unwrap();
        g.set_vertex_prop(vi, "balance", Value::Num(50.0));

        // A pure-read transaction commits — the invariant is skipped (nothing written).
        g.begin_tx();
        parse("MATCH (a:Acct) RETURN a.balance")
            .unwrap()
            .execute(&mut g, &Params::new())
            .unwrap();
        assert!(g.commit_tx().is_ok(), "pure-read commit skips invariants");

        // But a transaction that writes runs the invariant against the (violating)
        // staged graph and rolls back.
        g.begin_tx();
        run(&mut g, "MATCH (a:Acct {name: 'b'}) SET a.balance = -100").unwrap();
        assert!(
            matches!(g.commit_tx().unwrap_err(), TxCommitError::Invariant(_)),
            "a writing commit runs the invariant"
        );
        g.rollback_tx();
    }

    #[test]
    fn drop_and_introspection() {
        let mut g = ndjson::decode(LEDGER).unwrap();
        g.create_invariant("balanced", "MATCH (a:Acct) RETURN sum(a.balance) = 0")
            .unwrap();
        g.create_invariant("has_acct", "MATCH (a:Acct) RETURN count(a) >= 0")
            .unwrap();
        assert_eq!(
            g.invariants(),
            vec![
                (
                    "balanced".into(),
                    "MATCH (a:Acct) RETURN sum(a.balance) = 0".into()
                ),
                (
                    "has_acct".into(),
                    "MATCH (a:Acct) RETURN count(a) >= 0".into()
                ),
            ]
        );

        g.drop_invariant("balanced");
        assert_eq!(
            g.invariants(),
            vec![(
                "has_acct".into(),
                "MATCH (a:Acct) RETURN count(a) >= 0".into()
            )]
        );
        // Dropped → a previously-rejected unbalanced write now succeeds.
        run(&mut g, "MATCH (a:Acct {name: 'a'}) SET a.balance = 5").unwrap();
    }

    #[test]
    fn unparseable_query_is_a_syntax_error() {
        let mut g = ndjson::decode("").unwrap();
        assert_eq!(
            g.create_invariant("bad", "MATCH (a:Acct) RETURN >>>")
                .unwrap_err()
                .code,
            ErrorCode::Syntax
        );
        assert_eq!(
            g.create_invariant("empty", "").unwrap_err().code,
            ErrorCode::Syntax
        );
    }

    #[test]
    fn non_boolean_and_null_and_empty_all_hold() {
        // `false`-only-fails: a non-boolean cell, a null cell, and an empty result
        // set each HOLD (only a literal `false` cell fails).
        let mut g = ndjson::decode(LEDGER).unwrap();
        g.create_invariant("nonbool", "MATCH (a:Acct) RETURN sum(a.balance)")
            .unwrap(); // yields 0 (a number, not false) → holds
        g.create_invariant("nullcell", "MATCH (a:Acct) RETURN a.missing")
            .unwrap(); // null cells → hold
        g.create_invariant("empty", "MATCH (z:NoSuchLabel) RETURN z.x = z.x")
            .unwrap(); // empty result → holds
                       // A write still commits (all three hold regardless of the balance sum).
        run(&mut g, "MATCH (a:Acct {name: 'a'}) SET a.balance = 12345").unwrap();
    }
}
