/**
 * WHAT DOMINATES *INSIDE* THE FUSED CHAIN WALK? (item 1859)
 *
 * ⚠️ A DIFFERENT QUESTION FROM THE LAST FIVE ITEMS. Items 1846-1858 all asked "which shape reaches
 * no rung" — a route question, answered by a route screen because a missing rung has no hot frame
 * to profile. Both surfaces are now mined to ~2x on that axis, so this asks the other question:
 * given that the rung fires, where does its time go?
 *
 * ⚠️ THE SHAPE IS THE WORKLOAD SCREEN'S LARGEST REAL FAMILY. `chain-rows` is 565 ms of the screen
 * and 138 ns a row over 4.1M rows — the biggest producer that is not the genuine O(N^2) product.
 * So this profiles the exact walk that family spends its time in, rather than a shape chosen for
 * being easy to profile.
 *
 * ❌ ITS VERDICT WAS A CEILING, NOT A TARGET, and it is written here so the walk is not re-profiled.
 * 80.1% of the samples are ONE fully-inlined frame — the walk loop — and the only decomposable
 * component is `projectRow` at 6.1%, below this repo's ~10% noise floor. The adjacency iteration
 * and the label checks ARE the work, and they are the data layout rather than an addressable call.
 * Re-run this only to check that a layout change moved the 80% frame; a new target will not come
 * out of it. See item 1859 in docs/reviews/CLOSED.md for the figures and the two nominations that
 * came from the broad instruments instead.
 *
 * ⚠️ ENOUGH ITERATIONS THAT STARTUP CANNOT DOMINATE. Item 1843's first profile spent 22% of its
 * samples in `toUpperCase` called from `(module)` — the lexer's keyword table, built once at
 * import. Module init is ~17 ms, so the loop here runs for seconds.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 40);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 8, k: i % 5 } });
}

let e = 0;

for (let h = 0; h < FANOUT; h += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + h * 2_654_435_761) % NODES) + 1)),
      labels: ['E'],
    });
    e += 1;
  }
}

const Q = process.env.Q ?? 'MATCH (a:T)-[:E]->(b:T)-[:E]->(c:T) RETURN c.n AS x';

let rows = 0;
const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  rows += query(g, Q).length;
}

const ms = performance.now() - t0;

console.log(
  `${((ms * 1e6) / rows).toFixed(1)} ns/row over ${rows} rows in ${ms.toFixed(0)} ms — ${Q}`,
);
