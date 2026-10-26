//! Item 925: WHAT, exactly, gets slower as a store churns? Item 818's open anomaly, diagnosed.
//!
//! Item 818 measured a native append+delete loop degrading **1.64x over a 12x batch budget, on the
//! INDEXED arm only**, refuted the obvious cause by reading (`index_drop_node` does remove the id
//! AND drop the empty key, item 367), and recorded a hypothesis rather than a measurement: the
//! structures that are never compacted — the `deleted` tombstone vector and every per-node property
//! column — grow one slot per INSERT forever, because node ids are never reused.
//!
//! That hypothesis is testable, and item 820 is the precedent for it paying off: pinning the LIVE
//! set and varying only the CHURN found a loop that was O(nodes ever created), at 14.9 us on a fresh
//! store against 377.7 us after 1,000,000 create-and-delete pairs. This probe asks whether anything
//! ELSE still scales that way.
//!
//! THE DESIGN, and its control is item 818's own discriminator. The live set is pinned at 20,000 and
//! only the churn varies, so a cost that rises is a cost in "nodes ever created" and not in graph
//! size. Then four operations are timed against the SAME churned store:
//!
//!   - `seek` — an INDEXED equality on a property. 818 says the degradation is index-specific, so
//!     this is the suspect.
//!   - `scan` — the same question with NO index, answered by walking a label bucket that delete
//!     keeps at ~1 entry. **This is the CONTROL**: 818's argument is that the seek path touches
//!     whatever grows and the tiny-bucket scan does not, so if BOTH rise the index is innocent and
//!     the cause is something every read pays.
//!   - `del`  — one delete, the operation item 820 found was churn-linear and fixed.
//!   - `ins`  — one insert, which 820 measured FLAT at 278-734 ns and which should stay flat.
//!
//! Reading it: `ins` flat and `del` flat means 820's fix still holds. `seek` rising with `scan` flat
//! localises 818 to the index; both rising localises it to per-node growth that every read pays.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

const LIVE: u32 = 20_000;
/// Enough probe operations that one timing is not a single sample.
const OPS: u32 = 2_000;

/// A store with `LIVE` live nodes, then `churn` create-and-delete pairs applied.
///
/// `indexed` decides whether the property the probes query carries a hash index — built BEFORE the
/// churn, so the churn maintains it, which is the arm 818 found degrading.
fn churned(churn: u32, indexed: bool) -> Store {
    let mut b = Builder::default();

    for i in 0..LIVE {
        b.node(
            &["User"],
            &[
                ("name", Value::Str(format!("u{i}").into())),
                ("age", Value::Num(f64::from(i % 90))),
            ],
        );
    }

    let mut st = b.build();

    if indexed {
        st.create_index("name");
    }

    // Create and immediately delete, so the LIVE set never changes but the id space grows.
    for c in 0..churn {
        let id = st.add_node(
            &["Tmp"],
            &[
                ("name", Value::Str(format!("t{c}").into())),
                ("age", Value::Num(f64::from(c % 90))),
            ],
        );

        st.delete_node(id);
    }

    st
}

/// Min-of-3 nanoseconds per operation for a closure run `OPS` times.
fn per_op(mut f: impl FnMut(&mut Store), st: &mut Store) -> f64 {
    let mut best = f64::MAX;

    for _ in 0..3 {
        let t = Instant::now();

        for _ in 0..OPS {
            f(st);
        }

        best = best.min(t.elapsed().as_secs_f64() * 1e9 / f64::from(OPS));
    }

    best
}

fn main() {
    println!(
        "item 925 - what scales with CHURN? live set pinned at {LIVE}, {OPS} ops per timing, min of 3"
    );
    println!("  churn      seek(indexed)    scan(CONTROL, no index)     del        ins");

    for churn in [0u32, 100_000, 300_000, 1_000_000] {
        // SEEK arm: the indexed property, which is the arm item 818 found degrading.
        let mut si = churned(churn, true);
        let seek = per_op(
            |s| {
                let hit = s
                    .index_lookup("name", &Value::Str("u1234".into()))
                    .map_or(0, |ids| ids.len());

                assert!(
                    hit == 1,
                    "the indexed name must resolve to exactly one live node"
                );
            },
            &mut si,
        );

        // CONTROL arm: the same question with no index to seek, so it walks instead.
        let mut sc = churned(churn, false);
        let scan = per_op(
            |s| {
                let n = s.nodes_with_label("User").len();

                assert!(n as u32 == LIVE, "the live set must be pinned");
            },
            &mut sc,
        );

        // One delete and one insert on the churned store, the two operations item 820 measured.
        let mut sd = churned(churn, true);
        let mut next = 0u32;
        let del = per_op(
            |s| {
                let id = s.add_node(&["Tmp"], &[("age", Value::Num(1.0))]);

                s.delete_node(id);
                next += 1;
            },
            &mut sd,
        );
        let ins = per_op(
            |s| {
                s.add_node(&["Tmp2"], &[("age", Value::Num(1.0))]);
            },
            &mut sd,
        );

        println!(
            "  {churn:>8}   {seek:>9.1} ns      {scan:>9.1} ns          {del:>8.1}  {ins:>8.1}"
        );
    }

    println!(
        "\n  seek RISING with scan FLAT  -> item 818 is index-specific, as it claims.\n  \
         BOTH rising                 -> the cause is per-node growth every read pays, and the\n  \
                                        index is innocent.\n  \
         del or ins rising           -> a churn-linear write cost survived item 820."
    );
}
