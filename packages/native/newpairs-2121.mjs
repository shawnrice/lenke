/*
 * Item 2121 — the two precedence pairs the extended census exposed.
 *
 * 🔑 Adding twelve shapes took the census from 22/36 rungs reached to 34/36 and surfaced two pairs nobody
 * had priced: `chainFoldLevels > chainFoldedAggregate` and `chainGroupedLevels > hop2GroupedCount`.
 * ⚠️ A starved rung is a CANDIDATE — item 2118 priced the sibling pair and found the starvation correct
 * by 37x, so these get the same treatment rather than an assumption either way.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 9);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: `k${i % 97}`, n: i % 97 } });
}

let e = 0;

for (let d = 0; d < 3; d += 1) {
  for (let i = 0; i < N; i += 1) {
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
  chain3_foldedagg:
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN count(DISTINCT d.k) AS c',
  hop2_groupedstart: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN a.k AS k, count(*) AS c',
  /* ⚠️ CONTROLS the killed gates cannot reach. */
  hop2_count_ctl: 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN count(*) AS c',
  node_proj_ctl: 'MATCH (n:P) RETURN n.k AS k',
};
const out = [];

for (const [name, q] of Object.entries(shapes)) {
  const series = [];
  let answer = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = query(g, q, {});

    series.push(performance.now() - t0);
    answer = String(rows.length);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  out.push(`${name}=${kept[Math.floor(kept.length / 2)].toFixed(1)}(${answer})`);
}

console.log(`  ${out.join(' ')}`);
