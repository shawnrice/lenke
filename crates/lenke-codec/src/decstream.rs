//! Streaming DECODE: the mirror of [`stream`](crate::stream). A format decoder
//! walks the parsed JSON tree (which it keeps alive for the whole walk) and pushes
//! each element to a [`GraphSink`] as BORROWED views, instead of first building an
//! owned [`GraphData`](crate::GraphData) that the host then copies into its store.
//!
//! Why: `from_graph_data(deserialize(input))` materialized every value twice — once
//! as the codec's owned `Value` inside a `GraphData`, then again as the host's own
//! value — so a decode allocated a `String` per property before the host had even
//! seen it. A `DecVal` borrows the parsed tree, so a scalar property is handed over
//! with no allocation and the host makes exactly one value (its own).

use crate::json::{self, Json};
use crate::model::{GraphData, Value};
use crate::CodeResult;

/// A decoded property value BORROWED from the parsed JSON tree. Scalars borrow with
/// no allocation; the host sink turns each into its own value type as it inserts.
/// A nested list/map recurses, still borrowing every leaf string.
pub enum DecVal<'a> {
    Null,
    Bool(bool),
    Num(f64),
    Str(&'a str),
    Temporal { tag: &'a str, iso: &'a str },
    List(Vec<DecVal<'a>>),
    Map(Vec<(&'a str, DecVal<'a>)>),
}

/// The host implements this to receive decoded elements and build its graph
/// directly. `Err` aborts the decode with that [`CodecError`] (a strict missing
/// endpoint, a malformed temporal — whatever the host enforces). Endpoint order is
/// the document's; the host resolves `from`/`to` against the nodes it has seen.
pub trait GraphSink {
    fn node(&mut self, id: &str, labels: &[&str], props: &[(&str, DecVal<'_>)]) -> CodeResult<()>;
    fn edge(
        &mut self,
        id: Option<&str>,
        from: &str,
        to: &str,
        labels: &[&str],
        props: &[(&str, DecVal<'_>)],
    ) -> CodeResult<()>;
}

/// An owned [`Value`] viewed as a BORROWED [`DecVal`], and the reverse.
///
/// These two let a codec that already has an owned `decode` gain a streaming `decode_into`
/// without a second parser: the row walker becomes the only one, `decode_into` hands the sink
/// borrowed views of values it built for THAT ROW, and `decode` drives the same walker through
/// [`GraphDataSink`]. What disappears is the whole-document `Vec<Node>` and the second traversal
/// the engine's `from_graph_data` made over it — which for csv was ~60ms of a 119ms decode.
pub(crate) fn value_to_decval(v: &Value) -> DecVal<'_> {
    match v {
        Value::Null => DecVal::Null,
        Value::Bool(b) => DecVal::Bool(*b),
        Value::Num(n) => DecVal::Num(*n),
        Value::Str(s) => DecVal::Str(s),
        Value::Temporal { tag, iso } => DecVal::Temporal { tag, iso },
        Value::List(items) => DecVal::List(items.iter().map(value_to_decval).collect()),
        Value::Map(pairs) => DecVal::Map(
            pairs
                .iter()
                .map(|(k, x)| (k.as_str(), value_to_decval(x)))
                .collect(),
        ),
    }
}

pub(crate) fn decval_to_value(v: &DecVal<'_>) -> Value {
    match v {
        DecVal::Null => Value::Null,
        DecVal::Bool(b) => Value::Bool(*b),
        DecVal::Num(n) => Value::Num(*n),
        DecVal::Str(s) => Value::Str((*s).to_string()),
        DecVal::Temporal { tag, iso } => Value::Temporal {
            tag: (*tag).to_string(),
            iso: (*iso).to_string(),
        },
        DecVal::List(items) => Value::List(items.iter().map(decval_to_value).collect()),
        DecVal::Map(pairs) => Value::Map(
            pairs
                .iter()
                .map(|(k, x)| ((*k).to_string(), decval_to_value(x)))
                .collect(),
        ),
    }
}

/// A [`GraphSink`] that collects into a [`GraphData`], so one streaming walker can serve both
/// the streaming and the owned entry point. Never errors.
#[derive(Default)]
pub(crate) struct GraphDataSink {
    pub data: GraphData,
}

impl GraphSink for GraphDataSink {
    fn node(&mut self, id: &str, labels: &[&str], props: &[(&str, DecVal<'_>)]) -> CodeResult<()> {
        self.data.nodes.push(crate::model::Node {
            id: id.to_string(),
            labels: labels.iter().map(|l| (*l).to_string()).collect(),
            props: props
                .iter()
                .map(|(k, v)| ((*k).to_string(), decval_to_value(v)))
                .collect(),
        });

        Ok(())
    }

    fn edge(
        &mut self,
        id: Option<&str>,
        from: &str,
        to: &str,
        labels: &[&str],
        props: &[(&str, DecVal<'_>)],
    ) -> CodeResult<()> {
        self.data.edges.push(crate::model::Edge {
            id: id.map(str::to_string),
            from: from.to_string(),
            to: to.to_string(),
            labels: labels.iter().map(|l| (*l).to_string()).collect(),
            props: props
                .iter()
                .map(|(k, v)| ((*k).to_string(), decval_to_value(v)))
                .collect(),
        });

        Ok(())
    }
}

/// A parsed JSON value as a BORROWED [`DecVal`] — the streaming twin of
/// `json_to_value`. A non-finite number → `Null`; a single-key `{"@date":…}` → a
/// tagged temporal; any other object → a map. Leaf strings point into the tree.
pub(crate) fn json_to_decval<'a>(j: &'a Json<'a>) -> DecVal<'a> {
    match j {
        Json::Null => DecVal::Null,
        Json::Bool(b) => DecVal::Bool(*b),
        Json::Num(n) => {
            if n.is_finite() {
                DecVal::Num(*n)
            } else {
                DecVal::Null
            }
        }
        Json::Str(s) => DecVal::Str(s.as_ref()),
        Json::Arr(a) => DecVal::List(a.iter().map(json_to_decval).collect()),
        Json::Obj(pairs) => match json::temporal_from_pairs_ref(pairs) {
            Some((tag, iso)) => DecVal::Temporal { tag, iso },
            None => DecVal::Map(
                pairs
                    .iter()
                    .map(|(k, v)| (json::unescape_record_key(k.as_ref()), json_to_decval(v)))
                    .collect(),
            ),
        },
    }
}

/// Decode `input` in a STREAMING format, pushing elements to `sink`. Only formats
/// with a borrowed decoder route here (pg-json today; graphson next) — the host
/// keeps the owned-`GraphData` path for the rest, where the copy is unavoidable
/// anyway (csv is columnar). Returns `false` if `format` has no streaming decoder,
/// so the host can fall back without a second format table.
pub fn deserialize_into(
    input: &str,
    format: &str,
    sink: &mut dyn GraphSink,
) -> Option<CodeResult<()>> {
    match format {
        "pg-json" => Some(crate::pg_json::decode_into(input, sink)),
        "graphson" => Some(crate::graphson::decode_into(input, sink)),
        "pg-text" => Some(crate::pg_text::decode_into(input, sink)),
        "csv" => Some(crate::csv::decode_into(input, sink)),
        // Every textual format now streams; nothing falls back to the `GraphData` bridge.
        _ => None,
    }
}
