//! NDJSON egress/ingest: dump/load a store as newline-delimited JSON — one object
//! per live node, then one per edge. Dependency-free (a small hand-rolled JSON
//! writer, no serde) and deterministic (nodes by id; labels and property keys
//! sorted; edges in adjacency order).
//!
//! Emits the SHIPPED shape (byte-shape-compatible with
//! `@lenke/serialization`) so NDJSON is interchangeable across the engines (ids
//! are PRESERVED external ids — strings; a numeric id on ingest is kept as text):
//! - node: `{"type":"node","id":"N","labels":[...],"properties":{...}}`
//! - edge: `{"type":"edge","id":"E","from":"F","to":"T","labels":["R",...],"properties":{...}}`
//!
//! Ingest is lenient: it ALSO reads the engine's earlier shape (node `{"id",…,
//! "props"}`, edge `{"from","to","type":"<etype>","props"}`), so anything the
//! engine wrote before still loads. Property key ORDER is unspecified (each engine
//! emits its own), so cross-engine comparison is structural, not byte-identical.
//!
//! This module SERIALIZES values; it does not define value semantics (order,
//! equality) — those stay in [`crate::value`]. A non-finite number (NaN/Inf) has
//! no JSON form and is written as `null`, consistent with the engine's
//! NaN/Inf→null policy.

use crate::gstr::GStr;
use std::borrow::Cow;
use std::sync::Arc;

use crate::store::Store;
use crate::value::Value;

// Multicore NDJSON parse (feature `parallel`, native-only): the parse phase stages
// disjoint line-chunks in parallel; the store build stays serial (ids in input order).
#[cfg(feature = "parallel")]
use rayon::prelude::*;

/// The store as NDJSON: a line per live node, then a line per edge, ending with a
/// trailing newline when non-empty. Uses the graph's configured
/// [`Store::effective_parallelism`] (serial by default); see [`to_ndjson_threads`] to
/// pick the thread count explicitly.
#[must_use]
pub fn to_ndjson(store: &Store) -> String {
    to_ndjson_threads(store, store.effective_parallelism())
}

/// The store as NDJSON, rendered with up to `threads` workers. `threads <= 1` (or a
/// build without the `parallel` feature) runs the serial path. Output is byte-identical
/// at any thread count — nodes then edges are split on contiguous id ranges and
/// concatenated in order.
#[must_use]
pub fn to_ndjson_threads(store: &Store, threads: u32) -> String {
    let node_keys = store.prop_keys();
    let edge_keys = store.edge_prop_keys();
    // Resolve each node property column ONCE, in key order — the node loop then reads
    // cells with no hashmap lookup per node.
    let node_cols: Vec<(&str, &crate::store::Column)> = node_keys
        .iter()
        .filter_map(|k| store.column(k).map(|c| (k.as_str(), c)))
        .collect();
    let n = u32::try_from(store.node_count()).unwrap_or(u32::MAX);

    // One node's line and one node's whole out-edge run, as the SINGLE source of truth
    // for both the serial and parallel paths (so they are byte-identical). Each appends
    // to a caller-owned buffer and reads only immutable store state, so a parallel
    // renderer can format disjoint id ranges into private buffers and concatenate them
    // in id order — the exact serial byte sequence (see `parallel::concat_ranges`).
    let fmt_node = |out: &mut String, id: u32| {
        if !store.is_alive(id) {
            return;
        }
        // The SHIPPED shape (@lenke/serialization): a `type` discriminator,
        // `properties` (not `props`), and the PRESERVED external id. Ids and labels are
        // BORROWED (`&str`) — no per-node `GStr` clone or `Vec<String>` of cloned labels.
        out.push_str("{\"type\":\"node\",\"id\":");
        encode_string(out, store.node_ext_id_ref(id).unwrap_or(""));
        out.push_str(",\"labels\":");
        encode_str_array(out, &store.labels_of_refs(id));
        out.push_str(",\"properties\":");
        encode_object_cols(out, &node_cols, id as usize);
        out.push_str("}\n");
    };
    let fmt_out_edges = |out: &mut String, from: u32| {
        if !store.is_alive(from) {
            return;
        }
        for a in store.out(from) {
            let eid = a.eid;
            // An edge carries a type SET in `labels` (first = primary type), like the
            // TS engine — not a single `type` string.
            out.push_str("{\"type\":\"edge\",\"id\":");
            encode_string(out, store.edge_ext_id_ref(eid).unwrap_or(""));
            out.push_str(",\"from\":");
            encode_string(out, store.node_ext_id_ref(from).unwrap_or(""));
            out.push_str(",\"to\":");
            encode_string(out, store.node_ext_id_ref(a.nbr).unwrap_or(""));
            out.push_str(",\"labels\":");
            encode_str_array(out, &store.edge_labels_of(eid));
            out.push_str(",\"properties\":");
            encode_object(out, &edge_keys, |k| {
                store.has_edge_prop(eid, k).then(|| store.edge_prop(eid, k))
            });
            out.push_str("}\n");
        }
    };

    // Nodes (ascending id), then edges (by ascending `from`, out-adjacency order within).
    // Both sections split cleanly on contiguous id ranges, so parallel rendering
    // concatenated in range order reproduces the serial bytes exactly.
    #[cfg(feature = "parallel")]
    if threads > 1 {
        let nodes = crate::parallel::concat_ranges(threads, n, |lo, hi| {
            let mut s = String::new();
            for id in lo..hi {
                fmt_node(&mut s, id);
            }
            s
        });
        let edges = crate::parallel::concat_ranges(threads, n, |lo, hi| {
            let mut s = String::new();
            for from in lo..hi {
                fmt_out_edges(&mut s, from);
            }
            s
        });
        return nodes + &edges;
    }
    #[cfg(not(feature = "parallel"))]
    let _ = threads;

    // Pre-size so the buffer does not repeatedly reallocate mid-stream (~96 B/element).
    let mut out = String::with_capacity((store.node_count() + store.edge_count()) * 96);
    for id in 0..n {
        fmt_node(&mut out, id);
    }
    for from in 0..n {
        fmt_out_edges(&mut out, from);
    }
    out
}

/// The store's SCHEMA as NDJSON — the unique and required constraints, one per
/// line (`{"schema":"unique","label":..,"keys":[..]}` /
/// `{"schema":"required","label":..,"key":..}`). Each group sorted for
/// determinism. These lines lead a [`snapshot`] so they apply before the data.
#[must_use]
pub fn dump_schema(store: &Store) -> String {
    let mut out = String::new();
    let mut uniques = store.unique_constraints();
    uniques.sort();
    for (label, keys) in uniques {
        out.push_str("{\"schema\":\"unique\",\"label\":");
        encode_string(&mut out, &label);
        out.push_str(",\"keys\":");
        encode_str_array(&mut out, &keys);
        out.push_str("}\n");
    }
    let mut required = store.required_constraints();
    required.sort();
    for (label, key) in required {
        out.push_str("{\"schema\":\"required\",\"label\":");
        encode_string(&mut out, &label);
        out.push_str(",\"key\":");
        encode_string(&mut out, &key);
        out.push_str("}\n");
    }
    out
}

/// A full snapshot: schema lines first, then the data (nodes + edges). Reloading
/// with [`load_snapshot`] applies the schema before the data, so INSERT-time
/// enforcement on the reloaded store matches the original.
#[must_use]
pub fn snapshot(store: &Store) -> String {
    let mut out = dump_schema(store);
    out.push_str(&to_ndjson(store));
    out
}

/// Load a full snapshot (schema + data). Equivalent to [`from_ndjson`], which
/// already recognizes schema lines; named for symmetry with [`snapshot`].
pub fn load_snapshot(text: &str) -> Result<Store, String> {
    from_ndjson(text)
}

/// Write a node's property object from columns RESOLVED ONCE (outside the node
/// loop), in `cols` order. Skips the per-node, per-key `props.get(key)` hashmap
/// lookups the `keys`+closure form pays twice over (a `has_prop` then a `prop`) —
/// here each column is already in hand, so it is one `present_at` + one `read`.
fn encode_object_cols(out: &mut String, cols: &[(&str, &crate::store::Column)], row: usize) {
    out.push('{');
    let mut first = true;
    for (k, col) in cols {
        if !col.present_at(row) {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        encode_string(out, k);
        out.push(':');
        encode_value(out, &col.read(row));
    }
    out.push('}');
}

/// Write a JSON object from `keys`, including only those a present value exists
/// for (via `get`), in `keys` order.
fn encode_object(out: &mut String, keys: &[String], get: impl Fn(&str) -> Option<Value>) {
    out.push('{');
    let mut first = true;
    for k in keys {
        let Some(v) = get(k) else { continue };
        if !first {
            out.push(',');
        }
        first = false;
        encode_string(out, k);
        out.push(':');
        encode_value(out, &v);
    }
    out.push('}');
}

/// Append a JSON array of strings to `out` (shared with the schema-op vocabulary).
/// Generic over the element so a borrowed label slice (`&[&str]`, from
/// [`Store::labels_of_refs`]) writes without first cloning into `Vec<String>`.
pub fn encode_str_array<S: AsRef<str>>(out: &mut String, items: &[S]) {
    out.push('[');
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        encode_string(out, s.as_ref());
    }
    out.push(']');
}

/// Encode a value as JSON. A non-finite number becomes `null` (no JSON form).
/// A record key that LOOKS like a tagged temporal: one or more leading `@` then a
/// recognised tag (`@date`, `@@date`, …). ONLY these collide with the temporal wire
/// form, so only these are escaped — a `@`-leading key like `@user` is left alone.
fn is_temporal_shaped(k: &str) -> bool {
    let bare = k.trim_start_matches('@');
    bare.len() < k.len() && crate::temporal::Temporal::is_tag(bare)
}

/// Escape a temporal-shaped record/map key for the NDJSON wire: one extra `@`, so a
/// record like `{"@date": "…"}` is not read back as a tagged temporal (the temporal
/// check only matches a single RECOGNISED tag, so `@@date` falls through to the record
/// path). Every other key is returned unchanged. Inverse of [`unescape_record_key`];
/// kept byte-identical to `lenke_codec::json::escape_record_key` and the TS
/// `escapeRecordKey`.
fn escape_record_key(k: &str) -> std::borrow::Cow<'_, str> {
    if is_temporal_shaped(k) {
        std::borrow::Cow::Owned(format!("@{k}"))
    } else {
        std::borrow::Cow::Borrowed(k)
    }
}

/// Strip the single `@` that [`escape_record_key`] prepended, for a temporal-shaped key.
fn unescape_record_key(k: &str) -> &str {
    if is_temporal_shaped(k) {
        &k[1..]
    } else {
        k
    }
}

pub fn encode_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Node(_) | Value::Edge(_) => {
            unreachable!("element ref is never a stored property value")
        }
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(x) => {
            if x.is_finite() {
                out.push_str(&x.to_string());
            } else {
                out.push_str("null");
            }
        }
        Value::Str(s) => encode_string(out, s),
        // Tagged temporal: {"@date":"2024-01-15"} — the ISO string under a kind
        // key, matching the TS engine's json_tagged form.
        Value::Temporal(t) => {
            out.push_str("{\"@");
            out.push_str(t.tag());
            out.push_str("\":");
            encode_string(out, &t.format());
            out.push('}');
        }
        Value::List(items) => {
            out.push('[');
            for (i, it) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                encode_value(out, it);
            }
            out.push(']');
        }
        // A record is a JSON object (keys already sorted, so deterministic).
        Value::Record(fields) => {
            out.push('{');
            for (i, (k, v)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                encode_string(out, &escape_record_key(k));
                out.push(':');
                encode_value(out, v);
            }
            out.push('}');
        }
        // A Gremlin map is not a STORED property type (no producer persists one);
        // egress is best-effort as an object using each key's string form, so the
        // arm is total. (It decodes back as a record, not a map — acceptable since
        // maps are never written to a property.)
        Value::Map(pairs) => {
            out.push('{');
            for (i, (k, v)) in pairs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                match k {
                    Value::Str(s) => encode_string(out, &escape_record_key(s)),
                    other => encode_string(out, &format!("{other:?}")),
                }
                out.push(':');
                encode_value(out, v);
            }
            out.push('}');
        }
    }
}

/// Encode a JSON string with the required escapes (shared with the schema-op vocabulary).
pub fn encode_string(out: &mut String, s: &str) {
    out.push('"');
    // Fast path: a string with nothing to escape (the overwhelming common case —
    // ids, names, cities) copies whole, skipping the per-char match. The scan is one
    // cheap pass; only `"`, `\`, and control bytes (< 0x20) ever need escaping, and
    // in UTF-8 those are all single bytes, so a byte scan is exact.
    if s.bytes().all(|b| b >= 0x20 && b != b'"' && b != b'\\') {
        out.push_str(s);
        out.push('"');
        return;
    }
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// A staged node record: `(external id, labels, props)`.
///
/// BORROWED from the decoder's input since item 332 — the ids, labels and property KEYS are
/// slices of it, with `Cow`'s owned arm for the two cases that cannot be: a JSON string carrying
/// an escape (which must be unescaped into a buffer) and a numeric id (which is formatted). The
/// `Value`s stay owned; they are parsed and typed, not substrings. Sound because every decoder
/// entry takes a `&str`/`&[u8]` that outlives the whole decode, which is exactly what the GQL
/// lexer could NOT say (items 294/317, where a token would have pointed into a transient
/// `Vec<char>`). The records are only shared immutably across staging workers, so the lifetime is
/// `Send + Sync` without further work.
///
/// **Measured 1.21-1.29x on the decode** (five alternated rounds, both orders, every range
/// disjoint, with the harness's own null control flat): `nodes x1 prop` 65.31 -> 54.08ms,
/// `nodes x4 props` 115.29 -> 96.69, `nodes+5edges x2 props` 633.18 -> 500.44,
/// `ingest/ceiling` 636.01 -> 491.76, `value/codec flat scalars` 91.72 -> 72.31. The counted
/// mechanism: `alloc_count_probe` reads **2,550,034 -> 800,034 allocations (-68.6%)** on its 50k
/// node / 250k edge fixture, i.e. essentially every allocation of 8 bytes or fewer.
///
/// THE ESTIMATE HISTORY IS WORTH KEEPING, because both attempts missed and for opposite reasons.
/// Item 329 said 1.2-1.4x from a 161ms micro. Item 331 re-priced DOWN to 1.13-1.18x by counting
/// the allocations and multiplying by item 330's in-situ **5-7ns** per allocate-and-free pair.
/// The truth is ~1.25x, so 329's range was right and the careful re-pricing was wrong — because
/// **a per-allocation cost is not a constant, it depends on LIFETIME.** Item 330's pairs were
/// short-lived and LIFO, served off a hot free list at 5-7ns. These ~7M are held live across the
/// whole parse and then freed in bulk, which works out at ~19ns each. Multiplying a correct count
/// by the wrong one of those two numbers is how the re-pricing went wrong; a count is still the
/// right instrument, but the rate has to come from an allocation with the same lifetime.
pub(crate) type NodeRec<'a> = (Cow<'a, str>, Span, Span);

/// A `(start, len)` window into one of [`StagedNdjson`]'s two arenas.
///
/// A record used to own a `Vec` for its labels and another for its properties, which is **two
/// heap allocations per record whose contents are read exactly once** — 616,488 of the 700,036
/// allocations a 50k-node / 250k-edge decode made before item 333, since Rust's first growth for
/// a 24-to-56-byte element is capacity 4 and these hold one or two. One arena per kind, filled in
/// line order and sliced by span, replaces all of them with two amortized pushes.
///
/// `u32` because an NDJSON document with more than 4 billion labels is not a case; a 64-bit span
/// would make the record larger than the `Vec` it replaced.
pub(crate) type Span = (u32, u32);

/// Slice an arena by a span. The bounds are the arena's own, so a bad span panics here rather
/// than reading another record's labels — which is what makes the concat rebasing below safe to
/// get wrong loudly instead of quietly.
pub(crate) fn span_of<T>(arena: &[T], sp: Span) -> &[T] {
    &arena[sp.0 as usize..(sp.0 + sp.1) as usize]
}
/// A staged edge record: `(from-id, to-id, edge id?, labels, props)` — an edge's
/// first label is its type, the rest are secondary (multi-label edges).
pub(crate) type EdgeRec<'a> = (Cow<'a, str>, Cow<'a, str>, Option<Cow<'a, str>>, Span, Span);

/// The decoded-but-not-yet-applied contents of a full-graph document. Shared by
/// [`from_ndjson`] / [`merge_ndjson`] and the binary codec ([`crate::binary`]) so
/// every full-graph decoder feeds the one [`build_store`] path.
pub(crate) struct StagedNdjson<'a> {
    pub(crate) constraints: Vec<(Cow<'a, str>, Vec<Cow<'a, str>>)>,
    pub(crate) required: Vec<(Cow<'a, str>, Cow<'a, str>)>,
    pub(crate) nodes: Vec<NodeRec<'a>>,
    pub(crate) edges: Vec<EdgeRec<'a>>,
    /// Every record's labels, contiguous, in line order. Records hold a [`Span`] into it.
    pub(crate) labels: Vec<Cow<'a, str>>,
    /// Every record's properties, contiguous, in line order.
    pub(crate) props: Vec<(Cow<'a, str>, Value)>,
}

impl<'a> StagedNdjson<'a> {
    fn empty() -> Self {
        Self {
            constraints: Vec::new(),
            required: Vec::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            labels: Vec::new(),
            props: Vec::new(),
        }
    }
}

/// Parse an NDJSON document into staged records. External ids are PRESERVED
/// verbatim (no remap), so element_id / egress round-trip. Serial by default; a
/// caller wanting multicore staging uses [`stage_ndjson_threads`].
fn stage_ndjson(text: &str) -> Result<StagedNdjson<'_>, String> {
    stage_lines(text, 0)
}

/// Parse ONE slice of complete NDJSON lines into staged records, numbering error
/// messages from `line_offset` (so a parallel chunk still reports the true global
/// line). Pure — no shared state — so disjoint line-chunks stage independently and
/// their record vectors concatenate in order to the exact serial result.
fn stage_lines(text: &str, line_offset: usize) -> Result<StagedNdjson<'_>, String> {
    let mut constraints: Vec<(Cow<'_, str>, Vec<Cow<'_, str>>)> = Vec::new();
    let mut required: Vec<(Cow<'_, str>, Cow<'_, str>)> = Vec::new();
    let mut nodes: Vec<NodeRec<'_>> = Vec::new();
    let mut edges: Vec<EdgeRec<'_>> = Vec::new();
    let mut labels_arena: Vec<Cow<'_, str>> = Vec::new();
    let mut props_arena: Vec<(Cow<'_, str>, Value)> = Vec::new();

    // Both shapes are accepted so the engine is a drop-in for the TS engine's NDJSON AND
    // keeps reading anything it wrote earlier: the shipped `{"type":…,"labels":[…],
    // "properties":{…}}` and the legacy node `{"id",…,"props"}` / edge `{"from","to",
    // "type":"<etype>","props"}`. `record()` routes both (edge told by `from`; props from
    // `properties` OR `props`; edge type from `labels` or a legacy `type`).
    for (lineno, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let err = |m: String| format!("line {}: {m}", line_offset + lineno + 1);
        let mut p = JsonParser {
            b: line.as_bytes(),
            i: 0,
            depth: 0,
        };
        let rec = p.record(&mut labels_arena, &mut props_arena).map_err(err)?;
        p.ws();
        if p.i != p.b.len() {
            return Err(err(format!("trailing input at char {}", p.i)));
        }
        match rec {
            Rec::Node(n) => nodes.push(n),
            Rec::Edge(e) => edges.push(e),
            Rec::Unique(label, keys) => constraints.push((label, keys)),
            Rec::Required(label, key) => required.push((label, key)),
        }
    }
    Ok(StagedNdjson {
        constraints,
        required,
        nodes,
        edges,
        labels: labels_arena,
        props: props_arena,
    })
}

/// Cut `text` into at most `parts` contiguous chunks, each a run of COMPLETE lines
/// (every chunk ends just after a `\n`), paired with the 0-based line number of its
/// first line. One O(n) byte scan; splits fall on the newline boundary nearest each
/// evenly-spaced byte offset. Concatenating the chunks' staged records in order
/// reproduces the serial parse exactly.
#[cfg(feature = "parallel")]
fn line_chunks(text: &str, parts: usize) -> Vec<(&str, usize)> {
    let n = text.len();
    if parts <= 1 || n == 0 {
        return vec![(text, 0)];
    }
    let approx = (n / parts).max(1);
    let b = text.as_bytes();
    let mut chunks: Vec<(&str, usize)> = Vec::with_capacity(parts);
    let mut chunk_start = 0usize;
    let mut chunk_start_line = 0usize;
    let mut line = 0usize;
    let mut target = approx;
    for i in 0..n {
        if b[i] == b'\n' {
            line += 1;
            if i + 1 >= target && chunks.len() < parts - 1 {
                chunks.push((&text[chunk_start..=i], chunk_start_line));
                chunk_start = i + 1;
                chunk_start_line = line;
                target = chunk_start + approx;
            }
        }
    }
    if chunk_start < n {
        chunks.push((&text[chunk_start..], chunk_start_line));
    }
    if chunks.is_empty() {
        chunks.push((text, 0));
    }
    chunks
}

/// Parse an NDJSON document into staged records with up to `threads` workers: split
/// into contiguous complete-line chunks, stage them in parallel, and concatenate the
/// record vectors IN ORDER. Byte-identical to the serial parse — [`build_store`] then
/// assigns dense ids in that (input) order. `threads <= 1`, a tiny doc, or a build
/// without the `parallel` feature runs serially.
fn stage_ndjson_threads(text: &str, threads: u32) -> Result<StagedNdjson<'_>, String> {
    #[cfg(feature = "parallel")]
    if threads > 1 {
        let chunks = line_chunks(text, threads as usize * 4);
        if chunks.len() > 1 {
            let parts: Vec<Result<StagedNdjson, String>> =
                crate::parallel::with_pool(threads, || {
                    chunks
                        .par_iter()
                        .map(|&(chunk, line0)| stage_lines(chunk, line0))
                        .collect()
                });
            let mut merged = StagedNdjson::empty();
            for part in parts {
                let part = part?;
                // Each chunk staged into its OWN arenas, so its spans are chunk-relative.
                // Rebase them by the lengths already merged before appending the arenas —
                // the one thing in this file that is wrong if the order is wrong, which is
                // why the offsets are read BEFORE the `extend`.
                let (lo, po) = (merged.labels.len() as u32, merged.props.len() as u32);
                merged.constraints.extend(part.constraints);
                merged.required.extend(part.required);
                merged.nodes.extend(
                    part.nodes
                        .into_iter()
                        .map(|(id, l, p)| (id, (l.0 + lo, l.1), (p.0 + po, p.1))),
                );
                merged.edges.extend(
                    part.edges
                        .into_iter()
                        .map(|(f, t, id, l, p)| (f, t, id, (l.0 + lo, l.1), (p.0 + po, p.1))),
                );
                merged.labels.extend(part.labels);
                merged.props.extend(part.props);
            }
            return Ok(merged);
        }
    }
    let _ = threads;
    stage_lines(text, 0)
}

/// What a [`merge_ndjson`] applied vs. skipped — so a caller (the sync demand-fill
/// path) can surface anything that did not land cleanly. Empty skip/phantom lists
/// mean a clean merge. Mirrors the TS engine's `MergeReport`.
#[derive(Default)]
pub struct MergeReport {
    pub nodes_added: usize,
    pub edges_added: usize,
    /// Batch node ids skipped because the id already existed (first-wins).
    pub nodes_skipped: Vec<String>,
    /// Batch edge ids skipped because the explicit id already existed.
    pub edges_skipped: Vec<String>,
    /// Endpoint ids an edge referenced that were not declared — created as bare
    /// vertices (the lenient endpoint policy) and reported.
    pub phantom_vertices: Vec<String>,
}

/// Merge an NDJSON document into an EXISTING store with **first-wins** semantics
/// (matching the TS engine's `ndjson::append`): a node whose id already exists is
/// SKIPPED (the graph's copy kept) and reported; an edge with an already-present
/// explicit id is skipped; an undeclared edge endpoint is created as a bare vertex
/// and reported as a phantom; explicit edge ids are preserved. An id-less edge is
/// always inserted (it has no identity to dedup on). Schema lines (constraints)
/// are applied if present. This is the bulk demand-fill path — NOT an upsert; the
/// keyed upsert is GQL `_MERGE`.
pub fn merge_ndjson(store: &mut Store, text: &str) -> Result<MergeReport, String> {
    let staged = stage_ndjson(text)?;
    let mut report = MergeReport::default();

    for (label, keys) in &staged.constraints {
        let krefs: Vec<&str> = keys.iter().map(|s| &**s).collect();
        store.create_unique_constraint(label, &krefs)?;
    }
    for (label, key) in &staged.required {
        store.create_required_constraint(label, key)?;
    }

    // Nodes first (first-wins), so a same-batch edge can reference one.
    for (ext, lsp, psp) in &staged.nodes {
        let (labels, props) = (span_of(&staged.labels, *lsp), span_of(&staged.props, *psp));
        if store.node_by_ext(ext).is_some() {
            report.nodes_skipped.push(ext.to_string()); // first-wins: existing kept
            continue;
        }
        let lrefs: Vec<&str> = labels.iter().map(|s| &**s).collect();
        for label in &lrefs {
            crate::store::validate_label(label)?;
        }
        for (k, _) in props {
            crate::store::validate_prop_key(k)?;
        }
        let prefs: Vec<(&str, Value)> = props.iter().map(|(k, v)| (&**k, v.clone())).collect();
        store.add_node_with_id(&Arc::from(&**ext), &lrefs, &prefs);
        report.nodes_added += 1;
    }

    // Edge external id → eid over live edges, so an explicit-id dedup is O(1).
    let mut ext_to_eid: std::collections::HashMap<GStr, u32> = std::collections::HashMap::new();
    for eid in store.all_edges() {
        if let Some(ext) = store.edge_ext_id(eid) {
            ext_to_eid.insert(ext, eid);
        }
    }

    for (from, to, edge_id, lsp, psp) in &staged.edges {
        let (labels, props) = (span_of(&staged.labels, *lsp), span_of(&staged.props, *psp));
        // An edge whose explicit id already exists is a duplicate — drop it.
        if let Some(id) = edge_id {
            if ext_to_eid.contains_key(&**id) {
                report.edges_skipped.push(id.to_string());
                continue;
            }
        }
        for label in labels {
            crate::store::validate_label(label)?;
        }
        for (k, _) in props {
            crate::store::validate_prop_key(k)?;
        }
        let f = resolve_or_phantom(store, from, &mut report);
        let t = resolve_or_phantom(store, to, &mut report);
        let etype = &labels[0];
        let eid = match edge_id {
            Some(id) => store.add_edge_with_id(&Arc::from(&**id), f, t, etype),
            None => store.add_edge(f, t, etype),
        };
        if labels.len() > 1 {
            let extra: Vec<&str> = labels[1..].iter().map(|s| &**s).collect();
            store.set_edge_extra_labels(eid, &extra);
        }
        for (k, v) in props {
            store.set_edge_prop(eid, k, v.clone());
        }
        if let Some(e) = edge_id {
            ext_to_eid.insert(GStr::from(&**e), eid);
        }
        report.edges_added += 1;
    }
    store.rebuild_csr();
    store.rebuild_edge_num();
    Ok(report)
}

/// An endpoint id → its node, creating a bare vertex (and recording a phantom) for
/// an undeclared one — the lenient endpoint policy, matching the TS engine.
fn resolve_or_phantom(store: &mut Store, ext: &str, report: &mut MergeReport) -> u32 {
    if let Some(id) = store.node_by_ext(ext) {
        return id;
    }
    report.phantom_vertices.push(ext.to_string());
    store.add_node_with_id(&Arc::from(ext), &[], &[])
}

/// Load a store from NDJSON in the [`to_ndjson`] format. Node lines
/// (`{id,labels,props}`) come first, then edge lines (`{from,to,type,props}`).
///
/// The file's `id` values may have GAPS (a dump omits deleted nodes), so ids are
/// NOT preserved: nodes are inserted in file order and get fresh dense ids, and
/// edges are remapped through that file-id → new-id map. Consequently a dump of a
/// graph with deletions re-densifies on load — round-trip is exact for a gap-free
/// dump and STABLE from the first reload otherwise.
pub fn from_ndjson(text: &str) -> Result<Store, String> {
    from_ndjson_threads(text, 1)
}

/// Decode NDJSON into a store using up to `threads` workers. The PARSE (the dominant
/// cost) parallelizes over line-chunks; the store build stays serial so dense ids are
/// assigned in input order — the result is byte-identical at any thread count. Within
/// the serial build, endpoint resolution (`node_by_ext` per edge end) also parallelizes,
/// and nodes take the single-pass `add_node_bulk` fast path under bulk-load mode.
/// `threads <= 1` runs fully serial.
///
/// AMDAHL-BOUNDED BY THE SERIAL INSERT, and the bound is ~2.0x rather than the ~2.5x recorded
/// here before. Fitting `T(n) = P/n + S` to the corpus's own `ingest/threads` sweep
/// (729.08 / 555.59 / 460.24 / 411.51 ms at 1/2/4/8 threads) gives the same answer from all six
/// pairs of points — **P = 347-390ms parallel parse, S = 363-382ms serial build**, which audit
/// item 329 then confirmed by direct measurement at **parse 370ms / build 382ms**, within 5% of
/// the fit. The measured 1.77x at 8 threads is 88% of the 1.91-2.01x bound, so the parallel side
/// is close to done and **the serial build is the target**.
///
/// WHERE THE SERIAL BUILD GOES (item 329, 200k nodes / 1M edges / 115.8 MiB): edge loop 180ms,
/// `resolve_endpoints` 98ms (already parallel above one thread), **dropping the staged records
/// 68ms**, node loop 15ms, `rebuild_csr` 9ms, degrees+reserve 4ms, `materialize_ext` 4ms,
/// `rebuild_edge_num` 4ms, `end_bulk` 0.
///
/// NOT the per-property clones in either serial loop, which is the obvious first guess:
/// `GStr::clone` is a 16-byte struct copy for an inline string (<=12 bytes) and a relaxed atomic
/// increment for a long one, so the ~2.4M `Value` clones those loops make are close to free.
pub fn from_ndjson_threads(text: &str, threads: u32) -> Result<Store, String> {
    build_store(stage_ndjson_threads(text, threads)?, threads)
}

/// Build a `Store` from staged records — the shared tail of every full-graph
/// decoder ([`from_ndjson`] and [`crate::binary::from_binary`]). Applies schema
/// BEFORE data (the store is empty, so declaration always succeeds — INSERT-time
/// enforcement on the reloaded store matches), then finalizes the read overlays.
pub(crate) fn build_store(staged: StagedNdjson<'_>, threads: u32) -> Result<Store, String> {
    let StagedNdjson {
        constraints,
        required,
        nodes,
        edges,
        labels: labels_arena,
        props: props_arena,
    } = staged;

    let mut store = Store::default();
    for (label, keys) in &constraints {
        let krefs: Vec<&str> = keys.iter().map(|s| &**s).collect();
        store.create_unique_constraint(label, &krefs)?;
    }
    for (label, key) in &required {
        store.create_required_constraint(label, key)?;
    }
    // Bulk-load mode: defer version/epoch upkeep (a per-element hashmap op otherwise)
    // and the `ext_to_node` reverse-map build, reconciled once at `end_bulk`. Node
    // inserts take the single-pass `add_node_bulk` fast path (no per-property hashmap
    // lookup); `materialize_ext` then builds the reverse map in one reserved pass BEFORE
    // the edge loop resolves endpoints through it. Byte-identical to the serial adds.
    store.begin_bulk();
    // The `&[&str]` / `&[(&str, Value)]` the store wants are built ONCE and refilled, not
    // allocated per node: declared inside the loop they were two heap allocations per record
    // whose whole life was one `add_node_bulk` call (audit item 333). `clear()` keeps the
    // capacity, so after the first node this costs nothing.
    let mut lrefs: Vec<&str> = Vec::new();
    let mut prefs: Vec<(&str, Value)> = Vec::new();
    for (ext, lsp, psp) in &nodes {
        let (labels, props) = (span_of(&labels_arena, *lsp), span_of(&props_arena, *psp));
        lrefs.clear();
        lrefs.extend(labels.iter().map(|s| &**s));
        for label in &lrefs {
            crate::store::validate_label(label)?;
        }
        for (k, _) in props {
            crate::store::validate_prop_key(k)?;
        }
        prefs.clear();
        prefs.extend(props.iter().map(|(k, v)| (&**k, v.clone())));
        store.add_node_bulk(ext, &lrefs, &prefs);
    }
    drop(lrefs);
    drop(prefs);
    store.materialize_ext();
    // Resolve every edge's endpoints through the reverse map — a read-only `node_by_ext`
    // per end, so it parallelizes (the store is only READ here). The serial insert below
    // then uses the resolved dense ids, assigning eids in input order (byte-identical).
    let resolved = resolve_endpoints(&store, &edges, threads)?;
    // Pre-reserve the edge vectors and each node's adjacency from the resolved degrees,
    // so the insert loop below does zero incremental reallocation.
    let mut outdeg = vec![0u32; store.node_count()];
    let mut indeg = vec![0u32; store.node_count()];
    for &(f, t) in &resolved {
        outdeg[f as usize] += 1;
        indeg[t as usize] += 1;
    }
    store.reserve_for_edges(edges.len(), &outdeg, &indeg);
    // Edge insert stays SERIAL: it is memory-bound scattered adjacency writes with tiny
    // (avg few-edge) per-node work, and a parallel counting-sort rebuild measured SLOWER
    // — more passes over E, plus rayon overhead across 50k tiny per-node tasks. (Passing
    // the id by reference instead of a throwaway `Arc` per edge is measurement-neutral —
    // the transient small allocs are cheap — but it is cleaner, so it stays.)
    for ((_, _, edge_id, lsp, psp), &(f, t)) in edges.iter().zip(&resolved) {
        let (labels, props) = (span_of(&labels_arena, *lsp), span_of(&props_arena, *psp));
        for label in labels {
            crate::store::validate_label(label)?;
        }
        for (k, _) in props {
            crate::store::validate_prop_key(k)?;
        }
        let etype = &labels[0];
        let eid = match edge_id {
            Some(id) => store.add_edge_with_id(id, f, t, etype),
            None => store.add_edge(f, t, etype),
        };
        if labels.len() > 1 {
            let extra: Vec<&str> = labels[1..].iter().map(|s| &**s).collect();
            store.set_edge_extra_labels(eid, &extra);
        }
        for (k, v) in props {
            store.set_edge_prop(eid, k, v.clone());
        }
    }
    // Incremental loading left the CSR + numeric-edge overlays stale (edges arrive via
    // add_edge, which invalidates); rebuild both once so a loaded snapshot gets the
    // contiguous read path and the typed edge-property reads without a later rebuild.
    store.end_bulk();
    store.rebuild_csr();
    store.rebuild_edge_num();
    // Dictionary-encode categorical string columns now that every value is in — the
    // finalize that gives a bulk-loaded `city`/`dept`/`status` the code-based encoding
    // incremental adds skip (turns GROUP BY / DISTINCT / equality over them into u32
    // work instead of string hashing).
    store.dict_encode_columns();
    Ok(store)
}

/// Resolve each edge's `(from, to)` external ids to dense node ids through the store's
/// reverse map. `node_by_ext` is `&self`, so this is READ-ONLY and parallelizes over the
/// edges when `threads > 1` (a big chunk of edge-insert cost is these 2·|E| hashmap
/// lookups). Order is preserved, so the serial insert that follows still assigns eids in
/// input order. An unknown endpoint is an error (which edge is reported may differ under
/// parallel, but that is the malformed-input path only).
fn resolve_endpoints(
    store: &Store,
    edges: &[EdgeRec],
    threads: u32,
) -> Result<Vec<(u32, u32)>, String> {
    let lookup = |from: &str, to: &str| -> Result<(u32, u32), String> {
        let f = store
            .node_by_ext(from)
            .ok_or_else(|| format!("edge references unknown node id {from}"))?;
        let t = store
            .node_by_ext(to)
            .ok_or_else(|| format!("edge references unknown node id {to}"))?;
        Ok((f, t))
    };
    #[cfg(feature = "parallel")]
    if threads > 1 {
        return crate::parallel::with_pool(threads, || {
            edges
                .par_iter()
                .map(|(from, to, ..)| lookup(from, to))
                .collect()
        });
    }
    let _ = threads;
    edges
        .iter()
        .map(|(from, to, ..)| lookup(from, to))
        .collect()
}

// --- a tiny dependency-free JSON parser (one value per line) -----------------

/// A parsed JSON value. Public so other engine modules (e.g. [`crate::schema_op`])
/// can reuse the one hand-rolled, tested JSON parser instead of duplicating it.
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

/// Look up a field by key in a JSON object's `(key, value)` list.
pub fn field<'a>(fields: &'a [(String, Json)], key: &str) -> Option<&'a Json> {
    fields.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}
/// Like [`field`], but a missing key is an `Err`.
pub fn req<'a>(fields: &'a [(String, Json)], key: &str) -> Result<&'a Json, String> {
    field(fields, key).ok_or_else(|| format!("missing field `{key}`"))
}
/// A JSON string value, or `Err` for any other shape.
pub fn json_string(j: &Json) -> Result<String, String> {
    match j {
        Json::Str(s) => Ok(s.clone()),
        _ => Err("expected a string".into()),
    }
}
/// A JSON array of strings, or `Err` for any other shape.
pub fn json_str_array(j: &Json) -> Result<Vec<String>, String> {
    match j {
        Json::Arr(items) => items.iter().map(json_string).collect(),
        _ => Err("expected an array of strings".into()),
    }
}
/// A JSON value as a property `Value`. There is no map type, so a nested object
/// as a property value is rejected (the egress never emits one).
fn json_value(j: &Json) -> Result<Value, String> {
    Ok(match j {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Num(x) => Value::Num(*x),
        Json::Str(s) => Value::Str(GStr::from(s.as_str())),
        Json::Arr(items) => Value::List(items.iter().map(json_value).collect::<Result<_, _>>()?),
        // A single-key `{"@<tag>":"<iso>"}` object is a tagged temporal — the
        // inverse of the egress in `encode_value`. Any other object shape is not a
        // property value.
        Json::Obj(fields) => {
            if let [(key, Json::Str(s))] = fields.as_slice() {
                if let Some(tag) = key.strip_prefix('@') {
                    if crate::temporal::Temporal::is_tag(tag) {
                        return crate::temporal::Temporal::parse(tag, s)
                            .map(Value::Temporal)
                            .map_err(|e| format!("bad temporal value: {e}"));
                    }
                }
            }
            // Any other object is a record: decode each field recursively, then
            // canonicalize (sorted, last-wins) via the value contract.
            let pairs = fields
                .iter()
                .map(|(k, v)| {
                    json_value(v).map(|v| (GStr::from(unescape_record_key(k.as_str())), v))
                })
                .collect::<Result<Vec<_>, _>>()?;
            crate::value::make_record(pairs)
        }
    })
}

/// Parse exactly one JSON value from `text` (trailing whitespace allowed). The
/// public entry to the engine's one JSON parser, for callers outside NDJSON decode.
pub fn parse_json(text: &str) -> Result<Json, String> {
    parse_line(text)
}

/// Parse a JSON object of query parameters `{"name": value, …}` into `(name, value)`
/// pairs. Each value decodes with the same rules as a stored property value (scalars,
/// lists, records, tagged temporals). A non-object is an error.
pub fn parse_params(json: &str) -> Result<Vec<(String, Value)>, String> {
    params_from_obj(&parse_json(json)?)
}

/// Convert an ALREADY-parsed JSON object into query-parameter `(name, value)`
/// pairs — the nested-value counterpart of [`parse_params`] (which takes text),
/// for callers that hold a `params` sub-object (e.g. a prepared-statement payload).
pub fn params_from_obj(obj: &Json) -> Result<Vec<(String, Value)>, String> {
    match obj {
        Json::Obj(fields) => fields
            .iter()
            .map(|(k, v)| Ok((k.clone(), json_value(v)?)))
            .collect(),
        _ => Err("query parameters must be a JSON object".into()),
    }
}

/// Parse exactly one JSON value from `line` (trailing whitespace allowed).
fn parse_line(line: &str) -> Result<Json, String> {
    // Parse over the raw BYTES (`&[u8]`) — no per-line `Vec<char>` allocation, and the
    // structural scan is single-byte ASCII. `line` is valid UTF-8, so string CONTENT
    // (between quotes) is copied through as byte slices; only escapes are expanded. The
    // parsed values are byte-identical to the previous char parser.
    let mut p = JsonParser {
        b: line.as_bytes(),
        i: 0,
        depth: 0,
    };
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("trailing input at char {}", p.i));
    }
    Ok(v)
}

/// Maximum object/array nesting depth this hand-rolled parser accepts. `value` recurses
/// through `object`/`array`, so unbounded nesting (a crafted param, `mergeNdjson` /
/// snapshot value, or algo config) overflows the stack — an uncatchable SIGSEGV on
/// native and a trap on wasm. Far above any real property value (nested a handful deep),
/// and safely below the overflow threshold on the smallest stack (the ~1 MB wasm CLI).
const MAX_JSON_DEPTH: usize = 128;

struct JsonParser<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl<'a> JsonParser<'a> {
    fn ws(&mut self) {
        while self.b.get(self.i).is_some_and(u8::is_ascii_whitespace) {
            self.i += 1;
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.ws();
        match self.b.get(self.i) {
            // Charge one nesting level per container and release it after — a flat but
            // deeply-nested value can't overflow the recursive descent (or a later
            // recursive walk / Drop of the parsed tree).
            Some(b'{') => self.nested(Self::object),
            Some(b'[') => self.nested(Self::array),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') | Some(b'f') => self.boolean(),
            Some(b'n') => self.keyword("null", Json::Null),
            Some(c) if *c == b'-' || c.is_ascii_digit() => self.number(),
            other => Err(format!("unexpected {other:?} at char {}", self.i)),
        }
    }

    /// Run a container parser one nesting level deeper, rejecting past [`MAX_JSON_DEPTH`]
    /// before the stack overflows. Generic over the parsed type so BOTH recursive descents
    /// — the `Json` path (`object`/`array`, for params) and the `Value` path
    /// (`object_as_value`/`array_as_value`, for stored property values) — share the guard.
    fn nested<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, String>) -> Result<T, String> {
        self.depth += 1;
        if self.depth > MAX_JSON_DEPTH {
            self.depth -= 1;

            return Err(format!(
                "E_RESOURCE_EXHAUSTED: JSON nesting exceeds the maximum depth of {MAX_JSON_DEPTH}"
            ));
        }
        let r = f(self);
        self.depth -= 1;

        r
    }

    fn object(&mut self) -> Result<Json, String> {
        self.i += 1; // '{'
        let mut out = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Json::Obj(out));
        }
        loop {
            self.ws();
            let key = self.string()?;
            self.ws();
            if self.b.get(self.i) != Some(&b':') {
                return Err(format!("expected ':' at char {}", self.i));
            }
            self.i += 1;
            let val = self.value()?;
            out.push((key, val));
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(out));
                }
                _ => return Err(format!("expected ',' or '}}' at char {}", self.i)),
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.i += 1; // '['
        let mut out = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Json::Arr(out));
        }
        loop {
            out.push(self.value()?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(out));
                }
                _ => return Err(format!("expected ',' or ']' at char {}", self.i)),
            }
        }
    }

    /// An owned JSON string. Most callers store the result, so this stays the default.
    fn string(&mut self) -> Result<String, String> {
        Ok(self.string_cow()?.into_owned())
    }

    /// The same scan, but BORROWED from the input on the escape-free path — which is the
    /// common one, and the one where the allocation was pure waste.
    ///
    /// Audit item 330: the old `string()` already computed this slice and then called
    /// `.to_string()` on it. Two callers never needed the `String` at all — `record()`
    /// allocates one per JSON object KEY purely to `match` it against literals and drop it
    /// (4 per node line, 6 per edge line), and a string property value is allocated only to be
    /// copied into a `GStr` and dropped. On the corpus's 200k-node / 1M-edge fixture that is
    /// ~6.8M allocate-and-free pairs storing nothing.
    ///
    /// `self.b` is copied to a local first so the returned reference carries the parser's `'a`
    /// rather than the `&mut self` borrow.
    fn string_cow(&mut self) -> Result<Cow<'a, str>, String> {
        let b: &'a [u8] = self.b;
        if b.get(self.i) != Some(&b'"') {
            return Err(format!("expected a string at char {}", self.i));
        }
        self.i += 1;
        let start = self.i;
        // Escape-free fast path: scan to the closing quote and hand back the borrowed
        // byte slice (the common case — ids, names). Only on a backslash do we fall to a byte
        // buffer that copies runs and expands escapes.
        let mut buf: Vec<u8> = Vec::new();
        let mut run = start; // start of the current unescaped run
        loop {
            match self.b.get(self.i) {
                None => return Err("unterminated string".into()),
                Some(b'"') => {
                    if buf.is_empty() {
                        let s = core::str::from_utf8(&b[start..self.i])
                            .map_err(|_| "invalid utf-8 in string".to_string())?;
                        self.i += 1;
                        return Ok(Cow::Borrowed(s));
                    }
                    buf.extend_from_slice(&b[run..self.i]);
                    self.i += 1;
                    return String::from_utf8(buf)
                        .map(Cow::Owned)
                        .map_err(|_| "invalid utf-8 in string".to_string());
                }
                Some(b'\\') => {
                    buf.extend_from_slice(&self.b[run..self.i]);
                    self.i += 1;
                    match self.b.get(self.i) {
                        Some(b'"') => buf.push(b'"'),
                        Some(b'\\') => buf.push(b'\\'),
                        Some(b'/') => buf.push(b'/'),
                        Some(b'n') => buf.push(b'\n'),
                        Some(b'r') => buf.push(b'\r'),
                        Some(b't') => buf.push(b'\t'),
                        Some(b'b') => buf.push(0x08),
                        Some(b'f') => buf.push(0x0c),
                        Some(b'u') => {
                            let hex = self
                                .b
                                .get(self.i + 1..self.i + 5)
                                .and_then(|h| core::str::from_utf8(h).ok())
                                .ok_or_else(|| "bad \\u escape".to_string())?;
                            let cp = u32::from_str_radix(hex, 16)
                                .map_err(|_| "bad \\u escape".to_string())?;
                            let ch = char::from_u32(cp).ok_or("bad code point")?;
                            buf.extend_from_slice(ch.encode_utf8(&mut [0u8; 4]).as_bytes());
                            self.i += 4;
                        }
                        other => return Err(format!("bad escape {other:?}")),
                    }
                    self.i += 1;
                    run = self.i;
                }
                Some(_) => self.i += 1,
            }
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        self.number_f64().map(Json::Num)
    }

    fn number_f64(&mut self) -> Result<f64, String> {
        let start = self.i;
        while self
            .b
            .get(self.i)
            .is_some_and(|c| matches!(c, b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'))
        {
            self.i += 1;
        }
        // ASCII by construction, so `from_utf8` is infallible in practice.
        let text =
            core::str::from_utf8(&self.b[start..self.i]).map_err(|_| "bad number".to_string())?;
        text.parse::<f64>()
            .map_err(|_| format!("bad number `{text}`"))
    }

    fn boolean(&mut self) -> Result<Json, String> {
        Ok(Json::Bool(self.bool_raw()?))
    }

    fn bool_raw(&mut self) -> Result<bool, String> {
        if self.b.get(self.i) == Some(&b't') {
            self.keyword("true", Json::Null)?;
            Ok(true)
        } else {
            self.keyword("false", Json::Null)?;
            Ok(false)
        }
    }

    fn keyword(&mut self, word: &str, val: Json) -> Result<Json, String> {
        for &c in word.as_bytes() {
            if self.b.get(self.i) != Some(&c) {
                return Err(format!("expected `{word}` at char {}", self.i));
            }
            self.i += 1;
        }
        Ok(val)
    }

    // --- direct-into-record parsing (no intermediate `Json` tree) ---------------
    //
    // The NDJSON decode hot path parses each line straight into a [`Rec`] and its
    // property values straight into [`Value`], byte-identical to the old `parse_line`
    // + field-extraction (`json_id`/`json_str_array`/`json_props`/`json_value`) it
    // replaces — it just skips allocating the `Json` tree in between.

    /// A JSON value AS a property [`Value`] — the direct twin of `json_value`
    /// (temporal-tag and record aware).
    fn value_as_value(&mut self) -> Result<Value, String> {
        self.ws();
        match self.b.get(self.i) {
            // Charge one nesting level per container so a deeply-nested property value
            // (a crafted `mergeNdjson` / snapshot line) can't overflow the stack.
            Some(b'{') => self.nested(Self::object_as_value),
            Some(b'[') => self.nested(Self::array_as_value),
            // Borrowed: a `GStr` copies its bytes anyway, so the intermediate `String` this
            // used to build was allocated only to be read once and dropped (item 330).
            Some(b'"') => Ok(Value::Str(GStr::from(&*self.string_cow()?))),
            Some(b't') | Some(b'f') => Ok(Value::Bool(self.bool_raw()?)),
            Some(b'n') => {
                self.keyword("null", Json::Null)?;
                Ok(Value::Null)
            }
            Some(c) if *c == b'-' || c.is_ascii_digit() => Ok(Value::Num(self.number_f64()?)),
            other => Err(format!("unexpected {other:?} at char {}", self.i)),
        }
    }

    /// The `[…]` case of [`value_as_value`] — a list property value. Extracted so the
    /// `nested` depth guard wraps it (the cursor is at `[`).
    fn array_as_value(&mut self) -> Result<Value, String> {
        self.i += 1; // '['
        let mut items = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Value::List(items));
        }
        loop {
            items.push(self.value_as_value()?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Value::List(items));
                }
                _ => return Err(format!("expected ',' or ']' at char {}", self.i)),
            }
        }
    }

    /// The `{…}` case of [`value_as_value`]: a single-key `{"@<tag>":"<iso>"}` is a
    /// tagged temporal (inverse of the egress); any other object is a record. Mirrors
    /// `json_value`'s object branch exactly.
    fn object_as_value(&mut self) -> Result<Value, String> {
        let pairs = self.pairs()?;
        if let [(key, Value::Str(s))] = pairs.as_slice() {
            if let Some(tag) = key.strip_prefix('@') {
                if crate::temporal::Temporal::is_tag(tag) {
                    return crate::temporal::Temporal::parse(tag, s.as_str())
                        .map(Value::Temporal)
                        .map_err(|e| format!("bad temporal value: {e}"));
                }
            }
        }
        let pairs: Vec<(GStr, Value)> = pairs
            .into_iter()
            .map(|(k, v)| (GStr::from(unescape_record_key(&k)), v))
            .collect();
        Ok(crate::value::make_record(pairs))
    }

    /// Parse a `{"k": value, …}` object into its `(key, Value)` pairs in source order
    /// (the input to `properties` and to a record). Assumes the cursor is at `{`.
    /// `pairs` appending into a caller-owned arena (item 333).
    fn pairs_into(&mut self, out: &mut Vec<(Cow<'a, str>, Value)>) -> Result<(), String> {
        self.i += 1; // '{'
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(());
        }
        loop {
            self.ws();
            let key = self.string_cow()?;
            self.ws();
            if self.b.get(self.i) != Some(&b':') {
                return Err(format!("expected ':' at char {}", self.i));
            }
            self.i += 1;
            let val = self.value_as_value()?;
            out.push((key, val));
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(());
                }
                _ => return Err(format!("expected ',' or '}}' at char {}", self.i)),
            }
        }
    }

    /// `pairs_into` collecting into a fresh `Vec` — for a nested record VALUE, which is one
    /// object inside one property and so has no arena to append to.
    fn pairs(&mut self) -> Result<Vec<(Cow<'a, str>, Value)>, String> {
        let mut out = Vec::new();
        self.pairs_into(&mut out)?;
        Ok(out)
    }

    /// An element id, accepted as a JSON string OR an integer-valued number (rendered
    /// as its integer text) — `json_id` without the `Json`.
    fn id_as_string(&mut self) -> Result<Cow<'a, str>, String> {
        self.ws();
        match self.b.get(self.i) {
            Some(b'"') => self.string_cow(),
            Some(c) if *c == b'-' || c.is_ascii_digit() => {
                let n = self.number_f64()?;
                if n.fract() == 0.0 {
                    Ok(Cow::Owned((n as i64).to_string()))
                } else {
                    Err("expected an id (string or integer)".into())
                }
            }
            _ => Err("expected an id (string or integer)".into()),
        }
    }

    /// A JSON array of strings — `json_str_array` without the `Json`.
    fn string_array(&mut self) -> Result<Vec<Cow<'a, str>>, String> {
        let mut out = Vec::new();
        self.string_array_into(&mut out)?;
        Ok(out)
    }

    /// `string_array` appending into a caller-owned arena, so a record's labels cost an
    /// amortized push rather than a `Vec` of their own (item 333). The `Vec`-returning form
    /// above stays for the schema lines' `keys`, which must NOT touch the labels arena.
    fn string_array_into(&mut self, out: &mut Vec<Cow<'a, str>>) -> Result<(), String> {
        self.ws();
        if self.b.get(self.i) != Some(&b'[') {
            return Err("expected an array of strings".into());
        }
        self.i += 1;
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(());
        }
        loop {
            self.ws();
            out.push(self.string_cow()?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(());
                }
                _ => return Err(format!("expected ',' or ']' at char {}", self.i)),
            }
        }
    }

    /// Consume and discard one JSON value (an unknown top-level key). Rare on the
    /// shipped shapes, so it reuses the general `value()` parser.
    fn skip_value(&mut self) -> Result<(), String> {
        self.value().map(|_| ())
    }

    /// Parse ONE ndjson line's top-level object directly into a [`Rec`], routing known
    /// keys straight into typed fields. Byte-identical to `parse_line` + the field
    /// extraction in `stage_lines` it replaces.
    fn record(
        &mut self,
        labels_arena: &mut Vec<Cow<'a, str>>,
        props_arena: &mut Vec<(Cow<'a, str>, Value)>,
    ) -> Result<Rec<'a>, String> {
        self.ws();
        if self.b.get(self.i) != Some(&b'{') {
            return Err("expected a JSON object".into());
        }
        self.i += 1;
        let mut id: Option<Cow<'a, str>> = None;
        let mut labels: Option<Span> = None;
        let mut props: Option<Span> = None;
        let mut from: Option<Cow<'a, str>> = None;
        let mut to: Option<Cow<'a, str>> = None;
        let mut ty: Option<Cow<'a, str>> = None;
        let mut schema: Option<Cow<'a, str>> = None;
        let mut s_label: Option<Cow<'a, str>> = None;
        let mut s_keys: Option<Vec<Cow<'a, str>>> = None;
        let mut s_key: Option<Cow<'a, str>> = None;

        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
        } else {
            loop {
                self.ws();
                // Borrowed: this key is matched against literals and dropped, never stored
                // (item 330). The `pairs()` key below IS stored, so that one stays owned.
                let key = self.string_cow()?;
                self.ws();
                if self.b.get(self.i) != Some(&b':') {
                    return Err(format!("expected ':' at char {}", self.i));
                }
                self.i += 1;
                match &*key {
                    "id" => id = Some(self.id_as_string()?),
                    "labels" => {
                        // Last-wins on a repeated key: rewind the arena to this record's own
                        // start so the earlier run is not left stranded between the spans.
                        if let Some((s, _)) = labels {
                            labels_arena.truncate(s as usize);
                        }
                        let s = labels_arena.len() as u32;
                        self.string_array_into(labels_arena)?;
                        labels = Some((s, labels_arena.len() as u32 - s));
                    }
                    // `properties` OR the engine's earlier `props`; last-wins if both.
                    "properties" | "props" => {
                        if let Some((s, _)) = props {
                            props_arena.truncate(s as usize);
                        }
                        let s = props_arena.len() as u32;
                        self.pairs_into(props_arena)?;
                        props = Some((s, props_arena.len() as u32 - s));
                    }
                    "from" => from = Some(self.id_as_string()?),
                    "to" => to = Some(self.id_as_string()?),
                    "type" => ty = Some(self.string_cow()?),
                    "schema" => schema = Some(self.string_cow()?),
                    "label" => s_label = Some(self.string_cow()?),
                    "keys" => s_keys = Some(self.string_array()?),
                    "key" => s_key = Some(self.string_cow()?),
                    _ => self.skip_value()?,
                }
                self.ws();
                match self.b.get(self.i) {
                    Some(b',') => self.i += 1,
                    Some(b'}') => {
                        self.i += 1;
                        break;
                    }
                    _ => return Err(format!("expected ',' or '}}' at char {}", self.i)),
                }
            }
        }

        // Route exactly like the old field-extraction: a `schema` line first, else an
        // edge (told by `from`), else a node.
        if let Some(kind) = schema {
            return match &*kind {
                "unique" => Ok(Rec::Unique(
                    s_label.ok_or("missing field `label`")?,
                    s_keys.ok_or("missing field `keys`")?,
                )),
                "required" => Ok(Rec::Required(
                    s_label.ok_or("missing field `label`")?,
                    s_key.ok_or("missing field `key`")?,
                )),
                _ => Err("unknown schema kind".into()),
            };
        }
        // An absent `properties` is an EMPTY span, not a missing one — any start works at
        // length zero, so the arena's current end is the cheapest.
        let props = props.unwrap_or((props_arena.len() as u32, 0));
        if let Some(from) = from {
            let to = to.ok_or("missing field `to`")?;
            let labels = match labels {
                Some(l) => l,
                // Legacy single-type edge: `type` is the edge type (never "edge").
                None => match ty.filter(|t| t != "edge") {
                    Some(t) => {
                        let s = labels_arena.len() as u32;
                        labels_arena.push(t);
                        (s, 1)
                    }
                    None => return Err("edge needs `labels` (or a legacy `type`)".into()),
                },
            };
            if labels.1 == 0 {
                return Err("edge `labels` must have at least one entry".into());
            }
            return Ok(Rec::Edge((from, to, id, labels, props)));
        }
        Ok(Rec::Node((
            id.ok_or("missing field `id`")?,
            labels.ok_or("missing field `labels`")?,
            props,
        )))
    }
}

/// One decoded NDJSON line routed to its destination — the direct-parse result that
/// replaces building a `Json` tree then extracting fields.
enum Rec<'a> {
    Node(NodeRec<'a>),
    Edge(EdgeRec<'a>),
    Unique(Cow<'a, str>, Vec<Cow<'a, str>>),
    Required(Cow<'a, str>, Cow<'a, str>),
}

#[cfg(test)]
mod tests {
    use super::{
        from_ndjson, from_ndjson_threads, merge_ndjson, snapshot, to_ndjson, to_ndjson_threads,
    };
    use crate::store::Builder;
    use crate::value::Value;

    fn s(x: &str) -> Value {
        Value::Str(x.into())
    }

    /// A pathologically-nested JSON value (a crafted param / mergeNdjson / snapshot line)
    /// is rejected with a coded error rather than overflowing the stack (SIGSEGV / wasm
    /// trap). Covers BOTH recursive descents: the `Json` path (`parse_json`, for params)
    /// and the `Value` path (`from_ndjson`/`merge_ndjson` property values).
    /// Item 330 made two reads in the staging parser BORROW from the input instead of allocating,
    /// which splits `string_cow` into a slice path (no escapes) and an owned-buffer path (escapes).
    ///
    /// The string-VALUE side of that is already covered — `binary_round_trips_escaped_strings`
    /// below asserts `"a\"b\nc\ttab\\end"` survives — so what is new here is the KEY side, which
    /// nothing exercised: `record()` now matches `&*key` against its literals, and an escaped key
    /// reaches that match as a `Cow::Owned`.
    #[test]
    fn an_escaped_object_key_still_matches_its_literal() {
        // `"\u0069d"` IS `"id"` once unescaped, so this must decode as a node carrying that id —
        // not skip the field as unrecognised and fail for a missing `id`.
        let st = from_ndjson(
            "{\"type\":\"node\",\"\\u0069d\":\"a\",\"labels\":[\"N\"],\"properties\":{}}",
        )
        .expect("an escaped `id` key decodes");

        assert_eq!(st.node_count(), 1, "an escaped `id` key was not recognised");
        assert!(
            st.node_by_ext("a").is_some(),
            "the node did not land under the id the escaped key named"
        );
    }

    #[test]
    fn an_escaped_property_key_is_unescaped_and_still_stored() {
        // The `pairs()` key stays OWNED (it is stored), so this guards that borrowing the
        // object-level key beside it did not disturb the one that still allocates.
        let st = from_ndjson(
            "{\"type\":\"node\",\"id\":\"a\",\"labels\":[\"N\"],\"properties\":{\"k\\tx\":1}}",
        )
        .expect("decodes");
        let n = st.node_by_ext("a").expect("the node exists");

        assert!(matches!(st.prop(n, "k\tx"), Value::Num(x) if x == 1.0));
    }

    #[test]
    fn deeply_nested_json_rejects_instead_of_overflowing_the_stack() {
        let n = super::MAX_JSON_DEPTH + 50;
        let deep = format!("{}1{}", "[".repeat(n), "]".repeat(n));

        // Json path (query params).
        assert!(
            super::parse_json(&format!("{{\"x\":{deep}}}")).is_err(),
            "deeply-nested param JSON must be rejected, not overflow",
        );

        // Value path (property value on a decoded node).
        let line = format!("{{\"id\":\"a\",\"labels\":[\"N\"],\"props\":{{\"x\":{deep}}}}}");
        assert!(
            from_ndjson(&line).is_err(),
            "deeply-nested property value must be rejected, not overflow",
        );

        // A modestly-nested value still round-trips.
        let ok = format!(
            "{{\"id\":\"a\",\"labels\":[\"N\"],\"props\":{{\"x\":{}1{}}}}}",
            "[".repeat(50),
            "]".repeat(50)
        );
        assert!(from_ndjson(&ok).is_ok(), "depth 50 should decode fine");
    }

    #[test]
    fn merge_into_empty_equals_from_ndjson() {
        let doc = "{\"id\":\"1\",\"labels\":[\"P\"],\"props\":{\"n\":\"a\"}}\n\
                   {\"id\":\"2\",\"labels\":[\"P\"],\"props\":{\"n\":\"b\"}}\n\
                   {\"from\":\"1\",\"to\":\"2\",\"id\":\"e0\",\"type\":\"R\",\"props\":{}}\n";
        let mut merged = Builder::default().build();
        merge_ndjson(&mut merged, doc).unwrap();
        assert_eq!(to_ndjson(&merged), to_ndjson(&from_ndjson(doc).unwrap()));
    }

    #[test]
    fn merge_first_wins_on_existing_node() {
        let mut st = from_ndjson(
            "{\"id\":\"1\",\"labels\":[\"P\"],\"props\":{\"n\":\"a\",\"k\":\"keep\"}}\n",
        )
        .unwrap();
        let report = merge_ndjson(
            &mut st,
            "{\"id\":\"1\",\"labels\":[\"P\"],\"props\":{\"n\":\"z\",\"age\":5}}\n",
        )
        .unwrap();
        let id = st.node_by_ext("1").unwrap();
        let v = |x: Value| format!("{x:?}"); // Value is not PartialEq — compare via Debug
                                             // First-wins: the existing node is kept UNCHANGED and reported as skipped.
        assert_eq!(
            v(st.prop(id, "n")),
            v(s("a")),
            "existing kept, not overwritten"
        );
        assert_eq!(
            v(st.prop(id, "age")),
            v(Value::Null),
            "no new key merged in"
        );
        assert_eq!(v(st.prop(id, "k")), v(s("keep")));
        assert_eq!(st.node_count(), 1);
        assert_eq!(report.nodes_skipped, vec!["1"]);
        assert_eq!(report.nodes_added, 0);
    }

    #[test]
    fn merge_adds_unknown_node_and_skips_edge_by_id() {
        let mut st = from_ndjson(
            "{\"id\":\"1\",\"labels\":[\"P\"],\"props\":{}}\n\
             {\"id\":\"2\",\"labels\":[\"P\"],\"props\":{}}\n\
             {\"from\":\"1\",\"to\":\"2\",\"id\":\"e0\",\"type\":\"R\",\"props\":{\"w\":1}}\n",
        )
        .unwrap();
        let report = merge_ndjson(
            &mut st,
            "{\"id\":\"3\",\"labels\":[\"P\"],\"props\":{}}\n\
             {\"from\":\"1\",\"to\":\"2\",\"id\":\"e0\",\"type\":\"R\",\"props\":{\"w\":9}}\n",
        )
        .unwrap();
        assert_eq!(st.node_count(), 3, "node 3 inserted");
        assert_eq!(
            st.edge_count(),
            1,
            "e0 skipped (first-wins), not duplicated"
        );
        let eid = st.all_edges()[0];
        // First-wins: the existing edge's property is kept.
        assert_eq!(
            format!("{:?}", st.edge_prop(eid, "w")),
            format!("{:?}", Value::Num(1.0))
        );
        assert_eq!(report.nodes_added, 1);
        assert_eq!(report.edges_skipped, vec!["e0"]);
    }

    #[test]
    fn merge_auto_creates_a_phantom_endpoint() {
        // An edge to an undeclared node creates a bare vertex + reports it.
        let mut st = from_ndjson("{\"id\":\"1\",\"labels\":[\"P\"],\"props\":{}}\n").unwrap();
        let report = merge_ndjson(
            &mut st,
            "{\"from\":\"1\",\"to\":\"ghost\",\"type\":\"R\",\"props\":{}}\n",
        )
        .unwrap();
        assert!(
            st.node_by_ext("ghost").is_some(),
            "phantom endpoint created"
        );
        assert_eq!(report.phantom_vertices, vec!["ghost"]);
        assert_eq!(report.edges_added, 1);
    }

    /// A required constraint survives a snapshot round trip: it dumps a schema
    /// line and the reloaded store re-enforces it.
    #[test]
    fn required_constraint_survives_snapshot() {
        let mut st = Builder::default().build();
        st.add_node(&["User"], &[("email", s("a@x"))]);
        st.create_required_constraint("User", "email").unwrap();
        let snap = snapshot(&st);
        assert!(
            snap.contains("{\"schema\":\"required\",\"label\":\"User\",\"key\":\"email\"}"),
            "schema was: {snap}"
        );
        let mut st2 = from_ndjson(&snap).unwrap();
        // The reloaded constraint still bites: a User with no email violates it.
        st2.add_node(&["User"], &[("name", s("b"))]);
        assert!(st2.check_required_for_label("User").is_err());
    }
    fn n(x: f64) -> Value {
        Value::Num(x)
    }

    /// A small graph dumps to exactly these lines — hand-written. Property keys
    /// are sorted (age before name); a node without a key omits it.
    #[test]
    fn dumps_nodes_and_edges() {
        let mut st = Builder::default().build();
        let a = st.add_node(&["P"], &[("name", s("a")), ("age", n(1.0))]);
        let b = st.add_node(&["P"], &[("name", s("b"))]);
        let eid = st.add_edge(a, b, "R");
        st.set_edge_prop(eid, "weight", n(0.5));
        let expected = "{\"type\":\"node\",\"id\":\"0\",\"labels\":[\"P\"],\"properties\":{\"age\":1,\"name\":\"a\"}}\n\
             {\"type\":\"node\",\"id\":\"1\",\"labels\":[\"P\"],\"properties\":{\"name\":\"b\"}}\n\
             {\"type\":\"edge\",\"id\":\"e0\",\"from\":\"0\",\"to\":\"1\",\"labels\":[\"R\"],\"properties\":{\"weight\":0.5}}\n";
        assert_eq!(to_ndjson(&st), expected);
    }

    /// A temporal property survives an NDJSON round trip: it dumps to the tagged
    /// form and decodes back to the same value.
    #[test]
    fn temporal_props_round_trip() {
        use crate::temporal::{Date, Temporal};
        let mut st = Builder::default().build();
        st.add_node(
            &["P"],
            &[(
                "born",
                Value::Temporal(Temporal::Date(Date::parse("1990-05-01").unwrap())),
            )],
        );
        let text = to_ndjson(&st);
        assert!(
            text.contains("\"born\":{\"@date\":\"1990-05-01\"}"),
            "egress was: {text}"
        );
        let st2 = from_ndjson(&text).unwrap();
        match st2.prop(0, "born") {
            Value::Temporal(Temporal::Date(d)) => assert_eq!(d.format(), "1990-05-01"),
            o => panic!("expected a Date after round trip, got {o:?}"),
        }
    }

    /// A record property survives an NDJSON round trip: it dumps to a JSON object
    /// (keys sorted) and decodes back to the same record.
    #[test]
    fn record_props_round_trip() {
        use crate::value::make_record;
        let mut st = Builder::default().build();
        st.add_node(
            &["P"],
            &[(
                "meta",
                make_record(vec![
                    (crate::gstr::GStr::from("y"), s("hi")),
                    (crate::gstr::GStr::from("x"), n(1.0)),
                ]),
            )],
        );
        let text = to_ndjson(&st);
        assert!(
            text.contains("\"meta\":{\"x\":1,\"y\":\"hi\"}"),
            "egress was: {text}"
        );
        let st2 = from_ndjson(&text).unwrap();
        match st2.prop(0, "meta") {
            Value::Record(f) => {
                assert_eq!(f[0].0.as_ref(), "x");
                assert!(crate::value::equals(&f[0].1, &n(1.0)));
                assert_eq!(f[1].0.as_ref(), "y");
                assert!(crate::value::equals(&f[1].1, &s("hi")));
            }
            o => panic!("expected a Record after round trip, got {o:?}"),
        }
    }

    #[test]
    fn record_key_at_sigil_round_trips_and_is_not_a_temporal() {
        use crate::temporal::{Date, Temporal};
        use crate::value::make_record;
        // A record whose single key is a temporal tag (`@date`) would be indistinguishable
        // from a tagged temporal on the wire; the codec escapes it to `@@date`, so it
        // round-trips as a RECORD, while a real temporal still decodes as a temporal.
        let mut st = Builder::default().build();
        st.add_node(
            &["P"],
            &[
                (
                    "rec",
                    make_record(vec![(crate::gstr::GStr::from("@date"), s("2024-01-15"))]),
                ),
                (
                    "real",
                    Value::Temporal(Temporal::Date(Date::parse("2020-05-05").unwrap())),
                ),
            ],
        );
        let text = to_ndjson(&st);
        assert!(
            text.contains("\"@@date\":\"2024-01-15\""),
            "the record key is escaped on the wire: {text}"
        );
        let st2 = from_ndjson(&text).unwrap();
        match st2.prop(0, "rec") {
            Value::Record(f) => {
                assert_eq!(f[0].0.as_ref(), "@date", "the `@date` KEY survives");
                assert!(crate::value::equals(&f[0].1, &s("2024-01-15")));
            }
            o => panic!("expected a Record, got {o:?}"),
        }
        assert!(
            matches!(st2.prop(0, "real"), Value::Temporal(_)),
            "a real temporal still decodes as a temporal"
        );
    }

    /// A deleted node (and its edges) is absent from the dump.
    #[test]
    fn deleted_node_excluded() {
        let mut st = Builder::default().build();
        let a = st.add_node(&["P"], &[("name", s("a"))]);
        let b = st.add_node(&["P"], &[("name", s("b"))]);
        st.add_edge(a, b, "R");
        st.delete_node(b);
        let expected =
            "{\"type\":\"node\",\"id\":\"0\",\"labels\":[\"P\"],\"properties\":{\"name\":\"a\"}}\n";
        assert_eq!(to_ndjson(&st), expected);
    }

    /// Strings are escaped; a node with no labels/props emits empty `[]`/`{}`;
    /// bool, null, and list values encode as JSON.
    #[test]
    fn escaping_and_value_kinds() {
        let mut st = Builder::default().build();
        st.add_node(
            &[],
            &[
                ("q", s("a\"b\nc")),
                ("ok", Value::Bool(true)),
                ("z", Value::Null),
                ("xs", Value::List(vec![n(1.0), s("y")])),
            ],
        );
        let out = to_ndjson(&st);
        // keys sorted: ok, q, xs, z
        let expected = "{\"type\":\"node\",\"id\":\"0\",\"labels\":[],\"properties\":\
             {\"ok\":true,\"q\":\"a\\\"b\\nc\",\"xs\":[1,\"y\"],\"z\":null}}\n";
        assert_eq!(out, expected);
    }

    /// Non-finite numbers have no JSON form and are written as null.
    #[test]
    fn non_finite_number_is_null() {
        let mut st = Builder::default().build();
        st.add_node(&[], &[("v", n(f64::NAN))]);
        assert_eq!(
            to_ndjson(&st),
            "{\"type\":\"node\",\"id\":\"0\",\"labels\":[],\"properties\":{\"v\":null}}\n"
        );
    }

    /// An empty store dumps to the empty string.
    #[test]
    fn empty_store() {
        let st = Builder::default().build();
        assert_eq!(to_ndjson(&st), "");
    }

    // --- ingest / round-trip (C2) ---

    /// dump → parse → dump is IDENTITY for a gap-free graph.
    #[test]
    fn round_trip_is_identity_gap_free() {
        let mut st = Builder::default().build();
        let a = st.add_node(&["P"], &[("name", s("a")), ("age", n(1.0))]);
        let b = st.add_node(&["P", "Q"], &[("name", s("b"))]);
        let e = st.add_edge(a, b, "R");
        st.set_edge_prop(e, "weight", n(0.5));
        let d1 = to_ndjson(&st);
        let st2 = from_ndjson(&d1).unwrap();
        assert_eq!(d1, to_ndjson(&st2));
    }

    /// Parsing a hand-written document reconstructs the graph exactly.
    #[test]
    fn parse_reconstructs_graph() {
        let doc = "{\"id\":0,\"labels\":[\"P\"],\"props\":{\"age\":1,\"name\":\"a\"}}\n\
                   {\"id\":1,\"labels\":[],\"props\":{}}\n\
                   {\"from\":0,\"to\":1,\"type\":\"R\",\"props\":{\"weight\":0.5}}\n";
        let st = from_ndjson(doc).unwrap();
        assert_eq!(st.node_count(), 2);
        assert_eq!(st.nodes_with_label("P"), &[0]);
        assert!(matches!(st.prop(0, "name"), Value::Str(x) if &*x == "a"));
        assert!(matches!(st.prop(0, "age"), Value::Num(x) if x == 1.0));
        assert_eq!(st.out(0).len(), 1);
        assert_eq!(st.out(0)[0].nbr, 1);
        let eid = st.out(0)[0].eid;
        assert!(matches!(st.edge_prop(eid, "weight"), Value::Num(x) if x == 0.5));
    }

    /// A dump with a deleted node has an id GAP; ingest remaps to dense ids
    /// (edges follow the remap) and is stable from the first reload.
    #[test]
    fn gapped_ids_remap_and_stabilize() {
        let mut st = Builder::default().build();
        let a = st.add_node(&["P"], &[("name", s("a"))]);
        let b = st.add_node(&["P"], &[("name", s("b"))]);
        let c = st.add_node(&["P"], &[("name", s("c"))]);
        st.add_edge(a, c, "R"); // 0 -> 2
        st.delete_node(b); // gap at id 1
        let d1 = to_ndjson(&st); // node ids 0 and 2
        let st2 = from_ndjson(&d1).unwrap(); // remapped to 0, 1
        assert_eq!(st2.node_count(), 2);
        assert_eq!(st2.out(0).len(), 1);
        assert!(matches!(st2.prop(st2.out(0)[0].nbr, "name"), Value::Str(x) if &*x == "c"));
        // stable from here on
        let d2 = to_ndjson(&st2);
        let st3 = from_ndjson(&d2).unwrap();
        assert_eq!(d2, to_ndjson(&st3));
    }

    /// Every value kind (escaped string, bool, null, list) round-trips.
    #[test]
    fn value_kinds_round_trip() {
        let mut st = Builder::default().build();
        st.add_node(
            &[],
            &[
                ("q", s("a\"b\nc\ttab\\end")),
                ("ok", Value::Bool(true)),
                ("z", Value::Null),
                ("xs", Value::List(vec![n(1.0), s("y"), Value::Bool(false)])),
            ],
        );
        let d1 = to_ndjson(&st);
        let st2 = from_ndjson(&d1).unwrap();
        assert_eq!(d1, to_ndjson(&st2));
        assert!(matches!(st2.prop(0, "q"), Value::Str(x) if &*x == "a\"b\nc\ttab\\end"));
        assert!(matches!(st2.prop(0, "xs"), Value::List(v) if v.len() == 3));
    }

    #[test]
    fn malformed_lines_error() {
        assert!(from_ndjson("{\"id\":0,\"labels\":[],\"props\":{}").is_err()); // missing }
        assert!(from_ndjson("not json").is_err());
        assert!(from_ndjson("{\"nope\":1}").is_err()); // neither schema/id/from
    }

    // --- schema / snapshot (C3) ---

    /// `dump_schema` emits one line per unique constraint, sorted by (label,keys).
    #[test]
    fn dump_schema_lines() {
        let mut st = Builder::default().build();
        st.create_unique_constraint("User", &["email"]).unwrap();
        st.create_unique_constraint("Doc", &["id", "rev"]).unwrap();
        let expected = "{\"schema\":\"unique\",\"label\":\"Doc\",\"keys\":[\"id\",\"rev\"]}\n\
             {\"schema\":\"unique\",\"label\":\"User\",\"keys\":[\"email\"]}\n";
        assert_eq!(super::dump_schema(&st), expected);
    }

    /// A snapshot is schema lines first, then the data.
    #[test]
    fn snapshot_is_schema_then_data() {
        let mut st = Builder::default().build();
        st.create_unique_constraint("P", &["k"]).unwrap();
        st.add_node(&["P"], &[("k", n(1.0))]);
        let expected = "{\"schema\":\"unique\",\"label\":\"P\",\"keys\":[\"k\"]}\n\
             {\"type\":\"node\",\"id\":\"0\",\"labels\":[\"P\"],\"properties\":{\"k\":1}}\n";
        assert_eq!(super::snapshot(&st), expected);
    }

    /// A full snapshot round-trips BOTH data and schema: reload is byte-identical,
    /// and the reloaded constraint still rejects a violating INSERT.
    #[test]
    fn snapshot_round_trip_preserves_schema_and_data() {
        use crate::exec::execute;
        let mut st = Builder::default().build();
        st.create_unique_constraint("User", &["email"]).unwrap();
        let a = st.add_node(&["User"], &[("email", s("a@x")), ("name", s("A"))]);
        let b = st.add_node(&["User"], &[("email", s("b@x"))]);
        st.add_edge(a, b, "KNOWS");
        let snap = super::snapshot(&st);

        let mut st2 = super::load_snapshot(&snap).unwrap();
        assert_eq!(super::snapshot(&st2), snap); // data + schema identical

        // The constraint survived: a duplicate INSERT on the reloaded store errors.
        let dup = crate::gql::parse("INSERT (:User {email: 'a@x'})").unwrap();
        assert!(execute(&dup, &mut st2).is_err());
        // …and a fresh email still inserts fine.
        let ok = crate::gql::parse("INSERT (:User {email: 'c@x'})").unwrap();
        assert!(execute(&ok, &mut st2).is_ok());
    }

    /// Parallel NDJSON encode is byte-for-byte identical to serial at any thread count —
    /// nodes/edges are split on contiguous id ranges and concatenated in order, so no
    /// bytes move. (On a build without the `parallel` feature both run serial.)
    #[test]
    fn encode_is_byte_identical_across_thread_counts() {
        let mut b = Builder::default();
        let n = 500usize;
        let ids: Vec<u32> = (0..n)
            .map(|i| {
                b.node(
                    &["Person", if i % 3 == 0 { "Admin" } else { "User" }],
                    &[
                        ("name", s(&format!("p{i}"))),
                        ("age", Value::Num(20.0 + (i % 40) as f64)),
                    ],
                )
            })
            .collect();
        for i in 0..n {
            b.edge(ids[i], ids[(i * 7 + 3) % n], "KNOWS");
            b.edge(ids[i], ids[(i * 13 + 1) % n], "FOLLOWS");
        }
        let st = b.build();
        let serial = to_ndjson_threads(&st, 1);
        assert_eq!(
            serial,
            to_ndjson_threads(&st, 4),
            "4-thread encode diverged"
        );
        assert_eq!(
            serial,
            to_ndjson_threads(&st, 8),
            "8-thread encode diverged"
        );
        assert_eq!(
            serial,
            to_ndjson_threads(&st, 16),
            "16-thread encode diverged"
        );
        // And the default wrapper equals the serial form on an unconfigured store.
        assert_eq!(serial, to_ndjson(&st));
        // Round-trips.
        assert_eq!(serial, to_ndjson(&from_ndjson(&serial).unwrap()));
    }

    /// A repeated `labels` or `properties` key on one line is LAST-WINS, and with the
    /// records sharing one arena (item 333) that means rewinding the arena to this record's
    /// own start — not to the arena's front, which would steal every earlier record's
    /// labels. The mutant that truncates to 0 survived until this test existed, because
    /// nothing else in the suite feeds a duplicated key.
    #[test]
    fn a_repeated_labels_or_properties_key_is_last_wins() {
        let doc = concat!(
            r#"{"type":"node","id":"a","labels":["First"],"properties":{"k":1}}"#,
            "\n",
            r#"{"type":"node","id":"b","labels":["Ignored"],"labels":["Winner"],"#,
            r#""properties":{"k":2},"properties":{"k":3}}"#,
            "\n",
            r#"{"type":"node","id":"c","labels":["Third"],"properties":{"k":4}}"#,
        );
        let st = from_ndjson(doc).unwrap();
        // The LAST spelling of each repeated key is the one that lands.
        let b = st.node_by_ext("b").expect("b decoded");
        assert_eq!(st.labels_of(b), vec!["Winner".to_string()]);
        assert!(matches!(st.prop(b, "k"), Value::Num(x) if x == 3.0));
        // And the records on either side keep their own, which is what a rewind to the
        // arena's front would break.
        let a = st.node_by_ext("a").expect("a decoded");
        let c = st.node_by_ext("c").expect("c decoded");
        assert_eq!(st.labels_of(a), vec!["First".to_string()]);
        assert_eq!(st.labels_of(c), vec!["Third".to_string()]);
        assert!(matches!(st.prop(a, "k"), Value::Num(x) if x == 1.0));
        assert!(matches!(st.prop(c, "k"), Value::Num(x) if x == 4.0));
    }

    /// Parallel NDJSON decode is byte-for-byte identical to serial at any thread count:
    /// the parse fans out over contiguous line-chunks but the store build stays serial,
    /// so dense ids are assigned in input order. (Compared via the serial re-encode,
    /// which is identical iff the stores hold the same ids/order/data.)
    ///
    /// THE FIXTURE IS LOAD-BEARING AND WAS NOT (audit item 333). Every record used to carry
    /// the SAME label and every edge an EMPTY `properties`, which made the test blind to the
    /// one thing item 333 added — the span rebasing that merges a parallel chunk's records
    /// into the shared arenas. Two mutants that drop the rebasing SURVIVED: an unrebased
    /// span still lands on an identical string when every string is identical, and an empty
    /// span cannot be offset wrongly. So each record now gets a label and properties DERIVED
    /// FROM ITS INDEX, which is what makes a misread span produce a different answer. This is
    /// the same fixture failure the `examples/` probes are warned about in the repo guide,
    /// found here in a unit test.
    #[test]
    fn decode_is_byte_identical_across_thread_counts() {
        let n = 2000usize;
        let mut doc = String::new();
        for i in 0..n {
            doc.push_str(&format!(
                "{{\"type\":\"node\",\"id\":\"{i}\",\"labels\":[\"Person\",\"L{}\"],\"properties\":{{\"name\":\"p{i}\",\"age\":{}}}}}\n",
                i % 17,
                20 + i % 40
            ));
        }
        for i in 0..n {
            for d in [1usize, 7, 13] {
                doc.push_str(&format!(
                    "{{\"type\":\"edge\",\"id\":\"e{}\",\"labels\":[\"KNOWS\",\"E{}\"],\"from\":\"{i}\",\"to\":\"{}\",\"properties\":{{\"w\":{},\"tag\":\"t{}\"}}}}\n",
                    i * 3 + d,
                    (i + d) % 11,
                    (i * d + 3) % n,
                    i % 5,
                    d
                ));
            }
        }
        let reference = to_ndjson_threads(&from_ndjson_threads(&doc, 1).unwrap(), 1);
        for t in [2u32, 4, 8, 16] {
            let st = from_ndjson_threads(&doc, t).unwrap();
            assert_eq!(
                reference,
                to_ndjson_threads(&st, 1),
                "decode diverged at {t} threads"
            );
        }
        // The serial `from_ndjson` wrapper agrees too.
        assert_eq!(reference, to_ndjson_threads(&from_ndjson(&doc).unwrap(), 1));
    }
}
