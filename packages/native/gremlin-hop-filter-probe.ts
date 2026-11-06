/**
 * What does Gremlin's FILTERED hop cost, and where? (item 1602)
 *
 * Items 1600 and 1601 took the per-element gate on the GQL side — 1.25-1.31x on a filtered node
 * scan and 1.15x on the two-hop middle gate. This is the Gremlin twin of the same question, on the
 * same fixture shape, so the two surfaces can be compared on one instrument rather than inferred
 * from separate benches.
 *
 * ⚠️ ONE SHAPE PER PROCESS (items 737, 762). `SHAPE=<key>` selects; running the family together
 * moved a row 20% by POSITION in item 1600's probe.
 *
 *     SHAPE=far-count bun gremlin-hop-filter-probe.ts
 *     SHAPE=far-count bun --cpu-prof gremlin-hop-filter-probe.ts
 */
import { Graph } from '@lenke/core';
import { count, eq, has, hasLabel, out, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 400);
const SHAPE = process.env.SHAPE ?? 'far-count';

const PARAM = (i: number): string => `t${i % 50}`;

/**
 * Each shape is a function of the queried value, because a traversal is a BUILT object: reusing one
 * would measure a different question (item 1593 priced plan construction at 54% of a serving call
 * by reusing one arm's plan and not the other's, and the real share is ~17%).
 */
const SHAPES: Record<string, (v: string) => unknown> = {
  // The gate on the FAR endpoint of a one-hop count — the twin of GQL's `far-count`.
  'far-count': (v) => traversal(V(), hasLabel('User'), out('E'), has('team', eq(v)), count()),
  // The gate on the START, which can seed.
  'start-count': (v) => traversal(V(), hasLabel('User'), has('team', eq(v)), out('E'), count()),
  // Far gate, projecting.
  'far-proj': (v) =>
    traversal(V(), hasLabel('User'), out('E'), has('team', eq(v)), values('score')),
  // Two hops, so the gate sits in the middle of the walk.
  'mid-count': (v) =>
    traversal(V(), hasLabel('User'), out('E'), has('team', eq(v)), out('E'), count()),
  // NULL CONTROL: no `has` at all, so no per-element filter runs.
  'nofilter-count': () => traversal(V(), hasLabel('User'), out('E'), count()),
};

const build = SHAPES[SHAPE];

if (build === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE} — have ${Object.keys(SHAPES).join(', ')}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % 100, team: `t${i % 50}` },
  });
}

/**
 * ⚠️ SPLIT THE TARGET ON THE REPEAT INDEX, NOT ON `k`. `to = (a * k + b) % N` is INVARIANT under
 * `k -> k + N`, so a loop over `k < NODES * FANOUT` gives every one of a vertex's FANOUT edges the
 * SAME target: out-degree, in-degree and isolated counts all look perfect while the graph is
 * FUNCTIONAL (CLAUDE.md, items 1516/1518). `Math.floor(k / NODES)` is what makes the fanout branch.
 */
let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = k % NODES;
  const rep = Math.floor(k / NODES);
  const to = (from * 7 + rep * 2657 + 1) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`u${from}`)!,
    to: g.getVertexById(`u${to}`)!,
    labels: ['E'],
    properties: {},
  });
  edges += 1;
}

// COUNT THE DISTINCT ENDPOINTS before trusting a number off this fixture — the one line that would
// have caught item 702 and items 1516/1518.
const targets = new Set<string>();
const degreeOf = new Map<string, number>();

for (const e of g.edges) {
  targets.add(e.to.id);
  degreeOf.set(e.from.id, (degreeOf.get(e.from.id) ?? 0) + 1);
}

const branching = [...degreeOf.values()].filter((d) => d > 1).length;

console.log(
  `${NODES} vertices, ${edges} edges, ${targets.size} distinct targets, ${branching} with out-degree > 1`,
);

if (targets.size < NODES * 0.5 || branching < NODES * 0.5) {
  throw new Error('DEGENERATE FIXTURE — the generator collapsed; see the comment above');
}

// `toArray(plan, graph)` is the TS engine's execute entry — the same one `bench-gremlin.ts` times.
const exec = (i: number): unknown[] => toArray(build(PARAM(i)) as never, g);

for (let i = 0; i < 40; i += 1) {
  exec(i);
}

const answer = JSON.stringify(exec(1).slice(0, 2));
const t0 = performance.now();

for (let i = 0; i < REPS; i += 1) {
  exec(i);
}

const ns = ((performance.now() - t0) * 1e6) / REPS;

console.log(`${SHAPE.padEnd(16)} ${ns.toFixed(0).padStart(8)} ns/op   answer ${answer}`);
