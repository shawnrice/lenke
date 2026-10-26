//! Item 895: WHY is a query with an index on a dotted key SLOWER than the same query without one?
//!
//! `value/maps` gained indexed arms (this item) and they read:
//!
//!     string city (flat)                   253.9 us
//!     map field meta.city                 2594.8
//!     string city (flat, INDEXED)          306.0      <- 1.2x SLOWER with the index
//!     map field meta.city (INDEXED)      10699.5      <- 4.1x SLOWER with the index
//!
//! Creating an index makes both queries slower, which is worth a plan before a theory. This probe
//! prints whether an `IndexSeek` survives optimization, plus the index's own distinct count.
//!
//! THE ANSWER, and it is not a planner bug: with 4 distinct cities over 200k nodes the predicate
//! matches ~25% of rows, well above the 15% `SEEK_MAX_FRACTION` cap, so `seek_beats_scan`
//! correctly REJECTS the seek. Without an index the plan keeps an `IndexSeek` node that executes
//! as the no-index fallback filter — the path items 359/893/894 optimized. With an index it
//! becomes `Scan` + `Filter`, a DIFFERENT evaluator, and that one is slower.
//!
//! So the engine has two unindexed paths for one predicate and the cost model picks between them
//! on seek-vs-scan grounds while they differ by 4.1x on grounds it does not model. Item 894's
//! 1.65x on the fallback WIDENED this gap.
use lenke_engine::ndjson::from_ndjson;

const CITIES: [&str; 4] = ["NYC", "LDN", "TYO", "BER"];

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

fn main() {
    let n: usize = std::env::var("N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000);

    let dotted = "MATCH (p:P) WHERE p.meta.city = 'NYC' RETURN count(*) AS c";
    let flat = "MATCH (p:P) WHERE p.city = 'NYC' RETURN count(*) AS c";

    for (label, q, make, key) in [
        ("dotted", dotted, true, "meta.city"),
        ("flat", flat, false, "city"),
    ] {
        let nd = if make { map_ndjson(n) } else { flat_ndjson(n) };
        let plain = from_ndjson(&nd).expect("decodes");
        let mut indexed = from_ndjson(&nd).expect("decodes");
        indexed.create_index(key);

        for (which, store) in [("no index", &plain), ("indexed ", &indexed)] {
            let plan =
                lenke_engine::opt::optimize_indexed(lenke_engine::gql::parse(q).unwrap(), store);
            // The plan's Debug rendering is what tells us whether an IndexSeek was seeded.
            let rendered = format!("{plan:?}");
            let seeks = rendered.matches("IndexSeek").count();
            println!(
                "{label:7} {which}  IndexSeek x{seeks}  has_hash_index={}  distinct={:?}",
                store.has_hash_index(key),
                store.index_distinct_count(key),
            );
        }
        println!();
    }
}
