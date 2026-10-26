//! Item 871: which column REPRESENTATIONS does a filtered scan have a fast path for?
//!
//! The census move, applied to the filter family. `fastpath.rs` carries `try_stream_num_count`,
//! `try_stream_range_count`, `try_stream_dict_pred_count`, `try_stream_membership_count`,
//! `try_filter_keep_dict`, `try_filtered_scan_num_agg` and `try_filtered_scan_str_agg` — so
//! numeric, dictionary and string predicates are named in the function list and BOOL and TEMPORAL
//! are not. Items 840-858 found exactly that shape in the aggregate and DISTINCT families, where
//! the missing temporal arms were worth 2.6-36x.
//!
//! The fixture's five columns differ ONLY in representation, and each predicate is built to select
//! the SAME 1/50 of rows (the bool is 1/2 — a bool cannot be more selective than that, and the
//! row count is printed so it cannot be mistaken for a like-for-like ratio).
//!
//! Each representation is measured against TWO of its own controls, because a filtered count can
//! be slower for three different reasons and only the pair separates them:
//!   - `count(*)` with no filter: reads no property at all, the floor.
//!   - `WHERE true`: runs the filter machinery over every row but keeps them all. This is THE
//!     control for "why is the filtered version slower" — if `WHERE <pred>` and `WHERE true` agree,
//!     the predicate is free and the cost is the scan; if they diverge, the predicate is the cost.
use lenke_engine::store::{Builder, Store};
use lenke_engine::temporal::Temporal;
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(n: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        let m = i % 50;
        b.node(
            &["P"],
            &[
                // Num: 50 distinct
                ("num", Value::Num(f64::from(m))),
                // Dict: 50 distinct strings, under the dictionary cap
                ("dct", Value::Str(format!("d{m}").into())),
                // Str: 8,000 distinct, OVER the 4,096 cap, so it stays a plain string column
                ("str", Value::Str(format!("s{:05}", i % 8_000).into())),
                // Bool: 2 distinct
                ("bul", Value::Bool(m == 7)),
                // Temporal: 50 distinct dates
                (
                    "dat",
                    Value::Temporal(Temporal::Date(lenke_engine::temporal::Date {
                        days: 19_723 + i32::try_from(m).unwrap_or(0),
                    })),
                ),
            ],
        );
    }
    b.build()
}

fn probe(q: &str, store: &Store, reps: u32) -> Result<(f64, f64), String> {
    let raw = lenke_engine::gql::parse(q)?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut got = 0.0;
    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e6);
        if let Some(row) = out.rows.iter().next() {
            if let Value::Num(x) = &row[0] {
                got = *x;
            }
        }
    }
    Ok((best, got))
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

    println!(
        "# item 871 — filtered count by column representation, {n} nodes, min of {reps} (us)\n"
    );
    for (rep, key) in [
        ("Num", "num"),
        ("Dict", "dct"),
        ("Str", "str"),
        ("Bool", "bul"),
        ("Date", "dat"),
    ] {
        let present = store.column(key).is_some();
        println!("-- {rep:5} key={key} column_present={present}");
    }
    println!();

    let cases: [(&str, &str); 13] = [
        ("floor  count(*)", "MATCH (p:P) RETURN count(*) AS c"),
        (
            "Num   = 7",
            "MATCH (p:P) WHERE p.num = 7 RETURN count(*) AS c",
        ),
        (
            "Num   WHERE true",
            "MATCH (p:P) WHERE true RETURN count(*) AS c",
        ),
        (
            "Num   > 25",
            "MATCH (p:P) WHERE p.num > 25 RETURN count(*) AS c",
        ),
        (
            "Dict  = 'd7'",
            "MATCH (p:P) WHERE p.dct = 'd7' RETURN count(*) AS c",
        ),
        (
            "Dict  > 'd7'",
            "MATCH (p:P) WHERE p.dct > 'd7' RETURN count(*) AS c",
        ),
        (
            "Str   = 's00007'",
            "MATCH (p:P) WHERE p.str = 's00007' RETURN count(*) AS c",
        ),
        (
            "Str   > 's00007'",
            "MATCH (p:P) WHERE p.str > 's00007' RETURN count(*) AS c",
        ),
        (
            "Bool  = true",
            "MATCH (p:P) WHERE p.bul = true RETURN count(*) AS c",
        ),
        ("Bool  bare", "MATCH (p:P) WHERE p.bul RETURN count(*) AS c"),
        (
            "Date  = 19730",
            "MATCH (p:P) WHERE p.dat = DATE '2024-01-08' RETURN count(*) AS c",
        ),
        (
            "Date  >= 19730",
            "MATCH (p:P) WHERE p.dat >= DATE '2024-01-08' RETURN count(*) AS c",
        ),
        (
            "Date  IS NOT NULL",
            "MATCH (p:P) WHERE p.dat IS NOT NULL RETURN count(*) AS c",
        ),
    ];
    if std::env::var("XKIND").is_ok() {
        // What does the GENERAL path do for a cross-KIND temporal comparison? If it throws, a
        // fast path that returned 0 instead would be a WRONG ANSWER, which is what the date
        // path's `kind` guard exists to prevent.
        for q in [
            "MATCH (p:P) WHERE p.dat = DATETIME '2024-01-08T00:00:00' RETURN count(*) AS c",
            "MATCH (p:P) WHERE p.dat >= DATETIME '2024-01-08T00:00:00' RETURN count(*) AS c",
            "MATCH (p:P) WHERE p.dat >= TIME '12:00:00' RETURN count(*) AS c",
            "MATCH (p:P) WHERE p.num >= 'text' RETURN count(*) AS c",
        ] {
            let raw = lenke_engine::gql::parse(q).unwrap();
            let plan = lenke_engine::opt::optimize_indexed(raw, &store);
            match lenke_engine::exec::try_run(&plan, &store) {
                Ok(out) => println!(
                    "OK   {q}\n     -> {:?}",
                    out.rows.iter().next().map(|r| format!("{:?}", r[0]))
                ),
                Err(e) => println!("ERR  {q}\n     -> {e}"),
            }
        }
        return;
    }
    if std::env::var("PLAN").is_ok() {
        for q in [
            "MATCH (p:P) WHERE p.dat = DATE '2024-01-08' RETURN count(*) AS c",
            "MATCH (p:P) WHERE p.dat >= DATE '2024-01-08' RETURN count(*) AS c",
            "MATCH (p:P) WHERE p.num = 7 RETURN count(*) AS c",
        ] {
            let raw = lenke_engine::gql::parse(q).unwrap();
            let plan = lenke_engine::opt::optimize_indexed(raw, &store);
            println!("\nQ: {q}\n{plan:?}");
        }
        return;
    }
    for (label, q) in cases {
        match probe(q, &store, reps) {
            Ok((us, rows)) => println!("{label:22} {us:10.1} us  {rows:9.0} rows"),
            Err(e) => println!("{label:22}        n/a  {e}"),
        }
    }
}
