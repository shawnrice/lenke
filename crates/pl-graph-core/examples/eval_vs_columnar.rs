//! How far is the live WHERE path from the columnar floor? De-boxing already
//! shipped: a filtered aggregate now runs the predicate through the vectorized
//! frame (`eval_vec`, no per-row `Val`), gated by `USE_VEC` — flip it off and
//! this query is ~4.6x slower. So `[scan+count+pred] − [scan+count]` is NOT a
//! boxed-vs-not gap; it's the *vectorized expression interpreter* (arbitrary
//! predicate trees, 3-valued nulls, presence bitsets) versus a bespoke
//! `scan::predicate_gt` kernel over one typed column. The remaining ratio is the
//! interpreter→kernel headroom (would need per-predicate specialization or SIMD,
//! not de-boxing). Also: the property index sidesteps the scan entirely for
//! selective predicates, so this only bites on full-scan filters.
//! Run: cargo run --release --example eval_vs_columnar

use std::hint::black_box;
use std::time::Instant;

use pl_graph_core::gql::eval::Params;
use pl_graph_core::gql::prepare;
use pl_graph_core::graph::{Builder, Column, Graph, NodeRec, Value};
use pl_graph_core::scan::{predicate_gt_neon, predicate_gt_scalar};

const N: usize = 200_000;

fn build() -> Graph {
    let mut b = Builder::default();
    for i in 0..N {
        b.nodes.push(NodeRec {
            id: format!("p{i}"),
            labels: vec!["Person".to_string()],
            props: vec![("age".to_string(), Value::Num((18 + (i % 62)) as f64))],
        });
    }
    b.finalize()
}

fn time_query(g: &mut Graph, q: &str, iters: u32) -> f64 {
    let plan = prepare(q).unwrap();
    let params = Params::new();
    let _ = plan.execute(g, &params).unwrap();
    let t = Instant::now();
    for _ in 0..iters {
        let _ = plan.execute(g, &params).unwrap();
    }
    t.elapsed().as_secs_f64() * 1e6 / iters as f64
}

fn time_col(data: &[f64], thr: f64, iters: u32, simd: bool) -> f64 {
    let t = Instant::now();
    let mut acc = 0u64;
    for _ in 0..iters {
        let (c, _) = if simd {
            predicate_gt_neon(data, thr)
        } else {
            predicate_gt_scalar(data, thr)
        };
        acc = acc.wrapping_add(c);
    }
    black_box(acc);
    t.elapsed().as_secs_f64() * 1e6 / iters as f64
}

fn main() {
    let mut g = build();
    let iters = 500;

    let a = time_query(&mut g, "MATCH (n:Person) RETURN count(*) AS c", iters);
    let b = time_query(
        &mut g,
        "MATCH (n:Person) WHERE n.age >= 0 RETURN count(*) AS c",
        iters,
    );
    let vec_pred = b - a; // live (vectorized) filter cost; NOT a boxed path — see header

    let (scalar_us, simd_us) = match g.props.col("age") {
        Some(Column::Num { data, .. }) => (
            time_col(data, 0.0, iters * 20, false),
            time_col(data, 0.0, iters * 20, true),
        ),
        _ => panic!("no age column"),
    };

    println!("predicate over {N} rows (matches all, so pure predicate cost):\n");
    println!("  [a] scan + count                {a:>8.1} us");
    println!("  [b] scan + count + WHERE        {b:>8.1} us");
    println!("  vectorized filter    (b − a)    {vec_pred:>8.1} us   [de-boxed; USE_VEC]");
    println!(
        "  columnar scalar floor           {scalar_us:>8.2} us   ({:.0}x cheaper)",
        vec_pred / scalar_us
    );
    println!(
        "  columnar 'simd' floor           {simd_us:>8.2} us   ({:.0}x cheaper)   [scalar on x86 — no AVX path yet]",
        vec_pred / simd_us
    );
}
