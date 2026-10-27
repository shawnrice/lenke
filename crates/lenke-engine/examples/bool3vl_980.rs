//! Item 980: is `p.b = true` the same 3VL predicate as `p.b`, and `p.b = false` the same as
//! `NOT p.b`, including over a NULL and an ABSENT cell?
//!
//! ⚠️ THIS PROBE DOES NOT REACH `try_filter_keep_bool_prop`, and that is recorded here rather
//! than discovered again. It reports SAME on all four pairs **with the fast path's polarity
//! INVERTED**, so it cannot distinguish that change from its own inverse. Two reasons, both
//! measured: on the original 4-node fixture `p.b = true` is seeded as an `IndexSeek`; with the
//! padding below it is a `Filter`, but the projection makes it `Project { Filter { Scan } }`,
//! which is a different filter path from the `count(*)` shape where the 5.8x lives.
//!
//! What it IS good for is the row it gets right: `p.tag = true` on a STRING column returns no
//! rows while the bare `p.tag` RAISES, so the two spellings are not interchangeable in general
//! and any fold must be gated on the stored column type. Use it for that, not for equivalence.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;

fn fixture() -> Store {
    let mut b = Builder::default();
    b.node(
        &["P"],
        &[("tag", Value::Str("t".into())), ("b", Value::Bool(true))],
    );
    b.node(
        &["P"],
        &[("tag", Value::Str("f".into())), ("b", Value::Bool(false))],
    );
    b.node(
        &["P"],
        &[("tag", Value::Str("n".into())), ("b", Value::Null)],
    );
    b.node(&["P"], &[("tag", Value::Str("a".into()))]);
    b.build()
}

fn tags(q: &str, store: &Store) -> String {
    match lenke_engine::gql::parse(q) {
        Err(e) => format!("PARSE {e}"),
        Ok(raw) => {
            let plan = lenke_engine::opt::optimize_indexed(raw, store);
            match lenke_engine::exec::try_run(&plan, store) {
                Err(e) => format!("THROW {e}"),
                Ok(out) => {
                    let mut v: Vec<String> =
                        out.rows.iter().map(|r| format!("{:?}", r[0])).collect();
                    v.sort();
                    v.join(",")
                }
            }
        }
    }
}

fn main() {
    let store = fixture();
    for (a, b) in [
        ("p.b = true", "p.b"),
        ("true = p.b", "p.b"),
        ("p.b = false", "NOT p.b"),
        ("p.b <> true", "NOT p.b"),
        // THE HAZARD. `tag` is a STRING column. If `p.tag = true` is a no-match while the bare
        // `p.tag` RAISES on a non-boolean, the rewrite is unsound for any column that is not
        // Bool — and must be gated on the stored column type rather than on the literal.
        ("p.tag = true", "p.tag"),
    ] {
        let qa = format!("MATCH (p:P) WHERE {a} RETURN p.tag AS t");
        let qb = format!("MATCH (p:P) WHERE {b} RETURN p.tag AS t");
        let (ra, rb) = (tags(&qa, &store), tags(&qb, &store));
        println!(
            "  {:14} -> [{:10}]   {:10} -> [{:10}]   {}",
            a,
            ra,
            b,
            rb,
            if ra == rb { "SAME" } else { "DIFFER" }
        );
    }
}
