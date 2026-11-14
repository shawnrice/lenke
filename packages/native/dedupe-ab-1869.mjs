/**
 * THE FUSED SCAN DEDUPE, PER SHAPE (item 1869).
 *
 * ⚠️ THE CONTROLS ARE THE SHAPES THIS CANNOT REACH, and two of them matter for different reasons.
 * `V().values(k)` is the fused floor the deduped walk should land at or below. And the PIPELINE'S
 * OWN `dedupe` is exercised by `V().out(E).values(k).dedupe()`, which the rung refuses — item 1869
 * EXTRACTED the dedupe predicate out of `dispatch.ts`, so that central path must not have moved.
 */
import { Graph } from '@lenke/core';
import { V, dedupe, hasLabel, out, order, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const DISTINCT = Number(process.env.DISTINCT ?? 997);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: i % 3 === 0 ? ['T', 'U'] : ['T'],
    properties: { k: i % DISTINCT },
  });
}

for (let i = 0; i + 1 < N; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${i + 1}`),
    labels: ['E'],
  });
}

const SHAPES = [
  ['V().values(k).dedupe()            TARGET', traversal(V(), values('k'), dedupe())],
  [
    'V().hasLabel(U).values(k).dedupe() TARGET',
    traversal(V(), hasLabel('U'), values('k'), dedupe()),
  ],
  ['V().values(k)                     floor', traversal(V(), values('k'))],
  [
    'V().out(E).values(k).dedupe()     CONTROL (pipeline dedupe)',
    traversal(V(), out('E'), values('k'), dedupe()),
  ],
  ['V().values(k).order()             CONTROL (untouched)', traversal(V(), values('k'), order())],
  // ⚠️ THE LATENT-REGRESSION PROBE: `nodeValuesShortcut` ACCEPTS a `hasLabel` and walks the whole
  // graph, where the pipeline seeds from the label index. Item 1869 found that costing its DEDUPED
  // sibling 2.3x; this asks whether the undeduped rung pays the same, by comparing the labelled
  // form against a seeded spelling the rung refuses.
  [
    'V().hasLabel(U).values(k)         rung (whole-graph scan)',
    traversal(V(), hasLabel('U'), values('k')),
  ],
];

console.log(`${N} vertices, ${DISTINCT} distinct values, median of ${REPS} after 2 warm-ups`);
console.log('');

for (const [name, plan] of SHAPES) {
  const s = [];
  let rows = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();
    const got = toArray(plan, g);
    const ms = performance.now() - t0;

    if (r >= 2) {
      s.push(ms);
    }

    rows = got.length;
  }

  s.sort((a, b) => a - b);
  console.log(
    `${name.padEnd(60)} ${s[s.length >> 1].toFixed(2).padStart(8)} ms ${String(rows).padStart(8)} rows`,
  );
}
