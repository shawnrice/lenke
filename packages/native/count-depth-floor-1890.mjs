/**
 * WHY DOES A TWO-HOP COUNT COST 7x A THREE-HOP COUNT AT SCALE? (item 1890)
 *
 * ⚠️ THE SCALE SWEEP FOUND IT, which is item 1889's lesson applied to the other surface.
 * `rung-gap-screen.mjs` at `NODES=200000` flags `count: depth2 (42.0 ms) costs 7.3x depth3 (5.7)`
 * — a SHORTER chain costing more, which is the signature that grid was built for (item 1822). At
 * the screens' usual 20,000 vertices the same two cells read 1.1 and 0.5 ms, so the inversion is
 * there but 40x smaller in absolute terms and easy to read as timer noise.
 *
 * ⚠️ AND THE GRID TIMES EVERY CELL IN ONE PROCESS, so its numbers carry cross-row inline-cache
 * pollution (item 1871 retracted a flag for exactly that). This file is ONE SHAPE PER PROCESS, and
 * it reports the cold reps as well, because item 1889 found a lever whose whole risk lived in rep 1.
 *
 *     for d in 1 2 3 4 5; do DEPTH=$d bun count-depth-floor-1890.mjs; done
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const DEPTH = Number(process.env.DEPTH ?? 2);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'count';

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${String(i)}`, labels: ['P'], properties: { k: i % 997 } });
}

// ⚠️ FANOUT 1 AND A COPRIME STRIDE, the grid's own fixture: with one out-edge per vertex every
// depth returns exactly N rows, so a cost difference across depth is about the ROUTE and not about
// how many rows came back (item 1815's finding). The stride still makes the endpoints a permutation
// rather than the single collapsed target CLAUDE.md warns about.
for (let i = 0; i < NODES; i += 1) {
  g.addEdge({
    id: `e${String(i)}`,
    from: g.getVertexById(`v${String(i)}`),
    to: g.getVertexById(`v${String((i * 7 + 3) % NODES)}`),
    labels: ['E'],
  });
}

const chain = (d) => {
  let text = 'MATCH (a0:P)';

  for (let i = 1; i <= d; i += 1) {
    text += `-[:E]->(a${String(i)}:P)`;
  }

  return { text, far: `a${String(d)}` };
};

const { text, far } = chain(DEPTH);
const SHAPES = {
  count: `${text} RETURN count(*) AS c`,
  // The `rows` twin, so the count can be read against what producing the rows costs.
  rows: `${text} RETURN ${far}.k AS k`,
  // A count of the FAR end's distinct values — a different rung, for contrast.
  countdist: `${text} RETURN count(DISTINCT ${far}.k) AS c`,
};

const q = SHAPES[SHAPE];
const series = [];
const cold = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();

  rows = query(g, q).length;

  const ms = performance.now() - t0;

  if (r >= 2) {
    series.push(ms);
  } else {
    cold.push(ms);
  }
}

series.sort((a, b) => a - b);

console.log(
  `${SHAPE.padEnd(10)} depth ${String(DEPTH)}  ${series[series.length >> 1].toFixed(2).padStart(8)} ms  ` +
    `${String(rows).padStart(7)} rows   cold ${cold.map((x) => x.toFixed(0)).join('/')}`,
);
