//! Of element egress's ~115 ns a row, how much is CREATING the values and how much is DROPPING
//! them? (item 1171)
//!
//! Item 1170 re-measured the target and decomposed it as far as arithmetic allows:
//!
//! ```text
//!   hop node, NO distinct   177.5 ns/row       199k distinct maps  ~64 ms  (320 ns each)
//!   hop prop, NO distinct     7.4 ns/row       the remaining 1M rows ~115 ms = 115 ns/row
//! ```
//!
//! and stopped there, labelling the 115 ns "consistent with" 1M `Arc` increments plus a 32 MB
//! `Vec` plus 1M decrements and ~199k frees — not established term by term. This establishes the
//! one term that changes the DESIGN rather than the number.
//!
//! `support::time_query` measures `try_run` and then DROPS the `Rows` inside the timed closure. So
//! the figure includes teardown. That matters two ways:
//!
//!   - If creation dominates, the fix is the representation (keep `Col::Nodes(Vec<u32>)` columnar
//!     through egress, as item 1111 proposed) and the win is most of the 115 ns.
//!   - If the DROP dominates, a columnar representation still wins — there is nothing to tear
//!     down — but the headline figure is partly an artifact of how the harness times, and the
//!     corpus row should say so rather than let a future reader over-credit the change.
//!
//! Arms, on ONE store so no arm gets its own heap (item 1166's lesson):
//!
//!   A node, create + DROP      what the corpus row measures
//!   B node, create and LEAK    `mem::forget`, so teardown is outside the timing
//!   C prop, create + DROP      the 7.4 ns/row floor, as the control
//!   D prop, create and LEAK    the same control with teardown removed, so the leak arm itself
//!                              is checked against a row the change cannot reach
//!
//! A minus B is the drop. D minus C says whether `mem::forget` measures what I think it does: on
//! a numeric column there is nothing to free, so A-B should be large and C-D near zero.
//!
//!   cargo run --release --example egress_split_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};

use support::Cfg;

fn social(nodes: u32, deg: u32) -> Store {
    let mut b = Builder::default();

    for i in 0..nodes {
        b.node(
            &["Person"],
            &[
                ("age", lenke_engine::value::Value::Num(f64::from(i % 90))),
                (
                    "name",
                    lenke_engine::value::Value::Str(format!("p{i}").into()),
                ),
            ],
        );
    }

    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        for _ in 0..deg {
            b.edge(i, rng.next(nodes), "KNOWS");
        }
    }

    b.build()
}

fn best_ms(reps: usize, mut f: impl FnMut() -> usize) -> (f64, usize) {
    let mut best = f64::INFINITY;
    let mut rows = 0;

    for _ in 0..reps {
        let t = std::time::Instant::now();
        let n = f();

        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
        rows = n;
    }

    (best, rows)
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let deg: u32 = std::env::var("PROBE_DEG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5);
    let store = social(nodes, deg);

    let plan_of = |q: &str| {
        lenke_engine::opt::optimize_indexed(lenke_engine::gql::parse(q).expect("parses"), &store)
    };
    let node_q = plan_of("MATCH (a:Person)-[:KNOWS]->(b) RETURN b");
    let prop_q = plan_of("MATCH (a:Person)-[:KNOWS]->(b) RETURN b.age AS x");

    println!(
        "\n# {nodes} nodes / degree {deg}, min of {} reps\n",
        cfg.reps
    );
    println!("  arm                                    ms      rows      ns/row");

    let show = |label: &str, ms: f64, rows: usize| {
        let per = if rows == 0 {
            f64::NAN
        } else {
            ms * 1_000_000.0 / rows as f64
        };

        println!("  {label:<34} {ms:>8.1} {rows:>9} {per:>11.1}");
    };

    // A — create AND drop, which is what the corpus row times.
    let (a_ms, a_rows) = best_ms(cfg.reps, || {
        lenke_engine::exec::try_run(&node_q, &store).map_or(0, |r| r.rows.len())
    });

    show("A node, create + DROP", a_ms, a_rows);

    // B — create and LEAK, so teardown falls outside the timing. `mem::forget` is deliberate: it
    // is the only way to time creation alone without reaching into a private representation.
    let (b_ms, b_rows) = best_ms(cfg.reps, || {
        lenke_engine::exec::try_run(&node_q, &store).map_or(0, |r| {
            let n = r.rows.len();

            std::mem::forget(r);
            n
        })
    });

    show("B node, create + LEAK", b_ms, b_rows);

    let (c_ms, c_rows) = best_ms(cfg.reps, || {
        lenke_engine::exec::try_run(&prop_q, &store).map_or(0, |r| r.rows.len())
    });

    show("C prop, create + DROP        [ctl]", c_ms, c_rows);

    let (d_ms, d_rows) = best_ms(cfg.reps, || {
        lenke_engine::exec::try_run(&prop_q, &store).map_or(0, |r| {
            let n = r.rows.len();

            std::mem::forget(r);
            n
        })
    });

    show("D prop, create + LEAK        [ctl]", d_ms, d_rows);

    println!(
        "\n  the DROP, node: {:.1} ms ({:.1} ns/row)",
        a_ms - b_ms,
        (a_ms - b_ms) * 1_000_000.0 / a_rows.max(1) as f64
    );
    println!(
        "  the DROP, prop: {:.1} ms ({:.1} ns/row)  <- near zero is the leak arm validating itself",
        c_ms - d_ms,
        (c_ms - d_ms) * 1_000_000.0 / c_rows.max(1) as f64
    );
}
