//! Does `opt::mark` reach a `RepeatGroup`, and what does `CountOnly` save there? (item 1235)
//!
//! `ShortestPath` and `VarLength` have carried `PathNeed` since the `CountOnly` rewrite;
//! `RepeatGroup` did not, so `exec` passed a hardcoded `PathNeed::Full` and copied every chain out
//! even for `RETURN path_length(p)`. It routes through the SAME `var_length` walker, which already
//! honours the flag, so the field was the only thing missing.
//!
//! ⚠️ THE PLAN IS DUMPED BEFORE ANY TIME IS READ. Items 1215-1217 each measured code the query
//! never reached, and item 1219 found that mistake had HIDDEN a 7x; a marking rewrite is exactly
//! the kind that can silently not fire, because nothing about the ANSWER changes when it does not.
//! If the dump does not say `CountOnly`, the timings below are measuring nothing.
//!
//! CONTROLS the marking cannot reach: the same group with its lists READ (`size(b)`), which needs
//! `Full`; and a bare var-length hop, which was already marked before this change.
//!
//!   cargo run --release --example repeat_group_pathneed_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::Store;

use support::{time_query, Cfg};

fn plan_of(q: &str, store: &Store) -> String {
    let plan =
        lenke_engine::opt::optimize_indexed(lenke_engine::gql::parse(q).expect("parses"), store);
    format!("{plan:?}")
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(20_000) as u32;
    let store = support::social_store(nodes, 3);

    println!("\n# {nodes} nodes, degree 3, min of {} reps\n", cfg.reps);

    let cases = [
        (
            "repeat-group + path",
            "MATCH p = ((a)-[:KNOWS]->(b)){1,2} RETURN path_length(p) AS len",
        ),
        (
            "[CTL] repeat-group, lists READ",
            "MATCH ((a)-[:KNOWS]->(b)){1,2} RETURN size(b) AS k",
        ),
        (
            "nested group + path (item 1236 question)",
            "MATCH p = ((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){1,2} RETURN path_length(p) AS len",
        ),
        (
            "[CTL] varlen + path (marked before this change)",
            "MATCH p = (x:Person)-[:KNOWS]->{1,2}(y) RETURN path_length(p) AS len",
        ),
    ];

    println!("  --- REACH: does the plan carry CountOnly? ---");
    for (what, q) in cases {
        let s = plan_of(q, &store);
        let marked = if s.contains("path_need: CountOnly") {
            "CountOnly"
        } else if s.contains("path_need: Full") {
            "Full"
        } else {
            "no path_need in plan"
        };
        // ⚠️ NAME EVERY path-producing operator, not two of them. The first version of this
        // classifier knew only RepeatGroup and VarLength, so a NestedGroup printed as "other" —
        // which reads as "no operator" rather than "an operator I did not list". Item 1218 lost a
        // tick to a column whose label had stopped being true.
        let op = [
            "RepeatGroup",
            "NestedGroup",
            "VarLength",
            "ShortestPath",
            "Trail",
        ]
        .iter()
        .find(|n| s.contains(**n))
        .copied()
        .unwrap_or("none of the known producers");

        println!("  {what:<48} {op:<12} {marked}");

        // ⚠️ THE PLAN SHAPE AND A SAMPLE VALUE, because `nested.rs` contains no `Lineage` at all:
        // either the path is built somewhere else, or `path_length(p)` is answering with nulls and
        // the question is a CONFORMANCE one rather than a performance one. A substring search for
        // an operator name cannot tell those apart.
        if std::env::var_os("PROBE_PLAN").is_some() {
            println!("      plan: {}", &s[..s.len().min(260)]);
        }
    }

    println!("\n  --- COST ---");
    println!("  shape                                                us       rows");
    for (what, q) in cases {
        let us = time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
        let rows = lenke_engine::exec::try_run(
            &lenke_engine::opt::optimize_indexed(
                lenke_engine::gql::parse(q).expect("parses"),
                &store,
            ),
            &store,
        )
        .map_or(0, |r| r.rows.len());

        println!("  {what:<48} {us:>10.1} {rows:>10}");
    }

    println!(
        "\n  The row counts must be IDENTICAL to the pre-change build — `CountOnly` suppresses the\n  \
         chain COPY, never a row."
    );
}
