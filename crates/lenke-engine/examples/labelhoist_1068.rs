//! Item 1068: what does a LABEL NAME's length cost an element render, per row?
//!
//! `render_nodes` built `Value::Str(l.into())` from a `&str` per label per row. `GStr::new`
//! COPIES the bytes — inline to `INLINE_CAP` = 12, a heap allocation with a refcount header above
//! it — so a name longer than twelve characters allocated once per node per label, for a name
//! every node in the bucket shares.
//!
//! THE CORPUS CANNOT SHOW IT, which is why this probe exists: `query_bench`'s fixture labels are
//! `Person` and `Company`, both inline, so it reads the flat part of the curve. Item 391 hit
//! exactly this when it hoisted the property KEYS — "the bench cannot show the real win" — and its
//! own earlier probe missed it too, by using keys `"a".."d"`.
//!
//! So the axis is LENGTH, and this sweeps it over one fixture shape: 6, 12, 14, 17 and 39
//! characters. The 12-to-14 step is the inline boundary and is where the effect has to appear if
//! it is the copy; a smooth slope across all five would mean something else.
//!
//! THE CONTROL is a scalar projection over the longest label — same scan, same bucket, no element
//! rendered, so the hoist cannot reach it.
//!
//! ```text
//! cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example labelhoist_1068
//! LH_N=200000 LH_REPS=9 ... --example labelhoist_1068
//! ```
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Four properties per node, as `query/perrow`'s fixture has — the property loop is ~47% of an
/// element render (item 390), so a node with none would price a different question.
fn fixture(label: &str, rows: usize) -> Store {
    let mut b = Builder::default();

    for i in 0..rows {
        b.node(
            &[label],
            &[
                ("name", Value::Str(format!("n{i}").into())),
                ("age", Value::Num((i % 80) as f64)),
                ("city", Value::Str(format!("c{}", i % 17).into())),
                ("dept", Value::Str(format!("d{}", i % 5).into())),
            ],
        );
    }

    b.build()
}

fn time_q(q: &str, store: &Store, reps: usize) -> (f64, usize) {
    let raw = lenke_engine::gql::parse(q).expect("parses");
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let mut best = f64::MAX;
    let mut rows = 0;

    for _ in 0..reps {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).expect("runs");

        best = best.min(t.elapsed().as_secs_f64() * 1e6);
        rows = out.rows.iter().count();
    }

    (best, rows)
}

fn main() {
    let rows = env("LH_N", 100_000);
    let reps = env("LH_REPS", 5);

    println!("=== labelhoist/1068 (element render by LABEL NAME length) ===");
    println!("rows={rows} reps={reps}");
    println!("{:<46} {:>11} {:>11}", "label", "best_us", "ns/row");

    for label in [
        "Person",
        "PersonTwelve",
        "PersonThirteen",
        "EmploymentRecordX",
        "APurchaseOrderLineItemWithAVeryLongName",
    ] {
        let store = fixture(label, rows);
        let (us, got) = time_q(&format!("MATCH (n:{label}) RETURN n"), &store, reps);

        assert_eq!(got, rows, "every node is returned");
        println!(
            "{:<46} {:>11.1} {:>11.1}",
            format!("{label} ({})", label.len()),
            us,
            us * 1000.0 / rows as f64
        );
    }

    let label = "APurchaseOrderLineItemWithAVeryLongName";
    let store = fixture(label, rows);
    let (us, got) = time_q(
        &format!("MATCH (n:{label}) RETURN n.age AS a"),
        &store,
        reps,
    );

    assert_eq!(got, rows, "every node is returned");
    println!(
        "{:<46} {:>11.1} {:>11.1}   CONTROL (no element)",
        "scalar n.age, 39-char label",
        us,
        us * 1000.0 / rows as f64
    );
}
