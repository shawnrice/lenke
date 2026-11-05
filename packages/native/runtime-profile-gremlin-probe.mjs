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
 */
import { Graph } from '@lenke/core';
import {
  V,
  as_,
  coalesce,
  count,
  dedupe,
  fold,
  group,
  groupCount,
  gt,
  has,
  hasLabel,
  in_,
  order,
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
      to: g.getVertexById(`v${(k * 104_729) % NODES}`),
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
