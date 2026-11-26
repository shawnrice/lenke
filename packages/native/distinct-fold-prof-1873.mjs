/**
 * WHERE DOES `count(DISTINCT)` OVER A CHAIN SPEND ITS TIME? (item 1873)
 *
 * Item 1872's census nominated this: `MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(DISTINCT c.k)`
 * is the rung with the **thinnest margin over the general matcher of all 50** (0.34x, i.e. only 3x
 * ahead where its siblings are 10-300x) and one of the higher absolute costs (8.63 ms). A thin
 * margin is where item 1870's decay becomes possible, and a high absolute is where a win would be
 * worth having — this shape is both.
 *
 * THE CONTROLS ARE ITS OWN SIBLINGS, chosen so each isolates one part of the question:
 *
 *   - `count(*)` over the same chain  — the walk WITHOUT any distinct keying.
 *   - `count(DISTINCT c)` (the ELEMENT, not a property) — the same keying over a different value
 *     space, which says whether the cost is the key or the property read.
 *   - `RETURN DISTINCT c.k` — the same distinct set, emitted as rows rather than counted, which is
 *     a different rung (`distinctProjection`) and so prices the set-building alone.
 *   - the THREE-hop twin, whose margin is 0.21x — if the two differ by more than their row counts,
 *     the width matters.
 *
 * One shape per process is NOT used here deliberately: every row goes through the SAME rung family
 * and no arm is being compared across builds, so this is an attribution within one workload rather
 * than an A/B. Nothing below is a ratio between arms.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20_000);
const KEYS = Number(process.env.KEYS ?? 97);
const REPS = Number(process.env.REPS ?? 9);

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

const SHAPES = {
  'hop2 count(DISTINCT c.k)   TARGET':
    'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(DISTINCT c.k) AS c',
  'hop2 count(*)              no keying':
    'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(*) AS c',
  'hop2 count(DISTINCT c)     element key':
    'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN count(DISTINCT c) AS c',
  'hop2 RETURN DISTINCT c.k   rows, other rung':
    'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L) RETURN DISTINCT c.k AS k',
  'hop3 count(DISTINCT d.k)   wider twin':
    'MATCH (a:L)-[:R]->(b:L)-[:R]->(c:L)-[:R]->(d:L) RETURN count(DISTINCT d.k) AS c',
  'hop1 count(DISTINCT b.k)   narrower twin':
    'MATCH (a:L)-[:R]->(b:L) RETURN count(DISTINCT b.k) AS c',
};

console.log(
  `${N} vertices / ${N} edges, ${KEYS} distinct keys, median of ${REPS} after 2 warm-ups`,
);
console.log('');
console.log('shape                                       ms      rows/answer');
console.log('----------------------------------------------------------------');

for (const [name, text] of Object.entries(SHAPES)) {
  const s = [];
  let answer = '';

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();
    const got = query(g, text);
    const ms = performance.now() - t0;

    if (r >= 2) {
      s.push(ms);
    }

    answer = got.length === 1 ? String(got[0].c ?? got[0].k) : `${String(got.length)} rows`;
  }

  s.sort((a, b) => a - b);

  console.log(`${name.padEnd(44)} ${s[s.length >> 1].toFixed(2).padStart(7)}   ${answer}`);
}
