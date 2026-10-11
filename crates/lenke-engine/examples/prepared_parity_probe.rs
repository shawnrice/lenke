//! Would a PARSE CACHE in the native engine change any answer?
//!
//! The native `lnk_query` path calls `gql::parse_with_params_limited` + `opt::optimize_indexed`
//! on EVERY call — there is no parse or plan cache, while the TypeScript engine has had both
//! since audit items 228 and 229. `percall_probe` prices the gap: a serving call is parse 1163ns,
//! optimize 334ns and exec ~300ns, against the prepared path's `clone + bind + optimize` at
//! 456ns — so the ceiling is ~1797 -> ~756ns, **2.38x**.
//!
//! A cache has to hold a plan parsed ONCE and reused with different parameter values, which means
//! parsing in PREPARED mode (`$name` stays an unbound `Expr::Param`, bound per run) rather than
//! direct mode (`$name` is substituted to `Expr::Lit` during the parse). Those are two different
//! parses, so before any cache is built the question is whether they converge:
//!
//!   optimize(parse_with_params(q, params))  ==  optimize(bind(parse_prepared(q), params))  ?
//!
//! If the optimized plans are identical the route is identical, and a cache cannot change a
//! result or a cost. Where they differ — or where prepared mode refuses the query outright, which
//! it documents for `LIMIT`/`SKIP` and literal-only positions — the cache must fall back to the
//! direct path, and this probe's job is to say exactly which shapes those are.
//!
//! WHAT IT FOUND (item 318). Ten of fourteen shapes optimize to the IDENTICAL plan, with and
//! without an index on the gated key — including every seeding shape, which is where a
//! substituted literal could plausibly have seeded an index that a bound param would not. Three
//! carve-outs, and they are the whole design:
//!
//!   1. a param in `LIMIT`/`SKIP` — prepared mode REFUSES, so the fallback is automatic.
//!   2. **a param in an INSERT value — prepared mode ACCEPTS and plans it DIFFERENTLY**, which is
//!      the one that would have shipped quietly. Direct gives
//!      `Insert { nodes: [InsertNode { props: [("name", Str("new"))] }] }`, the literal path;
//!      prepared+bind gives `InsertFrom { input: Row, nodes: [InsertNodeExpr { .. }] }`, the
//!      general expression path. Same answer, different operator — a cache would route every
//!      parameterized INSERT off the fast path, a performance regression with no wrong answer to
//!      give it away. It needs an explicit carve-out, not a fallback that triggers on an error.
//!   3. an unbound param reports `E_MISSING_PARAMETER: unbound parameter $x` from the direct path
//!      and a bare `unbound parameter $x` from bind. **The two shipped paths still AGREE at the
//!      boundary**, because `ffi.rs` sets the code itself for the prepared path rather than
//!      reading it off the message — so this is not an existing divergence. It does mean a cache
//!      inside `lnk_query` has to set that code explicitly too: the direct arm there recovers it
//!      by `strip_prefix`, which a bound-param error never carries.
//!
//! Run: cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example
//!      prepared_parity_probe
use lenke_engine::value::Value;

/// `(label, query, params)` — what a parse cache would actually be asked to hold.
type Case = (&'static str, &'static str, Vec<(String, Value)>);

/// Chosen to cover the shapes that decide the design:
/// the seeding shapes (where a substituted literal could optimize differently from a bound param),
/// the positions prepared mode documents as unsupported, and a few plain shapes as a baseline.
fn cases() -> Vec<Case> {
    let p = |k: &str, v: Value| (k.to_string(), v);

    vec![
        (
            "no params at all",
            "MATCH (u:User) RETURN u.name AS n",
            vec![],
        ),
        (
            "param in an equality (the seeding shape)",
            "MATCH (u:User) WHERE u.name = $n RETURN u.score AS s",
            vec![p("n", Value::Str("name7".into()))],
        ),
        (
            "param REVERSED ($x = u.k)",
            "MATCH (u:User) WHERE $n = u.name RETURN u.score AS s",
            vec![p("n", Value::Str("name7".into()))],
        ),
        (
            "param in an inline property",
            "MATCH (u:User {name: $n}) RETURN u.score AS s",
            vec![p("n", Value::Str("name7".into()))],
        ),
        (
            "param in a range",
            "MATCH (u:User) WHERE u.score >= $lo RETURN u.name AS n",
            vec![p("lo", Value::Num(5.0))],
        ),
        (
            "param in an IN list",
            "MATCH (u:User) WHERE u.name IN $names RETURN u.score AS s",
            vec![p(
                "names",
                Value::List(vec![Value::Str("a".into()), Value::Str("b".into())]),
            )],
        ),
        (
            "two params, one AND",
            "MATCH (u:User) WHERE u.name = $n AND u.score > $lo RETURN u.name AS r",
            vec![p("n", Value::Str("x".into())), p("lo", Value::Num(1.0))],
        ),
        (
            "param in LIMIT (prepared mode documents this as unsupported)",
            "MATCH (u:User) RETURN u.name AS n LIMIT $k",
            vec![p("k", Value::Num(3.0))],
        ),
        (
            "param in SKIP (ditto)",
            "MATCH (u:User) RETURN u.name AS n SKIP $k LIMIT 2",
            vec![p("k", Value::Num(1.0))],
        ),
        (
            "param in an INSERT value (literal-only position)",
            "INSERT (:User {name: $n})",
            vec![p("n", Value::Str("new".into()))],
        ),
        (
            "a two-hop with a param gate",
            "MATCH (a:User)-[:KNOWS]->(b:User) WHERE a.name = $n RETURN b.name AS r",
            vec![p("n", Value::Str("name7".into()))],
        ),
        (
            "an aggregate with a param gate",
            "MATCH (u:User) WHERE u.score > $lo RETURN count(*) AS c",
            vec![p("lo", Value::Num(2.0))],
        ),
        (
            "a param used TWICE",
            "MATCH (u:User) WHERE u.name = $n OR u.city = $n RETURN u.score AS s",
            vec![p("n", Value::Str("x".into()))],
        ),
        // VALUE dependence. Item 318 verified the two parses agree for one param set per shape,
        // which is not a proof for every set: direct mode substitutes the VALUE, so a rule that
        // keys off the value's TYPE or SIZE could plan one way for a short list and another for a
        // long one (item 267 capped an inline `IN` list's OR-chain desugaring at 32 for exactly
        // that kind of reason). A text-keyed cache holds ONE plan for all future values, so if any
        // verdict here flips with the value, the cache is unsound for that shape.
        (
            "IN with a SHORT list (2)",
            "MATCH (u:User) WHERE u.name IN $names RETURN u.score AS s",
            vec![p(
                "names",
                Value::List(
                    (0..2)
                        .map(|i| Value::Str(format!("name{i}").into()))
                        .collect(),
                ),
            )],
        ),
        (
            "IN with a LONG list (40, past item 267's chain cap of 32)",
            "MATCH (u:User) WHERE u.name IN $names RETURN u.score AS s",
            vec![p(
                "names",
                Value::List(
                    (0..40)
                        .map(|i| Value::Str(format!("name{i}").into()))
                        .collect(),
                ),
            )],
        ),
        (
            "an equality against NULL",
            "MATCH (u:User) WHERE u.name = $n RETURN u.score AS s",
            vec![p("n", Value::Null)],
        ),
        (
            "an equality against a NUMBER where the column is a string",
            "MATCH (u:User) WHERE u.name = $n RETURN u.score AS s",
            vec![p("n", Value::Num(7.0))],
        ),
        (
            "an equality against a LIST (a cross-type compare)",
            "MATCH (u:User) WHERE u.name = $n RETURN u.score AS s",
            vec![p("n", Value::List(vec![Value::Num(1.0)]))],
        ),
        (
            "a range against NULL",
            "MATCH (u:User) WHERE u.score >= $lo RETURN u.name AS n",
            vec![p("lo", Value::Null)],
        ),
        (
            "a missing param (the error path, which binds at a different time)",
            "MATCH (u:User) WHERE u.name = $nope RETURN u.score AS s",
            vec![],
        ),
    ]
}

fn store() -> lenke_engine::store::Store {
    let mut s = lenke_engine::store::Store::default();

    for i in 0..200u32 {
        s.add_node(
            &["User"],
            &[
                ("name", Value::Str(format!("name{i}").into())),
                ("score", Value::Num(f64::from(i % 10))),
                ("city", Value::Str("Springfield".into())),
            ],
        );
    }

    s
}

fn main() {
    let st = store();
    // An indexed key as well as an unindexed one: a substituted literal can seed an index where a
    // bound param might not, and that difference would show up only with the index present.
    let mut indexed = store();
    indexed.create_index("name");

    println!("=== would a parse cache change the plan? (prepared vs direct) ===");
    println!(
        "  direct  = optimize_indexed(parse_with_params(q, params))      <- what lnk_query does now"
    );
    println!(
        "  cached  = optimize_indexed(bind_params(parse_prepared(q), params))  <- what a cache holds\n"
    );

    for (store_label, st) in [("no index", &st), ("index on name", &indexed)] {
        println!("  --- {store_label} ---");

        for (label, q, params) in cases() {
            let direct = lenke_engine::gql::parse_with_params(q, &params)
                .map(|p| format!("{:?}", lenke_engine::opt::optimize_indexed(p, st)));

            let cached = lenke_engine::gql::parse_prepared(q).and_then(|mut p| {
                lenke_engine::bind::bind_params(&mut p, &params)?;
                Ok(format!("{:?}", lenke_engine::opt::optimize_indexed(p, st)))
            });

            let verdict = match (&direct, &cached) {
                (Ok(d), Ok(c)) if d == c => "SAME plan".to_string(),
                (Ok(_), Ok(_)) => "DIFFERENT PLAN -- a cache would change the route".to_string(),
                (Err(d), Err(c)) if d == c => "both refuse, same message".to_string(),
                (Err(_), Err(_)) => "both refuse, DIFFERENT message".to_string(),
                (Ok(_), Err(e)) => format!("prepared REFUSES (fall back): {e}"),
                (Err(e), Ok(_)) => format!("direct refuses but prepared accepts: {e}"),
            };

            println!("  {label:<58} {verdict}");

            // The two carve-outs need their CONTENT, not just a verdict: a different plan might
            // be wrong or merely differently spelled, and a different error message is an
            // observable behaviour change that a cache would have to reproduce.
            if verdict.starts_with("DIFFERENT PLAN") {
                println!("      direct: {}", direct.as_ref().unwrap());
                println!("      cached: {}", cached.as_ref().unwrap());
            }

            if verdict.ends_with("DIFFERENT message") {
                println!("      direct: {}", direct.as_ref().unwrap_err());
                println!("      cached: {}", cached.as_ref().unwrap_err());
            }
        }

        println!();
    }
}
