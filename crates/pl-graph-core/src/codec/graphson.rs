//! GraphSON v3.0 (Apache TinkerPop) codec for the columnar core.
//!
//! The whole graph is one JSON document `{ "vertices": [<g:Vertex>...],
//! "edges": [<g:Edge>...] }`; each element uses GraphSON v3 typed values of the
//! form `{ "@type": <type>, "@value": <value> }`.
//!
//! LPG ↔ GraphSON mapping (see [`crate::codec`] for the shared divergences):
//!   - **Single-value properties.** Each vertex key is emitted as a one-element
//!     `g:VertexProperty` array; decode reads the first element only.
//!   - **Multi-label `::` convention.** A vertex's label *set* is joined with
//!     `::` into GraphSON's single `label` string and split back on decode (empty
//!     set ⇄ `""`). Edges carry a single type, emitted as-is.
//!   - **int/float inference.** `Number.isInteger`-style: a whole float → `g:Int64`,
//!     else `g:Double`. Both decode back to the core's single float type.

use serde_json::Value as J;

use crate::codec::{element_props, is_intish, node_labels, push_json_str, push_num};
use crate::error::{CodeError, CodeResult};
use crate::error_codes::ErrorCode;
use crate::graph::{Builder, EdgeRec, Graph, NodeRec, Value};

const LABEL_SEP: &str = "::";

/// Emit one core [`Value`] as a GraphSON v3 typed value.
fn push_typed(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Str(s) => push_json_str(out, s),
        Value::Num(x) => {
            if is_intish(*x) {
                out.push_str("{\"@type\":\"g:Int64\",\"@value\":");
                push_num(out, *x);
                out.push('}');
            } else {
                out.push_str("{\"@type\":\"g:Double\",\"@value\":");
                push_num(out, *x);
                out.push('}');
            }
        }
        Value::List(a) => {
            out.push_str("{\"@type\":\"g:List\",\"@value\":[");
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_typed(out, e);
            }
            out.push_str("]}");
        }
    }
}

/// Decode a GraphSON v3 typed value (or bare JSON scalar) back to a core value.
fn decode_typed(node: &J) -> CodeResult<Value> {
    Ok(match node {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::String(s) => Value::Str(s.as_str().into()),
        J::Number(n) => Value::Num(n.as_f64().unwrap_or(f64::NAN)),
        J::Array(a) => Value::List(a.iter().map(decode_typed).collect::<CodeResult<Vec<_>>>()?),
        J::Object(o) => {
            let value = o.get("@value");
            match o.get("@type").and_then(J::as_str) {
                Some("g:Int64" | "g:Int32" | "g:Double" | "g:Float") => {
                    let n = value.and_then(J::as_f64).ok_or_else(|| {
                        CodeError::new(
                            ErrorCode::InvalidShape,
                            "graphson: numeric typed value must be a number",
                        )
                    })?;
                    Value::Num(n)
                }
                Some("g:List") => {
                    let arr = value.and_then(J::as_array).ok_or_else(|| {
                        CodeError::new(
                            ErrorCode::InvalidShape,
                            "graphson: g:List value must be an array",
                        )
                    })?;
                    Value::List(
                        arr.iter()
                            .map(decode_typed)
                            .collect::<CodeResult<Vec<_>>>()?,
                    )
                }
                // An unknown/missing wrapper is outside the LPG model — reject it
                // (matches the TS codec) rather than storing a raw out-of-model value.
                _ => {
                    return Err(CodeError::new(
                        ErrorCode::InvalidShape,
                        "graphson: unknown or missing typed-value wrapper",
                    ))
                }
            }
        }
    })
}

pub fn encode(g: &Graph) -> String {
    let mut out = String::with_capacity(g.vertex_count() * 96 + g.edge_count() * 96);
    out.push_str("{\"vertices\":[");
    let mut first = true;
    for vi in 0..g.n {
        if !g.is_vertex_live(vi as u32) {
            continue;
        }
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str("{\"@type\":\"g:Vertex\",\"@value\":{\"id\":");
        push_json_str(&mut out, g.vid.text(vi as u32));
        out.push_str(",\"label\":");
        push_json_str(&mut out, &node_labels(g, vi as u32).join(LABEL_SEP));
        out.push_str(",\"properties\":{");
        for (pi, (k, v)) in element_props(&g.props, &g.strs, vi).iter().enumerate() {
            if pi > 0 {
                out.push(',');
            }
            push_json_str(&mut out, k);
            out.push_str(":[{\"@type\":\"g:VertexProperty\",\"@value\":{\"id\":");
            push_json_str(&mut out, &format!("{}/{k}", g.vid.text(vi as u32)));
            out.push_str(",\"value\":");
            push_typed(&mut out, v);
            out.push_str(",\"label\":");
            push_json_str(&mut out, k);
            out.push_str("}}]");
        }
        out.push_str("}}}");
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
        out.push_str("{\"@type\":\"g:Edge\",\"@value\":{");
        // Every edge has an id (assigned, or canonical `e{index}`) — always emit.
        out.push_str("\"id\":");
        push_json_str(&mut out, &g.edge_id(i as u32));
        out.push(',');
        out.push_str("\"label\":");
        push_json_str(&mut out, g.etype.text(g.e_type[i]));
        out.push_str(",\"inV\":");
        push_json_str(&mut out, g.vid.text(g.e_dst[i]));
        out.push_str(",\"outV\":");
        push_json_str(&mut out, g.vid.text(g.e_src[i]));
        out.push_str(",\"properties\":{");
        for (pi, (k, v)) in element_props(&g.edge_props, &g.strs, i).iter().enumerate() {
            if pi > 0 {
                out.push(',');
            }
            push_json_str(&mut out, k);
            out.push_str(":{\"@type\":\"g:Property\",\"@value\":{\"key\":");
            push_json_str(&mut out, k);
            out.push_str(",\"value\":");
            push_typed(&mut out, v);
            out.push_str("}}");
        }
        out.push_str("}}}");
    }
    out.push_str("]}");
    out
}

/// The `value` slot inside a `g:VertexProperty` / `g:Property` `@value` object.
fn inner_value(prop_value: &J) -> Option<&J> {
    prop_value.get("@value").and_then(|v| v.get("value"))
}

pub fn decode(input: &str) -> CodeResult<Graph> {
    let j: J = serde_json::from_str(input).map_err(|e| {
        CodeError::new(
            ErrorCode::InvalidJson,
            format!("graphson: invalid JSON: {e}"),
        )
    })?;
    let obj = j.as_object().ok_or_else(|| {
        CodeError::new(
            ErrorCode::InvalidShape,
            "graphson: expected a top-level object",
        )
    })?;

    let mut b = Builder::default();

    let shape = |msg: &str| CodeError::new(ErrorCode::InvalidShape, format!("graphson: {msg}"));

    if let Some(vertices) = obj.get("vertices").and_then(J::as_array) {
        for wrapper in vertices {
            let v = wrapper
                .get("@value")
                .and_then(J::as_object)
                .ok_or_else(|| shape("each vertex must have an @value object"))?;
            if !matches!(v.get("id"), Some(J::String(_)) | Some(J::Number(_))) {
                return Err(shape("vertex @value.id must be a string or number"));
            }
            let id = v.get("id").map(crate::codec::json_id).unwrap_or_default();
            let labels = match v.get("label") {
                Some(J::String(s)) if s.is_empty() => Vec::new(),
                Some(J::String(s)) => s.split(LABEL_SEP).map(String::from).collect(),
                _ => return Err(shape("vertex @value.label must be a string")),
            };
            let mut props = Vec::new();
            if let Some(pmap) = v.get("properties").and_then(J::as_object) {
                for (k, entries) in pmap {
                    // single-value LPG: read the first element of the array
                    if let Some(first) = entries.as_array().and_then(|a| a.first()) {
                        if let Some(val) = inner_value(first) {
                            props.push((k.clone(), decode_typed(val)?));
                        }
                    }
                }
            }
            b.nodes.push(NodeRec { id, labels, props });
        }
    }

    if let Some(edges) = obj.get("edges").and_then(J::as_array) {
        for wrapper in edges {
            let e = wrapper
                .get("@value")
                .and_then(J::as_object)
                .ok_or_else(|| shape("each edge must have an @value object"))?;
            let src = e.get("outV").map(crate::codec::json_id).unwrap_or_default();
            let dst = e.get("inV").map(crate::codec::json_id).unwrap_or_default();
            // single type — split the `::` convention and take the first.
            let Some(J::String(label)) = e.get("label") else {
                return Err(shape("edge @value.label must be a string"));
            };
            let etype = label.split(LABEL_SEP).next().unwrap_or("").to_string();
            let mut props = Vec::new();
            if let Some(pmap) = e.get("properties").and_then(J::as_object) {
                for (k, entry) in pmap {
                    if let Some(val) = inner_value(entry) {
                        props.push((k.clone(), decode_typed(val)?));
                    }
                }
            }
            let id = e.get("id").map(crate::codec::json_id);
            b.edges.push(EdgeRec {
                src,
                dst,
                etype,
                props,
                id,
            });
        }
    }

    b.finalize_strict()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Value;

    fn build() -> Graph {
        // Use pg-json to get a graph with a multi-label node, a list, ints+floats.
        crate::codec::pg_json::decode(
            r#"{"nodes":[{"id":"a","labels":["P","Q"],"properties":{"n":42,"w":3.5,"tags":["x","y"]}},{"id":"b","labels":[],"properties":{}}],"edges":[{"from":"a","to":"b","labels":["KNOWS"],"properties":{"since":2020}}]}"#,
        )
        .unwrap()
    }

    #[test]
    fn round_trip() {
        let g = build();
        let g2 = decode(&encode(&g)).unwrap();
        assert_eq!(g2.vertex_count(), 2);
        assert_eq!(g2.edge_count(), 1);
        let a = g2.vid.get("a").unwrap() as usize;
        assert_eq!(node_labels(&g2, a as u32).len(), 2); // multi-label via `::`
        assert_eq!(g2.props.value(a, "n", &g2.strs), Value::Num(42.0));
        assert_eq!(g2.props.value(a, "w", &g2.strs), Value::Num(3.5));
        assert_eq!(
            g2.props.value(a, "tags", &g2.strs),
            Value::List(vec![Value::Str("x".into()), Value::Str("y".into())]),
        );
        // empty label set round-trips to no labels
        let bn = g2.vid.get("b").unwrap();
        assert_eq!(node_labels(&g2, bn).len(), 0);
    }

    #[test]
    fn int_vs_float_typed() {
        let g = build();
        let s = encode(&g);
        assert!(s.contains("g:Int64"));
        assert!(s.contains("g:Double"));
    }

    #[test]
    fn strict_decode_rejects_malformed() {
        use crate::error_codes::ErrorCode;
        let code = |s: &str| decode(s).err().unwrap().code;
        // Invalid JSON and non-object top level.
        assert_eq!(code("{bad"), ErrorCode::InvalidJson);
        assert_eq!(code("[]"), ErrorCode::InvalidShape);
        // Vertex without @value / id / label.
        assert_eq!(
            code(r#"{"vertices":[{"@type":"g:Vertex"}]}"#),
            ErrorCode::InvalidShape
        );
        assert_eq!(
            code(r#"{"vertices":[{"@value":{"label":""}}]}"#),
            ErrorCode::InvalidShape // missing id
        );
        assert_eq!(
            code(r#"{"vertices":[{"@value":{"id":"a"}}]}"#),
            ErrorCode::InvalidShape // missing label
        );
        // Malformed g:List value and unknown wrapper in a property.
        assert_eq!(
            code(
                r#"{"vertices":[{"@value":{"id":"a","label":"","properties":{"k":[{"@value":{"value":{"@type":"g:List","@value":5}}}]}}}]}"#
            ),
            ErrorCode::InvalidShape
        );
        // A well-formed minimal document still decodes.
        assert!(decode(r#"{"vertices":[{"@value":{"id":"a","label":""}}]}"#).is_ok());
    }
}
