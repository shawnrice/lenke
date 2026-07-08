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
use crate::jsonfmt::{push_json_str, push_num};
#[cfg(feature = "parallel")]
use rayon::prelude::*;

use crate::json::{self, Json};

fn to_value(j: &Json) -> CodeResult<Value> {
    Ok(match j {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Num(n) => Value::Num(*n),
        Json::Str(s) => Value::Str(Arc::from(s.as_str())),
        Json::Arr(a) => Value::List(a.iter().map(to_value).collect::<CodeResult<Vec<_>>>()?),
        Json::Obj(_) => return Err(CodeError::new(
            ErrorCode::InvalidValue,
            "ndjson: property value is a nested object, which is outside the LPG scalar/list model",
        )),
    })
}

/// Decode a JSON object's `properties` field into core property pairs, or an
/// empty vec when absent. A nested-object value propagates as `InvalidValue`.
fn props_of(obj: &Json) -> CodeResult<Vec<(String, Value)>> {
    match obj.get("properties").and_then(Json::as_object) {
        Some(m) => m
            .iter()
            .map(|(k, v)| Ok((k.clone(), to_value(v)?)))
            .collect(),
        None => Ok(Vec::new()),
    }
}

/// A JSON id field as a string (a string verbatim; a number/bool/null via its
/// JSON text — matching serde_json's `Display`).
fn as_id(j: &Json) -> String {
    match j {
        Json::Str(s) => s.clone(),
        Json::Num(n) => crate::jsonfmt::js_number(*n),
        Json::Bool(b) => b.to_string(),
        _ => "null".to_string(),
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
    let Ok(j) = json::parse(line) else {
        return Err(CodeError::new(
            ErrorCode::InvalidJson,
            format!("ndjson: invalid JSON: {}", snippet()),
        ));
    };
    if j.as_object().is_none() {
        return Err(CodeError::new(
            ErrorCode::InvalidShape,
            format!(
                "ndjson: each line must be a node or edge object: {}",
                snippet()
            ),
        ));
    }
    let rec = match j.get("type").and_then(Json::as_str) {
        Some("node") => {
            let id = j.get("id").map(as_id).unwrap_or_default();
            let labels = j
                .get("labels")
                .and_then(Json::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            Rec::Node(NodeRec {
                id,
                labels,
                props: props_of(&j)?,
            })
        }
        Some("edge") => {
            let src = j.get("from").map(as_id).unwrap_or_default();
            let dst = j.get("to").map(as_id).unwrap_or_default();
            let etype = j
                .get("labels")
                .and_then(Json::as_array)
                .and_then(<[Json]>::first)
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_string();
            // Optional external edge id (absent ⇒ id-less, stays lazy).
            let id = j.get("id").and_then(Json::as_str).map(String::from);
            Rec::Edge(EdgeRec {
                src,
                dst,
                etype,
                props: props_of(&j)?,
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
        // A top-level null property is a PRESENT, first-class value (distinct
        // from absent) — it reads back as Null AND is present; a key never set
        // is not present. (Divergence from the old "null = absent" model.)
        {
            let line = r#"{"type":"node","id":"a","labels":["N"],"properties":{"d":null}}"#;
            let g = decode(line).unwrap();
            let a = g.vid.get("a").unwrap() as usize;
            assert_eq!(g.props.value(a, "d", &g.strs), Value::Null);
            assert!(g.props.is_present(a, "d"), "a stored null is present");
            assert!(
                !g.props.is_present(a, "never_set"),
                "an unset key is absent"
            );
        }
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
