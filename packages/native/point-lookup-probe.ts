/**
 * The hot INDEXED point lookup, in isolation — the row `bench:usage` cannot resolve.
 *
 * Built at item 915 to answer "did this window's GQL executor changes regress it?". `bench:usage`
 * read 885k-1.04M ops/s where earlier runs had recorded up to 1.29M, which looks like a regression
 * until you notice that bench swings **1.17x on this row and 1.26x on `100 updates`** between
 * consecutive runs of the SAME build. Its highest recorded figures are labelled "best recorded" —
 * i.e. outliers — and treating them as a baseline is how a noisy bench manufactures a regression.
 *
 * MEASURED here instead, three ORDER-ALTERNATED rounds, pre = item 902 (before 903's `pathProps`,
 * 909's scope change and 911's export):
 *
 *     pre    1842019 / 1839484 / 1842823 ops/s   (spread 1.002x)
 *     post   1943773 / 1774637 / 1808282         (spread 1.095x)
 *
 * No regression: post's BEST exceeds pre's best and its median is within 2%. 903 added one
 * `pred.pathProps !== undefined` check to `matchesPredicate`, which is on this path, and it does
 * not show.
 *
 * NOTE THE ABSOLUTE GAP TO THE BENCH: this probe reads ~1.8M ops/s where `bench:usage` reads
 * ~0.9-1.0M for the same operation. The difference is that bench's own per-operation harness, so
 * its numbers are comparable to ITSELF and are not an engine figure.
 *
 * One shape per process, a warm graph, the warm-up dropped and the median taken.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 20_000);
const OPS = Number(process.env.A_OPS ?? 200_000);
const REPS = 14;
const DROP = 3;

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `n${i}`, score: i % 100, active: true },
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

const Q = 'MATCH (u:User) WHERE u.name = $n RETURN u.score AS s';
const series: number[] = [];
let sink = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < OPS; i += 1) {
    sink += [...query(g, Q, { n: `n${i % N}` })].length;
  }

  series.push(performance.now() - t0);
}

// One row per lookup, accumulated across every rep — so the expected total is OPS * REPS, not
// OPS. Asserted because a point lookup that silently matched nothing would read as very fast.
if (sink !== OPS * REPS) {
  throw new Error(`got ${sink} rows, expected ${OPS * REPS} — the fixture or query is wrong`);
}

const p = series.slice(DROP).sort((a, b) => a - b);
const ms = p[Math.floor(p.length / 2)];

console.log(
  `RESULT ${((OPS / ms) * 1000).toFixed(0)} ops/s  (${((ms * 1000) / OPS).toFixed(3)} us/op)  rows=${sink}`,
);
