/**
 * IS THE FLIPPED-OPERAND SPELLING REALLY SLOWER ON A LONG CHAIN? (item 1727)
 *
 * `chain-gate-bench` exists to keep an inline constraint, a clause `WHERE` and a per-position label
 * honest against each other, and its header names the stake: "A spelling that costs more than its
 * twins is the bug class this repo has found four times (item 125)." CLAUDE.md lists this exact pair
 * among the historical defects — `$x = u.k` vs `u.k = $x`, each of which cost 100-300x and returned
 * the correct answer.
 *
 * At its hardcoded 20,000 vertices the table reads inline 1.1 ms, clause 1.6, flipped 2.1 — a 1.91x
 * spread over absolutes where a fixed per-call cost can dominate, and `min of 3` cannot separate the
 * two explanations. This measures the same four spellings at serving size with a real estimator.
 *
 * ⚠️ ONE SPELLING PER PROCESS. The gate bench says so for its own cases ("item 290 recorded a large
 * speedup making its NEIGHBOUR read 0.87x slower purely by warming it"), and item 762's redistribution
 * trap is the same hazard from the other side: four query shapes in one process share the dispatch
 * sites and the first one measured runs monomorphic.
 *
 * ⚠️ THE ANSWER IS PRINTED AND MUST MATCH ACROSS SPELLINGS. Three of the four ask the identical
 * question; the label form asks a different one (it selects a label rather than a property) and has
 * its own count, exactly as in the gate bench.
 *
 *     SPELL=inline NODES=200000 node chain-spelling-probe.mjs
 *     SPELL=flipped node chain-spelling-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const DEG = Number(process.env.DEG ?? 3);
const REPS = Number(process.env.REPS ?? 11);
const DROP = Number(process.env.DROP ?? 3);
const SPELL = process.env.SPELL ?? 'inline';

const QUERIES = {
  inline:
    'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2 {k: 1})-[:E]->(n3)-[:E]->(n4) RETURN count(*) AS c',
  clause:
    'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2)-[:E]->(n3)-[:E]->(n4) WHERE n2.k = 1 RETURN count(*) AS c',
  flipped:
    'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2)-[:E]->(n3)-[:E]->(n4) WHERE 1 = n2.k RETURN count(*) AS c',
  label:
    'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2:H)-[:E]->(n3)-[:E]->(n4) RETURN count(*) AS c',
  free: 'MATCH (a:N)-[:E]->(n0)-[:E]->(n1)-[:E]->(n2)-[:E]->(n3)-[:E]->(n4) RETURN count(*) AS c',
};

const q = QUERIES[SPELL];

if (q === undefined) {
  throw new Error(`unknown SPELL ${SPELL}; have ${Object.keys(QUERIES).join(',')}`);
}

// `k` takes three values and `H` marks the same third of the vertices, so the inline, clause and
// flipped forms select the SAME set and the label form selects a comparable one.
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: i % 3 === 1 ? ['N', 'H'] : ['N'],
    properties: { k: i % 3 },
  });
}

for (let e = 0; e < NODES * DEG; e += 1) {
  const from = e % NODES;

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${from}`),
    to: g.getVertexById(`v${(from * 7919 + Math.floor(e / NODES) * 104_729) % NODES}`),
    labels: ['E'],
  });
}

const series = [];
let answer;

for (let r = 0; r < REPS; r += 1) {
  const t = performance.now();
  const rows = query(g, q);

  series.push(performance.now() - t);
  answer = rows[0]?.c;
}

const kept = series.slice(DROP).sort((a, b) => a - b);

console.log(
  JSON.stringify({
    spell: SPELL,
    nodes: NODES,
    deg: DEG,
    answer,
    median: kept[Math.floor(kept.length / 2)],
    min: Math.min(...series),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
