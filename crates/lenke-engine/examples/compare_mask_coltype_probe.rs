//! Does a WHERE comparison have a typed mask for every column type? (item 1203)
//!
//! Item 1191 closed the column-representation census for FOLDS (six wins, one refuted). This is the
//! same census on a different path — `Expr::Compare`, which `evaluator.rs:1087` serves with exactly
//! TWO typed masks before falling back to a boxed per-row `compare`:
//!
//!   typed_num_mask   `Column::Num`                      (every op)
//!   typed_str_mask   `Column::Str`                      (every op)
//!                    `Column::Dict` for Eq/Ne ONLY      — an ordering op falls through
//!
//! Across both functions, `Column::Bool` and `Column::Temporal` are mentioned ZERO times. So three
//! candidate holes, and per items 1191/1192 a text census finds candidates and not facts — this
//! measures them.
//!
//! ⚠️ TWO FLOORS, both chosen before measuring (items 1187, 1189 and 1195 each paid for a control
//! that was subject to the hole it measured):
//!
//!   count(*) with NO predicate   the scan floor: what the walk costs with no comparison at all.
//!   WHERE true                   the same shape WITH a clause that cannot be false — this repo's
//!                                own control for "why is the filtered version slower" (item 570).
//!
//! And the reference for what a SERVED comparison costs is the `num`/`str` row of the same table,
//! at matched selectivity — not a different query.
//!
//! ⚠️ SELECTIVITY IS HELD AT ~50% ACROSS EVERY ROW. A predicate matching 1% and one matching 50%
//! count different numbers of rows, and the comparison would then be of two different questions.
//! The printed `rows` column is the check on that, not decoration.
//!
//!   cargo run --release --example compare_mask_coltype_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

use support::{time_query, Cfg};

fn store_of(nodes: u32) -> Store {
    let mut b = Builder::default();
    let mut rng = support::Lcg::seeded();

    for _i in 0..nodes {
        let n = rng.next(1_000_000);
        // Every column splits at ~50% on the predicate used below, so the rows counted are
        // comparable across representations.
        b.node(
            &["Person"],
            &[
                ("num", Value::Num(f64::from(n))),
                ("str", Value::Str(format!("u{n:08}").into())),
                // EIGHT distinct values, so this dictionary-encodes; `g0`-`g3` is half of them.
                ("dict", Value::Str(format!("g{}", n % 8).into())),
                ("flag", Value::Bool(n.is_multiple_of(2))),
                (
                    "date",
                    Value::Temporal(lenke_engine::temporal::Temporal::Date(
                        lenke_engine::temporal::Date::parse(&format!(
                            "{:04}-01-01",
                            1950 + (n % 100)
                        ))
                        .expect("a valid date"),
                    )),
                ),
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
                let rows = lenke_engine::exec::try_run(&plan, &store)
                    .ok()
                    .and_then(|r| r.rows.iter().next().and_then(|row| row.first()).cloned())
                    .map_or_else(|| "<none>".to_string(), |v| format!("{v:?}"));

                (us, rows)
            }
            Err(e) => (f64::NAN, format!("ERR {e}")),
        }
    };

    println!("\n# {nodes} nodes, min of {} reps\n", cfg.reps);

    // THE FLOORS FIRST, so every ratio below is against a number already on screen.
    let (bare, bare_rows) = ask("MATCH (a:Person) RETURN count(*) AS c");
    let (wtrue, _) = ask("MATCH (a:Person) WHERE true RETURN count(*) AS c");

    // ⚠️ `count(*)` WITH NO PREDICATE IS NOT A FLOOR. It has its own O(1) shortcut and reads at
    // the timer's resolution, so dividing by it manufactures any ratio you like — item 1196's own
    // rule, which the first version of this probe broke anyway (it printed ratios like 2063x).
    // The floor is `WHERE true`: the same walk, with a clause that cannot be false.
    println!("  count(*), no predicate (O(1), NOT a floor) {bare:>9.1}us   rows {bare_rows}");
    println!("  [FLOOR] WHERE true                        {wtrue:>9.1}us   (item 570's control)");
    println!("\n  predicate                               us   vs WHERE true   served?   rows");

    for (label, pred, served) in [
        // SERVED, and the reference for what a typed mask costs. ⚠️ EVERY predicate here must
        // actually MATCH about half the rows: the first version used `a.num = 500000`, which
        // matched ZERO of 200,000 random values, so its row timed a different question.
        ("a.num >= 500000", "a.num >= 500000", "YES num"),
        ("a.num < 500000", "a.num < 500000", "YES num"),
        ("a.str >= 'u00500000'", "a.str >= 'u00500000'", "YES str"),
        ("a.str < 'u00500000'", "a.str < 'u00500000'", "YES str"),
        // Dict Eq/Ne IS served by the code compare; an ORDERING op is the hole.
        ("a.dict = 'g3'", "a.dict = 'g3'", "YES dict eq"),
        ("a.dict <> 'g3'", "a.dict <> 'g3'", "YES dict ne"),
        ("a.dict >= 'g4'   [HOLE?]", "a.dict >= 'g4'", "no  dict ord"),
        ("a.dict < 'g4'    [HOLE?]", "a.dict < 'g4'", "no  dict ord"),
        // Bool and Temporal have no mask at all.
        ("a.flag = true    [HOLE?]", "a.flag = true", "no  bool"),
        ("a.flag <> true   [HOLE?]", "a.flag <> true", "no  bool"),
        (
            "a.date >= DATE'2000-01-01' [HOLE?]",
            "a.date >= DATE'2000-01-01'",
            "no  temporal",
        ),
        (
            "a.date < DATE'2000-01-01'  [HOLE?]",
            "a.date < DATE'2000-01-01'",
            "no  temporal",
        ),
    ] {
        let q = format!("MATCH (a:Person) WHERE {pred} RETURN count(*) AS c");
        let (us, rows) = ask(&q);

        // THE PLAN, canonicalized, because the first run's numbers inverted the hypothesis — the
        // supposedly unserved rows were the FASTEST — and a time cannot say why. A row whose plan
        // differs in shape is answering by a different route, not by a faster compare.
        let plan = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(&q).expect("parses"),
            &store,
        );
        let shape = format!("{plan:?}");
        let shape = shape
            .split_whitespace()
            .take(6)
            .collect::<Vec<_>>()
            .join(" ");

        println!(
            "  {label:<36} {us:>9.1} {:>10.2}x   {served:<13} {rows:<16} {}",
            us / wtrue,
            &shape[..shape.len().min(58)]
        );
    }

    println!(
        "\n  A [HOLE?] row near the SERVED rows means the boxed fallback is good enough there and\n  \
         the census found a candidate, not a target. Well above them is the headroom, capped by\n  \
         what a served row of the same shape costs."
    );
    println!(
        "  ⚠️ Check the `rows` column before reading any ratio: a predicate that selects a\n  \
         different number of rows is a different question."
    );
}
