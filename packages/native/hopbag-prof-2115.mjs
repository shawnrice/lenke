/*
 * Item 2115 — WHERE does `hop + store + values`'s ~105 unexplained ms go?
 *
 * WHAT IS ESTABLISHED. `hop + values` is 28 ms and `hop + store + values` 139 at 200,000 vertices /
 * 600,000 edges. Item 2114 blamed the bag; item 2115's floor refuted that — pushing 600,000 of the
 * engine's own vertex objects costs **2.4 ms**, and through a `pick`-shaped closure the pushes add 5.6 ms
 * over the same read. So ~105 ms is unaccounted for and this profile is to name it.
 *
 * ROUNDS ARE HIGH AND THE FIXTURE IS BUILT ONCE, so the graph construction is a small share of the
 * samples — item 1933's rule, and item 2110 is what happens when it is ignored (a profile whose top
 * frames were all `insertEdge` and `set labels`).
 *
 *     SHAPE=bag bun --cpu-prof --cpu-prof-dir=<dir> hopbag-prof-2115.mjs
 *     SHAPE=bare bun --cpu-prof --cpu-prof-dir=<dir> hopbag-prof-2115.mjs   # the CONTROL
 */
import { Graph } from '@lenke/core';
import { out, store, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const ROUNDS = Number(process.env.ROUNDS ?? 15);
const SHAPE = process.env.SHAPE ?? 'bag';
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: i % 5 === 4 ? { other: i } : { n: i % 97 },
  });
}

let e = 0;

for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

const shapes = {
  /* THE SUBJECT: the bag between the hop and the projection. */
  bag: () => traversal(V(), out('E'), store('x'), values('n')),
  /* THE CONTROL: the same hop and projection with NO bag — 28 ms, the fused walk. */
  bare: () => traversal(V(), out('E'), values('n')),
  /* A SECOND CONTROL: the bag with NO projection after it, to split the two residual steps. */
  bagonly: () => traversal(V(), out('E'), store('x')),
};
const make = shapes[SHAPE];

if (make === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; one of ${Object.keys(shapes).join(', ')}`);
}

const plan = make();
const series = [];
let rows = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  rows = toArray(plan, g).length;
  series.push(performance.now() - t0);
}

/* THE FIRST FIVE REPS ARE DROPPED: the CSR arms on the SECOND ask of a topology version, and the
 * per-rep series shows it settling only by rep 6 (204 134 58 58 56 36 35 35 35). A median over all reps
 * reports the arming, not the steady state. */
const sorted = series.slice(5).sort((a, b) => a - b);

console.log(`  SHAPE=${SHAPE}  edges=${e}  rows=${rows}`);
console.log(
  `  median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms   per-rep: ${series.map((v) => v.toFixed(0)).join(' ')}`,
);
