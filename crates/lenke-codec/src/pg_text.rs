//! The PG textual format (`.pg`) over the neutral model — a faithful port of
//! the now-removed lenke-core's `codec::pg_text`, retyped to [`GraphData`]/[`Value`]. One element
//! per line:
//! ```text
//! <id> :Label* key:value*          ← a node (one leading id)
//! <from> <to> :Label* key:value*   ← an edge (two leading ids)
//! ```
//! Told apart by the second token: a bare id (no `:`) means an edge. `#` starts a
//! comment.
//!
//! Values: strings are double-quoted (escaping `"`/`\` and the whitespace control
//! chars); numbers/booleans/`null` are bare; a temporal rides as an unquoted
//! `@<tag>:<iso>` token; a list rides on **repeated keys** (`tags:1 tags:2`), so
//! an empty list emits nothing and a single-element list is indistinguishable from
//! a scalar. The textual format has no edge-id slot, so a decoded edge carries no
//! id (the host re-derives the canonical `e{index}`).

use std::borrow::Cow;

use crate::decstream::{DecVal, GraphSink};
use crate::model::{is_temporal_tag, Edge, GraphData, Node, Value};
use crate::CodeResult;

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
                out.push_str(&crate::js_number(*x));
            } else {
                out.push_str("null");
            }
        }
        // A temporal rides as an unquoted `@<tag>:<iso>` token — the ISO form has
        // no whitespace/newline, so it stays on one physical line, and the `@`
        // sigil lets the parser tell it from a quoted string.
        Value::Temporal { tag, iso } => {
            out.push('@');
            out.push_str(tag);
            out.push(':');
            out.push_str(iso);
        }
        Value::Str(s) => {
            out.push('"');
            for c in s.chars() {
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
        // A map has no flat-token form; `serialize` pre-rejects a pg-text export
        // that contains one, so this is unreachable in practice.
        Value::Map(_) => {
            unreachable!("pg-text cannot carry a map; serialize() rejects it up front")
        }
    }
}

/// Append `key:value` tokens for one property (a list expands to one per element).
fn push_property(tokens: &mut Vec<String>, key: &str, v: &Value) {
    let k = id_token(key); // arbitrary keys are quoted like ids
    match v {
        Value::List(elems) => {
            for el in elems {
                let mut t = format!("{k}:");
                scalar_token(&mut t, el);
                tokens.push(t);
            }
        }
        _ => {
            let mut t = format!("{k}:");
            scalar_token(&mut t, v);
            tokens.push(t);
        }
    }
}

/// Escape a string's quote/backslash/control chars into a quoted token body.
fn quote_escaped(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
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
    out
}

/// Render a label token (`:label`); an embedded `:` needs no quoting, but
/// whitespace / quote / backslash still do.
fn label_token(s: &str) -> String {
    if s.chars()
        .any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '"' | '\\'))
    {
        quote_escaped(s)
    } else {
        s.to_string()
    }
}

/// Render an id as a token, quoting + escaping it when it contains a `:`,
/// whitespace, a quote/backslash, or is empty — so ids round-trip instead of
/// corrupting the line shape.
fn id_token(s: &str) -> String {
    let needs_quote = s.is_empty()
        || s.chars()
            .any(|c| matches!(c, ':' | ' ' | '\t' | '\n' | '\r' | '"' | '\\'));
    if needs_quote {
        quote_escaped(s)
    } else {
        s.to_string()
    }
}

/// Render a scalar value from a BORROWED [`ValueRef`] — the streaming twin of
/// [`scalar_token`], same bytes. A nested list/map is never a `ValueRef` scalar
/// (the sink handles those), so it is unreachable here.
fn scalar_token_ref(out: &mut String, v: crate::ValueRef) {
    use crate::ValueRef;
    match v {
        ValueRef::Null => out.push_str("null"),
        ValueRef::Bool(b) => out.push_str(if b { "true" } else { "false" }),
        ValueRef::Num(x) => {
            if x.is_finite() {
                out.push_str(&crate::js_number(x));
            } else {
                out.push_str("null");
            }
        }
        ValueRef::Temporal { tag, iso } => {
            out.push('@');
            out.push_str(tag);
            out.push(':');
            out.push_str(iso);
        }
        ValueRef::Str(s) => write_quote_body(out, s),
        ValueRef::Nested(_) => unreachable!("the sink expands a list/map, never a scalar token"),
    }
}

/// Write the escaped, double-quoted body of a string (shared by the token writers).
fn write_quote_body(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
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

/// Write an id token, quoting/escaping when needed (buffer twin of [`id_token`]).
fn write_id_token(out: &mut String, s: &str) {
    let needs_quote = s.is_empty()
        || s.chars()
            .any(|c| matches!(c, ':' | ' ' | '\t' | '\n' | '\r' | '"' | '\\'));
    if needs_quote {
        write_quote_body(out, s);
    } else {
        out.push_str(s);
    }
}

/// Write a `:label` token (buffer twin of `format!(":{}", label_token(l))`).
fn write_label_token(out: &mut String, s: &str) {
    out.push(':');
    if s.chars()
        .any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '"' | '\\'))
    {
        write_quote_body(out, s);
    } else {
        out.push_str(s);
    }
}

/// A streaming PG-text encoder — the byte-identical twin of [`encode`] that writes
/// each element's line from borrowed data instead of an owned [`GraphData`]. The
/// host calls [`begin`](Self::begin) (leading ids), then [`label`](Self::label) /
/// [`prop`](Self::prop) per token, and [`finish`](Self::finish). A map/record
/// property has no flat form, so `prop` returns `Err(UNSUPPORTED)` — the same
/// rejection `serialize`'s up-front `has_map_property` check makes.
pub struct PgTextSink {
    out: String,
    first: bool,
    any: bool,
}

impl PgTextSink {
    #[must_use]
    pub fn new(elements: usize) -> Self {
        Self {
            out: String::with_capacity(elements * 48),
            first: true,
            any: false,
        }
    }

    fn sep(&mut self) {
        if self.any {
            self.out.push(' ');
        }
        self.any = true;
    }

    /// Start a new element line (a node has one leading id; an edge has two).
    pub fn begin(&mut self, leading: &[&str]) {
        if !self.first {
            self.out.push('\n');
        }
        self.first = false;
        self.any = false;
        for l in leading {
            self.sep();
            write_id_token(&mut self.out, l);
        }
    }

    /// Append a `:label` token.
    pub fn label(&mut self, l: &str) {
        self.sep();
        write_label_token(&mut self.out, l);
    }

    /// Append a property token (a list expands to one `key:value` per element).
    pub fn prop(&mut self, key: &str, v: crate::ValueRef) -> CodeResult<()> {
        match v {
            crate::ValueRef::Nested(Value::List(elems)) => {
                for el in elems {
                    self.sep();
                    write_id_token(&mut self.out, key);
                    self.out.push(':');
                    scalar_token(&mut self.out, el);
                }
            }
            crate::ValueRef::Nested(_) => {
                return Err(crate::flat_map_property_error());
            }
            scalar => {
                self.sep();
                write_id_token(&mut self.out, key);
                self.out.push(':');
                scalar_token_ref(&mut self.out, scalar);
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn finish(self) -> String {
        self.out
    }
}

fn element_line(leading: &[&str], labels: &[String], props: &[(String, Value)]) -> String {
    let mut tokens: Vec<String> = leading.iter().map(|s| id_token(s)).collect();
    for l in labels {
        tokens.push(format!(":{}", label_token(l)));
    }
    for (k, v) in props {
        push_property(&mut tokens, k, v);
    }
    tokens.join(" ")
}

/// Serialize neutral graph data to PG-text: node lines, then edge lines.
pub fn encode(g: &GraphData) -> String {
    let mut lines: Vec<String> = Vec::with_capacity(g.nodes.len() + g.edges.len());
    for n in &g.nodes {
        lines.push(element_line(&[&n.id], &n.labels, &n.props));
    }
    for e in &g.edges {
        lines.push(element_line(&[&e.from, &e.to], &e.labels, &e.props));
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/// Split a line into tokens, keeping double-quoted spans (with `\` escapes) whole.
fn tokenize(line: &str) -> Vec<&str> {
    let b = line.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut start = 0;
    let mut started = false;
    let mut in_quote = false;

    while i < b.len() {
        let c = b[i];
        if in_quote {
            if c == b'\\' && i + 1 < b.len() {
                i += 2;
                continue;
            }
            if c == b'"' {
                in_quote = false;
            }
            i += 1;
            continue;
        }
        if c == b'"' {
            if !started {
                start = i;
                started = true;
            }
            in_quote = true;
        } else if c == b' ' || c == b'\t' {
            if started {
                tokens.push(&line[start..i]);
                started = false;
            }
        } else if !started {
            start = i;
            started = true;
        }
        i += 1;
    }
    if started {
        tokens.push(&line[start..]);
    }
    tokens
}

/// Looks like a JS-`Number`-shaped token (so `1e3` parses, but `inf` does not).
fn is_number(raw: &str) -> bool {
    let first = raw.as_bytes().first().copied();
    matches!(first, Some(b'0'..=b'9') | Some(b'-') | Some(b'.'))
        && raw.parse::<f64>().is_ok_and(f64::is_finite)
}

/// Parse the value half of a `key:value` token into a scalar value.
/// A parsed scalar whose strings BORROW the input line wherever they can.
///
/// The streaming decoder needs `DecVal`, which is `&str` all the way down, while `decode` needs
/// owned `Value`s — so the grammar is parsed ONCE into this, and the two forms are cheap
/// adapters over it (`into_value` / `as_decval`). Writing a second borrowed parser beside the
/// owned one would be two implementations of one grammar that can drift apart, which is the
/// divergence class the byte-identity fuzzers exist to catch.
///
/// Borrowing is the common case and that is the whole point: `unescape` is the IDENTITY on a
/// body with no backslash, so a quoted token without an escape can point straight at the line,
/// and an unquoted one always can. Only a genuine escape allocates.
#[derive(Clone)]
pub(crate) enum CowVal<'a> {
    Null,
    Bool(bool),
    Num(f64),
    Str(Cow<'a, str>),
    Temporal { tag: &'a str, iso: Cow<'a, str> },
    List(Vec<CowVal<'a>>),
}

impl CowVal<'_> {
    fn into_value(self) -> Value {
        match self {
            CowVal::Null => Value::Null,
            CowVal::Bool(b) => Value::Bool(b),
            CowVal::Num(n) => Value::Num(n),
            CowVal::Str(s) => Value::Str(s.into_owned()),
            CowVal::Temporal { tag, iso } => Value::Temporal {
                tag: tag.to_string(),
                iso: iso.into_owned(),
            },
            CowVal::List(items) => Value::List(items.into_iter().map(CowVal::into_value).collect()),
        }
    }

    fn as_decval(&self) -> DecVal<'_> {
        match self {
            CowVal::Null => DecVal::Null,
            CowVal::Bool(b) => DecVal::Bool(*b),
            CowVal::Num(n) => DecVal::Num(*n),
            CowVal::Str(s) => DecVal::Str(s),
            CowVal::Temporal { tag, iso } => DecVal::Temporal { tag, iso },
            CowVal::List(items) => DecVal::List(items.iter().map(CowVal::as_decval).collect()),
        }
    }
}

/// `unescape` without the allocation when there is nothing to unescape.
fn unescape_cow(body: &str) -> Cow<'_, str> {
    if body.contains('\\') {
        Cow::Owned(unescape(body))
    } else {
        Cow::Borrowed(body)
    }
}

fn parse_scalar_cow(raw: &str) -> CowVal<'_> {
    if let Some(rest) = raw.strip_prefix('"') {
        let body = rest.strip_suffix('"').unwrap_or(rest);

        return CowVal::Str(unescape_cow(body));
    }
    if let Some(rest) = raw.strip_prefix('@') {
        if let Some((tag, iso)) = rest.split_once(':') {
            if is_temporal_tag(tag) {
                return CowVal::Temporal {
                    tag,
                    iso: Cow::Borrowed(iso),
                };
            }
        }
    }
    match raw {
        "true" => CowVal::Bool(true),
        "false" => CowVal::Bool(false),
        "null" => CowVal::Null,
        _ if is_number(raw) => CowVal::Num(raw.parse().unwrap_or(f64::NAN)),
        _ => CowVal::Str(Cow::Borrowed(raw)),
    }
}

/// Read an id token, unquoting + unescaping only when it has to.
fn parse_id_cow(raw: &str) -> Cow<'_, str> {
    let Some(rest) = raw.strip_prefix('"') else {
        return Cow::Borrowed(raw);
    };
    let body = rest.strip_suffix('"').unwrap_or(rest);

    unescape_cow(body)
}

/// A line's labels plus its first-seen-ordered properties (repeated keys → lists), BORROWING
/// the line wherever no unescaping is needed. The one parser; `decode` and `decode_into` adapt.
type LabelsAndProps<'a> = (Vec<Cow<'a, str>>, Vec<(Cow<'a, str>, CowVal<'a>)>);

fn parse_labels_props<'a>(tokens: &[&'a str]) -> LabelsAndProps<'a> {
    let mut labels: Vec<Cow<'a, str>> = Vec::new();
    let mut props: Vec<(Cow<'a, str>, CowVal<'a>)> = Vec::new();
    let mut promoted: Vec<usize> = Vec::new();

    for token in tokens {
        if let Some(rest) = token.strip_prefix(':') {
            labels.push(parse_id_cow(rest));
            continue;
        }
        let sep = if token.starts_with('"') {
            let end = quoted_span_end(token, 0);
            if end >= token.len() || token.as_bytes()[end] != b':' {
                continue;
            }
            end
        } else {
            match token.find(':') {
                Some(c) => c,
                None => continue,
            }
        };
        let key = parse_id_cow(&token[..sep]);
        let value = parse_scalar_cow(&token[sep + 1..]);

        match props.iter().position(|(k, _)| *k == key) {
            Some(pos) if promoted.contains(&pos) => {
                if let CowVal::List(items) = &mut props[pos].1 {
                    items.push(value);
                }
            }
            Some(pos) => {
                let prev = std::mem::replace(&mut props[pos].1, CowVal::Null);
                props[pos].1 = CowVal::List(vec![prev, value]);
                promoted.push(pos);
            }
            None => props.push((key, value)),
        }
    }
    (labels, props)
}

/// Index just past the closing `"` of a quoted span at `start`, respecting
/// `\`-escapes; `s.len()` if unterminated.
fn quoted_span_end(s: &str, start: usize) -> usize {
    let b = s.as_bytes();
    let mut i = start + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return i + 1,
            _ => i += 1,
        }
    }
    s.len()
}

/// A leading token is an id iff it's a *whole* quoted span or has no `:`.
fn is_id_token(t: &str) -> bool {
    if t.starts_with('"') {
        quoted_span_end(t, 0) == t.len()
    } else {
        !t.contains(':')
    }
}

/// A second token that is an id (not a `:label` / `key:value`) marks an edge line.
fn is_edge_line(tokens: &[&str]) -> bool {
    tokens.len() >= 2 && is_id_token(tokens[1])
}

/// Read an id token, unquoting + unescaping it if it was quoted.
fn parse_id(raw: &str) -> String {
    parse_id_cow(raw).into_owned()
}

/// Undo the encode escapes: `\n`/`\r`/`\t` → the control chars, `\\`/`\"` → self,
/// any other `\x` → a literal `x` (lenient for foreign `.pg`).
fn unescape(body: &str) -> String {
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
    out
}

/// Deserialize a PG-text string into neutral graph data. Endpoints referenced by
/// an edge but never declared as a node line are the host's concern (pg-text is
/// the lenient codec — the host auto-creates them). Decode is infallible.
/// Owned labels + props, for the `GraphData` form.
fn owned(
    labels: Vec<Cow<'_, str>>,
    props: Vec<(Cow<'_, str>, CowVal<'_>)>,
) -> (Vec<String>, Vec<(String, Value)>) {
    (
        labels.into_iter().map(Cow::into_owned).collect(),
        props
            .into_iter()
            .map(|(k, v)| (k.into_owned(), v.into_value()))
            .collect(),
    )
}

pub fn decode(input: &str) -> GraphData {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
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
            let from = parse_id(tokens[0]);
            let to = parse_id(tokens[1]);
            let (labels, props) = parse_labels_props(&tokens[2..]);
            let (labels, props) = owned(labels, props);

            edges.push(Edge {
                id: None,
                from,
                to,
                labels,
                props,
            });
        } else {
            let id = parse_id(tokens[0]);
            let (labels, props) = parse_labels_props(&tokens[1..]);
            let (labels, props) = owned(labels, props);

            nodes.push(Node { id, labels, props });
        }
    }
    GraphData { nodes, edges }
}

/// Decode straight into a [`GraphSink`], with no `GraphData` in between.
///
/// pg-text was one of two formats (with csv) that had no streaming decoder, so the engine built
/// a whole owned `GraphData` and then rebuilt its store from it. Staged over a 9 MB /
/// 200,000-node document: the parse was 45.7ms, `from_graph_data` 65.4ms, the whole
/// `deserialize` 115.6ms — the BRIDGE was 57% of it, on an ingest path.
///
/// The borrowed views handed to the sink point either at `input` or at the `Cow::Owned` strings
/// held in the two locals below, which are complete before any reference into them is taken and
/// outlive the call. Nothing is cloned to make the call.
pub fn decode_into(input: &str, sink: &mut dyn GraphSink) -> CodeResult<()> {
    for raw in input.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let tokens = tokenize(line);
        if tokens.is_empty() {
            continue;
        }
        let edge = is_edge_line(&tokens);
        let rest = if edge { &tokens[2..] } else { &tokens[1..] };
        let (labels, props) = parse_labels_props(rest);
        // Borrowed views over the two locals, taken only once both are final.
        let label_refs: Vec<&str> = labels.iter().map(Cow::as_ref).collect();
        let prop_refs: Vec<(&str, DecVal<'_>)> = props
            .iter()
            .map(|(k, v)| (k.as_ref(), v.as_decval()))
            .collect();

        if edge {
            let from = parse_id_cow(tokens[0]);
            let to = parse_id_cow(tokens[1]);

            sink.edge(None, &from, &to, &label_refs, &prop_refs)?;
        } else {
            let id = parse_id_cow(tokens[0]);

            sink.node(&id, &label_refs, &prop_refs)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_scalars_and_lists() {
        let g = decode(
            "a :Person name:\"Ann\" age:30 active:true tags:x tags:y\nb :Person :Admin name:\"Bo\"\na b :KNOWS since:2020",
        );
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.nodes[0].props[1], ("age".to_string(), Value::Num(30.0)));
        assert_eq!(
            g.nodes[0].props[2],
            ("active".to_string(), Value::Bool(true))
        );
        assert_eq!(
            g.nodes[0].props[3].1,
            Value::List(vec![Value::Str("x".into()), Value::Str("y".into())]),
        );
        assert_eq!(g.nodes[1].labels, vec!["Person", "Admin"]);
        // stable through a round trip
        let g2 = decode(&encode(&g));
        assert_eq!(g2.nodes[0].props[3].1, g.nodes[0].props[3].1);
        assert_eq!(g2.edges.len(), 1);
    }

    #[test]
    fn a_key_repeated_three_times_collects_in_order() {
        let g = decode("a t:x t:y t:z");
        assert_eq!(
            g.nodes[0].props[0].1,
            Value::List(vec![
                Value::Str("x".into()),
                Value::Str("y".into()),
                Value::Str("z".into())
            ]),
        );
    }

    #[test]
    fn temporal_token_round_trips() {
        let g = decode("a on:@date:2020-02-29 took:@duration:P3M10DT90S");
        assert_eq!(
            g.nodes[0].props[0],
            (
                "on".to_string(),
                Value::Temporal {
                    tag: "date".into(),
                    iso: "2020-02-29".into()
                }
            ),
        );
        assert_eq!(
            encode(&g),
            "a on:@date:2020-02-29 took:@duration:P3M10DT90S"
        );
    }

    #[test]
    fn unknown_temporal_tag_stays_a_string() {
        let g = decode("a x:@nope:foo");
        assert_eq!(g.nodes[0].props[0].1, Value::Str("@nope:foo".into()));
    }

    #[test]
    fn edge_endpoint_and_comments() {
        let g = decode("# a comment\na b :KNOWS");
        assert_eq!(g.nodes.len(), 0); // endpoints are the host's concern (lenient)
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].labels, vec!["KNOWS"]);
    }

    #[test]
    fn quoted_control_chars_round_trip() {
        let g = decode("a name:\"a b\\\"c\\nd\"");
        assert_eq!(g.nodes[0].props[0].1, Value::Str("a b\"c\nd".into()));
        let g2 = decode(&encode(&g));
        assert_eq!(g2.nodes[0].props[0].1, Value::Str("a b\"c\nd".into()));
        assert_eq!(
            encode(&g).lines().count(),
            1,
            "a control char leaked a newline"
        );
    }
}
