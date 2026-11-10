/**
 * ONE query row, measured well enough to see a sub-10% change. The isolated harness CLAUDE.md asks
 * for, built because item 1366 established that the existing probe cannot answer the questions left.
 *
 * WHY THE EXISTING PROBE IS TOO NOISY. `runtime-profile-probe.mjs` times the WHOLE rep loop and
 * reports the total, so a single GC pause anywhere in 120 reps lands in the number. Item 1366
 * measured its floor on the 200k hop-filter row at **12% for the same binary** (452.2 / 506.2 /
 * 490.2 / 494.4), which is above most of the candidates worth testing — it refuted `FAST1` only in
 * the sense of "not large".
 *
 * WHAT THIS DOES DIFFERENTLY, all of it straight out of CLAUDE.md's estimator rules:
 *
 *   * **Per-rep timing, not a loop total.** One slow rep is then one sample, not the whole reading.
 *   * **Median of the kept reps, with warmup dropped.** The TS path plateaus high and emits a rare
 *     fast rep, so `min` is the wrong estimator and reports the outlier; some shapes are outright
 *     bimodal. 14 reps, drop 3, median is the documented recipe.
 *   * **Prints the whole distribution** — series, p25, median, p75, min, max — because a summary of a
 *     bimodal series is a lie and the series is the only way to see it.
 *   * **Reports GC inside the measured window** via `PerformanceObserver`, so a reading inflated by
 *     collection is visible as such instead of being mysterious. Item 1361 is why: the observer must
 *     be DRAINED before reading, or a synchronous loop reports zero pauses.
 *   * **One shape per process** (item 762), and the fixture is deterministic so every process builds
 *     byte-identical input.
 *
 *     SHAPE=hopfilter NODES=200000 REPS=14 DROP=3 node isolated-row-bench.mjs
 *
 * Output is one JSON line, so an A/B driver can parse it without scraping a table.
 */
import { PerformanceObserver } from 'node:perf_hooks';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const SHAPE = process.env.SHAPE ?? 'hopfilter';
const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 14);
const DROP = Number(process.env.DROP ?? 3);
/**
 * How often an edge carries BOTH `E` and `F`. 0 = never, so `graph.multiTypeEdgeCount` is 0 and
 * `bucketSumsAreSound` should license the degree-sum fast path for `:E|F` as well as `:E`.
 * 3 = every third edge, so the sums would double-count and the dedupe is genuinely required.
 */
const MULTILABEL = Number(process.env.MULTILABEL ?? 3);

/**
 * `MULTILABEL=-1` makes `E` and `F` DISJOINT — alternating, no edge carrying both (item 1405).
 *
 * ⚠️ THIS IS THE COMMON CASE AND THE BENCH COULD NOT BUILD IT. Every multi-type row here has used
 * overlapping types (every Nth edge carries both), which makes `graph.multiTypeEdgeCount` non-zero
 * and `typeEdgeCount` an OVER-count: at `MULTILABEL=3` the degree estimate reads 1.33x the truth.
 * Two distinct relationship types that never co-occur on one edge is what a real schema usually has,
 * and it reads the estimate EXACTLY — which changes which side of `FAR_DRIVEN_MIN_DEGREE` a given
 * true degree lands on. Item 1404 declined lowering that threshold because the bias can reach 2x;
 * this mode is how the other half of the question gets measured instead of reasoned about.
 *
 * `-1` rather than `0` because `MULTILABEL=0` already means "no `F` at all", which items 1375 and
 * 1390 use as the control that separates a routing gap from a correct decline.
 */
const DISJOINT = MULTILABEL === -1;

/**
 * How many DISTINCT far endpoints the edges point into, as a fraction of `NODES` (item 1390).
 *
 * `FANIN=1` (the default) is the original fixture: `(i * 7 + 3) % NODES`, so every vertex is a far
 * endpoint exactly once and far-end in-degree is 1. That is the WRONG fixture for any change to
 * `farDrivenHopWalk`, whose whole purpose is hoisting `projectRow` to once per far VERTEX — at
 * in-degree 1 there is nothing to amortize and the route can only lose. Item 1390 measured its
 * multi-type arm at 85.7 ms against the start-driven 69.3 here, which says nothing about the lever
 * until the degree is varied.
 *
 * `FANIN=0.01` points every edge into one of `NODES/100` vertices, so far-end in-degree is ~100 and
 * the hoist has 100 rows to spread one `projectRow` over. CLAUDE.md's rule, stated the other way
 * round: a change that only helps HIGH-degree vertices judged against a degree-1 fixture can only
 * lose.
 */
/**
 * ⚠️ HOW FAR A VERTEX'S SUCCESSOR SITS, which is worth ~2x at the SAME DEGREE (item 1426).
 *
 * `small` (the default, and byte-for-byte what every reading before item 1426 used) is
 * `to = (i * 7 + 3) % NODES`: a vertex points ~7 slots along, so the successor is partly
 * cache-resident. `random` is `from = (k * 7919) % NODES`, `to = (k * 104729) % NODES` — both
 * large-stride permutations, so a successor is effectively random across the whole range.
 *
 * Both give out-degree and in-degree exactly 1 at `FANOUT=1` (each multiplier is coprime with
 * `NODES`, so each mapping is a permutation) and both answer `NODES` for a chain count. They differ
 * in NOTHING but locality, and item 1426 measured that at **1.93x (GQL), 2.06x (Gremlin)** — two
 * instruments in this directory disagreed 1.91x on the identical query until this was the
 * explanation.
 *
 * The DEFAULT IS UNCHANGED on purpose: switching it would silently invalidate every absolute figure
 * recorded against this bench. Sweep it when claiming a general result; a real graph is unlikely to
 * have a strided successor.
 */
/**
 * ⚠️ A SELECTIVE SECOND LABEL `S`, on every Nth vertex. **DEFAULT 0 = OFF** (item 1435).
 *
 * Every vertex in this fixture was `P` and nothing else, so NO row could reach a route gated on a
 * label that NARROWS — and `threeSegmentRoute` picks the way-count SWEEP over the degree product
 * exactly when one does (item 1420 verified that choice). The 2-pass sweep therefore had no row at
 * all, which is why item 1106's `passes > 2` memo gate had never been re-measured against it.
 *
 * It is OFF by default because turning it on is not free: adding a second label to 2% of vertices
 * moved `chain3` from 90.49 to 94.17 ms, which would silently shift every absolute figure recorded
 * against this bench. `SELECTIVE=50` turns it on for the `*sel` rows.
 */
const SELECTIVE = Number(process.env.SELECTIVE ?? 0);

const STRIDE = process.env.STRIDE ?? 'small';

if (STRIDE !== 'small' && STRIDE !== 'random') {
  throw new Error(`STRIDE must be 'small' or 'random', got ${STRIDE}`);
}

const FANIN = Number(process.env.FANIN ?? 1);

/**
 * Out-edges per vertex (item 1401). `FANOUT=1` is the original fixture, byte-for-byte.
 *
 * ⚠️ EVERY GQL NUMBER THIS SESSION CAME FROM A DEGREE-1 FIXTURE, and item 1400 is why that is now a
 * knob. One out-edge per vertex, a single permutation cycle, no self-loops and no parallel edges —
 * and at item 1399 that degeneracy hid a CORRECTNESS difference, not just a cost one: removing the
 * depth-4 endpoint-mask gate measured "correct and 9.9x faster" here and answers **-3** on
 * randomized multigraphs, because the structures the trail correction exists for were all absent.
 *
 * The Gremlin bench has had `FANOUT` since it was written; this one did not, so its hop rows could
 * only ever say what a degree-1 graph does. A per-vertex cost and a per-edge cost scale differently
 * (CLAUDE.md), and so do a walk that dedupes and one that never meets a duplicate.
 */
// ⚠️⚠️ ONE EDGE PER NODE BY DEFAULT, AND THAT HIDES PER-EDGE EFFECTS. Item 1636 measured the
// far-property row builder at NO separation here at FANOUT=1 (33 ms rows with a 42 ms outlier) and at
// 1.23-1.43x at FANOUT=5 — and the same default produced a PHANTOM 7-18% regression on
// `hoprelfiltyield` that three further rounds refuted. At one edge per node there is one far-end read
// per vertex, so a per-EDGE cost barely exists. Item 1635 found the same default misleading the
// sibling probe (`gql-filtered-hop-floor-probe.mjs`), where it had set a recorded prior at less than
// half its real value. Pass FANOUT=5 for anything per-edge; the default stays at 1 so the numbers in
// items 1398-1447 remain comparable to each other.
const FANOUT = Number(process.env.FANOUT ?? 1);

const SHAPES = {
  hopfilter: 'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5 RETURN count(*) AS c',
  // AN EQUIVALENT-SPELLING PAIR (item 1375). A third of the edges carry BOTH `E` and `F`, and every
  // edge carries `E`, so these two count the SAME edges — but `:E` takes `edgesOfTypes`' single-bucket
  // fast path (item 324, which returns the Set and allocates nothing) while `:E|F` falls to
  // `edgesOfManyTypes`, which allocates a `types.map` array AND a dedupe Set per vertex. CLAUDE.md's
  // rule is that equivalent spellings must cost the same; this is the instrument for that claim on a
  // multi-type hop, which no bench row covered.
  hopsingle: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
  hopmulti: 'MATCH (a:P)-[:E|F]->(b:P) RETURN count(*) AS c',
  // THE ORDER-REVERSED TWIN (item 1384). `edgesOfManyTypes` iterates bucket `i` with `i` membership
  // tests, so the total is minimised by putting the LARGEST bucket first — which means it is
  // sensitive to the order the query names types, exactly as the Gremlin twin was at item 1382
  // (3.53x there). Unlike that one, this runs PER VERTEX over a single vertex's buckets, so the
  // per-call disparity is a degree rather than a whole index and may not be measurable at all.
  hopmultirev: 'MATCH (a:P)-[:F|E]->(b:P) RETURN count(*) AS c',
  hopcount: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
  // QUANTIFIED PATHS (item 1398), a major GQL surface with NO row here and never screened with a
  // windowed profile. `{1,2}` and `{1,3}` share a start and differ only in depth, so the pair prices
  // what each extra hop costs; `varlen11` is the degenerate quantifier, which must cost about what
  // the plain one-hop count does and is the control that separates "quantified paths are expensive"
  // from "this quantifier is expensive".
  varlen11: 'MATCH (a:P)-[:E]->{1,1}(b:P) RETURN count(*) AS c',
  varlen12: 'MATCH (a:P)-[:E]->{1,2}(b:P) RETURN count(*) AS c',
  varlen13: 'MATCH (a:P)-[:E]->{1,3}(b:P) RETURN count(*) AS c',
  // AN EQUIVALENT-SPELLING PAIR ACROSS THE QUANTIFIER (item 1398), **AT `FANOUT=1` ONLY**. `{2,2}` is
  // "exactly two hops", which is what the explicit chain spells, and at out-degree 1 they agree
  // exactly — no cycle is short enough for TRAIL semantics to separate them — so a cost difference
  // is a routing difference and not different work.
  //
  // ⚠️ AT `FANOUT=4` THEY ARE DIFFERENT QUESTIONS, and item 1401 measured it rather than leaving the
  // caveat asserted: `{2,2}` answers **799,996** against the chain's **800,000**, and `{3,3}`
  // **3,199,944** against **3,200,000**. A quantified path is a TRAIL and may not repeat an edge
  // while the chain may, so at degree 4 those 4 and 56 paths revisit one — which is the trail
  // correction doing real work. Compare these as a SPELLING pair only at `FANOUT=1`; above it they
  // are a semantics demonstration. (The routing crossover holds either way: at degree 4 the chain is
  // 2.98x faster at depth 2 and the quantifier 3.01x faster at depth 3.)
  quant22: 'MATCH (a:P)-[:E]->{2,2}(b:P) RETURN count(*) AS c',
  chain2: 'MATCH (a:P)-[:E]->()-[:E]->(b:P) RETURN count(*) AS c',
  quant33: 'MATCH (a:P)-[:E]->{3,3}(b:P) RETURN count(*) AS c',
  chain3: 'MATCH (a:P)-[:E]->()-[:E]->()-[:E]->(b:P) RETURN count(*) AS c',
  // THE 2-PASS SWEEP, which no row reached before item 1435. A selective end label sends
  // `threeSegmentRoute` to `longChainCount` instead of the degree product (item 1420 verified that
  // choice), and a 3-segment chain is 2 passes — the exact boundary item 1106's memo gate sits on.
  chain3sel: 'MATCH (a:P)-[:E]->()-[:E]->()-[:E]->(b:S) RETURN count(*) AS c',
  chain4sel: 'MATCH (a:P)-[:E]->()-[:E]->()-[:E]->()-[:E]->(b:S) RETURN count(*) AS c',
  varlen14: 'MATCH (a:P)-[:E]->{1,4}(b:P) RETURN count(*) AS c',
  varlen24: 'MATCH (a:P)-[:E]->{2,4}(b:P) RETURN count(*) AS c',
  quant44: 'MATCH (a:P)-[:E]->{4,4}(b:P) RETURN count(*) AS c',
  chain4: 'MATCH (a:P)-[:E]->()-[:E]->()-[:E]->()-[:E]->(b:P) RETURN count(*) AS c',
  // THE YIELD TWIN of the hopsingle/hopmulti pair (item 1387). Items 1377/1384/1386 all landed on
  // the COUNT path, where the answer is a number and the union of buckets can replace the walk
  // outright. A projection cannot take that route - every selected edge must actually be produced -
  // so this is the instrument for whatever disparity survives on the yield side. Same two spellings
  // over the same edge set, so they must cost the same.
  hopsingleyield: 'MATCH (a:P)-[:E]->(b:P) RETURN b.n AS n',
  hopmultiyield: 'MATCH (a:P)-[:E|F]->(b:P) RETURN b.n AS n',
  hopmultiyieldrev: 'MATCH (a:P)-[:F|E]->(b:P) RETURN b.n AS n',
  /**
   * ⚠️ THE START-DRIVEN TWINS OF THE TWO ROWS ABOVE, AND `OFFSET 1` IS WHAT FORCES THAT WALK.
   *
   * The single-type far-read hop takes the far-driven walk UNCONDITIONALLY whenever the start label
   * is vacuous — `hop-projection.ts`'s single-type exit has no degree gate at all, unlike the
   * multi-type one, whose `farDrivenPaysForMultiType` is what items 1390/1404/1406/1434 measured.
   * So there was no way to read the two walks against each other on a single-type hop, and no row
   * here did.
   *
   * Item 1777 gave `hopOrderPlan` a `pageSkip !== 0` arm of its `startDriven` flag, because a
   * skip-only page inherits the walk's order and the start-driven one is the general path's. That
   * makes `OFFSET 1` a START-DRIVEN FORCER: same detector, same exit, same walk machinery, one
   * fewer row out of `NODES` — which is the cheapest route A/B available, and it needs no source
   * edit, so both arms are ONE BUILD (item 737's trap, avoided the way items 1776-1778 avoided it).
   *
   * ⚠️ SO THEIR `digest` AND `rowCount` LEGITIMATELY DIFFER from the unpaged rows by exactly one
   * row. Compare a paged arm against a paged arm across fixture knobs, never against its unpaged
   * twin, for anything but the route question these exist to answer.
   */
  hopsingleyieldpage: 'MATCH (a:P)-[:E]->(b:P) RETURN b.n AS n OFFSET 1',
  hopmultiyieldpage: 'MATCH (a:P)-[:E|F]->(b:P) RETURN b.n AS n OFFSET 1',
  // THE OTHER THREE WALKS IN `hop-projection.ts` (item 1408). Items 1388, 1390 and 1407 all edited
  // that file and only two of its five walks had a row here — `startDriven`/`startDrivenMany` and
  // the far-driven pair. These are the rest, each reached by a clause the measured ones decline:
  //
  //   `filteredHopWalk`    a far predicate or carried `WHERE` — binds the start per vertex
  //   `undirectedHopWalk`  `-[:E]-`, which no other walk can serve (they capture ONE direction)
  //   `relBoundRoute`      a projected REL variable, which needs the edge bound
  //
  // Each is a PROJECTION, not a count, so they exercise row construction the way the yield rows do
  // — which is what item 1407's change touched and what these would have caught had they existed.
  hopfiltyield: 'MATCH (a:P)-[:E]->(b:P) WHERE b.n > 5 RETURN b.n AS n',
  /**
   * ⚠️ THE RAISE-FREE FAR PREDICATE, WHICH THIS BENCH COULD NOT SEE (item 1780). Every other
   * filtered row here is an ORDERING comparison (`>`), and `cross-type-comparison-no-error` is the
   * policy that splits them: `=` on a cross-type pair is a NO-MATCH where `<=` THROWS. So `b.k = 5`
   * cannot raise while `b.n > 5` can, and that distinction is the whole of item 936's candidate
   * design (1) — "gate the far-driven arm on a raise-free far predicate" — which it dismissed on
   * the grounds that the shape it had measured could raise. The shape that cannot was never
   * measured, because no row here had one.
   *
   * ⚠️ IT IS ALSO THE SELECTIVE ONE, which is a second reason the family needed it. Every `>` row
   * here passes ~100% of rows (`b.n > -1`, `b.n > 5` over `n = i`), so they measure a filter that
   * rejects nothing. An equality over `k = i % 97` passes ~1/97, so the two differ in what a walk
   * could SKIP as well as in whether it may reorder faults.
   *
   * `hopfiltneq` is its near-twin on the other raise-free operator and passes ~96/97 — the pair
   * separates "raise-free" from "selective", which a single row would conflate.
   */
  hopfiltfareq: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k = 5 RETURN b.n AS n',
  hopfiltneq: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k <> 5 RETURN b.n AS n',
  /**
   * ⚠️ THE START-DRIVEN TWINS OF THE FILTERED ROWS — i.e. THE ROUTE AS IT WAS BEFORE ITEM 1781.
   *
   * Item 1781 gave a raise-free far predicate the far-driven walk. `OFFSET 1` forces the
   * start-driven arm (item 1777's `pageSkip !== 0` arm of `startDriven`, made an instrument at item
   * 1779), so each pair measures the OLD route against the NEW one in ONE BUILD — no source patch,
   * no rebuild between arms, and item 737's cross-build trap cannot apply.
   *
   * ⚠️ THE PAGED ARM ALSO PAYS FOR THE PAGE, which is why that cost is bounded rather than assumed:
   * item 1775 profiled `internalSkip` at 3.7% of the general path, and on a rung the page is one
   * `rows.slice`. Item 1779's spelling pairs read 0.93-0.99x across six cells, so the page is worth
   * about a percent here — small against the gap these rows measure, and it biases AGAINST the new
   * route, since the slice is charged to the arm being beaten.
   */
  hopfiltyieldpage: 'MATCH (a:P)-[:E]->(b:P) WHERE b.n > 5 RETURN b.n AS n OFFSET 1',
  hopfiltallpasspage: 'MATCH (a:P)-[:E]->(b:P) WHERE b.n > -1 RETURN b.n AS n OFFSET 1',
  hopfiltfareqpage: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k = 5 RETURN b.n AS n OFFSET 1',
  hopfiltneqpage: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k <> 5 RETURN b.n AS n OFFSET 1',
  // ⚠️ THE DECOMPOSITION OF `hopfiltyield`, which is the heaviest OPEN row in this bench at **644
  // ns/row** (item 1437). Profiling it nominated nothing routable — `get adjFrom` is 1.1%, so the
  // edge-index trick item 1431 took for the undirected walk is worth ~nothing here — and the
  // remaining structural observation was that it reads `b.n` TWICE (once for the predicate, once for
  // the projection) with nothing memoizing it. These three rows are what separates the candidate
  // causes, because `hopfiltyield` differs from `hopsingleyield` in THREE things at once: it carries
  // a `WHERE` at all, it evaluates a predicate per edge, and it drops rows.
  //
  //   `hopsingleyield`   bare projection            — no clause, no predicate, all rows
  //   `hopfiltwtrue`     clause present, no reads   — isolates "takes the filtered walk"
  //   `hopfiltallpass`   real far predicate, ALL rows pass — isolates predicate eval at EQUAL rows
  //   `hopfiltdiffprop`  predicate and projection on DIFFERENT properties — isolates the double read
  //
  // `WHERE true` is the repo's named control for "why is the filtered version slower" (closed item
  // 570). `hopfiltallpass` matters because `hopfiltyield` returns 99,994 rows against the bare row's
  // 100,000, so the two are not comparable per row until the row counts agree; `b.n > -1` is a real
  // predicate the planner cannot fold, evaluated per edge, that keeps every row.
  hopfiltwtrue: 'MATCH (a:P)-[:E]->(b:P) WHERE true RETURN b.n AS n',
  hopfiltallpass: 'MATCH (a:P)-[:E]->(b:P) WHERE b.n > -1 RETURN b.n AS n',
  hopfiltdiffprop: 'MATCH (a:P)-[:E]->(b:P) WHERE b.k > -1 RETURN b.n AS n',
  hopundiryield: 'MATCH (a:P)-[:E]-(b:P) RETURN b.n AS n',
  hoprelyield: 'MATCH (a:P)-[r:E]->(b:P) RETURN r.w AS w',
  // `relBoundFilteredHopWalk`, the rel-bound walk's filtered half (item 446's other side). It is a
  // SEPARATE closure from `hoprelyield`'s, so a per-edge change to one does not reach the other —
  // item 1409 is the second time in two items that a sibling walk needed its own row to be priced.
  hoprelfiltyield: 'MATCH (a:P)-[r:E]->(b:P) WHERE r.w < 100 RETURN b.n AS n',
  // `filteredHopWalk`'s START-ONLY gated closure (item 1410) — a predicate reading only the start,
  // which gets its own walk because item 164 measured gating a vertex BEFORE reading its adjacency
  // at 34 ns against 52. `hopfiltyield`'s far predicate reaches the GENERAL closure instead, so the
  // two rows are two different walks inside one function and neither covers the other.
  hopstartonlyyield: 'MATCH (a:P)-[:E]->(b:P) WHERE a.n > 5 RETURN b.n AS n',
  // `detectOptionalHopProjection` — the OPTIONAL-MATCH hop, which is a wholly separate detector
  // with its own per-edge far-label test and no row until now.
  hopoptyield: 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b:P) RETURN b.n AS n',
  sortedpage: 'MATCH (n:P) WHERE n.k < 50 RETURN n.s AS s ORDER BY s LIMIT 10',
  // Item 1711: the FULL sort, no LIMIT, so rows.sort runs on every row instead of the heap
  // selecting a window. hopsortstr reaches the surrogate regex AND the typeRank dispatch;
  // hopsortnum reaches ONLY the dispatch. hopsingleyield is the same hop+projection with no
  // sort at all, so it is the control a comparator change cannot reach.
  hopsortstr: 'MATCH (a:P)-[:E]->(b:P) RETURN b.s AS s ORDER BY s',
  hopsortnum: 'MATCH (a:P)-[:E]->(b:P) RETURN b.n AS n ORDER BY n',
  grouped: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
  /**
   * ⚠️ THE EIGHT GENERAL-PATH SHAPES `rung-precedence-census.mjs` HAS BEEN NAMING SINCE ITEM 1775,
   * AND NONE OF THEM HAD A ROW HERE (item 1785) — which is why no ranking ever nominated them.
   *
   * The census reports "10 shapes on the GENERAL PATH — that list is the open surface", and two of
   * the ten are CORRECT declines that must stay: `node.limit` and `hop.limit`, where the general
   * pipeline's laziness beats a rung that materializes then slices by **360x** (item 1775 measured
   * that and it refuted itself as a finding). These are the other eight. They take NO rung at all,
   * so they re-pay `withBinding` / `matchPattern` / `projectBinding` / `recordTail` /
   * `evalLabelExpr` per row — the 96% item 1775's profile attributed to losing the rung.
   *
   * ⚠️ `hop2*` AND `varlen*` ARE SUPERLINEAR IN FANOUT, so they are kept at the bench's default
   * `FANOUT=1` meaning: one out-edge per vertex, so a 2-hop is NODES rows and a `{1,3}` is 3*NODES.
   * At `FANOUT=4` the same shapes are 16x and 84x that, which is a different question (and the one
   * `scale_bench` exists for) rather than a harder version of this one.
   */
  hop2sumend: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN sum(c.k) AS s',
  hop2distinctcount: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(DISTINCT c) AS c',
  hop2distinctrows: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.k',
  hop2groupend: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN c.k AS g, count(*) AS n',
  varlenproj: 'MATCH (a:P)-[:E]->{1,3}(b) RETURN b.k',
  varlendistinctcount: 'MATCH (a:P)-[:E]->{1,3}(b) RETURN count(DISTINCT b) AS c',
  optgroup: 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c',
  hopgroupsumcrossend: 'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, sum(b.k) AS s',
  /**
   * ⚠️ ONE OF THESE IS A RUNG-TAKING TWIN AND THE OTHER IS NOT — VERIFIED WITH `compileLinear`, after
   * I wrote the opposite here (item 1785).
   *
   *   hopgroupsumsameend   `b.k AS g, sum(b.n)` — takes `groupedHopAggregate`. A REAL twin of
   *                        `hopgroupsumcrossend`: same edges, same 97 groups, differing only in
   *                        which end carries the key and which the aggregate. **2.38x** at 200,000.
   *   hop2groupstart       `a.k AS g, count(*)` on a 2-hop — I claimed this "reaches a rung". It
   *                        does NOT: `compileLinear` reports GENERAL PATH for it exactly as for
   *                        `hop2groupend`, and the 1.09x between them is two general-path shapes
   *                        differing only in a property read, not a route gap. Kept as a row —
   *                        it is a legitimate shape and its number is real — but it is a SIBLING,
   *                        not a control, and nothing about a rung can be read off it.
   *
   * Which is item 1775's own lesson arriving from the other side: it found `groupedHopAggregate`
   * looking "willing but ALWAYS starved" when the corpus simply never contained the shape that
   * reaches it. A corpus gap reads like a starvation; an ASSUMED twin reads like a route gap. Both
   * are fixed the same way — ask `compileLinear` which rung fires, and never label a row from
   * expectation.
   */
  hop2groupstart: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN a.k AS g, count(*) AS n',
  hopgroupsumsameend: 'MATCH (a:P)-[:E]->(b) RETURN b.k AS g, sum(b.n) AS s',
  point: 'MATCH (n:P) WHERE n.n = 12345 RETURN n.s AS s',
  scan: 'MATCH (n:P) RETURN count(*) AS c',
};

const q = SHAPES[SHAPE];

if (q === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

/** The edge's label set: disjoint `E`/`F`, every Nth carrying both, or `E` alone. */
const labelsFor = (k) => {
  if (DISJOINT) {
    return k % 2 === 0 ? ['E'] : ['F'];
  }

  return MULTILABEL > 0 && k % MULTILABEL === 0 ? ['E', 'F'] : ['E'];
};

/** Deterministic, so every process in an A/B builds byte-identical input. */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: SELECTIVE > 0 && i % SELECTIVE === 0 ? ['P', 'S'] : ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  const pool = FANIN >= 1 ? NODES : Math.max(Math.floor(NODES * FANIN), 1);

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    const i = k % NODES;
    // The FANOUT-th edge out of `i` lands somewhere else, so degree rises without the targets
    // collapsing onto one vertex — `FANIN` is the knob for that and the two stay independent.
    const hop = Math.floor(k / NODES);

    g.addEdge({
      id: `e${k}`,
      from: g.getVertexById(`v${STRIDE === 'random' ? (k * 7919) % NODES : i}`),
      // FANIN=1 keeps the original `(i * 7 + 3) % NODES`, byte-for-byte at FANOUT=1; a smaller
      // fraction concentrates the far endpoints into the first `NODES * FANIN` vertices.
      to: g.getVertexById(
        `v${
          STRIDE === 'random'
            ? ((k % NODES) * 104_729 + hop * 2_654_435_761) % pool
            : (i * 7 + 3 + hop * 2_654_435_761) % pool
        }`,
      ),
      // A THIRD carry both types, so `:E` and `:E|F` select the identical edge set and the
      // multi-bucket path actually has something to DEDUPE — without the overlap it would be a
      // concatenation and would not exercise the `Set` the dedupe allocates.
      labels: labelsFor(k),
      properties: { w: k % 13 },
    });
  }

  return g;
};

const g = build();

// Armed AFTER the fixture, so build-time collection is not attributed to the measured reps.
let gcMs = 0;
let gcCount = 0;
const obs = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gcMs += e.duration;
    gcCount += 1;
  }
});

obs.observe({ entryTypes: ['gc'] });

const series = [];
let sink = 0;
let answer;
// ⚠️ `answer` IS THE FIRST ROW, AND A ROUTE MAY LEGITIMATELY REORDER (item 1390). An unordered GQL
// result's row order is unspecified and `farDrivenHopWalk` reorders deliberately, so comparing the
// first row across A/B arms reports a difference that is licensed — it fired on item 1390's run,
// which had verified the multiset separately and still lost its timing table to the check. The
// invariant a driver should compare is `rowCount` plus the digest below.
let rowCount = 0;
let digest = 0;

/**
 * ⚠️ WINDOWED, so a profile of this bench is of the QUERY and not of the fixture build (item 1391).
 *
 * `node --cpu-prof` profiles start to exit, and at `NODES=100000` with `REPS=6` the load dominates:
 * a profile of the post-1390 yield path put `getVertexById` 10.4%, `indexEdgeLabel` 7.3%,
 * `commitElementLabels` 4.9% and `addVertex` 2.4% near the top — every one of them the LOAD, none of
 * them the query — exactly the inversion `windowed-profile.mjs` was built for at item 1362 and the
 * family of defect item 1360 recorded. Set `PROF_OUT` to a path and the profile covers only the rep
 * loop; leave it unset and `profileWindow` just runs the body, so timing runs are unaffected.
 */
const measure = () => {
  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = query(g, q);
    const dt = performance.now() - t0;

    series.push(dt);
    sink += rows.length;
    [answer] = rows;
    rowCount = rows.length;
    // An ORDER-INDEPENDENT digest of the whole result: summed per row, so a permutation cannot
    // change it while a changed VALUE or a dropped row can. It runs outside the timed window and it
    // is the check the first row cannot make.
    digest = 0;

    for (const row of rows) {
      for (const k of Object.keys(row)) {
        const v = row[k];

        if (typeof v === 'number') {
          digest += v;
        } else if (v !== null && v !== undefined) {
          digest += JSON.stringify(v).length;
        }
      }
    }
  }

  return sink;
};

await profileWindow(process.env.PROF_OUT, measure);

// ⚠️ DRAIN before reading: `PerformanceObserver` delivers in a queued callback, so a synchronous
// loop buffers every entry and reports 0 pauses (item 1361's fifth instrument defect).
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

obs.disconnect();

if (sink === 0) {
  throw new Error(`${SHAPE} produced NO rows across ${REPS} reps — measuring nothing`);
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

/**
 * ⚠️ DID THIS FIXTURE ACTUALLY PRODUCE AN ANSWER? (item 1416)
 *
 * A count of 0, or zero rows, means the query found NOTHING — so the timing is of a path that
 * matched nothing, and optimizing against it is optimizing a dead branch. That is not hypothetical:
 * `MULTILABEL=-1` halves the `E` edges, so every multi-hop chain row answers 0 at out-degree 1, and
 * a whole ranking of the non-hop rows was taken that way before anyone read the `answer` field.
 * `chain3` read 21.5 ms dead against 47.1 ms live — so the dead reading was not merely useless, it
 * ranked the rows wrongly.
 *
 * Printed as a FLAG rather than left for a reader to infer, because the field was already there and
 * being looked straight past. A driver can refuse on it; a human sees it next to the number.
 */
const zeroAnswer =
  rowCount === 0 ||
  (rowCount === 1 &&
    answer !== null &&
    typeof answer === 'object' &&
    Object.values(answer).every((v) => v === 0 || v === null));

console.log(
  JSON.stringify({
    shape: SHAPE,
    nodes: NODES,
    fanout: FANOUT,
    disjoint: DISJOINT,
    stride: STRIDE,
    selective: SELECTIVE,
    reps: REPS,
    drop: DROP,
    answer,
    rowCount,
    digest,
    ...(zeroAnswer ? { VACUOUS_ZERO_ANSWER: true } : {}),
    median: Number(at(0.5).toFixed(3)),
    p25: Number(at(0.25).toFixed(3)),
    p75: Number(at(0.75).toFixed(3)),
    min: Number(kept[0].toFixed(3)),
    max: Number(kept[kept.length - 1].toFixed(3)),
    gcMs: Number(gcMs.toFixed(1)),
    gcCount,
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
