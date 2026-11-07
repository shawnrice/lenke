/**
 * Find UNPRICED hot code in the TS GREMLIN engine, mechanically. The Gremlin twin of
 * `runtime-profile-probe.mjs`, and it exists because that probe is GQL-ONLY.
 *
 * Item 921 built the unpriced-frame screen over five GQL shapes and reported "the next TS win is
 * unlikely to come from profiling the runtime path". Item 1358 found that verdict was partly an
 * artifact of the analyzer laundering unnameable frames into "already recorded" — and, separately,
 * that the probe it ran imports only `@lenke/core` and `@lenke/gql`. So **the Gremlin runtime path
 * has never been through this screen at all**, despite the standing instruction covering both
 * surfaces and despite `bench:gremlin`'s multi-hop count being the largest row in either suite.
 *
 * ONE SHAPE PER PROCESS (item 762): the shape comes from argv, so no other traversal shape pollutes
 * the dispatch sites of the one being measured.
 *
 *     node --cpu-prof --cpu-prof-dir=<dir> --cpu-prof-name=g-<shape>.cpuprofile \
 *          runtime-profile-gremlin-probe.mjs <shape> <reps>
 *
 * ⚠️ `toArray` takes (plan, graph) IN THAT ORDER. Item 1349 lost a round to calling it (graph, plan),
 * which throws nothing useful — it just measures the wrong thing.
 *
 * ⚠️ `@lenke/gremlin` is a BUILT DIST. A source edit reaches this probe only after `bun run build`.
 *
 * ⚠️ EVERY `SHAPES` ENTRY IS BUILT ONCE, AT MODULE LEVEL, AND THE PLAN OBJECT IS REUSED ACROSS REPS.
 * That is the right isolation for a profile — it measures EXECUTION and keeps plan construction out
 * of the frames — but it means this probe cannot see construction at all, and a caller whose values
 * vary pays it on every call because Gremlin has no parameter binding (item 1577). Item 1577 cut
 * construction 4.27x and not one row here moved, correctly.
 *
 * The gap is covered by `gremlin-build-share-probe.mjs`, which times a REUSED plan against one built
 * per call. Item 1578 measured construction, even after 1577, at a MEDIAN of **48.1%** of
 * `V().count()` and **51.5%** of `V(id)` over three runs each — and at noise (-0.4%, -0.3%) for
 * `hophas` and `valuesk`, whose execution dwarfs it. So a number from THIS probe is the serving cost
 * only for shapes whose execution dominates; for a cheap point query it is roughly HALF of it.
 *
 * ⚠️ Take the MEDIAN of several runs, not one. The `reused` arm is steady (0.137-0.147 us for
 * `control`) but the `fresh` arm spikes — 0.262, 0.284, then 1.006 across three runs — which is the
 * GC of allocating a plan per call, and a single run can read the share as high as 85.8%.
 */
import { Graph } from '@lenke/core';
import {
  V,
  as_,
  coalesce,
  count,
  dedupe,
  eq,
  fold,
  group,
  groupCount,
  gt,
  has,
  hasId,
  hasLabel,
  in_,
  limit,
  order,
  Order,
  out,
  project,
  select,
  toArray,
  traversal,
  id,
  identity,
  union,
  valueMap,
  values,
  repeat,
  match,
  local,
  optional,
  pipe,
  outE,
  inV,
  both,
} from '@lenke/gremlin';

import { profileWindow } from './windowed-profile.mjs';

const SHAPE = process.argv[2] ?? 'hopcount3';
const REPS = Number(process.argv[3] ?? 200);
/** ⚠️ See the size note in `runtime-profile-probe.mjs`: 20,000 is the CACHE-RESIDENT regime only. */
const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);

/**
 * One fixture for every shape, so a difference between shapes is the shape and not the data.
 * Deliberately the GQL probe's node count with a 5:1 edge ratio — CLAUDE.md's "match the fixture to
 * the claim": one edge per node is sparse, and per-edge costs scale with the edge:node ratio.
 */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    g.addEdge({
      id: `e${k}`,
      from: g.getVertexById(`v${(k * 7919) % NODES}`),
      // ⚠️ THE REPEAT INDEX IS LOAD-BEARING (item 1518). Any linear `(a*k + b) % N` is invariant
      // under `k -> k + N`, and the FANOUT edges leaving one vertex are exactly k0, k0+N, k0+2N, …
      // — so the old `(k * 104_729) % NODES` sent EVERY one of them to the SAME target. Degrees
      // looked perfect and the graph was functional: one distinct out-neighbour per vertex at any
      // fanout. Item 1516 found the same defect in the GQL bench's own fixture, and `small` arms
      // elsewhere in this corpus already carry this `hop` term for exactly this reason.
      // Both products stay far inside 2^53.
      to: g.getVertexById(
        `v${((k % NODES) * 104_729 + Math.floor(k / NODES) * 2_654_435_761) % NODES}`,
      ),
      labels: ['E'],
      properties: { w: k % 13 },
    });
  }

  return g;
};

const SHAPES = {
  // The CONTROL: answered by an O(1) bucket read, so none of the traverser machinery runs. A frame
  // that is hot here is fixture build or harness, not the engine's query path.
  control: traversal(V(), count()),
  // The largest row in `bench:gremlin` — the per-vertex multiplicity walk in `hopChainCount`.
  hopcount3: traversal(V(), hasLabel('P'), out('E'), out('E'), out('E'), count()),
  // Two hops, which the DEGREE INNER PRODUCT answers without an edge walk (item 590). Kept as the
  // reference for the row above: a change that moves both is in shared code.
  hopcount2: traversal(V(), hasLabel('P'), out('E'), out('E'), count()),
  // A row-RETURNING hop, so no count shortcut can claim it.
  hopbare: traversal(V(), out('E')),
  // The ORDER path, the Gremlin twin of GQL's `sortedpage` — item 1358's biggest GQL find.
  hoporder: traversal(V(), out('E'), values('k'), order()),
  // Grouping, the twin of GQL's `grouped`, which item 1358 found is 66% of its shape.
  grouped: traversal(V(), groupCount({ by: 'k' })),
  // A filter chain (item 537's shape), where the label is VACUOUS so it excludes nothing.
  filterchain: traversal(V(), hasLabel('P'), has('k', gt(44)), count()),
  // De-duplication over a hop, which materializes a set per traversal.
  hopdedupe: traversal(V(), out('E'), dedupe(), count()),
  // ⚠️ A HOP WITH A FILTER AFTER IT (item 1493). `filterchain` filters the VERTEX SET (200,000
  // tests) and `hopbare` walks without filtering; neither is the common real shape, which is to
  // walk and then filter the FAR end — one test per EDGE, so the test count scales with FANOUT
  // rather than with |V|. Item 1492 measured this at 51.8 ms against `hopbare`'s 44.5 at
  // 200,000 x 2, so the filter is 18 ns of a 111 ns-per-edge row, and the question is what the
  // other 111 are.
  hophas: traversal(V(), out('E'), has('k', gt(44)), count()),

  // ── Item 1474: shapes the screen never covered ──────────────────────────────────────────────
  //
  // The eight above are hops, order, grouping, filtering and dedupe. None of them is a SET
  // OPERATION, a wide PROJECTION, an OPTIONAL side or a named-step SELECT — and the GQL twin of
  // that gap is exactly where item 1473 found a 4.63x defect (`combineRows` built a key set both
  // UNION branches discarded). The same question asked of Gremlin.

  // ⚠️ OPPOSITE DIRECTIONS DELIBERATELY. Item 1460 fuses `union(out(T), out(T))` into one hop, so a
  // same-direction union would measure the fusion rather than the union machinery.
  unioned: traversal(V(), union(out('E'), in_('E')), count()),
  // A wide projection: two sub-traversals materialized per row.
  projected: traversal(V(), project('a', 'b'), count()),
  // The whole property bag per element, the widest read in the surface.
  valuemapped: traversal(V(), valueMap(), count()),
  // The optional side — `coalesce` keeps the left row when the hop yields nothing.
  coalesced: traversal(V(), coalesce(out('E'), V()), count()),
  // A named step and a select, the shape a join is written as.
  selected: traversal(V(), as_('a'), out('E'), select('a'), count()),
  // Grouping with a REDUCER, which `groupCount` above does not exercise.
  groupreduce: traversal(V(), group({ by: 'k' }), count()),
  // Barrier: the whole stream collapsed into one list.
  folded: traversal(V(), values('k'), fold(), count()),
  // ⚠️ `values()` DIRECTLY, with nothing after it to dilute the measurement. Item 1476 found
  // `projectValues` at 49.22% of `folded` — but `folded` also pays `foldStep`, so a change to
  // `values` measured only there would be divided by work it did not touch.
  valuesonly: traversal(V(), values('k'), count()),
  // Two keys, which takes the multi-key arm the single-key specialization must not change.
  valuestwo: traversal(V(), values('k', 'n'), count()),
  // ⚠️ ROWS, NOT COUNT (item 1485): a trailing single-key `values(k)` under a `count()` is a
  // presence filter and the values are never produced, so a count tail measures the shortcut rather
  // than the read. These two force the rows out, and differ only in the fused walk's `pick`:
  // `far.properties[k]` against `far.id`. 149 ns/row against 53 at 200,000 — the gap IS the
  // property read, and `values()` is on nearly every query.
  hopvaluesrows: traversal(V(), out('E'), values('k')),
  hopidrows: traversal(V(), out('E'), id()),

  /**
   * ⚠️ Item 1614: THE SECOND HOP UNDER A ROW-RETURNING TAIL, which the screen has never covered.
   * Every two-hop shape above ends in `count()`, which `hopChainCount` answers from degrees without
   * walking at all (item 590) — so the whole two-hop WALK has only ever been profiled in the arm
   * where it does not run. `gremlin-cliff-finder.ts` priced the row-returning twin at **315 ns a
   * row** against `hopvaluesrows`' 33 over 20,000x4, and a 9.5x per-row gap between one hop and two
   * is not a workload difference: both emit one property read per arriving traverser.
   *
   * `hop2idrows` is the same split `hopidrows` is to `hopvaluesrows` — it isolates the property read
   * from the walk, so a gap present in BOTH is the walk and a gap only in the first is the read.
   */
  hop2valuesrows: traversal(V(), out('E'), out('E'), values('k')),
  hop2idrows: traversal(V(), out('E'), out('E'), id()),

  // ── Item 1634: THREE hops yielding, the stacked arm ────────────────────────────────────────
  // The largest absolute TS row in the corrected bench (6868.6 ms) and 5.5x native. Item 1617
  // fused it with one generic STACKED walk for every depth above two; hop-chain-depth-floor.ts
  // now prices that arm at 1218.36 ms against a hand-written iterator stack'"'"'s 984.85 and literal
  // nesting'"'"'s 889.84 at 50,000/5 - 1.24x and 1.37x. Depth TWO is at its floor (1.04x), so the
  // gap is specific to the stacked walk.
  hop3valuesrows: traversal(V(), out('E'), out('E'), out('E'), values('k')),

  // ── Item 1642: a SEEDED POINT LOOKUP, which this probe had no shape for ─────────────────────
  // Item 1594 measured GQL answering an identical seeded point lookup in 650 ns against Gremlin's
  // 2619 and attributed ~2150 ns to "per-call machinery for a ONE-element result"; item 1641
  // re-measured the pair at 805 against 2000, so ~1200 ns of that machinery is still there. It is a
  // PER-CALL cost, not a per-row one, so none of items 1613-1636's walk fusions touch it — and it
  // is what every point query pays.
  //
  // ⚠️ THE PLAN IS REUSED HERE, like every shape in this file, so this measures EXECUTION only.
  // Construction is the other half and has its own instrument (`gremlin-build-share-probe.mjs`,
  // where item 1578 measured it at a MEDIAN of 48.1% of `V().count()`).
  point: traversal(V(), hasId('v12345'), values('k')),
  pointcount: traversal(V(), hasId('v12345'), count()),

  /**
   * ⚠️ Item 1615: the two shapes item 1614 LEFT on the pipeline, and the only two the cliff finder
   * still reads that way. Both are a two-hop walk with a `has` in it, and both now sit beside a
   * FUSED neighbour, which is what makes their cost a route loss rather than honest filtering:
   *
   *     hop hop values                    18.6 ms   319972 rows   <- fused at 1614
   *     hop hop + trailing has, values    87.3        6400        <- the pipeline, 4.68x
   *     hop + mid has + hop, values       14.0        6400        <- the pipeline
   *
   * The trailing row costs 4.7x its neighbour for FIFTY TIMES FEWER rows, because it walks all
   * 319,972 traversers down the pipeline and then filters.
   */
  hop2trailinghas: traversal(V(), out('E'), out('E'), has('k', gt(44)), values('k')),
  hop2midhas: traversal(V(), out('E'), has('k', gt(44)), out('E'), values('k')),

  // ── Item 1478: the last unprofiled Gremlin steps ────────────────────────────────────────────
  //
  // Variable-length traversal, the declarative join, and per-traverser scoping. All three are core
  // surfaces and none has ever been in a profile — the same question that found `groupStep` (1.27x)
  // and `projectValues` (1.39x) on this probe.
  //
  // ⚠️ Profiled at 200+ reps from the start. Item 1476: a 72-sample profile ranked the wrong frame,
  // and item 1477 confirmed the clean side of the same lesson.

  // Variable-length: `repeat(out('E')).times(2)`. At FANOUT=5 that is 25 rows per source, so the
  // size is kept well below the other shapes' to stay inside the memory cap.
  repeated: traversal(V(), repeat(out('E')).times(2), count()),
  // The declarative join. Two bound names over one hop, which is the smallest shape that exercises
  // the matcher rather than a single pattern.
  matched: traversal(V(), match(pipe(as_('a'), out('E'), as_('b'))), count()),
  // ⚠️ TWO AND THREE PATTERNS, because `matched` above has exactly ONE and that is the worst case
  // for anything that amortizes over the solver's DEPTH (item 1559). The DFS is depth 1 there, so a
  // change that trades k copies along a path for 1 at the leaf cannot show anything: k IS 1. These
  // two give the matcher an actual join to solve.
  matched2: traversal(
    V(),
    match(pipe(as_('a'), out('E'), as_('b')), pipe(as_('b'), out('E'), as_('c'))),
    count(),
  ),
  // ⚠️ A THREE-PATTERN `matched3` IS DELIBERATELY ABSENT. It measured 2383 ms a REP at FANOUT=5
  // (125 solutions a source), so it would add ~8 minutes to a 200-rep sweep. Item 1478 made the
  // same call about the 3-hop end-filtered question for the same reason: a shape whose single rep
  // takes seconds makes a probe nobody runs. Two patterns already give the solver a real join, and
  // item 1559's arithmetic says depth is not the axis that matters here anyway.
  // A multi-pattern match whose bindings are actually READ downstream, so the leaf snapshot is
  // load-bearing rather than dead. Without this the only multi-pattern rows would be ones where
  // nothing observes the tags, which is the easy half of the question.
  matchedsel: traversal(
    V(),
    match(pipe(as_('a'), out('E'), as_('b')), pipe(as_('b'), out('E'), as_('c'))),
    select('c'),
    count(),
  ),
  // Per-traverser scoping: `local` runs its sub-traversal once per incoming traverser, so it is the
  // shape where sub-plan setup cost is paid N times rather than once.
  localized: traversal(V(), local(pipe(outE(), inV())), count()),
  // ⚠️ THE HAND FLOOR for `localized`: the same inner chain written WITHOUT the local() wrapper.
  // `local` re-dispatches its sub-plan once per incoming traverser, and for a plan made only of
  // per-traverser steps (a flatMap chain with no barrier) that scoping changes nothing — so this is
  // the answer `local` could give if it fused. The gap between the two IS the opportunity, measured
  // before building the gate rather than after (item 1465's rule: price with a floor first).
  localfloor: traversal(V(), outE(), inV(), count()),
  // ⚠️ THE SHAPES THAT ACTUALLY TRAVERSE. The two above both end in a bare `count()`, which a chain
  // count can answer WITHOUT walking (0.07 ms) — so their ratio measures whether the count shortcut
  // applies, not what the walk costs. Appending `values('k')` defeats the shortcut in both arms, so
  // these are the pair that prices `local`'s per-traverser dispatch honestly.
  localvalues: traversal(V(), local(pipe(outE(), inV())), values('k'), count()),
  localvaluesfloor: traversal(V(), outE(), inV(), values('k'), count()),

  // ── Item 1480: the PER-ELEMENT branch steps ─────────────────────────────────────────────────
  //
  // `coalesce`/`choose`/`optional`/`branch` route each traverser individually BY DESIGN — unlike
  // `local`, that is their semantics, not an artefact, so item 1479's fusion cannot apply. The open
  // question is whether the per-traverser RE-DISPATCH (`applyPlanToStream` walking the step array
  // through a 103-arm switch, once per row) is itself expensive enough to be worth attacking.
  //
  // ⚠️ Realistic forms. Item 1474's `coalesced` used `coalesce(out('E'), V())`, whose second arm
  // rescans the whole graph — a shape nobody writes, and one whose cost is the rescan rather than
  // the dispatch.
  optionald: traversal(V(), optional(pipe(out('E'))), count()),
  coalesced2: traversal(V(), coalesce(pipe(out('E')), pipe(identity())), count()),
  // The floor for both: the arm that almost always wins, with no branch wrapper at all.
  branchfloor: traversal(V(), out('E'), count()),
  // ⚠️ And the honest pair, since a bare `count()` tail is answered by a chain count without
  // walking (item 1479 learned this the hard way at 377x). At FANOUT 5 every vertex has out-edges,
  // so `optional(out('E'))` always takes its first arm and the floor is semantically comparable.
  optionalvalues: traversal(V(), optional(pipe(out('E'))), values('k'), count()),
  coalescevalues: traversal(V(), coalesce(pipe(out('E')), pipe(identity())), values('k'), count()),
  branchvaluesfloor: traversal(V(), out('E'), values('k'), count()),

  // ── Item 1630: the UNCAPPED global sort over a fused walk, and its capped twin ───────────────
  // `hoporder` above is the target. This is the spelling `fuseOrderTake` folds into a `cap`, which
  // item 1591's fusion reaches only when the `values` step survives to `run`'s loop — here
  // `hopValuesShortcut` consumes it, so before item 1630 it returned TEN ROWS in 272 ms.
  hopordercap: traversal(V(), out('E'), values('k'), order(), limit(10)),
  // The DESCENDING spelling, which arrives as an identity `by` rather than as `desc: true` — the
  // shape whose gate item 1591 got wrong and only a literal expectation caught.
  hoporderdesc: traversal(V(), out('E'), values('k'), order(Order.desc)),

  // ── Item 1631: a SELECTIVE FAR FILTER on a yielding hop ─────────────────────────────────────
  // The cliff finder's biggest oddity at 200,000/5: `hop + far has, values` costs 188.2 ms to
  // produce 20,000 rows where the UNFILTERED `hop values` costs 132.8 for 999,996 — the filter
  // costs more than the 50x fewer rows save. `team` is 1 in 50, so this is the selective arm; the
  // probe's existing `hophas` is a COUNT and `hop2trailinghas` is two hops.
  hopfarhasvalues: traversal(V(), out('E'), has('k', eq(1)), values('n')),
  // The UNFILTERED neighbour, which is the same walk with nothing removed — the control that says
  // whether a change is in the filter or in the walk.
  hopvaluesn: traversal(V(), out('E'), values('n')),
  // The `id()` twin, 3.14x its own unfiltered neighbour in the same run.
  hopfarhasid: traversal(V(), out('E'), has('k', eq(1)), id()),
  // Item 1647's residual: the union spelling costs 118 ns more per call than the `both` plan the
  // rewrite turns it into, and only 27 of that is the (now cached) rewrite. These two shapes are
  // the pair that isolates where the other ~91 ns goes.
  unioncount: traversal(V(), union(out('E'), in_('E')), count()),
  bothcount: traversal(V(), both('E'), count()),
};

const plan = SHAPES[SHAPE];

if (plan === undefined) {
  throw new Error(`unknown shape ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

const g = build();
let sink = 0;
const t0 = performance.now();

await profileWindow(process.env.PROF_OUT, () => {
  for (let i = 0; i < REPS; i += 1) {
    const rows = toArray(plan, g);

    sink += Array.isArray(rows) ? rows.length : 1;
  }

  return sink;
});

const ms = performance.now() - t0;

// Asserted, not printed and ignored: a shape that silently returned nothing would profile the error
// path and look like a result.
if (sink === 0) {
  throw new Error(
    `${SHAPE} produced NO rows across ${REPS} runs — the profile would be of nothing`,
  );
}

console.log(JSON.stringify({ shape: SHAPE, reps: REPS, ms: Number(ms.toFixed(1)), sink }));
