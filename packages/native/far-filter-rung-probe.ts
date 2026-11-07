/**
 * WHICH RUNG admits a far-filtered yielding hop, and what residual it leaves (item 1631).
 *
 * ⚠️ READ THE RUNG FROM THE ENGINE, NOT FROM THE TIMING — the cliff finder's rule, and item 1602's
 * reason: timing cannot tell "declined" from "more work". `far-filter-values-floor.ts` measured
 * `out(E).has(k,eq(1)).id()` at **144.15 ms for 10,310 rows** against the unfiltered `out(E).id()`'s
 * **68.94 for 999,996** — while the `values(n)` twin of the same filtered walk costs 86.48. The two
 * projections are composed into `pick` by the same code, so a 1.67x between them should not exist
 * and the first question is whether both are even on the same route.
 *
 *     bun far-filter-rung-probe.ts
 */
import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';
import { V, eq, gt, has, id, out, traversal, values } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';

// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung entry point, read pre-build
import { hopValuesShortcut } from '../gremlin/src/executor/hop-values.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { effectivePlan } from '../gremlin/src/executor/index.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal rung entry point, read pre-build
import { startFilteredHopValues } from '../gremlin/src/executor/start-filtered-hop-values.js';

const g = new Graph();

for (let i = 0; i < 40; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { k: i % 7, n: i } });
}

for (let i = 0; i < 40; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: g.getVertexById(`u${i}`) as Vertex,
    to: g.getVertexById(`u${(i * 7 + 1) % 40}`) as Vertex,
    labels: ['E'],
    properties: {},
  });
}

const SHAPES: [string, Plan][] = [
  ['out.values            ', traversal(V(), out('E'), values('n'))],
  ['out.id                ', traversal(V(), out('E'), id())],
  ['out.farhas.values     ', traversal(V(), out('E'), has('k', eq(1)), values('n'))],
  ['out.farhas.id         ', traversal(V(), out('E'), has('k', eq(1)), id())],
  ['out.farhas(gt).values ', traversal(V(), out('E'), has('k', gt(-1)), values('n'))],
  ['out.farhas(gt).id     ', traversal(V(), out('E'), has('k', gt(-1)), id())],
  ['out.farhas            ', traversal(V(), out('E'), has('k', eq(1)))],
];

console.log(`${'shape'.padEnd(24)} ${'rung'.padEnd(22)} rest`);

for (const [name, plan] of SHAPES) {
  const effective = effectivePlan(plan, g, false);
  const hv = hopValuesShortcut(effective, g);
  const sf = hv === undefined ? startFilteredHopValues(effective, g) : undefined;
  const taken = hv ?? sf;
  let which = 'NONE (pipeline)';

  if (hv !== undefined) {
    which = 'hopValuesShortcut';
  } else if (sf !== undefined) {
    which = 'startFilteredHopValues';
  }

  const rest = taken === undefined ? '-' : JSON.stringify(taken.rest.map((s) => s.kind));
  const hasDrain = taken === undefined ? '-' : typeof (taken.values as { drain?: unknown }).drain;

  console.log(`${name.padEnd(24)} ${which.padEnd(22)} ${rest}  drain=${hasDrain}`);
}
