//! GQL engine micro-benchmark. Builds a synthetic social graph and times
//! representative query shapes (label scan, join, group/aggregate, projection,
//! EXISTS, var-length), plus prepared-plan vs lower-per-call. Run:
//!   cargo run --release --example gql_bench

use std::time::Instant;

use pl_graph_core::gql::eval::Params;
use pl_graph_core::gql::{parse, prepare};
use pl_graph_core::graph::{Builder, EdgeRec, Graph, NodeRec, Value};

const N: usize = 50_000; // persons
const SOFTWARE: usize = 2_000;
const KNOWS_PER: usize = 4; // out-edges per person

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn build() -> Graph {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut b = Builder::default();
    for i in 0..N {
        let age = 18 + (i % 62);
        b.nodes.push(NodeRec {
            id: format!("p{i}"),
            labels: vec!["Person".to_string()],
            props: vec![
                ("age".to_string(), Value::Num(age as f64)),
                ("name".to_string(), Value::Str(format!("name{i}").into())),
                ("dept".to_string(), Value::Str(format!("d{}", i % 12).into())),
            ],
        });
    }
    for j in 0..SOFTWARE {
        b.nodes.push(NodeRec {
            id: format!("s{j}"),
            labels: vec!["Software".to_string()],
            props: vec![("name".to_string(), Value::Str(format!("sw{j}").into()))],
        });
    }
    for i in 0..N {
        for _ in 0..KNOWS_PER {
            b.edges.push(EdgeRec {
                src: format!("p{i}"),
                dst: format!("p{}", rng.below(N)),
                etype: "KNOWS".to_string(),
                props: vec![],
            });
        }
        // ~half the people create one piece of software
        if i % 2 == 0 {
            b.edges.push(EdgeRec {
                src: format!("p{i}"),
                dst: format!("s{}", rng.below(SOFTWARE)),
                etype: "CREATED".to_string(),
                props: vec![("weight".to_string(), Value::Num(0.5))],
            });
        }
    }
    b.finalize()
}

/// Run `q` `iters` times against `g`, return (avg microseconds, row count).
fn bench(g: &mut Graph, q: &str, iters: u32) -> (f64, usize) {
    let plan = prepare(q).unwrap();
    let params = Params::new();
    let rows = plan.execute(g, &params).unwrap().rows.len(); // warm up + row count
    let t = Instant::now();
    for _ in 0..iters {
        let _ = plan.execute(g, &params).unwrap();
    }
    let us = t.elapsed().as_secs_f64() * 1e6 / iters as f64;
    (us, rows)
}

fn main() {
    let t = Instant::now();
    let mut g = build();
    eprintln!(
        "built graph: {} vertices, {} edges in {:.1} ms\n",
        g.vertex_count(),
        g.edge_count(),
        t.elapsed().as_secs_f64() * 1e3
    );

    let queries: &[(&str, &str, u32)] = &[
        ("label scan + count", "MATCH (n:Person) RETURN count(*) AS c", 200),
        ("scan + filter count", "MATCH (n:Person) WHERE n.age > 50 RETURN count(*) AS c", 200),
        ("projection LIMIT 100", "MATCH (n:Person) RETURN n.name LIMIT 100", 2000),
        ("project many rows", "MATCH (n:Person) WHERE n.age > 30 RETURN n.name, n.age", 100),
        ("1-hop join count", "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c", 100),
        ("group by + aggregate", "MATCH (n:Person) RETURN n.dept, count(*) AS c, avg(n.age) AS a", 100),
        ("exists subquery", "MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->() } RETURN count(*) AS c", 50),
        ("edge prop filter", "MATCH (a:Person)-[r:CREATED]->(s) WHERE r.weight > 0.4 RETURN count(*) AS c", 100),
        ("var-length 1..2", "MATCH (a:Person {name:'name0'})-[:KNOWS]->{1,2}(b) RETURN count(*) AS c", 200),
        ("order by + limit", "MATCH (n:Person) RETURN n.name ORDER BY n.age DESC LIMIT 20", 100),
        // --- expression-heavy (isolates expression eval; the bytecode-VM target) ---
        (
            "expr-heavy filter count",
            "MATCH (n:Person) WHERE (n.age * 2 + 1) % 3 = 0 AND n.age > 20 AND abs(n.age - 40) < 15 RETURN count(*) AS c",
            200,
        ),
        (
            "expr-heavy project",
            "MATCH (n:Person) RETURN n.age * 2 + 10 AS x, abs(n.age - 30) AS y, \
             CASE WHEN n.age >= 30 THEN 'sr' ELSE 'jr' END AS t, (n.age % 7) + sqrt(n.age) AS z",
            100,
        ),
        // --- attribution A/B pairs (subtract to isolate one cost) ---
        ("[a] scan+count", "MATCH (n:Person) RETURN count(*) AS c", 300),
        ("[b] scan+count+pred", "MATCH (n:Person) WHERE n.age >= 0 RETURN count(*) AS c", 300),
        ("[c] project num col", "MATCH (n:Person) RETURN n.age", 200),
        ("[d] project str col", "MATCH (n:Person) RETURN n.name", 200),
        ("[e] 2-hop join count", "MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) RETURN count(*) AS c", 30),
    ];

    println!("{:<26} {:>12} {:>12}", "query", "avg", "rows");
    println!("{}", "-".repeat(52));
    for (label, q, iters) in queries {
        let (us, rows) = bench(&mut g, q, *iters);
        let pretty = if us >= 1000.0 { format!("{:.2} ms", us / 1000.0) } else { format!("{us:.1} us") };
        println!("{label:<26} {pretty:>12} {rows:>12}");
    }

    // Prepared (lower once) vs per-call (lower every run).
    let q = "MATCH (n:Person) WHERE n.name = $who RETURN n.age AS age";
    let mut p = Params::new();
    p.insert("who".to_string(), pl_graph_core::gql::eval::Val::Str("name123".into()));
    let iters = 2000u32;

    let plan = prepare(q).unwrap();
    let t = Instant::now();
    for _ in 0..iters {
        let _ = plan.execute(&mut g, &p).unwrap();
    }
    let prepared_us = t.elapsed().as_secs_f64() * 1e6 / iters as f64;

    let t = Instant::now();
    for _ in 0..iters {
        let _ = parse(q).unwrap().execute(&mut g, &p).unwrap();
    }
    let percall_us = t.elapsed().as_secs_f64() * 1e6 / iters as f64;

    println!("\nprepared vs per-call (point lookup, {iters} iters):");
    println!("  prepared.execute : {prepared_us:.1} us");
    println!("  parse+execute    : {percall_us:.1} us   (+{:.1}us parse/lower)", percall_us - prepared_us);

    // Materialization overhead: the GQL engine builds a binding per matched row;
    // the fingerprint engine folds during the walk (no per-row alloc). Same count.
    let fq = "MATCH (a:Person) RETURN count(*)";
    let fp = pl_graph_core::query::parse(fq).unwrap();
    let t = Instant::now();
    for _ in 0..200 {
        let _ = fp.run(&g);
    }
    let fp_us = t.elapsed().as_secs_f64() * 1e6 / 200.0;
    let (gql_us, _) = bench(&mut g, "MATCH (a:Person) RETURN count(*) AS c", 200);
    println!("\ncount(*) over {} Person — materialization overhead:", N);
    println!("  fingerprint (no per-row alloc) : {fp_us:.1} us");
    println!("  gql (binding per row)          : {gql_us:.1} us   ({:.1}x)", gql_us / fp_us);
}
