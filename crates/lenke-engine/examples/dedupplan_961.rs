//! Item 961: WHY does `dedup()` cost 1.78x `RETURN DISTINCT` on the same question?
//!
//! `spelling_probe` flags the pair as a perf cliff — `MATCH (n:Person) RETURN DISTINCT n.dept`
//! at 0.086 ms against `g.V().hasLabel('Person').values('dept').dedup()` at 0.152, both five
//! rows. The two surfaces lower to ONE `ir::Plan` and run ONE `exec`, so a cost difference IS a
//! plan difference; this prints both plans so the difference is read rather than guessed.
//!
//! Diagnosis only — no claim about the fix, because the whole point of items 947-949 is that a
//! fix priced against the behaviour instead of the mechanism gets withdrawn one item later.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

const DEPTS: [&str; 5] = ["eng", "sales", "ops", "hr", "legal"];

fn fixture(n: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(
            &["Person"],
            &[("dept", Value::Str(DEPTS[(i as usize) % DEPTS.len()].into()))],
        );
    }
    b.build()
}

fn main() {
    let n: u32 = std::env::var("N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(200_000);
    let reps: u32 = std::env::var("REPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9);
    let store = fixture(n);

    // THE THIRD ARM SEPARATES THE TWO DIFFERENCES. The Gremlin plan differs from the GQL one in
    // TWO ways at once — an extra `Filter { PropertyExists }` (which `values()` semantics
    // REQUIRE: a vertex without the key yields nothing, where `RETURN n.dept` yields null) and
    // `DistinctBy { key_slots: [0] }` in place of `Distinct`. A ratio between the first two arms
    // cannot say which costs what. This arm is GQL carrying the SAME filter, so:
    //   arm3 ~ arm2  -> the gap is the semantically required filter, and there is no defect
    //   arm3 ~ arm1  -> the gap is `DistinctBy` against `Distinct`, which IS a lowering choice
    let pairs: [(&str, &str, &str); 7] = [
        (
            "GQL DISTINCT",
            "gql",
            "MATCH (n:Person) RETURN DISTINCT n.dept AS d",
        ),
        (
            "GRM dedup   ",
            "gremlin",
            "g.V().hasLabel('Person').values('dept').dedup()",
        ),
        (
            "GQL +exists ",
            "gql",
            "MATCH (n:Person) WHERE PROPERTY_EXISTS(n, dept) RETURN DISTINCT n.dept AS d",
        ),
        // Item 962: APPORTION the filtered arm. `try_distinct_scan_prop` requires
        // `Project { Scan }` with NO filter, so arm 3 is the GENERAL `Distinct` path, not the
        // same operator arm 1 runs. These two split its cost: arm 4 is the filter and scan with
        // no dedup at all, arm 5 the unfiltered count. Without them "Distinct costs 2.07x" is a
        // claim about two different code paths wearing one name.
        (
            "GQL filt cnt",
            "gql",
            "MATCH (n:Person) WHERE PROPERTY_EXISTS(n, dept) RETURN count(*) AS c",
        ),
        (
            "GQL bare cnt",
            "gql",
            "MATCH (n:Person) RETURN count(*) AS c",
        ),
        // Item 963: the subtrahend item 962 SHOULD have used. `count(*)` does not materialize
        // `dept` at all, while both dedup arms do — so subtracting it credited the dedup step
        // with the projection's cost. `count(n.dept)` forces the column to be built and still
        // returns one row, which is the closest thing to "everything but the dedup".
        (
            "GQL filt proj",
            "gql",
            "MATCH (n:Person) WHERE PROPERTY_EXISTS(n, dept) RETURN count(n.dept) AS c",
        ),
        // Item 964: does an ORDINARY predicate reach the same shape? The arms above all use
        // PROPERTY_EXISTS, which was chosen to match Gremlin's `values()` semantics — not
        // because it is what a user writes. If a plain comparison gets seeded or fused instead,
        // the whole `Distinct`-under-a-filter target is narrower than it looks.
        (
            "GQL ord pred",
            "gql",
            "MATCH (n:Person) WHERE n.dept > 'a' RETURN DISTINCT n.dept AS d",
        ),
    ];

    println!("# item 961 — `RETURN DISTINCT` against `dedup()`, {n} nodes, min of {reps} (us)\n");

    for (name, lang, q) in pairs {
        let raw = match lang {
            "gql" => lenke_engine::gql::parse(q),
            _ => lenke_engine::gremlin::parse(q),
        };
        match raw {
            Err(e) => println!("  {name} PARSE ERROR {e}"),
            Ok(raw) => {
                let plan = lenke_engine::opt::optimize_indexed(raw, &store);
                let mut best = f64::MAX;
                let mut rows = 0;
                for _ in 0..reps {
                    let t = Instant::now();
                    match lenke_engine::exec::try_run(&plan, &store) {
                        Err(e) => {
                            println!("  {name} RUN ERROR {e}");
                            break;
                        }
                        Ok(out) => {
                            best = best.min(t.elapsed().as_secs_f64() * 1e6);
                            rows = out.rows.len();
                        }
                    }
                }
                println!("  {name} {best:9.1} us   rows={rows}");
                println!("      {plan:?}\n");
            }
        }
    }
}
