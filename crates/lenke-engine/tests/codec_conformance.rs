//! The RUST half of the cross-implementation codec conformance corpus.
//!
//! # Why this file exists (item 2536)
//!
//! `conformance/codec-corpus.json` was built as the durable fix for silent Rust↔TS codec
//! drift: both engines read the SAME fixture, apply the SAME structural normalization, and
//! must agree. The corpus says so itself ("read by BOTH the Rust crate (crates/lenke-engine,
//! conformance test) and the TS `@lenke/serialization` suite"), and the TS half's docstring
//! says it reads the same fixture "as the Rust crate's conformance test".
//!
//! **Both statements were false.** The Rust reader lived in the retired `pl-graph-core` crate
//! and was lost in the migration; a sweep for every reference to the corpus found exactly ONE,
//! the TS test. So `expect(want).toBe(corpus.canonical_normal)` — labelled the "cross-impl
//! golden" — was comparing TS against a committed STRING, which proves only that Rust agreed on
//! the day the golden was dumped, by a crate that no longer exists. The comment had even been
//! updated to name `lenke-engine` during the rename sweep, without restoring the reader, so the
//! claim read as current while nothing checked it.
//!
//! That is the gap items 2533-2535 walked through: three JSON acceptance divergences between
//! the engines (escaped non-BMP characters rejected, four malformed numbers accepted, unescaped
//! control characters accepted), on a surface this corpus was supposed to be guarding.
//!
//! # What this asserts
//!
//! The same three things the TS half asserts, so the two can disagree only if the engines do:
//!
//! 1. the canonical graph decodes to the golden normal form — the actual cross-engine claim,
//!    since both sides now derive the string from their own store rather than trusting it;
//! 2. it round-trips structurally through all five formats;
//! 3. every row of the reject table is refused with the same error code.
//!
//! Normalization is a PORT of the TS `normalize`/`propRepr`, deliberately line-for-line: nodes
//! and edges sorted, labels sorted and joined, properties sorted by key and rendered as
//! `key=<JSON>`, and edge ids ignored (Rust assigns `e{index}` where TS assigns a random id, a
//! divergence that is by design). `encode_value` is the value renderer because it is the one
//! the engine already uses for NDJSON and it matches `JSON.stringify` — the number formatting
//! included, which is what makes a `1.5` or a `-0` comparable at all.
//!
//! A stored `null` is PRESENT, not absent (`null-first-class-policy`), which the golden relies
//! on: the canonical graph's `KNOWS` edge carries `note=null`. So presence is tested with
//! `has_prop` / `has_edge_prop` rather than by checking whether the value reads as null.

use lenke_engine::codec;
use lenke_engine::ndjson;
use lenke_engine::store::Store;

/// Path is relative to THIS FILE, so it breaks loudly at compile time if the corpus moves —
/// which is the failure mode that let the old reader disappear unnoticed.
const CORPUS: &str = include_str!("../../../conformance/codec-corpus.json");

/// A property bag's canonical text: keys sorted, `key=<JSON value>`, comma-joined. The TS half
/// builds the same string with `Object.keys(bag).sort()` and `JSON.stringify`.
fn prop_repr(
    keys: &[String],
    present: impl Fn(&str) -> bool,
    read: impl Fn(&str) -> lenke_engine::value::Value,
) -> String {
    let mut sorted: Vec<&String> = keys.iter().filter(|k| present(k)).collect();
    sorted.sort();

    sorted
        .iter()
        .map(|k| {
            let mut v = String::new();
            ndjson::encode_value(&mut v, &read(k));

            format!("{k}={v}")
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Order-independent string form of a store; edge ids deliberately ignored.
fn normalize(store: &Store) -> String {
    let node_keys = store.prop_keys();
    let edge_keys: Vec<String> = store
        .edge_prop_keys_arc()
        .iter()
        .map(|k| k.to_string())
        .collect();
    let mut lines: Vec<String> = Vec::new();
    let n = u32::try_from(store.node_count()).unwrap_or(u32::MAX);

    for id in 0..n {
        if !store.is_alive(id) {
            continue;
        }

        let mut labels = store.labels_of_refs(id);
        labels.sort_unstable();

        lines.push(format!(
            "V {} [{}] {{{}}}",
            store.node_ext_id_ref(id).unwrap_or(""),
            labels.join(","),
            prop_repr(&node_keys, |k| store.has_prop(id, k), |k| store.prop(id, k)),
        ));
    }

    for from in 0..n {
        if !store.is_alive(from) {
            continue;
        }

        for a in store.out(from) {
            let eid = a.eid;
            let mut types = store.edge_labels_of_refs(eid);
            types.sort_unstable();

            lines.push(format!(
                "E {}->{} :{} {{{}}}",
                store.node_ext_id_ref(from).unwrap_or(""),
                store.node_ext_id_ref(a.nbr).unwrap_or(""),
                types.join(","),
                prop_repr(
                    &edge_keys,
                    |k| store.has_edge_prop(eid, k),
                    |k| store.edge_prop(eid, k)
                ),
            ));
        }
    }

    lines.sort();
    lines.join("\n")
}

/// The OTHER half's source, embedded so that DELETING it breaks this build.
///
/// `include_str!` on the corpus (above) catches the corpus moving. It does NOT catch what actually
/// happened at item 2536: the corpus stayed put and the READER disappeared, leaving every comment
/// still claiming a cross-implementation check that no longer existed. A fixture is cross-engine
/// only while BOTH sides still read it, so each half now holds the other to that.
const TS_HALF: &str = include_str!("../../../packages/serialization/src/conformance.test.ts");

/// The audit at item 2537 swept every shared corpus / golden / fixture in the repo and counted its
/// readers per language. `codec-corpus.json` was the ONLY file that claims to be cross-engine, and
/// after 2536 both of its readers are present. Three other files tripped a first-pass filter and
/// all three were co-occurrence artifacts: the claim matched somewhere in the 23,000-line audit
/// document rather than near the reference. Requiring the claim WITHIN 600 characters of the
/// filename dropped the count to zero. The remaining one-sided fixtures — the ported TinkerPop
/// `modern_*` graphs, the GQL corpus shards, a TS-only demo graph — are one-sided BY DESIGN, and
/// `docs/conformance/order-union.groovy` has no code reader because it is a console oracle a human
/// pipes into TinkerPop.
#[test]
fn the_other_half_of_this_corpus_still_reads_it() {
    assert!(
        TS_HALF.contains("codec-corpus.json"),
        "the TS half no longer reads the shared corpus — this stopped being a \
         cross-implementation test the moment that happened, which is exactly how item 2536's gap \
         went unnoticed",
    );

    // It must also still APPLY the corpus, not merely mention it in prose.
    for needed in ["canonical_normal", "reject"] {
        assert!(
            TS_HALF.contains(needed),
            "the TS half no longer checks `{needed}`, so the two halves assert different things",
        );
    }
}

fn corpus() -> serde_json::Value {
    serde_json::from_str(CORPUS).expect("the shared corpus is valid JSON")
}

#[test]
fn the_canonical_graph_matches_the_cross_engine_golden() {
    let c = corpus();
    let canonical = c["canonical"].as_str().expect("canonical is a string");
    let want = c["canonical_normal"]
        .as_str()
        .expect("canonical_normal is a string");

    let store = ndjson::from_ndjson(canonical).expect("the canonical graph decodes");
    let got = normalize(&store);

    assert_eq!(
        got, want,
        "the Rust engine's reading of the canonical graph differs from the committed golden \
         that the TS engine is checked against — the two implementations disagree, or the \
         golden is stale",
    );
}

#[test]
fn the_canonical_graph_round_trips_through_every_format() {
    let c = corpus();
    let canonical = c["canonical"].as_str().expect("canonical is a string");
    let store = ndjson::from_ndjson(canonical).expect("the canonical graph decodes");
    let want = normalize(&store);

    // NDJSON keeps its own native module; the other four go through the shared codec crate.
    let back = ndjson::from_ndjson(&ndjson::to_ndjson(&store)).expect("ndjson round-trips");
    assert_eq!(
        normalize(&back),
        want,
        "ndjson round trip changed the graph"
    );

    for format in ["pg-json", "pg-text", "graphson", "csv"] {
        let blob = codec::serialize(&store, format)
            .unwrap_or_else(|e| panic!("{format} failed to encode: {e:?}"));
        let back = codec::deserialize(&blob, format)
            .unwrap_or_else(|e| panic!("{format} failed to decode its own output: {e:?}"));

        assert_eq!(
            normalize(&back),
            want,
            "{format} round trip changed the graph",
        );
    }
}

#[test]
fn every_reject_row_is_refused_with_the_same_code_as_the_ts_engine() {
    let c = corpus();
    let rows = c["reject"].as_array().expect("reject is an array").clone();

    assert!(
        !rows.is_empty(),
        "the reject table is empty — nothing is being checked"
    );

    for row in rows {
        let format = row["format"].as_str().expect("format is a string");
        let input = row["input"].as_str().expect("input is a string");
        let code = row["code"].as_str().expect("code is a string");

        // NDJSON is the engine's own module and reports a `String`; the shared codecs report a
        // `CodecError` carrying the shared code. Both must refuse the row, and for a codec
        // error the CODE must match the one the TS engine raises (rule: assert the code, not
        // the message).
        if format == "ndjson" {
            assert!(
                ndjson::from_ndjson(input).is_err(),
                "ndjson accepted malformed input: {input}",
            );

            continue;
        }

        let got = codec::deserialize(input, format);

        assert!(got.is_err(), "{format} accepted malformed input: {input}",);

        let err = got.err().expect("checked above");

        assert_eq!(err.code, code, "wrong error code for {format} on {input}",);
    }
}
