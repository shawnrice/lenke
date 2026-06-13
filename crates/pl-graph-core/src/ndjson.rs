//! NDJSON codec for the columnar core. One JSON object per line, tagged
//! `type:"node"|"edge"`. Decoding parses lines **in parallel** (rayon) — the
//! axis single-threaded JS can't match — then assembles serially.
//!
//! Scope note: this experimental core models edge *type* (first label) but not
//! edge properties, so benchmark graphs use vertex-only properties to keep the
//! round-trip faithful. Property objects nested in values coerce to null (not
//! in the LPG scalar/list value model).

use crate::graph::{Builder, Column, EdgeRec, Graph, NodeRec, Value};
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
    let recs: Vec<Rec> = text.par_lines().filter_map(parse_line).collect();
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

fn value_to_json(v: &Value) -> J {
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Num(x) => serde_json::Number::from_f64(*x).map(J::Number).unwrap_or(J::Null),
        Value::Str(s) => J::String(s.clone()),
        Value::List(a) => J::Array(a.iter().map(value_to_json).collect()),
    }
}

fn vertex_prop(g: &Graph, vi: usize, col: &Column) -> Option<J> {
    match col {
        Column::Num { data, present } if present.get(vi) => {
            serde_json::Number::from_f64(data[vi]).map(J::Number)
        }
        Column::Str { data, present } if present.get(vi) => {
            Some(J::String(g.strs.text(data[vi]).to_string()))
        }
        Column::Bool { data, present } if present.get(vi) => Some(J::Bool(data[vi])),
        Column::Mixed { data } => data[vi].as_ref().map(value_to_json),
        _ => None,
    }
}

/// Encode a columnar graph back to NDJSON (nodes then edges).
pub fn encode(g: &Graph) -> String {
    let mut out = String::with_capacity(g.n * 64 + g.edge_count() * 48);
    for vi in 0..g.n {
        let labels: Vec<J> = {
            let s = g.vlabel_off[vi] as usize;
            let e = g.vlabel_off[vi + 1] as usize;
            g.vlabel_flat[s..e].iter().map(|&l| J::String(g.labels.text(l).to_string())).collect()
        };
        let mut props = serde_json::Map::new();
        for (&kid, col) in &g.cols {
            if let Some(jv) = vertex_prop(g, vi, col) {
                props.insert(g.keys.text(kid).to_string(), jv);
            }
        }
        let rec = serde_json::json!({
            "type": "node",
            "id": g.vid.text(vi as u32),
            "labels": labels,
            "properties": J::Object(props),
        });
        out.push_str(&rec.to_string());
        out.push('\n');
    }
    for i in 0..g.edge_count() {
        let rec = serde_json::json!({
            "type": "edge",
            "from": g.vid.text(g.e_src[i]),
            "to": g.vid.text(g.e_dst[i]),
            "labels": [g.etype.text(g.e_type[i])],
            "properties": {},
        });
        out.push_str(&rec.to_string());
        out.push('\n');
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
