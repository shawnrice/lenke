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
                    Value::Num(value.and_then(J::as_f64).unwrap_or(f64::NAN))
                }
                Some("g:List") => Value::List(
                    value
                        .and_then(J::as_array)
                        .map(|a| a.iter().map(decode_typed).collect::<CodeResult<Vec<_>>>())
                        .transpose()?
                        .unwrap_or_default(),
                ),
                // Unknown wrapper: fall back to the raw @value (a nested object
                // here is out-of-model → InvalidValue, via json_to_value).
                _ => match value {
                    Some(v) => crate::codec::json_to_value(v)?,
                    None => Value::Null,
                },
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
        if let Some(id) = g.edge_id(i as u32) {
            out.push_str("\"id\":");
            push_json_str(&mut out, id);
            out.push(',');
        }
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
    let j: J = serde_json::from_str(input)
        .map_err(|e| CodeError::new(ErrorCode::InvalidJson, format!("graphson: invalid JSON: {e}")))?;
    let obj = j
        .as_object()
        .ok_or_else(|| CodeError::new(ErrorCode::InvalidShape, "graphson: expected a top-level object"))?;

    let mut b = Builder::default();

    if let Some(vertices) = obj.get("vertices").and_then(J::as_array) {
        for wrapper in vertices {
            let Some(v) = wrapper.get("@value").and_then(J::as_object) else { continue };
            let id = v.get("id").map(crate::codec::json_id).unwrap_or_default();
            let labels = match v.get("label").and_then(J::as_str) {
                Some("") | None => Vec::new(),
                Some(s) => s.split(LABEL_SEP).map(String::from).collect(),
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
            let Some(e) = wrapper.get("@value").and_then(J::as_object) else { continue };
            let src = e.get("outV").map(crate::codec::json_id).unwrap_or_default();
            let dst = e.get("inV").map(crate::codec::json_id).unwrap_or_default();
            // single type — split the `::` convention and take the first.
            let etype = e
                .get("label")
                .and_then(J::as_str)
                .map(|s| s.split(LABEL_SEP).next().unwrap_or("").to_string())
                .unwrap_or_default();
            let mut props = Vec::new();
            if let Some(pmap) = e.get("properties").and_then(J::as_object) {
                for (k, entry) in pmap {
                    if let Some(val) = inner_value(entry) {
                        props.push((k.clone(), decode_typed(val)?));
                    }
                }
            }
            let id = e.get("id").map(crate::codec::json_id);
            b.edges.push(EdgeRec { src, dst, etype, props, id });
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
}
