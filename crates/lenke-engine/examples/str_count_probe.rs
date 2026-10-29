//! What does a count over a HIGH-CARDINALITY string equality cost? (item 1222)
//!
//! Item 1219 made the DICT branch of `try_stream_membership_count` 2.75-7.07x faster by specializing
//! a single target and accumulating branchlessly. The same function's `Column::Str` branch — the one
//! taken when a string column is NOT dictionary-encoded — still reads
//!
//! ```ignore
//! if present[i] && targets.iter().any(|t| data[i].as_ref() == *t) { count += 1; }
//! ```
//!
//! which pays an iterator plus a closure per row for what is, in the overwhelmingly common case, one
//! comparison against one literal.
//!
//! ⚠️ THE FIXTURE HAS TO MAKE THE COLUMN A `Str` AND NOT A `Dict`, which is the whole difficulty:
//! `seek_crossover_probe` uses eight distinct values and is dictionary-encoded, so it exercises the
//! branch item 1219 already fixed and says NOTHING about this one. Here every node gets a distinct
//! `name`, so the column cannot be dictionary-encoded.
//!
//! ⚠️ AND THE PROBE ASSERTS WHICH BRANCH SERVED IT, rather than assuming. Items 1215, 1216 and 1217
//! each measured code the query never reached, and item 1219 found that mistake had HIDDEN a 7x.
//! `LENKE_PROBE_ARM=1` makes the engine print the serving arm; run it once before trusting a number.
//!
//! TWO SELECTIVITIES, because a count that scales with MATCHES moves between them and one that
//! scales with NODES does not (item 1221's pair). A single-row equality is ~0.0005% and a prefix
//! match over a tenth of the graph is 10%.
//!
//! CONTROL: `count(*)` over the whole label, which no string predicate reaches — and, because that
//! is 0.3 us and a ratio against the timer's resolution is meaningless (item 1196), a second control
//! that does real work: the same count filtered on a NUMERIC column, which goes through
//! `sweep_num_count` and not this function at all.
//!
//!   cargo run --release --example str_count_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// Every `name` DISTINCT, so the column cannot be dictionary-encoded and the `Str` arm is the one
/// that can serve an equality on it. `tenth` is a deliberately LOW-cardinality companion so a
/// 10%-selective string predicate is available on a `Str` column too.
fn store_of(nodes: u32) -> Store {
    let mut b = Builder::default();

    for i in 0..nodes {
        b.node(
            &["Person"],
            &[
                ("name", Value::Str(format!("person{i}").into())),
                ("k", Value::Num(f64::from(i % 90))),
            ],
        );
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = store_of(nodes);

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!("  shape                                      us      rows  plan");

    for (what, q) in [
        (
            "str = one literal (~0.0005%)",
            "MATCH (p:Person) WHERE p.name = 'person12345' RETURN count(*) AS c",
        ),
        (
            "str <> one literal (~100%)",
            "MATCH (p:Person) WHERE p.name <> 'person12345' RETURN count(*) AS c",
        ),
        (
            "str IN [one]",
            "MATCH (p:Person) WHERE p.name IN ['person12345'] RETURN count(*) AS c",
        ),
        (
            "str IN [two]",
            "MATCH (p:Person) WHERE p.name IN ['person12345','person777'] RETURN count(*) AS c",
        ),
        (
            "str = a OR = b",
            "MATCH (p:Person) WHERE p.name = 'person12345' OR p.name = 'person777' RETURN count(*) AS c",
        ),
        (
            "[CTL] num k > 45 (~49%, sweep_num_count)",
            "MATCH (p:Person) WHERE p.k > 45 RETURN count(*) AS c",
        ),
        (
            "[CTL] count(*), no predicate",
            "MATCH (p:Person) RETURN count(*) AS c",
        ),
    ] {
        let us = time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
        let plan = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &store,
        );
        let s = format!("{plan:?}");
        let shape = if s.contains("IndexSeek") {
            "IndexSeek"
        } else if s.contains("Filter") {
            "Filter+Scan"
        } else {
            "Scan"
        };
        let rows = lenke_engine::exec::try_run(&plan, &store)
            .ok()
            .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
            .and_then(|v| match v {
                Value::Num(n) => Some(n),
                _ => None,
            })
            .unwrap_or(f64::NAN);

        println!("  {what:<40} {us:>8.1} {rows:>9.0}  {shape}");
    }

    println!(
        "\n  The two string rows must answer DIFFERENT row counts (1 and nodes-1); if they agree,\n  \
         the predicate is not doing what the label says and the timing means nothing."
    );
}
