//! CSV codec over the neutral model — a faithful port of the now-removed
//! lenke-core's `codec::csv`, retyped to [`GraphData`]/[`Value`]. A Neo4j-`admin-import`-style
//! pair of typed CSVs (nodes + edges) joined by a `=== EDGES ===` sentinel line.
//!
//! **nodes** columns: `id`, `:LABEL` (label set, `;`-joined), then one typed
//! column per property key (`key:string|integer|float|boolean|<temporal>`, lists
//! as `key:integer[]`). **edges** columns: `id`, `:START_ID`, `:END_ID`, `:TYPE`,
//! then the same typed property columns.
//!
//! Faithfully ported hard parts: null / empty-string / absent are three distinct
//! on-wire states (absent = empty unquoted cell; null = `\N`; present `""` =
//! quoted empty); a heterogeneous cell carries an inline `\T<code>:` type
//! override; RFC-4180 quoting; list elements escape `;`/`\`; spreadsheet-formula
//! neutralization. Temporal cells decode to `Value::Temporal{tag, iso}` WITHOUT
//! validating the ISO string — the host validates when it builds its graph.

use crate::model::{Edge, GraphData, Node, Value};
use crate::{is_intish, js_number};
use std::collections::{HashMap, HashSet};

const NULL_TOKEN: &str = "\\N";
const LIST_SEP: char = ';';
const OVERRIDE_PREFIX: &str = "\\T";
const NULL_ELEMENT_CODE: &str = "n";
const EDGES_MARKER: &str = "=== EDGES ===";
const SEPARATOR: &str = "\n=== EDGES ===\n";

// --------------------------------------------------------------- column types ---

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scalar {
    Str,
    Int,
    Float,
    Bool,
    Date,
    Time,
    DateTime,
    ZonedTime,
    ZonedDateTime,
    Duration,
}

impl Scalar {
    fn as_str(self) -> &'static str {
        match self {
            Self::Str => "string",
            Self::Int => "integer",
            Self::Float => "float",
            Self::Bool => "boolean",
            Self::Date => "date",
            Self::Time => "localtime",
            Self::DateTime => "datetime",
            Self::ZonedTime => "zoned_time",
            Self::ZonedDateTime => "zoned_datetime",
            Self::Duration => "duration",
        }
    }
    fn from_str(s: &str) -> Self {
        match s {
            "integer" => Self::Int,
            "float" => Self::Float,
            "boolean" => Self::Bool,
            "date" => Self::Date,
            "localtime" => Self::Time,
            "datetime" => Self::DateTime,
            "zoned_time" => Self::ZonedTime,
            "zoned_datetime" => Self::ZonedDateTime,
            "duration" => Self::Duration,
            _ => Self::Str,
        }
    }
    fn code(self) -> char {
        match self {
            Self::Str => 's',
            Self::Int => 'i',
            Self::Float => 'f',
            Self::Bool => 'b',
            Self::Date => 'd',
            Self::Time => 'l',
            Self::DateTime => 't',
            Self::ZonedTime => 'w',
            Self::ZonedDateTime => 'z',
            Self::Duration => 'u',
        }
    }
    fn from_code(c: &str) -> Self {
        match c {
            "i" => Self::Int,
            "f" => Self::Float,
            "b" => Self::Bool,
            "d" => Self::Date,
            "l" => Self::Time,
            "t" => Self::DateTime,
            "w" => Self::ZonedTime,
            "z" => Self::ZonedDateTime,
            "u" => Self::Duration,
            _ => Self::Str,
        }
    }
    /// The kind tag for a temporal scalar type, or `None` for a non-temporal type.
    fn temporal_tag(self) -> Option<&'static str> {
        match self {
            Self::Date => Some("date"),
            Self::Time => Some("localtime"),
            Self::DateTime => Some("datetime"),
            Self::ZonedTime => Some("zoned_time"),
            Self::ZonedDateTime => Some("zoned_datetime"),
            Self::Duration => Some("duration"),
            _ => None,
        }
    }
    /// A temporal kind tag → its scalar type (the inverse of [`temporal_tag`]).
    fn from_temporal_tag(tag: &str) -> Self {
        match tag {
            "localtime" => Self::Time,
            "datetime" => Self::DateTime,
            "zoned_time" => Self::ZonedTime,
            "zoned_datetime" => Self::ZonedDateTime,
            "duration" => Self::Duration,
            _ => Self::Date, // "date"
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
        Value::Temporal { tag, .. } => Scalar::from_temporal_tag(tag),
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
        other => ColType {
            scalar: scalar_of(other),
            list: false,
        },
    }
}

fn column_header(key: &str, t: ColType) -> String {
    format!(
        "{}:{}{}",
        guard_field(key),
        t.scalar.as_str(),
        if t.list { "[]" } else { "" }
    )
}

fn header_line(cells: &[String]) -> String {
    cells
        .iter()
        .map(|c| quote_field(c))
        .collect::<Vec<_>>()
        .join(",")
}

/// Leading chars a spreadsheet reads as a formula (`= + - @`, plus TAB/CR).
fn starts_with_formula(s: &str) -> bool {
    matches!(s.chars().next(), Some('=' | '+' | '-' | '@' | '\t' | '\r'))
}

fn parse_header(header: &str) -> (String, ColType) {
    let colon = header.rfind(':').unwrap_or(header.len());
    let key = unguard_field(&header[..colon]);
    let mut type_part = if colon < header.len() {
        &header[colon + 1..]
    } else {
        ""
    };
    let list = type_part.ends_with("[]");
    if list {
        type_part = &type_part[..type_part.len() - 2];
    }
    (
        key,
        ColType {
            scalar: Scalar::from_str(type_part),
            list,
        },
    )
}

fn type_code(t: ColType) -> String {
    format!("{}{}", t.scalar.code(), if t.list { "[]" } else { "" })
}

// ------------------------------------------------ scalar (de)serialization ---

fn num_str(x: f64) -> String {
    if x.is_finite() {
        js_number(x)
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
        Value::Temporal { iso, .. } => iso.to_string(),
        _ => String::new(),
    }
}

fn raw_to_scalar(scalar: Scalar, raw: &str) -> Value {
    if let Some(tag) = scalar.temporal_tag() {
        // The ISO string is not validated here — the host validates on build.
        return Value::Temporal {
            tag: tag.to_string(),
            iso: raw.to_string(),
        };
    }
    match scalar {
        Scalar::Bool => Value::Bool(raw == "true"),
        // A foreign "inf"/"-inf"/"nan" parses in Rust but is NaN under JS Number();
        // filter to finite so both decoders agree (our encoder never writes these).
        Scalar::Int | Scalar::Float => Value::Num(
            raw.parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .unwrap_or(f64::NAN),
        ),
        _ => Value::Str(raw.to_string()),
    }
}

fn escape_element(s: &str) -> String {
    s.replace('\\', "\\\\").replace(';', "\\;")
}

/// Prefix a raw field that would otherwise read as an escape or spreadsheet
/// formula (a leading `\` or a formula char); `unguard_field` strips one leading `\`.
fn guard_field(s: &str) -> String {
    if s.starts_with('\\') || starts_with_formula(s) {
        format!("\\{s}")
    } else {
        s.to_string()
    }
}

fn unguard_field(s: &str) -> String {
    s.strip_prefix('\\').unwrap_or(s).to_string()
}

/// Neutralize an already-escaped label / string list element (only a leading
/// formula char needs guarding; the body already doubled a leading `\`).
fn guard_element(escaped: String) -> String {
    if starts_with_formula(&escaped) {
        format!("\\{escaped}")
    } else {
        escaped
    }
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
    if matches!(el, Value::Null) {
        return escape_element(&format!("{OVERRIDE_PREFIX}{NULL_ELEMENT_CODE}:"));
    }
    let actual = scalar_of_element(el);
    let raw = scalar_to_raw(actual, el);
    if actual == elem_scalar {
        // A genuine string whose value begins with the override prefix `\T` would, once
        // escaped, be indistinguishable from a real type-override on decode. Emit it as
        // an explicit `\Ts:` string-code override, which decodes back to the literal.
        // (The TS csv codec has the matching branch, so the wire stays byte-identical.)
        if actual == Scalar::Str && raw.starts_with(OVERRIDE_PREFIX) {
            return escape_element(&format!("{OVERRIDE_PREFIX}{}:{}", Scalar::Str.code(), raw));
        }
        let body = escape_element(&raw);
        if actual == Scalar::Str {
            guard_element(body)
        } else {
            body
        }
    } else {
        escape_element(&format!("{OVERRIDE_PREFIX}{}:{}", actual.code(), raw))
    }
}

fn raw_to_element(elem_scalar: Scalar, part: &str) -> Value {
    if let Some(rest) = part.strip_prefix(OVERRIDE_PREFIX) {
        if let Some(colon) = rest.find(':') {
            let code = &rest[..colon];
            if code == NULL_ELEMENT_CODE {
                return Value::Null;
            }
            return raw_to_scalar(Scalar::from_code(code), &rest[colon + 1..]);
        }
    }
    raw_to_scalar(elem_scalar, part)
}

fn value_to_raw(t: ColType, v: &Value) -> String {
    if t.list {
        if let Value::List(elems) = v {
            return elems
                .iter()
                .map(|el| element_to_raw(t.scalar, el))
                .collect::<Vec<_>>()
                .join(";");
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
        return Value::List(
            split_list(raw)
                .iter()
                .map(|p| raw_to_element(t.scalar, p))
                .collect(),
        );
    }
    raw_to_scalar(t.scalar, raw)
}

// ---------------------------------------------------------- cell (de)coding ---

struct Encoded {
    raw: String,
    force_quote: bool,
}

fn encode_cell(column: ColType, v: &Value) -> Encoded {
    if matches!(v, Value::Null) {
        return Encoded {
            raw: NULL_TOKEN.to_string(),
            force_quote: false,
        };
    }
    let actual = infer_column(v);
    if actual == column {
        if column.scalar == Scalar::Str && !column.list {
            let s = match v {
                Value::Str(s) => s.to_string(),
                _ => String::new(),
            };
            let raw = if s.starts_with('\\') || starts_with_formula(&s) {
                format!("\\{s}")
            } else {
                s
            };
            return Encoded {
                raw,
                force_quote: true,
            };
        }
        let raw = value_to_raw(column, v);
        let force = raw.is_empty();
        return Encoded {
            raw,
            force_quote: force,
        };
    }
    let raw = format!(
        "{OVERRIDE_PREFIX}{}:{}",
        type_code(actual),
        value_to_raw(actual, v)
    );
    Encoded {
        raw,
        force_quote: false,
    }
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
                let ot = ColType {
                    scalar: Scalar::from_code(code),
                    list,
                };
                return Some(raw_to_value(ot, &rest[colon + 1..]));
            }
        }
    }
    if column.scalar == Scalar::Str && !column.list {
        return Some(Value::Str(
            text.strip_prefix('\\').unwrap_or(text).to_string(),
        ));
    }
    Some(raw_to_value(column, text))
}

// -------------------------------------------------------- RFC-4180 plumbing ---

struct Cell {
    text: String,
    quoted: bool,
}

fn quote_field(raw: &str) -> String {
    let mut out = String::new();
    quote_field_into(&mut out, raw);
    out
}

/// Append `s`, doubling any `"` — the RFC-4180 body of an already-quoted field.
///
/// The caller used to reach for `str::replace`, which ALLOCATES UNCONDITIONALLY: a fresh
/// String per cell even when there was no quote to double, which is the common case. A `Str`
/// column always sets `force_quote`, so on the cross-engine bench's two string columns that
/// was 400,000 Strings per encode for nothing.
fn push_doubling_quotes(out: &mut String, s: &str) {
    if !s.as_bytes().contains(&b'"') {
        out.push_str(s);

        return;
    }
    for ch in s.chars() {
        if ch == '"' {
            out.push_str("\"\"");
        } else {
            out.push(ch);
        }
    }
}

/// One cell's quoted text, straight into `out`.
///
/// Byte-identical to the `encode_cell` + quote pair it replaces, with a fast path for the
/// commonest cell there is: a string in a string column. That path used to allocate TWICE —
/// `scalar_to_raw` cloned the value into `Encoded::raw`, then `replace` cloned it again — and
/// now writes through. Everything else still goes through `encode_cell`, including the
/// `actual != column` mismatch branch.
fn write_cell(out: &mut String, t: ColType, v: &Value) {
    if t.scalar == Scalar::Str && !t.list && !matches!(v, Value::Null) {
        if let Value::Str(text) = v {
            if infer_column(v) == t {
                // `force_quote` is always true here, and the escape prefix goes on BEFORE the
                // quote doubling — a `\\` is not a `"`, so prefix-then-double is the same
                // bytes as the old build-then-double.
                out.push('"');
                if text.starts_with('\\') || starts_with_formula(text) {
                    out.push('\\');
                }
                push_doubling_quotes(out, text);
                out.push('"');

                return;
            }
        }
    }

    let enc = encode_cell(t, v);

    if enc.force_quote {
        out.push('"');
        push_doubling_quotes(out, &enc.raw);
        out.push('"');
    } else {
        quote_field_into(out, &enc.raw);
    }
}

/// `quote_field` straight into an existing buffer.
///
/// The owned form allocated A STRING PER FIELD purely to be appended to `out`, and in the
/// common case — no comma, quote, newline or list separator — that allocation was a verbatim
/// copy (`raw.to_string()`). On the cross-engine bench's 200,000-node CSV encode that is on the
/// order of a million Strings created and dropped for nothing, which is why native's `encode
/// csv` sat at 1.03x against pure TypeScript while every other codec managed 1.8-5.2x, and why
/// the wasm build was actually SLOWER than TypeScript there (0.89x).
///
/// Byte-for-byte the same output: the same `needs` test, the same doubling of `"`, the same
/// surrounding quotes.
fn quote_field_into(out: &mut String, raw: &str) {
    let needs = raw
        .bytes()
        .any(|b| b == b',' || b == b'"' || b == b'\n' || b == b'\r' || b == LIST_SEP as u8);
    if !needs {
        out.push_str(raw);
        return;
    }
    out.push('"');
    for ch in raw.chars() {
        if ch == '"' {
            out.push_str("\"\"");
        } else {
            out.push(ch);
        }
    }
    out.push('"');
}

/// Single-pass RFC-4180 parser. Each cell carries whether it was quoted.
fn parse_csv(input: &str) -> Vec<Vec<Cell>> {
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut row: Vec<Cell> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut in_quotes = false;
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    macro_rules! end_field {
        () => {{
            row.push(Cell {
                text: std::mem::take(&mut field),
                quoted,
            });
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
            '\r' => {}
            '\n' => {
                end_field!();
                rows.push(std::mem::take(&mut row));
            }
            _ => field.push(c),
        }
        i += 1;
    }
    if !field.is_empty() || quoted || !row.is_empty() {
        row.push(Cell {
            text: field,
            quoted,
        });
        rows.push(row);
    }
    rows
}

// ---------------------------------------- column-set computation (encode) ---

/// One element's properties, borrowed from the neutral graph data.
type Bag<'a> = &'a [(String, Value)];

fn bag_get<'a>(bag: Bag<'a>, key: &str) -> Option<&'a Value> {
    bag.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn compute_columns(bags: &[Bag<'_>]) -> (Vec<String>, HashMap<String, ColType>) {
    let mut keys: Vec<String> = Vec::new();
    let mut types: HashMap<String, ColType> = HashMap::new();
    let mut seen = HashSet::new();
    for bag in bags {
        for (key, value) in *bag {
            // BORROW BEFORE YOU CLONE. `HashSet<String>::insert` takes an owned value, so
            // `seen.insert(key.clone())` allocated a String for EVERY CELL — 600,000 of them
            // for the bench's 200,000 nodes at three properties each — to discover, after the
            // first row, that the key was already there. `contains` answers the same question
            // through `Borrow<str>` without allocating, so the clone now happens once per
            // DISTINCT key.
            if !seen.contains(key.as_str()) {
                seen.insert(key.clone());
                keys.push(key.clone());
            }
            if !matches!(value, Value::Null) && !types.contains_key(key) {
                types.insert(key.clone(), infer_column(value));
            }
        }
    }
    for key in &keys {
        types.entry(key.clone()).or_insert(ColType {
            scalar: Scalar::Str,
            list: false,
        });
    }
    (keys, types)
}

/// `types` arrives RESOLVED and positional, zipped with `keys`, rather than as the
/// `HashMap<String, ColType>` it is built in: the map form meant hashing a key string once per
/// cell per row — 600,000 lookups for the bench's 200,000 nodes at three properties each — to
/// re-derive something fixed for the whole encode.
fn write_row(out: &mut String, fixed: &[&str], keys: &[String], types: &[ColType], bag: Bag<'_>) {
    for (i, f) in fixed.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        quote_field_into(out, f);
    }
    for (key, t) in keys.iter().zip(types) {
        out.push(',');
        match bag_get(bag, key) {
            None => {}
            Some(v) => write_cell(out, *t, v),
        }
    }
}

/// Join a label set into a `;`-separated cell, escaping `;`/`\`/formula per label.
fn join_labels(labels: &[String]) -> String {
    labels
        .iter()
        .map(|l| guard_element(escape_element(l)))
        .collect::<Vec<_>>()
        .join(";")
}

fn split_labels(text: &str) -> Vec<String> {
    if text.is_empty() {
        Vec::new()
    } else {
        split_list(text)
    }
}

fn prop_cols_from_header(header: &[Cell], fixed: usize) -> Vec<(String, ColType)> {
    header
        .iter()
        .skip(fixed)
        .map(|c| parse_header(&c.text))
        .collect()
}

fn props_from_row(
    row: &[Cell],
    prop_cols: &[(String, ColType)],
    fixed: usize,
) -> Vec<(String, Value)> {
    let mut props: Vec<(String, Value)> = Vec::new();
    for (c, (key, t)) in prop_cols.iter().enumerate() {
        let Some(cell) = row.get(c + fixed) else {
            continue;
        };
        if let Some(v) = decode_cell(*t, cell) {
            props.push((key.clone(), v));
        }
    }
    props
}

// -------------------------------------------------- public nodes / edges ---

/// Serialize just the nodes section.
pub fn encode_nodes(g: &GraphData) -> String {
    let bags: Vec<Bag<'_>> = g.nodes.iter().map(|n| n.props.as_slice()).collect();
    let (keys, types) = compute_columns(&bags);

    let header = {
        let mut h = vec!["id".to_string(), ":LABEL".to_string()];
        h.extend(keys.iter().map(|k| column_header(k, types[k])));
        header_line(&h)
    };
    // Resolved ONCE, positionally, instead of a hash lookup per cell per row.
    let coltypes: Vec<ColType> = keys.iter().map(|k| types[k]).collect();
    let mut out = String::with_capacity(header.len() + g.nodes.len() * 64);
    out.push_str(&header);
    for n in &g.nodes {
        let labels = join_labels(&n.labels);
        let id = guard_field(&n.id);
        out.push('\n');
        write_row(&mut out, &[&id, &labels], &keys, &coltypes, &n.props);
    }
    out
}

/// Serialize just the edges section.
pub fn encode_edges(g: &GraphData) -> String {
    let bags: Vec<Bag<'_>> = g.edges.iter().map(|e| e.props.as_slice()).collect();
    let (keys, types) = compute_columns(&bags);

    let header = {
        let mut h = vec![
            "id".to_string(),
            ":START_ID".to_string(),
            ":END_ID".to_string(),
            ":TYPE".to_string(),
        ];
        h.extend(keys.iter().map(|k| column_header(k, types[k])));
        header_line(&h)
    };
    let coltypes: Vec<ColType> = keys.iter().map(|k| types[k]).collect();
    let mut out = String::with_capacity(header.len() + g.edges.len() * 64);
    out.push_str(&header);
    for e in &g.edges {
        let id = guard_field(e.id.as_deref().unwrap_or(""));
        let from = guard_field(&e.from);
        let to = guard_field(&e.to);
        let etype = join_labels(&e.labels);
        out.push('\n');
        write_row(
            &mut out,
            &[&id, &from, &to, &etype],
            &keys,
            &coltypes,
            &e.props,
        );
    }
    out
}

/// Encode neutral graph data to the combined single string.
pub fn encode(g: &GraphData) -> String {
    format!("{}{}{}", encode_nodes(g), SEPARATOR, encode_edges(g))
}

/// Decode the combined single-string form into neutral graph data. Endpoint
/// well-formedness (batch CSV is strict: an edge endpoint must be a declared
/// node) is the host's concern when it builds its graph.
pub fn decode(input: &str) -> GraphData {
    let all_rows = parse_csv(input);
    let split = all_rows
        .iter()
        .position(|r| r.len() == 1 && !r[0].quoted && r[0].text == EDGES_MARKER);
    let (node_rows, edge_rows): (&[Vec<Cell>], &[Vec<Cell>]) = match split {
        Some(i) => (&all_rows[..i], &all_rows[i + 1..]),
        None => (&all_rows, &[]),
    };

    let mut nodes = Vec::new();
    if let Some(header) = node_rows.first() {
        let prop_cols = prop_cols_from_header(header, 2);
        for row in node_rows.iter().skip(1) {
            let id = unguard_field(row.first().map(|c| c.text.as_str()).unwrap_or(""));
            let labels = split_labels(row.get(1).map(|c| c.text.as_str()).unwrap_or(""));
            nodes.push(Node {
                id,
                labels,
                props: props_from_row(row, &prop_cols, 2),
            });
        }
    }

    let mut edges = Vec::new();
    if let Some(header) = edge_rows.first() {
        let prop_cols = prop_cols_from_header(header, 4);
        for row in edge_rows.iter().skip(1) {
            let id = row
                .first()
                .map(|c| c.text.clone())
                .filter(|s| !s.is_empty())
                .map(|s| unguard_field(&s));
            let from = unguard_field(row.get(1).map(|c| c.text.as_str()).unwrap_or(""));
            let to = unguard_field(row.get(2).map(|c| c.text.as_str()).unwrap_or(""));
            let labels = split_labels(row.get(3).map(|c| c.text.as_str()).unwrap_or(""));
            edges.push(Edge {
                id,
                from,
                to,
                labels,
                props: props_from_row(row, &prop_cols, 4),
            });
        }
    }

    GraphData { nodes, edges }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> GraphData {
        crate::pg_json::decode(
            r#"{"nodes":[
              {"id":"a","labels":["P","Q"],"properties":{"n":42,"w":3.5,"ok":true,"name":"ann","tags":["x","y"],"mix":7,"blank":""}},
              {"id":"b","labels":["P"],"properties":{"name":"bo","mix":"hi"}}
            ],"edges":[{"id":"e0","from":"a","to":"b","labels":["KNOWS"],"properties":{"since":2020,"strength":0.9}}]}"#,
        )
        .unwrap()
    }

    fn prop<'a>(g: &'a GraphData, node_id: &str, key: &str) -> Option<&'a Value> {
        let n = g.nodes.iter().find(|n| n.id == node_id)?;
        n.props.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    #[test]
    fn round_trip_heterogeneous() {
        let g = decode(&encode(&sample()));
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
        assert_eq!(prop(&g, "a", "n"), Some(&Value::Num(42.0)));
        assert_eq!(prop(&g, "a", "w"), Some(&Value::Num(3.5)));
        assert_eq!(prop(&g, "a", "ok"), Some(&Value::Bool(true)));
        assert_eq!(prop(&g, "a", "name"), Some(&Value::Str("ann".into())));
        assert_eq!(
            prop(&g, "a", "tags"),
            Some(&Value::List(vec![
                Value::Str("x".into()),
                Value::Str("y".into())
            ]))
        );
        // present empty string survives (≠ absent)
        assert_eq!(prop(&g, "a", "blank"), Some(&Value::Str("".into())));
        // heterogeneous `mix`: int on a, string on b — via the sigil
        assert_eq!(prop(&g, "a", "mix"), Some(&Value::Num(7.0)));
        assert_eq!(prop(&g, "b", "mix"), Some(&Value::Str("hi".into())));
        // absent key stays absent
        assert_eq!(prop(&g, "b", "n"), None);
        // multi-label node
        assert_eq!(g.nodes[0].labels, vec!["P", "Q"]);
    }

    #[test]
    fn null_list_element_round_trips() {
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"t","labels":["T"],"properties":{"dims":[1,null,2],"oneNull":[null]}}],"edges":[]}"#,
        )
        .unwrap();
        let enc = encode(&g);
        assert!(
            enc.contains("Tn:"),
            "null element should use \\Tn: sigil: {enc}"
        );
        let g2 = decode(&enc);
        assert_eq!(
            prop(&g2, "t", "dims"),
            Some(&Value::List(vec![
                Value::Num(1.0),
                Value::Null,
                Value::Num(2.0)
            ]))
        );
        assert_eq!(
            prop(&g2, "t", "oneNull"),
            Some(&Value::List(vec![Value::Null]))
        );
    }

    #[test]
    fn override_sigil_string_list_element_round_trips() {
        // A string list element whose value begins with the `\T` override prefix must
        // survive: `\Ti:5` (looks like an int override), `\Tn:` (null sigil), `\Ts:x`
        // (string sigil). Alongside a real int override + a real null in another list,
        // so the disambiguation is exercised both ways.
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"t","labels":["T"],"properties":{"sigils":["\\Ti:5","\\Tn:","\\Ts:x","ok"],"real":["\\Ti:5",5,null]}}],"edges":[]}"#,
        )
        .unwrap();
        let g2 = decode(&encode(&g));
        assert_eq!(
            prop(&g2, "t", "sigils"),
            Some(&Value::List(vec![
                Value::Str("\\Ti:5".into()),
                Value::Str("\\Tn:".into()),
                Value::Str("\\Ts:x".into()),
                Value::Str("ok".into()),
            ]))
        );
        assert_eq!(
            prop(&g2, "t", "real"),
            Some(&Value::List(vec![
                Value::Str("\\Ti:5".into()),
                Value::Num(5.0),
                Value::Null,
            ]))
        );
    }

    #[test]
    fn present_null_vs_absent() {
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"a","labels":[],"properties":{"k":null,"m":1}},{"id":"b","labels":[],"properties":{"m":2}}],"edges":[]}"#,
        )
        .unwrap();
        let g2 = decode(&encode(&g));
        assert_eq!(prop(&g2, "a", "k"), Some(&Value::Null), "present null lost");
        assert_eq!(prop(&g2, "b", "k"), None, "absent became present");
    }

    #[test]
    fn temporal_columns_round_trip() {
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"e","labels":["Event"],"properties":{"on":{"@date":"2020-02-29"},"took":{"@duration":"P3M10DT90S"}}}],"edges":[]}"#,
        )
        .unwrap();
        let g2 = decode(&encode(&g));
        assert_eq!(
            prop(&g2, "e", "on"),
            Some(&Value::Temporal {
                tag: "date".into(),
                iso: "2020-02-29".into()
            })
        );
        assert_eq!(
            prop(&g2, "e", "took"),
            Some(&Value::Temporal {
                tag: "duration".into(),
                iso: "P3M10DT90S".into()
            })
        );
    }

    /// Columns of DIFFERENT types keep their own type when encoded.
    ///
    /// `write_row` takes the column types POSITIONALLY, zipped with `keys`, instead of hashing
    /// each key per cell. A mis-zip is invisible unless the columns disagree about their type —
    /// reversing the vector passed all 29 existing tests, because their fixtures use columns
    /// that share one type. Here a number, a string and a list sit side by side, so a cell
    /// encoded against the wrong column's type cannot round-trip.
    #[test]
    fn columns_of_different_types_keep_their_own() {
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"n1","labels":["L"],"properties":{"a_num":7,"b_str":"seven","c_list":[1,2]}}],"edges":[]}"#,
        )
        .unwrap();
        let enc = encode(&g);
        let g2 = decode(&enc);

        // The BYTES, not just the round-trip: a cell encoded against the wrong column's type
        // takes `encode_cell`'s mismatch branch, which writes a self-describing form that
        // still decodes correctly — so a round-trip assertion alone cannot see a mis-zip.
        let body = enc.lines().nth(1).unwrap_or_default();

        assert!(
            body.contains(",7,") && body.contains("seven"),
            "typed cells not in their plain form: {enc}"
        );
        assert_eq!(prop(&g2, "n1", "a_num"), Some(&Value::Num(7.0)), "{enc}");
        assert_eq!(
            prop(&g2, "n1", "b_str"),
            Some(&Value::Str("seven".into())),
            "{enc}"
        );
        assert_eq!(
            prop(&g2, "n1", "c_list"),
            Some(&Value::List(vec![Value::Num(1.0), Value::Num(2.0)])),
            "{enc}"
        );
    }

    /// A `"` in a FIXED field — an id or a label — round-trips, doubled per RFC 4180.
    ///
    /// `quoting_labels_and_formulas` already puts a quote in a property VALUE, but a value
    /// takes `encode_cell`'s `force_quote` branch, so the doubling loop inside
    /// `quote_field_into` is reached only by the fixed columns. Nothing covered that: breaking
    /// the doubling there (`""` emitted as `"`) passed all 29 codec tests and was caught only
    /// by the random-seeded `codec` fuzzer.
    #[test]
    fn a_quote_in_an_id_or_label_round_trips() {
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"he said \"hi\"","labels":["lab\"el"],"properties":{"k":1}},{"id":"b","labels":[],"properties":{}}],"edges":[{"id":"e\"1","from":"he said \"hi\"","to":"b","labels":["R\"EL"],"properties":{}}]}"#,
        )
        .unwrap();
        let enc = encode(&g);

        // Doubled, not dropped: a bare `"` inside a quoted field would end the field.
        assert!(
            enc.contains("\"\"hi\"\"\""),
            "embedded quote not doubled: {enc}"
        );

        let g2 = decode(&enc);

        assert!(
            g2.nodes.iter().any(|n| n.id == "he said \"hi\""),
            "id did not survive: {:?}",
            g2.nodes.iter().map(|n| &n.id).collect::<Vec<_>>()
        );
        assert!(
            g2.nodes
                .iter()
                .any(|n| n.labels.iter().any(|l| l == "lab\"el")),
            "label did not survive"
        );
        assert!(
            g2.edges
                .iter()
                .any(|e| e.labels.iter().any(|l| l == "R\"EL")),
            "edge type did not survive"
        );
    }

    #[test]
    fn quoting_labels_and_formulas() {
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"n1","labels":["has;semi","Plain"],"properties":{"s":"has,comma \"q\" ;semi","name":"=1+2","dash":"-danger"}},{"id":"b","labels":[],"properties":{}}],"edges":[{"from":"n1","to":"b","labels":["REL;X"],"properties":{}}]}"#,
        )
        .unwrap();
        let enc = encode(&g);
        assert!(enc.contains("\"\\=1+2\""), "= not neutralized: {enc}");
        assert!(enc.contains("\"\\-danger\""), "- not neutralized");
        let g2 = decode(&enc);
        assert_eq!(
            prop(&g2, "n1", "s"),
            Some(&Value::Str("has,comma \"q\" ;semi".into()))
        );
        assert_eq!(prop(&g2, "n1", "name"), Some(&Value::Str("=1+2".into())));
        let mut labels = g2
            .nodes
            .iter()
            .find(|n| n.id == "n1")
            .unwrap()
            .labels
            .clone();
        labels.sort();
        assert_eq!(labels, vec!["Plain", "has;semi"]);
        assert_eq!(g2.edges[0].labels, vec!["REL;X"]);
    }

    #[test]
    fn negative_numbers_not_neutralized() {
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"n1","labels":["N"],"properties":{"balance":-5}}],"edges":[]}"#,
        )
        .unwrap();
        let enc = encode(&g);
        assert!(!enc.contains("\\-5"), "number wrongly neutralized: {enc}");
        assert_eq!(
            prop(&decode(&enc), "n1", "balance"),
            Some(&Value::Num(-5.0))
        );
    }

    #[test]
    fn section_marker_inside_a_value_does_not_split() {
        let g = crate::pg_json::decode(
            r#"{"nodes":[{"id":"a","labels":["N"],"properties":{"note":"x\n=== EDGES ===\ny"}},{"id":"b","labels":["N"],"properties":{}}],"edges":[{"from":"a","to":"b","labels":["R"],"properties":{}}]}"#,
        )
        .unwrap();
        let g2 = decode(&encode(&g));
        assert_eq!(g2.nodes.len(), 2, "premature split dropped a node");
        assert_eq!(g2.edges.len(), 1, "premature split dropped the edge");
        assert_eq!(
            prop(&g2, "a", "note"),
            Some(&Value::Str("x\n=== EDGES ===\ny".into()))
        );
    }
}
