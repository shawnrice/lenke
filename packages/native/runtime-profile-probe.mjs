/**
 * Find UNPRICED hot code in the TS engine, mechanically. Paired with `runtime-profile-analyze.mjs`,
 * which does the cross-check against `CLOSED.md` and the audit.
 *
 * Item 919's lesson was that a targeted timer can only confirm a site you already suspect, and a
 * CPU profile found in one run what four hand-placed timers had missed. That profile covered the
 * COMPILE path; this one covers the RUNTIME path.
 *
 * ONE SHAPE PER PROCESS (item 762): the shape comes from argv, so no other query shape pollutes
 * the dispatch sites of the one being measured.
 *
 *     node --cpu-prof --cpu-prof-dir=<dir> --cpu-prof-name=<shape>.cpuprofile \
 *          runtime-profile-probe.mjs <shape> <n>
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const SHAPE = process.argv[2] ?? 'hopfilter';
const N = Number(process.argv[3] ?? 2000);
const NODES = 20000;

/** One fixture for every shape, so a difference between shapes is the shape and not the data. */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3) % NODES}`),
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }

  return g;
};

const SHAPES = {
  // The row CLOSED.md records at 32x native.
  hopfilter: 'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5 RETURN count(*) AS c',
  // A projection with ORDER BY + LIMIT, the serving shape.
  sortedpage: 'MATCH (n:P) WHERE n.k < 50 RETURN n.s AS s ORDER BY s LIMIT 10',
  // A grouped aggregate.
  grouped: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
  // A point lookup, the hot serving read.
  point: 'MATCH (n:P) WHERE n.n = 12345 RETURN n.s AS s',
  // The control: no pattern at all, so none of the match/expand machinery runs.
  control: 'RETURN 1 AS one',
};

const q = SHAPES[SHAPE];

if (q === undefined) {
  throw new Error(`unknown shape ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

const g = build();
let sink = 0;
const t0 = performance.now();

for (let i = 0; i < N; i += 1) {
  sink += query(g, q).length;
}

const ms = performance.now() - t0;

// Asserted, not printed and ignored: a shape that silently returned nothing would profile the
// error path and look like a result.
if (sink === 0) {
  throw new Error(`${SHAPE} produced NO rows across ${N} runs — the profile would be of nothing`);
}

console.log(JSON.stringify({ shape: SHAPE, n: N, ms: Number(ms.toFixed(1)), sink }));
