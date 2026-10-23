// What does a PER-ELEMENT branch cost in the pure-TS Gremlin engine?
//
// Item 624 fixed this in the native engine: `coalesce`/`choose` ran TinkerPop's per-traverser
// semantics literally (a one-row batch per input row per arm) at 368/478 ns/row, against
// `union`'s 8.4 whole-stream — 36x once the arms were run over the whole frontier. It closed
// by naming the TS engine as unpriced, because `coalesceStep` has the SAME SHAPE there:
//
//     for (const t of stream) { for (const plan of plans) { [...applyPlanToStream(plan, [t], …)] } }
//
// against `unionStep`'s whole-stream `applyPlanToStream(plan, all, …)`. Same shape is not the
// same cost, though: the TS engine is a generator pipeline, not a columnar one, so a per-row
// call is a generator resume and an array materialization rather than a batch allocation, and
// `union` pays `[...stream]` up front where `coalesce` does not. Which way that lands is a
// measurement, and this is it.
//
//   cd packages/native && bun branch-cost-probe.ts
//   PROBE_N=50000 bun branch-cost-probe.ts
//
// `@lenke/gremlin` is a BUILT DIST — a source edit needs `bun run build` before it is visible
// here.
import { Graph } from '@lenke/core';
import { V, choose, coalesce, has, in_, out, toArray, traversal, union } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';

const N = Number(process.env.PROBE_N ?? 20_000);
const REPS = Number(process.env.PROBE_REPS ?? 9);

const graph = new Graph();
// `addEdge` wants the vertex OBJECTS its `addVertex` returned, not their ids.
const vs = Array.from({ length: N }, (_, i) =>
  graph.addVertex({ id: `v${i}`, labels: ['N'], properties: { num: i % 1000 } }),
);

for (let i = 0; i < N; i++) {
  graph.addEdge({
    id: `e${i}`,
    from: vs[i],
    to: vs[(i * 7 + 1) % N],
    labels: ['R'],
    properties: {},
  });
}

// `toArray(plan, graph)` is how a builder plan is run against the TS engine (bench-gremlin.ts).
const cases: [string, Plan][] = [
  // The floor: the frontier, then the frontier and one hop, with no branch at all.
  ['V() (the floor)', traversal(V())],
  ['V().out (1 hop)', traversal(V(), out('R'))],
  // The control the change cannot reach: `union` is already whole-stream in TS.
  ['union(out, out)', traversal(V(), union(traversal(out('R')), traversal(out('R'))))],
  ['coalesce(out, out)', traversal(V(), coalesce(traversal(out('R')), traversal(out('R'))))],
  ['coalesce(out, in)', traversal(V(), coalesce(traversal(out('R')), traversal(in_('R'))))],
  [
    'choose(has, out, in)',
    traversal(V(), choose(traversal(has('num', 1)), traversal(out('R')), traversal(in_('R')))),
  ],
  // Arm 0 produces NOTHING for every row, so both arms run: the per-row cost doubles if the
  // branch overhead is what dominates, and barely moves if the hop is.
  ['coalesce(MISS, out)', traversal(V(), coalesce(traversal(out('NOPE')), traversal(out('R'))))],
];

console.log(`\n=== TS branch cost, ${N} vertices / ${N} edges, min of ${REPS} ===`);
console.log(
  `${'case'.padEnd(24)}${'total_ms'.padStart(10)}${'ns/row'.padStart(10)}${'xFloor'.padStart(9)}${'rows'.padStart(10)}`,
);

let floor = 0;

for (const [label, plan] of cases) {
  let lo = Number.POSITIVE_INFINITY;
  let rows = 0;

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();
    const got = toArray(plan, graph);
    lo = Math.min(lo, performance.now() - t);
    rows = got.length;
  }

  const perRow = (lo * 1e6) / N;

  if (floor === 0) {
    floor = perRow;
  }

  console.log(
    `${label.padEnd(24)}${lo.toFixed(2).padStart(10)}${perRow.toFixed(2).padStart(10)}${(perRow / floor).toFixed(1).padStart(9)}${String(rows).padStart(10)}`,
  );
}
