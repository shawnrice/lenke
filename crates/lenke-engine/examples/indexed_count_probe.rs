//! What does `count(*)` over an INDEXED equality cost? (item 1217)
//!
//! Item 1216 located the dict-equality row as an `IndexSeek` and priced a missing `count(*)` arm at
//! ~600x. Building it revealed the rest of the story: `index_seek_count` returned `None` on every
//! call, because the census probe's fixture has NO INDEX AT ALL — `optimize_indexed` plans an
//! `IndexSeek` for an equality regardless, and `index_seek_ids` then degrades to a label scan
//! (its third arm). So that row's 187-304 µs was never an index lookup, and the new arm was
//! unmeasured.
//!
//! ⚠️ THIS IS THE FIXTURE THAT EXERCISES IT, and the reason the probe exists rather than the arm
//! being trusted: a fix that never runs and a fix that does nothing are indistinguishable from a
//! flat measurement (items 1215 and 1216 are both that mistake). Here the index is CREATED, so the
//! hash arm is reached and `count(*)` can be answered from the bucket's length.
//!
//! THE FLOOR is `count(*)` over the whole label — 0.3 µs, O(1) off the label bucket — and the
//! REFERENCE is the same equality PROJECTED, which must still materialize the ids and so cannot
//! benefit. If the count collapses toward the floor while the projection does not move, the arm is
//! doing exactly what it claims and nothing else.
//!
//!   cargo run --release --example indexed_count_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

fn store_of(nodes: u32, indexed: bool) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for _ in 0..nodes {
        let v = rng.next(100);

        b.node(
            &["Person"],
            &[
                ("d", Value::Str(format!("g{}", v % 8).into())),
                ("k", Value::Num(f64::from(v))),
            ],
        );
    }

    let mut store = b.build();

    if indexed {
        store.create_index("d");
    }

    store
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!("  shape                                  no index   indexed    ratio   answer");

    let plain = store_of(nodes, false);
    let indexed = store_of(nodes, true);

    for (label, q) in [
        (
            "count(*) WHERE d = 'g3'",
            "MATCH (p:Person) WHERE p.d = 'g3' RETURN count(*) AS c",
        ),
        // The REFERENCE: the same equality projected still needs the ids, so an index helps it
        // only by narrowing the scan — it cannot become a length.
        (
            "project   WHERE d = 'g3'",
            "MATCH (p:Person) WHERE p.d = 'g3' RETURN p.k AS x",
        ),
        // CONTROLS the index cannot reach: a count over the whole label (the floor), and an
        // equality on a DIFFERENT, unindexed key.
        (
            "[CTL] count(*), no predicate",
            "MATCH (p:Person) RETURN count(*) AS c",
        ),
        (
            "[CTL] count(*) WHERE k = 3",
            "MATCH (p:Person) WHERE p.k = 3 RETURN count(*) AS c",
        ),
    ] {
        let ask = |store: &Store| -> (f64, String) {
            let us = time_query(q, false, store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
            let plan = lenke_engine::opt::optimize_indexed(
                lenke_engine::gql::parse(q).expect("parses"),
                store,
            );
            let rows = lenke_engine::exec::try_run(&plan, store).map_or(0, |r| r.rows.len());

            (us, format!("{rows} row(s)"))
        };
        let (a, _) = ask(&plain);
        let (b, answer) = ask(&indexed);

        println!("  {label:<36} {a:>9.1} {b:>9.1} {:>8.2}x   {answer}", a / b);
    }

    println!(
        "\n  The count collapsing while the projection does NOT is the arm working: a count can be\n  \
         a bucket length, a projection still needs every id."
    );
}
