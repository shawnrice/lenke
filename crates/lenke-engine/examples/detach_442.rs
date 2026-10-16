//! Item 442: `DETACH DELETE` is the one write that is not fast natively. Item 442's screen, with
//! graph construction and the verification read both excluded from the clock, at 20,000 nodes:
//!
//! ```text
//!   SET one prop      0.34 ms     REMOVE a prop   0.31 ms     DELETE edges   0.43 ms
//!   SET on an edge    0.47        INSERT an edge  0.81        DETACH DELETE  8.77
//! ```
//!
//! 8.77 ms to detach 2,000 nodes is 4.4 us a node against `SET`'s 0.17 us over the same 2,000 —
//! about 26x. This probe asks WHY by varying one thing at a time, which is the only way to tell
//! the two candidate shapes apart:
//!
//!   - per-deleted-node work proportional to the WHOLE edge set (a scan per delete), or
//!   - per-deleted-node work proportional to its OWN degree (unavoidable).
//!
//! Hold the deleted count fixed and double the edges: a scan-per-delete doubles, a
//! degree-proportional cost does not. Then hold the edges fixed and double the deleted count: both
//! double, so that sweep alone cannot separate them — which is why the first one is the test.
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn fixture(nodes: u32, deg: u32, tagged_every: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..nodes {
        if i % tagged_every == 0 {
            b.node(&["P", "Univ"], &[("k", Value::Num(f64::from(i % 7)))]);
        } else {
            b.node(&["Univ"], &[("k", Value::Num(f64::from(i % 7)))]);
        }
    }
    let mut x = 12345u64;
    for i in 0..nodes {
        for _ in 0..deg {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            b.edge(i, (x % u64::from(nodes)) as u32, "E");
        }
    }
    b.build()
}

/// Time ONE run of `q` against a FRESH store, since a delete is not repeatable.
fn once(q: &str, nodes: u32, deg: u32, tagged_every: u32) -> Result<(f64, u64), String> {
    let mut best = f64::MAX;
    let mut deleted = 0u64;
    for _ in 0..3 {
        let mut store = fixture(nodes, deg, tagged_every);
        let before = store.live_node_count() as u64;
        let raw = lenke_engine::gql::parse(q)?;
        let plan = lenke_engine::opt::optimize_indexed(raw, &store);
        let t = Instant::now();
        lenke_engine::exec::execute(&plan, &mut store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        deleted = before - store.live_node_count() as u64;
    }
    Ok((best, deleted))
}

fn main() {
    let q = "MATCH (a:P) DETACH DELETE a";
    println!("A — DELETED COUNT FIXED (2,000), EDGES DOUBLING. A scan per delete doubles here.");
    for deg in [1u32, 2, 4, 8] {
        match once(q, 20_000, deg, 10) {
            Ok((ms, n)) => println!(
                "  deg {deg:>2}  {:>7} edges   {ms:>8.3} ms   {n} deleted   {:>7.2} us a node",
                20_000 * deg,
                ms * 1000.0 / n as f64
            ),
            Err(e) => println!("  deg {deg:>2}  ERROR {e}"),
        }
    }
    println!("\nB — EDGES FIXED (40,000), DELETED COUNT RISING.");
    for every in [100u32, 20, 10, 4, 2] {
        match once(q, 20_000, 2, every) {
            Ok((ms, n)) => println!(
                "  1 in {every:>3}   {ms:>8.3} ms   {n:>6} deleted   {:>7.2} us a node",
                ms * 1000.0 / n as f64
            ),
            Err(e) => println!("  1 in {every:>3}   ERROR {e}"),
        }
    }
    // The CLINCHER. `delete_node` says it in a comment — "Remove from every label bucket (no
    // per-node label list yet, so sweep)" — and sweeps `retain` over EVERY bucket per deleted
    // node. In sweep A/B above, `:Univ` holds every node, so each delete scans the whole node
    // set: that is a constant per deleted node, independent of edges AND of degree, which is
    // exactly what A and B measured. If so, the per-node cost scales with the NODE COUNT.
    println!("\nD — DELETED COUNT FIXED (1,000), NODE COUNT (and so bucket size) DOUBLING.");
    for nodes in [5_000u32, 10_000, 20_000, 40_000] {
        // `tagged_every` is chosen so the deleted count stays 1,000 as `nodes` grows.
        let every = nodes / 1_000;

        match once(q, nodes, 2, every) {
            Ok((ms, n)) => println!(
                "  {nodes:>6} nodes   {ms:>8.3} ms   {n:>5} deleted   {:>7.2} us a node",
                ms * 1000.0 / n as f64
            ),
            Err(e) => println!("  {nodes:>6} nodes   ERROR {e}"),
        }
    }

    println!("\nC — the CONTROLS: writes that are already fast, same fixture.");
    for (name, w) in [
        ("DELETE edges only", "MATCH (a:P)-[e:E]->(b) DELETE e"),
        ("SET a prop", "MATCH (a:P) SET a.k = 99"),
    ] {
        match once(w, 20_000, 2, 10) {
            Ok((ms, _)) => println!("  {name:<18} {ms:>8.3} ms"),
            Err(e) => println!("  {name:<18} ERROR {e}"),
        }
    }
}
