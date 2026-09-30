//! Query-shape cost — what individual GQL and Gremlin shapes pay, which counts
//! shortcut vs enumerate, what a row costs by what is returned, and what turning
//! text into a plan costs before anything runs. Consolidates the retired
//! `gql_bench`, `gremlin_bench`, `exists_probe`, `query_row_cost`, `plan_bench`
//! and `seeded_traversal_bench`.
//!
//! Cases (filter with `-- <name>`):
//!   gql      — label scan / filter / project / 1-hop / 2-hop / group / EXISTS.
//!   gremlin  — count / has-filter / out / out.out / values / dedup.
//!   counts   — count(*) over each shape: which still enumerate since the
//!              shortcut ladder (a fast one is a tally, a slow one walks rows).
//!   perrow   — RETURN count vs a scalar vs a string vs the whole element: the
//!              per-row materialization cost by what is projected.
//!   plan     — lex+parse+lower only, no graph, no exec: the cost of the text.
//!   seeded   — an equality filter on an indexed key: seek vs full scan.
//!   shortest — ANY SHORTEST: anchored cost, the cost of PROJECTING the path on top
//!              of the same traversal, and the unbounded case (which reports
//!              E_RESOURCE_EXHAUSTED by design, not a time).

use crate::harness::{best_us, section, social_store, time_query, Cfg};
use lenke_engine::store::Store;

fn table(title: &str, store: &Store, gremlin: bool, cfg: &Cfg, shapes: &[(&str, &str)]) {
    section(title);
    println!("{:22} {:>11} {:>10}", "shape", "best_us", "rows");
    for (name, q) in shapes {
        match time_query(q, gremlin, store, cfg.reps) {
            Ok((us, rows)) => println!("{name:22} {us:>11.1} {rows:>10}"),
            Err(e) => println!("{name:22} {:>11} {:>10}  ({})", "n/a", "-", e.trim()),
        }
    }
}

pub fn run(cfg: &Cfg) {
    // Cap the fixture: 2-hop over deg-5 is quadratic in degree, so a huge graph
    // makes the group slow without changing the shape being measured.
    let store = social_store(cfg.nodes(200_000), 5);

    if cfg.want("query/gql") {
        table(
            "query/gql",
            &store,
            false,
            cfg,
            &[
                ("label scan", "MATCH (p:Person) RETURN count(*) AS c"),
                (
                    "filter age>50",
                    "MATCH (p:Person) WHERE p.age > 50 RETURN count(*) AS c",
                ),
                ("project 3", "MATCH (p:Person) RETURN p.name, p.age, p.city"),
                (
                    "1-hop",
                    "MATCH (p:Person)-[:KNOWS]->(q) RETURN count(*) AS c",
                ),
                (
                    "2-hop",
                    "MATCH (p:Person)-[:KNOWS]->()-[:KNOWS]->(r) RETURN count(*) AS c",
                ),
                (
                    "group by dept",
                    "MATCH (p:Person) RETURN p.dept, count(*) AS c",
                ),
                (
                    "EXISTS",
                    "MATCH (p:Person) WHERE EXISTS { (p)-[:KNOWS]->() } RETURN count(*) AS c",
                ),
            ],
        );
    }

    if cfg.want("query/gremlin") {
        table(
            "query/gremlin",
            &store,
            true,
            cfg,
            &[
                ("V count", "g.V().count()"),
                ("has age>50", "g.V().has('age', gt(50)).count()"),
                ("out", "g.V().out('KNOWS').count()"),
                ("out.out", "g.V().out('KNOWS').out('KNOWS').count()"),
                ("values", "g.V().values('name').count()"),
                ("dedup city", "g.V().values('city').dedup().count()"),
            ],
        );
    }

    if cfg.want("query/counts") {
        table(
            "query/counts (shortcut vs enumerate)",
            &store,
            false,
            cfg,
            &[
                ("label", "MATCH (p:Person) RETURN count(*) AS c"),
                (
                    "filtered",
                    "MATCH (p:Person) WHERE p.age > 50 RETURN count(*) AS c",
                ),
                (
                    "1-hop",
                    "MATCH (p:Person)-[:KNOWS]->() RETURN count(*) AS c",
                ),
                (
                    "2-hop",
                    "MATCH (p:Person)-[:KNOWS]->()-[:KNOWS]->() RETURN count(*) AS c",
                ),
                ("grouped", "MATCH (p:Person) RETURN p.dept, count(*) AS c"),
            ],
        );
    }

    if cfg.want("query/perrow") {
        section("query/perrow (per-row by projection)");
        println!(
            "{:22} {:>11} {:>10} {:>11}",
            "return", "best_us", "rows", "ns/row"
        );
        for (name, q) in [
            ("count(*)", "MATCH (p:Person) RETURN count(*) AS c"),
            ("scalar p.age", "MATCH (p:Person) RETURN p.age"),
            ("string p.name", "MATCH (p:Person) RETURN p.name"),
            ("element p", "MATCH (p:Person) RETURN p"),
        ] {
            match time_query(q, false, &store, cfg.reps) {
                Ok((us, rows)) => {
                    let ns = if rows > 0 {
                        us * 1e3 / rows as f64
                    } else {
                        0.0
                    };
                    println!("{name:22} {us:>11.1} {rows:>10} {ns:>11.1}");
                }
                Err(e) => println!("{name:22} {:>11}  ({})", "n/a", e.trim()),
            }
        }
    }

    if cfg.want("query/plan") {
        section("query/plan (text -> plan, no exec)");
        println!("{:30} {:>11}", "text", "best_us");
        for (name, q) in [
            ("label scan", "MATCH (p:Person) RETURN count(*) AS c"),
            (
                "2-hop + filter",
                "MATCH (p:Person)-[:KNOWS]->(q) WHERE p.age > 50 RETURN q.name",
            ),
            (
                "group + order + limit",
                "MATCH (p:Person) RETURN p.dept, count(*) AS c ORDER BY c DESC LIMIT 3",
            ),
            (
                "gremlin 2-hop",
                "g.V().out('KNOWS').out('KNOWS').values('name').dedup()",
            ),
        ] {
            let gremlin = q.starts_with("g.");
            let us = best_us(cfg.reps, || {
                if gremlin {
                    lenke_engine::gremlin::parse(q).map(|_| ())
                } else {
                    lenke_engine::gql::parse(q).map(|_| ())
                }
            });
            println!("{name:30} {us:>11.2}");
        }
    }

    if cfg.want("query/shortest") {
        // `ANY SHORTEST` had NO bench coverage until an OOM went looking for it, which is
        // how a query that killed the process at 6,000 nodes stayed invisible. Three
        // questions: what an anchored shortest path costs, what PROJECTING the path costs
        // on top of the identical traversal, and what an unanchored one does now.
        //
        // The lineage row is the finding. Same BFS, same rows kept; the only difference is
        // whether a path is materialized. Measured on a degree-3 fixture at 4,000 nodes:
        // 15.1M rows but 110.5M path elements at ~94 bytes each, peaking at 10.4 GB — so
        // the path projection, not the search, is what makes this operator expensive.
        //
        // The last row is expected to report E_RESOURCE_EXHAUSTED, not a time. An
        // all-pairs shortest path emits one row per (source, reachable target), which is
        // quadratic; before the ceiling existed it was OOM-killed at 16 GB on 6,000 nodes.
        // If this row ever starts reporting a time, the ceiling stopped working.
        let sp = social_store(cfg.nodes(50_000), 3);
        let mut sp_ix = social_store(cfg.nodes(50_000), 3);
        sp_ix.create_index("name");
        table(
            "query/shortest (anchored vs projected vs unbounded)",
            &sp,
            false,
            cfg,
            &[
                (
                    "anchored count",
                    "MATCH p = ANY SHORTEST (x:Person)-[:KNOWS]->*(y) WHERE x.name = 'name1' \
                     RETURN count(*) AS c",
                ),
                (
                    // The lineage-free control: SAME 47,007 rows as the two path rows
                    // below, projecting an ordinary property instead of a path. The gap
                    // between this and "anchored + path" is the cost of LINEAGE; the gap
                    // to "anchored count" is mostly just output size, so comparing a
                    // path projection against count(*) over-attributes to lineage.
                    "anchored + y.name",
                    "MATCH p = ANY SHORTEST (x:Person)-[:KNOWS]->*(y) WHERE x.name = 'name1' \
                     RETURN y.name AS n",
                ),
                (
                    "anchored + path",
                    "MATCH p = ANY SHORTEST (x:Person)-[:KNOWS]->*(y) WHERE x.name = 'name1' \
                     RETURN path_length(p) AS len",
                ),
                (
                    "anchored + nodes(p)",
                    "MATCH p = ANY SHORTEST (x:Person)-[:KNOWS]->*(y) WHERE x.name = 'name1' \
                     RETURN nodes(p) AS ns",
                ),
                (
                    "unbounded (guarded)",
                    "MATCH p = ANY SHORTEST (x:Person)-[:KNOWS]->*(y) \
                     RETURN path_length(p) AS len",
                ),
            ],
        );
        // The OTHER three path-producing operators, each asked for nothing but the path's
        // SIZE. `ShortestPath` skips the chain walk for this (PathNeed::CountOnly); these
        // three still materialize every chain. Whether that is worth fixing is what these
        // rows answer — `shortest_k` ENUMERATES TRAILS rather than running one BFS, so its
        // cost profile is different and the win may simply not be there.
        //
        // Each is paired with the same lineage-free control as above: a property projection
        // over the same rows. The gap between a row and its control is the prize.
        table(
            "query/shortest (size-only reads that still materialize)",
            &sp,
            false,
            cfg,
            &[
                // UNANCHORED, unlike the rows above. Anchoring one source and bounding the
                // hops leaves 12 rows, where the `*` shortest path reaches 47,007 — far too
                // few for the materialization cost to be visible at all. Every source, two
                // hops, is the shape that makes these comparable.
                (
                    "varlen control",
                    "MATCH (x:Person)-[:KNOWS]->{1,2}(y) RETURN y.name AS n",
                ),
                (
                    "varlen + path",
                    "MATCH p = (x:Person)-[:KNOWS]->{1,2}(y) RETURN path_length(p) AS len",
                ),
                // No label on the group's inner nodes: a label/property/WHERE there is
                // E_NOT_IMPLEMENTED, so spelling it that way measures the error path.
                //
                // `size(b)`, NOT `b.name`. A group variable binds a LIST, and a bare `.prop`
                // on a list is null by design — so `RETURN b.name` returns 599,998 NULLs and
                // is no control at all. It was one here, and the "RepeatGroup is 6x the
                // var-length hop at baseline" reading came from comparing it against a query
                // doing real work.
                (
                    "repeat-group control",
                    "MATCH ((a)-[:KNOWS]->(b)){1,2} RETURN size(b) AS k",
                ),
                (
                    "repeat-group + path",
                    "MATCH p = ((a)-[:KNOWS]->(b)){1,2} RETURN path_length(p) AS len",
                ),
                // The group's lists UNREAD: this names the endpoint and never touches `a` or
                // `b`, so the per-rep list columns are built for nothing. That is the row
                // that guards the unread-bindings rewrite — a pure performance change has no
                // correctness test that can fail if it stops firing, so if this returns to
                // ~82,000us the rewrite has silently stopped working.
                (
                    "repeat-group unread",
                    "MATCH ((a)-[:KNOWS]->(b)){1,2} (t) RETURN t.name AS n",
                ),
                // A list FUNCTION over the group's boxed list column. Its argument is a bare
                // slot, which `eval` used to clone the whole column for — one `Vec`
                // allocation per row, before the function ran. This is the guard for the
                // borrowed-argument path: a pure performance change has no correctness test
                // that fails when it stops firing, so a return to ~142,000us is the signal.
                (
                    "repeat-group head(b)",
                    "MATCH ((a)-[:KNOWS]->(b)){1,2} RETURN head(b) AS h",
                ),
                // A k = 2 unit: TWO hops per repetition over one edge type, which lowers to
                // `RepeatGroup { k: 2 }` and CANNOT be flattened onto the var-length counting
                // path (a multi-element unit emits only at rep boundaries). Before it had a
                // counting sink of its own it materialized every emitted row to return one
                // number, and past the trail budget it refused outright — 1,796,808 rows at
                // 20,000 vertices, over the 1,000,000 default, where the TS engine answered.
                // A time here rather than an error is the guard.
                (
                    "k2-group count",
                    "MATCH ((x)-[:KNOWS]->(m)-[:KNOWS]->(y)){1,2} RETURN count(*) AS c",
                ),
                // A NESTED group — a unit with a reversed hop, which is what lowers to
                // `NestedGroup` rather than `RepeatGroup`, and which has its own walker rather
                // than `run_varlen`. Two guards in one row: the bound list columns were built
                // whether or not anything read them (a bare count reads none), and the walk then
                // appended a row per emitted path to return one number. 863,818us -> 146,402us
                // once the walk got a counting sink of its own; ~665ms means the lists came back
                // and ~860ms means the rows did.
                (
                    "nested-group count",
                    "MATCH ((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){1,2} RETURN count(*) AS c",
                ),
                // The valid comparison, and where the real finding was: both count the same
                // 599,998 rows and return the identical number. A var-length hop shortcuts
                // `count(*)`; a group had no such path, so it enumerated every row.
                (
                    "repeat-group count",
                    "MATCH ((a)-[:KNOWS]->(b)){1,2} RETURN count(*) AS c",
                ),
                // The SAME counts with a LABEL on the group's endpoint — the shape a user
                // actually writes, and the shape that showed `(t:Label)` was not reaching the
                // label fast path. GQL emits `'Label' IN labels(slot)` for it and the optimizer
                // canonicalizes that to `IsLabeled`, but only for a slot it can PROVE holds a
                // node, and it knew nothing about a quantified group's endpoint. So the test ran
                // the boxed evaluator, building a label list per row: 89,017us -> 12,890us here
                // (6.9x) and 1,341,788us -> 899,127us on the nested form (1.49x).
                //
                // The pair below is the guard, and it is a PAIR on purpose: the property
                // spelling of the same endpoint filter was always on the typed vectorized path,
                // so the gap between the two rows WAS the bug. They now cost the same, and a
                // return to ~89,000us on the label row means the canonicalization stopped
                // firing.
                //
                // Both of these STILL materialize: a `{1,2}` single-direction unit flattens to
                // `VarLength`, whose count has an ALGEBRAIC degree-sum path that does not take a
                // predicate, so an endpoint filter drops it to enumeration. Measured floor with
                // the filter ignored: 759us, so ~19x is still on the table here. The nested and
                // `k = 2` rows below are the ones the endpoint peel reaches.
                (
                    "group count :label",
                    "MATCH ((a)-[:KNOWS]->(b)){1,2} (t:Person) RETURN count(*) AS c",
                ),
                (
                    "group count .prop",
                    "MATCH ((a)-[:KNOWS]->(b)){1,2} (t) WHERE t.age < 10 RETURN count(*) AS c",
                ),
                // The nested form of the same endpoint filter, which DOES reach the counting
                // sink: 1,341,788us before the label test was canonicalized, 911,360us after
                // that, and 155,479us once the sink applied the filter itself rather than
                // declining on it — against a 147,550us floor measured with the filter ignored
                // outright.
                (
                    "nested count :label",
                    "MATCH ((x)-[:KNOWS]->(m)<-[:KNOWS]-(y)){1,2} (t:Person) RETURN count(*) AS c",
                ),
                // This row used to be an ERROR on purpose. The endpoint filter sits ABOVE the
                // group, so the count declined and went back on the materializing walk, and past
                // the trail budget it refused outright — a label that excludes NOTHING (every
                // vertex here is a Person) turned an answer into a refusal. Measured on one
                // 12,000-vertex graph, 1,075,835 rows: TS 1,698ms against native
                // E_RESOURCE_EXHAUSTED, where the same count WITHOUT the label was native 13ms
                // against TS 1,609ms.
                //
                // The counting sink now applies an endpoint-only filter itself, so this answers:
                // ERROR -> 63,585us. An error here again means the peel stopped firing.
                (
                    "k2 count :label",
                    "MATCH ((x)-[:KNOWS]->(m)-[:KNOWS]->(y)){1,2} (t:Person) RETURN count(*) AS c",
                ),
                (
                    "varlen count",
                    "MATCH (x:Person)-[:KNOWS]->{1,2}(y) RETURN count(*) AS c",
                ),
                (
                    "shortest-k control",
                    "MATCH p = SHORTEST 2 (x:Person)-[:KNOWS]->{1,2}(y) RETURN y.name AS n",
                ),
                (
                    "shortest-k + path",
                    "MATCH p = SHORTEST 2 (x:Person)-[:KNOWS]->{1,2}(y) \
                     RETURN path_length(p) AS len",
                ),
            ],
        );
        // The endpoint-anchored early stop needs the hash index to fire, so it gets its
        // own store: with both ends pinned the BFS stops at the target's depth instead of
        // sweeping the component.
        table(
            "query/shortest (endpoint-anchored early stop)",
            &sp_ix,
            false,
            cfg,
            &[(
                "both ends anchored",
                "MATCH p = ANY SHORTEST (x:Person)-[:KNOWS]->*(y) WHERE x.name = 'name1' \
                 AND y.name = 'name4242' RETURN path_length(p) AS len",
            )],
        );
    }

    if cfg.want("query/seeded") {
        section("query/seeded (indexed equality: seek vs scan)");
        // Same query, same rows — the only difference is whether the key is
        // indexed, so the optimize step turns the scan into a seek. (An inline
        // literal is a seekable spelling; per the equal-spellings rule it must
        // cost the same as the `$param` form.)
        let q = "MATCH (p:Person) WHERE p.name = 'name12345' RETURN p.age";
        let scan = social_store(cfg.nodes(200_000), 5);
        let mut indexed = social_store(cfg.nodes(200_000), 5);
        indexed.create_index("name");
        let scan_us = time_query(q, false, &scan, cfg.reps).map_or(f64::NAN, |(u, _)| u);
        let seek_us = time_query(q, false, &indexed, cfg.reps).map_or(f64::NAN, |(u, _)| u);
        println!(
            "{:22} {:>11} {:>11} {:>8}",
            "p.name = 'name12345'", "scan_us", "seek_us", "speedup"
        );
        println!(
            "{:22} {scan_us:>11.1} {seek_us:>11.1} {:>8.1}",
            "",
            scan_us / seek_us
        );
    }
}
