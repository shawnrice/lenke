//! Does an ALGORITHM care whether the CSR overlay is fresh? (item 1166)
//!
//! Items 1121/1122 built `rearm_if_warranted` — a stale overlay rebuilds itself once enough reads
//! have been served on it (`REARM_AFTER = 4`, break-even measured at 1.97-2.23 reads) — and wired
//! it into exactly TWO FFI entry points: `lnk_query` and the prepared-statement run. The
//! ENTRY-POINT enum's remaining adjacency-heavy variant is `lnk_command`'s `algo`, and `ffi.rs`
//! says in as many words why it was left out:
//!
//! > NOT widened to the rest of `lnk_command`: the algo commands read adjacency heavily and a
//! > re-arm would be safe there too (…), but that surface has no measurement behind it.
//!
//! This is that measurement.
//!
//! ⚠️ A FALSE START WORTH RECORDING, because it nearly ended the investigation. Grepping `algo.rs`
//! for the typed accessors (`out_typed_csr`, `out_typed_flat`, `for_each_typed_out`, `csr_fresh`)
//! returns ZERO for every one of them, which reads as "the algorithms do not touch the overlay, so
//! a re-arm would be pure cost". That is wrong. `algo.rs` goes through `store.out()` / `store.inc()`,
//! and BOTH branch on `csr_fresh`: fresh returns a contiguous `&csr_out[a..b]`, stale falls back to
//! `out_adj[node]` — a Vec-of-Vecs, so one pointer chase and one scattered allocation per node.
//! The dependency is real and the accessor's NAME simply does not contain it. Absence of a name is
//! not absence of a dependency (the item-1165 lesson, in a different dress).
//!
//! So the arms are the overlay's state, with an algorithm that sweeps every edge many times:
//!
//!   A FRESH            as `build()` leaves it
//!   B STALE            after ONE `add_edge`, which clears `csr_fresh` with nothing to re-arm it
//!   C STALE + rebuild  the state a widened `rearm_if_warranted` would produce
//!   D degree [ctl]     one pass over adjacency rather than `iterations` passes — same accessors,
//!                      so it moves with the overlay too, but by far less if the cost is locality
//!
//! Go/no-go: if B is materially worse than A and C recovers it, the widening has its measurement.
//! If B == A, the algorithms do not care and the pending task should be RETIRED rather than built.
//!
//!   cargo run --release --example algo_stale_csr_probe

#[path = "support/harness.rs"]
#[allow(dead_code)]
mod support;

use lenke_engine::store::{Builder, Store};

use support::Cfg;

fn social(nodes: u32, deg: u32) -> Store {
    let mut b = Builder::default();

    for _ in 0..nodes {
        b.node(&["Person"], &[]);
    }

    let mut rng = support::Lcg::seeded();

    for i in 0..nodes {
        for d in 0..deg {
            let ty = if d % 2 == 0 { "KNOWS" } else { "FOLLOWS" };

            b.edge(i, rng.next(nodes), ty);
        }
    }

    b.build()
}

/// Min-of-reps wall time in milliseconds, `black_box`ing the result so the run cannot be elided.
fn best_ms<T>(reps: usize, mut f: impl FnMut() -> T) -> f64 {
    let mut best = f64::INFINITY;

    for _ in 0..reps {
        let t = std::time::Instant::now();
        let out = f();
        let ms = t.elapsed().as_secs_f64() * 1000.0;

        std::hint::black_box(out);
        best = best.min(ms);
    }

    best
}

fn main() {
    let cfg = Cfg::from_env();
    let nodes = cfg.scale.unwrap_or(200_000) as u32;
    let deg: u32 = std::env::var("PROBE_DEG")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    let iters: u32 = std::env::var("PROBE_ITERS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);

    println!(
        "\n# {nodes} nodes / degree {deg}, pagerank x{iters} iterations, min of {}\n",
        cfg.reps
    );

    // ONE STORE, MEASURED IN SEQUENCE — and the first draft got this wrong in a way worth
    // recording. It built a separate store per arm so that one arm's reads could not warm the
    // next, which also made the arms three different HEAPS: A-vs-B then conflates the overlay's
    // state with each store's own allocation layout, and it duly showed a 1.07-1.20x that a
    // rebuild did not recover. Driving ONE store through the states removes the confound, and the
    // stale state is re-entered with a second write so the whole cycle is observed rather than
    // inferred.
    let mut st = social(nodes, deg);
    let pr = |s: &Store| lenke_engine::algo::pagerank(s, None, None, 0.85, iters, 1);

    println!("  overlay state                            ms      vs FRESH");

    let a = best_ms(cfg.reps, || pr(&st));
    println!("  A FRESH                            {a:>10.1}         1.00x");

    st.add_edge(0, 1, "KNOWS"); // clears csr_fresh; nothing re-arms it on this path today
    let b = best_ms(cfg.reps, || pr(&st));
    println!(
        "  B STALE (one add_edge)             {b:>10.1}   {:>10.2}x",
        b / a
    );

    let rebuild_ms = {
        let t = std::time::Instant::now();
        st.rebuild_csr();
        t.elapsed().as_secs_f64() * 1000.0
    };
    let c = best_ms(cfg.reps, || pr(&st));
    println!(
        "  C REBUILT                          {c:>10.1}   {:>10.2}x",
        c / a
    );

    st.add_edge(2, 3, "FOLLOWS"); // back to stale, so the cycle is closed on the same heap
    let d = best_ms(cfg.reps, || pr(&st));
    println!(
        "  D STALE AGAIN                      {d:>10.1}   {:>10.2}x",
        d / a
    );
    println!("  (one rebuild_csr costs             {rebuild_ms:>10.1} ms, single shot)");

    // THE CONTROL: one pass over adjacency instead of `iters` passes, same accessors. If the gap
    // were locality, a single pass would show far less of it than a ten-pass sweep.
    let e_stale = best_ms(cfg.reps, || {
        lenke_engine::algo::degree(&st, lenke_engine::ir::Dir::Out, None, 1)
    });
    st.rebuild_csr();
    let e_fresh = best_ms(cfg.reps, || {
        lenke_engine::algo::degree(&st, lenke_engine::ir::Dir::Out, None, 1)
    });
    println!(
        "  E degree [ctl]  fresh {e_fresh:.2} / stale {e_stale:.2}   {:>10.2}x",
        e_stale / e_fresh
    );
}
