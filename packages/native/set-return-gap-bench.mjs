/**
 * DOES A `SET` STATEMENT COST MORE WITHOUT A TRAILING `RETURN` THAN WITH ONE? (item 1842)
 *
 * ⚠️ THIS BENCH EXISTS BECAUSE THE MULTI-ARM VERSION OF IT WAS WRONG, AND ITS OWN SWEEP CAUGHT
 * IT. Run as one process with the arms in sequence, it reported `SET` without a `RETURN` at
 * 8.77 us against 4.13 us with one — a 2.1x penalty for doing LESS work, which is the loud
 * route-gap signature this repo hunts. Sweeping the size then showed the ratio at 1.00x for
 * SEED=2000 and SEED=20000, and 5.84x only at SEED=200 — the arm that happened to run FIRST in
 * the process. The same arm measured 9.62 us first and 1.35 us later: the whole effect was the
 * JIT tiering up, not the route. CLAUDE.md's one-shape-per-process rule (item 762), arrived at
 * the hard way for the third time this session.
 *
 * ⚠️ SO: ONE ARM PER PROCESS, and the comparison is between PROCESSES. Each child runs exactly
 * one query text against one fixture size and prints one JSON line. Nothing in a child ever
 * sees a second shape, so no dispatch site is polymorphic in one arm and monomorphic in another.
 *
 * ⚠️ THE SEEK IS INDEXED ON PURPOSE. Without an index `WHERE n.n = $n` is a scan over SEED
 * vertices and the statement is all seek and no write — item 1842 measured 50.15 us unindexed
 * against 5.54 us indexed for the same SET, so an unindexed fixture would bury the question.
 *
 *     bun set-return-gap-bench.mjs
 *     SEEDS=200,2000 REPS=11 bun set-return-gap-bench.mjs
 */
import { execFileSync } from 'node:child_process';

const SEEDS = (process.env.SEEDS ?? '200,2000,20000').split(',').map(Number);
const REPS = Number(process.env.REPS ?? 9);
const BATCH = Number(process.env.BATCH ?? 2000);

const ARMS = {
  'SET no RETURN': 'MATCH (n:P) WHERE n.n = $n SET n.k = $k',
  'SET + RETURN': 'MATCH (n:P) WHERE n.n = $n SET n.k = $k RETURN n.k',
};

const child = (text, seed) => {
  const src = `
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const SEED = ${seed};
const BATCH = ${BATCH};
const build = () => {
  const g = new Graph();
  for (let i = 0; i < SEED; i += 1) {
    g.addVertex({ id: 'v' + i, labels: ['P'], properties: { n: i, k: i % 97 } });
  }
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });
  return g;
};
const Q = ${JSON.stringify(text)};
const series = [];
for (let r = 0; r < ${REPS}; r += 1) {
  const g = build();
  const t0 = performance.now();
  for (let i = 0; i < BATCH; i += 1) { query(g, Q, { n: i % SEED, k: i % 97 }); }
  series.push(((performance.now() - t0) * 1000) / BATCH);
}
// ⚠️ DROP THE FIRST THREE REPS, then take the MEDIAN of the rest — the TS path's early reps are
// visibly the JIT tiering up, and \`min\` over a plateau-with-a-rare-fast-rep estimates the two
// arms differently (the rule in CLAUDE.md's "before trusting a number").
const kept = series.slice(3).sort((a, b) => a - b);
const m = kept.length >> 1;
const median = kept.length % 2 === 1 ? kept[m] : (kept[m - 1] + kept[m]) / 2;
process.stdout.write(JSON.stringify({ median, series }));
`;

  return JSON.parse(
    execFileSync('bun', ['--input-type=module', '-e', src], {
      cwd: '/home/shawn/projects/pl-graph/packages/native',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
};

console.log(`# set-return-gap-bench — ONE ARM PER PROCESS, reps=${REPS} batch=${BATCH}`);
console.log('# the question: does omitting a trailing RETURN make a SET statement slower?\n');

for (const seed of SEEDS) {
  const a = child(ARMS['SET no RETURN'], seed);
  const b = child(ARMS['SET + RETURN'], seed);

  console.log(
    `SEED=${String(seed).padStart(5)}  no RETURN ${a.median.toFixed(2).padStart(6)} us   ` +
      `+ RETURN ${b.median.toFixed(2).padStart(6)} us   ratio ${(a.median / b.median).toFixed(2)}x`,
  );
  console.log(`   no RETURN series ${a.series.map((x) => x.toFixed(2)).join(' ')}`);
  console.log(`   + RETURN series ${b.series.map((x) => x.toFixed(2)).join(' ')}`);
}
