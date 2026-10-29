//! What does a DATE-predicate count cost, and does item 1220's rewrite transfer to it? (item 1223)
//!
//! Item 1220 made `sweep_num_count` branchless and took every numeric filtered count 3.19x. Its
//! temporal twin `sweep_date_count` has SIX call sites (all six date compares) and still reads
//!
//! ```ignore
//! if present[i] {
//!     if let Temporal::Date(d) = &data[i] {
//!         if cmp(d.days) { count += 1; }
//!     }
//! }
//! ```
//!
//! Three nested branches, not one. The middle is an enum DISCRIMINANT test rather than a presence
//! bit, so item 1220's rewrite does NOT transfer unchanged and its 3.19x does not predict this.
//! That is the question.
//!
//! ⚠️ THIS PROBE EXISTS BECAUSE A DEFERRAL WAS STALE. `CLAUDE.md` lists "temporal-column cost needs
//! host `Temporal` construction" among the questions that cannot be asked from an example. It can:
//! `lib.rs` re-exports `lenke_engine_core::temporal`, `Temporal::Date` is a public variant and
//! `Date { days: i32 }` has a public field, so a date column builds from here in one line.
//!
//! SELECTIVITY ~41%, near the worst case for branch misprediction — the same reasoning as item
//! 1221's row pair. `days` spreads over 20,000 values from 10,000, and `DATE '2020-01-01'` is day
//! 18,262, so the predicate splits the fixture rather than selecting an extreme.
//!
//! CONTROLS, both in-process: the same count on a NUMERIC column, which goes through
//! `sweep_num_count` and not this function, and `count(*)` with no predicate. The numeric control is
//! the load-bearing one — `count(*)` is 0.3 us and a ratio against the timer's resolution means
//! nothing (item 1196).
//!
//!   cargo run --release --example date_count_probe
//!   LENKE_PROBE_ARM=1 cargo run --release --example date_count_probe   # which arm served it

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::temporal::{Date, Temporal};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

/// A homogeneous DATE column plus a numeric twin of the same selectivity, so the two arms are
/// compared on the same fixture and the same row count rather than across fixtures.
fn store_of(nodes: u32) -> Store {
    let mut b = Builder::default();

    for i in 0..nodes {
        let days = 10_000 + i32::try_from(i % 20_000).expect("fits i32");

        b.node(
            &["P"],
            &[
                ("d", Value::Temporal(Temporal::Date(Date { days }))),
                // The SAME threshold as a number, so the control answers the same row count: a
                // control that answers a different question measures a different question
                // (item 1203).
                ("k", Value::Num(f64::from(days))),
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
    // WHICH VARIANT MAKES THE ENUM 40 BYTES (item 1224). A sum type is as wide as its widest
    // member, so one oversized variant taxes every temporal column including a date-only one.
    {
        use lenke_engine::temporal::{DateTime, Duration, Time, ZonedDateTime, ZonedTime};
        use std::mem::size_of;

        println!(
            "  variants: Date {} | Time {} | DateTime {} | ZonedTime {} | ZonedDateTime {} | Duration {}",
            size_of::<Date>(),
            size_of::<Time>(),
            size_of::<DateTime>(),
            size_of::<ZonedTime>(),
            size_of::<ZonedDateTime>(),
            size_of::<Duration>()
        );
    }

    // THE COLUMN WIDTH, which is what item 1223 found the date path's remaining cost to be.
    println!(
        "  size_of::<Temporal>() = {} bytes, size_of::<f64>() = {}
",
        std::mem::size_of::<Temporal>(),
        std::mem::size_of::<f64>()
    );
    println!("  shape                                        us      rows  plan");

    for (what, q) in [
        (
            "date > DATE '2020-01-01' (~41%)",
            "MATCH (p:P) WHERE p.d > DATE '2020-01-01' RETURN count(*) AS c",
        ),
        (
            "date >= DATE '2020-01-01'",
            "MATCH (p:P) WHERE p.d >= DATE '2020-01-01' RETURN count(*) AS c",
        ),
        (
            "date = DATE '2020-01-01'",
            "MATCH (p:P) WHERE p.d = DATE '2020-01-01' RETURN count(*) AS c",
        ),
        (
            "[CTL] num k > 18262 (sweep_num_count)",
            "MATCH (p:P) WHERE p.k > 18262 RETURN count(*) AS c",
        ),
        (
            "[CTL] count(*), no predicate",
            "MATCH (p:P) RETURN count(*) AS c",
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
        "\n  The `>` date row and the numeric control must answer the SAME row count. If they\n  \
         differ, the two arms are not being asked the same question and the ratio is noise."
    );
}
