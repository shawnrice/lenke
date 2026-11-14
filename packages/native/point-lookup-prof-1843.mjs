/**
 * THE INDEXED POINT LOOKUP — the commonest OLTP shape there is (item 1843).
 *
 * `MATCH (n:P) WHERE n.n = $n RETURN n.k` against a hash index measured ~1.9-2.4 us for ONE
 * row, against ~0.1 us for the direct `getVertexById`. That ratio is what this profile is for.
 *
 * ⚠️ 800,000 QUERIES, AND ITEM 1843'S FIRST PROFILE IS WHY. At 80,000 the process spent 22% of
 * its samples in `toUpperCase` called from `(module)` — the lexer's keyword table, built once at
 * import. Module init is ~17 ms (core 5.7, gql 7.7, gremlin 3.4), so a profile whose query loop
 * runs for 160 ms is one third startup and reads as though a string builtin were hot on the
 * seek path. At this count the loop runs ~1.6 s and startup is ~1%.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const SEED = Number(process.env.SEED ?? 2000);
const BATCH = Number(process.env.BATCH ?? 2000);
const REPS = Number(process.env.REPS ?? 400);

const g = new Graph();

for (let i = 0; i < SEED; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i, k: i % 97 } });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });

const Q = 'MATCH (n:P) WHERE n.n = $n RETURN n.k';

let rows = 0;
const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  for (let i = 0; i < BATCH; i += 1) {
    rows += query(g, Q, { n: i % SEED }).length;
  }
}

const ms = performance.now() - t0;

if (rows !== REPS * BATCH) {
  throw new Error(`got ${rows} rows, expected ${REPS * BATCH} — not comparable`);
}

console.log(
  `${((ms * 1000) / rows).toFixed(2)} us/query over ${rows} queries (${ms.toFixed(0)} ms)`,
);
