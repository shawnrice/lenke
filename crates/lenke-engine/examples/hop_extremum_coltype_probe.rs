//! Does `min`/`max` over a HOP's far endpoint cost the same for every COLUMN TYPE? (item 1182)
//!
//! Item 1172 found the SCAN extremum served `Num`, `Str` and `Temporal` and not `Bool`, and item
//! 1175 found the same hole in the top-K dispatch one function over. "Grep the pattern elsewhere"
//! one level further is the FRONTIER family — the same aggregate over a traversal's endpoints
//! rather than a bare scan — and reading it first says the hole there is wider:
//!
//! ```text
//!   try_frontier_prop_agg   Column::Num 1    Str 0   Dict 0   Bool 0   Temporal 0   Gen 0
//! ```
//!
//! So FIVE of six representations have no arm, against the scan path's one. `min(b.name)` over a
//! hop is an ordinary question — the earliest hire among a person's reports, the lowest grade among
//! a batch — so this is not an exotic shape.
//!
//! ONE COLUMN PER REPRESENTATION on the same nodes, reached through the same hop, so only the
//! representation differs. Two controls:
//!
//!   count(<key>) over the hop  — reads only the presence mask, so it is each representation's
//!                                OWN floor; flat here means the walk is not the variable
//!   min over the SCAN          — the path items 1172/1175 already fixed, as the reference for
//!                                what "served" costs
//!
//!   cargo run --release --example hop_extremum_coltype_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

fn store_of(nodes: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        let n = rng.next(1_000_000);
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
                // EIGHT distinct values, so this dictionary-encodes.
                ("dict", Value::Str(format!("g{}", n % 8).into())),
                ("bool", Value::Bool(n.is_multiple_of(2))),
                ("mixed", mixed),
            ],
        );
    }

    for i in 0..nodes {
        for _ in 0..deg {
            b.edge(i, rng.next(nodes), "KNOWS");
        }
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let deg: u32 = std::env::var("PROBE_DEG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    let store = store_of(nodes, deg);

    println!(
        "\n# {nodes} nodes / degree {deg}, one column per representation, min of {}\n",
        cfg.reps
    );
    println!("  column      hop min(us)   hop count(us)   scan min(us)       answer of hop min");

    for key in ["num", "str", "dict", "bool", "mixed"] {
        let ask = |q: &str| -> (f64, String) {
            match time_query(q, false, &store, cfg.reps) {
                Ok((us, _)) => {
                    let plan = lenke_engine::opt::optimize_indexed(
                        lenke_engine::gql::parse(q).expect("parses"),
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

        let (hop_min, answer) = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN min(b.{key}) AS c"
        ));
        let (hop_cnt, _) = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(b.{key}) AS c"
        ));
        let (scan_min, _) = ask(&format!("MATCH (a:Person) RETURN min(a.{key}) AS c"));
        let short = if answer.len() > 22 {
            format!("{}...", &answer[..19])
        } else {
            answer
        };

        println!("  {key:<10} {hop_min:>11.1} {hop_cnt:>15.1} {scan_min:>14.1}       {short}");
    }

    // THE MULTI-AGGREGATE SIBLING (item 1184). `try_frontier_multi_agg` serves TWO OR MORE
    // scalar aggregates over one frontier and admits `count`/`min`/`max` — but its `MinMax` spec
    // destructures `Column::Num` exactly as the single-aggregate path did before item 1182, so
    // the same hole should be here one function over. Unlike that path it declines `Plan::Scan`
    // outright, so there is no bare-scan case to steal and no ordering question.
    //
    // `count(*), count(b.k)` is the control: BOTH are served for every representation (a count
    // folds the present mask, item 376), so that row prices the two-aggregate machinery itself
    // and must be flat across types. A representation where the count pair is flat but the
    // min/max pair is slow has the `MinMax` hole; one where both are slow has something else.
    println!();
    println!("  column      min+max(us)   cnt*+cnt(k)(us)   min+max ÷ counts");

    for key in ["num", "str", "dict", "bool", "mixed"] {
        let ask = |q: &str| -> f64 {
            time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us)
        };

        let pair = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN min(b.{key}) AS lo, max(b.{key}) AS hi"
        ));
        let ctl = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS n, count(b.{key}) AS c"
        ));

        println!("  {key:<10} {pair:>11.1} {ctl:>17.1} {:>17.2}x", pair / ctl);
    }

    // THE TOP-K SIBLING, which has NO hop entry at all (item 1185). Every top-K fast path in
    // `exec/order.rs` is a `try_scan_top_k*` requiring `Plan::Scan`, so `ORDER BY <hop prop>
    // LIMIT k` materializes every PATH and sorts it. Items 1175/1180 fixed the scan spelling of
    // this question; the hop spelling was never asked.
    //
    // NOTE the collapse that paid for items 1182/1184 is NOT available here: `min`/`max` ignore
    // multiplicity, but an ORDERED WINDOW does not — a node reached by two paths contributes two
    // rows. So any win must come from a bounded heap over the walk, not from deduplicating it.
    //
    // FLOOR: `count(b.k)` over the same hop, NOT `count(*)` — item 1183 found `count(*)` over a
    // hop is answered by a closed form (a degree sum) and so cannot floor anything that walks.
    // CONTROL: the same `ORDER BY` with NO limit, which no top-K path can take, so it should be
    // flat whatever happens to the limited form.
    println!();
    println!("  column     top-k(us)   order-all(us)   count(k)(us)   top-k ÷ floor");

    for key in ["num", "str", "dict", "bool", "mixed"] {
        let ask = |q: &str| -> f64 {
            time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us)
        };

        // ASSERT THE ANSWER, not just the time. The first version of this table timed only, and
        // item 1185's emission loop emitted HALF the window — a bug the corpus caught and this
        // probe could not have, while sitting directly on the row it was measuring. A perf probe
        // that cannot see a wrong answer will happily report a speedup for one.
        let check = |q: &str, want: usize| {
            let plan = lenke_engine::opt::optimize_indexed(
                lenke_engine::gql::parse(q).expect("parses"),
                &store,
            );
            let got = lenke_engine::exec::try_run(&plan, &store).map_or(0, |r| r.rows.len());
            assert!(got == want, "{q}\n  returned {got} rows, want {want}");
        };

        check(
            &format!("MATCH (a:Person)-[:KNOWS]->(b) RETURN b.{key} AS v ORDER BY v LIMIT 10"),
            10,
        );
        check(
            &format!("MATCH (a:Person)-[:KNOWS]->(b) RETURN b.{key} AS v ORDER BY v DESC LIMIT 2"),
            2,
        );

        let topk = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN b.{key} AS v ORDER BY v LIMIT 10"
        ));
        let all = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN b.{key} AS v ORDER BY v"
        ));
        let floor = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(b.{key}) AS c"
        ));

        println!(
            "  {key:<10} {topk:>9.1} {all:>15.1} {floor:>14.1} {:>15.2}x",
            topk / floor
        );
    }

    // THE FUSED FILTERED-HOP AGGREGATE (item 1190). `try_fused_hop_mask_agg` serves
    // `count(*)`/`sum`/`min`/`max` over `Filter(<endpoint pred>, Expand(Scan))` for predicates the
    // inline numeric count cannot take — an OR, a mixed-key disjunction, a string search — and
    // destructures `Column::Num` alone.
    //
    // ⚠️ IT IS THE SAME STRUCTURAL FAMILY AS ITEM 1189 (a FILTERED shape), where the filter's own
    // cost left only ~1.3-1.7x. So the floor is chosen FIRST this time, which is the lesson from
    // 1187 and 1189 both: `count(*)` over the IDENTICAL filtered hop — same walk, same mask, no
    // value read. `count(*)` reads no column at all, so unlike `count(<key>)` it cannot be
    // unserved for the representations under test.
    //
    // The predicate is held FIXED on `num` while the aggregate's column varies, so the only thing
    // changing between rows is the fold.
    println!();
    println!("  column   filtered min(us)   count(*) floor(us)   ÷ floor");

    const PRED: &str = "WHERE b.num > 500000 OR b.num < 100";

    for key in ["num", "str", "dict", "bool", "mixed"] {
        let ask = |q: &str| -> f64 {
            time_query(q, false, &store, cfg.reps).map_or(f64::NAN, |(us, _)| us)
        };
        let filtered = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) {PRED} RETURN min(b.{key}) AS c"
        ));
        let floor = ask(&format!(
            "MATCH (a:Person)-[:KNOWS]->(b) {PRED} RETURN count(*) AS c"
        ));

        println!(
            "  {key:<10} {filtered:>13.1} {floor:>19.1} {:>11.2}x",
            filtered / floor
        );
    }
}
