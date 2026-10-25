//! Equivalent-spelling & cross-language perf coverage.
//!
//! The old engine had spellings of the SAME query hit different code paths (100-300x
//! gaps). This engine lowers BOTH GQL and Gremlin to one `ir::Plan` and runs one
//! `exec`, so perf is a property of the optimized plan, not the surface syntax — two
//! spellings that optimize to the same plan CANNOT differ in speed. This probe checks
//! that claim directly: for each group of queries that should be equivalent, it prints
//! the optimized plan (canonicalized) and the measured time, and flags any group whose
//! members disagree on either. A plan mismatch is the real signal; the time is the
//! backstop for "different plan, but does it matter?".
//!
//! Run: cargo run --release --manifest-path crates/lenke-engine/Cargo.toml --example spelling_probe

use lenke_engine::store::{Builder, Store};
use lenke_engine::value::Value;
use std::time::Instant;

const CITIES: &[&str] = &["NYC", "LA", "SF", "CHI", "SEA", "BOS", "AUS", "DEN"];
const DEPTS: &[&str] = &["eng", "sales", "ops", "hr", "legal"];

struct Lcg(u64);
impl Lcg {
    fn next(&mut self, bound: u32) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 33) as u32) % bound.max(1)
    }
}

fn fixture(n: u32, deg: u32) -> Store {
    let mut b = Builder::default();
    for i in 0..n {
        b.node(
            &["Person"],
            &[
                ("name", Value::Str(format!("name{i}").into())),
                ("age", Value::Num(f64::from(i % 100))),
                (
                    "city",
                    Value::Str((*CITIES.get((i % 8) as usize).unwrap()).into()),
                ),
                (
                    "dept",
                    Value::Str((*DEPTS.get((i % 5) as usize).unwrap()).into()),
                ),
            ],
        );
    }
    let mut rng = Lcg(0x1234_5678);
    for i in 0..n {
        for _ in 0..deg {
            b.edge(i, rng.next(n), "KNOWS");
        }
    }
    let mut store = b.build();
    // The far-side / seed-side groups are about whether a predicate reaches an INDEX,
    // which needs one to exist. Without it those groups silently measured something
    // else (pool size before the hop), and read as cliffs that indexing would fix.
    store.create_range_index("age");
    store
}

enum Lang {
    Gql,
    Gremlin,
}
use Lang::{Gql, Gremlin};

/// Optimized plan (debug) + best-of-N time + row count, or the parse/opt error.
fn plan_and_time(lang: &Lang, q: &str, store: &Store) -> Result<(String, f64, usize), String> {
    let raw = match lang {
        Gql => lenke_engine::gql::parse(q),
        Gremlin => lenke_engine::gremlin::parse(q),
    }?;
    let plan = lenke_engine::opt::optimize_indexed(raw, store);
    let plan_str = format!("{plan:?}");
    let mut best = f64::MAX;
    let mut rows = 0;
    for _ in 0..7 {
        let t = Instant::now();
        let out = lenke_engine::exec::try_run(&plan, store).map_err(|e| e.to_string())?;
        best = best.min(t.elapsed().as_secs_f64() * 1e3);
        rows = out.rows.len();
    }
    Ok((plan_str, best, rows))
}

fn main() {
    let store = fixture(100_000, 5);

    // Each group: queries that MUST be semantically equivalent. Mixed GQL & Gremlin.
    let groups: &[(&str, &[(Lang, &str)])] = &[
        (
            // Item 550. ISO's `<order by and page statement>` (§14.10) can stand UNDER the
            // aggregate. A keyless `Aggregate` is one row and an order-free fold cannot read the
            // order, so these three are one question — and the two with the clause cost 10.10 and
            // 0.56ms against 0.01 before `apply_local` learned to elide them.
            "a vacuous ORDER BY / OFFSET statement vs none",
            &[
                (Gql, "MATCH (n:Person) RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) OFFSET 0 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) ORDER BY n.age RETURN count(*) AS c"),
            ],
        ),
        (
            "a vacuous ORDER BY statement under an aggregate",
            &[
                (Gql, "MATCH (n:Person) RETURN max(n.age) AS m"),
                (Gql, "MATCH (n:Person) ORDER BY n.age RETURN max(n.age) AS m"),
            ],
        ),
        (
            // Item 548. A trailing `FILTER <pred>` (ISO §14.6) asks what a clause `WHERE` on the
            // MATCH before it asks. The TS engine put the FILTER spelling one clause in front of
            // every detector and paid 3.5-8.6x for it; THIS engine never had the cliff — the two
            // spellings read 0.18/0.20, 0.91/0.88 and 0.51/0.51 ms before the fix, which is why
            // there was no Rust twin to build. This group is the guard on that.
            "a trailing FILTER vs a clause WHERE",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age > 50 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) FILTER n.age > 50 RETURN count(*) AS c"),
            ],
        ),
        (
            "a trailing FILTER vs a clause WHERE (one hop)",
            &[
                (Gql, "MATCH (:Person)-[:KNOWS]->(b) WHERE b.age > 50 RETURN count(*) AS c"),
                (Gql, "MATCH (:Person)-[:KNOWS]->(b) FILTER b.age > 50 RETURN count(*) AS c"),
            ],
        ),
        (
            // Item 616. The single most common serving query there is: give me the element
            // with this id. Gremlin has a SEED for it -- `g.V(id)` lowers to
            // `Plan::NodeSeed`, an O(1) external-id hash probe measured at 31-65 ns a seek
            // (item 615's `seed_cost_by_entry_point`). GQL has `element_id(n)` as a scalar
            // function and, as far as the crate goes, NOTHING that turns a predicate over it
            // into a seed: `Plan::NodeSeed` is constructed in exactly ONE place, the Gremlin
            // parser. So the question this group asks is whether the two surface languages
            // can express one point lookup at one cost, which is the probe's whole charter.
            //
            // The id is a Builder-minted dense-id string, so '12345' exists in a 100,000-node
            // fixture. Both spellings must return the same single row.
            "point lookup BY ID — Gremlin seed vs GQL element_id predicate",
            &[
                (Gremlin, "g.V('12345').values('age')"),
                (
                    Gql,
                    "MATCH (n:Person) WHERE element_id(n) = '12345' RETURN n.age AS a",
                ),
            ],
        ),
        (
            "count(*) — operand-free / count(n) / Gremlin",
            &[
                (Gql, "MATCH (n:Person) RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) RETURN count(n) AS c"),
                (Gremlin, "g.V().hasLabel('Person').count()"),
            ],
        ),
        (
            "predicate operand order (age > 50 vs 50 < age)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age > 50 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE 50 < n.age RETURN count(*) AS c"),
            ],
        ),
        (
            ">= operand order (age >= 30 vs 30 <= age)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age >= 30 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE 30 <= n.age RETURN count(*) AS c"),
            ],
        ),
        (
            "equality operand order (name = lit vs lit = name)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.name = 'name500' RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE 'name500' = n.name RETURN count(*) AS c"),
            ],
        ),
        (
            "inline {k:v} vs WHERE equality",
            &[
                (Gql, "MATCH (n:Person {dept: 'eng'}) RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.dept = 'eng' RETURN count(*) AS c"),
            ],
        ),
        (
            // The Rust twin of item 776's TS gap: an ANONYMOUS end node against a NAMED one that
            // nothing reads. In TypeScript `hopEnds` refused `node.variable === undefined`, so
            // `->()` fell to the general row pipeline and cost 4.6-4.9x the `->(b)` spelling.
            //
            // Here they are one question by construction — the two lower to one plan — and this
            // group is the guard on that, not a target. Added at item 779 together with the
            // inline-start pair below, because both TS gaps were fast-path ADMISSION gates and
            // this engine's defence against that class is canonicalization rather than a wider
            // gate.
            "an ANONYMOUS end node vs a named one",
            &[
                (Gql, "MATCH (:Person)-[r:KNOWS]->() RETURN count(r) AS c"),
                (Gql, "MATCH (:Person)-[r:KNOWS]->(b) RETURN count(r) AS c"),
            ],
        ),
        (
            // The HOP twin of the group above, which only covers a node SCAN (item 779). The TS
            // engine had an 8.4x gap in exactly this shape — `plainNode` refused a start with
            // inline properties, so the inline spelling fell off `detectHopProjection` while the
            // clause spelling was admitted (items 777/778) — and the scan case gave no warning,
            // because the scan rungs accept both spellings there.
            //
            // So this asks the Rust engine the same question one position along: an inline
            // property on the hop's START, against the same predicate in a clause `WHERE`, with a
            // PROJECTION rather than a count so the row-building path is exercised.
            //
            // THE ANSWER IS NEGATIVE, and it is the architecture's claim holding rather than luck:
            // both spellings lower to ONE optimized plan (0.664 ms against 0.653, and the probe's
            // own `identical optimized plan` check passes), so there is no Rust twin of items
            // 777/778 to build. The reason the two engines differ here is structural — TypeScript's
            // fast paths read the PATTERN, so a predicate's SPELLING decides which rung admits it,
            // while this engine canonicalizes before any routing decision is made. That is why 778
            // needed a clause-list rewrite (`liftStartProps`) and this side needs nothing.
            //
            // Both of these groups therefore stay as GUARDS, not targets: they are the test that
            // the canonicalization keeps covering the two positions where the other engine was
            // caught, and a future routing change that started reading the pattern instead of the
            // plan would show up here as a plan mismatch.
            "inline {k:v} on a hop START vs WHERE equality",
            &[
                (Gql, "MATCH (a:Person {dept: 'eng'})-[:KNOWS]->(b) RETURN count(b.age) AS c"),
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE a.dept = 'eng' RETURN count(b.age) AS c"),
            ],
        ),
        (
            "multi-predicate: inline map vs WHERE-AND (both orders)",
            &[
                (Gql, "MATCH (n:Person {dept: 'eng', age: 30}) RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.dept = 'eng' AND n.age = 30 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age = 30 AND n.dept = 'eng' RETURN count(*) AS c"),
            ],
        ),
        (
            // An endpoint LABEL on a quantified group. GQL emits `'Person' IN labels(t)` for
            // `(t:Person)`, and the optimizer canonicalizes that to `IsLabeled` — but only for a
            // slot it can PROVE holds a node, and it knew nothing about a group's endpoint, so
            // the inline spelling ran the boxed evaluator and built a label list per row. On
            // 50,000 vertices, degree 3, a `{1,2}` group: 89,017us -> 12,890us, 6.9x. A ONE-
            // repetition group here because `{1,2}` over this 100,000-vertex fixture is past the
            // trail budget; the shapes that need the bigger fixture are bench rows instead.
            //
            // This group could NOT have FOUND that bug, and it is worth being clear about why:
            // before the fix both spellings lowered to the same boxed `In`-over-`Call`, so the
            // probe read "identical plan, identical exec" at 75ms just as it now does at 9.6ms.
            // A canonicalization that fails UNIFORMLY is invisible to an equivalence check. The
            // guard for the absolute cost is the bench pair (`group count :label` against
            // `group count .prop`, two different predicates over one shape, where the GAP is the
            // signal); this group's job is the narrower invariant that the two LABEL spellings
            // never diverge from each other.
            "endpoint label on a group (inline vs IN labels())",
            &[
                (Gql, "MATCH ((a)-[:KNOWS]->(b)){1,1} (t:Person) RETURN count(*) AS c"),
                (
                    Gql,
                    "MATCH ((a)-[:KNOWS]->(b)){1,1} (t) WHERE 'Person' IN labels(t) \
                     RETURN count(*) AS c",
                ),
            ],
        ),
        (
            // The same two label spellings over a VAR-LENGTH AGGREGATE, which is a different
            // question from the group count above and was answered differently until item 372.
            // `try_varlen_agg` folds `sum`/`max` during the DFS, but matched `Plan::VarLength`
            // DIRECTLY — and an endpoint label lowers to a `Filter` ABOVE the hop, so the fold
            // was taken for `(b)` and declined for `(b:Person)`, which fell through to the
            // MATERIALIZING aggregate: 2.19x on a 50,000-node fixture, and at 200,000 x degree-5
            // the labelled spelling did not merely cost more, it hit the trail ROW CAP that a
            // fold never reaches and raised `E_RESOURCE_EXHAUSTED` where its twin returned an
            // answer. Both spellings here lower to the same `IsLabeled`, so they must agree on
            // plan AND time; the aggregate is what makes this group distinct from the count.
            "endpoint label on a var-length AGGREGATE (inline vs IN labels())",
            &[
                (Gql, "MATCH (a)-[:KNOWS]->{1,2}(b:Person) RETURN sum(b.age) AS c"),
                (
                    Gql,
                    "MATCH (a)-[:KNOWS]->{1,2}(b) WHERE 'Person' IN labels(b) \
                     RETURN sum(b.age) AS c",
                ),
            ],
        ),
        (
            // CONJUNCT ORDER. `A AND B` and `B AND A` are the same question, and the engine does
            // not normalize them: the optimizer leaves the conjuncts in the written order and
            // `zip_bool` evaluates BOTH operands over every row, so neither order short-circuits.
            //
            // Measured on 200,000 vertices with a selective compare and an EXISTS:
            //   age > 98 alone            334us
            //   EXISTS alone            1,123us
            //   age > 98 AND EXISTS     1,215us      <- additive, so EXISTS sees every row
            //   EXISTS AND age > 98       902us      <- 1.35x apart, stable over three runs
            //
            // The cheap conjunct here is on `dept`, which this fixture does NOT index — and that
            // is the point. When one conjunct IS seekable the seek extraction already pulls it
            // out whichever side it was written on, so an indexed spelling of this group reports
            // `identical plan` at 0.02ms and measures nothing: INDEX SEEDING ALREADY DOES
            // COST-ORDERING. The gap is the non-seekable case, where both predicates run over
            // every row. It also RETURNS ROWS rather than `count(*)`: a counted form hits a
            // count shortcut that bypasses the general filter path, reports `identical plan` at
            // 0.18ms and measures nothing of what this group is about.
            //
            // This group PASSES today, and it is recorded here with what it does and does not
            // establish, because sizing the gap took three wrong turns worth remembering:
            //
            //   * an INDEXED cheap conjunct reports `identical plan` at 0.02ms — seek extraction
            //     pulls it out whichever side it was written on, so index seeding already does
            //     cost-ordering, and that spelling measures nothing;
            //   * a `count(*)` form hits a count shortcut that bypasses the general filter path
            //     entirely, at 0.18ms;
            //   * the row-returning, non-seekable form above has IDENTICAL plans, so conjunct
            //     order is already normalized on this fixture.
            //
            // What IS established, by reading `zip_bool`: an `And`/`Or` mask evaluates BOTH
            // operands over EVERY row, always. So early elimination has something to win whenever
            // a selective cheap conjunct sits beside an expensive one and neither is seekable —
            // but the prize is NOT yet credibly sized, and a whole-query bench cannot size it
            // (the predicate is a minority of the total). That wants its own isolated harness.
            //
            // Separately: on the UNINDEXED `social_store` bench fixture the two orders measured
            // 1,208-1,246us against 893-902us, stable over three runs, which this fixture does not
            // reproduce. Unexplained, and not short-circuiting — `zip_bool` does not skip.
            //
            // ISO permits either resolution: US008 makes the actual order of expression
            // evaluation implementation-dependent, UA004 the raising of an exception from an
            // INESSENTIAL part (see `research/iso-39075/`).
            "conjunct order (cheap AND expensive, both ways)",
            &[
                (
                    Gql,
                    "MATCH (n:Person) WHERE n.dept = 'eng' AND EXISTS { (n)-[:KNOWS]->() } \
                     RETURN n.name AS x",
                ),
                (
                    Gql,
                    "MATCH (n:Person) WHERE EXISTS { (n)-[:KNOWS]->() } AND n.dept = 'eng' \
                     RETURN n.name AS x",
                ),
            ],
        ),
        (
            "IN list vs OR chain",
            &[
                (Gql, "MATCH (n:Person) WHERE n.dept IN ['eng', 'sales'] RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.dept = 'eng' OR n.dept = 'sales' RETURN count(*) AS c"),
            ],
        ),
        (
            // The 2-term group above cannot see this: `normalize_pred` rewrites an `IN` of
            // <=32 literals INTO an OR-chain, so at two terms both spellings become the
            // same chain and the plans match trivially. PAST the gate the `IN` stays an
            // `Expr::In` served by the hashed `in_set` while a user-written chain stays a
            // chain -- so 33 terms is the first length at which the two can diverge, and
            // nothing tested it. (Item 270 found and fixed exactly this in the TS engine,
            // where the group was also 2 terms.) `age` is `i % 100`, so both spellings
            // admit ages 0..32 and the answer check is meaningful.
            "IN list vs OR chain, 33 terms (past normalize_pred's 32 gate)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age IN [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32] RETURN count(*) AS c"),
                (
                    Gql,
                    "MATCH (n:Person) WHERE n.age = 0 OR n.age = 1 OR n.age = 2 OR n.age = 3 OR n.age = 4 OR n.age = 5 OR n.age = 6 OR n.age = 7 OR n.age = 8 OR n.age = 9 OR n.age = 10 OR n.age = 11 OR n.age = 12 OR n.age = 13 OR n.age = 14 OR n.age = 15 OR n.age = 16 OR n.age = 17 OR n.age = 18 OR n.age = 19 OR n.age = 20 OR n.age = 21 OR n.age = 22 OR n.age = 23 OR n.age = 24 OR n.age = 25 OR n.age = 26 OR n.age = 27 OR n.age = 28 OR n.age = 29 OR n.age = 30 OR n.age = 31 OR n.age = 32 \
                     RETURN count(*) AS c",
                ),
            ],
        ),
        (
            "range AND (two spellings of 30<=age<40)",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age >= 30 AND n.age < 40 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age < 40 AND n.age >= 30 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE 40 > n.age AND 30 <= n.age RETURN count(*) AS c"),
            ],
        ),
        (
            // A negated numeric LITERAL used to survive as `Arith { Sub, 0, 1 }`, which
            // the typed comparison fast paths decline — so `> -1` ran the boxed
            // evaluator over every row at 7.0x the cost of `>= 0` on a scan and 6.8x on
            // a traversal frontier. Nothing here tested a negative constant, which is
            // why the cliff stood. Every spelling below admits the same rows (age is
            // 0..99), so any spread is the plan.
            "negative literal (four spellings of \"every row\")",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age > -1 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age > -1.0 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age >= 0 RETURN count(*) AS c"),
                (Gql, "MATCH (n:Person) WHERE n.age >= -5 RETURN count(*) AS c"),
            ],
        ),
        (
            "negative literal on a traversal frontier",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > -1 RETURN count(*) AS c"),
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age >= 0 RETURN count(*) AS c"),
            ],
        ),
        (
            // NARROWED TWICE and now down to ~9x, with a cause that is no longer a
            // planning gap at all. This used to be 43x (1% selective) / 52.7x (10%):
            // the engine did not score both ends of a fixed-length pattern, so a
            // predicate on the FAR end never reached an index and the walk ran from
            // every node and filtered after. `orient` in opt.rs now reverses a one-hop
            // pattern so the predicated end seeds the walk, which closes most of it.
            //
            // The required label on `RangeSeek` was the second cause, and it is gone —
            // both property indexes are keyed by PROPERTY, so the label was only ever a
            // post-filter, and an unlabelled `(b)` now seeds like any other (E73).
            //
            // What is left is NOT a planning gap: both spellings seed identically now.
            // The backwards form counts by summing adjacency lengths, which never looks
            // at an edge, while the forwards form keeps a residual check above the hop
            // and so must visit every edge. Those are different questions — see E71 and
            // audit item 11, where four attempts to close it are recorded.
            "far-side predicate: forwards vs backwards (~9x, and not a penalty)",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE b.age > 98 RETURN count(*) AS c"),
                (Gql, "MATCH (b:Person)<-[:KNOWS]-(a) WHERE b.age > 98 RETURN count(*) AS c"),
            ],
        ),
        (
            // Was a 300x cliff, and the nastiest kind: adding a LABEL made it slower.
            // Both ends lower to stacked filters, the merge rule fuses them into one
            // `And`, and the Expand pushdown arm was all-or-nothing — so the slot-1
            // label check pinned the slot-0 range predicate above the hop and the walk
            // ran from every Person. The pushdown now splits per conjunct, and all
            // four spellings optimize to the same seek-then-expand plan.
            "far-side predicate with BOTH ends labelled",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE b.age > 98 RETURN count(*) AS c"),
                (Gql, "MATCH (b:Person)<-[:KNOWS]-(a:Person) WHERE b.age > 98 RETURN count(*) AS c"),
            ],
        ),
        (
            // The mirror of the group above, on the SEED side. Both spellings seed
            // identically now that pushdown splits — what is left (8.5x) is NOT a
            // seeding difference but a shortcut one: `count(*)` over a BARE `Expand`
            // sums degrees and never walks an edge, and the `(b:Person)` spelling
            // keeps a residual `IsLabeled` above the hop that makes the shortcut
            // impossible, so it enumerates paths instead. See E68 in
            // `simd_index_probe`, and audit item 11 — the fix is to teach the count
            // shortcut to tolerate a far-end label check.
            "seed-side predicate with BOTH ends labelled",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b:Person) WHERE a.age > 98 RETURN count(*) AS c"),
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) WHERE a.age > 98 RETURN count(*) AS c"),
            ],
        ),
        (
            // TWO hops, the widest gap this probe has ever measured: 178,357us written
            // forwards against 2,155us written backwards, because `reverse_chain` used
            // to require an Expand directly over a Scan and so left every longer
            // pattern in its written direction. Both spellings now produce the SAME
            // plan, which is why this group reads "identical optimized plan" rather
            // than two times that happen to agree.
            "two-hop far-side predicate: forwards vs backwards",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person) WHERE c.age > 98 RETURN count(*) AS n"),
                (Gql, "MATCH (c:Person)<-[:KNOWS]-(b:Person)<-[:KNOWS]-(a:Person) WHERE c.age > 98 RETURN count(*) AS n"),
            ],
        ),
        (
            // THREE hops, the widest gap ever measured in this repo: 263,502us written
            // forwards against 37us written backwards (at 50k nodes — the forwards form
            // did not finish at 200k). This is also where the rename stopped being a
            // single swap: the permutation is 0<->3 AND 1<->2, so the two MIDDLE slots
            // trade places too.
            "three-hop far-side predicate: forwards vs backwards",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b:Person)-[:KNOWS]->(c:Person)-[:KNOWS]->(d:Person) WHERE d.age > 99.5 RETURN count(*) AS n"),
                (Gql, "MATCH (d:Person)<-[:KNOWS]-(c:Person)<-[:KNOWS]-(b:Person)<-[:KNOWS]-(a:Person) WHERE d.age > 99.5 RETURN count(*) AS n"),
            ],
        ),
        (
            "1-hop projection: GQL vs Gremlin",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) RETURN b.name AS n"),
                (Gremlin, "g.V().hasLabel('Person').out('KNOWS').values('name')"),
            ],
        ),
        (
            // THE ONE-HOP COUNT, across the two surface languages — the shape with the biggest
            // documented fast path in this engine and, until item 789, the one cross-language
            // pair this probe did not carry.
            //
            // Items 285 and 286 are both about this count: the unfiltered branch of
            // `buildOneHopCount` went from an O(1) bucket size straight to a per-edge walk, and
            // giving it the degree-sum rung took 54.06 ms to 21.38. All of that work was reached
            // through the GQL spelling. Whether the GREMLIN spelling of the same question lands on
            // the same rung is a question about the single-IR claim — CLAUDE.md's "speed is a
            // property of the optimized plan, not the surface syntax" — and it had never been
            // asked for this shape.
            "one-hop count: GQL vs Gremlin",
            &[
                (Gql, "MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c"),
                (Gremlin, "g.V().hasLabel('Person').out('KNOWS').count()"),
            ],
        ),
        (
            // The same question with the hop UNLABELLED at the start, which is the member item
            // 286's group proved cannot converge with its labelled twin (O(1) against
            // O(|label|)). Here both members ARE the same work, so they must converge.
            "one-hop count, start unlabelled: GQL vs Gremlin",
            &[
                (Gql, "MATCH (a)-[:KNOWS]->(b) RETURN count(*) AS c"),
                (Gremlin, "g.V().out('KNOWS').count()"),
            ],
        ),
        (
            "filtered count: GQL vs Gremlin",
            &[
                (Gql, "MATCH (n:Person) WHERE n.age > 28 RETURN count(*) AS c"),
                (Gremlin, "g.V().hasLabel('Person').has('age', gt(28)).count()"),
            ],
        ),
        // The POINT LOOKUP by property equality, the single most common serving query there is —
        // and the shape item 362 measured a 1.74x cross-LANGUAGE gap on (`bench:usage`, unindexed:
        // GQL 53.0k ops/s against Gremlin 30.4k). Every cross-language group here was an aggregate
        // or a projection over the whole label; none was a selective equality, which is where a
        // seeding difference would show. Added at item 363 so the gap has a plan to look at rather
        // than a rate to wonder about.
        (
            "point lookup by property equality: GQL vs Gremlin",
            &[
                (Gql, "MATCH (n:Person) WHERE n.name = 'name12345' RETURN n.age AS a"),
                (
                    Gremlin,
                    "g.V().hasLabel('Person').has('name','name12345').values('age')",
                ),
            ],
        ),
        (
            "DISTINCT vs dedup",
            &[
                (Gql, "MATCH (n:Person) RETURN DISTINCT n.dept AS d"),
                (Gremlin, "g.V().hasLabel('Person').values('dept').dedup()"),
            ],
        ),
        (
            // ROWS_MAY_DIFFER: `groupCount()` is defined to return ONE Map, where the
            // GQL spelling returns one row per group. Same answer, different container
            // — so neither the row count nor the time is comparable across the two.
            "grouped count: GQL vs Gremlin groupCount [ROWS_MAY_DIFFER]",
            &[
                (Gql, "MATCH (n:Person) RETURN n.dept AS d, count(*) AS c"),
                (Gremlin, "g.V().hasLabel('Person').groupCount().by('dept')"),
            ],
        ),
        (
            "ordered top-k: GQL LIMIT vs Gremlin range",
            &[
                (Gql, "MATCH (n:Person) RETURN n.name AS name, n.age AS age ORDER BY age DESC LIMIT 2"),
                (Gremlin, "g.V().hasLabel('Person').order().by('age', desc).range(0, 2).values('name')"),
            ],
        ),
    ];

    let mut cliffs = 0;
    let mut gaps = 0;
    for (title, variants) in groups {
        println!("\n=== {title} ===");
        let mut results = Vec::new();
        for (lang, q) in *variants {
            let tag = match lang {
                Gql => "GQL ",
                Gremlin => "GRM ",
            };
            match plan_and_time(lang, q, &store) {
                Ok((plan, ms, rows)) => {
                    println!("  {tag}{ms:>8.3}ms  rows={rows:<7} {q}");
                    results.push(Some((plan, ms, rows)));
                }
                Err(e) => {
                    println!("  {tag}   ERR  {q}  -> {e}");
                    results.push(None);
                }
            }
        }
        // Separate a CAPABILITY gap (a variant did not parse — a missing feature, not
        // a perf finding) from a PERF CLIFF (all variants parsed but cost differs).
        let ok: Vec<&(String, f64, usize)> = results.iter().flatten().collect();
        if ok.len() < variants.len() {
            println!("  ○ capability gap: a variant did not parse/run (a syntax gap, not perf)");
            gaps += 1;
            continue;
        }
        let plan0 = &ok[0].0;
        let same_plan = ok.iter().all(|(p, _, _)| p == plan0);
        let rows0 = ok[0].2;
        let same_rows = ok.iter().all(|(_, _, r)| *r == rows0);
        let tmin = ok.iter().map(|(_, t, _)| *t).fold(f64::MAX, f64::min);
        let tmax = ok.iter().map(|(_, t, _)| *t).fold(0.0, f64::max);
        let ratio = if tmin > 0.0 { tmax / tmin } else { 1.0 };
        // Under ~1us the timer's own resolution dominates, and the ratio of two such
        // numbers is noise — the operand-free count group reported a 1.57x "cliff"
        // between two measurements that both printed as 0.000ms.
        if tmax < 0.001 {
            println!("  ✓ all variants below the timer's resolution — no cost to compare");
            continue;
        }
        // A group tagged ROWS_MAY_DIFFER returns the same answer in a different
        // CONTAINER (one Map vs one row per group), so both the row count and the
        // time are apples-to-oranges. Report it and move on rather than flagging it
        // every run as a cliff it is not.
        if title.contains("[ROWS_MAY_DIFFER]") {
            println!("  ✓ answers equivalent; row count and cost differ by design (see note)");
            continue;
        }
        if !same_rows {
            println!("  ⚠ ROW COUNT DIFFERS across spellings — not actually equivalent!");
            cliffs += 1;
        }
        if same_plan {
            println!("  ✓ identical optimized plan → identical exec (perf guaranteed)");
        } else if ratio > 1.5 {
            // Plans differ AND the cost differs materially — the real spelling cliff.
            println!("  ✗ PERF CLIFF: plans differ, time spread {ratio:.2}x (tmin {tmin:.3} tmax {tmax:.3})");
            cliffs += 1;
        } else {
            // Different plan shape (e.g. GQL vs Gremlin structure) but same cost — fine.
            println!("  ✓ plans differ but cost matches ({ratio:.2}x) — equivalent speed");
        }
    }

    println!("\n{}", "=".repeat(60));
    if cliffs == 0 {
        println!("NO PERF CLIFFS: every equivalent spelling converges on plan or cost.");
    } else {
        println!("{cliffs} PERF CLIFF(S) — see ✗/⚠ above.");
    }
    if gaps > 0 {
        println!("{gaps} capability gap(s) (unparsed variants) — feature gaps, not perf.");
    }
}
