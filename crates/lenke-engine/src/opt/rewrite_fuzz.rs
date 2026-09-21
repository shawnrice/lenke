//! Generative differential test for the optimizer: does rewriting change the answer?
//!
//! One invariant, and it is the optimizer's entire contract:
//!
//! ```text
//! for every plan p and store s:   run(optimize_indexed(p, s), s)  ≡  run(p, s)
//! ```
//!
//! `assert_rows_preserved` in `tests.rs` has always checked exactly this. The gap it
//! leaves is COVERAGE, and it is the expensive kind: the inputs are hand-written, so
//! they only ever cover bugs someone already thought of. Three wrong-answer bugs
//! shipped through that gap in one week (see below), and each was caught by the first
//! test written AFTER the fact. This generates the inputs instead.
//!
//! # Why the existing probes could not catch these
//!
//! It is tempting to say the integration probes measure speed and the unit tests check
//! answers. That is wrong, and believing it points at the wrong fix: `simd_index_probe`
//! E66/E69/E72 all DO assert answers, against an unindexed control, which is a sound
//! oracle. Those assertions ran and passed while the engine returned wrong rows.
//!
//! The oracle was fine. The FIXTURE could not express the error, for two independent
//! reasons, and every miss needed both:
//!
//! 1. **Interchangeable nodes.** `social_store` gives every node the label `Person` and
//!    every edge the type `KNOWS`. Orientation's whole job is permuting WHICH SLOT
//!    HOLDS WHICH NODE. On a graph where nodes are label-interchangeable, a permutation
//!    is close to unobservable by construction.
//! 2. **Permutation-invariant output.** E72 asks `count(*)`. No scramble of slots can
//!    change a count unless it changes which rows MATCH — which needs per-position
//!    predicates, which needs the fixture point 1 says we do not have.
//!
//! So the two things this module does differently are those two, inverted:
//!
//! - [`fixture`] makes every node distinguishable (a unique `name`) and every POSITION
//!   distinguishable (labels with deliberately different coverage, several edge types).
//!   If two slots hold different nodes, swapping them changes the output.
//! - [`gen_plan`] emits "project every slot, in order" as its most common shape. That
//!   projection is the canary. A generator that mostly emitted `count(*)` would inherit
//!   E72's blindness exactly.
//!
//! # The three it was built from
//!
//! - renaming slots across an `Aggregate`, which turned `count(*)` into a read of a
//!   column that does not exist, and with no projection at all returned the pattern's
//!   own slots reversed (`carol, carol` for `alice, bob`);
//! - a two-hop reversal that put the MIDDLE node's label check on the far end, dropping
//!   rows — invisible where every node carries the same label;
//! - a three-hop reversal renamed with a single end-swap, leaving slots 1 and 2 crossed
//!   — wrong only when the middle nodes are distinguishable.
//!
//! # It was validated by MUTATION TESTING, and that is the only reason to trust it
//!
//! This passed on the first run. So does a test that checks nothing, and the two look
//! identical from the outside — so each historical bug was re-introduced into `opt.rs`
//! and the fuzzer had to catch it:
//!
//! ```text
//!   rename with a single end-swap instead of the full permutation   seed 21
//!   an intermediate predicate placed on the far end                 seed 16
//!   orienting when the pattern's slots ARE the output columns       seed 0
//!   a residual filter above the pattern left un-renamed             seed 9
//! ```
//!
//! Two of those needed the GENERATOR widened before they were catchable, which is the
//! useful part — both were shapes a reasonable person forgets:
//!
//! - **no projection at all.** Every realistic query has a `RETURN`, so a generator
//!   naturally wraps every pattern in one. But that is precisely the shape where the
//!   pattern's slots are the result columns, and reversing them reorders the answer.
//! - **a `Distinct` between the pattern and its consumer.** Adjacent filters are merged
//!   by the fixpoint before orientation runs, so a residual filter can only survive
//!   above the pattern with something in between. Without that shape,
//!   `orient_apply`'s rename-the-filter-above branch is UNREACHABLE — confirmed by
//!   instrumenting it across 2,000 plans and never hitting it — and a mutation of that
//!   branch passed silently.
//!
//! # Widening it found a real bug, and four gaps in itself
//!
//! The first version chained one to three `Expand`s from a single scan. Widening it to
//! six hops, joins, var-length hops, mid-plan projections and disjunctions did two
//! things, and the second matters more than the first.
//!
//! It found a SHIPPED BUG, two days old, in `peel_hops`/`shift_slot`: both asked
//! `max_slot(pred) == Some(endpoint)` where they meant "reads that slot and no other".
//! A predicate over slots {1, 4} has a maximum of 4, so it was attributed to hop 4 and
//! renamed as though slot 1 were not there — emerging as a read of slot 4 at a point
//! where only slots 0 and 1 exist. `reverse_chain` documents this exact trap for the
//! FAR predicate, where a maximum of 0 is sufficient because 0 is also the minimum; the
//! middle of a chain has no such luck. See [`super::reads_only_slot`].
//!
//! And mutation testing found four holes in the GENERATOR, each invisible until a
//! mutation went uncaught:
//!
//! - **no projection at all** — every realistic query has a `RETURN`, so a generator
//!   wraps every pattern in one; but that is the shape whose slots ARE the result
//!   columns.
//! - **a `Distinct` between the pattern and its consumer** — without something in
//!   between, adjacent filters merge and `orient_apply`'s rename-the-filter-above
//!   branch is unreachable.
//! - **predicates reading more than one slot** — with single-slot predicates
//!   `split_pushable` never actually SPLITS, so the mixed-conjunction pushdown (the
//!   largest bug of the week) was generated exactly never.
//! - **disjunctions** — a mixed `And` is taken apart by that same split before
//!   orientation sees it, so only a mixed `Or` reaches `reverse_chain` still reading
//!   both ends. Adding them is what surfaced the shipped bug above.
//!
//! The pattern is consistent: the gaps were all shapes that are *rare in real queries*
//! and therefore absent from an unexamined generator, while being exactly where the
//! rewrites' assumptions are load-bearing.
//!
//! # A second widening, and what it cost
//!
//! Adding predicate variety — all four range operators, BOTH OPERAND ORDERS, equality
//! on a hash-indexed key, `IN`, `PropertyExists`, `Not`, two-sided ranges — plus absent
//! properties, deleted nodes and two more indexed keys, did three things worth knowing:
//!
//! - It made the repo's OWN documented bug class testable for the first time. "The
//!   planner recognized one spelling and scanned for another" is the shape behind every
//!   index-seeding bug in the old engine; a mutation that stops `range_seek_target`
//!   flipping the operator for `lit < prop` is caught at seed 22, and could not have
//!   been caught at all before, because only one operand order was ever generated.
//! - It DILUTED the rewrites under study, twice. Plans reaching an index fell 659 → 164
//!   (nine predicate forms, of which four seed), then recovered to 444 once the anchor
//!   position was restricted to seekable forms and the new keys were actually indexed.
//!   Only the coverage test noticed; every correctness test stayed green throughout.
//! - It made a shape stop being generated by ACCIDENT. The two-slot intermediate
//!   predicate that found yesterday's bug arose only when pushdown happened to relocate
//!   a top-level `Or` into the middle of a chain. Diluting the corpus broke that
//!   accident, and the mutation for a bug this fuzzer had found the day before stopped
//!   being caught. It is now generated deliberately. **A shape worth testing is worth
//!   generating on purpose** — relying on one rewrite to set up another's test case is
//!   a dependency nobody records and everybody breaks.
//!
//! # A third widening: bound edges, and an index that changed the answer
//!
//! Teaching the generator `bind_edge` hops — which append TWO slots, edge then node —
//! turned it red on the FIRST run, and on a shipped feature rather than this week's
//! work. An interval-index SEEK did not filter by edge type. The RI-tree is keyed on
//! the interval alone and knows nothing about types, and the seek path pushed every
//! overlapping edge without consulting `want`, while the SCAN path had always filtered
//! correctly via `for_each_nbr`.
//!
//! So `-[r:T]->` with an interval predicate returned edges of every type the moment an
//! interval index existed. **Creating an index changed the answer**, silently, on
//! exactly the bitemporal "as of" query the index exists to serve. Nothing had caught
//! it because every test covering interval overlap had either one edge type or no
//! index — the bug needs both an index AND a type filter, and no hand-written fixture
//! had ever combined them.
//!
//! Bound edges were picked deliberately rather than at random: every bug this fuzzer
//! has found is a slot index computed one way in one place and another way somewhere
//! else, and a hop appending two slots is where such an assumption breaks first.
//!
//! # A fourth widening: paging, ordering and real aggregates
//!
//! `ORDER BY` / `LIMIT` needed a change to the ORACLE, not just the generator, and the
//! reasoning is the interesting part. `OrderPage` sorts STABLY, so when sort keys tie,
//! which rows survive a `LIMIT` depends on the order rows arrived in — and the arrival
//! order is exactly what optimizing is allowed to change. Comparing sequences under
//! ties would report differences the engine is free to have.
//!
//! The way out is to make the key TOTAL: every page sorts on a tuple of all slots'
//! `name`, which is unique per node, so the only equal keys are identical rows. The
//! window is then the same whatever the arrival order, and `check` can compare ORDER
//! and not merely membership — strictly stronger, and it catches a top-k returning the
//! right rows in the wrong sequence. Edges have no `name`, so a chain carrying a bound
//! edge simply is not paged, rather than paged under a key that is only nearly total.
//!
//! This round found no engine bug. It found one in the FUZZER: the first version sorted
//! `Prop{slot,"name"}` above a projection, where the slots already hold names, so every
//! key was null, every key tied, and it reported a "failure" at seed 1461 that was the
//! oracle's fault. Worth stating plainly because a generative test that reports a
//! difference is persuasive, and the first question has to be whether the difference is
//! real.
//!
//! Also added: aggregates beyond `count` (`Sum`/`Min`/`Max`/`Avg`, optionally
//! `DISTINCT`, optionally grouped), each of which routes to a different fast path.
//!
//! # A fifth widening: set operations, and two more bugs
//!
//! `UNION` / `EXCEPT` / `INTERSECT` are the only place this generator nests one whole
//! query inside another, capped at one level. Adding them found a **user-facing panic
//! reachable from ordinary GQL**:
//!
//! ```text
//! MATCH (a:Person)-[:KNOWS]->(b) RETURN a.name AS x, b.name AS y
//! UNION ALL MATCH (n:Person) RETURN n.name AS x
//! ```
//!
//! The general path had always padded a short arm's rows with NULLs exactly as
//! `Plan::Union` documents. The bug was in the fast-path GUARD, which indexes the right
//! arm up to the LEFT arm's width and was computed EAGERLY — before the width check in
//! the `if` that guards it. So the out-of-range read happened while deciding whether
//! the fast path applied, in a case where it never did.
//!
//! Orientation also learned to see through `OrderPage`, which it previously declined
//! outright, so a pattern under an `ORDER BY` never oriented.
//!
//! # The oracle is the thing most likely to be wrong
//!
//! Twice now a reported failure has been this file's fault rather than the engine's,
//! and both times the mistake was the same shape: a claim about the SORT KEY that was
//! not checked.
//!
//! - Sorting `Prop{slot,"name"}` above a projection, where the slots already hold the
//!   names, so every key was null and every row tied (seed 1461).
//! - Treating `keys.len() >= width` as "total", which a one-key page over a one-column
//!   input satisfies while sorting on a property with seven values (seed 96445).
//!
//! Both produced confident, reproducible "differences". The first question about any
//! failure here is whether the difference is real, and the second is whether the oracle
//! earned the right to make the comparison it made.
//!
//! # A sixth widening: shortest paths and quantified groups
//!
//! Both were picked for the same reason bound edges were: SLOT ARITHMETIC. Every bug
//! this has found is an index computed one way in one place and another way somewhere
//! else, and these two are where there is most room to get that wrong.
//!
//! `RepeatGroup` is the extreme case — it appends the endpoint FIRST and then one LIST
//! column per `group_binds` entry, so a hop grows the row by `1 + binds` rather than by
//! one. `ShortestPath` is tamer but has its own predicate-pushdown arm, built on the
//! same `split_pushable` the `Expand` arm only learned to use this week.
//!
//! Both also carry a predicate over a MINI-SCOPE rather than the outer row —
//! `ShortestPath`'s `edge_pred` reads the edge at scalar slot 0, `RepeatGroup`'s
//! `per_rep_pred` reads source/edge/target at slots 0/1/2 — so anything renaming slots
//! while walking a plan has to leave them alone. A generator that never emitted one
//! could not tell whether that held.
//!
//! No engine bug this round, but not vacuous either: the `ShortestPath` pushdown arm is
//! reached over 23,000 times in a default sweep, and a mutation that drops its residual
//! is caught.
//!
//! One measurement fixed along the way: `multi_hop` counted only `Expand`s, so a chain
//! whose second hop was var-length or shortest-path read as single-hop. Adding these
//! operators looked like a 40% coverage LOSS that was entirely the metric's fault.
//!
//! # A seventh widening: optional hops, and a whole CLASS of panic
//!
//! `OptionalExpand` is the only operator here that puts a NULL NODE into a frontier: a
//! row with no matching neighbour lands the `u32::MAX` sentinel. Generating it turned
//! the fuzzer red immediately, and kept it red through six further sites, because the
//! bug was not one place — it was a CLASS.
//!
//! Every TYPED fast path in the filter and mask layers read its column by the frontier
//! id directly (`present[id as usize]`), while the general `eval_mask` path had always
//! treated the sentinel as UNKNOWN and dropped the row. So the panic appeared only when
//! the predicate was simple enough to take a fast path — which is the common case.
//! Eleven guards across eight functions now; `index_seek_ids` and `range_seek_ids` take
//! their ids from the store and cannot see a sentinel, so they are left alone.
//!
//! Reachable from ordinary GQL in two spellings (`WHERE` directly inside `OPTIONAL
//! MATCH` is rejected by the parser, which is why the obvious one was safe):
//!
//! ```text
//! MATCH (a:N) OPTIONAL MATCH (a)-[:T]->(x) FILTER x.age > 0 RETURN a.name AS n
//! MATCH (a:N) OPTIONAL MATCH (a)-[:T]->(x) MATCH (a) WHERE x.age > 0 RETURN a.name AS n
//! ```
//!
//! # Everything generated was renameable, so the rename guards were untested
//!
//! Mutation testing then found a SYSTEMATIC hole rather than a missing shape. Every
//! expression this generator emitted — `Prop`, `IsLabeled`, `Compare`, `And`/`Or`/`Not`,
//! `In`, `PropertyExists`, `Slot` — is one `map_slots` can rewrite. So every
//! `swap_slots(...).is_some()` check in `orient_scan`, over projection items, aggregate
//! keys, filter predicates and sort keys, was trivially TRUE, and deleting one changed
//! nothing.
//!
//! Those checks exist for what the rename REFUSES: records, maps, CASE, index reads, the
//! subquery family, every path expression. [`gen_unrenameable`] emits a `Case`, which is
//! the cheapest of those and the only one that still evaluates to an ordinary value, so
//! the plan runs and the comparison stays meaningful — the point being that orientation
//! must DECLINE rather than rewrite around it. Two guards that were no-ops against the
//! old corpus are now caught when removed.
//!
//! The lesson generalizes past this file: a generator built only from the shapes a
//! rewrite ACCEPTS cannot test the branch where it declines.
//!
//! # Reading an uncaught mutation
//!
//! It means one of two things, and they are opposite. Either the generator cannot reach
//! the shape (a real hole — widen it), or the mutated code is REDUNDANT with another
//! guard that catches the same error (defence in depth — nothing to fix). The
//! `max_slot`-versus-`reads_only_slot` pair is the second kind: reverting either guard
//! alone is masked by the other, and only reverting BOTH reproduces the bug. Check
//! which case you are in before widening anything.
//!
//! When adding a rewrite, mutate it and check this catches it. A generative test whose
//! teeth have never been verified is worse than no test, because it is believed.
//!
//! # Density falls as shapes are added, and that is fine
//!
//! Every widening spends probability that used to go somewhere else, so the fraction of
//! plans reaching any given rewrite drifts down — plans that seed an index went 33% to
//! 10% across five widenings. That is arithmetic, not decay: fixed probability mass
//! spread over more shapes, while the total reachable SURFACE grows every time. The
//! extra seeds are not buying back something lost; they are covering the shapes that
//! did not exist before.
//!
//! So the answer is just to run more seeds, and seeds are nearly free — 25k in 2.2s,
//! in parallel with the rest of the suite. The density floors in the coverage test
//! still get recalibrated as shapes are added; their job is to catch the generator
//! silently drifting to trivia, not to hold any particular mix. Lowering a floor while
//! SHRINKING the sweep would be the thing to avoid.
//!
//! If density ever fell far enough that covering one rewrite needed a genuinely slow
//! sweep, the answer would be weighted generation — bias the mix toward under-covered
//! shapes — not a smaller generator. Nowhere near that: every mutation is still caught
//! under seed 1,200.
//!
//! # Scope
//!
//! Deliberately narrow, and narrow in a way that keeps failures readable: 24 nodes,
//! degree 2-3, at most three hops. A failing seed is small enough to print and step
//! through, and even a fully unoriented three-hop cross product stays trivial. Seeds
//! are fixed so CI is deterministic; `LENKE_OPT_FUZZ_SEEDS` runs more locally.

use super::{optimize_indexed, IndexOracle};
use crate::exec::Rows;
use crate::ir::{Agg, AggFn, CompareOp, Dir, Expr, PathMode, Plan};
use crate::store::{Builder, Store};
use crate::value::Value;

/// A dep-free deterministic PRNG, so a failing seed replays exactly.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        // Numerical Recipes' LCG constants; adequate for choosing between a handful
        // of shapes, and the point here is reproducibility, not statistical quality.
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        self.0 >> 16
    }

    /// A value in `0..n`.
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }

    /// True with probability `num/den`.
    fn chance(&mut self, num: u64, den: u64) -> bool {
        self.next() % den < num
    }

    fn pick<'a, T>(&mut self, xs: &'a [T]) -> &'a T {
        &xs[self.below(xs.len())]
    }
}

/// Labels carried by fixture nodes, in DELIBERATELY different proportions — the point
/// is that `IsLabeled(slot i, L)` and `IsLabeled(slot j, L)` select different things,
/// so moving a label check between positions changes the answer.
const LABELS: [&str; 4] = ["Node", "Wide", "Half", "Rare"];
/// Edge types, so a hop's type is a distinguishing feature too.
const ETYPES: [&str; 3] = ["T1", "T2", "T3"];
/// A low-cardinality string property — what an equality seek is actually for.
const TAGS: [&str; 3] = ["red", "green", "blue"];
/// Numeric keys, one always present and one sometimes absent.
const NUM_KEYS: [&str; 2] = ["age", "score"];

const NODES: u32 = 24;

/// A graph where every node and every POSITION is distinguishable.
///
/// Each node gets a unique `name`, so a projection of the pattern's slots is a
/// fingerprint of which node landed where. `age` spreads over 0..20 so a range
/// predicate can be genuinely selective — orientation is gated on the far predicate
/// selecting under ~15% of the graph, so without tight bounds the rewrite under test
/// would simply decline and the fuzzer would cover nothing.
fn fixture(seed: u64) -> Store {
    let mut rng = Lcg(seed ^ 0x9E37_79B9_7F4A_7C15);
    let mut b = Builder::default();

    for i in 0..NODES {
        let mut labels: Vec<&str> = vec!["Node"];
        if i % 2 == 0 {
            labels.push("Half"); // 50%
        }
        if i % 3 == 0 {
            labels.push("Wide"); // 33%
        }
        if i % 8 == 0 {
            labels.push("Rare"); // 12%
        }
        // Three property shapes on purpose. `name` is unique (the permutation
        // fingerprint); `age` is numeric and SOMETIMES ABSENT, so a predicate over it
        // is three-valued and a seek has to agree with a scan about the missing rows;
        // `tag` is a low-cardinality string, which is what a hash seek is for.
        let mut props: Vec<(&str, Value)> = vec![
            ("name", Value::Str(format!("n{i}").into())),
            ("score", Value::Num(f64::from(i % 7))),
            (
                "tag",
                Value::Str(TAGS[(i % TAGS.len() as u32) as usize].into()),
            ),
        ];
        if i % 9 != 0 {
            props.push(("age", Value::Num(f64::from(i % 20))));
        }
        b.node(&labels, &props);
    }

    for i in 0..NODES {
        for _ in 0..(2 + rng.below(2)) {
            let dst = rng.below(NODES as usize) as u32;
            b.edge(i, dst, ETYPES[rng.below(ETYPES.len())]);
        }
    }

    let mut store = b.build();

    // EDGE PROPERTIES, so a BOUND edge variable has something to be predicated on.
    // `lo`/`hi` are a half-open interval per edge, which is what the interval-overlap
    // fusion rewrite exists for; `w` is an ordinary numeric for range predicates.
    for eid in 0..store.edge_count() as u32 {
        let lo = f64::from(eid % 10);
        store.set_edge_prop(eid, "lo", Value::Num(lo));
        store.set_edge_prop(eid, "hi", Value::Num(lo + f64::from(1 + eid % 5)));
        store.set_edge_prop(eid, "w", Value::Num(f64::from(eid % 6)));
    }

    // DELETED nodes. `range_seek_ids` filters them out explicitly and a plain scan
    // must agree — a seek that forgets the tombstone check returns rows the scan does
    // not, which is exactly the kind of divergence a hand-written fixture never has,
    // because hand-written fixtures are freshly built.
    for i in 0..NODES {
        if i % 11 == 7 {
            store.delete_node(i);
        }
    }

    store
}

/// Index every key the generator writes predicates against.
///
/// Indexing only some of them is a silent coverage hole rather than a conservative
/// choice: `seedable` asks the oracle, so a predicate on an UNINDEXED key makes
/// orientation decline, and widening the generator to `tag` and `score` without
/// indexing them dropped plans-that-reach-an-index from 659 per 2,000 to 169.
fn index_all(store: &mut Store) {
    store.create_index("name");
    store.create_index("tag");
    store.create_range_index("age");
    store.create_range_index("score");
    // The RI-tree over each edge's half-open [lo, hi). Without it the interval-overlap
    // rewrite still fires (`IntervalExpand` is seek-or-scan), but the seek half of it
    // is never exercised.
    store.create_interval_index("lo", "hi");
}

/// A predicate reading exactly `slot`, in one of the forms the planner recognizes.
///
/// The variety here is the point, and it targets the bug class this repo has been bitten
/// by most: every index-seeding bug found in the old engine had the shape "the planner
/// recognized ONE SPELLING of a predicate and scanned for another that meant exactly the
/// same thing". The first version of this generator emitted `Gt`/`Ge` on one numeric key
/// in one operand order — so `IndexSeek` (equality, hash) was barely reached at all, and
/// the mirrored spelling `lit < prop` never once.
fn gen_pred(rng: &mut Lcg, slot: usize, selective: bool) -> Expr {
    let kind = rng.below(KIND_COUNT);
    gen_pred_kind(rng, slot, selective, kind)
}

/// The predicate that ANCHORS a pattern — the far-side one orientation seeds from.
///
/// Restricted to the forms a seek can actually serve, and that restriction is
/// load-bearing. Widening `gen_pred` from two forms to nine diluted the seekable ones
/// so far that plans reaching an index fell from 659 per 2,000 to 164. The coverage
/// test caught it, which is exactly why that test exists — the exotic forms still
/// appear in every other position, they just no longer crowd the rewrites under study
/// out of the one position that triggers them.
fn gen_anchor_pred(rng: &mut Lcg, slot: usize, selective: bool) -> Expr {
    let kind = *rng.pick(&SEEKABLE_KINDS);
    gen_pred_kind(rng, slot, selective, kind)
}

/// How many predicate forms [`gen_pred_kind`] knows.
const KIND_COUNT: usize = 9;
/// The forms a seek can serve: range compares (either operand order), string equality,
/// and a two-sided range.
const SEEKABLE_KINDS: [usize; 5] = [1, 2, 3, 4, 8];

fn gen_pred_kind(rng: &mut Lcg, slot: usize, selective: bool, kind: usize) -> Expr {
    // A SELECTIVE bound is what makes orientation eligible (under ~15% of the graph).
    // Ages run 0..20 over 24 nodes, so `> 17` is about two; the loose bounds exist so
    // the "declines, correctly" path is covered too.
    let num_bound = |rng: &mut Lcg| {
        if selective {
            *rng.pick(&[17.0, 18.0, 16.0])
        } else {
            *rng.pick(&[-1.0, 0.0, 5.0])
        }
    };

    match kind {
        0 => Expr::IsLabeled {
            slot,
            labels: vec![(*rng.pick(&LABELS)).to_string()],
        },

        // A numeric comparison, EITHER OPERAND ORDER. `age > 17` and `17 < age` are
        // the same query and must optimize to the same plan; `range_seek_target`
        // flips the operator for the mirrored form, and nothing was testing that.
        1..=3 => {
            // `score` has only 7 distinct values, so a bound on it is never under the
            // ~15% orientation threshold; `age` spreads over 20 and can be. When the
            // caller wants SELECTIVE, it has to be a key capable of selectivity, or
            // the rewrite correctly declines and the plan covers nothing.
            let key = if selective {
                "age".to_string()
            } else {
                (*rng.pick(&NUM_KEYS)).to_string()
            };
            let op = *rng.pick(&[CompareOp::Gt, CompareOp::Ge, CompareOp::Lt, CompareOp::Le]);
            let bound = Expr::Lit(Value::Num(num_bound(rng)));
            let prop = Expr::Prop { slot, key };
            if rng.chance(1, 2) {
                Expr::Compare {
                    op,
                    left: Box::new(prop),
                    right: Box::new(bound),
                }
            } else {
                Expr::Compare {
                    op: flip_op(op),
                    left: Box::new(bound),
                    right: Box::new(prop),
                }
            }
        }

        // EQUALITY on a low-cardinality string — the shape a hash index exists for,
        // and the one that becomes an `IndexSeek`. Both operand orders again.
        4 => {
            // Equality on `tag` matches a third of the graph; equality on `name` (which
            // is unique) matches one node. Both are hash-indexed and both are worth
            // generating — but only the second is selective enough to orient, so the
            // caller's intent decides which.
            let (key, lit) = if selective {
                (
                    "name",
                    Expr::Lit(Value::Str(format!("n{}", rng.below(NODES as usize)).into())),
                )
            } else {
                ("tag", Expr::Lit(Value::Str((*rng.pick(&TAGS)).into())))
            };
            let prop = Expr::Prop {
                slot,
                key: key.into(),
            };
            let op = *rng.pick(&[CompareOp::Eq, CompareOp::Ne]);
            if rng.chance(1, 2) {
                Expr::Compare {
                    op,
                    left: Box::new(prop),
                    right: Box::new(lit),
                }
            } else {
                Expr::Compare {
                    op,
                    left: Box::new(lit),
                    right: Box::new(prop),
                }
            }
        }

        // `prop IN [a, b]`, which the planner treats as a disjunction of equalities
        // and has its own seeding path (`k = $a OR k = $b` vs `k IN [$a, $b]` is on
        // the repo's list of spellings that once differed by 100-300x).
        5 => Expr::In {
            needle: Box::new(Expr::Prop {
                slot,
                key: "tag".into(),
            }),
            haystack: Box::new(Expr::List {
                items: vec![
                    Expr::Lit(Value::Str((*rng.pick(&TAGS)).into())),
                    Expr::Lit(Value::Str((*rng.pick(&TAGS)).into())),
                ],
            }),
        },

        // PRESENCE, which is not a comparison and is three-valued in its own way —
        // `age` is deliberately absent on some nodes.
        6 => Expr::PropertyExists {
            slot,
            key: (*rng.pick(&NUM_KEYS)).to_string(),
        },

        // NEGATION. `Not` is not seedable, so this covers the planner correctly
        // DECLINING to seed something that looks close to a seekable compare.
        7 => Expr::Not(Box::new(Expr::Compare {
            op: CompareOp::Lt,
            left: Box::new(Expr::Prop {
                slot,
                key: "score".into(),
            }),
            right: Box::new(Expr::Lit(Value::Num(f64::from(rng.below(7) as u32)))),
        })),

        // TWO BOUNDS ON ONE KEY, which the planner coalesces into a single two-sided
        // range seek. Written in both directions so the coalescing has to normalize.
        _ => {
            let key = if selective {
                "age".to_string()
            } else {
                (*rng.pick(&NUM_KEYS)).to_string()
            };
            let lo = Expr::Compare {
                op: CompareOp::Ge,
                left: Box::new(Expr::Prop {
                    slot,
                    key: key.clone(),
                }),
                right: Box::new(Expr::Lit(Value::Num(num_bound(rng) - 4.0))),
            };
            let hi = Expr::Compare {
                op: CompareOp::Lt,
                left: Box::new(Expr::Prop { slot, key }),
                right: Box::new(Expr::Lit(Value::Num(num_bound(rng) + 4.0))),
            };
            if rng.chance(1, 2) {
                Expr::And(Box::new(lo), Box::new(hi))
            } else {
                Expr::And(Box::new(hi), Box::new(lo))
            }
        }
    }
}

/// `a OP b` means the same as `b flip(OP) a`.
fn flip_op(op: CompareOp) -> CompareOp {
    match op {
        CompareOp::Lt => CompareOp::Gt,
        CompareOp::Le => CompareOp::Ge,
        CompareOp::Gt => CompareOp::Lt,
        CompareOp::Ge => CompareOp::Le,
        other => other,
    }
}

/// Edge property keys, for predicates on a BOUND edge variable.
const EDGE_KEYS: [&str; 3] = ["w", "lo", "hi"];

/// A predicate on a bound EDGE slot.
///
/// Edges are a separate namespace from nodes in every way that matters here: their
/// properties are stored apart, `IsLabeled` on an edge compares the TYPE name rather
/// than a label bucket, and a `bind_edge` hop appends the edge and the node as two
/// slots, so any arithmetic that assumes one slot per hop is wrong by one and keeps
/// being wrong further up the chain.
fn gen_edge_pred(rng: &mut Lcg, slot: usize) -> Expr {
    match rng.below(4) {
        // The INTERVAL-OVERLAP shape: `r.lo <= qhi AND r.hi >= qlo`, which the planner
        // fuses into an `IntervalExpand`. The operators are not interchangeable — `lo`
        // takes the `<=` side and `hi` the `>=` side — so this is also a check that the
        // fusion refuses the other spellings rather than quietly mixing up the axes.
        0 | 1 => {
            let qlo = f64::from(rng.below(8) as u32);
            Expr::And(
                Box::new(Expr::Compare {
                    op: CompareOp::Le,
                    left: Box::new(Expr::Prop {
                        slot,
                        key: "lo".into(),
                    }),
                    right: Box::new(Expr::Lit(Value::Num(qlo + 3.0))),
                }),
                Box::new(Expr::Compare {
                    op: CompareOp::Ge,
                    left: Box::new(Expr::Prop {
                        slot,
                        key: "hi".into(),
                    }),
                    right: Box::new(Expr::Lit(Value::Num(qlo))),
                }),
            )
        }
        // An ordinary range on an edge property — must NOT fuse, and must not be
        // mistaken for a node predicate by anything that pushes filters around.
        2 => Expr::Compare {
            op: *rng.pick(&[CompareOp::Gt, CompareOp::Le]),
            left: Box::new(Expr::Prop {
                slot,
                key: (*rng.pick(&EDGE_KEYS)).to_string(),
            }),
            right: Box::new(Expr::Lit(Value::Num(f64::from(rng.below(6) as u32)))),
        },
        // `IsLabeled` on an EDGE tests its type, not a node label.
        _ => Expr::IsLabeled {
            slot,
            labels: vec![(*rng.pick(&ETYPES)).to_string()],
        },
    }
}

/// A generated subplan and the width (slot count) it produces. Width has to be
/// tracked explicitly: `Expand`/`VarLength` append one slot, a `Join` concatenates
/// both sides' slots, and a mid-plan `Project` replaces the namespace entirely.
struct Gen {
    plan: Plan,
    width: usize,
    /// Whether any slot holds an EDGE rather than a node. Sorting needs to know: the
    /// only property that is unique per element here is `name`, and edges do not have
    /// one, so a chain with a bound edge cannot be given a TOTAL sort key.
    bound_edge: bool,
}

/// How many hops to chain. Weighted hard toward the short patterns real queries are
/// made of, with the deep ones RARE rather than absent: a six-hop walk over this
/// fixture is a few tens of thousands of rows, which is fine occasionally and far too
/// slow as the common case.
fn gen_hop_count(rng: &mut Lcg) -> usize {
    match rng.below(100) {
        0..=44 => 1,
        45..=74 => 2,
        75..=89 => 3,
        90..=95 => 4,
        96..=98 => 5,
        _ => 6,
    }
}

/// A seed: a labelled or unlabelled scan. Both matter — the seeks' label became
/// optional, so an unlabelled scan now reaches an index too, and the two take
/// different paths through the seeding rules.
fn gen_seed(rng: &mut Lcg) -> Gen {
    let label = if rng.chance(3, 4) {
        Some((*rng.pick(&LABELS)).to_string())
    } else {
        None
    };
    Gen {
        plan: Plan::Scan { label },
        width: 1,
        bound_edge: false,
    }
}

/// A chain: a seed, then `hops` hops, each an `Expand` or (rarely) a `VarLength`, with
/// intermediate filters between them.
///
/// `deep` chains are steered toward `Dir::Out` and a single edge type. Not for
/// realism — to bound the fan-out, since a six-hop `Both` walk over a degree-3 graph
/// is millions of paths and would make this test a benchmark.
fn gen_chain(rng: &mut Lcg, hops: usize) -> Gen {
    let mut g = gen_seed(rng);
    let deep = hops >= 4;

    for h in 0..hops {
        let etypes: Vec<String> = if deep || rng.chance(3, 4) {
            vec![(*rng.pick(&ETYPES)).to_string()]
        } else {
            Vec::new() // any type
        };
        let dir = if deep {
            Dir::Out
        } else {
            *rng.pick(&[Dir::Out, Dir::In, Dir::Both])
        };

        // A VARIABLE-LENGTH hop now and then. This is not decoration: the pushdown
        // arm for `VarLength` is the one that has always SPLIT its predicate (the
        // `Expand` arm only learned to this week), and `max_slot` claims `usize::MAX`
        // for path expressions specifically to stop them being pushed below one.
        if !deep && rng.chance(1, 8) {
            let min = rng.below(2) as u32;
            g.plan = Plan::VarLength {
                input: Box::new(g.plan),
                from: g.width - 1,
                dir,
                edge_label: etypes,
                min,
                max: min + 1 + rng.below(2) as u32,
                mode: *rng.pick(&[
                    PathMode::Walk,
                    PathMode::Trail,
                    PathMode::Simple,
                    PathMode::Acyclic,
                ]),
                until: None,
                body_filter: None,
                double_loops: false,
            };
        } else if !deep && rng.chance(1, 9) {
            // A SHORTEST-PATH hop: BFS emitting each reachable target once, appending
            // it as one slot. It has its own predicate-pushdown arm in `opt`, built on
            // the same `split_pushable` that the `Expand` arm only learned this week —
            // and it is one of two operators that orientation must refuse, since
            // `peel_hops` accepts nothing but plain hops.
            //
            // `edge_pred` is the interesting part: it reads the EDGE at scalar slot 0
            // of a MINI-SCOPE, not the outer slot 0. Anything that renames slots while
            // walking the plan has to leave it alone, and a generator that never emits
            // one would never notice.
            let edge_pred = rng.chance(1, 2).then(|| {
                Box::new(Expr::Compare {
                    op: CompareOp::Ge,
                    left: Box::new(Expr::Prop {
                        slot: 0,
                        key: "w".into(),
                    }),
                    right: Box::new(Expr::Lit(Value::Num(f64::from(rng.below(4) as u32)))),
                })
            });
            g.plan = Plan::ShortestPath {
                input: Box::new(g.plan),
                from: g.width - 1,
                dir,
                edge_label: etypes,
                min: rng.below(2) as u32,
                // Bounded: an unbounded BFS over this fixture reaches everything, which
                // is slow and says little.
                max: Some(1 + rng.below(3) as u32),
                selector: *rng.pick(&[
                    crate::ir::ShortestSelector::Any,
                    crate::ir::ShortestSelector::All,
                    crate::ir::ShortestSelector::ShortestK { k: 2, group: false },
                    crate::ir::ShortestSelector::ShortestK { k: 2, group: true },
                ]),
                edge_pred,
            };
            g.width += 1;
            continue;
        } else if !deep && rng.chance(1, 9) {
            // A quantified subpath GROUP: like a var-length hop, but it also binds the
            // repetition's variables as LIST columns.
            //
            // This is the most intricate slot arithmetic in the IR — the endpoint is
            // appended FIRST, then one list column per `group_binds` entry, so the hop
            // grows the row by `1 + group_binds.len()` rather than by one. Every bug
            // this fuzzer has found is a slot index computed one way in one place and
            // another way somewhere else, and this is the operator with the most ways
            // to get that wrong.
            //
            // `per_rep_pred` reads a MINI-SCOPE (source=0, edge=1, target=2), not the
            // outer row, which is the same trap as `ShortestPath`'s `edge_pred`.
            let endpoint_slot = g.width;
            let all_binds = [
                crate::ir::GroupPos::NodeAt(0),
                crate::ir::GroupPos::EdgeAt(0),
                crate::ir::GroupPos::NodeAt(1),
            ];
            let nbinds = 1 + rng.below(3);
            let group_binds: Vec<(crate::ir::GroupPos, usize)> = all_binds
                .iter()
                .take(nbinds)
                .enumerate()
                .map(|(i, pos)| (*pos, endpoint_slot + 1 + i))
                .collect();
            let per_rep_pred = rng.chance(1, 3).then(|| {
                Box::new(Expr::Compare {
                    op: CompareOp::Ge,
                    left: Box::new(Expr::Prop {
                        slot: 2,
                        key: "score".into(),
                    }),
                    right: Box::new(Expr::Lit(Value::Num(f64::from(rng.below(4) as u32)))),
                })
            });
            g.width += 1 + group_binds.len();
            g.plan = Plan::RepeatGroup {
                input: Box::new(g.plan),
                from: endpoint_slot - 1,
                dir,
                edge_label: etypes,
                min: 1,
                max: 1 + rng.below(3) as u32,
                mode: *rng.pick(&[PathMode::Walk, PathMode::Trail, PathMode::Simple]),
                endpoint_slot,
                group_binds,
                // Single-hop unit only; multi-hop bodies lower elsewhere.
                k: 1,
                per_rep_pred,
            };
            // A group column is a LIST, so it is not a node and the chain must not try
            // to sort on it as if it were unique.
            g.bound_edge = true;
            continue;
        } else if !deep && rng.chance(1, 7) {
            // An OPTIONAL hop, which is the only operator here that puts a NULL NODE
            // into a frontier: a row with no matching neighbour lands the `u32::MAX`
            // sentinel (GQL `OPTIONAL MATCH`) or the source element itself (Gremlin
            // `optional(...)`, `keep_source`). Everything downstream then has to cope
            // with a slot that holds a node-shaped nothing — `IsLabeled` must not
            // match it, a property read off it is null, and a sort has to place it.
            //
            // It also appends TWO slots under `bind_edge`, edge before node, which is
            // the arithmetic that has produced every bug this fuzzer has found.
            let keep_source = rng.chance(1, 2);
            let bind = rng.chance(1, 3);
            // The LANDING predicate reads the appended node slot, which is one further
            // along when an edge is bound — a candidate neighbour failing it makes the
            // source null-fill rather than drop, so it is applied before the "any
            // match?" decision rather than after. Exactly the kind of slot that is easy
            // to compute one way here and another way in the executor.
            let landing_slot = g.width + usize::from(bind);
            let landing_pred = rng
                .chance(1, 3)
                .then(|| Box::new(gen_pred(rng, landing_slot, false)));
            g.plan = Plan::OptionalExpand {
                input: Box::new(g.plan),
                from: g.width - 1,
                dir,
                edge_label: etypes,
                keep_source,
                bind_edge: bind,
                landing_pred,
            };
            g.width += if bind { 2 } else { 1 };
            if bind {
                // A bound edge means a slot that is not a node, so the chain can no
                // longer be given a total sort key.
                g.bound_edge = true;
            }
            continue;
        } else if !deep && rng.chance(1, 5) {
            // A BOUND EDGE, which appends TWO slots (edge then node) instead of one.
            //
            // Worth generating for the arithmetic alone: every bug this fuzzer has
            // found has been a slot index computed one way in one place and another
            // way somewhere else, and a hop that appends two slots is where such an
            // assumption breaks first. It also gates the interval-overlap fusion, and
            // orientation refuses it outright — so these plans exercise the decline.
            g.plan = g.plan.expand_edge(g.width - 1, dir, &etypes);
            g.bound_edge = true;
            let edge_slot = g.width;
            g.width += 2;
            if rng.chance(2, 3) {
                g.plan = g.plan.filter(gen_edge_pred(rng, edge_slot));
            }
            continue;
        } else {
            g.plan = g.plan.expand(g.width - 1, dir, &etypes);
        }
        g.width += 1;

        // An INTERMEDIATE filter on the hop's endpoint — the one that has to travel
        // with its own hop through a reversal, and whose misplacement was the two-hop
        // bug. Deep chains always get one, to keep the frontier from exploding.
        if h + 1 < hops && (deep || rng.chance(1, 2)) {
            g.plan = g.plan.filter(gen_pred(rng, g.width - 1, deep));
        }

        // An intermediate filter reading this hop's endpoint AND an earlier slot, as a
        // DISJUNCTION so nothing can split it apart on the way down.
        //
        // This is the exact trigger for the `max_slot == endpoint` bug, and generating
        // it directly matters: the shape used to arise only by accident, when pushdown
        // happened to relocate a two-slot `Or` from the top of the chain into the
        // middle. Widening the generator diluted that accident until the mutation for
        // that bug — a bug found by this very fuzzer the day before — stopped being
        // caught at all. A shape worth testing is worth generating on purpose.
        if h + 1 < hops && g.width >= 3 && rng.chance(1, 4) {
            let earlier = rng.below(g.width - 2);
            let a = gen_pred(rng, earlier, false);
            let b = gen_pred(rng, g.width - 1, false);
            g.plan = g.plan.filter(Expr::Or(Box::new(a), Box::new(b)));
        }
    }

    // The far-side predicate: what orientation seeds from, when it fires. The last
    // slot is always a NODE — a bound-edge hop appends the edge first and the node
    // second — so a node predicate is right here regardless of how the hop was made.
    let selective = rng.chance(3, 4);
    g.plan = g.plan.filter(gen_anchor_pred(rng, g.width - 1, selective));

    // A MIXED conjunction over the whole chain, which has to be split per conjunct on
    // the way down — each hop keeping the part that reads the slot it appends and
    // pushing the rest below. This is the shape `(a:L)-[:T]->(b:M) WHERE a.k > v`
    // lowers to once the filters merge.
    if g.width >= 2 && rng.chance(1, 3) {
        let pred = gen_cross_pred(rng, g.width);
        g.plan = g.plan.filter(pred);
    }

    g
}

/// A conjunction reading TWO DIFFERENT slots — `a.age > 1 AND b:L`.
///
/// Every other generated predicate reads exactly one slot, and that turned out to be a
/// hole big enough to drive the week's largest bug through: with single-slot
/// predicates, `split_pushable` never actually SPLITS. It puts the whole predicate
/// either below the hop or above it, so the mixed-conjunction path — the one where a
/// slot-1 label check used to pin a slot-0 range predicate above the hop and cost 300x
/// — was generated exactly never. Two mutations of that code went uncaught until this
/// existed.
///
/// It also covers the opposite branch on purpose: orientation must DECLINE a far-side
/// predicate that reads both ends, because the reversed seed cannot evaluate the half
/// that names the other node.
fn gen_cross_pred(rng: &mut Lcg, width: usize) -> Expr {
    debug_assert!(width >= 2);
    let i = rng.below(width);
    let j = {
        let k = rng.below(width);
        if k == i {
            (i + 1) % width
        } else {
            k
        }
    };
    let selective = rng.chance(1, 2);
    let a = gen_pred(rng, i, selective);
    let b = gen_pred(rng, j, false);

    // A DISJUNCTION sometimes, and it reaches somewhere `And` cannot. `split_pushable`
    // flattens conjunctions only, so a mixed `And` is taken apart — the slot-0 half is
    // pushed below the hop and the far half stays above, and by the time orientation
    // runs the predicate reads one end. A mixed `Or` cannot be split, so it arrives at
    // `reverse_chain` still reading BOTH ends, which is the only way to reach that
    // function's both-ends guard. Without disjunctions that guard is dead code, and a
    // mutation deleting it was caught by nothing in the entire test suite.
    if rng.chance(1, 3) {
        Expr::Or(Box::new(a), Box::new(b))
    } else {
        Expr::And(Box::new(a), Box::new(b))
    }
}

/// An expression that the slot rename REFUSES, reading `slot`.
///
/// Every other expression this generator emits is renameable, which made every
/// `swap_slots(...).is_some()` guard in `orient_scan` — over projection items,
/// aggregate keys, filter predicates and sort keys — trivially true. A mutation that
/// deleted one of those checks changed nothing, because the corpus contained nothing
/// it could refuse. The guards exist for the expressions `map_slots` will not rewrite:
/// records, maps, CASE, index reads, the subquery family, and every path expression.
///
/// `Case` is the cheapest of those to build and the only one that evaluates to an
/// ordinary value, so a plan carrying it still runs and the comparison stays
/// meaningful — the point is that orientation must DECLINE rather than rename around
/// it.
fn gen_unrenameable(rng: &mut Lcg, slot: usize) -> Expr {
    Expr::Case {
        branches: vec![(
            Expr::Compare {
                op: CompareOp::Gt,
                left: Box::new(Expr::Prop {
                    slot,
                    key: "score".into(),
                }),
                right: Box::new(Expr::Lit(Value::Num(f64::from(rng.below(5) as u32)))),
            },
            Expr::Prop {
                slot,
                key: "name".into(),
            },
        )],
        otherwise: Some(Box::new(Expr::Lit(Value::Str("other".into())))),
    }
}

/// A total sort key over `width` slots, plus a skip/limit window.
///
/// Totality is the whole point. `OrderPage` sorts STABLY, so under a LIMIT the
/// surviving rows depend on the order rows arrived in — which is precisely what
/// optimizing is allowed to change. A key that is total removes the ambiguity: the only
/// equal keys are identical rows, so the window is the same whatever the arrival order
/// and raw and optimized must agree exactly. `name` is unique per node, so a tuple of
/// every slot's `name` is total; edges have no `name`, which is why a chain carrying a
/// bound edge is not given a page at all.
/// `projected` says what the slots hold. BELOW a projection they are elements, so each
/// key reads `name` off one; ABOVE a projection they are already the names, and reading
/// `name` off a string yields null — which makes every key tie, turns the window into a
/// prefix of an unspecified order, and reports a difference that is the generator's
/// fault rather than the optimizer's. The first version did exactly that and "found" a
/// bug at seed 1461 that was not one.
fn gen_page(
    rng: &mut Lcg,
    width: usize,
    projected: bool,
) -> (Vec<crate::ir::SortKey>, Option<usize>, Option<usize>) {
    let keys = (0..width)
        .map(|i| crate::ir::SortKey {
            expr: if projected {
                Expr::Slot(i)
            } else {
                Expr::Prop {
                    slot: i,
                    key: "name".into(),
                }
            },
            // (totality is preserved: `name` and `Slot` are both unique per node)
            descending: rng.chance(1, 3),
            nulls_first: rng.chance(1, 2),
        })
        .collect();
    // A bare page (no keys) would be a prefix of an unspecified order, so keys are
    // always present. `limit` reaches 0 deliberately — the LIMIT-0 rule is its own
    // documented edge case — and `skip` can run past the end.
    let skip = if rng.chance(1, 3) {
        Some(rng.below(4))
    } else {
        None
    };
    let limit = if rng.chance(3, 4) {
        Some(rng.below(6))
    } else {
        None
    };
    (keys, skip, limit)
}

/// A random plan, sometimes two combined with `UNION` / `EXCEPT` / `INTERSECT`.
///
/// The arms are whole queries, so this is the only place the generator nests one plan
/// inside another, and it is capped at one level — a tree of unions would multiply
/// cost without reaching anything new.
///
/// Arm WIDTHS deliberately differ some of the time. A shorter arm's rows are padded
/// with NULLs to the left arm's width, and the result's columns come from the left, so
/// the padding path is only reached when the right arm is narrower. `EXCEPT` and
/// `INTERSECT` always deduplicate (only `UNION` honours `all`), which makes them a
/// different comparison again.
fn gen_plan(rng: &mut Lcg) -> Plan {
    if !rng.chance(1, 7) {
        return gen_plan_one(rng);
    }

    let left = gen_plan_one(rng);
    let lw = super::width(&left);
    let right = gen_plan_one(rng);
    let rw = super::width(&right);

    // Arm widths are equal MOST of the time and deliberately unequal some of it. A
    // shorter right arm has its rows padded with NULLs to the left arm's width, which
    // is a separate code path — and was a panic until this generator first reached it.
    let common = lw.min(rw);
    let narrow = if common > 1 && rng.chance(1, 3) {
        1 + rng.below(common - 1)
    } else {
        common
    };
    let arm = |p: Plan, tag: &str, k: usize| Plan::Project {
        input: Box::new(p),
        items: (0..k)
            .map(|i| (format!("{tag}{i}"), Expr::Slot(i)))
            .collect(),
    };
    let (left, right) = (arm(left, "l", common), arm(right, "r", narrow));

    Plan::Union {
        left: Box::new(left),
        right: Box::new(right),
        all: rng.chance(1, 2),
        op: *rng.pick(&[
            crate::ir::CombineOp::Union,
            crate::ir::CombineOp::Except,
            crate::ir::CombineOp::Intersect,
        ]),
    }
}

fn gen_plan_one(rng: &mut Lcg) -> Plan {
    // A JOIN of two chains, sometimes. Both sides are kept SHALLOW: the join's output
    // is bounded by matching pairs, but two deep chains multiply before that bound
    // applies. Output slots are all of the left's then all of the right's, so the
    // right side's predicates and the join key have to be renumbered by `left.width`.
    let mut g = if rng.chance(1, 6) {
        let (lh, rh) = (1 + rng.below(2), 1 + rng.below(2));
        let left = gen_chain(rng, lh);
        let right_raw = gen_chain(rng, rh);
        let (lw, rw) = (left.width, right_raw.width);
        let on = vec![(rng.below(lw), rng.below(rw))];
        let mut j = Gen {
            plan: Plan::join(left.plan, right_raw.plan, on),
            width: lw + rw,
            bound_edge: left.bound_edge || right_raw.bound_edge,
        };
        // DIRECTLY above the join, with nothing in between. The pushdown arm matches
        // `Filter` over `Join`, so a filter separated from it by a `Distinct` or a
        // `Project` never reaches it — which is why a mutation removing the arm's
        // left-slots-only guard went uncaught. Half of these read both sides, which
        // is precisely what the guard exists to refuse.
        if rng.chance(2, 3) {
            let pred = if rng.chance(1, 2) {
                gen_cross_pred(rng, j.width)
            } else {
                let slot = rng.below(j.width);
                gen_pred(rng, slot, false)
            };
            j.plan = j.plan.filter(pred);
        }
        j
    } else {
        let hops = gen_hop_count(rng);
        gen_chain(rng, hops)
    };

    // A MID-PLAN projection that keeps a subset of slots as elements, then carries on
    // hopping and filtering above it. This is the namespace boundary with a pattern
    // still underneath — `Slot(0)` above it is the projection's first output column,
    // nothing to do with the pattern, and renaming through it is how `count(*)` once
    // became a read of a column that does not exist.
    if g.width >= 2 && rng.chance(1, 6) {
        let keep: Vec<usize> = (0..g.width).filter(|_| rng.chance(2, 3)).collect();
        let keep = if keep.is_empty() { vec![0] } else { keep };
        g = Gen {
            width: keep.len(),
            bound_edge: g.bound_edge,
            plan: Plan::Project {
                input: Box::new(g.plan),
                items: keep
                    .iter()
                    .map(|&i| (format!("p{i}"), Expr::Slot(i)))
                    .collect(),
            },
        };
        // Keep going ABOVE the boundary — an expand and/or a filter that reads the
        // projection's columns, not the pattern's slots.
        if rng.chance(1, 2) {
            g.plan = g.plan.expand(
                g.width - 1,
                *rng.pick(&[Dir::Out, Dir::In]),
                &[(*rng.pick(&ETYPES)).to_string()],
            );
            g.width += 1;
        }
        if rng.chance(1, 2) {
            let slot = rng.below(g.width);
            g.plan = g.plan.filter(gen_pred(rng, slot, false));
        }
    }

    // A `Distinct` between the pattern and whatever reads it, sometimes with a further
    // filter above that. This is the only way a residual filter can SURVIVE above the
    // pattern: adjacent filters are merged by the fixpoint before orientation runs, so
    // without something in between, `orient_apply`'s rename-the-filter-above branch is
    // unreachable — verified by instrumenting it, and a mutation of that branch went
    // uncaught until this shape existed.
    if rng.chance(1, 5) {
        g.plan = Plan::Distinct {
            input: Box::new(g.plan),
        };
        if rng.chance(1, 2) {
            let slot = rng.below(g.width);
            g.plan = g.plan.filter(gen_pred(rng, slot, false));
        }
    }

    // ORDER BY / LIMIT, which is the top-k fast path and was entirely unfuzzed.
    //
    // THE SORT KEY IS EVERY SLOT, and that is what makes the comparison sound rather
    // than flaky. `OrderPage` sorts STABLY, so with ties the surviving rows under a
    // LIMIT depend on the order the rows arrived in — which is exactly what optimizing
    // is allowed to change. Sorting on a key that is TOTAL removes the ambiguity: the
    // only equal keys are identical rows, so the window is the same whatever the
    // arrival order, and raw and optimized must agree exactly.
    //
    // `name` is unique per node, so a tuple of every slot's `name` is total. Edges have
    // no `name`, so a chain carrying a bound edge is skipped rather than compared under
    // a key that is only nearly total.
    // Placed BELOW the projection, this also happens to cover a real limitation:
    // `orient_scan` has no arm for `OrderPage`, so a pattern under an `ORDER BY`
    // declines to orient — safe (the sort keys reference pattern slots and would need
    // renaming too) but a missed optimization. Kept rare for that reason, with the
    // above-the-projection placement generated separately below, where it does not
    // block the rewrite.
    if !g.bound_edge && rng.chance(1, 8) {
        let (keys, skip, limit) = gen_page(rng, g.width, false);
        g.plan = g.plan.order_page(keys, skip, limit);
    } else if rng.chance(1, 10) {
        // A page whose key is NOT total — one key, over a property with many ties.
        //
        // This is the shape that orientation under an `ORDER BY` can legitimately
        // change: reversing alters the order rows reach a STABLE sort, so tied rows
        // come out in a different order, and with a LIMIT a different subset survives.
        // Neither is a property of the query. So: no limit and no skip, and
        // `ordered_output` sends it to the multiset comparison — which still asserts
        // the thing that must hold, that the ROW SET is unchanged.
        let slot = rng.below(g.width);
        let keys = vec![crate::ir::SortKey {
            // Sometimes an expression the slot rename REFUSES, which is the only way
            // to exercise `orient_scan`'s check that a page's keys are renameable —
            // deleting that check was otherwise a no-op against this corpus. It is
            // safe here precisely because this page has no limit: the key is not
            // total, so `ordered_output` already sends it to the multiset comparison.
            expr: if rng.chance(1, 3) {
                gen_unrenameable(rng, slot)
            } else {
                Expr::Prop {
                    slot,
                    key: "score".into(),
                }
            },
            descending: rng.chance(1, 2),
            nulls_first: false,
        }];
        g.plan = g.plan.order_page(keys, None, None);
    }

    let far = g.width - 1;
    let all_slots: Vec<(String, Expr)> = (0..g.width)
        .map(|i| {
            (
                format!("s{i}"),
                Expr::Prop {
                    slot: i,
                    key: "name".into(),
                },
            )
        })
        .collect();

    // THE PATTERN ITSELF, with no projection over it. Its slots ARE the query's output
    // columns, so reversing them reorders the result — which is how the first version
    // of this rewrite returned `carol, carol` where the answer was `alice, bob`. It is
    // also the shape a generator forgets, because every realistic query has a RETURN;
    // leaving it out meant a faithful mutation of that bug went uncaught.
    if rng.chance(1, 8) {
        return g.plan;
    }

    let count = |name: &str| Agg {
        func: AggFn::Count,
        arg: None,
        distinct: false,
        name: name.into(),
        frac: None,
        null_on_empty: false,
        numeric_only: false,
    };

    // Aggregates beyond `count`, each of which has its own fast path in `exec`
    // (`try_scan_num_agg`, `try_frontier_prop_agg`, …). `Sum` and `Avg` are also where
    // float summation ORDER shows up: they are only equal across two plans if the rows
    // are folded in the same sequence or the sum is order-independent, so a rewrite
    // that reorders rows under one is worth knowing about.
    let numeric_agg = |rng: &mut Lcg, slot: usize| Agg {
        func: *rng.pick(&[AggFn::Sum, AggFn::Min, AggFn::Max, AggFn::Avg]),
        arg: Some(Expr::Prop {
            slot,
            key: (*rng.pick(&NUM_KEYS)).to_string(),
        }),
        distinct: rng.chance(1, 4),
        name: "a".into(),
        frac: None,
        null_on_empty: false,
        numeric_only: false,
    };

    match rng.below(11) {
        // THE CANARY, and deliberately the most common shape: every slot projected in
        // order, by a property unique per node. Any permutation of the pattern's slots
        // shows up here as a row mismatch. A generator weighted toward `count(*)`
        // instead would reproduce E72's blindness.
        0..=3 => {
            let mut items = all_slots;
            // Occasionally project something the rename refuses, so orientation has to
            // decline rather than rewrite around it.
            if rng.chance(1, 6) {
                let slot = rng.below(g.width);
                items.push(("case".into(), gen_unrenameable(rng, slot)));
            }
            Plan::Project {
                input: Box::new(g.plan),
                items,
            }
        }
        // The ends only — still permutation-sensitive, and the shape most real queries
        // have.
        4 => Plan::Project {
            input: Box::new(g.plan),
            items: vec![all_slots[0].clone(), all_slots[far].clone()],
        },
        // A page ABOVE the projection, sorting on the projected columns. Structurally
        // different from the other placement and, unlike it, does not stop the pattern
        // beneath from being oriented — so this is the shape that exercises top-k and
        // orientation at the same time.
        9 if !g.bound_edge => {
            let projected = Plan::Project {
                input: Box::new(g.plan),
                items: all_slots,
            };
            let (keys, skip, limit) = gen_page(rng, g.width, true);
            projected.order_page(keys, skip, limit)
        }
        // A projection with DISTINCT over it: dedup happens on the projected columns,
        // so a permutation that survives the projection can still change the count.
        5 => Plan::Distinct {
            input: Box::new(Plan::Project {
                input: Box::new(g.plan),
                items: all_slots,
            }),
        },
        // `count(*)` directly over the pattern. Permutation-INVARIANT by itself, but it
        // is the shape that exposed the `Aggregate` namespace boundary — the rename
        // must stop there, and a count that reads a column past the boundary faults.
        6 | 7 => Plan::Aggregate {
            input: Box::new(g.plan),
            keys: Vec::new(),
            aggs: vec![count("c")],
        },
        // GROUP BY a pattern slot: an aggregate whose KEY reads the pattern, so the
        // rename has to reach the key and stop above it.
        8 => {
            let key = all_slots[rng.below(g.width)].clone();
            Plan::Aggregate {
                input: Box::new(g.plan),
                keys: vec![key],
                aggs: vec![count("c")],
            }
        }
        // A NUMERIC aggregate, optionally grouped and optionally DISTINCT — every one
        // of which routes to a different fast path than `count(*)`.
        _ => {
            let slot = rng.below(g.width);
            let agg = numeric_agg(rng, slot);
            let keys = if rng.chance(1, 2) {
                vec![all_slots[rng.below(g.width)].clone()]
            } else {
                Vec::new()
            };
            Plan::Aggregate {
                input: Box::new(g.plan),
                keys,
                aggs: vec![agg, count("c")],
            }
        }
    }
}

/// Is this plan's ROW ORDER part of its answer?
///
/// Only when a page sits at the root, seen through operators that preserve order.
/// Everything else is unordered, and [[order-is-unspecified]] applies: comparing
/// sequences there would flag differences the engine is free to have.
///
/// This is only sound because the generator gives every page a TOTAL sort key (see
/// `gen_page`). With ties, a stable sort makes the output depend on the arrival order,
/// which optimizing is allowed to change.
fn ordered_output(plan: &Plan) -> bool {
    match plan {
        // A page is TOTAL when it has a key per slot AND every key reads something
        // unique per node. Both halves are needed, and the count alone is not enough:
        // a one-key page over a one-column input passes a count test while sorting on
        // `score`, which has seven values and ties constantly. That misread a
        // deliberately non-total page as total and reported an "order changed" failure
        // at seed 96445 that was the oracle's fault, not the optimizer's.
        //
        // The unique-valued expressions are exactly the two `gen_page` emits: `name`
        // off an element, or a `Slot` already holding one of those names.
        Plan::OrderPage { input, keys, .. } => {
            let unique = |k: &crate::ir::SortKey| {
                matches!(&k.expr, Expr::Prop { key, .. } if key == "name")
                    || matches!(k.expr, Expr::Slot(_))
            };
            keys.len() >= super::width(input) && keys.iter().all(unique)
        }
        // Both preserve row order; an `Aggregate` does not, and anything else is not
        // worth assuming about.
        Plan::Project { input, .. } | Plan::Distinct { input } => ordered_output(input),
        _ => false,
    }
}

/// Rows in order, for a plan whose order is part of its answer.
fn seq(rows: &Rows) -> Vec<String> {
    rows.rows
        .iter()
        .map(|r| r.iter().map(|v| format!("{v:?};")).collect::<String>())
        .collect()
}

/// Rows as a sorted multiset. Order is unspecified for an unordered query, so the
/// comparison must not depend on it — but MULTIPLICITY must be preserved, which is why
/// this is a sorted bag and not a set (a reversal that double-counts a path is a real
/// bug, and a set would hide it).
fn bag(rows: &Rows) -> Vec<String> {
    let mut out: Vec<String> = rows
        .rows
        .iter()
        .map(|r| r.iter().map(|v| format!("{v:?};")).collect::<String>())
        .collect();
    out.sort();
    out
}

/// Check the invariant for one seed against one store, and report richly on failure —
/// the seed alone has to be enough to reproduce and read.
fn check(seed: u64, store: &Store, indexed: bool) {
    let mut rng = Lcg(seed);
    let plan = gen_plan(&mut rng);

    // `try_run`, not `run`, because a deep generated chain can legitimately trip the
    // intermediate-frontier guard — and the ERROR is part of the invariant rather than
    // a reason to crash the test:
    //
    //   raw ok, opt ok    the bags must match (the invariant proper)
    //   raw ok, opt ERR   FAIL — optimizing broke a query that worked
    //   raw ERR, opt ok   fine, and rather the point: the rewrite made it feasible.
    //                     A deep walk that blows the frontier unoriented can seed
    //                     from the far end and finish.
    //   raw ERR, opt ERR  nothing to compare
    let before = crate::exec::try_run(&plan, store);
    let opt = optimize_indexed(plan.clone(), store as &dyn IndexOracle);
    let after = crate::exec::try_run(&opt, store);

    match (&before, &after) {
        // An ORDERED comparison where the order is specified, a multiset comparison
        // everywhere else. The ordered one is strictly stronger and catches a top-k
        // that returns the right rows in the wrong sequence, which a bag cannot.
        (Ok(b), Ok(a)) if ordered_output(&plan) => assert_eq!(
            seq(b),
            seq(a),
            "\noptimizing changed the ORDER (seed {seed}, indexed {indexed})\
             \n  raw:       {plan:?}\
             \n  optimized: {opt:?}\n"
        ),
        (Ok(b), Ok(a)) => assert_eq!(
            bag(b),
            bag(a),
            "\noptimizing changed the answer (seed {seed}, indexed {indexed})\
             \n  raw:       {plan:?}\
             \n  optimized: {opt:?}\n"
        ),
        (Ok(_), Err(e)) => panic!(
            "\noptimizing BROKE a working plan (seed {seed}, indexed {indexed}): {e}\
             \n  raw:       {plan:?}\
             \n  optimized: {opt:?}\n"
        ),
        _ => {}
    }
}

/// How many seeds to sweep. Fixed, so CI is deterministic; raise it with
/// `LENKE_OPT_FUZZ_SEEDS` when changing a rewrite.
///
/// Sized by what iterations actually cost, which is almost nothing: 6k seeds run in
/// 0.56s, 25k in 2.2s, 100k in 8.8s, against a whole-engine suite of 2.75s. 25k is
/// four times the coverage for about two seconds, and noise in a CI job measured in
/// minutes.
///
/// Per-shape DENSITY falls as the generator learns new shapes — plans reaching an index
/// went 33% to 10% over five widenings — but that is arithmetic, not decay: fixed
/// probability mass spread over more shapes, with the total reachable surface strictly
/// growing each time. The answer is simply to run more seeds.
fn seed_count() -> u64 {
    std::env::var("LENKE_OPT_FUZZ_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(25_000)
}

/// The invariant, over an INDEXED store — where the seeding rules, the pushdown split
/// and orientation all actually fire.
#[test]
fn optimizing_preserves_rows_with_indexes() {
    let mut store = fixture(1);
    index_all(&mut store);

    for seed in 0..seed_count() {
        check(seed, &store, true);
    }
}

/// The same invariant with NO indexes. Most index-driven rewrites decline here, which
/// makes this the control: it covers the "correctly does nothing" path, and any
/// difference between the two sweeps is itself informative.
#[test]
fn optimizing_preserves_rows_without_indexes() {
    let store = fixture(1);

    for seed in 0..seed_count() {
        check(seed, &store, false);
    }
}

/// Vary the GRAPH as well as the plan. A single fixture can hide a rewrite that is only
/// wrong at a particular density or label distribution — the two-hop bug needed a
/// middle node whose label differed from its neighbours' to be visible at all.
#[test]
fn optimizing_preserves_rows_across_fixtures() {
    for fixture_seed in 0..16 {
        let mut store = fixture(fixture_seed);
        store.create_range_index("age");
        store.create_index("name");

        for seed in 0..(seed_count() / 16).max(1) {
            check(
                seed.wrapping_mul(31).wrapping_add(fixture_seed),
                &store,
                true,
            );
        }
    }
}

/// COVERAGE, not correctness: a generative test that never triggers the rewrite it was
/// built for passes vacuously, and looks exactly like a test that works. This asserts
/// the generated corpus actually reaches the interesting shapes.
#[test]
fn the_generator_actually_reaches_the_rewrites() {
    let mut store = fixture(1);
    index_all(&mut store);

    fn plan_has<F: Fn(&Plan) -> bool + Copy>(p: &Plan, f: F) -> bool {
        if f(p) {
            return true;
        }
        match p {
            Plan::Project { input, .. }
            | Plan::Aggregate { input, .. }
            | Plan::Filter { input, .. }
            | Plan::Expand { input, .. }
            | Plan::VarLength { input, .. }
            | Plan::ShortestPath { input, .. }
            | Plan::OptionalExpand { input, .. }
            | Plan::RepeatGroup { input, .. }
            | Plan::OrderPage { input, .. }
            | Plan::Distinct { input } => plan_has(input, f),
            Plan::Join { left, right, .. } | Plan::Union { left, right, .. } => {
                plan_has(left, f) || plan_has(right, f)
            }
            _ => false,
        }
    }

    fn has<F: Fn(&Plan) -> bool + Copy>(p: &Plan, f: F) -> bool {
        if f(p) {
            return true;
        }
        match p {
            Plan::Project { input, .. }
            | Plan::Aggregate { input, .. }
            | Plan::Filter { input, .. }
            | Plan::Expand { input, .. }
            | Plan::Distinct { input } => has(input, f),
            _ => false,
        }
    }

    let (mut seeks, mut oriented, mut multi_hop, mut nonempty) = (0, 0, 0, 0);
    let (mut joins, mut varlen, mut deep, mut faults) = (0, 0, 0, 0);
    let (mut bound_edge, mut interval) = (0, 0);
    let (mut paged, mut num_agg, mut unions) = (0, 0, 0);
    let (mut shortest, mut repeat_group, mut optional) = (0, 0, 0);
    let n = 2_000;

    for seed in 0..n {
        let mut rng = Lcg(seed);
        let plan = gen_plan(&mut rng);
        let opt = optimize_indexed(plan.clone(), &store as &dyn IndexOracle);

        if has(&opt, |p| {
            matches!(p, Plan::RangeSeek { .. } | Plan::IndexSeek { .. })
        }) {
            seeks += 1;
        }
        // Orientation is observable as the hop DIRECTIONS changing.
        // Every HOP kind, not just `Expand` — a chain whose second hop is a
        // var-length or shortest-path hop is still multi-hop, and counting only
        // `Expand` made adding those look like a coverage loss when it was not.
        // Orientation is still detectable here: it flips the hops it reverses, so the
        // sequence changes either way.
        fn dirs(p: &Plan, out: &mut Vec<Dir>) {
            match p {
                Plan::Expand { dir, .. }
                | Plan::VarLength { dir, .. }
                | Plan::ShortestPath { dir, .. } => out.push(*dir),
                _ => {}
            }
            match p {
                Plan::Project { input, .. }
                | Plan::Aggregate { input, .. }
                | Plan::Filter { input, .. }
                | Plan::Expand { input, .. }
                | Plan::VarLength { input, .. }
                | Plan::ShortestPath { input, .. }
                | Plan::OrderPage { input, .. }
                | Plan::Distinct { input } => dirs(input, out),
                _ => {}
            }
        }
        let (mut a, mut b) = (Vec::new(), Vec::new());
        dirs(&plan, &mut a);
        dirs(&opt, &mut b);
        if a != b {
            oriented += 1;
        }
        if a.len() >= 2 {
            multi_hop += 1;
        }
        if a.len() >= 4 {
            deep += 1;
        }
        if plan_has(&plan, |p| matches!(p, Plan::Join { .. })) {
            joins += 1;
        }
        if plan_has(&plan, |p| matches!(p, Plan::VarLength { .. })) {
            varlen += 1;
        }
        if plan_has(&plan, |p| {
            matches!(
                p,
                Plan::Expand {
                    bind_edge: true,
                    ..
                }
            )
        }) {
            bound_edge += 1;
        }
        if plan_has(&opt, |p| matches!(p, Plan::IntervalExpand { .. })) {
            interval += 1;
        }
        if plan_has(&plan, |p| matches!(p, Plan::OrderPage { .. })) {
            paged += 1;
        }
        if plan_has(&plan, |p| matches!(p, Plan::Union { .. })) {
            unions += 1;
        }
        if plan_has(&plan, |p| matches!(p, Plan::ShortestPath { .. })) {
            shortest += 1;
        }
        if plan_has(&plan, |p| matches!(p, Plan::RepeatGroup { .. })) {
            repeat_group += 1;
        }
        if plan_has(&plan, |p| matches!(p, Plan::OptionalExpand { .. })) {
            optional += 1;
        }
        if plan_has(
            &plan,
            |p| matches!(p, Plan::Aggregate { aggs, .. } if aggs.iter().any(|a| a.func != AggFn::Count)),
        ) {
            num_agg += 1;
        }
        match crate::exec::try_run(&plan, &store) {
            Ok(r) if !r.rows.is_empty() => nonempty += 1,
            Ok(_) => {}
            Err(_) => faults += 1,
        }
    }

    println!(
        "seeks {seeks}/{n}  oriented {oriented}/{n}  multi-hop {multi_hop}/{n}  \
         deep {deep}/{n}  joins {joins}/{n}  varlen {varlen}/{n}  \
         bound-edge {bound_edge}/{n}  interval {interval}/{n}  \
         paged {paged}/{n}  num-agg {num_agg}/{n}  unions {unions}/{n}  \
         shortest {shortest}/{n}  repeat-group {repeat_group}/{n}  \
         optional {optional}/{n}  \
         non-empty {nonempty}/{n}  faulted {faults}/{n}"
    );

    // FLOORS on DENSITY, calibrated against what the generator actually produces (the
    // line above prints it) with room to spare — not aspirations.
    //
    // They drift down as shapes are added, and that is fine and expected: probability
    // spent on joins and pages is probability not spent on seeds. What must not drift
    // is ABSOLUTE coverage, so `seed_count` rises to compensate (4,000 by default; the
    // whole sweep still runs in well under a second). Lowering a floor and leaving the
    // sweep the same size would be trading coverage for a green test. They guard one thing: the
    // generator silently drifting to trivia, which is invisible from the outside
    // because a vacuous generative test looks exactly like a working one.
    //
    // They earn their keep. Widening `gen_pred` from two predicate forms to nine
    // dropped plans-reaching-an-index from 659 to 164 in one commit, because the
    // seekable forms were diluted and two new keys had no index at all. Nothing else
    // would have noticed: every correctness test stayed green, on a corpus that had
    // quietly stopped exercising the rewrites it exists to test.
    assert!(seeks > n / 25, "too few plans seed an index: {seeks}/{n}");
    assert!(oriented > n / 20, "too few plans orient: {oriented}/{n}");
    assert!(
        multi_hop > n / 4,
        "too few multi-hop plans: {multi_hop}/{n}"
    );
    assert!(deep > n / 20, "too few deep (4+ hop) chains: {deep}/{n}");
    assert!(joins > n / 10, "too few joins: {joins}/{n}");
    assert!(varlen > n / 10, "too few var-length hops: {varlen}/{n}");
    assert!(
        bound_edge > n / 20,
        "too few bound-edge hops: {bound_edge}/{n}"
    );
    assert!(
        interval > n / 50,
        "too few interval fusions: {interval}/{n}"
    );
    assert!(
        paged > n / 20,
        "too few ORDER BY / LIMIT plans: {paged}/{n}"
    );
    assert!(
        num_agg > n / 50,
        "too few numeric aggregates: {num_agg}/{n}"
    );
    assert!(
        nonempty > n / 3,
        "too many plans return NO ROWS — a fuzzer over empty results proves nothing: \
         {nonempty}/{n}"
    );
    // Deep chains are ALLOWED to trip the frontier guard — that is why the oracle is
    // three-valued — but if most plans fault the sweep is measuring the guard, not the
    // optimizer.
    assert!(
        faults < n / 10,
        "too many plans fault; the sweep is testing the frontier guard, not the \
         optimizer: {faults}/{n}"
    );
}

/// Print the raw and optimized plan for one seed. Not a check — a debugging aid for
/// reading a failure the sweep reports.
#[test]
#[ignore = "debugging aid: LENKE_OPT_FUZZ_SEED=<n> cargo test -- --ignored dump_seed"]
fn dump_seed() {
    let seed: u64 = std::env::var("LENKE_OPT_FUZZ_SEED")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut store = fixture(1);
    index_all(&mut store);

    let mut rng = Lcg(seed);
    let plan = gen_plan(&mut rng);
    let opt = optimize_indexed(plan.clone(), &store as &dyn IndexOracle);
    println!("seed {seed}\n\nRAW:\n{plan:?}\n\nOPTIMIZED:\n{opt:?}");
}
