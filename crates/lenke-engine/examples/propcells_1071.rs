//! Item 1071: what does ONE property CELL cost an element render, and does specializing the
//! column loop per variant change it?
//!
//! Item 390's ablation put **47% of an element render in the property loop** — the largest share,
//! and the one the two map-allocation attacks left untouched (392 refuted pre-sizing the vector,
//! 1070 refuted the `Arc<[_]>` representation).
//!
//! WHY THE CORPUS CANNOT ADJUDICATE IT. `query_bench -- perrow` renders nodes with FOUR
//! properties, so the per-cell cost is diluted by the ~250 ns/row the rest of the render pays, and
//! a per-cell change arrives as a few percent — inside the drift those 67-300 ms rows show between
//! builds. Measured: the subject row moved 1.03x while `element r`, which the change cannot reach,
//! moved 1.04x the OTHER way.
//!
//! So sweep K, the number of properties per node. A per-cell saving scales with K; anything that
//! does not is not per-cell. K=1 is the control at the bottom of the curve.
//!
//! ```text
//! cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example propcells_1071
//! PC_N=100000 PC_REPS=7 ... --example propcells_1071
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

/// `k` properties per node, every one PRESENT — so each arm's cell count is exactly `rows * k` and
/// the per-cell cost is the slope. Half numeric and half string, so both specialized arms run.
fn fixture(rows: usize, k: usize) -> Store {
    let mut b = Builder::default();

    for i in 0..rows {
        let props: Vec<(String, Value)> = (0..k)
            .map(|j| {
                if j % 2 == 0 {
                    (format!("n{j}"), Value::Num((i + j) as f64))
                } else {
                    (
                        format!("s{j}"),
                        Value::Str(format!("v{}", (i + j) % 97).into()),
                    )
                }
            })
            .collect();
        let as_refs: Vec<(&str, Value)> =
            props.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();

        b.node(&["P"], &as_refs);
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
    let rows = env("PC_N", 100_000);
    let reps = env("PC_REPS", 5);

    println!("=== propcells/1071 (element render by PROPERTIES PER NODE) ===");
    println!("rows={rows} reps={reps}");
    println!(
        "{:<22} {:>11} {:>11} {:>12}",
        "arm", "best_us", "ns/row", "ns/cell"
    );

    for k in [1, 4, 16, 64] {
        let store = fixture(rows, k);
        let (us, got) = time_q("MATCH (n:P) RETURN n", &store, reps);

        println!(
            "{:<22} {:>11.1} {:>11.1} {:>12.2}",
            format!("K={k}"),
            us,
            us * 1000.0 / got.max(1) as f64,
            us * 1000.0 / (got.max(1) * k) as f64
        );
    }

    // THE CONTROL: a scalar projection at the widest K — the same store, the same scan, no element
    // rendered, so no property cell is materialized at all.
    let store = fixture(rows, 64);
    let (us, got) = time_q("MATCH (n:P) RETURN n.n0 AS a", &store, reps);

    println!(
        "{:<22} {:>11.1} {:>11.1} {:>12}   CONTROL (no element)",
        "K=64 scalar",
        us,
        us * 1000.0 / got.max(1) as f64,
        "-"
    );
}
