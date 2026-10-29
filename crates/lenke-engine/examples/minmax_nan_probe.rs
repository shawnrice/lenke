//! Can a `Column::Num` hold NaN, and do the two min/max folds AGREE on it? (item 1161)
//!
//! `scan_fold_minmax` (the multi-agg path) folds with a plain `x < mn` and justifies it in a
//! comment: "stored Nums are finite, so `x < mn` == `cmp_num_total`". `try_scan_num_agg` (the
//! single-agg path) instead carries an `Option<f64>` through the loop and compares with
//! `cmp_num_total`, which is 3.6-3.9x slower (item 1161's enum pricing) precisely because the
//! `Option` branch stops the loop auto-vectorizing.
//!
//! Before copying the fast fold onto the slow path, the comment's premise gets checked rather
//! than believed — item 1142 is the precedent: a representation invariant I was sure of turned
//! out to be about something else, and a `VARIANT` print settled it in one run.
//!
//! `stored_infinity_is_a_value` already proves ±INFINITY is storable, so "finite" is false as
//! written. The question that decides the design is narrower: NaN. Under `cmp_num_total` NaN is
//! GREATEST and all NaNs tie, so `max` over a group containing one must BE NaN, while a plain
//! `x > mx` skips it silently.
//!
//!   cargo run --release --example minmax_nan_probe

use lenke_engine::store::Builder;
use lenke_engine::value::Value;

fn ask(store: &lenke_engine::store::Store, q: &str) -> String {
    let plan =
        lenke_engine::opt::optimize_indexed(lenke_engine::gql::parse(q).expect("parses"), store);
    match lenke_engine::exec::try_run(&plan, store) {
        Ok(r) => r
            .rows
            .iter()
            .next()
            .map(|row| format!("{:?}", row))
            .unwrap_or_else(|| "<no rows>".to_string()),
        Err(e) => format!("ERR {e}"),
    }
}

fn main() {
    // A NaN placed DIRECTLY in the column, bypassing any host-side sanitization — this asks what
    // the FOLD does, which is the question. Whether a query can create one is the separate check
    // below.
    let mut b = Builder::default();
    b.node(&["N"], &[("v", Value::Num(1.0))]);
    b.node(&["N"], &[("v", Value::Num(f64::NAN))]);
    b.node(&["N"], &[("v", Value::Num(5.0))]);
    let store = b.build();

    println!("\n# a NaN in the column, three nodes: 1.0, NaN, 5.0");
    println!("# under cmp_num_total NaN is GREATEST, so max MUST be NaN and min MUST be 1.0\n");
    println!(
        "  single-agg min      {}",
        ask(&store, "MATCH (n:N) RETURN min(n.v) AS c")
    );
    println!(
        "  single-agg max      {}",
        ask(&store, "MATCH (n:N) RETURN max(n.v) AS c")
    );
    println!(
        "  multi-agg  min,max  {}",
        ask(&store, "MATCH (n:N) RETURN min(n.v) AS a, max(n.v) AS b")
    );
    println!(
        "  ORDER BY (the contract's own order, as the reference)  {}",
        ask(&store, "MATCH (n:N) RETURN n.v AS c ORDER BY n.v DESC")
    );

    // Can a QUERY put a NaN in a column? `sqrt` of a negative is the cheapest route.
    let mut b2 = Builder::default();
    b2.node(&["N"], &[("v", Value::Num(-1.0))]);
    let mut s2 = b2.build();
    let w = lenke_engine::gql::parse("MATCH (n:N) SET n.v = sqrt(n.v)").expect("parses");
    let plan = lenke_engine::opt::optimize_indexed(w, &s2);
    match lenke_engine::exec::execute(&plan, &mut s2) {
        Ok(_) => println!(
            "\n# after SET n.v = sqrt(-1): stored value is {}",
            ask(&s2, "MATCH (n:N) RETURN n.v AS c")
        ),
        Err(e) => println!("\n# SET failed: {e}"),
    }
    println!(
        "  _is_nan over it     {}",
        ask(&s2, "MATCH (n:N) RETURN _is_nan(n.v) AS c")
    );
}
