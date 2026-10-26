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

/// Item 370's question, which sweeps A-D cannot reach: what does ONE `delete_node` cost, and in
/// what does it scale? `DETACH DELETE` hands its whole match to `delete_nodes` (`write.rs:166`),
/// which sweeps each bucket ONCE for the batch — so every sweep above measures the BATCH path. A
/// plain single delete takes `delete_nodes(&[id])`, whose targeted arm skips the buckets the
/// victim is not in (item 663) and then `retain`s the one it IS in, over the whole label.
///
/// `victim_in_big` picks the arm:
///   - true  — every node carries `:Univ`, so the victim's own bucket IS the node set.
///   - false — the victims carry `:Tmp` (200 of them) beside a `:Univ` bucket holding the rest.
///     The targeted path's `binary_search` MISSES `:Univ`, so that bucket is skipped and only the
///     200-entry one is touched. It stays flat in `nodes`, which is what separates "the cost is
///     the victim's OWN bucket" from "the cost is the store's size".
///
/// THE SMALL ARM IS NOT A CONTROL, and calling it one was wrong (item 920). The victim's 200-entry
/// bucket is still rewritten, so any change to how a bucket drops an entry REACHES this arm — it
/// measured 0.13 -> 0.10 us across item 920's change. It is a SMALL-BUCKET arm: it pins the cost to
/// the bucket's size, and that is all. The control for anything in `delete_nodes`' targeted path is
/// SWEEPS A-D, which delete in batches above `TARGETED_MAX` and so take the full sweep instead.
///
/// Degree is 0 and every node carries exactly one property, so neither adjacency detach nor the
/// `set_absent` loop over distinct keys can scale with `nodes` and be mistaken for the bucket.
fn single_delete_us(nodes: u32, victim_in_big: bool) -> (f64, u64) {
    const VICTIMS: u32 = 200;
    let mut best = f64::MAX;
    let mut removed = 0u64;

    for _ in 0..3 {
        let mut b = Builder::default();
        for i in 0..nodes {
            let labels: &[&str] = if victim_in_big || i >= VICTIMS {
                &["Univ"]
            } else {
                &["Tmp"]
            };
            b.node(labels, &[("k", Value::Num(f64::from(i % 7)))]);
        }
        let mut store = b.build();
        let before = store.live_node_count() as u64;

        // Spread the victims across the bucket rather than taking a prefix: removing from the
        // FRONT is the worst case for a memmove and from the BACK is the best, so a prefix would
        // flatter or punish one arm by position alone.
        let step = (nodes / VICTIMS).max(1);
        let ids: Vec<u32> = if victim_in_big {
            (0..VICTIMS).map(|v| v * step).collect()
        } else {
            (0..VICTIMS).collect()
        };

        let t = Instant::now();
        for &id in &ids {
            store.delete_node(id);
        }
        best = best.min(t.elapsed().as_secs_f64() * 1e6 / ids.len() as f64);
        removed = before - store.live_node_count() as u64;
    }

    (best, removed)
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
    println!("\nE — ONE delete at a time (item 370), NODE COUNT doubling. Degree 0.");
    println!("    big  = the victim's OWN label holds every node");
    println!("    small = the victim is in a 200-node label beside a big one (big bucket SKIPPED)");
    println!("    NB: `small` is NOT a control - its own bucket is still rewritten. A-D are.");
    for nodes in [5_000u32, 10_000, 50_000, 200_000] {
        let (big, nb) = single_delete_us(nodes, true);
        let (ctl, nc) = single_delete_us(nodes, false);

        assert!(
            nb == 200 && nc == 200,
            "both arms must delete 200: {nb} and {nc}"
        );
        println!(
            "  {nodes:>7} nodes   big {big:>8.2} us   small {ctl:>7.2} us   big/small {:>6.1}x",
            big / ctl
        );
    }
}
