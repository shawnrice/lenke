//! The cache's contract, which is narrower than "it is faster": every call must return what
//! `gql::parse_with_params_limited` would have returned, and the cache must stay bounded.
//!
//! Two of these exist because item 228 recorded the trap rather than because they looked worth
//! writing:
//!
//!   - **Saturation hides an admission bug.** "Single-use texts do not grow the cache" is true
//!     either way once the cache sits at its cap, so that assertion passes with the admission
//!     filter deleted. The filter is tested on its OWN counter (`seen`) instead.
//!   - **A text is admitted on its SECOND sighting**, so the occupancy assertions have to count
//!     sightings, not calls.
use super::{clear, parse_for_run, stats};
use crate::value::Value;

const DEPTH: usize = 64;

fn plan_of(q: &str, params: &[(String, Value)]) -> String {
    format!(
        "{:?}",
        parse_for_run(q, params, DEPTH).expect("should parse")
    )
}

fn direct_of(q: &str, params: &[(String, Value)]) -> String {
    format!(
        "{:?}",
        crate::gql::parse_with_params_limited(q, params, DEPTH).expect("should parse")
    )
}

fn param(k: &str, v: Value) -> Vec<(String, Value)> {
    vec![(k.to_string(), v)]
}

#[test]
fn a_text_is_admitted_on_its_second_sighting_not_its_first() {
    clear();

    let q = "MATCH (u:User) WHERE u.name = $n RETURN u.score AS s";
    let p = param("n", Value::Str("a".into()));

    let _ = parse_for_run(q, &p, DEPTH).expect("parses");
    // FIRST sighting: remembered as a candidate, nothing retained.
    assert_eq!(stats().size, 0, "admitted on the first sighting");
    assert_eq!(stats().seen, 1, "the admission filter did not record it");

    let _ = parse_for_run(q, &p, DEPTH).expect("parses");
    // SECOND: it has earned a slot, and leaves the filter.
    assert_eq!(stats().size, 1);
    assert_eq!(stats().seen, 0, "an admitted text stayed in the filter");
}

#[test]
fn a_single_use_text_retains_no_plan() {
    clear();

    for i in 0..40 {
        // The all-miss workload: a value interpolated into the TEXT rather than bound, so every
        // call has a fresh key. `bench:usage`'s append row does exactly this.
        let q = format!("INSERT (:Event {{name: 'ev{i}', seq: {i}}})");
        let _ = parse_for_run(&q, &[], DEPTH).expect("parses");
    }

    // The ASSERTION THAT MATTERS is on the filter, not the cache: `size == 0` would also hold if
    // admission were immediate and the cap were doing the work, which is the trap item 228
    // recorded. 40 distinct texts, each seen once, so all 40 sit in the filter and NONE was
    // admitted.
    assert_eq!(stats().size, 0, "a single-use text was admitted");
    // Against the CAP, not against 40: the filter is bounded, so with a cap below 40 some of the
    // sightings have been forgotten again — and a test that fails when the cap is RETUNED is
    // asserting an implementation detail rather than the behaviour.
    assert_eq!(
        stats().seen,
        40.min(stats().cap),
        "the filter did not record the sightings"
    );
}

#[test]
fn the_cache_and_both_sets_stay_bounded() {
    clear();

    for i in 0..500 {
        let q = format!("MATCH (u:User) WHERE u.score = {i} RETURN u.name AS n");
        // Twice each, so every one of the 500 is ADMITTED rather than merely seen.
        let _ = parse_for_run(&q, &[], DEPTH).expect("parses");
        let _ = parse_for_run(&q, &[], DEPTH).expect("parses");
    }

    let s = stats();

    assert!(s.size <= s.cap, "cache over cap: {} > {}", s.size, s.cap);
    assert!(s.seen <= s.cap, "filter over cap: {} > {}", s.seen, s.cap);
    assert!(
        s.refused <= s.cap,
        "refusal set over cap: {} > {}",
        s.refused,
        s.cap
    );
    assert_eq!(s.size, s.cap, "500 admitted texts should fill the cache");
}

#[test]
fn a_hit_returns_what_the_direct_path_returns_for_a_different_value() {
    clear();

    let q = "MATCH (u:User) WHERE u.name = $n RETURN u.score AS s";

    // Warm with one value...
    let warm = param("n", Value::Str("first".into()));
    let _ = parse_for_run(q, &warm, DEPTH).expect("parses");
    let _ = parse_for_run(q, &warm, DEPTH).expect("parses");
    assert_eq!(stats().size, 1, "not warmed");

    // ...then hit it with a DIFFERENT one. This is the whole point of holding a prepared plan,
    // and the case a cache keyed on text would get wrong if it stored a plan with the first
    // value baked in.
    for v in ["second", "third", ""] {
        let p = param("n", Value::Str(v.into()));
        assert_eq!(plan_of(q, &p), direct_of(q, &p), "value {v:?}");
    }

    // A number, a null and a list through the same cached plan: item 318 verified no plan depends
    // on the parameter's value, so the same slot has to serve all of them.
    for v in [
        Value::Num(7.0),
        Value::Null,
        Value::List(vec![Value::Num(1.0)]),
    ] {
        let p = param("n", v.clone());
        assert_eq!(plan_of(q, &p), direct_of(q, &p), "value {v:?}");
    }
}

#[test]
fn a_parameterized_insert_is_refused_rather_than_cached() {
    clear();

    // Prepared mode ACCEPTS this and plans it as `InsertFrom`/`InsertNodeExpr`, where the direct
    // path uses the literal `Insert`/`InsertNode`. Same rows, slower operator — the divergence
    // with no wrong answer to give it away (item 318). Admission compares the two plans, so it
    // excludes itself.
    let q = "INSERT (:User {name: $n})";
    let p = param("n", Value::Str("new".into()));

    let _ = parse_for_run(q, &p, DEPTH).expect("parses");
    let _ = parse_for_run(q, &p, DEPTH).expect("parses");

    assert_eq!(stats().size, 0, "a parameterized INSERT was cached");
    assert_eq!(stats().refused, 1, "it was not remembered as refused");

    // And it keeps answering as the direct path does, on the literal operator.
    let rendered = plan_of(q, &p);
    assert_eq!(rendered, direct_of(q, &p));
    assert!(
        rendered.starts_with("Insert {"),
        "expected the literal Insert operator, got: {rendered}"
    );
}

#[test]
fn a_param_in_limit_is_refused_rather_than_cached() {
    clear();

    // Prepared mode refuses this outright, so the fallback is automatic — but it must also be
    // REMEMBERED, or every call pays a failed prepared parse on top of its real one.
    let q = "MATCH (u:User) RETURN u.name AS n LIMIT $k";
    let p = param("k", Value::Num(3.0));

    let _ = parse_for_run(q, &p, DEPTH).expect("parses");
    let _ = parse_for_run(q, &p, DEPTH).expect("parses");

    assert_eq!(stats().size, 0, "a LIMIT param was cached");
    assert_eq!(stats().refused, 1);
    assert_eq!(plan_of(q, &p), direct_of(q, &p));
}

#[test]
fn a_different_max_depth_does_not_serve_a_cached_plan() {
    clear();

    // The query has to be one the two ceilings DISAGREE about, or the test is vacuous: a shallow
    // query parses the same at either limit, so both paths render the same plan whether or not
    // the ceiling is checked on a hit. A first version used `u.name = $n` and the mutant that
    // deletes the check SURVIVED it.
    let q = "MATCH (u:User) WHERE u.a = $n AND (u.b = 2 AND (u.c = 3 AND (u.d = 4 AND u.e = 5))) RETURN u.name AS r";
    let p = param("n", Value::Num(1.0));

    assert!(
        crate::gql::parse_with_params_limited(q, &p, 4).is_err(),
        "the fixture must EXCEED the shallow ceiling or this test proves nothing"
    );

    let _ = parse_for_run(q, &p, DEPTH).expect("parses at the wide ceiling");
    let _ = parse_for_run(q, &p, DEPTH).expect("parses at the wide ceiling");
    assert_eq!(stats().size, 1, "not warmed");

    // The ceiling is stored and verified rather than folded into the key, so a call under a
    // TIGHTER limit must miss and be re-parsed — and then rejected, exactly as the uncached path
    // rejects it. Serving the cached plan would answer a query the caller's limit forbids.
    assert!(
        parse_for_run(q, &p, 4).is_err(),
        "a cached plan was served under a ceiling that forbids it"
    );
}

#[test]
fn a_failing_parse_is_not_remembered() {
    clear();

    let q = "MATCH (u:User) WHERE RETURN";

    for _ in 0..3 {
        assert!(
            parse_for_run(q, &[], DEPTH).is_err(),
            "a syntax error should surface every time"
        );
    }

    // Nothing is stored for a text that does not parse — not in the cache, and not as a refusal.
    // Caching the failure would make the first one permanent for that text; a failing query is
    // not a hot path.
    assert_eq!(stats().size, 0);
    assert_eq!(stats().refused, 0);
}

#[test]
fn a_missing_parameter_reports_the_same_error_through_a_hit() {
    clear();

    let q = "MATCH (u:User) WHERE u.name = $n RETURN u.score AS s";
    let p = param("n", Value::Str("a".into()));

    let _ = parse_for_run(q, &p, DEPTH).expect("parses");
    let _ = parse_for_run(q, &p, DEPTH).expect("parses");
    assert_eq!(stats().size, 1, "not warmed");

    // Now omit it. The direct path's message carries the wire code inline and `bind_params`
    // returns a bare one, so without the prefix added on the hit path `ffi.rs` would recover
    // `E_SYNTAX` by `strip_prefix` where the uncached call gives `E_MISSING_PARAMETER`.
    let hit = parse_for_run(q, &[], DEPTH).expect_err("should refuse an unbound parameter");
    let direct =
        crate::gql::parse_with_params_limited(q, &[], DEPTH).expect_err("should also refuse");

    assert_eq!(hit, direct);
    assert!(
        hit.starts_with("E_MISSING_PARAMETER:"),
        "lost the wire code: {hit}"
    );
}

#[test]
fn a_now_function_is_never_cached_whatever_the_sighting_order() {
    clear();

    // The order that broke it, and the one the GQL conformance differential actually runs: FIRST
    // with no clock, where the direct parse and the prepared parse AGREE on `Lit(Null)` and the
    // equality check at admission is satisfied — then with a clock, which the admitted plan can
    // no longer see. A now-function folds `$__now` into the plan at PARSE time, so the plan is
    // not a function of the query text.
    let q = "RETURN current_date AS d";
    let clock = vec![(
        "__now".to_string(),
        crate::value::Value::Str("2026-07-13".into()),
    )];

    let no_clock_1 = plan_of(q, &[]);
    let no_clock_2 = plan_of(q, &[]);

    assert_eq!(no_clock_1, direct_of(q, &[]));
    assert_eq!(no_clock_2, direct_of(q, &[]));
    assert_eq!(
        stats().size,
        0,
        "a clock-reading text was admitted on its second sighting"
    );
    assert_eq!(stats().refused, 1, "it was not remembered as refused");

    // ...and now the call that used to read a stale `Lit(Null)` out of the cache.
    assert_eq!(plan_of(q, &clock), direct_of(q, &clock));

    // Each of the five niladic now-functions, since the refusal is a name list that has to stay
    // in step with `current_temporal_kind`.
    for f in [
        "current_timestamp",
        "local_timestamp",
        "current_date",
        "current_time",
        "local_time",
    ] {
        clear();

        let q = format!("RETURN {f} AS v");
        let _ = plan_of(&q, &[]);
        let _ = plan_of(&q, &[]);

        assert_eq!(stats().size, 0, "`{f}` was admitted");
        assert_eq!(plan_of(&q, &clock), direct_of(&q, &clock), "`{f}`");
    }
}

#[test]
fn every_shape_answers_identically_warm_and_cold() {
    // The contract, swept: for each shape, the first call (cold), the second (admitting) and the
    // third (a hit, or a refusal taking the direct path) must all render the same plan as the
    // uncached path. A shape whose cached plan differs shows up here regardless of WHY.
    let cases: Vec<(&str, Vec<(String, Value)>)> = vec![
        ("MATCH (u:User) RETURN u.name AS n", vec![]),
        (
            "MATCH (u:User) WHERE u.name = $n RETURN u.score AS s",
            param("n", Value::Str("x".into())),
        ),
        (
            "MATCH (u:User) WHERE $n = u.name RETURN u.score AS s",
            param("n", Value::Str("x".into())),
        ),
        (
            "MATCH (u:User {name: $n}) RETURN u.score AS s",
            param("n", Value::Str("x".into())),
        ),
        (
            "MATCH (u:User) WHERE u.score >= $lo RETURN u.name AS n",
            param("lo", Value::Num(5.0)),
        ),
        (
            "MATCH (u:User) WHERE u.name IN $names RETURN u.score AS s",
            param(
                "names",
                Value::List(vec![Value::Str("a".into()), Value::Str("b".into())]),
            ),
        ),
        (
            "MATCH (a:User)-[:KNOWS]->(b:User) WHERE a.name = $n RETURN b.name AS r",
            param("n", Value::Str("x".into())),
        ),
        (
            "MATCH (u:User) WHERE u.score > $lo RETURN count(*) AS c",
            param("lo", Value::Num(2.0)),
        ),
        (
            "MATCH (u:User) RETURN u.name AS n LIMIT $k",
            param("k", Value::Num(3.0)),
        ),
        (
            "INSERT (:User {name: $n})",
            param("n", Value::Str("n".into())),
        ),
    ];

    for (q, p) in cases {
        clear();

        let want = direct_of(q, &p);

        for call in 1..=3 {
            assert_eq!(plan_of(q, &p), want, "call {call} of `{q}`");
        }
    }
}
