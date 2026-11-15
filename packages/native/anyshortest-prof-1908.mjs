// Item 1908 — `ANY SHORTEST` is the GQL surface's largest ADDRESSABLE shape once items 1902-1907
// cleared the sort and seeded-var-length rows: 2318 ms for 2,099,864 rows at 200,000 vertices,
// against the one-hop projection's 33 ns a row.
//
// ⚠️ ITS FLOOR IS NOT A PLAIN HOP, which is the first thing to establish rather than assume: the
// shape runs a shortest-path search per seed, so the honest comparison is against the SAME walk
// without the selector (`{1,3}` reachability, which `reachShortcut` serves) and against the
// unseeded form. Both are carried here.
//
//     SHAPE=anyshortest|reach|allshortest|hop REPS=40 bun --cpu-prof anyshortest-prof-1908.mjs
//
// ⚠️ PROFILE AT A HIGH `REPS` OR THE PROFILE IS THE FIXTURE — item 1900's lesson: at REPS=3 the top
// frames were all `addEdge`/`indexEdgeLabel`, i.e. building a 1,000,000-edge graph.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200000);
const FANOUT = 5;
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? 'anyshortest';

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: N_POOL[i % N_POOL.length] } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX — CLAUDE.md's fix for the `(a*k+b) % N` functional-graph trap.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: [1, 2, 3, 4, 5, 7, 9][e % 7] },
  });
}

const QUERIES = {
  anyshortest: 'MATCH ANY SHORTEST (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p0 RETURN b.n AS x',
  allshortest: 'MATCH ALL SHORTEST (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p0 RETURN b.n AS x',
  // ⚠️ THE FLOOR: the same seeded walk with NO selector, which `reachShortcut` serves. It answers a
  // DIFFERENT question (distinct reachable values, not one row per pair) so it is a floor rather
  // than a control — the row counts differ by three orders of magnitude and that is the point.
  reach: 'MATCH (a:T)-[:E]->{1,3}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.n AS x',
  // The plain hop, for the per-row figure every other shape is read against.
  hop: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x',
};

const text = QUERIES[SHAPE];
const ser = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();

  rows = query(g, text, { p0: 3 }).length;

  const ms = performance.now() - t0;

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);

const med = ser[ser.length >> 1];

console.log(
  SHAPE.padEnd(12),
  med.toFixed(2).padStart(9),
  'ms',
  String(rows).padStart(8),
  'rows',
  rows === 0 ? '' : `${((med * 1e6) / rows).toFixed(0)} ns/row`,
);
