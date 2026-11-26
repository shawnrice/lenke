/*
 * Item 2123 — the grouped OPTIONAL-hop count rung, A/B.
 *
 * **HALF THE ANCHORS HAVE NO OUT-EDGE, AND THAT IS LOAD-BEARING.** The rung's whole difference from
 * the plain grouped count is `max(1, degree)`, so a fixture where every vertex has edges makes the two
 * arithmetics agree — my first measurement fixture gave every vertex degree 3 and the numbers matched
 * while proving nothing.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 9);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } });
}

let e = 0;

for (let d = 0; d < 3; d += 1) {
  for (let i = 0; i < N; i += 2) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

const shapes = {
  target: 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c',
  filtered:
    'MATCH (a:P) WHERE a.n > 10 OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c',
  /* ITEM 2124's TARGET — the far-keyed arm, which item 2123's gate refused at 361 ms. */
  farkey: 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN b.k AS g, count(*) AS c',
  farkey_filtered:
    'MATCH (a:P) WHERE a.n > 10 OPTIONAL MATCH (a)-[:E]->(b) RETURN b.k AS g, count(*) AS c',
  /* CONTROLS the gate cannot reach. */
  plain_ctl: 'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, count(*) AS c',
  optcount_ctl: 'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN count(*) AS c',
  edgekey_ctl: 'MATCH (a:P) OPTIONAL MATCH (a)-[r:E]->(b) RETURN r.k AS g, count(*) AS c',
};
const out = [];

for (const [name, q] of Object.entries(shapes)) {
  const series = [];
  let first = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = query(g, q, {});

    series.push(performance.now() - t0);
    first = JSON.stringify(rows[0]?.c ?? null);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  out.push(`${name}=${kept[Math.floor(kept.length / 2)].toFixed(1)}(c=${first})`);
}

console.log(`  ${out.join(' ')}`);
