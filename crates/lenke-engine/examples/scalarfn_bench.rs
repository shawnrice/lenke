//! What does ONE scalar function call cost per row, and which names are on a vectorized path?
//!
//! The evaluator's `Expr::Call` arm is a chain of specialization tables consulted by NAME and
//! arity — `unary_num_fn`, `unary_str_fn`, `binary_str_pred_fn`, `binary_num_fn` (items 759, 765,
//! 766) — and anything no table claims falls to the general per-row dispatch, which materializes
//! each argument through `Col::value_at`. For a string argument that CLONES the `GStr` out of a
//! `Col::Str` into a `Value`, which is the cost those items were about.
//!
//! So "is this name vectorized?" is a question with a measurable answer, and the answer is a
//! per-row cost that separates into two bands. This example exists because items 759, 765, 766 and
//! 767 each rebuilt an ad-hoc harness to ask it — four times for one question, which is the
//! expensive path `examples/README.md` warns about. The committed form also makes the NEXT
//! addition cheap: add the name here, and the band it lands in says whether a table claimed it.
//!
//! READING IT. Every case is `RETURN count(f(a.s))` over the same rows, so the row count and the
//! aggregate are identical across cases and the only difference is the expression. The controls
//! are at the bottom:
//!
//!   - `count(a.s)` — no function at all, the floor any call is measured against.
//!   - `count(abs(a.n))` — a NUMERIC one-arg call, vectorized since item 759 and reading from a
//!     `Col::Num` that needs no clone. It is the cheapest a call gets and cannot be improved by
//!     anything done to the string tables, so it is the control a string-side change must not move.
//!
//! The fixture mixes ASCII and non-ASCII strings on purpose: `utf16_len` has an ASCII fast path
//! (item 767, worth 1.16x after the surrounding boxing was removed and 0% before it), so an
//! all-ASCII fixture would price `char_length` as a different function than it is.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32) -> Store {
    let mut b = Builder::default();

    for i in 0..n {
        // A LEADING AND TRAILING SPACE on every third string, so the trim family has something to
        // strip rather than measuring the no-op path, and a non-ASCII run on every seventh.
        let s = match i % 21 {
            0..=6 => format!("  pad{}  ", i % 97),
            7..=13 => format!("naïve-{}-ßé", i % 97),
            _ => format!("plain{}", i % 97),
        };

        b.node(
            &["Univ"],
            &[
                ("n", Value::Num(f64::from(i % 1009))),
                ("s", Value::Str(s.into())),
            ],
        );
    }

    b.build()
}

fn probe(q: &str, store: &Store, reps: u32) -> Result<f64, String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;

    for _ in 0..reps {
        let t = Instant::now();
        let _ = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
    }

    Ok(best)
}

/// One-argument STRING functions. The two bands this example exists to show are a table hit and a
/// fall-through, and the names are listed together rather than grouped by band so the output says
/// which is which instead of the source.
const STR_1: &[&str] = &[
    "upper",
    "lower",
    "char_length",
    "byte_length",
    "trim",
    "btrim",
    "ltrim",
    "rtrim",
    "reverse",
    "to_string",
    // THE DECISIVE THIRD MEASUREMENT, and the reason this list is not grouped by band. `size` is
    // on the GENERAL dispatch and returns a `Num` without allocating an output string, which is
    // exactly `char_length`'s shape on the VECTORIZED path. Without it, "upper and trim cost the
    // same" has two explanations — the fast path buys nothing, or it is not firing at all — and
    // the pair cannot tell them apart (item 339's rule).
    "size",
];

/// Two-argument forms, including the trim family's char-set spelling — which must stay on the
/// general dispatch, since the tables are consulted by arity and these are the arity they do not
/// claim.
const STR_2: &[(&str, &str)] = &[
    ("contains", "contains(a.s, 'pad')"),
    ("starts_with", "starts_with(a.s, 'pad')"),
    ("btrim/2", "btrim(a.s, ' ')"),
    ("ltrim/2", "ltrim(a.s, ' ')"),
    ("left", "left(a.s, 3)"),
    ("split", "split(a.s, '-')"),
];

/// Two-argument NUMERIC calls, which item 759 put in `binary_num_fn` and measured at 3.33x
/// (`power`) and 3.55x (`mod`). That item changed two things at once — the table entry AND a
/// typed-slice arm — and item 784 refuted the arm at zero, so these rows are here to let the
/// table entry be priced on its own by removing a name from the table and re-running.
const NUM_2: &[(&str, &str)] = &[
    ("power", "power(a.n, 2)"),
    ("mod", "mod(a.n, 7)"),
    ("atan2", "atan2(a.n, 2)"),
    // CONTROL: a two-argument numeric name that is NOT in the table and never was — its second
    // argument is a digit COUNT with its own non-finite rule, so it stays on the general dispatch
    // by design. The gap between this and the three above is the table entry's whole value.
    ("round/2", "round(a.n, 2)"),
];

/// Cases where the call's OUTPUT COLUMN is consumed rather than merely counted (item 784).
///
/// `count(f(x))` counts non-nulls and may not read the values deeply, so it prices the INPUT side
/// and the dispatch — which is what item 783 used it for, and why that item's refutation is about
/// the dispatch only. An aggregate FOLD is the other question: `try_scan_num_agg` folds a `Num`
/// column and its gate declines every other kind (`strag_421` is that question for a stored
/// column), and every vectorized scalar arm here emits `Col::Gen`. So `max(char_length(a.s))`
/// cannot reach the fold that `max(a.n)` does, and the pair below says what that costs.
const CONSUMED: &[(&str, &str)] = &[
    ("max(char_length)", "max(char_length(a.s)) AS c"),
    ("max(byte_length)", "max(byte_length(a.s)) AS c"),
    ("max(abs)", "max(abs(a.n)) AS c"),
    ("sum(char_length)", "sum(char_length(a.s)) AS c"),
    // CONTROLS: the same folds over a STORED column, which is what the fast fold is for. The gap
    // between these and the rows above is the output column's doing, not the fold's.
    ("CONTROL max(a.n)", "max(a.n) AS c"),
    ("CONTROL sum(a.n)", "sum(a.n) AS c"),
];

fn main() {
    // Both sides of the cache transition (CLAUDE.md: between 200k and 1M elements), because a
    // per-row expression cost and a memory-bound one are different questions.
    for n in [200_000u32, 1_000_000] {
        let store = fixture(n);
        let reps = if n > 500_000 { 5 } else { 9 };
        println!("\n=== scalar function cost, {n} nodes (min of {reps}) ===");

        let floor = probe("MATCH (a:Univ) RETURN count(a.s) AS c", &store, reps)
            .expect("the no-function floor");
        let num = probe("MATCH (a:Univ) RETURN count(abs(a.n)) AS c", &store, reps)
            .expect("the numeric control");

        for name in STR_1 {
            let q = format!("MATCH (a:Univ) RETURN count({name}(a.s)) AS c");

            match probe(&q, &store, reps) {
                Ok(ms) => println!(
                    "  {:<14} {:>8.2}ms  {:>6.1} ns/row   +{:>6.1} over the floor",
                    name,
                    ms,
                    ms * 1e6 / f64::from(n),
                    (ms - floor) * 1e6 / f64::from(n)
                ),
                Err(e) => println!("  {name:<14}    SKIP  {e}"),
            }
        }

        for (name, call) in STR_2 {
            let q = format!("MATCH (a:Univ) RETURN count({call}) AS c");

            match probe(&q, &store, reps) {
                Ok(ms) => println!(
                    "  {:<14} {:>8.2}ms  {:>6.1} ns/row   +{:>6.1} over the floor",
                    name,
                    ms,
                    ms * 1e6 / f64::from(n),
                    (ms - floor) * 1e6 / f64::from(n)
                ),
                Err(e) => println!("  {name:<14}    SKIP  {e}"),
            }
        }

        for (name, call) in NUM_2 {
            let q = format!("MATCH (a:Univ) RETURN count({call}) AS c");

            match probe(&q, &store, reps) {
                Ok(ms) => println!(
                    "  {:<18} {:>8.2}ms  {:>6.1} ns/row   [two-arg numeric]",
                    name,
                    ms,
                    ms * 1e6 / f64::from(n)
                ),
                Err(e) => println!("  {name:<18}    SKIP  {e}"),
            }
        }

        for (name, agg) in CONSUMED {
            let q = format!("MATCH (a:Univ) RETURN {agg}");

            match probe(&q, &store, reps) {
                Ok(ms) => println!(
                    "  {:<18} {:>8.2}ms  {:>6.1} ns/row   [output CONSUMED by a fold]",
                    name,
                    ms,
                    ms * 1e6 / f64::from(n)
                ),
                Err(e) => println!("  {name:<18}    SKIP  {e}"),
            }
        }

        println!(
            "  {:<14} {:>8.2}ms  {:>6.1} ns/row   CONTROL numeric, vectorized (item 759)",
            "abs",
            num,
            num * 1e6 / f64::from(n)
        );
        println!(
            "  {:<14} {:>8.2}ms  {:>6.1} ns/row   CONTROL no function at all",
            "count(a.s)",
            floor,
            floor * 1e6 / f64::from(n)
        );
    }
}
