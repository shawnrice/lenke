//! NDJSON codec for the columnar core. One JSON object per line, tagged
//! `type:"node"|"edge"`. Decoding parses lines **in parallel** (rayon) — the
//! axis single-threaded JS can't match — then assembles serially.
//!
//! Scope note: this experimental core models edge *type* (first label) but not
//! edge properties, so benchmark graphs use vertex-only properties to keep the
//! round-trip faithful. Property objects nested in values coerce to null (not
//! in the LPG scalar/list value model).

use crate::graph::{Builder, Column, EdgeRec, Graph, NodeRec, Value};
#[cfg(feature = "parallel")]
use rayon::prelude::*;
use serde_json::Value as J;

fn to_value(j: &J) -> Value {
    match j {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        J::String(s) => Value::Str(s.clone()),
        J::Array(a) => Value::List(a.iter().map(to_value).collect()),
        J::Object(_) => Value::Null,
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

fn parse_line(line: &str) -> Option<Rec> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let j: J = serde_json::from_str(line).ok()?;
    let obj = j.as_object()?;
    match obj.get("type").and_then(J::as_str)? {
        "node" => {
            let id = obj.get("id").map(as_id).unwrap_or_default();
            let labels = obj
                .get("labels")
                .and_then(J::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let props = obj
                .get("properties")
                .and_then(J::as_object)
                .map(|m| m.iter().map(|(k, v)| (k.clone(), to_value(v))).collect())
                .unwrap_or_default();
            Some(Rec::Node(NodeRec { id, labels, props }))
        }
        "edge" => {
            let src = obj.get("from").map(as_id).unwrap_or_default();
            let dst = obj.get("to").map(as_id).unwrap_or_default();
            let etype = obj
                .get("labels")
                .and_then(J::as_array)
                .and_then(|a| a.first())
                .and_then(J::as_str)
                .unwrap_or("")
                .to_string();
            Some(Rec::Edge(EdgeRec { src, dst, etype }))
        }
        _ => None,
    }
}

/// Decode NDJSON into a columnar graph. Lines parse in parallel; the build is
/// serial (shared dictionaries).
pub fn decode(text: &str) -> Graph {
    #[cfg(feature = "parallel")]
    let recs: Vec<Rec> = text.par_lines().filter_map(parse_line).collect();
    #[cfg(not(feature = "parallel"))]
    let recs: Vec<Rec> = text.lines().filter_map(parse_line).collect();
    let mut b = Builder::default();
    for r in recs {
        match r {
            Rec::Node(n) => b.nodes.push(n),
            Rec::Edge(e) => b.edges.push(e),
        }
    }
    b.finalize()
}

/// Decode without parallelism — for isolating rayon's contribution in the bench.
pub fn decode_serial(text: &str) -> Graph {
    let mut b = Builder::default();
    for line in text.lines() {
        match parse_line(line) {
            Some(Rec::Node(n)) => b.nodes.push(n),
            Some(Rec::Edge(e)) => b.edges.push(e),
            None => {}
        }
    }
    b.finalize()
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
    use std::fmt::Write as _;
    if x.is_finite() {
        let _ = write!(out, "{x}");
    } else {
        out.push_str("null");
    }
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

/// Is property `col` present at vertex `vi`?
fn col_present(col: &Column, vi: usize) -> bool {
    match col {
        Column::Num { present, .. } | Column::Str { present, .. } | Column::Bool { present, .. } => {
            present.get(vi)
        }
        Column::Mixed { data } => data[vi].is_some(),
    }
}

/// Encode a columnar graph back to NDJSON (nodes then edges). Builds the string
/// directly — no per-record `serde_json::Value` allocation.
pub fn encode(g: &Graph) -> String {
    let mut out = String::with_capacity(g.n * 64 + g.edge_count() * 48);
    for vi in 0..g.n {
        out.push_str("{\"type\":\"node\",\"id\":");
        push_json_str(&mut out, g.vid.text(vi as u32));
        out.push_str(",\"labels\":[");
        let s = g.vlabel_off[vi] as usize;
        let e = g.vlabel_off[vi + 1] as usize;
        for (i, &l) in g.vlabel_flat[s..e].iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_json_str(&mut out, g.labels.text(l));
        }
        out.push_str("],\"properties\":{");
        let mut first = true;
        for (&kid, col) in &g.cols {
            if !col_present(col, vi) {
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            push_json_str(&mut out, g.keys.text(kid));
            out.push(':');
            match col {
                Column::Num { data, .. } => push_num(&mut out, data[vi]),
                Column::Str { data, .. } => push_json_str(&mut out, g.strs.text(data[vi])),
                Column::Bool { data, .. } => out.push_str(if data[vi] { "true" } else { "false" }),
                Column::Mixed { data } => push_value(&mut out, data[vi].as_ref().unwrap()),
            }
        }
        out.push_str("}}\n");
    }
    for i in 0..g.edge_count() {
        out.push_str("{\"type\":\"edge\",\"from\":");
        push_json_str(&mut out, g.vid.text(g.e_src[i]));
        out.push_str(",\"to\":");
        push_json_str(&mut out, g.vid.text(g.e_dst[i]));
        out.push_str(",\"labels\":[");
        push_json_str(&mut out, g.etype.text(g.e_type[i]));
        out.push_str("],\"properties\":{}}\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_content() {
        let input = "\
{\"type\":\"node\",\"id\":\"a\",\"labels\":[\"Person\"],\"properties\":{\"name\":\"ann\",\"age\":30,\"active\":true}}
{\"type\":\"node\",\"id\":\"b\",\"labels\":[\"Person\"],\"properties\":{\"name\":\"bo\",\"age\":25,\"active\":false}}
{\"type\":\"edge\",\"from\":\"a\",\"to\":\"b\",\"labels\":[\"KNOWS\"],\"properties\":{}}";
        let g = decode(input);
        assert_eq!(g.n, 2);
        assert_eq!(g.edge_count(), 1);
        // re-decoding the encoding yields the same shape
        let g2 = decode(&encode(&g));
        assert_eq!(g2.n, 2);
        assert_eq!(g2.edge_count(), 1);
        // age column present and correct
        let age_kid = g2.keys.get("age").unwrap();
        match &g2.cols[&age_kid] {
            Column::Num { data, .. } => {
                let a = g2.vid.get("a").unwrap() as usize;
                assert_eq!(data[a], 30.0);
            }
            _ => panic!("age should be a Num column"),
        }
    }
}
