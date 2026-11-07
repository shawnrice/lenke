/**
 * ONE far-filter shape per PROCESS (item 1631), because the multi-arm floor could not resolve the
 * question it raised.
 *
 * ⚠️ WHY THIS EXISTS. `far-filter-values-floor.ts` runs eight arms in one process and reported
 * `out(E).has(k,eq(1)).id()` at 144.15 ms against the `values(n)` twin's 86.48 — same route, same
 * loop, same composed `pick`, differing only in the inner closure. But `pick` is called through a
 * closure VARIABLE inside that loop, so running several arms in one process makes that call site
 * polymorphic across them: the measurement cannot distinguish "this projection is slower" from
 * "this process taught the loop four shapes" (items 737 and 762, and the `pick` inlining question
 * `start-filtered-hop-values.ts`' header already records as unsettled).
 *
 *     SHAPE=farhasid bun far-filter-one-shape.ts
 *     NODES=200000 REPS=9 SHAPE=farhasvalues bun far-filter-one-shape.ts
 */
import { Graph } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';
import { V, eq, gt, has, id, out, toArray, traversal, values } from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'farhasid';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { k: i % 97, n: i } });
}

/** ⚠️ Split on the REPEAT INDEX — items 1516/1518; a linear `(a*k+b)%N` makes the graph functional. */
let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = k % NODES;
  const to = (from * 7 + Math.floor(k / NODES) * 2657 + 1) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`u${from}`) as Vertex,
    to: g.getVertexById(`u${to}`) as Vertex,
    labels: ['E'],
    properties: {},
  });
  edges += 1;
}

const targets = new Set<string>();

for (const e of g.edges) {
  targets.add(e.to.id);
}

if (targets.size < NODES * 0.5) {
  throw new Error('DEGENERATE FIXTURE — the generator collapsed');
}

/** The hand floors, each its own function so only the selected one is ever called. */
const handFiltered = (): number => {
  let n = 0;

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const e of bucket as Iterable<Edge>) {
      const far = e.to;

      if (far.properties.k === 1 && far.id !== undefined) {
        n += 1;
      }
    }
  }

  return n;
};

const PLANS: Record<string, () => number> = {
  farhasid: () => toArray(traversal(V(), out('E'), has('k', eq(1)), id()), g).length,
  farhasvalues: () => toArray(traversal(V(), out('E'), has('k', eq(1)), values('n')), g).length,
  farhasalwaysid: () => toArray(traversal(V(), out('E'), has('k', gt(-1)), id()), g).length,
  farhasalwaysvalues: () =>
    toArray(traversal(V(), out('E'), has('k', gt(-1)), values('n')), g).length,
  plainid: () => toArray(traversal(V(), out('E'), id()), g).length,
  plainvalues: () => toArray(traversal(V(), out('E'), values('n')), g).length,
  handfiltered: handFiltered,
};

const run = PLANS[SHAPE];

if (run === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; one of ${Object.keys(PLANS).join(', ')}`);
}

let rows = 0;

for (let i = 0; i < 2; i += 1) {
  rows = run();
}

// The per-rep SERIES, not just a summary: the TS per-row path plateaus high and emits a rare fast
// rep, so `min` can estimate two arms differently (the rule in CLAUDE.md's bench section).
const series: number[] = [];

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();

  rows = run();
  series.push(performance.now() - t0);
}

const sorted = [...series].sort((a, b) => a - b);
const warm = series.slice(3);
const median = [...warm].sort((a, b) => a - b)[Math.floor(warm.length / 2)];

console.log(
  JSON.stringify({
    shape: SHAPE,
    rows,
    edges,
    min: Number(sorted[0].toFixed(2)),
    median: Number(median.toFixed(2)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);

// A Plan is referenced so the import is not elided by a future edit that drops an arm.
const _keep: Plan = traversal(V(), out('E'), id());

void _keep;
