// Item 1951 — the profile behind item 1949's 5.02x: WHICH FRAME owns the MIXED arm's gap?
//
// Item 1949 priced `MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x` at 368.7 ms against a
// 73.4 ms hand edge pass once one isolated off-label vertex makes `T` non-vacuous, with the
// homogeneous arm already at 1.19x of its own ceiling. So the whole gap appears when NON-VACUITY
// turns something on, and this profile names it before anything is built.
//
// 🔑 TWO CANDIDATES, AND THEY WANT DIFFERENT FIXES. A non-vacuous `T` turns on BOTH:
//   (a) the per-edge `matchesLabel(far, fl)` in the general closure's inner loop — a far-vertex
//       deref this file's own comments price at ~180 ns in edge order, and
//   (b) `candidateVertexSource(graph, startLabel)` switching from every vertex to the label bucket.
// If (a) dominates, an edge pass helps because it visits far vertices in EDGE-INSERTION order
// instead of per-start adjacency order. If (b) dominates, an edge pass is the wrong lever entirely.
//
// A read is idempotent, so one graph serves every round and the fixture stays OUT of the profile —
// item 1933's rule.
//
//     bun --cpu-prof --cpu-prof-dir=<dir> filterprof-1951.mjs
//     MODE=homogeneous bun --cpu-prof ... filterprof-1951.mjs   # the CONTROL
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const MODE = process.env.MODE ?? 'mixed';

/*
 * SHAPE picks the subject or one of two CONTROLS. Both controls are shapes this item's gate cannot
 * reach, which is what makes them controls rather than second subjects:
 *
 *   target   the filtered hop whose route the item changes
 *   nofilter the SAME hop unfiltered — item 1940's arm, a different route entirely
 *   selstart the filtered hop with a SELECTIVE start label, where the new gate DECLINES on coverage
 */
const SHAPE = process.env.SHAPE ?? 'target';
const QUERIES = {
  target: 'MATCH (a:T)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x',
  nofilter: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x',
  selstart: 'MATCH (a:S)-[:E]->(b:T) FILTER b.n > $p0 RETURN b.n AS x',
};
const Q = QUERIES[SHAPE] ?? QUERIES.target;
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  // `S` on one vertex in 20 gives the `selstart` control a start label at coverage 0.05, far below
  // the gate's threshold, so that shape must route exactly as it did before this item.
  const labels = i % 20 === 0 ? ['T', 'S'] : ['T'];

  g.addVertex({ id: String(i + 1), labels, properties: { n: i % 12 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // Split on the REPEAT INDEX, not on `e` alone — the generator trap CLAUDE.md records.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

if (MODE === 'mixed') {
  // ONE isolated off-label vertex: no edges, so every answer is unchanged and only `vertexCount`
  // and the `T` bucket's size move. That is the whole difference between the two arms.
  g.addVertex({ id: 'off', labels: ['Z'], properties: { n: 0 } });
}

let rows = 0;
const t0 = performance.now();

for (let r = 0; r < ROUNDS; r += 1) {
  rows = query(g, Q, { p0: 5 }).length;
}

const ms = performance.now() - t0;

console.log(
  `${SHAPE}\t${MODE}\t${String(ROUNDS)} rounds\t${(ms / ROUNDS).toFixed(1)} ms/round\t` +
    `${((ms * 1e6) / (ROUNDS * rows)).toFixed(1)} ns/row\t${String(rows)} rows`,
);
