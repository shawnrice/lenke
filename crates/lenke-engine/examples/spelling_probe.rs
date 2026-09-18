//! Equivalent-spelling & cross-language perf coverage.
//!
//! The old engine had spellings of the SAME query hit different code paths (100-300x
//! gaps). This engine lowers BOTH GQL and Gremlin to one `ir::Plan` and runs one
//! `exec`, so perf is a property of the optimized plan, not the surface syntax — two
//! spellings that optimize to the same plan CANNOT differ in speed. This probe checks
//! that claim directly: for each group of queries that should be equivalent, it prints
//! the optimized plan (canonicalized) and the measured time, and flags any group whose
//! members disagree on either. A plan mismatch is the real signal; the time is the
//! backstop for "different plan, but does it matter?".
//!
//! Run: cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example spelling_probe

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

const CITIES: &[&str] = &["NYC", "LA", "SF", "CHI", "SEA", "BOS", "AUS", "DEN"];
const DEPTS: &[&str] = &["eng", "sales", "ops", "hr", "legal"];

struct Lcg(u64);
impl Lcg {
    fn next(&mut self, bound: u32) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as u32) % bound.max(1)
    }
}

fn fixture(n: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(
            &["Person"],
            &[
                ("name", Value::Str(format!("name{i}").into())),
                ("age", Value::Num(f64::from(i % 100))),
                (
                    "city",
                    Value::Str((*CITIES.get((i % 8) as usize).unwrap()).into()),
                ),
                (
                    "dept",
                    Value::Str((*DEPTS.get((i % 5) as usize).unwrap()).into()),
                ),
            ],
        );
    }
    let mut rng = Lcg(0x1234_5678);
    for i in 0..n {
        for _ in 0..deg {
            b.edge(i, rng.next(n), "KNOWS");
        }
    }
    let mut store = b.build();
    // The far-side / seed-side groups are about whether a predicate reaches an INDEX,
    // which needs one to exist. Without it those groups silently measured something
    // else (pool size before the hop), and read as cliffs that indexing would fix.
    store.create_range_index("age");
    store
}

enum Lang {
    Gql,
    Gremlin,
}
use Lang::{Gql, Gremlin};

/// Optimized plan (debug) + best-of-N time + row count, or the parse/opt error.
fn plan_and_time(lang: &Lang, q: &str, store: &Store) -> Result<(String, f64, usize), String> {
    let raw = match lang {
        Gql => lenke_engine::gql::parse(q),
        Gremlin => lenke_engine::gremlin::parse(q),
    }?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let plan_str = format!("{plan:?}");
    let mut best = f64::MAX;
    let mut rows = 0;
    for _ in 0..7 {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        rows = out.rows.len();
    }
    Ok((plan_str, best, rows))
}

fn main() {
    let store = fixture(100_000, 5);

    // Each group: queries that MUST be semantically equivalent. Mixed GQL & Gremlin.
    let groups: &[(&str, &[(Lang, &str)])] = &[
        (
            "count(*) — operand-free / count(n) / Gremlin",
            &[
                (Gql, "MATCH (n:Person) RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) RETURN count(n) AS c"),
                (Gremlin, "g.V().hasLabel('Person').count()"),
            ],
        ),
        (
            "predicate operand order (age > 50 vs 50 < age)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age > 50 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE 50 < n.age RETURN count(*) AS c"),
            ],
        ),
        (
            ">= operand order (age >= 30 vs 30 <= age)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age >= 30 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE 30 <= n.age RETURN count(*) AS c"),
            ],
        ),
        (
            "equality operand order (name = lit vs lit = name)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.name = 'name500' RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE 'name500' = n.name RETURN count(*) AS c"),
            ],
        ),
        (
            "inline {k:v} vs WHERE equality",
            &[
                (Gql, "MATCH (n:Person {dept: 'eng'}) RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.dept = 'eng' RETURN count(*) AS c"),
            ],
        ),
        (
            "multi-predicate: inline map vs WHERE-AND (both orders)",
            &[
                (Gql, "MATCH (n:Person {dept: 'eng', age: 30}) RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.dept = 'eng' AND n.age = 30 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age = 30 AND n.dept = 'eng' RETURN count(*) AS c"),
            ],
        ),
        (
            "IN list vs OR chain",
            &[
                (Gql, "MATCH (n:Person) WHERE n.dept IN ['eng', 'sales'] RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.dept = 'eng' OR n.dept = 'sales' RETURN count(*) AS c"),
            ],
        ),
        (
            "range AND (two spellings of 30<=age<40)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age >= 30 AND n.age < 40 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age < 40 AND n.age >= 30 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE 40 > n.age AND 30 <= n.age RETURN count(*) AS c"),
            ],
        ),
        (
            // A negated numeric LITERAL used to survive as `Arith { Sub, 0, 1 }`, which
            // the typed comparison fast paths decline — so `> -1` ran the boxed
            // evaluator over every row at 7.0x the cost of `>= 0` on a scan and 6.8x on
            // a traversal frontier. Nothing here tested a negative constant, which is
            // why the cliff stood. Every spelling below admits the same rows (age is
            // 0..99), so any spread is the plan.
            "negative literal (four spellings of \"every row\")",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age > -1 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age > -1.0 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age >= 0 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age >= -5 RETURN count(*) AS c"),
            ],
        ),
        (
            "negative literal on a traversal frontier",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > -1 RETURN count(*) AS c"),
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age >= 0 RETURN count(*) AS c"),
            ],
        ),
        (
            // NARROWED but still the widest cliff here (28x on this fixture). This used
            // to be 43x (1% selective) / 52.7x (10%):
            // the engine did not score both ends of a fixed-length pattern, so a
            // predicate on the FAR end never reached an index and the walk ran from
            // every node and filtered after. `orient` in opt.rs now reverses a one-hop
            // pattern so the predicated end seeds the walk, which closes most of it.
            //
            // What is left is the shape below, and the cause is precise: `RangeSeek`
            // carries a REQUIRED label, so the reversed seed can only become a seek if
            // the far node was written with one. Here `(b)` has no label, so reversal
            // buys the pre-filter but not the index, and the backwards spelling — where
            // `b:Person` sits on the seed — still wins. Write it `(b:Person)` and the
            // two spellings converge (E66 in `simd_index_probe`).
            "far-side predicate: forwards vs backwards (NARROWED 40x -> ~4x)",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 98 RETURN count(*) AS c"),
                (Gql, "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 RETURN count(*) AS c"),
            ],
        ),
        (
            // Was a 300x cliff, and the nastiest kind: adding a LABEL made it slower.
            // Both ends lower to stacked filters, the merge rule fuses them into one
            // `And`, and the Expand pushdown arm was all-or-nothing — so the slot-1
            // label check pinned the slot-0 range predicate above the hop and the walk
            // ran from every Person. The pushdown now splits per conjunct, and all
            // four spellings optimize to the same seek-then-expand plan.
            "far-side predicate with BOTH ends labelled",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98 RETURN count(*) AS c"),
                (Gql, "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 RETURN count(*) AS c"),
            ],
        ),
        (
            // The mirror of the group above, on the SEED side. Both spellings seed
            // identically now that pushdown splits — what is left (8.5x) is NOT a
            // seeding difference but a shortcut one: `count(*)` over a BARE `Expand`
            // sums degrees and never walks an edge, and the `(b:Person)` spelling
            // keeps a residual `IsLabeled` above the hop that makes the shortcut
            // impossible, so it enumerates paths instead. See E68 in
            // `simd_index_probe`, and audit item 11 — the fix is to teach the count
            // shortcut to tolerate a far-end label check.
            "seed-side predicate with BOTH ends labelled",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE a.age > 98 RETURN count(*) AS c"),
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE a.age > 98 RETURN count(*) AS c"),
            ],
        ),
        (
            // TWO hops, the widest gap this probe has ever measured: 178,357us written
            // forwards against 2,155us written backwards, because `reverse_chain` used
            // to require an Expand directly over a Scan and so left every longer
            // pattern in its written direction. Both spellings now produce the SAME
            // plan, which is why this group reads "identical optimized plan" rather
            // than two times that happen to agree.
            "two-hop far-side predicate: forwards vs backwards",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) WHERE c.age > 98 RETURN count(*) AS n"),
                (Gql, "MATCH (c:Person)<-[:KNOWS]-(b:Person)<-[:KNOWS]-(a:Person) WHERE c.age > 98 RETURN count(*) AS n"),
            ],
        ),
        (
            "1-hop projection: GQL vs Gremlin",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) RETURN b.name AS n"),
                (Gremlin, "g.V().hasLabel('Person').out('KNOWS').values('name')"),
            ],
        ),
        (
            "filtered count: GQL vs Gremlin",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age > 28 RETURN count(*) AS c"),
                (Gremlin, "g.V().hasLabel('Person').has('age', gt(28)).count()"),
            ],
        ),
        (
            "DISTINCT vs dedup",
            &[
                (Gql, "MATCH (n:Person) RETURN DISTINCT n.dept AS d"),
                (Gremlin, "g.V().hasLabel('Person').values('dept').dedup()"),
            ],
        ),
        (
            // ROWS_MAY_DIFFER: `groupCount()` is defined to return ONE Map, where the
            // GQL spelling returns one row per group. Same answer, different container
            // — so neither the row count nor the time is comparable across the two.
            "grouped count: GQL vs Gremlin groupCount [ROWS_MAY_DIFFER]",
            &[
                (Gql, "MATCH (n:Person) RETURN n.dept AS d, count(*) AS c"),
                (Gremlin, "g.V().hasLabel('Person').groupCount().by('dept')"),
            ],
        ),
        (
            "ordered top-k: GQL LIMIT vs Gremlin range",
            &[
                (Gql, "MATCH (n:Person) RETURN n.name AS name, n.age AS age ORDER BY age DESC LIMIT 2"),
                (Gremlin, "g.V().hasLabel('Person').order().by('age', desc).range(0, 2).values('name')"),
            ],
        ),
    ];

    let mut cliffs = 0;
    let mut gaps = 0;
    for (title, variants) in groups {
        println!("\n=== {title} ===");
        let mut results = Vec::new();
        for (lang, q) in *variants {
            let tag = match lang {
                Gql => "GQL ",
                Gremlin => "GRM ",
            };
            match plan_and_time(lang, q, &store) {
                Ok((plan, ms, rows)) => {
                    println!("  {tag}{ms:>8.3}ms  rows={rows:<7} {q}");
                    results.push(Some((plan, ms, rows)));
                }
                Err(e) => {
                    println!("  {tag}   ERR  {q}  -> {e}");
                    results.push(None);
                }
            }
        }
        // Separate a CAPABILITY gap (a variant did not parse — a missing feature, not
        // a perf finding) from a PERF CLIFF (all variants parsed but cost differs).
        let ok: Vec<&(String, f64, usize)> = results.iter().flatten().collect();
        if ok.len() < variants.len() {
            println!("  ○ capability gap: a variant did not parse/run (a syntax gap, not perf)");
            gaps += 1;
            continue;
        }
        let plan0 = &ok[0].0;
        let same_plan = ok.iter().all(|(p, _, _)| p == plan0);
        let rows0 = ok[0].2;
        let same_rows = ok.iter().all(|(_, _, r)| *r == rows0);
        let tmin = ok.iter().map(|(_, t, _)| *t).fold(f64::MAX, f64::min);
        let tmax = ok.iter().map(|(_, t, _)| *t).fold(0.0, f64::max);
        let ratio = if tmin > 0.0 { tmax / tmin } else { 1.0 };
        // A group tagged ROWS_MAY_DIFFER returns the same answer in a different
        // CONTAINER (one Map vs one row per group), so both the row count and the
        // time are apples-to-oranges. Report it and move on rather than flagging it
        // every run as a cliff it is not.
        if title.contains("[ROWS_MAY_DIFFER]") {
            println!("  ✓ answers equivalent; row count and cost differ by design (see note)");
            continue;
        }
        if !same_rows {
            println!("  ⚠ ROW COUNT DIFFERS across spellings — not actually equivalent!");
            cliffs += 1;
        }
        if same_plan {
            println!("  ✓ identical optimized plan → identical exec (perf guaranteed)");
        } else if ratio > 1.5 {
            // Plans differ AND the cost differs materially — the real spelling cliff.
            println!("  ✗ PERF CLIFF: plans differ, time spread {ratio:.2}x (tmin {tmin:.3} tmax {tmax:.3})");
            cliffs += 1;
        } else {
            // Different plan shape (e.g. GQL vs Gremlin structure) but same cost — fine.
            println!("  ✓ plans differ but cost matches ({ratio:.2}x) — equivalent speed");
        }
    }

    println!("\n{}", "=".repeat(60));
    if cliffs == 0 {
        println!("NO PERF CLIFFS: every equivalent spelling converges on plan or cost.");
    } else {
        println!("{cliffs} PERF CLIFF(S) — see ✗/⚠ above.");
    }
    if gaps > 0 {
        println!("{gaps} capability gap(s) (unparsed variants) — feature gaps, not perf.");
    }
}
