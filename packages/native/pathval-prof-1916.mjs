// Item 1916 — `RETURN edges(p)` and `RETURN edges(p)[0]` are the GQL surface's largest OPEN shapes:
// item 1901's coverage sweep measured **738.46 and 741.10 ms for 500,000 rows** at 200,000 vertices
// / 1,000,000 edges, against the one-hop projection control's 26.22 for 800,000.
//
// ⚠️ THE ONE-HOP CONTROL IS THE WRONG FLOOR AND THAT IS THE POINT OF THIS PROBE. A `{1,2}`
// var-length match over a seeded start does far more work than a one-hop projection whatever it
// returns, and `edges(p)` returns a LIST of edge objects per row where the control returns a
// scalar. Comparing them prices "var-length matching + building path values" against "a one-hop
// scalar" and calls the difference the path value. Item 1878's lesson, which cost an item to a 4.7x
// that turned out to be 2 microseconds.
//
// 🔑 SO THE FLOOR CARRIED HERE IS THE SAME MATCH RETURNING A SCALAR — identical pattern, identical
// seed, identical row count, with no path value anywhere. The difference between `scalar` and
// `edges` is then the path machinery and nothing else. `bound` adds the path VARIABLE without
// reading it, which splits "binding a path" from "materializing its edges".
//
//     SHAPE=edges|idx0|scalar|bound|nodes|len|hop bun --cpu-prof pathval-prof-1916.mjs
//
// ⚠️ ONE SHAPE PER PROCESS, and profile at a high REPS or the profile is the fixture build
// (item 1900's lesson, hit again at item 1915).
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);
const SHAPE = process.env.SHAPE ?? 'edges';

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    properties: { n: N_POOL[i % N_POOL.length], k: i % 50 },
  });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    // Splits on the REPEAT INDEX — CLAUDE.md's functional-graph fix.
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: e % 7 },
  });
}

const PAT = 'MATCH p = (a:T)-[:E]->{1,2}(b:T) WHERE a.n = $p0';

const SHAPES = {
  // THE TARGETS, as item 1901 measured them.
  edges: `${PAT} RETURN edges(p) AS x`,
  idx0: `${PAT} RETURN edges(p)[0] AS x`,
  // THE FLOOR: the same match, the same rows, a scalar instead of a path value.
  scalar: `${PAT} RETURN b.n AS x`,
  // The path VARIABLE bound but never read — "binding a path" minus "materializing its edges".
  bound: `${PAT} RETURN b.n AS x`,
  // The other two path accessors, to tell a general path cost from an `edges`-specific one.
  nodes: `${PAT} RETURN nodes(p) AS x`,
  len: `${PAT} RETURN path_length(p) AS x`,
  // CONTROL the change cannot reach: no path, no var-length.
  hop: 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x',
};

/**
 * ⚠️ THE ARMS ADDED AFTER THE FIRST RUN, because the floor turned out to be the story: `scalar` is
 * 548.74 ms of the `edges` arm's 772.59, so 71% of what item 1901 recorded as a path-value cost is
 * the VAR-LENGTH MATCH. These split that floor further.
 */
const EXTRA = {
  // The spelling item 1906 took (9.25x) returns DISTINCT; this probe's floor does not. If DISTINCT
  // is cheaper than not deduping, the non-DISTINCT form is reaching a different route.
  distinct: 'MATCH (a:T)-[:E]->{1,2}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.n AS x',
  // The inline seed, which item 1906 established reaches `reachShortcut` where the clause form did
  // not. Same question, same rows.
  inline: 'MATCH (a:T {n: $p0})-[:E]->{1,2}(b:T) RETURN b.n AS x',
  inlinedist: 'MATCH (a:T {n: $p0})-[:E]->{1,2}(b:T) RETURN DISTINCT b.n AS x',
  // Fixed bounds, to see whether the cost tracks the QUANTIFIER or the row count.
  one: 'MATCH (a:T)-[:E]->{1,1}(b:T) WHERE a.n = $p0 RETURN b.n AS x',
  two: 'MATCH (a:T)-[:E]->{2,2}(b:T) WHERE a.n = $p0 RETURN b.n AS x',
  // The unquantified two-hop spelling of the SAME {2,2} question, written out.
  twohop: 'MATCH (a:T)-[:E]->(m:T)-[:E]->(b:T) WHERE a.n = $p0 RETURN b.n AS x',
  // And the unquantified ONE hop, seeded the same way: the per-row floor with a seed.
  onehop: 'MATCH (a:T)-[:E]->(b:T) WHERE a.n = $p0 RETURN b.n AS x',
};

// `bound` is the same TEXT as `scalar` but without the `p =` binding removed, so build it apart:
// the point is to keep `p =` while returning a scalar, which `scalar` must NOT have.
const TEXT =
  SHAPE === 'scalar'
    ? 'MATCH (a:T)-[:E]->{1,2}(b:T) WHERE a.n = $p0 RETURN b.n AS x'
    : (EXTRA[SHAPE] ?? SHAPES[SHAPE]);

const params = SHAPE === 'hop' ? {} : { p0: 3 };
const ser = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();
  const out = query(g, TEXT, params);
  const ms = performance.now() - t0;

  rows = out.length;

  if (r >= 2) {
    ser.push(ms);
  }
}

ser.sort((a, b) => a - b);

console.log(
  `${SHAPE.padEnd(7)} N=${N} reps=${REPS}  median ${ser[ser.length >> 1].toFixed(2)} ms  ` +
    `min ${ser[0].toFixed(2)}  rows ${rows}`,
);
console.log(`  text   ${TEXT}`);
console.log(`  series ${ser.map((x) => x.toFixed(1)).join(' ')}`);
