//! Item 1008: does ONE multi-label edge demote every typed hop in the graph?
//!
//! Item 1004 narrowed the COUNT sites' guard from the global `has_multi_label_edges()` to a
//! per-type `type_ever_secondary()`, worth ~1200x. Item 1007 grepped the pattern and found the
//! same shape at two TRAVERSAL sites — `for_each_nbr` and the degree reader, both asking the
//! global question about a single wanted type — and **declined to change them**, because the only
//! fixture that reached them gives every node ONE out-edge, where a per-type bucket seek and a
//! one-element scan are identical work. It measured 690.4 us against 666.3: no effect to see.
//!
//! This is the fixture that can see it. `expand_bench`'s header says where the per-type structures
//! win — _"a selective type over a high-degree, many-type node"_ — so that is the shape here, and
//! the ONE variable is whether a single unrelated edge carries a second label.
//!
//! THE TAINT IS ONE EDGE, deliberately. The guard is global: `has_multi_label_edges()` is true if
//! ANY edge anywhere is multi-label, so one edge out of `nodes * degree` is enough to demote every
//! typed hop in the graph if the guard is costing what item 1007 suspected. Tainting half the
//! edges would measure something else — the secondary-probe cost — and confound the question.
//!
//! THE QUERY RETURNS ROWS, not a count. A count is answered by `typed_hop_count_from_size` from a
//! partition length and never reaches `for_each_nbr`; that is exactly the distinction item 1007
//! drew, and using a count here would measure item 1004's already-fixed path instead.
//!
//! Run:
//!   cargo run --release --manifest-path crates/lenke-engine/Cargo.toml \
//!     --example multilabel_taint_1008
//!   DEGREE=256 TYPES=8 NODES=20000 ... --example multilabel_taint_1008
use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

fn env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// `nodes` vertices, each with `degree` out-edges spread across `types` edge types.
///
/// Endpoints are scattered by a multiplier coprime with `nodes` so the adjacency is not walked in
/// creation order — the trap items 164/286/287 record, where a sequential `from` side makes one
/// spelling look ~2x faster than its twin.
fn fixture(nodes: usize, degree: usize, types: usize, taint: bool) -> Store {
    let mut b = Builder::default();
    let ids: Vec<u32> = (0..nodes)
        .map(|i| b.node(&["V"], &[("k", Value::Num((i % 100) as f64))]))
        .collect();

    for (i, src) in ids.iter().enumerate() {
        for d in 0..degree {
            let dst = ids[(i * 104_729 + d * 15_485_863) % nodes];
            let t = format!("T{}", d % types);
            b.edge(*src, dst, &t);
        }
    }

    let mut store = b.build();

    if taint {
        // ONE edge gains a second label. Its primary stays whatever it was, so no answer changes:
        // every edge that matched `:T0` before still matches it, and the tainted edge gains a
        // label nothing queries. Only the GUARD's answer changes.
        store.set_edge_extra_labels(0, &["UNRELATED"]);
    }

    store.rebuild_csr();
    store
}

fn time_rows(q: &str, store: &Store, reps: usize) -> (f64, usize) {
    let plan = lenke_engine::opt::optimize_indexed(lenke_engine::gql::parse(q).unwrap(), store);
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
    let nodes = env("NODES", 20_000);
    let reps = env("REPS", 7);
    // A ROW-RETURNING typed hop on a SELECTIVE type — `T0` is one of `types`, so the per-type
    // structure skips the rest of the adjacency where the flat scan reads all of it.
    let q = "MATCH (n:V)-[:T0]->(m) RETURN m.k AS k";

    println!("# item 1008 — does ONE multi-label edge demote every typed hop?");
    println!("# {nodes} nodes, min of {reps} (us). The taint is a SECOND label on ONE edge.\n");
    println!("  degree  types     clean_us    tainted_us      ratio   rows   same");

    for (degree, types) in [(4usize, 1usize), (32, 1), (32, 8), (256, 8), (256, 64)] {
        let clean = fixture(nodes, degree, types, false);
        let tainted = fixture(nodes, degree, types, true);
        let (cu, cr) = time_rows(q, &clean, reps);
        let (tu, tr) = time_rows(q, &tainted, reps);
        // A ratio between arms answering different questions is meaningless, so the row counts
        // are CHECKED rather than assumed — the taint must not change which rows come back.
        let same = if cr == tr { "yes" } else { "NO — VOID" };

        println!(
            "  {degree:6}  {types:5}  {cu:11.1}  {tu:12.1}  {:9.2}x  {cr:>6}   {same}",
            tu / cu
        );
    }
}
