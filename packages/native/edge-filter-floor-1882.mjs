/**
 * WHAT IS THE EDGE-PROPERTY FILTER COSTING, AND WHAT IS ITS FLOOR? (item 1882)
 *
 * Item 1881's workload screen nominated `V().outE('E').has('w', gt(3)).inV().values('n')` as the
 * largest absolute on the Gremlin surface. It also reported the shape as already FUSED, and **that
 * was wrong** — item 1882's route census (now a permanent `edgef:` family in
 * `gremlin-route-screen.mjs`) reads:
 *
 *     generic   edgef: outE has inV values      4 applyStep calls  [has inV outE values]
 *     SHORTCUT  edgef: outE inV values          0
 *
 * So the predicate is the whole difference: drop the `has` and the same traversal is answered by a
 * fused walk; keep it and all four steps run through the generic traverser pipeline. Every one of
 * the family's seven filtered spellings is generic.
 *
 * THIS FILE IS THE PRICE, AND IT IS ONE SHAPE PER PROCESS. Item 1874 retracted a 1.73x that was
 * a within-process cross-row ratio and item 1870 measured a control moving 1.7x purely by running
 * last. So `SHAPE` selects exactly one traversal and the comparison is made BETWEEN runs:
 *
 *     for s in filtered unfiltered hop; do SHAPE=$s bun edge-filter-floor-1882.mjs; done
 *
 * AND IT REPORTS ns PER EDGE VISIT, not only ns a row. The filtered shape emits ~46% of the rows
 * the unfiltered one does, so a per-ROW ratio flatters it — item 1858 declined a target for exactly
 * this reason ("it visits the same 200,000 vertices and emits 7x fewer rows, so the per-ROW figure
 * overstates it badly"). Both shapes visit the SAME edges; that is the invariant denominator.
 */
import { Graph } from '@lenke/core';
import { V, gt, has, inV, out, outE, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'filtered';

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const W_POOL = [1, 2, 3, 4, 5, 7, 9];

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: N_POOL[i % N_POOL.length], k: i % 50 },
  });
}

let eEdges = 0;

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);
  const labels = hop % 4 === 3 ? ['F'] : ['E'];

  if (labels[0] === 'E') {
    eEdges += 1;
  }

  g.addEdge({
    id: `e${e}`,
    // The repeat index is in the expression — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy.
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels,
    properties: { w: W_POOL[e % W_POOL.length] },
  });
}

{
  const seen = new Set();

  for (let hop = 0; hop < FANOUT; hop += 1) {
    seen.add((3 + hop * 2_654_435_761) % N);
  }

  if (FANOUT > 1 && seen.size < 2) {
    throw new Error(`fixture is FUNCTIONAL: v1 reaches ${String(seen.size)} distinct targets`);
  }
}

/** All three visit the SAME `E` edges; only the predicate and the projection differ. */
const SHAPES = {
  filtered: () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')),
  unfiltered: () => traversal(V(), outE('E'), inV(), values('n')),
  hop: () => traversal(V(), out('E'), values('n')),
};

const plan = SHAPES[SHAPE]();
const series = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();

  rows = toArray(plan, g).length;

  const ms = performance.now() - t0;

  if (r >= 2) {
    series.push(ms);
  }
}

series.sort((a, b) => a - b);

const ms = series[series.length >> 1];

console.log(
  `${SHAPE.padEnd(11)} ${ms.toFixed(2).padStart(8)} ms  ${String(rows).padStart(8)} rows  ` +
    `${((ms * 1e6) / Math.max(rows, 1)).toFixed(0).padStart(5)} ns/row  ` +
    `${((ms * 1e6) / eEdges).toFixed(0).padStart(5)} ns/edge-visit  (${String(eEdges)} E edges)`,
);
