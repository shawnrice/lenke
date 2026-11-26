/*
 * Item 2120 — the multi-column `RETURN DISTINCT` arm, against the one-column path it had to widen.
 *
 * **THE ONE-COLUMN ROW IS THE CONTROL THAT MATTERS.** Item 2119 shipped a one-column fast path at
 * 25.8x; widening `distinctLevel` to N columns puts a per-column loop on that same path, and the
 * one-column spelling is the commoner of the two. A cross-run reading suggested 18.8 -> 25.2 (1.34x
 * WORSE), which is exactly the kind of number that must come from an alternated A/B rather than two runs.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 11);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, k: `k${i % 53}` } });
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
  onecol: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n',
  twocol: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n, c.k AS k',
  threecol: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN DISTINCT c.n AS n, c.k AS k, c.n AS m',
  hop3two: 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN DISTINCT d.n AS n, d.k AS k',
  cnt_ctl: 'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN count(DISTINCT c.n) AS c',
  hop1_ctl: 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.n AS n, b.k AS k',
};
const out = [];

for (const [name, q] of Object.entries(shapes)) {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    query(g, q, {});
    series.push(performance.now() - t0);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  out.push(`${name}=${kept[Math.floor(kept.length / 2)].toFixed(1)}`);
}

console.log(`  ${out.join(' ')}`);
