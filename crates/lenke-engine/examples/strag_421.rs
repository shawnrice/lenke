//! Item 421: WHAT DOES A SCALAR `min`/`max` COST BY COLUMN TYPE? `try_scan_num_agg` folds an
//! ungrouped `sum`/`avg`/`min`/`max` straight off the `Column::Num` slices, and its gate says
//! what it does not do:
//!
//! ```text
//! let Some(Column::Num { data, present, .. }) = store.column(key) else {
//!     return None; // non-numeric column: the general path handles poison
//! };
//! ```
//!
//! So a `max` over a STRING column has no columnar fold. The question this probe asks is only
//! how much that costs, and whether the answer depends on the column's ENCODING — a dictionary
//! column holds few distinct strings behind many codes, and the extremum of the whole column is
//! the extremum of the distinct values that appear in it, which is a far smaller set.
//!
//! The CONTROLS are the paths that already exist and must be unreachable from any change here:
//! the numeric fold (`try_scan_num_agg`), the count over a column of any type
//! (`try_scan_count_prop`), and the projection of the same column, which is the floor for
//! anything that has to look at every row.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32, distinct: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        // `s` is LOW-cardinality, so it is the dictionary case; `wide` has a distinct string per
        // node, which is the case a dictionary cannot help. Both are present on every node, so
        // presence is not what separates them. `k` is the numeric control.
        let s = format!("c{:04}", i % distinct);
        let wide = format!("u{i:08}");
        b.node(
            &["P"],
            &[
                ("k", Value::Num(f64::from(i % 1000))),
                ("s", Value::Str(s.into())),
                ("wide", Value::Str(wide.into())),
            ],
        );
    }
    b.build()
}

fn probe(q: &str, store: &Store, reps: u32) -> Result<(f64, String), String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut got = String::new();
    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        got = format!("{:?}", out.rows.iter().next().and_then(|r| r.first()));
    }
    Ok((best, got))
}

fn main() {
    // Sweep the size: cache-resident and not are different questions, and the transition is
    // between 200k and 1M (the repo's bench rules).
    for n in [50_000u32, 200_000, 1_000_000] {
        let store = fixture(n, 97);
        // Which ENCODING each column actually got. The claim "the dict arm is 14x" is only
        // about the dict arm if the fixture produced one, and `scan_is_cheap` is the engine's
        // own answer to that (item 407 added it for the seek threshold).
        println!(
            "\n=== {n} nodes, `s` dict={} (97 distinct), `wide` dict={} ===",
            store.scan_is_cheap("s"),
            store.scan_is_cheap("wide")
        );
        let cases: &[(&str, &str)] = &[
            ("T max dict string", "MATCH (a:P) RETURN max(a.s) AS m"),
            ("T min dict string", "MATCH (a:P) RETURN min(a.s) AS m"),
            ("T max wide string", "MATCH (a:P) RETURN max(a.wide) AS m"),
            ("C max numeric", "MATCH (a:P) RETURN max(a.k) AS m"),
            ("C sum numeric", "MATCH (a:P) RETURN sum(a.k) AS m"),
            ("C count(a.s)", "MATCH (a:P) RETURN count(a.s) AS m"),
            ("C count(*)", "MATCH (a:P) RETURN count(*) AS m"),
            ("C project a.s", "MATCH (a:P) RETURN a.s AS m"),
        ];
        // `PROBE_ONLY=<substring>` runs ONE case in this process. Item 420 found a control
        // moving 1.28x purely because the targets AHEAD of it in the same process got faster
        // and stopped allocating — a control that shares an allocator with a target that got
        // 14x is no longer the same measurement. One case per process is how that is settled.
        let only = std::env::var("PROBE_ONLY").ok();
        for (name, q) in cases
            .iter()
            .filter(|(n, _)| only.as_ref().is_none_or(|o| n.contains(o.as_str())))
        {
            match probe(q, &store, 5) {
                Ok((ms, got)) => println!("{:<20} {:>9.3} ms   {got}", name, ms),
                Err(e) => println!("{name:<20}     ERROR {e}"),
            }
        }
    }
}
