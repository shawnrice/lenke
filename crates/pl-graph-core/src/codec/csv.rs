//! CSV codec — a Neo4j-`admin-import`-style pair of typed CSVs (nodes + edges)
//! joined into one document by a `=== EDGES ===` sentinel line.
//!
//! **nodes** columns: `id`, `:LABEL` (label set, `;`-joined), then one typed
//! column per property key (`key:string|integer|float|boolean`, lists as
//! `key:integer[]` with `;`-joined elements). **edges** columns: `id`,
//! `:START_ID`, `:END_ID`, `:TYPE`, then the same typed property columns.
//!
//! The hard parts, ported faithfully from the TS codec:
//!   - **null / empty-string / absent** are three distinct on-wire states:
//!     absent = empty *unquoted* cell; null = the `\N` token; present `""` =
//!     quoted empty. (The core never stores null, so encode emits `\N` for none
//!     of its own data; a foreign `\N` decodes to absent.)
//!   - **heterogeneous keys**: a cell whose concrete type differs from its
//!     column's type carries an inline `\T<code>:` override sigil (`s|i|f|b`,
//!     `[]` for lists), so a key used with mixed types still round-trips.
//!   - RFC-4180 quoting; list elements escape `;` and `\`.
//!
//! Core divergences (see [`crate::codec`]): edge `:TYPE` is the single edge type
//! (not a set); edge `id` is synthesized (`e{index}`) and ignored on decode.

use crate::codec::{element_props, is_intish};
use crate::graph::{Builder, EdgeRec, Graph, NodeRec, Value};

const NULL_TOKEN: &str = "\\N";
const LIST_SEP: char = ';';
const OVERRIDE_PREFIX: &str = "\\T";
const SEPARATOR: &str = "\n=== EDGES ===\n";

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scalar {
    Str,
    Int,
    Float,
    Bool,
}

impl Scalar {
    fn as_str(self) -> &'static str {
        match self {
            Scalar::Str => "string",
            Scalar::Int => "integer",
            Scalar::Float => "float",
            Scalar::Bool => "boolean",
        }
    }
    fn from_str(s: &str) -> Scalar {
        match s {
            "integer" => Scalar::Int,
            "float" => Scalar::Float,
            "boolean" => Scalar::Bool,
            _ => Scalar::Str,
        }
    }
    fn code(self) -> char {
        match self {
            Scalar::Str => 's',
            Scalar::Int => 'i',
            Scalar::Float => 'f',
            Scalar::Bool => 'b',
        }
    }
    fn from_code(c: &str) -> Scalar {
        match c {
            "i" => Scalar::Int,
            "f" => Scalar::Float,
            "b" => Scalar::Bool,
            _ => Scalar::Str,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ColType {
    scalar: Scalar,
    list: bool,
}

fn scalar_of(v: &Value) -> Scalar {
    match v {
        Value::Bool(_) => Scalar::Bool,
        Value::Num(x) => {
            if is_intish(*x) {
                Scalar::Int
            } else {
                Scalar::Float
            }
        }
        _ => Scalar::Str,
    }
}

/// The scalar type to attribute to a list element (null / nested list → string).
fn scalar_of_element(el: &Value) -> Scalar {
    match el {
        Value::Null | Value::List(_) => Scalar::Str,
        other => scalar_of(other),
    }
}

fn infer_column(v: &Value) -> ColType {
    match v {
        Value::List(elems) => {
            let scalar = match elems.first() {
                Some(first) if !matches!(first, Value::Null | Value::List(_)) => scalar_of(first),
                _ => Scalar::Str,
            };
            ColType { scalar, list: true }
        }
        other => ColType { scalar: scalar_of(other), list: false },
    }
}

fn column_header(key: &str, t: ColType) -> String {
    format!("{key}:{}{}", t.scalar.as_str(), if t.list { "[]" } else { "" })
}

fn parse_header(header: &str) -> (String, ColType) {
    let colon = header.rfind(':').unwrap_or(header.len());
    let key = header[..colon].to_string();
    let mut type_part = if colon < header.len() { &header[colon + 1..] } else { "" };
    let list = type_part.ends_with("[]");
    if list {
        type_part = &type_part[..type_part.len() - 2];
    }
    (key, ColType { scalar: Scalar::from_str(type_part), list })
}

fn type_code(t: ColType) -> String {
    format!("{}{}", t.scalar.code(), if t.list { "[]" } else { "" })
}

// ---------------------------------------------------------------------------
// Scalar (de)serialization
// ---------------------------------------------------------------------------

fn num_str(x: f64) -> String {
    if x.is_finite() {
        format!("{x}")
    } else {
        "null".to_string()
    }
}

/// One scalar's raw (pre-quoting) text, of the given column scalar type.
fn scalar_to_raw(scalar: Scalar, v: &Value) -> String {
    if scalar == Scalar::Bool {
        return match v {
            Value::Bool(true) => "true".to_string(),
            _ => "false".to_string(),
        };
    }
    match v {
        Value::Num(x) => num_str(*x),
        Value::Str(s) => s.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn raw_to_scalar(scalar: Scalar, raw: &str) -> Value {
    match scalar {
        Scalar::Bool => Value::Bool(raw == "true"),
        Scalar::Int | Scalar::Float => Value::Num(raw.parse().unwrap_or(f64::NAN)),
        Scalar::Str => Value::Str(raw.into()),
    }
}

fn escape_element(s: &str) -> String {
    s.replace('\\', "\\\\").replace(';', "\\;")
}

/// Split a list cell on unescaped `;`, unescaping `\;` and `\\` inline.
fn split_list(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(n) = chars.next() {
                cur.push(n);
            }
        } else if c == LIST_SEP {
            out.push(std::mem::take(&mut cur));
        } else {
            cur.push(c);
        }
    }
    out.push(cur);
    out
}

fn element_to_raw(elem_scalar: Scalar, el: &Value) -> String {
    let actual = scalar_of_element(el);
    let raw = scalar_to_raw(actual, el);
    if actual == elem_scalar {
        escape_element(&raw)
    } else {
        escape_element(&format!("{OVERRIDE_PREFIX}{}:{}", actual.code(), raw))
    }
}

fn raw_to_element(elem_scalar: Scalar, part: &str) -> Value {
    if let Some(rest) = part.strip_prefix(OVERRIDE_PREFIX) {
        if let Some(colon) = rest.find(':') {
            let code = &rest[..colon];
            return raw_to_scalar(Scalar::from_code(code), &rest[colon + 1..]);
        }
    }
    raw_to_scalar(elem_scalar, part)
}

fn value_to_raw(t: ColType, v: &Value) -> String {
    if t.list {
        if let Value::List(elems) = v {
            return elems.iter().map(|el| element_to_raw(t.scalar, el)).collect::<Vec<_>>().join(";");
        }
        return String::new();
    }
    scalar_to_raw(t.scalar, v)
}

fn raw_to_value(t: ColType, raw: &str) -> Value {
    if t.list {
        if raw.is_empty() {
            return Value::List(Vec::new());
        }
        return Value::List(split_list(raw).iter().map(|p| raw_to_element(t.scalar, p)).collect());
    }
    raw_to_scalar(t.scalar, raw)
}

// ---------------------------------------------------------------------------
// Cell (de)coding
// ---------------------------------------------------------------------------

struct Encoded {
    raw: String,
    force_quote: bool,
}

fn encode_cell(column: ColType, v: &Value) -> Encoded {
    if matches!(v, Value::Null) {
        return Encoded { raw: NULL_TOKEN.to_string(), force_quote: false };
    }
    let actual = infer_column(v);
    if actual == column {
        if column.scalar == Scalar::Str && !column.list {
            // scalar strings are always force-quoted (so present "" ≠ absent),
            // and a leading backslash is doubled so a literal `\N`/`\T…` can't be
            // read as a sentinel (decode strips exactly one leading backslash).
            let s = match v {
                Value::Str(s) => s.to_string(),
                _ => String::new(),
            };
            let raw = if s.starts_with('\\') { format!("\\{s}") } else { s };
            return Encoded { raw, force_quote: true };
        }
        let raw = value_to_raw(column, v);
        let force = raw.is_empty(); // present-but-empty (e.g. empty list) must quote
        return Encoded { raw, force_quote: force };
    }
    // heterogeneous cell: tag with its concrete type
    let raw = format!("{OVERRIDE_PREFIX}{}:{}", type_code(actual), value_to_raw(actual, v));
    Encoded { raw, force_quote: false }
}

/// `None` = absent (key not on this element).
fn decode_cell(column: ColType, cell: &Cell) -> Option<Value> {
    let text = &cell.text;
    if !cell.quoted && text.is_empty() {
        return None; // absent
    }
    let sentinel = text.starts_with('\\') && !text.starts_with("\\\\");
    if sentinel && text == NULL_TOKEN {
        return Some(Value::Null);
    }
    if sentinel {
        if let Some(rest) = text.strip_prefix(OVERRIDE_PREFIX) {
            if let Some(colon) = rest.find(':') {
                let mut code = &rest[..colon];
                let list = code.ends_with("[]");
                if list {
                    code = &code[..code.len() - 2];
                }
                let ot = ColType { scalar: Scalar::from_code(code), list };
                return Some(raw_to_value(ot, &rest[colon + 1..]));
            }
        }
    }
    if column.scalar == Scalar::Str && !column.list {
        // literal string: undo the leading-backslash escape
        return Some(Value::Str(text.strip_prefix('\\').unwrap_or(text).into()));
    }
    Some(raw_to_value(column, text))
}

// ---------------------------------------------------------------------------
// RFC-4180 plumbing
// ---------------------------------------------------------------------------

struct Cell {
    text: String,
    quoted: bool,
}

fn quote_field(raw: &str) -> String {
    if raw.contains(',') || raw.contains('"') || raw.contains('\n') || raw.contains('\r') || raw.contains(LIST_SEP) {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw.to_string()
    }
}

/// Single-pass RFC-4180 parser. Each cell carries whether it was quoted (needed
/// to tell `''` from absent/`\N`).
fn parse_csv(input: &str) -> Vec<Vec<Cell>> {
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut row: Vec<Cell> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut in_quotes = false;
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    // Push the current field, then start a fresh one (resetting the quoted flag).
    macro_rules! end_field {
        () => {{
            row.push(Cell { text: std::mem::take(&mut field), quoted });
            quoted = false;
        }};
    }

    while i < chars.len() {
        let c = chars[i];
        if in_quotes {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    field.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
                i += 1;
                continue;
            }
            field.push(c);
            i += 1;
            continue;
        }
        match c {
            '"' => {
                quoted = true;
                in_quotes = true;
            }
            ',' => end_field!(),
            '\r' => {} // swallow; CRLF handled by the \n branch
            '\n' => {
                end_field!();
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
        i += 1;
    }
    // Flush the trailing field/row (no reset needed at end of input).
    if !field.is_empty() || quoted || !row.is_empty() {
        row.push(Cell { text: field, quoted });
        rows.push(row);
    }
    rows
}

// ---------------------------------------------------------------------------
// Column-set computation (header = union of all keys, first-seen order)
// ---------------------------------------------------------------------------

type Bag = Vec<(String, Value)>;

fn bag_get<'a>(bag: &'a Bag, key: &str) -> Option<&'a Value> {
    bag.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn compute_columns(bags: &[Bag]) -> (Vec<String>, std::collections::HashMap<String, ColType>) {
    let mut keys: Vec<String> = Vec::new();
    let mut types: std::collections::HashMap<String, ColType> = std::collections::HashMap::new();
    let mut seen = std::collections::HashSet::new();
    for bag in bags {
        for (key, value) in bag {
            if seen.insert(key.clone()) {
                keys.push(key.clone());
            }
            if !matches!(value, Value::Null) && !types.contains_key(key) {
                types.insert(key.clone(), infer_column(value));
            }
        }
    }
    for key in &keys {
        types.entry(key.clone()).or_insert(ColType { scalar: Scalar::Str, list: false });
    }
    (keys, types)
}

fn build_row(fixed: &[&str], keys: &[String], types: &std::collections::HashMap<String, ColType>, bag: &Bag) -> String {
    let mut cells: Vec<String> = fixed.iter().map(|s| quote_field(s)).collect();
    for key in keys {
        match bag_get(bag, key) {
            None => cells.push(String::new()), // absent
            Some(v) => {
                let enc = encode_cell(types[key], v);
                cells.push(if enc.force_quote {
                    format!("\"{}\"", enc.raw.replace('"', "\"\""))
                } else {
                    quote_field(&enc.raw)
                });
            }
        }
    }
    cells.join(",")
}

fn split_labels(text: &str) -> Vec<String> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split(LIST_SEP).map(String::from).collect()
    }
}

fn prop_cols_from_header(header: &[Cell], fixed: usize) -> Vec<(String, ColType)> {
    header.iter().skip(fixed).map(|c| parse_header(&c.text)).collect()
}

fn props_from_row(row: &[Cell], prop_cols: &[(String, ColType)], fixed: usize) -> Bag {
    let mut props = Bag::new();
    for (c, (key, t)) in prop_cols.iter().enumerate() {
        let Some(cell) = row.get(c + fixed) else { continue };
        match decode_cell(*t, cell) {
            // present null collapses to absent (the core never stores null)
            Some(Value::Null) | None => {}
            Some(v) => props.push((key.clone(), v)),
        }
    }
    props
}

// ---------------------------------------------------------------------------
// Bags from the graph
// ---------------------------------------------------------------------------

fn vertex_bags(g: &Graph) -> Vec<(u32, Bag)> {
    (0..g.n as u32)
        .filter(|&vi| g.is_vertex_live(vi))
        .map(|vi| {
            let bag = element_props(&g.props, &g.strs, vi as usize)
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
            (vi, bag)
        })
        .collect()
}

fn edge_bags(g: &Graph) -> Vec<(usize, Bag)> {
    (0..g.edge_slots())
        .filter(|&i| g.is_edge_live(i as u32))
        .map(|i| {
            let bag = element_props(&g.edge_props, &g.strs, i)
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
            (i, bag)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Public nodes / edges CSV
// ---------------------------------------------------------------------------

pub fn encode_nodes(g: &Graph) -> String {
    let entries = vertex_bags(g);
    let bags: Vec<Bag> = entries.iter().map(|(_, b)| b.clone()).collect();
    let (keys, types) = compute_columns(&bags);

    let header = {
        let mut h = vec!["id".to_string(), ":LABEL".to_string()];
        h.extend(keys.iter().map(|k| column_header(k, types[k])));
        h.join(",")
    };
    let mut rows = vec![header];
    for (vi, bag) in &entries {
        let labels = crate::codec::node_labels(g, *vi).join(";");
        let id = g.vid.text(*vi).to_string();
        rows.push(build_row(&[&id, &labels], &keys, &types, bag));
    }
    rows.join("\n")
}

pub fn encode_edges(g: &Graph) -> String {
    let entries = edge_bags(g);
    let bags: Vec<Bag> = entries.iter().map(|(_, b)| b.clone()).collect();
    let (keys, types) = compute_columns(&bags);

    let header = {
        let mut h = vec!["id".to_string(), ":START_ID".to_string(), ":END_ID".to_string(), ":TYPE".to_string()];
        h.extend(keys.iter().map(|k| column_header(k, types[k])));
        h.join(",")
    };
    let mut rows = vec![header];
    for (i, bag) in &entries {
        let id = format!("e{i}");
        let from = g.vid.text(g.e_src[*i]).to_string();
        let to = g.vid.text(g.e_dst[*i]).to_string();
        let etype = g.etype.text(g.e_type[*i]).to_string();
        rows.push(build_row(&[&id, &from, &to, &etype], &keys, &types, bag));
    }
    rows.join("\n")
}

/// Encode a graph to the combined single string: nodes CSV, sentinel, edges CSV.
pub fn encode(g: &Graph) -> String {
    format!("{}{}{}", encode_nodes(g), SEPARATOR, encode_edges(g))
}

/// Decode the combined single-string form into a fresh graph (nodes, then edges).
pub fn decode(input: &str) -> Result<Graph, String> {
    let (nodes_csv, edges_csv) = match input.find(SEPARATOR) {
        Some(idx) => (&input[..idx], &input[idx + SEPARATOR.len()..]),
        None => (input, ""),
    };

    let mut b = Builder::default();

    let node_rows = parse_csv(nodes_csv);
    if let Some(header) = node_rows.first() {
        let prop_cols = prop_cols_from_header(header, 2);
        for row in node_rows.iter().skip(1) {
            let id = row.first().map(|c| c.text.clone()).unwrap_or_default();
            let labels = split_labels(row.get(1).map(|c| c.text.as_str()).unwrap_or(""));
            b.nodes.push(NodeRec { id, labels, props: props_from_row(row, &prop_cols, 2) });
        }
    }

    let edge_rows = parse_csv(edges_csv);
    if let Some(header) = edge_rows.first() {
        let prop_cols = prop_cols_from_header(header, 4);
        for row in edge_rows.iter().skip(1) {
            let src = row.get(1).map(|c| c.text.clone()).unwrap_or_default();
            let dst = row.get(2).map(|c| c.text.clone()).unwrap_or_default();
            let etype = split_labels(row.get(3).map(|c| c.text.as_str()).unwrap_or(""))
                .into_iter()
                .next()
                .unwrap_or_default();
            b.edges.push(EdgeRec { src, dst, etype, props: props_from_row(row, &prop_cols, 4) });
        }
    }

    Ok(b.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Graph {
        // heterogeneous: missing keys, lists, int/float/bool/string, empty string,
        // and a key (`mix`) used as int on one node and string on another.
        crate::codec::pg_json::decode(
            r#"{"nodes":[
              {"id":"a","labels":["P","Q"],"properties":{"n":42,"w":3.5,"ok":true,"name":"ann","tags":["x","y"],"mix":7,"blank":""}},
              {"id":"b","labels":["P"],"properties":{"name":"bo","mix":"hi"}}
            ],"edges":[{"from":"a","to":"b","labels":["KNOWS"],"properties":{"since":2020,"strength":0.9}}]}"#,
        )
        .unwrap()
    }

    #[test]
    fn round_trip() {
        let g = sample();
        let g2 = decode(&encode(&g)).unwrap();
        assert_eq!(g2.vertex_count(), 2);
        assert_eq!(g2.edge_count(), 1);

        let a = g2.vid.get("a").unwrap() as usize;
        let b = g2.vid.get("b").unwrap() as usize;
        assert_eq!(g2.props.value(a, "n", &g2.strs), Value::Num(42.0));
        assert_eq!(g2.props.value(a, "w", &g2.strs), Value::Num(3.5));
        assert_eq!(g2.props.value(a, "ok", &g2.strs), Value::Bool(true));
        assert_eq!(g2.props.value(a, "name", &g2.strs), Value::Str("ann".into()));
        assert_eq!(
            g2.props.value(a, "tags", &g2.strs),
            Value::List(vec![Value::Str("x".into()), Value::Str("y".into())]),
        );
        // present empty string survives (≠ absent)
        assert_eq!(g2.props.value(a, "blank", &g2.strs), Value::Str("".into()));
        // multi-label node
        assert_eq!(crate::codec::node_labels(&g2, a as u32).len(), 2);

        // heterogeneous `mix`: int on a, string on b — both recovered via the sigil
        assert_eq!(g2.props.value(a, "mix", &g2.strs), Value::Num(7.0));
        assert_eq!(g2.props.value(b, "mix", &g2.strs), Value::Str("hi".into()));

        // absent key stays absent (b has no `n`)
        assert_eq!(g2.props.value(b, "n", &g2.strs), Value::Null);
    }

    #[test]
    fn quoting_and_separators() {
        let g = crate::codec::pg_json::decode(
            r#"{"nodes":[{"id":"a","labels":[],"properties":{"s":"has,comma \"quote\" and ;semi"}}],"edges":[]}"#,
        )
        .unwrap();
        let g2 = decode(&encode(&g)).unwrap();
        let a = g2.vid.get("a").unwrap() as usize;
        assert_eq!(g2.props.value(a, "s", &g2.strs), Value::Str("has,comma \"quote\" and ;semi".into()));
    }
}
