//! Does the RUST engine have the wrapped-aggregate hole items 1197/1198 just closed in TS? (1199)
//!
//! "Grep the pattern elsewhere" is a step of the method, and the two engines are independent
//! implementations, so the answer is a measurement and not an inference. In TS, wrapping an
//! ungrouped aggregate in ANY expression left the streaming route — `size(collect(a.k))` cost 10.2x
//! the bare `collect`, `coalesce(max(a.num), 0)` 10.2x the bare `max` — because the detector
//! required the aggregate to BE the whole projection item.
//!
//! The structural reason to expect Rust to differ is that it lowers a wrapped aggregate to TWO
//! plan nodes, `Project{ <wrapper> , Aggregate{ <agg> } }`, so the fast paths in `exec/fastpath.rs`
//! match the `Aggregate` beneath a `Project` and never see the wrapper. If that holds, every
//! wrapped row costs its bare twin plus one scalar evaluation on ONE row, and there is nothing here.
//!
//! ⚠️ THE FLOOR IS THE BARE SPELLING, for the reason items 1187/1189/1195 each paid for: it is the
//! same question through the route the fast path already serves. `count(*)` would flatter the
//! comparison (its own O(1) shortcut) and `size(collect(x))` would distort it (item 1195: `size`
//! borrows the column and reads `len()` without a pass, which overstated a gap 3.5x).
//!
//! Read the output as: every `vs bare` near 1.0 means the planner's split already does what items
//! 1197 and 1198 had to build by hand in TS — a REFUTATION, recorded with its numbers so the lever
//! is not re-priced from the TS result.
//!
//!   cargo run --release --example wrapped_agg_probe

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

        b.node(
            &["Person"],
            &[
                ("num", Value::Num(f64::from(n))),
                ("str", Value::Str(format!("u{i:08}").into())),
            ],
        );
    }

    b.build()
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let store = store_of(nodes);

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

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);
    println!("  shape                                      us    vs bare   answer");

    // Each wrapped shape is paired with the BARE spelling of the same aggregate, so the ratio is
    // against the route that already serves it rather than against some other query.
    for (label, bare, wrapped) in [
        (
            "abs(min(a.num) - 10)",
            "MATCH (a:Person) RETURN min(a.num) AS c",
            "MATCH (a:Person) RETURN abs(min(a.num) - 10) AS c",
        ),
        (
            "max(a.num) + 1",
            "MATCH (a:Person) RETURN max(a.num) AS c",
            "MATCH (a:Person) RETURN max(a.num) + 1 AS c",
        ),
        (
            "coalesce(max(a.num), 0)",
            "MATCH (a:Person) RETURN max(a.num) AS c",
            "MATCH (a:Person) RETURN coalesce(max(a.num), 0) AS c",
        ),
        (
            "count(a.num) * 2",
            "MATCH (a:Person) RETURN count(a.num) AS c",
            "MATCH (a:Person) RETURN count(a.num) * 2 AS c",
        ),
        (
            "upper(max(a.str))",
            "MATCH (a:Person) RETURN max(a.str) AS c",
            "MATCH (a:Person) RETURN upper(max(a.str)) AS c",
        ),
        (
            "size(collect(a.num))",
            "MATCH (a:Person) RETURN collect(a.num) AS c",
            "MATCH (a:Person) RETURN size(collect(a.num)) AS c",
        ),
        (
            "coalesce(collect(a.num), 1)",
            "MATCH (a:Person) RETURN collect(a.num) AS c",
            "MATCH (a:Person) RETURN coalesce(collect(a.num), 1) AS c",
        ),
    ] {
        let (b, _) = ask(bare);
        let (w, answer) = ask(wrapped);
        let short = if answer.len() > 24 {
            format!("{}...", &answer[..21])
        } else {
            answer
        };

        println!("  {label:<34} {w:>10.1} {:>8.2}x   {short}", w / b);
    }

    // ⚠️ THE ONE ROW THAT IS NOT 1.00x NEEDS ITS OWN TABLE. `coalesce(collect(a.num), 1)` came
    // back at 4.33x the bare `collect` while `size(collect(a.num))` came back at 0.45x, and the
    // difference between those two is named in `evaluator.rs:2130`: `size`/`cardinality` BORROW
    // the column, while the generic path materializes each argument with `Col::value_at`, and
    // `Col::Gen(v) => v[i].clone()` on a `Value::List` DEEP-COPIES THE WHOLE LIST. That comment
    // ends "that clone is on the path of every function over a boxed column, not just this one",
    // so the question is whether the cost is `coalesce` or the clone.
    //
    // Several functions over the SAME aggregate separate those: if they all pay it, it is the
    // clone. The controls are the same functions over a SCALAR aggregate (`max`), where there is
    // no list to copy — those must stay flat, and they are what makes the ratio mean "copying the
    // container" rather than "calling a function".
    println!("\n  A function over a LIST-valued aggregate, against the bare aggregate:\n");
    println!("  shape                                      us    vs bare   answer");

    let (bare_list, _) = ask("MATCH (a:Person) RETURN collect(a.num) AS c");
    let (bare_scalar, _) = ask("MATCH (a:Person) RETURN max(a.num) AS c");

    for (label, q, over_list) in [
        (
            "coalesce(collect(a.num), 1)",
            "MATCH (a:Person) RETURN coalesce(collect(a.num), 1) AS c",
            true,
        ),
        (
            "reverse(collect(a.num))",
            "MATCH (a:Person) RETURN reverse(collect(a.num)) AS c",
            true,
        ),
        (
            "size(collect(a.num))",
            "MATCH (a:Person) RETURN size(collect(a.num)) AS c",
            true,
        ),
        (
            "cardinality(collect(a.num))",
            "MATCH (a:Person) RETURN cardinality(collect(a.num)) AS c",
            true,
        ),
        (
            "[CTL] coalesce(max(a.num), 1)",
            "MATCH (a:Person) RETURN coalesce(max(a.num), 1) AS c",
            false,
        ),
        (
            "[CTL] abs(max(a.num))",
            "MATCH (a:Person) RETURN abs(max(a.num)) AS c",
            false,
        ),
    ] {
        let (us, answer) = ask(q);
        let base = if over_list { bare_list } else { bare_scalar };
        let short = if answer.len() > 24 {
            format!("{}...", &answer[..21])
        } else {
            answer
        };

        println!("  {label:<34} {us:>10.1} {:>8.2}x   {short}", us / base);
    }

    // ITEM 1200's TARGET ROWS. The cell-level borrow is in the PER-ROW loop, so the one-row
    // aggregate shape above is its smallest case; a list-valued column read per row is where the
    // clone is paid N times. There is no stored list column, so a per-row list is built with
    // `[a.num]` — which makes this the honest shape for the general case rather than only the
    // aggregate one.
    //
    // The CONTROLS are unary functions over a NON-container cell (a number, a string): they go
    // through the identical new arm, so they say whether borrowing a cell costs anything where
    // there is nothing big to copy.
    println!("\n  A unary function over a per-row CONTAINER, and over non-containers [CTL]:\n");
    println!("  shape                                      us   answer");

    for (label, q) in [
        (
            "reverse([a.num])            per row",
            "MATCH (a:Person) RETURN reverse([a.num]) AS c",
        ),
        (
            "size([a.num, a.num])        per row",
            "MATCH (a:Person) RETURN size([a.num, a.num]) AS c",
        ),
        (
            "head([a.num, a.num])        per row",
            "MATCH (a:Person) RETURN head([a.num, a.num]) AS c",
        ),
        (
            "[CTL] abs(a.num)            per row",
            "MATCH (a:Person) RETURN abs(a.num) AS c",
        ),
        (
            "[CTL] upper(a.str)          per row",
            "MATCH (a:Person) RETURN upper(a.str) AS c",
        ),
        (
            "[CTL] a.num                 per row",
            "MATCH (a:Person) RETURN a.num AS c",
        ),
    ] {
        let (us, answer) = ask(q);
        let short = if answer.len() > 24 {
            format!("{}...", &answer[..21])
        } else {
            answer
        };

        println!("  {label:<34} {us:>10.1}   {short}");
    }

    // THE n-ARY HALF'S BREADTH (item 1201), measured before deciding whether a 113-site signature
    // change is worth it. Item 1200 closed the UNARY case with `std::slice::from_ref`, which a
    // multi-argument call cannot use — it needs an owned buffer, so every LIST argument is still
    // deep-copied before the function sees it.
    //
    // These are the multi-arg functions that actually take a list: `list_contains` is the purest
    // case (it only READS the list, so the copy is 100% waste), while `append` must build a new
    // list anyway (`out = v.clone()` inside), so borrowing can only remove ONE of its two copies.
    // The CONTROL is the same function over a SHORT literal list, where there is nothing big to
    // copy — if that moves too, the cost is not the copy.
    println!("\n  n-ARY over a LIST-valued aggregate [item 1201's open half]:\n");
    println!("  shape                                      us    vs bare   answer");

    for (label, q) in [
        (
            "list_contains(collect(a.num), 5)",
            "MATCH (a:Person) RETURN list_contains(collect(a.num), 5) AS c",
        ),
        (
            "append(collect(a.num), 1)",
            "MATCH (a:Person) RETURN append(collect(a.num), 1) AS c",
        ),
        (
            "intersection(collect(a.num), [1])",
            "MATCH (a:Person) RETURN intersection(collect(a.num), [1]) AS c",
        ),
        (
            "concat(collect(a.num), [1])",
            "MATCH (a:Person) RETURN concat(collect(a.num), [1]) AS c",
        ),
        (
            "[CTL] list_contains([1, 2], 1)",
            "MATCH (a:Person) RETURN list_contains([1, 2], 1) AS c",
        ),
    ] {
        let (us, answer) = ask(q);
        let short = if answer.len() > 24 {
            format!("{}...", &answer[..21])
        } else {
            answer
        };

        println!(
            "  {label:<34} {us:>10.1} {:>8.2}x   {short}",
            us / bare_list
        );
    }

    println!(
        "\n  Every ratio near 1.0 => the planner's Project/Aggregate split already separates the\n  \
         wrapper from the fold, and the TS routing hole has no Rust twin."
    );
    println!(
        "  A LIST row well above 1.0 with the SCALAR controls flat => the cost is copying the\n  \
         container to evaluate the argument, not calling the function."
    );
}
