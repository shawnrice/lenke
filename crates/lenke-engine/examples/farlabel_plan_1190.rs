//! Does a FAR-ENDPOINT LABEL compile to a `Filter` over the `Expand`? (item 1190)
use lenke_engine::store::Builder;
use lenke_engine::value::Value;

fn main() {
    let mut b = Builder::default();
    for i in 0..50u32 {
        b.node(&["N"], &[("k", Value::Num(f64::from(i)))]);
    }
    for i in 0..40u32 {
        b.edge(i, i + 5, "E");
    }
    let store = b.build();
    for (tag, q) in [
        (
            "far label  ",
            "MATCH (a:N)-[:E]->(c:N) RETURN min(c.k) AS v",
        ),
        ("no far label", "MATCH (a:N)-[:E]->(c) RETURN min(c.k) AS v"),
    ] {
        let plan = lenke_engine::opt::optimize_indexed(
            lenke_engine::gql::parse(q).expect("parses"),
            &store,
        );
        println!("\n=== {tag} {q}\n{plan:?}");
    }
}
