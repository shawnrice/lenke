//! PG-JSON codec (https://pg-format.readthedocs.io) for the columnar core.
//!
//! Wire shape (a single JSON document):
//! ```text
//! { "nodes": [{ "id", "labels": [...], "properties": {...} }],
//!   "edges": [{ "id", "from", "to", "undirected", "labels": [...], "properties": {...} }] }
//! ```
//!
//! Lossiness follows the shared model (see [`crate::codec`]): node ids round-trip
//! exactly; numeric ids in a *foreign* document are read as strings; an edge's
//! optional external id round-trips (emitted only when assigned, read on decode);
//! `undirected` is always emitted `false` and ignored on decode (directed core).

use serde_json::Value as J;

use crate::codec::{
    element_props, json_id, json_props, json_str_array, node_labels, push_json_str, push_value,
};
use crate::error::{CodeError, CodeResult};
use crate::error_codes::ErrorCode;
use crate::graph::{Builder, EdgeRec, Graph, NodeRec};

/// Emit an element's present properties as a JSON object.
fn push_props(out: &mut String, props: &[(&str, crate::graph::Value)]) {
    out.push('{');
    for (i, (k, v)) in props.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        push_json_str(out, k);
        out.push(':');
        push_value(out, v);
    }
    out.push('}');
}

/// Serialize a graph to a PG-JSON string (compact, single pass).
pub fn encode(g: &Graph) -> String {
    let mut out = String::with_capacity(g.vertex_count() * 64 + g.edge_count() * 64);
    out.push_str("{\"nodes\":[");
    let mut first = true;
    for vi in 0..g.n {
        if !g.is_vertex_live(vi as u32) {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str("{\"id\":");
        push_json_str(&mut out, g.vid.text(vi as u32));
        out.push_str(",\"labels\":[");
        for (i, l) in node_labels(g, vi as u32).iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            push_json_str(&mut out, l);
        }
        out.push_str("],\"properties\":");
        push_props(&mut out, &element_props(&g.props, &g.strs, vi));
        out.push('}');
    }
    out.push_str("],\"edges\":[");
    first = true;
    for i in 0..g.edge_slots() {
        if !g.is_edge_live(i as u32) {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        out.push('{');
        if let Some(id) = g.edge_id(i as u32) {
            out.push_str("\"id\":");
            push_json_str(&mut out, id);
            out.push(',');
        }
        out.push_str("\"from\":");
        push_json_str(&mut out, g.vid.text(g.e_src[i]));
        out.push_str(",\"to\":");
        push_json_str(&mut out, g.vid.text(g.e_dst[i]));
        out.push_str(",\"undirected\":false,\"labels\":[");
        push_json_str(&mut out, g.etype.text(g.e_type[i]));
        out.push_str("],\"properties\":");
        push_props(&mut out, &element_props(&g.edge_props, &g.strs, i));
        out.push('}');
    }
    out.push_str("]}");
    out
}

/// Deserialize a PG-JSON string into a fresh graph.
pub fn decode(input: &str) -> CodeResult<Graph> {
    let j: J = serde_json::from_str(input).map_err(|e| {
        CodeError::new(
            ErrorCode::InvalidJson,
            format!("pg-json: invalid JSON: {e}"),
        )
    })?;
    let obj = j.as_object().ok_or_else(|| {
        CodeError::new(
            ErrorCode::InvalidShape,
            "pg-json: expected a top-level object",
        )
    })?;

    let mut b = Builder::default();

    if let Some(nodes) = obj.get("nodes").and_then(J::as_array) {
        for node in nodes {
            let Some(o) = node.as_object() else { continue };
            b.nodes.push(NodeRec {
                id: o.get("id").map(json_id).unwrap_or_default(),
                labels: json_str_array(o.get("labels")),
                props: json_props(o.get("properties"))?,
            });
        }
    }

    if let Some(edges) = obj.get("edges").and_then(J::as_array) {
        for edge in edges {
            let Some(o) = edge.as_object() else { continue };
            // The core edge carries one type — take the first label.
            let etype = o
                .get("labels")
                .and_then(J::as_array)
                .and_then(|a| a.first())
                .and_then(J::as_str)
                .unwrap_or("")
                .to_string();
            b.edges.push(EdgeRec {
                src: o.get("from").map(json_id).unwrap_or_default(),
                dst: o.get("to").map(json_id).unwrap_or_default(),
                etype,
                props: json_props(o.get("properties"))?,
                id: o.get("id").map(json_id),
            });
        }
    }

    b.finalize_strict()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Column, Value};

    fn sample() -> &'static str {
        r#"{"nodes":[{"id":"a","labels":["Person"],"properties":{"name":"ann","age":30,"active":true,"tags":["x","y"]}},{"id":"b","labels":["Person","Admin"],"properties":{"name":"bo"}}],"edges":[{"id":"ignored","from":"a","to":"b","undirected":false,"labels":["KNOWS"],"properties":{"since":2020}}]}"#
    }

    #[test]
    fn round_trip() {
        let g = decode(sample()).unwrap();
        assert_eq!(g.vertex_count(), 2);
        assert_eq!(g.edge_count(), 1);
        // multi-label node preserved
        let b = g.vid.get("b").unwrap();
        assert_eq!(node_labels(&g, b).len(), 2);
        // re-encode then decode is stable
        let g2 = decode(&encode(&g)).unwrap();
        assert_eq!(g2.vertex_count(), 2);
        assert_eq!(g2.edge_count(), 1);
        let a = g2.vid.get("a").unwrap() as usize;
        let age = g2.props.keys.get("age").unwrap();
        match &g2.props.cols[age as usize] {
            Column::Num { data, .. } => assert_eq!(data[a], 30.0),
            _ => panic!("age should be Num"),
        }
        // list property survives
        assert_eq!(
            g2.props.value(a, "tags", &g2.strs),
            Value::List(vec![Value::Str("x".into()), Value::Str("y".into())]),
        );
    }

    #[test]
    fn bad_json_errs() {
        assert!(decode("{not json").is_err());
    }

    fn decode_err_code(doc: &str) -> ErrorCode {
        match decode(doc) {
            Err(e) => e.code,
            Ok(_) => panic!("expected an error, got Ok"),
        }
    }

    #[test]
    fn edge_to_undeclared_vertex_is_missing_vertex() {
        // 'b' is never declared as a node — strict decode rejects the dangling edge.
        let doc = r#"{"nodes":[{"id":"a","labels":[],"properties":{}}],"edges":[{"from":"a","to":"b","labels":["R"],"properties":{}}]}"#;
        assert_eq!(decode_err_code(doc), ErrorCode::MissingVertex);
    }

    #[test]
    fn nested_object_property_is_invalid_value() {
        // A nested object is outside the LPG scalar/list model.
        let doc = r#"{"nodes":[{"id":"a","labels":[],"properties":{"bad":{"x":1}}}],"edges":[]}"#;
        assert_eq!(decode_err_code(doc), ErrorCode::InvalidValue);
    }

    #[test]
    fn edge_id_round_trips() {
        let doc = r#"{"nodes":[{"id":"a","labels":[],"properties":{}},{"id":"b","labels":[],"properties":{}}],"edges":[{"id":"pay-1","from":"a","to":"b","labels":["PAID"],"properties":{}}]}"#;
        let g = decode(doc).unwrap();
        assert_eq!(g.edge_id(0), Some("pay-1"));
        assert_eq!(g.edge_by_id("pay-1"), Some(0));
        // survives encode → decode
        let g2 = decode(&encode(&g)).unwrap();
        assert_eq!(g2.edge_id(0), Some("pay-1"));
        assert_eq!(g2.edge_by_id("pay-1"), Some(0));
        // an id-less edge stays id-less (no spurious id, lazy overlay)
        let idless = decode(r#"{"nodes":[{"id":"a","labels":[],"properties":{}},{"id":"b","labels":[],"properties":{}}],"edges":[{"from":"a","to":"b","labels":["X"],"properties":{}}]}"#).unwrap();
        assert_eq!(idless.edge_id(0), None);
        // the emitted edge object carries no id (nodes still do)
        let enc = encode(&idless);
        let edges = &enc[enc.find("\"edges\":").unwrap()..];
        assert!(!edges.contains("\"id\":"));
        assert_eq!(decode(&enc).unwrap().edge_id(0), None); // stays id-less on round-trip
    }
}
