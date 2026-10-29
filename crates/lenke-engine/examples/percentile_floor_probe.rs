//! What is the FLOOR for a percentile, and which of its three costs is the big one? (item 1162)
//!
//! Item 1161 priced the aggregate-kind enum and left `percentile_cont` / `percentile_disc` at
//! 3674us against `sum`'s 122 on the same column — 30x — and declined to call it a target,
//! because a percentile needs an order statistic and `sum` does not. This probe decides it.
//!
//! Item 234 is the precedent and the reason this is measured before anything is built: a FLOOR
//! per shape RETRACTED TWO OF THREE targets, because the big ratio turned out to be data layout
//! rather than the overhead being blamed.
//!
//! `percentile_of` has THREE separable costs, and the method says find out which one owns the
//! 30x rather than fix the one that is most obvious:
//!
//!   1. BOXING — the gather calls `col.value_at(i)` per row, building a `Value` for each.
//!   2. THE COMPARATOR — `sort_by(|a, b| a.partial_cmp(b).unwrap_or(Equal))`, a closure call per
//!      comparison, rather than `sort_unstable_by(f64::total_cmp)`.
//!   3. THE SORT ITSELF — O(n log n) where ONE order statistic needs only O(n)
//!      (`select_nth_unstable`), and `cont` needs two adjacent ones.
//!
//! An O(n) selection only addresses (3). If (1) owns the ratio, selection is the wrong build and
//! a columnar gather is the right one — so the arms separate them:
//!
//!   A1 sum                    the scan+column floor, and the control no percentile work reaches
//!   A2 collect_list           MATERIALIZATION ONLY: the same boxed gather, no sort at all
//!   A3 percentile_disc        one order statistic, as it costs today
//!   A4 percentile_cont        two interpolated, as it costs today
//!   A5 FLOOR: select_nth      columnar f64 copy + `select_nth_unstable_by` — the candidate
//!   A6 columnar + full sort   the same copy + `sort_unstable_by(total_cmp)`
//!
//! A5 against A6 prices the SELECTION; A2 against A5 prices the BOXING; A1 is the floor both sit
//! on. Note the gather keeps only FINITE values (`x.is_finite()`), so NaN and ±INFINITY are
//! dropped — A5/A6 replicate that or they are measuring a different question.
//!
//!   cargo run --release --example percentile_floor_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Column, Store};

use support::{best_us, time_query, Cfg};

fn numeric_store(nodes: u32) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for _ in 0..nodes {
        let n = f64::from(rng.next(1_000_000));

        b.node(&["Person"], &[("n", lenke_engine::value::Value::Num(n))]);
    }

    b.build()
}

/// The finite values of a `Num` column, gathered COLUMNAR — no `Value`, no per-row boxing.
/// This is the gather a fast path would do, so it is the gather the floor must include.
fn finite_values(store: &Store, key: &str) -> Vec<f64> {
    let Some(Column::Num { data, present, .. }) = store.column(key) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(data.len());
    for (i, &x) in data.iter().enumerate() {
        if present[i] && x.is_finite() {
            out.push(x);
        }
    }
    out
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = numeric_store(nodes);

    println!(
        "\n# {nodes} nodes, one dense numeric property, min of {}\n",
        cfg.reps
    );
    println!("  arm                                       us");

    for (label, q) in [
        (
            "A1 sum                        [ctl]",
            "MATCH (a:Person) RETURN sum(a.n) AS c",
        ),
        (
            "A2 collect_list   materialize only",
            "MATCH (a:Person) RETURN collect_list(a.n) AS c",
        ),
        (
            "A3 percentile_disc",
            "MATCH (a:Person) RETURN percentile_disc(a.n, 0.5) AS c",
        ),
        (
            "A4 percentile_cont",
            "MATCH (a:Person) RETURN percentile_cont(a.n, 0.5) AS c",
        ),
    ] {
        match time_query(q, false, &store, cfg.reps) {
            Ok((us, _)) => println!("  {label:<40} {us:>8.1}"),
            Err(e) => println!("  {label:<40}    ERR   {e}"),
        }
    }

    // A5: the candidate's floor — columnar gather plus ONE order statistic.
    let us = best_us(cfg.reps, || {
        let mut v = finite_values(&store, "n");
        if v.is_empty() {
            return f64::NAN;
        }
        let n = v.len();
        let idx = ((0.5 * n as f64).ceil() as usize)
            .saturating_sub(1)
            .min(n - 1);
        let (_, nth, _) = v.select_nth_unstable_by(idx, f64::total_cmp);
        *nth
    });
    println!("  {:<40} {us:>8.1}", "A5 FLOOR columnar + select_nth");

    // A6: the same gather with a full sort, so A5-vs-A6 is the selection on its own.
    let us6 = best_us(cfg.reps, || {
        let mut v = finite_values(&store, "n");
        v.sort_unstable_by(f64::total_cmp);
        if v.is_empty() {
            return f64::NAN;
        }
        let n = v.len();
        let idx = ((0.5 * n as f64).ceil() as usize)
            .saturating_sub(1)
            .min(n - 1);
        v[idx]
    });
    println!("  {:<40} {us6:>8.1}", "A6 columnar + full sort");

    // A7: the gather ALONE, so the copy is separated from both the sort and the selection.
    let us7 = best_us(cfg.reps, || finite_values(&store, "n").len());
    println!("  {:<40} {us7:>8.1}", "A7 columnar gather alone");
}
