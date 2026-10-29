//! Which PLAN does each surface produce for `ORDER BY <bool> LIMIT k`? (item 1178)
//!
//! Item 1175's boolean top-K arm is reached through GQL (0.00 ms) and NOT through Gremlin
//! (2.31 ms), while the NUMERIC spelling of the same question costs 1.12 against 1.54 — so the
//! gap is not general surface overhead. `try_scan_top_k` requires `Plan::Scan` as its input and
//! the lift (`top_k_liftable`) requires a bare `Scan` under the projection, so the question is
//! what each surface actually hands it.
//!
//!   cargo run --release --example boolorder_plan_1178
use lenke_engine::store::Builder;
use lenke_engine::value::Value;

fn main() {
    let mut b = Builder::default();
    for i in 0..2000u32 {
        b.node(
            &["Person"],
            &[
                ("age", Value::Num(f64::from(i % 90))),
                ("flag", Value::Bool(i % 2 == 0)),
            ],
        );
    }
    let store = b.build();

    for (surface, q) in [
        (
            "gql  bool",
            "MATCH (a:Person) RETURN a.flag AS v ORDER BY a.flag LIMIT 5",
        ),
        (
            "gql  num ",
            "MATCH (a:Person) RETURN a.age AS v ORDER BY a.age LIMIT 5",
        ),
        // Does a GQL `WHERE` survive as a `Filter` NODE, or is it lifted into the scan? That is
        // what decides whether item 1180's mutant M3 (treating any filter as a presence test) is
        // reachable at all.
        (
            "gql  where=",
            "MATCH (a:Person) WHERE a.flag = true RETURN a.flag AS v ORDER BY a.flag LIMIT 5",
        ),
        (
            "gql  where>",
            "MATCH (a:Person) WHERE a.age > 5 RETURN a.flag AS v ORDER BY a.flag LIMIT 5",
        ),
    ] {
        let raw = lenke_engine::gql::parse(q).expect("parses");
        let plan = lenke_engine::opt::optimize_indexed(raw, &store);

        println!("\n=== {surface}  {q}\n{plan:?}");
    }

    for (surface, q) in [
        ("grem bool", "g.V().values('flag').order().limit(5)"),
        ("grem num ", "g.V().values('age').order().limit(5)"),
        // A presence filter on a DIFFERENT key than the sort key — the shape
        // `scan_for_top_k`'s `fk == key` condition exists to refuse (item 1180, mutants M2/M3).
        (
            "grem has(other)",
            "g.V().has('age').values('flag').order().limit(5)",
        ),
        (
            "grem hasLabel",
            "g.V().hasLabel('Person').values('flag').order().limit(5)",
        ),
    ] {
        let raw = lenke_engine::gremlin::parse(q).expect("parses");
        let plan = lenke_engine::opt::optimize_indexed(raw, &store);

        println!("\n=== {surface}  {q}\n{plan:?}");
    }
}
