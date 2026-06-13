//! Columnar LPG: dense u32 vertex indices, dictionary-encoded labels/keys,
//! typed property columns (contiguous — SIMD-scannable), and CSR adjacency.
//!
//! Property model: a key's column is typed by its first non-null value
//! (Num=f64 to match the JS float64 value model, Str=interned, Bool). Values
//! that don't fit a key's column land in a `Mixed` fallback so round-trips stay
//! lossless. Absent slots are tracked by a presence bitset; numeric absents are
//! stored as NaN so a SIMD predicate scan over the contiguous f64 naturally
//! rejects them.

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

/// Compact presence bitset (1 bit/vertex).
#[derive(Debug, Clone)]
pub struct BitSet {
    words: Vec<u64>,
}

impl BitSet {
    pub fn zeros(n: usize) -> Self {
        BitSet { words: vec![0u64; n.div_ceil(64)] }
    }
    #[inline]
    pub fn set(&mut self, i: usize) {
        self.words[i >> 6] |= 1u64 << (i & 63);
    }
    #[inline]
    pub fn get(&self, i: usize) -> bool {
        (self.words[i >> 6] >> (i & 63)) & 1 == 1
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

/// A typed property column. Length == graph vertex count.
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

/// The columnar graph.
pub struct Graph {
    pub n: usize,
    /// external string id <-> dense index
    pub vid: Dict,
    pub labels: Dict,
    /// CSR: vertex -> its label ids
    pub vlabel_off: Vec<u32>,
    pub vlabel_flat: Vec<u32>,
    /// inverted: label -> vertices (CSR), for label-scan query seeds
    pub by_label_off: Vec<u32>,
    pub by_label_vts: Vec<u32>,
    pub keys: Dict,
    pub strs: Dict,
    pub cols: HashMap<u32, Column>,
    /// edges (parallel arrays) + edge-type dict
    pub etype: Dict,
    pub e_src: Vec<u32>,
    pub e_dst: Vec<u32>,
    pub e_type: Vec<u32>,
    /// CSR out-adjacency (neighbor + its edge type, grouped by source)
    pub out_off: Vec<u32>,
    pub out_nbr: Vec<u32>,
    pub out_etype: Vec<u32>,
}

impl Graph {
    pub fn edge_count(&self) -> usize {
        self.e_src.len()
    }

    /// Out-neighbors of `v` whose edge type is `etype` (or all if `None`).
    pub fn out_neighbors(&self, v: u32, etype: Option<u32>) -> impl Iterator<Item = u32> + '_ {
        let start = self.out_off[v as usize] as usize;
        let end = self.out_off[v as usize + 1] as usize;
        (start..end).filter_map(move |i| match etype {
            Some(t) if self.out_etype[i] != t => None,
            _ => Some(self.out_nbr[i]),
        })
    }

    /// Does vertex `v` carry label id `l`?
    pub fn has_label(&self, v: u32, l: u32) -> bool {
        let s = self.vlabel_off[v as usize] as usize;
        let e = self.vlabel_off[v as usize + 1] as usize;
        self.vlabel_flat[s..e].contains(&l)
    }

    /// Vertices carrying label `l` (a contiguous slice of the inverted index).
    pub fn vertices_with_label(&self, l: u32) -> &[u32] {
        let s = self.by_label_off[l as usize] as usize;
        let e = self.by_label_off[l as usize + 1] as usize;
        &self.by_label_vts[s..e]
    }
}

// ---------------------------------------------------------------------------
// Builder: accumulate node/edge records, then finalize into the columnar form.
// This `finalize` is the "build the graph" hot path the benchmark measures.
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
}

#[derive(Default)]
pub struct Builder {
    pub nodes: Vec<NodeRec>,
    pub edges: Vec<EdgeRec>,
}

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

/// Exclusive prefix sum producing an (n+1)-length offsets array ending in total.
fn offsets_from_degrees(deg: &[u32]) -> Vec<u32> {
    let mut off = vec![0u32; deg.len() + 1];
    let mut acc = 0u32;
    for (i, &d) in deg.iter().enumerate() {
        off[i] = acc;
        acc += d;
    }
    off[deg.len()] = acc;
    off
}

impl Builder {
    pub fn finalize(self) -> Graph {
        let Builder { nodes, edges } = self;
        let mut vid = Dict::default();

        // (1) Assign dense indices to declared nodes, in order.
        for node in &nodes {
            vid.intern(&node.id);
        }
        // (2) Ensure edge endpoints exist (bare vertices for undeclared ids).
        for e in &edges {
            vid.intern(&e.src);
            vid.intern(&e.dst);
        }
        let n = vid.len();

        // (3) Labels: per-vertex CSR + inverted (label -> vertices) CSR.
        let mut labels = Dict::default();
        let mut node_label_ids: Vec<Vec<u32>> = vec![Vec::new(); n];
        for node in &nodes {
            let vi = vid.get(&node.id).unwrap() as usize;
            for l in &node.labels {
                node_label_ids[vi].push(labels.intern(l));
            }
        }
        let mut vlabel_deg = vec![0u32; n];
        for (vi, ls) in node_label_ids.iter().enumerate() {
            vlabel_deg[vi] = ls.len() as u32;
        }
        let vlabel_off = offsets_from_degrees(&vlabel_deg);
        let mut vlabel_flat = vec![0u32; vlabel_off[n] as usize];
        {
            let mut cursor = vlabel_off.clone();
            for (vi, ls) in node_label_ids.iter().enumerate() {
                for &l in ls {
                    let p = cursor[vi] as usize;
                    vlabel_flat[p] = l;
                    cursor[vi] += 1;
                }
            }
        }
        // inverted: count vertices per label, scatter
        let n_labels = labels.len();
        let mut label_deg = vec![0u32; n_labels.max(1)];
        for ls in &node_label_ids {
            for &l in ls {
                label_deg[l as usize] += 1;
            }
        }
        let by_label_off = offsets_from_degrees(&label_deg);
        let mut by_label_vts = vec![0u32; by_label_off[n_labels.max(1)] as usize];
        {
            let mut cursor = by_label_off.clone();
            for (vi, ls) in node_label_ids.iter().enumerate() {
                for &l in ls {
                    let p = cursor[l as usize] as usize;
                    by_label_vts[p] = vi as u32;
                    cursor[l as usize] += 1;
                }
            }
        }

        // (4) Property columns: infer kind per key, then fill.
        let mut keys = Dict::default();
        let mut kinds: HashMap<u32, Kind> = HashMap::new();
        for node in &nodes {
            for (k, v) in &node.props {
                let kid = keys.intern(k);
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
        let mut strs = Dict::default();
        let mut cols: HashMap<u32, Column> = HashMap::new();
        for (&kid, &kind) in &kinds {
            let col = match kind {
                Kind::Num => Column::Num { data: vec![f64::NAN; n], present: BitSet::zeros(n) },
                Kind::Str => Column::Str { data: vec![u32::MAX; n], present: BitSet::zeros(n) },
                Kind::Bool => Column::Bool { data: vec![false; n], present: BitSet::zeros(n) },
                Kind::Mixed => Column::Mixed { data: vec![None; n] },
            };
            cols.insert(kid, col);
        }
        for node in &nodes {
            let vi = vid.get(&node.id).unwrap() as usize;
            for (k, v) in &node.props {
                let kid = keys.get(k).unwrap();
                let col = cols.get_mut(&kid).unwrap();
                match (col, v) {
                    (Column::Num { data, present }, Value::Num(x)) => {
                        data[vi] = *x;
                        present.set(vi);
                    }
                    (Column::Str { data, present }, Value::Str(s)) => {
                        data[vi] = strs.intern(s);
                        present.set(vi);
                    }
                    (Column::Bool { data, present }, Value::Bool(b)) => {
                        data[vi] = *b;
                        present.set(vi);
                    }
                    (Column::Mixed { data }, val) => {
                        data[vi] = Some(val.clone());
                    }
                    // value disagrees with an inferred non-Mixed column (e.g. a
                    // stray null) — leave absent.
                    _ => {}
                }
            }
        }

        // (5) Edges -> parallel arrays + out-CSR (counting sort by source).
        let mut etype = Dict::default();
        let e = edges.len();
        let mut e_src = vec![0u32; e];
        let mut e_dst = vec![0u32; e];
        let mut e_type = vec![0u32; e];
        for (i, ed) in edges.iter().enumerate() {
            e_src[i] = vid.get(&ed.src).unwrap();
            e_dst[i] = vid.get(&ed.dst).unwrap();
            e_type[i] = etype.intern(&ed.etype);
        }
        let mut out_deg = vec![0u32; n];
        for &s in &e_src {
            out_deg[s as usize] += 1;
        }
        let out_off = offsets_from_degrees(&out_deg);
        let mut out_nbr = vec![0u32; e];
        let mut out_etype = vec![0u32; e];
        {
            let mut cursor = out_off.clone();
            for i in 0..e {
                let s = e_src[i] as usize;
                let p = cursor[s] as usize;
                out_nbr[p] = e_dst[i];
                out_etype[p] = e_type[i];
                cursor[s] += 1;
            }
        }

        Graph {
            n,
            vid,
            labels,
            vlabel_off,
            vlabel_flat,
            by_label_off,
            by_label_vts,
            keys,
            strs,
            cols,
            etype,
            e_src,
            e_dst,
            e_type,
            out_off,
            out_nbr,
            out_etype,
        }
    }
}
