//! Serialization codecs mirroring the TypeScript `@lenke/serialization`
//! package: **pg-json**, **pg-text**, **graphson**, and **csv**. (NDJSON has its
//! own module, [`crate::ndjson`].) Each codec exposes `encode(&Graph) -> String`
//! and `decode(&str) -> Result<Graph, String>`, and [`serialize`] /
//! [`deserialize`] dispatch by format name (including `"ndjson"`).
//!
//! ## Two faithful divergences from the TS core
//!
//! Both are pre-existing properties of this columnar core (see [`crate::ndjson`]),
//! not codec choices:
//!   - **An edge carries a single type** (`etype`), not a label *set*. Where a
//!     format models edge labels as a list (PG-JSON `labels`, CSV `:TYPE`,
//!     GraphSON `label`), we emit the one type and, on decode, take the first
//!     label as the type.
//!   - **Every edge has an id.** It is the assigned external id, or — computed on
//!     demand — the canonical `e{index}` derived from the dense index (see
//!     [`Graph::edge_id`](crate::graph::Graph::edge_id)); the explicit-id overlay
//!     stays lazy, so the load path is unaffected. Formats with an edge-id slot
//!     (PG-JSON, GraphSON, CSV, NDJSON) **always emit** it and round-trip it.
//!     PG-text has no id slot, so its edges re-derive `e{index}` on decode rather
//!     than round-tripping an assigned id. **Node** ids round-trip exactly.
//!
//! Streaming variants (the TS `encodeStream`/`decodeStream`) are intentionally
//! omitted: the idiomatic bulk path here is the whole-string `encode`/`decode`
//! over the `Builder`, which is the codec-contract surface.

pub mod csv;
pub mod graphson;
pub mod pg_json;
pub mod pg_text;

#[cfg(test)]
mod conformance;

use std::sync::Arc;

use crate::error::{CodeError, CodeResult};
use crate::error_codes::ErrorCode;
use crate::graph::{Dict, Graph, Properties, Value};
use crate::json::Json;

// ---------------------------------------------------------------------------
// Element/property access over the columnar store
// ---------------------------------------------------------------------------

/// Present properties of element `idx`, in key-id (intern) order. A `Null` from
/// the store means *absent* — `Null` is never stored (see `set_value`) — so it
/// is skipped, matching the "key not on the element" semantics every codec uses.
pub(crate) fn element_props<'a>(
    store: &'a Properties,
    strs: &Dict,
    idx: usize,
) -> Vec<(&'a str, Value)> {
    let mut out = Vec::new();
    for kid in 0..store.cols.len() as u32 {
        let v = store.value_id(idx, kid, strs);
        if matches!(v, Value::Null) {
            continue;
        }
        out.push((store.keys.text(kid), v));
    }
    out
}

/// A node's labels as string slices, in stored order.
pub(crate) fn node_labels(g: &Graph, vi: u32) -> Vec<&str> {
    g.vertex_labels(vi)
        .iter()
        .map(|&l| g.labels.text(l))
        .collect()
}

/// True if a float is an exact integer value — GraphSON `g:Int64` vs `g:Double`,
/// CSV `integer` vs `float`. Mirrors JS `Number.isInteger`.
pub(crate) fn is_intish(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

// ---------------------------------------------------------------------------
// JSON scalar emit (shared by pg-json and graphson; mirrors ndjson)
// ---------------------------------------------------------------------------

// JSON scalar emit is shared via [`crate::jsonfmt`], so every serde-free writer
// (gremlin, ndjson, codecs) escapes strings and formats numbers identically.
pub(crate) use crate::jsonfmt::{push_json_str, push_num};

/// Emit a core [`Value`] as a plain JSON value (used by pg-json).
pub(crate) fn push_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(x) => push_num(out, *x),
        Value::Str(s) => push_json_str(out, s),
        Value::List(a) => {
            out.push('[');
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_value(out, e);
            }
            out.push(']');
        }
    }
}

// ---------------------------------------------------------------------------
// JSON scalar parse (shared by pg-json; graphson has its own typed decode)
// ---------------------------------------------------------------------------

/// A `serde_json::Value` as a core [`Value`]. A nested object is outside the LPG
/// scalar/list property model, so it's an `InvalidValue` error (mirrors the TS
/// `normalizeValue` contract) rather than a silent coercion.
pub(crate) fn json_to_value(j: &Json) -> CodeResult<Value> {
    Ok(match j {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Num(n) => Value::Num(*n),
        Json::Str(s) => Value::Str(Arc::from(s.as_str())),
        Json::Arr(a) => Value::List(
            a.iter()
                .map(json_to_value)
                .collect::<CodeResult<Vec<_>>>()?,
        ),
        Json::Obj(_) => {
            return Err(CodeError::new(
                ErrorCode::InvalidValue,
                "property value is a nested object, which is outside the LPG scalar/list model",
            ))
        }
    })
}

/// A JSON id field as a string (a string verbatim; a number/bool/null via its
/// JSON text — matching serde_json's `Display`).
pub(crate) fn json_id(j: &Json) -> String {
    match j {
        Json::Str(s) => s.clone(),
        Json::Num(n) => crate::jsonfmt::js_number(*n),
        Json::Bool(b) => b.to_string(),
        _ => "null".to_string(),
    }
}

/// A JSON array field as a `Vec<String>` (non-string elements dropped).
pub(crate) fn json_str_array(field: Option<&Json>) -> Vec<String> {
    field
        .and_then(Json::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// A JSON object field as core property pairs (used by pg-json). A nested-object
/// value anywhere is an `InvalidValue` error (see [`json_to_value`]).
pub(crate) fn json_props(field: Option<&Json>) -> CodeResult<Vec<(String, Value)>> {
    match field.and_then(Json::as_object) {
        Some(m) => m
            .iter()
            .map(|(k, v)| Ok((k.clone(), json_to_value(v)?)))
            .collect(),
        None => Ok(Vec::new()),
    }
}

// ---------------------------------------------------------------------------
// Format dispatch (mirrors the TS `serialize` / `deserialize`)
// ---------------------------------------------------------------------------

/// An unrecognized format name. The codes are now structural: an unknown name is
/// distinct from a parse failure of a *known* format (which the decoders code
/// precisely), so the FFI layer can surface `e.code` directly.
fn unknown_format(format: &str) -> CodeError {
    CodeError::new(
        ErrorCode::UnknownFormat,
        format!("unknown serialization format '{format}'"),
    )
}

/// Serialize `g` in the named format: `pg-json | pg-text | graphson | csv | ndjson`.
pub fn serialize(g: &Graph, format: &str) -> CodeResult<String> {
    match format {
        "pg-json" => Ok(pg_json::encode(g)),
        "pg-text" => Ok(pg_text::encode(g)),
        "graphson" => Ok(graphson::encode(g)),
        "csv" => Ok(csv::encode(g)),
        "ndjson" => Ok(crate::ndjson::encode(g)),
        other => Err(unknown_format(other)),
    }
}

/// Deserialize `input` in the named format into a fresh graph. A bad format name
/// yields `UnknownFormat`; a malformed payload of a known format yields the
/// decoder's own code (`InvalidJson` / `InvalidShape` / …).
pub fn deserialize(input: &str, format: &str) -> CodeResult<Graph> {
    match format {
        "pg-json" => pg_json::decode(input),
        "pg-text" => Ok(pg_text::decode(input)),
        "graphson" => graphson::decode(input),
        "csv" => csv::decode(input),
        "ndjson" => crate::ndjson::decode(input),
        other => Err(unknown_format(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A graph with one explicitly-id'd edge, via pg-json.
    fn with_edge_id() -> Graph {
        pg_json::decode(
            r#"{"nodes":[{"id":"a","labels":[],"properties":{}},{"id":"b","labels":[],"properties":{}}],"edges":[{"id":"pay-1","from":"a","to":"b","labels":["PAID"],"properties":{"amt":50}}]}"#,
        )
        .unwrap()
    }

    #[test]
    fn edge_id_round_trips_across_id_formats() {
        let g = with_edge_id();
        assert_eq!(g.edge_id(0).as_ref(), "pay-1");
        for format in ["pg-json", "graphson", "csv", "ndjson"] {
            let blob = serialize(&g, format).unwrap();
            let g2 = deserialize(&blob, format).unwrap();
            assert_eq!(g2.edge_id(0).as_ref(), "pay-1", "edge id lost via {format}");
            assert_eq!(
                g2.edge_by_id("pay-1"),
                Some(0),
                "reverse lookup lost via {format}"
            );
        }
    }

    #[test]
    fn dispatch_unknown_format_errs() {
        let g = with_edge_id();
        assert!(serialize(&g, "nope").is_err());
        assert!(deserialize("", "nope").is_err());
    }

    #[test]
    fn set_and_remove_edge_id() {
        let mut g = crate::ndjson::decode(
            "{\"type\":\"node\",\"id\":\"a\",\"labels\":[],\"properties\":{}}\n{\"type\":\"node\",\"id\":\"b\",\"labels\":[],\"properties\":{}}\n{\"type\":\"edge\",\"from\":\"a\",\"to\":\"b\",\"labels\":[\"X\"],\"properties\":{}}",
        )
        .unwrap();
        assert_eq!(g.edge_id(0).as_ref(), "e0"); // canonical `e{index}` by default
        g.set_edge_id(0, "e-custom");
        assert_eq!(g.edge_id(0).as_ref(), "e-custom");
        assert_eq!(g.edge_by_id("e-custom"), Some(0));
        // removing the edge purges the overlay
        g.remove_edge(0);
        assert_eq!(g.edge_by_id("e-custom"), None);
    }

    #[test]
    fn every_edge_has_a_canonical_id() {
        // No edge is id-less: an unassigned edge has the canonical `e{index}`,
        // resolvable in both directions, and that id is emitted by every codec.
        let g = crate::ndjson::decode(
            "{\"type\":\"node\",\"id\":\"a\",\"labels\":[],\"properties\":{}}\n\
             {\"type\":\"node\",\"id\":\"b\",\"labels\":[],\"properties\":{}}\n\
             {\"type\":\"edge\",\"from\":\"a\",\"to\":\"b\",\"labels\":[\"X\"],\"properties\":{}}\n\
             {\"type\":\"edge\",\"from\":\"b\",\"to\":\"a\",\"labels\":[\"Y\"],\"properties\":{}}",
        )
        .unwrap();
        assert_eq!(g.edge_id(0).as_ref(), "e0");
        assert_eq!(g.edge_id(1).as_ref(), "e1");
        assert_eq!(g.edge_by_id("e1"), Some(1));
        assert_eq!(g.edge_by_id("e9"), None); // out of range
                                              // The canonical id is emitted and round-trips through every id format.
        for format in ["pg-json", "graphson", "csv", "ndjson"] {
            let blob = serialize(&g, format).unwrap();
            let g2 = deserialize(&blob, format).unwrap();
            assert_eq!(
                g2.edge_id(0).as_ref(),
                "e0",
                "canonical id lost via {format}"
            );
            assert_eq!(
                g2.edge_by_id("e1"),
                Some(1),
                "reverse lookup lost via {format}"
            );
        }
    }
}
