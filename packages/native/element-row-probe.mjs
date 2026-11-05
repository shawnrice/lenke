/**
 * DOES MATERIALIZING AN EDGE AS A ROW VALUE COST MORE THAN A VERTEX?
 *
 * Item 1520 noticed `query: project the edge + materialize` at 627.9 ms for 1,000,000 rows (628 ns a
 * row) against `project the element + materialize` at 26.6 ms for 200,000 (133 ns a row) and flagged
 * the 4.7x as UNEXPLAINED rather than as a defect. This probe explains it.
 *
 * ⚠️ THOSE TWO ROWS ARE NOT COMPARABLE PER ELEMENT, which is the first thing to establish and the
 * reason the 4.7x is not itself a finding:
 *
 *     project the element   MATCH (n:Person) RETURN n              — a LABEL BUCKET scan, 200k rows
 *     project the edge      MATCH (:Person)-[r:KNOWS]->() RETURN r — a 1-HOP WALK, 1M rows
 *
 * So the difference mixes the element TYPE with the walk that produced it. Dividing one by the other
 * prices neither — the error item 1480 made ("that floor rides the values walk and does LESS work").
 *
 * The experiment holds the WALK constant and varies only what lands in the row:
 *
 *     edge    MATCH (:P)-[r:E]->()  RETURN r   — same walk, same row count, EDGE in the row
 *     farnode MATCH (:P)-[:E]->(x)  RETURN x   — same walk, same row count, VERTEX in the row
 *     relprop MATCH (:P)-[r:E]->()  RETURN r.w — same walk, a SCALAR in the row (the floor)
 *     bucket  MATCH (n:P) RETURN n              — the label-bucket scan, for scale only
 *
 * `edge` against `farnode` is the answer: equal means the element type costs nothing and item 1520's
 * 4.7x was entirely the walk; unequal is an edge-specific cost worth pricing.
 *
 *     ARM=edge node element-row-probe.mjs        # one arm per process (item 762)
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 11);
const DROP = Number(process.env.DROP ?? 3);
const ONLY = process.env.ARM;

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90, name: `n${i}` } });
}

// ⚠️ The repeat index is in the `to` expression — item 1518's rule. Without it all FANOUT edges of a
// vertex land on one target and the walk never branches.
for (let k = 0; k < NODES * FANOUT; k += 1) {
  graph.addEdge({
    id: `e${k}`,
    labels: ['E'],
    from: graph.getVertexById(`v${(k * 7919) % NODES}`),
    to: graph.getVertexById(
      `v${((k % NODES) * 104_729 + Math.floor(k / NODES) * 2_654_435_761) % NODES}`,
    ),
    properties: { w: k % 7 },
  });
}

const ARMS = {
  edge: 'MATCH (:P)-[r:E]->() RETURN r',
  farnode: 'MATCH (:P)-[:E]->(x) RETURN x',
  relprop: 'MATCH (:P)-[r:E]->() RETURN r.w AS w',
  bucket: 'MATCH (n:P) RETURN n',
  // ⚠️ THE `star` HAZARD, measured rather than reasoned about (item 1522). If `RETURN *` took the
  // same rel-bound walk, skipping the anonymous far binding could change its OUTPUT — `mapToRow`
  // copies EVERY binding with no NUL filter. A cost far above `edge` says star is on the general
  // path instead and the hazard cannot arise.
  star: 'MATCH (:P)-[r:E]->() RETURN *',
  starnamed: 'MATCH (p:P)-[r:E]->(x) RETURN *',
};

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

const names = ONLY === undefined ? Object.keys(ARMS) : [ONLY];

for (const name of names) {
  const text = ARMS[name];

  if (text === undefined) {
    throw new Error(`unknown ARM ${name}; have ${Object.keys(ARMS).join(',')}`);
  }

  // Warm the parse cache (admitted on the SECOND sighting) and record the row count, so an arm that
  // silently returns nothing cannot read as fast.
  let rows = 0;

  for (let w = 0; w < 3; w += 1) {
    rows = query(graph, text).length;
  }

  const times = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    query(graph, text);
    times.push(performance.now() - t0);
  }

  // ⚠️ The window covers only the selected ARM's rep loop, so a profile cannot mix arms.
  if (process.env.PROF_OUT !== undefined && ONLY !== undefined) {
    // eslint-disable-next-line no-await-in-loop
    await profileWindow(process.env.PROF_OUT, () => {
      for (let i = 0; i < Number(process.env.PROF_ITERS ?? 12); i += 1) {
        query(graph, text);
      }

      return 0;
    });
  }

  const ms = med(times.slice(DROP));

  console.log(
    JSON.stringify({
      arm: name,
      rows,
      ms: Number(ms.toFixed(1)),
      nsPerRow: Number(((ms * 1e6) / rows).toFixed(1)),
      series: times.map((x) => Number(x.toFixed(0))),
    }),
  );
}
