//! NDJSON codec for the columnar core. One JSON object per line, tagged
//! `type:"node"|"edge"`. Decoding parses lines **in parallel** (rayon) — the
//! axis single-threaded JS can't match — then assembles serially.
//!
//! Scope note: an edge's *type* is its first label. Edge **properties** are
//! supported (same columnar store as vertex properties). A property value that
//! is a nested object is outside the LPG scalar/list model → `InvalidValue`
//! (matching the TS codec), rather than a silent null coercion.

use std::sync::Arc;

use crate::error::{CodeError, CodeResult};
use crate::error_codes::ErrorCode;
use crate::graph::{Builder, Column, Dict, EdgeRec, Graph, NodeRec, Properties, Value};
#[cfg(feature = "parallel")]
use rayon::prelude::*;
use serde_json::Value as J;

fn to_value(j: &J) -> CodeResult<Value> {
    Ok(match j {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        J::String(s) => Value::Str(Arc::from(s.as_str())),
        J::Array(a) => Value::List(a.iter().map(to_value).collect::<CodeResult<Vec<_>>>()?),
        J::Object(_) => return Err(CodeError::new(
            ErrorCode::InvalidValue,
            "ndjson: property value is a nested object, which is outside the LPG scalar/list model",
        )),
    })
}

/// Decode a JSON object's `properties` field into core property pairs, or an
/// empty vec when absent. A nested-object value propagates as `InvalidValue`.
fn props_of(obj: &serde_json::Map<String, J>) -> CodeResult<Vec<(String, Value)>> {
    match obj.get("properties").and_then(J::as_object) {
        Some(m) => m
            .iter()
            .map(|(k, v)| Ok((k.clone(), to_value(v)?)))
            .collect(),
        None => Ok(Vec::new()),
    }
}

fn as_id(j: &J) -> String {
    match j {
        J::String(s) => s.clone(),
        other => other.to_string(),
    }
}

enum Rec {
    Node(NodeRec),
    Edge(EdgeRec),
}

/// Parse one line. A blank line is skipped (`Ok(None)`); everything else is
/// strict and matches the TS codec: invalid JSON → `InvalidJson`, a non-object
/// or an unknown/missing `type` → `InvalidShape`, a nested-object property value
/// → `InvalidValue`. (Previously these all silently skipped the line, which
/// could mask corrupt fixtures since `decode` is the crate's test-fixture loader.)
fn parse_line(line: &str) -> CodeResult<Option<Rec>> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let snippet = || line.chars().take(80).collect::<String>();
    let Ok(j) = serde_json::from_str::<J>(line) else {
        return Err(CodeError::new(
            ErrorCode::InvalidJson,
            format!("ndjson: invalid JSON: {}", snippet()),
        ));
    };
    let Some(obj) = j.as_object() else {
        return Err(CodeError::new(
            ErrorCode::InvalidShape,
            format!(
                "ndjson: each line must be a node or edge object: {}",
                snippet()
            ),
        ));
    };
    let rec = match obj.get("type").and_then(J::as_str) {
        Some("node") => {
            let id = obj.get("id").map(as_id).unwrap_or_default();
            let labels = obj
                .get("labels")
                .and_then(J::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            Rec::Node(NodeRec {
                id,
                labels,
                props: props_of(obj)?,
            })
        }
        Some("edge") => {
            let src = obj.get("from").map(as_id).unwrap_or_default();
            let dst = obj.get("to").map(as_id).unwrap_or_default();
            let etype = obj
                .get("labels")
                .and_then(J::as_array)
                .and_then(|a| a.first())
                .and_then(J::as_str)
                .unwrap_or("")
                .to_string();
            // Optional external edge id (absent ⇒ id-less, stays lazy).
            let id = obj.get("id").and_then(J::as_str).map(String::from);
            Rec::Edge(EdgeRec {
                src,
                dst,
                etype,
                props: props_of(obj)?,
                id,
            })
        }
        _ => {
            return Err(CodeError::new(
                ErrorCode::InvalidShape,
                format!(
                    "ndjson: line is not a 'node' or 'edge' record: {}",
                    snippet()
                ),
            ))
        }
    };
    Ok(Some(rec))
}

/// Decode NDJSON into a columnar graph. Lines parse in parallel; the build is
/// serial (shared dictionaries).
pub fn decode(text: &str) -> CodeResult<Graph> {
    // `collect` into a Result short-circuits on the first InvalidValue (rayon's
    // parallel collect supports this), so one bad line fails the whole decode.
    #[cfg(feature = "parallel")]
    let recs: Vec<Option<Rec>> = text
        .par_lines()
        .map(parse_line)
        .collect::<CodeResult<_>>()?;
    #[cfg(not(feature = "parallel"))]
    let recs: Vec<Option<Rec>> = text.lines().map(parse_line).collect::<CodeResult<_>>()?;
    let mut b = Builder::default();
    for r in recs.into_iter().flatten() {
        match r {
            Rec::Node(n) => b.nodes.push(n),
            Rec::Edge(e) => b.edges.push(e),
        }
    }
    Ok(b.finalize())
}

/// Decode without parallelism — for isolating rayon's contribution in the bench.
pub fn decode_serial(text: &str) -> CodeResult<Graph> {
    let mut b = Builder::default();
    for line in text.lines() {
        match parse_line(line)? {
            Some(Rec::Node(n)) => b.nodes.push(n),
            Some(Rec::Edge(e)) => b.edges.push(e),
            None => {}
        }
    }
    Ok(b.finalize())
}

/// Write a JSON string literal (with escaping) straight into `out`.
fn push_json_str(out: &mut String, s: &str) {
    use std::fmt::Write as _;
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

fn push_num(out: &mut String, x: f64) {
    if x.is_finite() {
        out.push_str(&js_number(x));
    } else {
        out.push_str("null");
    }
}

/// Format a finite `f64` exactly as JavaScript's `Number.prototype.toString`
/// (ECMA-262 Number::toString) would — fixed notation for `-6 < n ≤ 21`,
/// exponential (`1e+21`, `1e-7`) outside that, and `-0` normalized to `0`. This
/// keeps number output byte-identical to the TS side. Rust's `{:e}` gives the
/// shortest round-tripping mantissa; we just place the decimal point / pick
/// fixed-vs-exponential per the spec. Non-finite input is the caller's concern.
///
/// Lives here (the base `ndjson` feature) rather than in `codec` so a minimal
/// `--features ndjson` build — the leanest one that can still load a graph — is
/// self-contained; `codecs` (which implies `ndjson`) reuses it from here.
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

fn push_value(out: &mut String, v: &Value) {
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

/// Is property `col` present at element `idx`?
fn col_present(col: &Column, idx: usize) -> bool {
    match col {
        Column::Num { present, .. }
        | Column::Str { present, .. }
        | Column::Bool { present, .. } => present.get(idx),
        Column::Mixed { data } => data[idx].is_some(),
    }
}

/// Emit the `{...}` body of an element's properties from a columnar store —
/// shared by node and edge encoding. `strs` backs the string columns.
fn push_props(out: &mut String, store: &Properties, strs: &Dict, idx: usize) {
    out.push('{');
    let mut first = true;
    for (kid, col) in store.cols.iter().enumerate() {
        if !col_present(col, idx) {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        push_json_str(out, store.keys.text(kid as u32));
        out.push(':');
        match col {
            Column::Num { data, .. } => push_num(out, data[idx]),
            Column::Str { data, .. } => push_json_str(out, strs.text(data[idx])),
            Column::Bool { data, .. } => out.push_str(if data[idx] { "true" } else { "false" }),
            Column::Mixed { data } => push_value(out, data[idx].as_ref().unwrap()),
        }
    }
    out.push('}');
}

/// Encode a columnar graph back to NDJSON (nodes then edges). Builds the string
/// directly — no per-record `serde_json::Value` allocation.
pub fn encode(g: &Graph) -> String {
    let mut out = String::with_capacity(g.vertex_count() * 64 + g.edge_count() * 48);
    for vi in 0..g.n {
        if !g.is_vertex_live(vi as u32) {
            continue; // skip tombstoned vertices
        }
        out.push_str("{\"type\":\"node\",\"id\":");
        push_json_str(&mut out, g.vid.text(vi as u32));
        out.push_str(",\"labels\":[");
        for (i, &l) in g.vertex_labels(vi as u32).iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_json_str(&mut out, g.labels.text(l));
        }
        out.push_str("],\"properties\":");
        push_props(&mut out, &g.props, &g.strs, vi);
        out.push_str("}\n");
    }
    for i in 0..g.edge_slots() {
        if !g.is_edge_live(i as u32) {
            continue; // skip tombstoned edges
        }
        out.push_str("{\"type\":\"edge\"");
        // Every edge has an id (assigned, or canonical `e{index}`) — always emit.
        out.push_str(",\"id\":");
        push_json_str(&mut out, &g.edge_id(i as u32));
        out.push_str(",\"from\":");
        push_json_str(&mut out, g.vid.text(g.e_src[i]));
        out.push_str(",\"to\":");
        push_json_str(&mut out, g.vid.text(g.e_dst[i]));
        out.push_str(",\"labels\":[");
        push_json_str(&mut out, g.etype.text(g.e_type[i]));
        out.push_str("],\"properties\":");
        push_props(&mut out, &g.edge_props, &g.strs, i);
        out.push_str("}\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
            (1.25, "1.25"),
        ];
        for &(x, want) in cases {
            assert_eq!(js_number(x), want, "js_number({x})");
        }
    }

    #[test]
    fn nested_object_property_is_invalid_value() {
        // A nested object is outside the LPG scalar/list model (matching TS ndjson).
        let line = r#"{"type":"node","id":"a","labels":[],"properties":{"bad":{"x":1}}}"#;
        match decode(line) {
            Err(e) => assert_eq!(e.code, ErrorCode::InvalidValue),
            Ok(_) => panic!("expected InvalidValue"),
        }
        // The serial path agrees with the parallel one.
        match decode_serial(line) {
            Err(e) => assert_eq!(e.code, ErrorCode::InvalidValue),
            Ok(_) => panic!("expected InvalidValue"),
        }
    }

    #[test]
    fn round_trip_preserves_content() {
        let input = "\
{\"type\":\"node\",\"id\":\"a\",\"labels\":[\"Person\"],\"properties\":{\"name\":\"ann\",\"age\":30,\"active\":true}}
{\"type\":\"node\",\"id\":\"b\",\"labels\":[\"Person\"],\"properties\":{\"name\":\"bo\",\"age\":25,\"active\":false}}
{\"type\":\"edge\",\"from\":\"a\",\"to\":\"b\",\"labels\":[\"KNOWS\"],\"properties\":{}}";
        let g = decode(input).unwrap();
        assert_eq!(g.n, 2);
        assert_eq!(g.edge_count(), 1);
        // re-decoding the encoding yields the same shape
        let g2 = decode(&encode(&g)).unwrap();
        assert_eq!(g2.n, 2);
        assert_eq!(g2.edge_count(), 1);
        // age column present and correct
        let age_kid = g2.props.keys.get("age").unwrap();
        match &g2.props.cols[age_kid as usize] {
            Column::Num { data, .. } => {
                let a = g2.vid.get("a").unwrap() as usize;
                assert_eq!(data[a], 30.0);
            }
            _ => panic!("age should be a Num column"),
        }
    }

    #[test]
    fn strict_decode_rejects_malformed_lines() {
        use crate::error_codes::ErrorCode;
        // `.err().unwrap()` rather than `unwrap_err()` (Graph has no Debug impl).
        let code = |s: &str| decode(s).err().unwrap().code;
        // Invalid JSON → InvalidJson (matches TS, instead of a silent skip).
        assert_eq!(code("{not json"), ErrorCode::InvalidJson);
        // Valid JSON but not an object → InvalidShape.
        assert_eq!(code("42"), ErrorCode::InvalidShape);
        assert_eq!(code("[1,2]"), ErrorCode::InvalidShape);
        // Object with unknown/missing `type` → InvalidShape.
        assert_eq!(code(r#"{"type":"banana"}"#), ErrorCode::InvalidShape);
        assert_eq!(code(r#"{"id":"a"}"#), ErrorCode::InvalidShape);
        // Blank lines are still skipped (not an error).
        let g = decode("\n  \n{\"type\":\"node\",\"id\":\"a\",\"labels\":[],\"properties\":{}}\n")
            .unwrap();
        assert_eq!(g.n, 1);
    }

    #[test]
    fn deeply_nested_array_is_rejected_not_overflow() {
        use crate::error_codes::ErrorCode;
        // serde caps nesting at 128 levels during parse → a clean InvalidJson,
        // never a stack overflow or a silent accept (matches the TS depth guard).
        let deep = format!("{}1{}", "[".repeat(2000), "]".repeat(2000));
        let line = format!(r#"{{"type":"node","id":"a","labels":[],"properties":{{"x":{deep}}}}}"#);
        assert_eq!(decode(&line).err().unwrap().code, ErrorCode::InvalidJson);
    }

    #[test]
    fn duplicate_ids_first_wins_node_drop_second_edge() {
        // Matches the TS core: a duplicate node id is first-wins (later labels/
        // props ignored), and an edge with an already-seen id is dropped.
        let g = decode(
            "{\"type\":\"node\",\"id\":\"a\",\"labels\":[\"L1\"],\"properties\":{\"x\":1}}\n\
             {\"type\":\"node\",\"id\":\"a\",\"labels\":[\"L2\"],\"properties\":{\"x\":2}}\n\
             {\"type\":\"node\",\"id\":\"b\",\"labels\":[],\"properties\":{}}\n\
             {\"type\":\"edge\",\"id\":\"x\",\"from\":\"a\",\"to\":\"b\",\"labels\":[\"R\"],\"properties\":{}}\n\
             {\"type\":\"edge\",\"id\":\"x\",\"from\":\"b\",\"to\":\"a\",\"labels\":[\"S\"],\"properties\":{}}",
        )
        .unwrap();
        assert_eq!(g.n, 2); // a (first-wins) + b
        let a = g.vid.get("a").unwrap();
        let labels: Vec<&str> = g
            .vertex_labels(a)
            .iter()
            .map(|&l| g.labels.text(l))
            .collect();
        assert_eq!(labels, vec!["L1"]); // first-wins: L2 ignored
        assert_eq!(g.props.value(a as usize, "x", &g.strs), Value::Num(1.0)); // first-wins
        assert_eq!(g.edge_count(), 1); // drop-second: only the first edge id 'x'
        assert_eq!(g.etype.text(g.e_type[0]), "R");
    }

    // ===== decode characterization =====
    //
    // Assert the exact `Value` that `decode` parses each JSON property into, so
    // the hand-rolled parser (which will replace `serde_json::from_str`) can be
    // proven equivalent. Covers escape decoding (incl. `\uXXXX` + surrogate
    // pairs), number forms, list/bool/null, and whitespace. Malformed-input
    // rejection is locked by `strict_decode_rejects_malformed_lines`,
    // `deeply_nested_array_is_rejected_not_overflow`, and the lone-surrogate
    // test below.

    fn decoded(props: &str, key: &str) -> Value {
        let line = format!(r#"{{"type":"node","id":"a","labels":["N"],"properties":{props}}}"#);
        let g = decode(&line).unwrap();
        let a = g.vid.get("a").unwrap() as usize;
        g.props.value(a, key, &g.strs)
    }
    fn str_val(s: &str) -> Value {
        Value::Str(s.into())
    }

    #[test]
    fn decode_string_escapes() {
        assert_eq!(decoded(r#"{"s":"a\"b"}"#, "s"), str_val("a\"b"));
        assert_eq!(decoded(r#"{"s":"a\\b"}"#, "s"), str_val("a\\b"));
        assert_eq!(decoded(r#"{"s":"a\/b"}"#, "s"), str_val("a/b")); // \/ → /
        assert_eq!(decoded(r#"{"s":"a\tb\nc\rd"}"#, "s"), str_val("a\tb\nc\rd"));
        assert_eq!(
            decoded(r#"{"s":"a\bb\fc"}"#, "s"),
            str_val("a\u{08}b\u{0c}c")
        );
        // \uXXXX (BMP) and surrogate pairs (astral) decode to real chars.
        assert_eq!(decoded(r#"{"s":"\u0041\u00e9"}"#, "s"), str_val("A\u{e9}"));
        assert_eq!(
            decoded(r#"{"s":"\ud83e\udd80"}"#, "s"),
            str_val("\u{1F980}")
        );
    }

    #[test]
    fn decode_number_forms() {
        assert_eq!(decoded(r#"{"n":42}"#, "n"), Value::Num(42.0));
        assert_eq!(decoded(r#"{"n":-7}"#, "n"), Value::Num(-7.0));
        assert_eq!(decoded(r#"{"n":1.5}"#, "n"), Value::Num(1.5));
        assert_eq!(decoded(r#"{"n":1.5e3}"#, "n"), Value::Num(1500.0)); // exponent
        assert_eq!(decoded(r#"{"n":2.5e-3}"#, "n"), Value::Num(0.0025));
    }

    #[test]
    fn decode_bool_null_and_lists() {
        assert_eq!(decoded(r#"{"b":true}"#, "b"), Value::Bool(true));
        assert_eq!(decoded(r#"{"c":false}"#, "c"), Value::Bool(false));
        // A top-level null property is absent (null = absent in this LPG model)…
        assert_eq!(decoded(r#"{"d":null}"#, "d"), Value::Null);
        // …but null INSIDE a list value is preserved.
        assert_eq!(
            decoded(r#"{"xs":[1,2,3]}"#, "xs"),
            Value::List(vec![Value::Num(1.0), Value::Num(2.0), Value::Num(3.0)])
        );
        assert_eq!(
            decoded(r#"{"xs":["a",2,true,null]}"#, "xs"),
            Value::List(vec![
                str_val("a"),
                Value::Num(2.0),
                Value::Bool(true),
                Value::Null
            ])
        );
        assert_eq!(
            decoded(r#"{"xs":[[1],[2,3]]}"#, "xs"),
            Value::List(vec![
                Value::List(vec![Value::Num(1.0)]),
                Value::List(vec![Value::Num(2.0), Value::Num(3.0)]),
            ])
        );
    }

    #[test]
    fn decode_tolerates_whitespace() {
        assert_eq!(
            decoded("{ \"n\" : 1 , \"s\" : \"x\" }", "n"),
            Value::Num(1.0)
        );
        assert_eq!(decoded("{ \"n\" : 1 , \"s\" : \"x\" }", "s"), str_val("x"));
    }

    #[test]
    fn decode_rejects_lone_surrogate() {
        use crate::error_codes::ErrorCode;
        // A lone high surrogate is not valid JSON — must be rejected, not decoded
        // to a replacement char (serde behavior; the hand-rolled parser must match).
        let line = r#"{"type":"node","id":"a","labels":["N"],"properties":{"s":"\ud83e"}}"#;
        assert_eq!(decode(line).err().unwrap().code, ErrorCode::InvalidJson);
    }
}
