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

use std::collections::HashMap;

/// String interner: `intern` is amortized O(1), `text` reverses.
#[derive(Default, Debug)]
pub struct Dict {
    map: HashMap<String, u32>,
    pub strings: Vec<String>,
}

impl Dict {
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.map.get(s) {
            return id;
        }
        let id = self.strings.len() as u32;
        self.strings.push(s.to_string());
        self.map.insert(s.to_string(), id);
        id
    }
    pub fn get(&self, s: &str) -> Option<u32> {
        self.map.get(s).copied()
    }
    pub fn text(&self, id: u32) -> &str {
        &self.strings[id as usize]
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
        BitSet { words: vec![0u64; n.div_ceil(64)] }
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
        self.words.get(i >> 6).is_some_and(|w| (w >> (i & 63)) & 1 == 1)
    }
}

/// A JSON-ish scalar/list value, matching the vendor-neutral LPG value model.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Value>),
}

/// A typed property column. Length == its store's element count.
#[derive(Debug)]
pub enum Column {
    /// Numbers as f64 (absent = NaN, also flagged in `present`).
    Num { data: Vec<f64>, present: BitSet },
    /// Interned string ids (absent = u32::MAX).
    Str { data: Vec<u32>, present: BitSet },
    Bool { data: Vec<bool>, present: BitSet },
    /// Heterogeneous / list / mixed-type keys: keep the raw values.
    Mixed { data: Vec<Option<Value>> },
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
    pub cols: HashMap<u32, Column>,
    /// Element count the columns are sized to (vertex count, or edge count).
    pub len: usize,
}

impl Properties {
    /// The column for `key`, if any.
    pub fn col(&self, key: &str) -> Option<&Column> {
        self.keys.get(key).and_then(|kid| self.cols.get(&kid))
    }

    /// Value at element `idx` for `key` as a core [`Value`] (absent → `Null`).
    /// `strs` is the graph-wide interner backing `Column::Str`.
    pub fn value(&self, idx: usize, key: &str, strs: &Dict) -> Value {
        match self.col(key) {
            Some(Column::Num { data, present }) if present.get(idx) => Value::Num(data[idx]),
            Some(Column::Bool { data, present }) if present.get(idx) => Value::Bool(data[idx]),
            Some(Column::Str { data, present }) if present.get(idx) => {
                Value::Str(strs.text(data[idx]).to_string())
            }
            Some(Column::Mixed { data }) => data[idx].clone().unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }

    /// Append one element slot (absent in every existing column).
    fn push_element(&mut self) {
        for col in self.cols.values_mut() {
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
        let kid = self.keys.intern(key);
        let len = self.len;
        let col = self.cols.entry(kid).or_insert_with(|| empty_col_for(&v, len));
        if !col_set(col, idx, &v, strs) {
            // type mismatch — promote the column to Mixed, then set.
            *col = to_mixed(col, strs);
            col_set(col, idx, &v, strs);
        }
    }

    /// Remove element `idx`'s `key` (no-op if absent).
    pub fn remove_value(&mut self, idx: usize, key: &str) {
        if let Some(kid) = self.keys.get(key) {
            if let Some(col) = self.cols.get_mut(&kid) {
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
    e_live: Vec<bool>,
    live_e: usize,
    /// per-vertex out / in adjacency (the mutable replacement for CSR)
    out: Vec<Vec<Adj>>,
    in_: Vec<Vec<Adj>>,
    /// counter for synthesized ids of vertices created at runtime
    synth: u64,
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
        self.out[v as usize].iter().filter_map(move |a| match etype {
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
            self.props.set_value(vi as usize, &k, v, &mut self.strs);
        }
        self.n += 1;
        vi
    }

    /// Add an edge `from -> to` of `etype` with properties; returns its index.
    pub fn add_edge(&mut self, from: u32, to: u32, etype: &str, props: Vec<(String, Value)>) -> u32 {
        let ei = self.e_src.len() as u32;
        let tid = self.etype.intern(etype);
        self.e_src.push(from);
        self.e_dst.push(to);
        self.e_type.push(tid);
        self.e_live.push(true);
        self.live_e += 1;
        self.out[from as usize].push(Adj { eidx: ei, nbr: to, etype: tid });
        self.in_[to as usize].push(Adj { eidx: ei, nbr: from, etype: tid });
        self.edge_props.push_element();
        for (k, v) in props {
            self.edge_props.set_value(ei as usize, &k, v, &mut self.strs);
        }
        ei
    }

    pub fn set_vertex_prop(&mut self, vi: u32, key: &str, v: Value) {
        self.props.set_value(vi as usize, key, v, &mut self.strs);
    }
    pub fn remove_vertex_prop(&mut self, vi: u32, key: &str) {
        self.props.remove_value(vi as usize, key);
    }
    pub fn set_edge_prop(&mut self, ei: u32, key: &str, v: Value) {
        self.edge_props.set_value(ei as usize, key, v, &mut self.strs);
    }
    pub fn remove_edge_prop(&mut self, ei: u32, key: &str) {
        self.edge_props.remove_value(ei as usize, key);
    }

    pub fn add_vertex_label(&mut self, vi: u32, name: &str) {
        let lid = self.labels.intern(name);
        if !self.vlabels[vi as usize].contains(&lid) {
            self.vlabels[vi as usize].push(lid);
            self.by_label.entry(lid).or_default().push(vi);
        }
    }
    pub fn remove_vertex_label(&mut self, vi: u32, name: &str) {
        if let Some(lid) = self.labels.get(name) {
            self.vlabels[vi as usize].retain(|&x| x != lid);
            if let Some(bucket) = self.by_label.get_mut(&lid) {
                bucket.retain(|&x| x != vi);
            }
        }
    }

    /// An edge carries a single type; relabelling replaces it (last wins).
    pub fn add_edge_label(&mut self, ei: u32, name: &str) {
        let tid = self.etype.intern(name);
        let i = ei as usize;
        self.e_type[i] = tid;
        let (src, dst) = (self.e_src[i] as usize, self.e_dst[i] as usize);
        for a in self.out[src].iter_mut().filter(|a| a.eidx == ei) {
            a.etype = tid;
        }
        for a in self.in_[dst].iter_mut().filter(|a| a.eidx == ei) {
            a.etype = tid;
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
        self.e_live[i] = false;
        self.live_e -= 1;
        let (src, dst) = (self.e_src[i] as usize, self.e_dst[i] as usize);
        self.out[src].retain(|a| a.eidx != ei);
        self.in_[dst].retain(|a| a.eidx != ei);
    }

    /// Delete a vertex. Without `detach`, a vertex that still has edges is an
    /// error (ISO/Cypher semantics); with `detach`, incident edges go first.
    pub fn remove_vertex(&mut self, vi: u32, detach: bool) -> Result<(), String> {
        let i = vi as usize;
        if !self.is_vertex_live(vi) {
            return Ok(());
        }
        let incident: Vec<u32> =
            self.out[i].iter().chain(self.in_[i].iter()).map(|a| a.eidx).collect();
        if !detach && !incident.is_empty() {
            return Err("cannot delete a vertex that still has relationships; use DETACH DELETE".to_string());
        }
        for ei in incident {
            self.remove_edge(ei);
        }
        for lid in self.vlabels[i].clone() {
            if let Some(bucket) = self.by_label.get_mut(&lid) {
                bucket.retain(|&x| x != vi);
            }
        }
        self.vlabels[i].clear();
        self.out[i].clear();
        self.in_[i].clear();
        self.v_live[i] = false;
        self.live_n -= 1;
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
        Some(Kind::Num) => Column::Num { data: vec![f64::NAN; len], present: BitSet::zeros(len) },
        Some(Kind::Str) => Column::Str { data: vec![u32::MAX; len], present: BitSet::zeros(len) },
        Some(Kind::Bool) => Column::Bool { data: vec![false; len], present: BitSet::zeros(len) },
        _ => Column::Mixed { data: vec![None; len] },
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
            Column::Str { data, present } if present.get(i) => Some(Value::Str(strs.text(data[i]).to_string())),
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
    let mut props = Properties { keys: Dict::default(), cols: HashMap::new(), len };
    // Pre-create columns from inferred kinds so the first value of each key
    // lands in a typed column (mutation promotes to Mixed only on conflict).
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
    for (&kid, &kind) in &kinds {
        let col = match kind {
            Kind::Num => Column::Num { data: vec![f64::NAN; len], present: BitSet::zeros(len) },
            Kind::Str => Column::Str { data: vec![u32::MAX; len], present: BitSet::zeros(len) },
            Kind::Bool => Column::Bool { data: vec![false; len], present: BitSet::zeros(len) },
            Kind::Mixed => Column::Mixed { data: vec![None; len] },
        };
        props.cols.insert(kid, col);
    }
    for (idx, item) in items {
        for (k, v) in *item {
            if !matches!(v, Value::Null) {
                let kid = props.keys.get(k).unwrap();
                let col = props.cols.get_mut(&kid).unwrap();
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
        let node_items: Vec<(usize, &[(String, Value)])> =
            nodes.iter().map(|nd| (vid.get(&nd.id).unwrap() as usize, nd.props.as_slice())).collect();
        let props = build_props(n, &node_items, &mut strs);

        // (4) Edges: parallel arrays + per-vertex out/in adjacency.
        let mut etype = Dict::default();
        let e = edges.len();
        let mut e_src = vec![0u32; e];
        let mut e_dst = vec![0u32; e];
        let mut e_type = vec![0u32; e];
        let mut out: Vec<Vec<Adj>> = vec![Vec::new(); n];
        let mut in_: Vec<Vec<Adj>> = vec![Vec::new(); n];
        for (i, ed) in edges.iter().enumerate() {
            let s = vid.get(&ed.src).unwrap();
            let d = vid.get(&ed.dst).unwrap();
            let t = etype.intern(&ed.etype);
            e_src[i] = s;
            e_dst[i] = d;
            e_type[i] = t;
            out[s as usize].push(Adj { eidx: i as u32, nbr: d, etype: t });
            in_[d as usize].push(Adj { eidx: i as u32, nbr: s, etype: t });
        }

        // (5) Edge property columns — same machinery, indexed by edge index.
        let edge_items: Vec<(usize, &[(String, Value)])> =
            edges.iter().enumerate().map(|(i, ed)| (i, ed.props.as_slice())).collect();
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
            e_live: vec![true; e],
            live_e: e,
            out,
            in_,
            synth: 0,
        }
    }
}
