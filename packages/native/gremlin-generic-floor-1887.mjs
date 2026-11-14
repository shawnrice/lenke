/**
 * WHICH OF THE REMAINING GENERIC GREMLIN SHAPES IS WORTH TAKING? (item 1887)
 *
 * ⚠️ FLOOR BEFORE PRICING — item 1878's lesson, which cost a whole item to a 4.7x that turned out to
 * be 2 microseconds. Items 1883 and 1884 left four shapes that `gremlin-route-screen.mjs` still
 * reads as `generic`, and a route difference is not automatically a cost one (item 1854):
 *
 *     edgef: outE has inV count       4 applyStep calls
 *     edgef: outE has count           3
 *     edgef: outE has values          3   (the EDGE's own property, not the far vertex's)
 *     opt:   optional two hops     4002   (the per-traverser sub-plan dispatch item 1480 priced)
 *
 * Each is measured beside the FUSED twin that bounds it, so the question is "how much is on the
 * table" rather than "is this shape slow". ONE SHAPE PER PROCESS (items 1870/1874), `SERIES=1`
 * prints the per-rep series (item 1884: a 9-rep window measured warm-up as the steady state on a
 * pipeline shape, and the series is what showed it).
 *
 *     for s in ecount ecount_fused einvcount evalues evalues_fused opt2 opt1; do \
 *       SHAPE=$s bun gremlin-generic-floor-1887.mjs; done
 */
import { Graph } from '@lenke/core';
import {
  V,
  count,
  gt,
  has,
  inV,
  optional,
  out,
  outE,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

const N = Number(process.env.N ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 20);
const SHAPE = process.env.SHAPE ?? 'ecount';

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const W_POOL = [1, 2, 3, 4, 5, 7, 9];

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: N_POOL[i % N_POOL.length] },
  });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${String(e)}`,
    // The repeat index is in the expression — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy.
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
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

const SHAPES = {
  // The three edge-filter terminals item 1883 left generic, each beside its fused twin.
  ecount: () => traversal(V(), outE('E'), has('w', gt(3)), count()),
  ecount_fused: () => traversal(V(), outE('E'), count()),
  einvcount: () => traversal(V(), outE('E'), has('w', gt(3)), inV(), count()),
  evalues: () => traversal(V(), outE('E'), has('w', gt(3)), values('w')),
  evalues_fused: () => traversal(V(), outE('E'), values('w')),
  // The multi-step `optional` sub-plan, beside the single-step one item 1884 fused.
  opt2: () => traversal(V(), optional(traversal(out('E'), out('E'))), values('n')),
  opt1: () => traversal(V(), optional(traversal(out('E'))), values('n')),
};

const plan = SHAPES[SHAPE]();
const series = [];
let rows = 0;

for (let r = 0; r < REPS + 3; r += 1) {
  const t0 = performance.now();
  const got = toArray(plan, g);

  rows = Array.isArray(got) ? got.length : 1;

  const ms = performance.now() - t0;

  if (r >= 3) {
    series.push(ms);
  }
}

if (process.env.SERIES === '1') {
  console.log(`# ${SHAPE} series: ${series.map((x) => x.toFixed(1)).join(' ')}`);
}

const sorted = [...series].sort((a, b) => a - b);
const ms = sorted[sorted.length >> 1];

console.log(
  `${SHAPE.padEnd(14)} ${ms.toFixed(2).padStart(8)} ms  ${String(rows).padStart(7)} rows`,
);
