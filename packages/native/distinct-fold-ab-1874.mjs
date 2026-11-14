/**
 * `count(DISTINCT x)` OVER A CHAIN — ONE SHAPE PER PROCESS (item 1874).
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE THE NOMINATION IT TESTS WAS MEASURED THE WRONG WAY. Item 1873 read, from
 * a single process that timed six shapes in sequence:
 *
 *     count(DISTINCT c.k)   5.91 ms      RETURN DISTINCT c.k   3.42 ms
 *
 * and concluded the count rung was 1.73x slower than materializing the set it counts. **Re-running
 * the same two shapes in a DIFFERENT order gives `RETURN DISTINCT c.k` at 5.63 and
 * `count(DISTINCT c.k)` at 8.70** — the gap moves with position, because row order pollutes inline
 * caches within a process. Item 1871's census header says this in terms: such a run "cannot support
 * comparing one shape against another within a run". I wrote that and then did it.
 *
 * So the only instrument that can settle whether a change to this rung helps is ONE SHAPE, ONE
 * PROCESS, two builds — which is what this is. `SHAPE` picks the row; nothing else runs.
 *
 *     SHAPE=target bun distinct-fold-ab-1874.mjs     # count(DISTINCT c.k) over two hops
 *     SHAPE=chain  bun distinct-fold-ab-1874.mjs     # the three-hop twin
 *     SHAPE=plain  bun distinct-fold-ab-1874.mjs     # count(c.k), a CONTROL the change cannot reach
 *     SHAPE=rows   bun distinct-fold-ab-1874.mjs     # RETURN DISTINCT c.k, the other rung
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20_000);
const KEYS = Number(process.env.KEYS ?? 97);
const REPS = Number(process.env.REPS ?? 15);
const SHAPE = process.env.SHAPE ?? 'target';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['L'], properties: { k: i % KEYS, n: i % 13 } });
}

for (let i = 0; i < N; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3) % N}`),
    labels: ['R'],
  });
}

const TEXT = {
  target: 'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(DISTINCT c.k) AS c',
  chain: 'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN count(DISTINCT d.k) AS c',
  plain: 'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(c.k) AS c',
  rows: 'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN DISTINCT c.k AS k',
}[SHAPE];

if (TEXT === undefined) {
  throw new Error(`unknown SHAPE=${SHAPE}`);
}

const series = [];
let answer = '';

for (let r = 0; r < REPS + 3; r += 1) {
  const t0 = performance.now();
  const got = query(g, TEXT);
  const ms = performance.now() - t0;

  if (r >= 3) {
    series.push(ms);
  }

  answer = got.length === 1 ? String(got[0].c ?? got[0].k) : `${String(got.length)} rows`;
}

series.sort((a, b) => a - b);

console.log(
  `${SHAPE.padEnd(7)} median ${series[series.length >> 1].toFixed(2)} ms  ` +
    `min ${series[0].toFixed(2)}  max ${series[series.length - 1].toFixed(2)}  answer ${answer}`,
);
