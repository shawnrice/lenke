//! Item 1070: what would `Value::Map(Arc<[(Value, Value)]>)` save over `Arc<Vec<_>>`?
//!
//! Items 338/390 ablated element materialization as **47% property loop, 37% two `Value::Map`
//! allocations, 12% labels, ~0 external id**. The labels are hoisted now (1068, 1069) and item 392
//! refuted the obvious attack on the 37% (pre-sizing the property vector measured 1.25x SLOWER).
//! This prices the OTHER attack before anyone writes it, because it is a cross-crate refactor of
//! every `Value::Map` construction and match site.
//!
//! THE IDEA. `Map(Arc<Vec<(Value, Value)>>)` is TWO allocations — the `Vec`'s buffer and the
//! `Arc`'s box — and `Value::Record` in the same enum already uses the single-allocation
//! `Arc<[(GStr, Value)]>` form. An element render builds two maps per row, so the floor looks like
//! 2 allocations where it currently pays 4.
//!
//! THE CATCH, which is why this is a measurement and not a patch. `Arc<[T]>` is one allocation
//! only when it is built from an `ExactSizeIterator` (`Arc::from_iter` writes in place).
//! `Arc::<[T]>::from(vec)` COPIES into a fresh allocation instead, so converting a `Vec` that was
//! accumulated by pushes costs the `Vec` + the `Arc` + a memcpy — the same count, plus the copy.
//! The outer 3-pair map has a known length and can win; the PROPERTY map does not, because which
//! properties are present varies per row.
//!
//! So this times the four shapes directly, at the sizes a render actually uses.
//!
//! ```text
//! cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example mapalloc_1070
//! MA_N=1000000 ... --example mapalloc_1070
//! ```
use lenke_engine::value::Value;
use std::hint::black_box;
use std::sync::Arc;
use std::time::Instant;

fn env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn best_ns(reps: usize, rows: usize, mut f: impl FnMut()) -> f64 {
    let mut best = f64::MAX;

    for _ in 0..reps {
        let t = Instant::now();

        f();
        best = best.min(t.elapsed().as_secs_f64() * 1e9 / rows as f64);
    }

    best
}

/// ALLOCATION-FREE pair construction, which the first cut of this probe got wrong: it built the
/// key with `format!`, so every row allocated a `String` per pair and the control read 107 ns/row
/// — swamping the very thing being measured. The engine does not do that either (items 391, 1068,
/// 1069 hoisted exactly these keys), so cloning a pre-built `Value` is also the faithful shape.
fn pair(keys: &[Value], i: usize) -> (Value, Value) {
    (keys[i % keys.len()].clone(), Value::Num(i as f64))
}

fn main() {
    let rows = env("MA_N", 1_000_000);
    let reps = env("MA_REPS", 5);
    let props = env("MA_PROPS", 4);
    let keys: Vec<Value> = (0..4).map(|i| Value::Str(format!("k{i}").into())).collect();

    println!("=== mapalloc/1070 (Arc<Vec<_>> vs Arc<[_]>, at render sizes) ===");
    println!("rows={rows} reps={reps} props={props}");
    println!("{:<52} {:>10}", "shape", "ns/row");

    // THE OUTER MAP: three pairs, length known at the construction site.
    let a = best_ns(reps, rows, || {
        for i in 0..rows {
            let m: Arc<Vec<(Value, Value)>> =
                Arc::new(vec![pair(&keys, i), pair(&keys, i + 1), pair(&keys, i + 2)]);

            black_box(&m);
        }
    });

    println!(
        "{:<52} {:>10.1}",
        "outer 3-pair: Arc::new(vec![..])  (today)", a
    );

    let b = best_ns(reps, rows, || {
        for i in 0..rows {
            let m: Arc<[(Value, Value)]> =
                Arc::from_iter([pair(&keys, i), pair(&keys, i + 1), pair(&keys, i + 2)]);

            black_box(&m);
        }
    });

    println!("{:<52} {:>10.1}", "outer 3-pair: Arc::from_iter([..])", b);

    // THE PROPERTY MAP: accumulated by pushes, so its length is NOT known up front.
    let c = best_ns(reps, rows, || {
        for i in 0..rows {
            let mut v: Vec<(Value, Value)> = Vec::new();

            for j in 0..props {
                if j != 2 {
                    v.push(pair(&keys, i + j));
                }
            }

            let m: Arc<Vec<(Value, Value)>> = Arc::new(v);

            black_box(&m);
        }
    });

    println!(
        "{:<52} {:>10.1}",
        "props: pushes -> Arc::new(v)  (today)", c
    );

    let d = best_ns(reps, rows, || {
        for i in 0..rows {
            let mut v: Vec<(Value, Value)> = Vec::new();

            for j in 0..props {
                if j != 2 {
                    v.push(pair(&keys, i + j));
                }
            }

            let m: Arc<[(Value, Value)]> = Arc::from_iter(v);

            black_box(&m);
        }
    });

    println!("{:<52} {:>10.1}", "props: pushes -> Arc::from_iter(v)", d);

    // THE CONTROL: the pairs alone, with no map built at all — so the difference between the rows
    // above and this one is the map, and not `pair()`.
    let e = best_ns(reps, rows, || {
        for i in 0..rows {
            let mut v: Vec<(Value, Value)> = Vec::new();

            for j in 0..props {
                if j != 2 {
                    v.push(pair(&keys, i + j));
                }
            }

            black_box(&v);
        }
    });

    println!(
        "{:<52} {:>10.1}   CONTROL (no map)",
        "props: pushes only", e
    );
    println!();
    println!(
        "outer: {:+.1} ns/row     props: {:+.1} ns/row     both: {:+.1} ns/row",
        b - a,
        d - c,
        (b - a) + (d - c)
    );
}
