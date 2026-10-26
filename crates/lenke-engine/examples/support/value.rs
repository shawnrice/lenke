//! Value-type cost — what a map/record property costs against the same fields as
//! flat scalar columns, stored and through the NDJSON codec. Consolidates the
//! retired `map_bench` and `map_codec_bench`.
//!
//! (Temporal-column cost — `temporal_bench` — needs host-side `Temporal`
//! construction; it is deferred rather than faked here. See examples/README.md.)
//!
//! Cases (filter with `-- <name>`):
//!   maps   — a scalar query (age filter) on a flat vs a map-carrying graph (the
//!            regression baseline: a map must not slow the scalar columns), and a
//!            dotted-path map-field query (`p.meta.city`).
//!   codec  — NDJSON decode + encode of a map graph vs the same fields flat: the
//!            map overhead in the codec.

use crate::harness::{best_ms, section, time_query, Cfg, DEFAULT_NODES};
use lenke_engine::ndjson::{from_ndjson, to_ndjson};

const CITIES: [&str; 4] = ["NYC", "LA", "SF", "CHI"];

fn flat_ndjson(n: usize) -> String {
    (0..n)
        .map(|i| {
            format!(
                r#"{{"type":"node","id":"v{i}","labels":["P"],"properties":{{"age":{},"city":"{}","tier":{}}}}}"#,
                i % 100,
                CITIES[i % 4],
                i % 3
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn map_ndjson(n: usize) -> String {
    (0..n)
        .map(|i| {
            format!(
                r#"{{"type":"node","id":"v{i}","labels":["P"],"properties":{{"age":{},"meta":{{"city":"{}","tier":{}}}}}}}"#,
                i % 100,
                CITIES[i % 4],
                i % 3
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn run(cfg: &Cfg) {
    // Decode is linear, so no cap is needed — a large BENCH_N just decodes more.
    let n = cfg.scale.unwrap_or(DEFAULT_NODES);

    if cfg.want("value/maps") {
        section("value/maps (scalar regression + map-field access)");
        let flat = from_ndjson(&flat_ndjson(n)).expect("decodes");
        let maps = from_ndjson(&map_ndjson(n)).expect("decodes");
        let scalar = "MATCH (p:P) WHERE p.age > 50 RETURN count(*) AS c";
        let field = "MATCH (p:P) WHERE p.meta.city = 'NYC' RETURN count(*) AS c";
        // The MATCHED flat comparison, added at audit item 359. Without it the only available
        // ratio was `map field meta.city` against `scalar age`, whose two sides differ in TWO
        // things — a dotted path AND string-vs-numeric — so the section invited a conclusion it
        // could not support. Measured, the string/numeric axis runs the OTHER way (a flat string
        // equality is FASTER than the numeric range, because it seeds an IndexSeek shape), so the
        // un-matched ratio understated the real nested-path penalty. One extra row makes the
        // comparison sound; a ratio is only as honest as the sameness of its two sides.
        let flat_str = "MATCH (p:P) WHERE p.city = 'NYC' RETURN count(*) AS c";
        // THE MISSING INDEXED ARMS, added at item 895. Every row above is the UNINDEXED path, and
        // the scan this section measures is explicitly the fallback twin of a dotted
        // `index_lookup` — so without an indexed arm the section cannot say whether the nested
        // penalty it reports is something a user should care about or something they should index
        // away. Item 877's lesson in a different key: a missing ROW is why a gap sits unmeasured.
        //
        // Both arms are indexed so the comparison stays matched (item 359's rule): a dotted index
        // against a FLAT index, not against an unindexed flat scan.
        let mut flat_ix = from_ndjson(&flat_ndjson(n)).expect("decodes");
        flat_ix.create_index("city");
        let mut maps_ix = from_ndjson(&map_ndjson(n)).expect("decodes");
        maps_ix.create_index("meta.city");
        println!("{:30} {:>10}", "query", "us");
        for (name, q, store) in [
            ("scalar age (flat)", scalar, &flat),
            ("scalar age (map graph)", scalar, &maps),
            ("string city (flat)", flat_str, &flat),
            ("map field meta.city", field, &maps),
            ("string city (flat, INDEXED)", flat_str, &flat_ix),
            ("map field meta.city (INDEXED)", field, &maps_ix),
        ] {
            match time_query(q, false, store, cfg.reps) {
                Ok((us, _)) => println!("{name:30} {us:>10.1}"),
                Err(e) => println!("{name:30} {:>10}  ({})", "n/a", e.trim()),
            }
        }
    }

    if cfg.want("value/codec") {
        section("value/codec (NDJSON round-trip: flat vs map)");
        println!(
            "{:22} {:>10} {:>10} {:>8}",
            "graph", "decode_ms", "encode_ms", "MiB"
        );
        for (name, text) in [
            ("flat scalars", flat_ndjson(n)),
            ("meta record", map_ndjson(n)),
        ] {
            let mib = text.len() as f64 / (1024.0 * 1024.0);
            let decode_ms = best_ms(cfg.reps, || from_ndjson(&text).expect("decodes"));
            let store = from_ndjson(&text).expect("decodes");
            let encode_ms = best_ms(cfg.reps, || to_ndjson(&store));
            println!("{name:22} {decode_ms:>10.2} {encode_ms:>10.2} {mib:>8.1}");
        }
    }
}
