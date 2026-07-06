//! Cross-implementation codec conformance: the Rust half of a shared corpus
//! (`/conformance/codec-corpus.json`) that the TS `@lenke/serialization`
//! suite reads too. Both sides decode the same canonical graph, round-trip it
//! through every format, and assert the result is **structurally** identical —
//! normalized (sorted nodes/edges, labels as sets, props sorted by key, edge
//! ids ignored), because edge ids (Rust `e{index}` vs TS `rando()`) and key
//! ordering legitimately differ. Both also reject the same malformed inputs
//! with the same `ErrorCode`. Keeping the fixture shared is what stops the two
//! engines' accepted-input / output behaviour from drifting apart.

use crate::codec::{deserialize, element_props, node_labels, push_value, serialize};
use crate::graph::{Graph, Value};
use crate::json::{self, Json};

/// The shared corpus, embedded at compile time (repo-root `conformance/`).
const CORPUS: &str = include_str!("../../../../conformance/codec-corpus.json");

/// A canonical scalar/list representation, matching the TS side's
/// `JSON.stringify` (numbers via the shared JS-compatible formatter).
fn value_repr(v: &Value) -> String {
    let mut s = String::new();
    push_value(&mut s, v);
    s
}

/// Sorted `key=value` pairs for a property bag.
fn prop_repr(props: &[(&str, Value)]) -> String {
    let mut pairs: Vec<String> = props
        .iter()
        .map(|(k, v)| format!("{k}={}", value_repr(v)))
        .collect();
    pairs.sort_unstable();
    pairs.join(",")
}

/// A normalized, order-independent string form of a graph. Edge ids are
/// deliberately excluded (pg-text drops them; the two engines synthesize
/// different ids for id-less edges).
fn normalize(g: &Graph) -> String {
    let mut lines: Vec<String> = Vec::new();

    for vi in 0..g.n as u32 {
        if !g.is_vertex_live(vi) {
            continue;
        }
        let mut labels = node_labels(g, vi);
        labels.sort_unstable();
        let props = prop_repr(&element_props(&g.props, &g.strs, vi as usize));
        lines.push(format!(
            "V {} [{}] {{{}}}",
            g.vid.text(vi),
            labels.join(","),
            props
        ));
    }

    for i in 0..g.edge_slots() {
        if !g.is_edge_live(i as u32) {
            continue;
        }
        let props = prop_repr(&element_props(&g.edge_props, &g.strs, i));
        lines.push(format!(
            "E {}->{} :{} {{{}}}",
            g.vid.text(g.e_src[i]),
            g.vid.text(g.e_dst[i]),
            g.etype.text(g.e_type[i]),
            props
        ));
    }

    lines.sort_unstable();
    lines.join("\n")
}

fn corpus() -> Json {
    json::parse(CORPUS).expect("conformance corpus is valid JSON")
}

#[test]
fn canonical_round_trips_every_format_structurally() {
    let c = corpus();
    let canonical = c.get("canonical").and_then(Json::as_str).unwrap();
    let g = crate::ndjson::decode(canonical).unwrap();
    let want = normalize(&g);
    // Cross-impl golden: both engines must produce this exact normal form, so
    // they provably interpret the canonical graph identically (not just stably).
    assert_eq!(
        want,
        c.get("canonical_normal").and_then(Json::as_str).unwrap(),
        "Rust's normal form drifted from the shared golden"
    );

    for format in ["pg-json", "pg-text", "graphson", "csv", "ndjson"] {
        let blob = serialize(&g, format).unwrap();
        let g2 = deserialize(&blob, format).unwrap_or_else(|e| {
            panic!("re-decode failed for {format}: {e:?}");
        });
        assert_eq!(
            normalize(&g2),
            want,
            "round-trip diverged from the canonical graph for {format}"
        );
    }
}

#[test]
fn malformed_inputs_rejected_with_expected_code() {
    let c = corpus();
    for case in c.get("reject").and_then(Json::as_array).unwrap() {
        let format = case.get("format").and_then(Json::as_str).unwrap();
        let input = case.get("input").and_then(Json::as_str).unwrap();
        let want = case.get("code").and_then(Json::as_str).unwrap();
        let err = deserialize(input, format)
            .err()
            .unwrap_or_else(|| panic!("{format} accepted malformed input: {input:?}"));
        assert_eq!(
            err.code.as_str(),
            want,
            "wrong error code for {format} on {input:?}"
        );
    }
}
