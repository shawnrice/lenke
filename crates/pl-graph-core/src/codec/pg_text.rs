//! The PG textual format (`.pg`) — the line-based companion to PG-JSON. One
//! element per line:
//! ```text
//! <id> :Label* key:value*          ← a node (one leading id)
//! <from> <to> :Label* key:value*   ← an edge (two leading ids)
//! ```
//! Told apart by the second token: a bare id (no `:`) means an edge. `#` starts a
//! comment.
//!
//! Value mapping: strings are double-quoted (escaping `"` and `\`); numbers,
//! booleans, and `null` are bare; a list rides on **repeated keys**
//! (`tags:1 tags:2`). On decode a key seen once is a scalar, more than once a
//! list — so (as in the TS codec) an empty list emits nothing (decodes as absent)
//! and a single-element list is indistinguishable from a scalar. Node ids are
//! preserved; the textual format has no edge-id slot, so edges decode id-less
//! (use PG-JSON / GraphSON / CSV to round-trip edge ids). An edge's single type
//! is its first `:Label`.

use crate::codec::{element_props, node_labels};
use crate::graph::{Builder, EdgeRec, Graph, NodeRec, Value};

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/// Render one scalar value as a PG-text token value (never a list).
fn scalar_token(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(x) => {
            if x.is_finite() {
                use std::fmt::Write as _;
                let _ = write!(out, "{x}");
            } else {
                out.push_str("null");
            }
        }
        Value::Str(s) => {
            out.push('"');
            for c in s.chars() {
                // Escape the quote/backslash AND the line/whitespace control chars
                // — pg-text is line-oriented, so an unescaped newline in a value
                // would split the token across physical lines and corrupt the
                // round-trip. Must match the TS codec's escape scheme exactly.
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        Value::List(_) => {} // handled by the caller (one token per element)
    }
}

/// Append `key:value` tokens for one property (a list expands to one per element).
fn push_property(tokens: &mut Vec<String>, key: &str, v: &Value) {
    match v {
        Value::List(elems) => {
            for el in elems {
                let mut t = format!("{key}:");
                scalar_token(&mut t, el);
                tokens.push(t);
            }
        }
        _ => {
            let mut t = format!("{key}:");
            scalar_token(&mut t, v);
            tokens.push(t);
        }
    }
}

fn element_line(leading: &[&str], labels: &[&str], props: &[(&str, Value)]) -> String {
    let mut tokens: Vec<String> = leading.iter().map(|s| s.to_string()).collect();
    for l in labels {
        tokens.push(format!(":{l}"));
    }
    for (k, v) in props {
        push_property(&mut tokens, k, v);
    }
    tokens.join(" ")
}

/// Serialize a graph to PG-text: node lines, then edge lines.
pub fn encode(g: &Graph) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(g.vertex_count() + g.edge_count());
    for vi in 0..g.n {
        if !g.is_vertex_live(vi as u32) {
            continue;
        }
        let id = g.vid.text(vi as u32);
        lines.push(element_line(
            &[id],
            &node_labels(g, vi as u32),
            &element_props(&g.props, &g.strs, vi),
        ));
    }
    for i in 0..g.edge_slots() {
        if !g.is_edge_live(i as u32) {
            continue;
        }
        let from = g.vid.text(g.e_src[i]);
        let to = g.vid.text(g.e_dst[i]);
        let etype = g.etype.text(g.e_type[i]);
        lines.push(element_line(
            &[from, to],
            &[etype],
            &element_props(&g.edge_props, &g.strs, i),
        ));
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/// Split a line into tokens, keeping double-quoted spans (with `\` escapes) whole.
fn tokenize(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut in_quote = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_quote {
            current.push(c);
            if c == '\\' && i + 1 < chars.len() {
                current.push(chars[i + 1]);
                i += 2;
                continue;
            } else if c == '"' {
                in_quote = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_quote = true;
            started = true;
            current.push(c);
        } else if c == ' ' || c == '\t' {
            if started {
                tokens.push(std::mem::take(&mut current));
                started = false;
            }
        } else {
            current.push(c);
            started = true;
        }
        i += 1;
    }
    if started {
        tokens.push(current);
    }
    tokens
}

/// Looks like a JS-`Number`-shaped token (so a bare `1e3` parses, but `inf` does not).
fn is_number(raw: &str) -> bool {
    let first = raw.as_bytes().first().copied();
    matches!(first, Some(b'0'..=b'9') | Some(b'-') | Some(b'.')) && raw.parse::<f64>().is_ok()
}

/// Parse the value half of a `key:value` token into a scalar value.
fn parse_scalar(raw: &str) -> Value {
    if let Some(rest) = raw.strip_prefix('"') {
        let body = rest.strip_suffix('"').unwrap_or(rest);
        // Undo the encode escapes: `\n`/`\r`/`\t` decode to the control chars,
        // `\\`/`\"` to themselves, and any other `\x` to a literal `x` (lenient
        // for foreign `.pg`). Must match the TS codec exactly.
        let mut out = String::with_capacity(body.len());
        let mut chars = body.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('r') => out.push('\r'),
                    Some('t') => out.push('\t'),
                    Some(other) => out.push(other),
                    None => {}
                }
            } else {
                out.push(c);
            }
        }
        return Value::Str(out.into());
    }
    match raw {
        "true" => Value::Bool(true),
        "false" => Value::Bool(false),
        "null" => Value::Null,
        _ if is_number(raw) => Value::Num(raw.parse().unwrap()),
        _ => Value::Str(raw.into()), // bare unquoted string (lenient for foreign .pg)
    }
}

/// Pull labels and properties (repeated keys → lists) from the trailing tokens.
fn parse_labels_props(tokens: &[String]) -> (Vec<String>, Vec<(String, Value)>) {
    let mut labels = Vec::new();
    // preserve first-seen key order, collecting repeats
    let mut order: Vec<String> = Vec::new();
    let mut collected: std::collections::HashMap<String, Vec<Value>> =
        std::collections::HashMap::new();
    for token in tokens {
        if let Some(label) = token.strip_prefix(':') {
            labels.push(label.to_string());
            continue;
        }
        let Some(colon) = token.find(':') else {
            continue;
        };
        let key = token[..colon].to_string();
        let value = parse_scalar(&token[colon + 1..]);
        if let Some(list) = collected.get_mut(&key) {
            list.push(value);
        } else {
            order.push(key.clone());
            collected.insert(key, vec![value]);
        }
    }
    let props = order
        .into_iter()
        .map(|k| {
            let mut vals = collected.remove(&k).unwrap();
            let v = if vals.len() == 1 {
                vals.pop().unwrap()
            } else {
                Value::List(vals)
            };
            (k, v)
        })
        .collect();
    (labels, props)
}

/// A second token without a colon is the edge's destination id.
fn is_edge_line(tokens: &[String]) -> bool {
    tokens.len() >= 2 && !tokens[1].contains(':')
}

/// Deserialize a PG-text string into a fresh graph. Endpoints referenced by an
/// edge but never declared as a node line are created (bare) by `finalize` —
/// this leniency is intentional format semantics (matching the TS codec), so
/// decode is infallible and returns `Graph` directly (no coded error to carry).
pub fn decode(input: &str) -> Graph {
    let mut b = Builder::default();
    for raw in input.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let tokens = tokenize(line);
        if tokens.is_empty() {
            continue;
        }
        if is_edge_line(&tokens) {
            let from = tokens[0].clone();
            let to = tokens[1].clone();
            let (labels, props) = parse_labels_props(&tokens[2..]);
            b.edges.push(EdgeRec {
                src: from,
                dst: to,
                etype: labels.into_iter().next().unwrap_or_default(),
                props,
                id: None, // the .pg textual format has no edge-id slot
            });
        } else {
            let id = tokens[0].clone();
            let (labels, props) = parse_labels_props(&tokens[1..]);
            b.nodes.push(NodeRec { id, labels, props });
        }
    }
    b.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_scalars_and_lists() {
        let src = "\
a :Person name:\"Ann\" age:30 active:true tags:x tags:y
b :Person :Admin name:\"Bo\"
a b :KNOWS since:2020";
        let g = decode(src);
        assert_eq!(g.vertex_count(), 2);
        assert_eq!(g.edge_count(), 1);
        let a = g.vid.get("a").unwrap() as usize;
        assert_eq!(g.props.value(a, "age", &g.strs), Value::Num(30.0));
        assert_eq!(g.props.value(a, "active", &g.strs), Value::Bool(true));
        assert_eq!(
            g.props.value(a, "tags", &g.strs),
            Value::List(vec![Value::Str("x".into()), Value::Str("y".into())]),
        );
        // multi-label node
        assert_eq!(node_labels(&g, g.vid.get("b").unwrap()).len(), 2);

        // encode → decode is stable for scalars + multi-element lists
        let g2 = decode(&encode(&g));
        let a2 = g2.vid.get("a").unwrap() as usize;
        assert_eq!(
            g2.props.value(a2, "tags", &g2.strs),
            Value::List(vec![Value::Str("x".into()), Value::Str("y".into())]),
        );
        assert_eq!(g2.edge_count(), 1);
    }

    #[test]
    fn quoted_strings_and_comments() {
        let src = "# a comment\nx name:\"a b\\\"c\"";
        let g = decode(src);
        let x = g.vid.get("x").unwrap() as usize;
        assert_eq!(
            g.props.value(x, "name", &g.strs),
            Value::Str("a b\"c".into())
        );
    }

    #[test]
    fn edge_endpoint_autocreated() {
        let g = decode("a b :KNOWS");
        assert_eq!(g.vertex_count(), 2); // a and b created as bare nodes
        assert_eq!(g.edge_count(), 1);
    }

    #[test]
    fn escapes_control_chars_in_strings() {
        // A value with newline/CR/tab/quote/backslash must survive a round trip;
        // an unescaped newline would split the line and corrupt the graph.
        let g = crate::ndjson::decode(
            r#"{"type":"node","id":"a","labels":["N"],"properties":{"note":"l1\nl2\tx\"q\\b\r"}}"#,
        )
        .unwrap();
        let text = encode(&g);
        // The value must not leak a raw newline into the output (single line).
        assert_eq!(
            text.trim_end_matches('\n').lines().count(),
            1,
            "value control char leaked into output: {text:?}"
        );
        let g2 = decode(&text);
        let a = g2.vid.get("a").unwrap() as usize;
        assert_eq!(
            g2.props.value(a, "note", &g2.strs),
            Value::Str("l1\nl2\tx\"q\\b\r".into())
        );
    }
}
