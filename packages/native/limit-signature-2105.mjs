/*
 * Item 2105 — does item 2104's defect shape exist in the SIBLING row rungs?
 *
 * 🔑 THE SIGNATURE IS CHEAP AND DECISIVE: a vacuous `LIMIT` cannot change an answer smaller than the
 * limit, but it DOES defeat a length-gated rung and let the plan fall through to the orienting matcher.
 * **If "as written" is slower than "as written + LIMIT", that rung is losing to declining** — which is
 * exactly what item 2103 found for `hop2Projection` (59x) and 2104 fixed (82x).
 *
 * ⚠️ ROW PROJECTIONS, NOT `count(*)`. Item 2102's by-depth probe held the projection at `count(*)` and
 * reported "the gap needs three hops" — a confound, because the count path has the seek and the row
 * paths did not. Every shape here RETURNS ROWS.
 *
 * ⚠️ EVERY PAIR IS ASSERTED TO THE SAME ROW COUNT. A `LIMIT` lower than the answer would change it, and
 * the pair would then be two different questions rather than one spelling difference.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  /*
   * ⚠️ `tag` IS SELECTIVE (1 in 2,000) AND `:P` IS UNIFORM. A selective far predicate is what makes a
   * seek worth having; a uniform label keeps `orient`'s bucket-size arm out of the comparison, so the
   * only thing that can move a row is the SEEK — which is what item 2104's gate requires.
   */
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97, tag: `t${i % 2000}` } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`),
    labels: ['E'],
    properties: {},
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['tag'] });

const shapes = {
  '1 hop  rows': 'MATCH (a:P)-[:E]->(b:P) WHERE b.tag = $t RETURN a.n AS n',
  '2 hops rows (fixed at 2104)':
    'MATCH (a:P)-[:E]->(m:P)-[:E]->(b:P) WHERE b.tag = $t RETURN a.n AS n',
  '3 hops rows':
    'MATCH (a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P) WHERE b.tag = $t RETURN a.n AS n',
  '1 hop  DISTINCT': 'MATCH (a:P)-[:E]->(b:P) WHERE b.tag = $t RETURN DISTINCT a.n AS n',
  '3 hops DISTINCT':
    'MATCH (a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P) WHERE b.tag = $t RETURN DISTINCT a.n AS n',
};

const timeIt = (q) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, { t: 't7' });
    series.push(performance.now() - t0);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], n: rows.length };
};

console.log(`  NODES=${NODES} FANOUT=${FANOUT}, tag 1/2000, indexed, median of ${REPS}\n`);
console.log(
  `  ${'shape'.padEnd(28)} ${'as written'.padStart(11)} ${'+ LIMIT'.padStart(9)} ${'ratio'.padStart(7)}  rows`,
);

for (const [name, q] of Object.entries(shapes)) {
  const bare = timeIt(q);
  const limited = timeIt(`${q} LIMIT 1000000`);

  if (bare.n !== limited.n) {
    throw new Error(
      `${name}: the LIMIT changed the answer (${bare.n} vs ${limited.n}) — not one question`,
    );
  }

  const ratio = bare.ms / limited.ms;
  const flag = ratio > 1.5 ? '  ⚠️ LOSES TO DECLINING' : '';

  console.log(
    `  ${name.padEnd(28)} ${bare.ms.toFixed(2).padStart(11)} ${limited.ms.toFixed(2).padStart(9)} ${ratio.toFixed(2).padStart(6)}x  ${bare.n}${flag}`,
  );
}
