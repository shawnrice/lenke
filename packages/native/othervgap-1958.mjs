// Item 1958 — `V().outE(E).otherV().values(n)` against its twin `V().outE(E).inV().values(n)`.
//
// Item 1921 normalized `otherV` after a DIRECTED edge step into `inV`/`outV`, closing this repo's
// named bug class on this pair: 328.12 -> 48.71 ms against the twin's 47.72, i.e. EQUAL, which is
// the success criterion for a spelling gap. The workload screen carries both rows side by side so
// the gap stays visible.
//
// TODAY THE SCREEN READS 108.55 AGAINST 81.14 — a 1.34x gap, where this session's two earlier
// runs of the same screen read 1.03x and 1.04x. Normalized, the two spellings are the SAME PLAN, and
// the same plan cannot cost two different amounts — so either the normalization stopped firing, or
// the screen's reading is an artifact of running 45 shapes in one process.
//
// ONE SHAPE PER PROCESS IS THE ONLY WAY TO TELL. Item 1956 found this probe family's rows
// interfering through shared dispatch sites, and found one of them BIMODAL across whole processes.
// So: `SHAPE=otherv` or `SHAPE=inv`, one per run, and compare mode by mode.
//
//     SHAPE=otherv bun othervgap-1958.mjs
//     SHAPE=inv    bun othervgap-1958.mjs
import { Graph } from '@lenke/core';
import { inV, otherV, outE, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'otherv';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 12 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // Split on the REPEAT INDEX — the generator trap CLAUDE.md records.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const BUILD = {
  otherv: () => traversal(V(), outE('E'), otherV(), values('n')),
  inv: () => traversal(V(), outE('E'), inV(), values('n')),
};
const build = BUILD[SHAPE] ?? BUILD.otherv;
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ts = [];
let rows = 0;
let sum = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const got = toArray(build(), g);

  ts.push(performance.now() - t0);

  if (r === 0) {
    rows = got.length;

    // An answer guard: the two spellings must agree, or the comparison is of two questions.
    for (const x of got) {
      sum += Number(x);
    }
  }
}

console.log(
  `RESULT\t${SHAPE}\t${med(ts).toFixed(1)}\t${((med(ts) * 1e6) / rows).toFixed(0)}\t${String(rows)}\t${String(sum)}`,
);
