use super::*;
use crate::exec::run;
use crate::gql::{parse_prepared, parse_with_params};
use crate::store::{Builder, Store};

fn s(x: &str) -> Value {
    Value::Str(x.into())
}
fn n(x: f64) -> Value {
    Value::Num(x)
}
fn people() -> Store {
    let mut b = Builder::default();
    b.node(&["Person"], &[("name", s("alice")), ("age", n(30.0))]);
    b.node(&["Person"], &[("name", s("bob")), ("age", n(25.0))]);
    b.build()
}

/// Parse-in-prepared-mode + bind must yield the EXACT same plan as substituting
/// the value at parse time — so a prepared run is byte-identical to a direct one.
fn prepared_equals_direct(query: &str, params: &[(String, Value)]) {
    let mut prepared = parse_prepared(query).unwrap();
    bind_params(&mut prepared, params).unwrap();
    let direct = parse_with_params(query, params).unwrap();
    assert_eq!(
        format!("{prepared:?}"),
        format!("{direct:?}"),
        "prepared+bind != direct for `{query}`"
    );
}

#[test]
fn bound_plan_matches_direct_substitution() {
    prepared_equals_direct(
        "MATCH (n:Person) WHERE n.age = $a RETURN n.name AS x",
        &[("a".into(), n(30.0))],
    );
    // Inline prop: `{k: $p}` binds via the filter path, same plan as the literal.
    prepared_equals_direct(
        "MATCH (n:Person {name: $nm}) RETURN n.age AS a",
        &[("nm".into(), s("alice"))],
    );
    // A param nested in arithmetic / function position.
    prepared_equals_direct(
        "MATCH (n:Person) WHERE n.age > $a + 1 RETURN n.name AS x",
        &[("a".into(), n(20.0))],
    );
}

#[test]
fn one_prepared_plan_reused_with_different_params() {
    let store = people();
    let template = parse_prepared("MATCH (n:Person) WHERE n.name = $nm RETURN n.age AS a").unwrap();
    let age_for = |nm: &str| {
        let mut plan = template.clone(); // parse once, bind many
        bind_params(&mut plan, &[("nm".into(), s(nm))]).unwrap();
        let rows = run(&plan, &store);
        assert_eq!(rows.rows.len(), 1, "{nm}");
        format!("{:?}", rows.rows[0][0])
    };
    assert_eq!(age_for("alice"), format!("{:?}", n(30.0)));
    assert_eq!(age_for("bob"), format!("{:?}", n(25.0)));
}

#[test]
fn missing_param_is_an_error() {
    let mut plan = parse_prepared("MATCH (n) WHERE n.k = $x RETURN n").unwrap();
    let err = bind_params(&mut plan, &[]).unwrap_err();
    assert!(err.contains("$x"), "unhelpful error: {err}");
}

#[test]
fn binding_is_idempotent_across_clones() {
    // Binding a clone must not disturb the template (the reuse invariant).
    let template = parse_prepared("MATCH (n:Person) WHERE n.age = $a RETURN n").unwrap();
    let before = format!("{template:?}");
    let mut once = template.clone();
    bind_params(&mut once, &[("a".into(), n(1.0))]).unwrap();
    assert_eq!(
        format!("{template:?}"),
        before,
        "template mutated by a bind"
    );
}

/// A REPEATED parameter name is LAST-WINS, which matches `ndjson`'s convention for a repeated
/// JSON key (item 333 pins that for `labels`/`properties`) and is what both engines must agree
/// on: a JS object literal and `JSON.parse` both collapse a duplicate key to the last spelling.
///
/// Reachable because `Json::Obj` is a `Vec<(String, Json)>` whose parser PUSHES, so
/// `params_from_obj` can hand `bind_params` two entries under one name. `g.query(text, obj)`
/// cannot produce one (a JS object has no duplicates), but `lnk_query` takes the params as a raw
/// JSON string, so any ABI caller can.
///
/// This test exists because the lookup table is an implementation choice that silently decides it
/// (item 598): a `HashMap` built by `collect` is last-wins, and a forward linear scan would be
/// FIRST-wins — the same rows by a different value, with nothing in the suite to notice.
#[test]
fn a_repeated_parameter_name_is_last_wins() {
    let mut plan = parse_prepared("MATCH (n:Person) WHERE n.name = $x RETURN n.age AS a").unwrap();

    bind_params(
        &mut plan,
        &[("x".into(), s("alice")), ("x".into(), s("bob"))],
    )
    .unwrap();

    // `bob`, not `alice` — and the rendered plan is where it is visible, since the bound literal
    // is baked into it.
    let rendered = format!("{plan:?}");

    assert!(
        rendered.contains("\"bob\""),
        "expected the LAST binding to win, got: {rendered}"
    );
    assert!(
        !rendered.contains("\"alice\""),
        "the first binding survived — the lookup is first-wins, not last-wins: {rendered}"
    );

    // And it reaches the ANSWER, not just the rendering.
    let store = people();
    let rows = run(&plan, &store);

    assert_eq!(rows.rows.len(), 1, "expected bob's single row");
    assert!(
        matches!(rows.rows[0][0], Value::Num(x) if x == 25.0),
        "got {:?}",
        rows.rows[0][0]
    );
}

/// TWO DISTINCT parameters, bound to values that are NOT interchangeable, each in a position where
/// the other's value changes the answer.
///
/// This exists because a mutant that ignores the NAME entirely — `find(|_| true)`, which with the
/// reverse scan hands back the last parameter for every `$name` — SURVIVED the whole 1,177-test
/// suite (item 598). Every other bind test supplies one parameter, or two whose values happen to
/// be interchangeable, so nothing noticed that the lookup had stopped reading the name. A one-param
/// fixture cannot witness a name-blind lookup, exactly as a total count cannot witness a direction
/// bug (item 586).
#[test]
fn two_parameters_bind_to_their_own_names() {
    let mut plan = parse_prepared(
        "MATCH (n:Person) WHERE n.name = $who AND n.age = $years RETURN n.name AS nm",
    )
    .unwrap();

    // alice is 30 and bob is 25, so CROSSING the two bindings matches nobody — which is what makes
    // this fixture able to tell the difference.
    bind_params(
        &mut plan,
        &[("who".into(), s("alice")), ("years".into(), n(30.0))],
    )
    .unwrap();

    let store = people();
    let rows = run(&plan, &store);

    assert_eq!(rows.rows.len(), 1, "alice/30 should match exactly one row");
    assert!(
        matches!(&rows.rows[0][0], Value::Str(x) if &**x == "alice"),
        "got {:?}",
        rows.rows[0][0]
    );

    // The crossed pair must match NOTHING, so a lookup that returns the wrong parameter cannot
    // accidentally agree.
    let mut crossed = parse_prepared(
        "MATCH (n:Person) WHERE n.name = $who AND n.age = $years RETURN n.name AS nm",
    )
    .unwrap();

    bind_params(
        &mut crossed,
        &[("who".into(), s("alice")), ("years".into(), n(25.0))],
    )
    .unwrap();

    assert_eq!(
        run(&crossed, &store).rows.len(),
        0,
        "alice/25 is nobody — the two bindings were not kept apart"
    );
}
