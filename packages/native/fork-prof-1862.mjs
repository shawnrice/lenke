/**
 * WHERE DOES THE FORKED MULTI-PATTERN SPEND ITS TIME? (item 1862)
 *
 * The scaling sweep settled that it JOINS rather than products — 1.76x per doubling, not 4x — so
 * the 6.5x against the chain twin at the SAME row count is a constant factor, and a constant factor
 * is what a profile can attribute. One shape, one process.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 3200);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 60);
const Q = process.env.Q ?? 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN b.n AS x, c.n AS y';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8 } });
}

let e = 0;

for (let h = 0; h < FANOUT; h += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + h * 2_654_435_761) % N) + 1)),
      labels: ['E'],
    });
    e += 1;
  }
}

let rows = 0;
const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  rows += query(g, Q).length;
}

const ms = performance.now() - t0;

console.log(`${((ms * 1e6) / rows).toFixed(1)} ns/row over ${rows} rows in ${ms.toFixed(0)} ms`);
console.log(Q);
