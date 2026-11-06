/**
 * How much of a Gremlin call is PLAN CONSTRUCTION, per shape (item 1578)?
 *
 * The 32-shape profile probe builds every `SHAPES` entry ONCE at module level and reuses the plan
 * object across reps, so it has never measured construction at all. That is the right isolation for
 * a profile — but it means a real caller whose values vary pays something the standing instrument
 * cannot see, and item 1577 cut that cost 4.27x without any probe row moving.
 *
 * ⚠️ ONE SHAPE PER PROCESS (`SHAPE=<name>`), because the first version of this measurement put four
 * shapes in one process and reported a **NEGATIVE build share of -95.9%** for `point` — fresh plans
 * apparently faster than a reused one. That is item 762's dispatch pollution: all four arms share
 * one `toArray` call site, which goes megamorphic. The impossible sign is what exposed it; a merely
 * wrong number would have been published.
 *
 *     for s in control point hophas valuesk; do SHAPE=$s node gremlin-build-share-probe.mjs; done
 */
import { Graph } from '@lenke/core';
import { V, count, gt, has, out, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const SHAPE = process.env.SHAPE ?? 'control';

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
}

// Split the target on the REPEAT INDEX: `(i * a + b) % N` is invariant under `i -> i + N`, so a flat
// loop would point all of one vertex's edges at the same target and the graph would be functional.
for (let rep = 0; rep < FANOUT; rep += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${rep}_${i}`,
      from: vs[i],
      to: vs[(i * 7919 + rep * 104_729 + 1) % NODES],
      labels: ['E'],
    });
  }
}

/** Each shape: a builder taking the iteration index, plus how many reps it can afford. */
const SHAPES = {
  control: [() => traversal(V(), count()), 2000],
  point: [(i) => traversal(V(`v${i % NODES}`)), 2000],
  hophas: [() => traversal(V(), out('E'), has('k', gt(44)), count()), 200],
  valuesk: [() => traversal(V(), values('k')), 100],
};

const entry = SHAPES[SHAPE];

if (entry === undefined) {
  throw new Error(`unknown shape ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

const [make, reps] = entry;
const med = (f) => {
  const s = [];

  for (let q = 0; q < 5; q += 1) {
    const t0 = performance.now();

    for (let i = 0; i < reps; i += 1) {
      f(i);
    }

    s.push(performance.now() - t0);
  }

  s.sort((a, b) => a - b);

  return (s[2] / reps) * 1000;
};
const fixed = make(0);

// Warm both call shapes before either is timed.
toArray(fixed, g);
toArray(make(1), g);

const reused = med(() => toArray(fixed, g));
const fresh = med((i) => toArray(make(i), g));

console.log(
  JSON.stringify({
    shape: SHAPE,
    reps,
    reusedUs: Number(reused.toFixed(3)),
    freshUs: Number(fresh.toFixed(3)),
    buildSharePct: Number((((fresh - reused) / fresh) * 100).toFixed(1)),
  }),
);
