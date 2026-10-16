//! Item 401: WHICH PREDICATE SPELLINGS SEED AN INDEX. Every index-seeding bug this engine has
//! had took one shape — the planner recognized one spelling and scanned for another that meant
//! exactly the same thing — and each cost 100-300x while returning the correct answer, so no
//! correctness test could catch it (see the repo's "equivalent spellings must cost the same").
//!
//! `spelling_probe` checks that equivalent spellings reach the SAME plan. This asks the prior
//! question for one family: of all the ways to write a seedable predicate, which ones actually
//! produce a `RangeSeek`/`IndexSeek` at all. A spelling that scans is the missing path.
//!
//! The answer is read off the PLAN, not the clock: a scan that happens to be fast on this
//! fixture is still the bug.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        // `city` carries a HASH index and `city_r` the same strings with a RANGE index, so a
        // PREFIX question can be asked of a structure able to answer it. `sparse` is present on
        // 1% of nodes: a presence test on a key every node has cannot show what seeding it from
        // the index would save. Both omissions were the fixture error item 402 made.
        let city = if i % 7 == 0 { "oslo" } else { "bergen" };
        let mut props: Vec<(&str, Value)> = vec![
            ("uid", Value::Num(f64::from(i))),
            ("age", Value::Num(f64::from(i % 90))),
            ("city", Value::Str(city.into())),
            ("city_r", Value::Str(city.into())),
        ];
        if i % 100 == 0 {
            props.push(("sparse", Value::Num(f64::from(i))));
        }
        b.node(&["Person"], &props);
    }
    let mut x = 12345u64;
    for i in 0..n {
        for _ in 0..deg {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            b.edge(i, (x % u64::from(n)) as u32, "KNOWS");
        }
    }
    let mut s = b.build();
    s.create_range_index("age");
    s.create_range_index("uid");
    s.create_index("city");
    s.create_range_index("city_r");
    s.create_range_index("sparse");
    s
}

fn probe(q: &str, store: &Store) -> Result<(bool, f64, usize), String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let text = format!("{plan:?}");
    let seeded = text.contains("RangeSeek") || text.contains("IndexSeek");
    let mut best = f64::MAX;
    let mut rows = 0;
    for _ in 0..5 {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        rows = out.rows.len();
    }
    Ok((seeded, best, rows))
}

fn main() {
    let store = fixture(200_000, 2);
    // Each group is one QUESTION written several ways. Every member must agree on `seeded`,
    // and they must agree on the answer — the row count is printed so a spelling that seeds by
    // changing the question is visible too.
    let groups: &[(&str, &[&str])] = &[
        (
            "range, numeric",
            &[
                "MATCH (n:Person) WHERE n.age > 88 RETURN count(*) AS c",
                "MATCH (n:Person) WHERE 88 < n.age RETURN count(*) AS c",
                "MATCH (n:Person) WHERE NOT (n.age <= 88) RETURN count(*) AS c",
            ],
        ),
        (
            "equality, numeric",
            &[
                "MATCH (n:Person) WHERE n.age = 88 RETURN count(*) AS c",
                "MATCH (n:Person) WHERE 88 = n.age RETURN count(*) AS c",
                "MATCH (n:Person {age: 88}) RETURN count(*) AS c",
            ],
        ),
        (
            "equality, string",
            &[
                "MATCH (n:Person) WHERE n.city = 'oslo' RETURN count(*) AS c",
                "MATCH (n:Person) WHERE 'oslo' = n.city RETURN count(*) AS c",
                "MATCH (n:Person {city: 'oslo'}) RETURN count(*) AS c",
            ],
        ),
        // `age` has a RANGE index and `city` an EQUALITY index. The multi-value seed rung
        // (items 263/264) is an equality rung, so testing `IN` over the range-indexed key
        // measures the FIXTURE, not the planner — both groups are here for that reason.
        (
            "set membership over a RANGE-indexed key",
            &[
                "MATCH (n:Person) WHERE n.age IN [88, 89] RETURN count(*) AS c",
                "MATCH (n:Person) WHERE n.age = 88 OR n.age = 89 RETURN count(*) AS c",
            ],
        ),
        // The PRICE of the gap, on a key where it can matter: 200,000 distinct values, so a
        // two-term `IN` wants two point seeks and gets a whole-store scan.
        (
            "set membership over a SELECTIVE range-indexed key",
            &[
                "MATCH (n:Person) WHERE n.uid IN [77, 1234] RETURN count(*) AS c",
                "MATCH (n:Person) WHERE n.uid = 77 OR n.uid = 1234 RETURN count(*) AS c",
                "MATCH (n:Person) WHERE n.uid = 77 RETURN count(*) AS c",
            ],
        ),
        (
            "set membership over an EQUALITY-indexed key",
            &[
                "MATCH (n:Person) WHERE n.city IN ['oslo', 'troms'] RETURN count(*) AS c",
                "MATCH (n:Person) WHERE n.city = 'oslo' OR n.city = 'troms' RETURN count(*) AS c",
            ],
        ),
        (
            "bounded range (two-sided)",
            &[
                "MATCH (n:Person) WHERE n.age > 80 AND n.age < 85 RETURN count(*) AS c",
                "MATCH (n:Person) WHERE n.age < 85 AND n.age > 80 RETURN count(*) AS c",
                "MATCH (n:Person) WHERE 80 < n.age AND 85 > n.age RETURN count(*) AS c",
            ],
        ),
        (
            "range + an unrelated conjunct",
            &[
                "MATCH (n:Person) WHERE n.age > 88 AND n.city = 'oslo' RETURN count(*) AS c",
                "MATCH (n:Person) WHERE n.city = 'oslo' AND n.age > 88 RETURN count(*) AS c",
            ],
        ),
        // Spellings a range index could in principle serve but may not: a PREFIX is a range
        // ['os', 'ot'), and `IS NOT NULL` is the whole index, since the index holds only
        // non-null present values.
        (
            "prefix match",
            &[
                "MATCH (n:Person) WHERE n.city_r STARTS WITH 'os' RETURN count(*) AS c",
                "MATCH (n:Person) WHERE n.city_r >= 'os' AND n.city_r < 'ot' RETURN count(*) AS c",
            ],
        ),
        (
            "presence",
            &[
                "MATCH (n:Person) WHERE n.sparse IS NOT NULL RETURN count(*) AS c",
                "MATCH (n:Person) WHERE n.sparse > -1 RETURN count(*) AS c",
            ],
        ),
        // Is the `IS NOT NULL` cost per ROW or per RESULT? A dense key and a sparse one have
        // the same row count and 100x different result sizes. Same answer both ways tells you
        // the cost is the column materialization, not the predicate.
        (
            "presence, dense key (diagnostic)",
            &["MATCH (n:Person) WHERE n.age IS NOT NULL RETURN count(*) AS c"],
        ),
        (
            "presence, no index at all (diagnostic)",
            &["MATCH (n:Person) WHERE n.nokey IS NOT NULL RETURN count(*) AS c"],
        ),
        (
            "CONTROL unseedable",
            &["MATCH (n:Person) WHERE n.age + 0 > 88 RETURN count(*) AS c"],
        ),
    ];

    let mut flagged = 0;
    for (name, qs) in groups {
        println!("\n=== {name}");
        let mut seen: Vec<(bool, usize)> = Vec::new();
        for q in *qs {
            match probe(q, &store) {
                Ok((seeded, ms, rows)) => {
                    let n_rows = rows;
                    seen.push((seeded, n_rows));
                    let mark = if seeded { "SEEK" } else { "scan" };
                    println!("  {mark}  {ms:>8.3} ms  rows={n_rows}  {q}");
                    if std::env::var("SHOW_SEED").is_ok() {
                        let raw2 = lenke_engine::gql::parse(q).unwrap();
                        let pl = format!("{:?}", lenke_engine::opt::optimize_indexed(raw2, &store));
                        if let Some(i) = pl.find("Seek").map(|i| i.saturating_sub(10)) {
                            println!("        seed: {}", &pl[i..(i + 110).min(pl.len())]);
                        }
                    }
                }
                Err(e) => println!("  ERR   {}  {q}", e.trim()),
            }
        }
        if seen.len() > 1 {
            let first = seen[0];
            if seen.iter().any(|s| s.0 != first.0) {
                println!("  !! SPELLING GAP: members disagree on whether they seed");
                flagged += 1;
            }
            if seen.iter().any(|s| s.1 != first.1) {
                println!("  !! NOT EQUIVALENT: members disagree on the row count");
                flagged += 1;
            }
        }
    }
    println!("\n{flagged} group(s) flagged");
}
