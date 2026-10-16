//! Item 428: the NATIVE twin of item 427. The TS engine's generic projection tail paged the
//! PROJECTED rows, so `RETURN a.u AS s SKIP 199995 LIMIT 5` projected all 200,000 to return five
//! — 1.96-2.09x, closed by skipping bindings where the projection cannot raise.
//!
//! Does native do the same? The question is asked the same way: the paged query against the
//! unpaged projection of the same rows (which must project everything, so it is the ceiling) and
//! against `count(*)` (which reads nothing). A native `SKIP` that paged rows rather than inputs
//! would sit at the projection's cost; one that pages inputs should sit far below it.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        let j = (i * 48_271) % n;
        b.node(
            &["P"],
            &[
                ("k", Value::Num(f64::from(j % 1000))),
                ("u", Value::Str(format!("u{j:08}").into())),
            ],
        );
    }
    b.build()
}

fn probe(q: &str, store: &Store, reps: u32) -> Result<(f64, usize), String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut rows = 0;
    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        rows = out.rows.len();
    }
    Ok((best, rows))
}

fn main() {
    for n in [200_000u32, 1_000_000] {
        let store = fixture(n);
        println!("\n=== {n} nodes ===");
        let skip_to_end = n - 5;
        let cases: Vec<(String, String)> = vec![
            (
                "T skip to the end".into(),
                format!("MATCH (a:P) RETURN a.u AS s SKIP {skip_to_end} LIMIT 5"),
            ),
            (
                "T skip, no limit".into(),
                format!("MATCH (a:P) RETURN a.u AS s SKIP {skip_to_end}"),
            ),
            (
                "T skip, two props".into(),
                format!("MATCH (a:P) RETURN a.u AS s, a.k AS k SKIP {skip_to_end} LIMIT 5"),
            ),
            // The REALISTIC page, and the one that decides whether there is a target: a deep
            // `SKIP n-5` is pathological, but `SKIP 100 LIMIT 20` is what a paged UI asks. If
            // the engine gathers every row's projection before paging, the shallow page costs
            // the same as the deep one; if it pages inputs, it costs nothing.
            (
                "T shallow page".into(),
                "MATCH (a:P) RETURN a.u AS s SKIP 100 LIMIT 20".into(),
            ),
            (
                "T shallow, two props".into(),
                "MATCH (a:P) RETURN a.u AS s, a.k AS k SKIP 100 LIMIT 20".into(),
            ),
            (
                "C ordered top-k".into(),
                "MATCH (a:P) RETURN a.u AS s ORDER BY s LIMIT 5".into(),
            ),
            ("C project all".into(), "MATCH (a:P) RETURN a.u AS s".into()),
            (
                "C limit 5 only".into(),
                "MATCH (a:P) RETURN a.u AS s LIMIT 5".into(),
            ),
            (
                "C count(*)".into(),
                "MATCH (a:P) RETURN count(*) AS c".into(),
            ),
        ];
        for (name, q) in &cases {
            match probe(q, &store, 5) {
                Ok((ms, rows)) => println!("{name:<20} {ms:>9.3} ms  {rows} rows"),
                Err(e) => println!("{name:<20}     ERROR {e}"),
            }
        }
    }
}
