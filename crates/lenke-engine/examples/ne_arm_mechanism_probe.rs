//! Is the `ne` arm's 2.3-3.2x periodic-vs-random MISPREDICTION or GATHER LOCALITY? (item 1229)
//!
//! Item 1228 found `projection, THREE bounds` at 508.6 us periodic against 1177.4 random (2.30x)
//! and `sum, THREE bounds` at 272.3 against 863.5 (3.17x), while `count, THREE bounds` was flat.
//! It recorded that as "the misprediction signature". THAT ATTRIBUTION IS UNVERIFIED, and there is
//! a second explanation that fits the same three numbers:
//!
//!   - MISPREDICTION: the exclusion arm's closure is `v >= lo && v <= hi && v != x`, and a random
//!     column makes the branch unpredictable where a periodic one does not.
//!   - GATHER LOCALITY: with `k = i % 100`, the rows passing `k > 50 AND k < 100` form long
//!     CONTIGUOUS runs of ids, so everything downstream reads `data[id]` sequentially. With random
//!     values the kept ids are scattered and the same reads become a random gather.
//!
//! The three rows cannot separate those, because the flat COUNT does not discriminate: item 1213
//! gave it a two-pass trick (a range count minus the excluded value's count), so it runs NO branchy
//! predicate AND does no gather. It is flat for two reasons at once.
//!
//! ⚠️ THE DISCRIMINATOR IS A COUNT WITH **TWO** EXCLUSIONS. Item 1213's trick handles exactly one,
//! so `<> a AND <> b` falls to the general branchy arm — a branchy predicate with NO gather and no
//! materialization. Then:
//!
//!   two-exclusion count data-dependent  -> MISPREDICTION is real
//!   two-exclusion count FLAT            -> the 2.3-3.2x is GATHER LOCALITY, and item 1228's
//!                                          attribution needs correcting
//!
//! Both fixtures are the same generator with the same value RANGE and the same selectivity; only
//! the ORDER of the column's values differs, which is the one variable this question turns on.
//!
//!   cargo run --release --example ne_arm_mechanism_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

fn store_of(nodes: u32, periodic: bool) -> Store {
    let mut b = Builder::default();
    let mut vals = support::Lcg::seeded();

    for i in 0..nodes {
        let k = if periodic { i % 100 } else { vals.next(100) };

        b.node(&["Person"], &[("k", Value::Num(f64::from(k)))]);
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let periodic = store_of(nodes, true);
    let random = store_of(nodes, false);

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!(
        "  shape                                        periodic     random    ratio     rows"
    );

    for (what, q) in [
        // THE DISCRIMINATOR: a branchy predicate, no gather, no materialization.
        (
            "count, TWO exclusions [branchy, NO gather]",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 AND p.k <> 74 RETURN count(*) AS c",
        ),
        // ONE exclusion: item 1213's two-pass trick, so neither branchy nor gathering.
        (
            "count, ONE exclusion [1213 two-pass]",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 RETURN count(*) AS c",
        ),
        // The two rows item 1228 measured, for continuity.
        (
            "sum, ONE exclusion [gathers]",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 RETURN sum(p.k) AS s",
        ),
        (
            "projection, ONE exclusion [gathers]",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 AND p.k <> 73 RETURN p.k AS x",
        ),
        // A GATHER WITH NO EXCLUSION AT ALL: if this is data-dependent too, the exclusion is not
        // what matters and gather locality is the whole story.
        (
            "projection, range only [gathers, no ne]",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 RETURN p.k AS x",
        ),
        (
            "sum, range only [gathers, no ne]",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 RETURN sum(p.k) AS s",
        ),
        // CONTROLS: no filter at all, so neither mechanism applies.
        (
            "[CTL] unfiltered count",
            "MATCH (p:Person) RETURN count(*) AS c",
        ),
        (
            "[CTL] unfiltered projection",
            "MATCH (p:Person) RETURN p.k AS x",
        ),
    ] {
        let ask = |store: &Store| -> (f64, usize) {
            let us = time_query(q, false, store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
            let rows = lenke_engine::exec::try_run(
                &lenke_engine::opt::optimize_indexed(
                    lenke_engine::gql::parse(q).expect("parses"),
                    store,
                ),
                store,
            )
            .map_or(0, |r| r.rows.len());

            (us, rows)
        };
        let (a, ra) = ask(&periodic);
        let (b, rb) = ask(&random);
        let rows = if ra == rb {
            format!("{ra}")
        } else {
            format!("{ra} vs {rb}")
        };

        println!("  {what:<44} {a:>8.1} {b:>10.1} {:>8.2}x  {rows}", b / a);
    }

    println!(
        "\n  A data-dependent TWO-exclusion COUNT means misprediction is real. A FLAT one means\n  \
         the 2.3-3.2x is gather locality and item 1228's attribution needs correcting."
    );
}
