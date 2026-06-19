//! Serialization codecs mirroring the TypeScript `@pl-graph/serialization`
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
//!   - **Edge ids are an optional, lazy overlay.** An edge's canonical identity
//!     is its dense index; an external string id is opt-in (see
//!     [`Graph::set_edge_id`](crate::graph::Graph::set_edge_id)). Formats with an
//!     edge-id slot (PG-JSON, GraphSON, CSV, NDJSON) **round-trip** an assigned
//!     id and omit it for id-less edges (so the lazy overlay stays empty);
//!     PG-text has no id slot, so its edges are always id-less. **Node** ids
//!     round-trip exactly.
//!
//! Streaming variants (the TS `encodeStream`/`decodeStream`) are intentionally
//! omitted: the idiomatic bulk path here is the whole-string `encode`/`decode`
//! over the `Builder`, which is the codec-contract surface.

pub mod csv;
pub mod graphson;
pub mod pg_json;
pub mod pg_text;

use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::Value as J;

use crate::error::{CodeError, CodeResult};
use crate::error_codes::ErrorCode;
use crate::graph::{Dict, Graph, Properties, Value};

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

/// Write a JSON string literal (with escaping) into `out`.
pub(crate) fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Format a finite `f64` exactly as JavaScript's `Number.prototype.toString`
/// (ECMA-262 Number::toString) would — fixed notation for `-6 < n ≤ 21`,
/// exponential (`1e+21`, `1e-7`) outside that, and `-0` normalized to `0`. This
/// keeps codec number output byte-identical to the TS side. Rust's `{:e}` gives
/// the shortest round-tripping mantissa; we just place the decimal point / pick
/// fixed-vs-exponential per the spec. Non-finite input is the caller's concern.
pub(crate) fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string(); // also normalizes -0.0 → "0" (JS drops the sign)
    }
    let neg = x < 0.0;
    let sci = format!("{:e}", x.abs()); // e.g. "1.5e21", "1e-7"
    let (mant, exp_str) = sci.split_once('e').expect("{:e} always has an 'e'");
    let exp: i32 = exp_str.parse().expect("valid base-10 exponent");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32; // significant digits
    let n = exp + 1; // ECMA `n`: position of the decimal point

    let mut out = String::new();
    if neg {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let e = n - 1;
        out.push(if e >= 0 { '+' } else { '-' });
        out.push_str(&e.abs().to_string());
    }
    out
}

/// Write a finite number, or `null` for NaN/±Infinity (not representable in JSON).
pub(crate) fn push_num(out: &mut String, x: f64) {
    if x.is_finite() {
        out.push_str(&js_number(x));
    } else {
        out.push_str("null");
    }
}

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
pub(crate) fn json_to_value(j: &J) -> CodeResult<Value> {
    Ok(match j {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        J::String(s) => Value::Str(Arc::from(s.as_str())),
        J::Array(a) => Value::List(
            a.iter()
                .map(json_to_value)
                .collect::<CodeResult<Vec<_>>>()?,
        ),
        J::Object(_) => {
            return Err(CodeError::new(
                ErrorCode::InvalidValue,
                "property value is a nested object, which is outside the LPG scalar/list model",
            ))
        }
    })
}

/// A JSON id field as a string (string verbatim; numbers/other stringified).
pub(crate) fn json_id(j: &J) -> String {
    match j {
        J::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A JSON array field as a `Vec<String>` (non-string elements dropped).
pub(crate) fn json_str_array(field: Option<&J>) -> Vec<String> {
    field
        .and_then(J::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// A JSON object field as core property pairs (used by pg-json). A nested-object
/// value anywhere is an `InvalidValue` error (see [`json_to_value`]).
pub(crate) fn json_props(field: Option<&J>) -> CodeResult<Vec<(String, Value)>> {
    match field.and_then(J::as_object) {
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
        assert_eq!(g.edge_id(0), Some("pay-1"));
        for format in ["pg-json", "graphson", "csv", "ndjson"] {
            let blob = serialize(&g, format).unwrap();
            let g2 = deserialize(&blob, format).unwrap();
            assert_eq!(g2.edge_id(0), Some("pay-1"), "edge id lost via {format}");
            assert_eq!(
                g2.edge_by_id("pay-1"),
                Some(0),
                "reverse lookup lost via {format}"
            );
        }
    }

    #[test]
    fn js_number_matches_js_tostring() {
        // Must match JavaScript Number.prototype.toString byte-for-byte, incl.
        // the fixed/exponential threshold (n>21 or n≤-6) and -0 → "0".
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (100.0, "100"),
            (0.5, "0.5"),
            (1234.5, "1234.5"),
            (12300.0, "12300"),
            (0.1, "0.1"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e-10, "1e-10"),
            (1e100, "1e+100"),
            (-1e-7, "-1e-7"),
            (3.14159, "3.14159"),
        ];
        for &(x, want) in cases {
            assert_eq!(js_number(x), want, "js_number({x})");
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
        assert_eq!(g.edge_id(0), None); // id-less by default
        g.set_edge_id(0, "e-custom");
        assert_eq!(g.edge_id(0), Some("e-custom"));
        assert_eq!(g.edge_by_id("e-custom"), Some(0));
        // removing the edge purges the overlay
        g.remove_edge(0);
        assert_eq!(g.edge_by_id("e-custom"), None);
    }
}
