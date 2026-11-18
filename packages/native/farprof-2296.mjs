/**
 * ⚠️⚠️ **WHY IS THE INLINE FAR PREDICATE 2.8x SLOWER THAN THE CLAUSE ONE? (item 2296)**
 *
 * Item 2295 isolated it to within 1% and established what it is NOT: not a route difference (all
 * spellings compile to `hopProjection`), not item 2293's orientation gate (the far node is unlabelled, so
 * no bucket can be 64x smaller), and not item 2291's direction (here the CLAUSE form is the fast one).
 *
 * ```text
 *     (b {k: 5})          130.66 / 128.58 / 129.07 ms
 *     (b WHERE b.k = 5)   146.73 / 143.79 / 145.64
 *     (b) WHERE b.k = 5    46.34 /  46.38 /  46.09   <- 2.8x FASTER
 * ```
 *
 * 🔑 ONE SHAPE PER PROCESS, so a profile of this driver attributes to one spelling only — items
 * 2285/2286 showed extra arms in one process both erase and manufacture gaps.
 *
 * ⚠️ `SHAPE=rows` is the CONTROL: the same hop with no predicate at all. Without it a profile cannot
 * separate what the predicate costs from what the walk costs.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'inlineProp';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 90 } });
}

for (let i = 0; i < N; i += 1) {
  const from = g.getVertexById(`v${(i * 7919) % N}`);
  const to = g.getVertexById(`v${(i * 104_729) % N}`);

  if (from && to) {
    g.addEdge({ id: `e${i}`, from, to, labels: ['E'], properties: {} });
  }
}

const QUERIES = {
  inlineProp: 'MATCH (a:P)-[:E]->(b {k: 5}) RETURN b.k AS v',
  inlineWhere: 'MATCH (a:P)-[:E]->(b WHERE b.k = 5) RETURN b.k AS v',
  clause: 'MATCH (a:P)-[:E]->(b) WHERE b.k = 5 RETURN b.k AS v',
  /* The CONTROL: the same hop, no predicate — so the predicate's own cost is readable by subtraction. */
  rows: 'MATCH (a:P)-[:E]->(b) RETURN b.k AS v',
};

const text = QUERIES[SHAPE];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (let w = 0; w < 3; w += 1) {
  query(g, text, {});
}

const ts = [];
let rows = 0;

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();

  rows = query(g, text, {}).length;
  ts.push(performance.now() - t);
}

console.log(
  `  SHAPE=${SHAPE.padEnd(11)} median ${med(ts).toFixed(2).padStart(8)} ms   rows=${rows}`,
);
