//! Does `min`/`max` cost the same over every COLUMN TYPE? (item 1172)
//!
//! Item 1161 made the numeric extremum 3.8-4.2x faster, which raises the obvious next question:
//! `min` reads a column, and the store has SIX column representations, so the question is whether
//! the fast path covers all of them or only the one that got attention.
//!
//! Reading first found THREE dedicated entries — `try_scan_num_agg` (Num), `try_scan_str_agg`
//! (Str), `try_scan_temporal_agg` (Temporal) — so this is NOT a case of one variant served and the
//! rest abandoned. But three entries for six representations still leaves `Dict`, `Bool` and `Gen`
//! unaccounted for, and reading five functions to find out which of them some arm happens to admit
//! is slower and less reliable than asking the engine. Measuring also catches the case a gate
//! admits but serves badly, which reading cannot.
//!
//! ONE COLUMN PER REPRESENTATION, all on the same nodes so the row count and the scan are shared
//! and only the representation differs:
//!
//!   num       Column::Num        the arm item 1161 optimized — the reference
//!   str       Column::Str        high-cardinality strings (a unique value per node)
//!   dict      Column::Dict       low-cardinality strings (8 distinct), so it dictionary-encodes
//!   bool      Column::Bool
//!   date      Column::Temporal
//!   mixed     Column::Gen        a type per node, which de-opts the column
//!
//! `count(*)` is the control no column fold can reach, and `count(<key>)` is the second control:
//! it reads only the presence mask, so it should cost the same for EVERY representation. A
//! representation where `count` is flat but `min` is slow has a fold problem; one where both are
//! slow has a column problem.
//!
//!   cargo run --release --example minmax_coltype_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

fn store_of(nodes: u32) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        let n = rng.next(1_000_000);
        // `mixed` carries a DIFFERENT type per node, which is what forces `Column::Gen`.
        let mixed = match i % 3 {
            0 => Value::Num(f64::from(n)),
            1 => Value::Str(format!("s{n}").into()),
            _ => Value::Bool(n.is_multiple_of(2)),
        };

        b.node(
            &["Person"],
            &[
                ("num", Value::Num(f64::from(n))),
                ("str", Value::Str(format!("u{i:08}").into())),
                // EIGHT distinct values over 200,000 nodes, so this dictionary-encodes.
                ("dict", Value::Str(format!("g{}", n % 8).into())),
                ("bool", Value::Bool(n.is_multiple_of(2))),
                ("date", Value::Num(f64::from(n % 30_000))),
                ("mixed", mixed),
            ],
        );
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = store_of(nodes);

    println!(
        "\n# {nodes} nodes, one column per representation, min of {}\n",
        cfg.reps
    );
    println!("  column         min(us)     max(us)   count(k)(us)      answer of min");

    for key in ["num", "str", "dict", "bool", "date", "mixed"] {
        let ask = |agg: &str| -> (f64, String) {
            let q = format!("MATCH (a:Person) RETURN {agg}(a.{key}) AS c");

            match time_query(&q, false, &store, cfg.reps) {
                Ok((us, _)) => {
                    let plan = lenke_engine::opt::optimize_indexed(
                        lenke_engine::gql::parse(&q).expect("parses"),
                        &store,
                    );
                    let answer = lenke_engine::exec::try_run(&plan, &store)
                        .ok()
                        .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
                        .map_or_else(|| "<none>".to_string(), |v| format!("{v:?}"));

                    (us, answer)
                }
                Err(e) => (f64::NAN, format!("ERR {e}")),
            }
        };

        let (mn, answer) = ask("min");
        let (mx, _) = ask("max");
        let (cnt, _) = ask("count");
        let short = if answer.len() > 26 {
            format!("{}...", &answer[..23])
        } else {
            answer
        };

        println!("  {key:<10} {mn:>10.1} {mx:>11.1} {cnt:>12.1}      {short}");
    }

    // THE SORT/TOP-K SIBLING of the same enum (item 1175). `exec/order.rs` mentions `Column::Num`,
    // `Dict` and `Temporal` twice each and `Str` once, and `Column::Bool` NOT AT ALL — the same
    // hole item 1172 closed in the extremum dispatch, one function over. Item 864's
    // `try_scan_top_k_wide` claims to serve "every other representation", so whether that is a
    // real gap is a measurement and not a reading.
    //
    // `ORDER BY … LIMIT 10` is the shape with a dedicated path; the floor is the same `count(k)`
    // column above, and `ORDER BY` with NO limit is the second control — it cannot take a top-k
    // path at all, so it should be flat across representations in a way the limited form need not.
    println!();
    println!("  column       top-k(us)   order-all(us)      first value");

    for key in ["num", "str", "dict", "bool", "date", "mixed"] {
        let ask = |q: &str| -> (f64, String) {
            match time_query(q, false, &store, cfg.reps) {
                Ok((us, _)) => {
                    let plan = lenke_engine::opt::optimize_indexed(
                        lenke_engine::gql::parse(q).expect("parses"),
                        &store,
                    );
                    let first = lenke_engine::exec::try_run(&plan, &store)
                        .ok()
                        .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
                        .map_or_else(|| "<none>".to_string(), |v| format!("{v:?}"));

                    (us, first)
                }
                Err(e) => (f64::NAN, format!("ERR {e}")),
            }
        };

        let (topk, first) = ask(&format!(
            "MATCH (a:Person) RETURN a.{key} AS v ORDER BY a.{key} LIMIT 10"
        ));
        let (all, _) = ask(&format!(
            "MATCH (a:Person) RETURN a.{key} AS v ORDER BY a.{key}"
        ));
        let short = if first.len() > 22 {
            format!("{}...", &first[..19])
        } else {
            first
        };

        println!("  {key:<10} {topk:>10.1} {all:>15.1}      {short}");
    }

    println!();

    match time_query(
        "MATCH (a:Person) RETURN count(*) AS c",
        false,
        &store,
        cfg.reps,
    ) {
        Ok((us, _)) => println!(
            "  {:<10} {us:>10.1}   [the control no column fold reaches]",
            "count(*)"
        ),
        Err(e) => println!("  count(*)   ERR {e}"),
    }
}
