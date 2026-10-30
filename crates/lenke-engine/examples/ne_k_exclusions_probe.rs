//! How does a count with k EXCLUSIONS scale, and where would k+1 passes lose? (item 1231)
//!
//! Item 1213 answered ONE exclusion as two vectorized passes (count the range, subtract the
//! excluded value's own count) and everything beyond fell to the fully general arm, which walks
//! `bounds` and dispatches `num_pred` per row. Item 1229 measured that as a cliff: one exclusion
//! 51.2 us, TWO exclusions 608.8 — 11.9x for one more literal.
//!
//! Generalizing to k exclusions is k+1 passes. THAT RAISES ITS OWN QUESTION, which this answers
//! rather than capping on a guess: k+1 vectorized passes each cost something, so for large enough
//! k the general arm — ONE pass, however branchy — must eventually win. This sweeps k to find
//! whether that crossover is inside any range a query would plausibly use.
//!
//! BOTH FIXTURES, because the general arm is data-dependent (item 1229: 2.06x) and the pass-based
//! arm should be FLAT. A pass-based arm that is flat across fixtures while the general one is not
//! is the signature that the rewrite did what it claims.
//!
//! CONTROLS the change cannot reach: the range-only count (the `ne.is_empty()` branch, untouched),
//! and a STRING bound (a different column type entirely).
//!
//!   cargo run --release --example ne_k_exclusions_probe

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

        b.node(
            &["Person"],
            &[
                ("k", Value::Num(f64::from(k))),
                ("s", Value::Str(format!("u{k:04}").into())),
            ],
        );
    }

    b.build()
}

/// `WHERE k > 50 AND k < 100` plus `k <> v` for `k_count` distinct values inside the range.
fn query_with(k_count: usize) -> String {
    let mut q = String::from("MATCH (p:Person) WHERE p.k > 50 AND p.k < 100");

    for j in 0..k_count {
        // 60, 61, ... all strictly inside (50, 100), so every exclusion needs a real pass.
        q.push_str(&format!(" AND p.k <> {}", 60 + j));
    }
    q.push_str(" RETURN count(*) AS c");
    q
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let periodic = store_of(nodes, true);
    let random = store_of(nodes, false);

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!("  shape                          periodic(us)   random(us)   ratio    answer");

    let ask = |store: &Store, q: &str| -> (f64, f64) {
        let us = time_query(q, false, store, cfg.reps).map_or(f64::NAN, |(us, _)| us);
        let ans = lenke_engine::exec::try_run(
            &lenke_engine::opt::optimize_indexed(
                lenke_engine::gql::parse(q).expect("parses"),
                store,
            ),
            store,
        )
        .ok()
        .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
        .and_then(|v| match v {
            Value::Num(n) => Some(n),
            _ => None,
        })
        .unwrap_or(f64::NAN);

        (us, ans)
    };

    for k_count in [0usize, 1, 2, 4, 8, 16, 32] {
        let q = query_with(k_count);
        let (a, ans_a) = ask(&periodic, &q);
        let (b, ans_b) = ask(&random, &q);
        // ⚠️ THE TWO FIXTURES LEGITIMATELY ANSWER DIFFERENT COUNTS and that is NOT a warning: the
        // random draw does not land exactly 2,000 rows on each of the 100 values, so its filtered
        // counts differ by a fraction of a percent. Both are printed; the comparison that MUST
        // hold is between the two ARMS at the same k, which is read down the column.
        let answer = format!("{ans_a:.0} / {ans_b:.0}");
        let label = format!("count, {k_count} exclusion(s)");

        println!(
            "  {label:<30} {a:>12.1} {b:>12.1} {:>7.2}x    {answer}",
            b / a
        );
    }

    for (what, q) in [
        (
            "[CTL] range only, no ne",
            "MATCH (p:Person) WHERE p.k > 50 AND p.k < 100 RETURN count(*) AS c",
        ),
        (
            "[CTL] STRING bound",
            "MATCH (p:Person) WHERE p.s > 'u0050' RETURN count(*) AS c",
        ),
    ] {
        let (a, ans) = ask(&periodic, q);
        let (b, _) = ask(&random, q);

        println!(
            "  {what:<30} {a:>12.1} {b:>12.1} {:>7.2}x    {ans:.0}",
            b / a
        );
    }

    println!(
        "\n  k+1 passes should be FLAT across the two fixtures where the general arm is not.\n  \
         The crossover, if any, is the k at which the time stops beating the pre-change general\n  \
         arm — compare against a build without the k-exclusion arm."
    );
}
