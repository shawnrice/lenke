//! Perf-lever benchmark: isolates the query shapes targeted by the four
//! optimization levers so before/after numbers stay comparable across changes.
//!
//!   #2 fused aggregate scan  -> agg_avg / agg_sum / agg_minmax
//!   #3 relationship-first    -> trav_count / trav_filter
//!   #1 intra-query parallel  -> scan_filter / group_by / trav_* (scale w/ cores)
//!   #4 CSR read-snapshot     -> trav_2hop (cache-locality sensitive)
//!
//! Build + run (from crates/lenke-core):
//!   cargo build --release --example perf_bench
//!   ./target/release/examples/perf_bench [vertices] [edges_per_vertex]
//! With the parallel-query feature (lever #1):
//!   cargo build --release --features parallel-query --example perf_bench
//!
//! One graph is built once; each shape is timed with auto-scaled iterations so a
//! fast query runs many times and a slow one a few, all to ~the same wall budget.

use std::time::Instant;

use lenke_core::gql::eval::Params;
use lenke_core::gql::prepare;
use lenke_core::graph::{Builder, EdgeRec, Graph, NodeRec, Value};

/// xorshift — deterministic edges so every run/lever sees the identical graph.
struct Rng(u64);
impl Rng {
    fn below(&mut self, n: usize) -> usize {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x % n as u64) as usize
    }
}

fn build(n: usize, eper: usize) -> Graph {
    let mut b = Builder::default();
    for i in 0..n {
        b.nodes.push(NodeRec {
            id: format!("p{i}"),
            labels: vec!["Person".to_string()],
            props: vec![
                ("age".to_string(), Value::Num((18 + (i % 62)) as f64)),
                // `name`: high cardinality (unique). `city`: low cardinality (~50).
                ("name".to_string(), Value::Str(format!("name{i}").into())),
                (
                    "city".to_string(),
                    Value::Str(format!("city{}", i % 50).into()),
                ),
            ],
        });
    }
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for i in 0..n {
        for _ in 0..eper {
            b.edges.push(EdgeRec {
                src: format!("p{i}"),
                dst: format!("p{}", rng.below(n)),
                etype: "KNOWS".to_string(),
                props: vec![],
                id: None,
            });
        }
    }
    b.finalize()
}

/// Time `q` over `g`, auto-scaling iterations to ~a fixed wall budget. Returns
/// (mean_ms, rows). The first execute warms caches / any lazy structures.
fn bench(g: &mut Graph, q: &str) -> (f64, i64) {
    let plan = prepare(q).unwrap();
    let p = Params::new();
    let first = plan.execute(g, &p).unwrap(); // warm
    let rows = first.nrows as i64;
    let t0 = Instant::now();
    let _ = plan.execute(g, &p).unwrap();
    let one = t0.elapsed().as_secs_f64();
    let iters = (0.4 / one).clamp(3.0, 500.0) as u32;
    let t = Instant::now();
    for _ in 0..iters {
        let _ = plan.execute(g, &p).unwrap();
    }
    (t.elapsed().as_secs_f64() * 1e3 / iters as f64, rows)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: usize = args
        .get(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1_000_000);
    let eper: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(8);

    let t = Instant::now();
    let mut g = build(n, eper);
    println!(
        "\nN={} vertices, {} edges  (built {:.1}s)   parallel-query={}",
        g.vertex_count(),
        g.edge_count(),
        t.elapsed().as_secs_f64(),
        cfg!(feature = "parallel-query"),
    );

    // (shape label, lever tag, query)
    let shapes: &[(&str, &str, &str)] = &[
        ("agg_avg", "#2", "MATCH (n:Person) RETURN avg(n.age) AS a"),
        ("agg_sum", "#2", "MATCH (n:Person) RETURN sum(n.age) AS s"),
        (
            "agg_minmax",
            "#2",
            "MATCH (n:Person) RETURN min(n.age) AS a, max(n.age) AS b",
        ),
        (
            "scan_filter",
            "#1/#2",
            "MATCH (n:Person) WHERE n.age = 42 RETURN count(*) AS c",
        ),
        (
            "group_by",
            "#1",
            "MATCH (n:Person) RETURN n.age AS age, count(*) AS c",
        ),
        (
            "trav_count",
            "#3/#4",
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c",
        ),
        (
            "trav_count_bare",
            "#3",
            "MATCH ()-[:KNOWS]->() RETURN count(*) AS c",
        ),
        (
            "trav_filter",
            "#1/#3",
            "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 40 RETURN count(*) AS c",
        ),
        (
            "trav_2hop",
            "#4",
            "MATCH (a:Person)-[:KNOWS]->()-[:KNOWS]->(b) RETURN count(*) AS c",
        ),
        // String comparison: present literal, absent literal (all-false fast path),
        // and a DISTINCT count that folds through the scalar val_key path.
        (
            "str_eq_present",
            "#6b",
            "MATCH (n:Person) WHERE n.name = 'name500000' RETURN count(*) AS c",
        ),
        (
            "str_eq_absent",
            "#6b",
            "MATCH (n:Person) WHERE n.name = 'zzz_absent' RETURN count(*) AS c",
        ),
        (
            "str_distinct",
            "#6b",
            "MATCH (n:Person) RETURN count(DISTINCT n.city) AS c",
        ),
        // Row-returning shapes — exercise projection + output materialization
        // (Val→Value boxing, node→Map building), not just a scalar count.
        (
            "rows_scalar",
            "out",
            "MATCH (n:Person) WHERE n.age > 40 RETURN n.name AS name, n.age AS age",
        ),
        (
            "rows_orderby",
            "out",
            "MATCH (n:Person) RETURN n.name AS name ORDER BY n.age DESC, n.name LIMIT 100",
        ),
        (
            "rows_node",
            "out",
            "MATCH (n:Person) WHERE n.age > 60 RETURN n",
        ),
        (
            "trav_rows",
            "out",
            "MATCH (a:Person)-[:KNOWS]->(b) RETURN a.name AS an, b.age AS ba",
        ),
    ];

    println!("  {:<14} {:<7} {:>11}   rows", "shape", "lever", "ms");
    for (label, lever, q) in shapes {
        let (ms, rows) = bench(&mut g, q);
        println!("  {label:<14} {lever:<7} {ms:>11.3}   {rows}");
    }

    std::hint::black_box(&g);
}
