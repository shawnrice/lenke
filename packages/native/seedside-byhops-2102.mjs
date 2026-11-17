/*
 * Item 2102 — is item 2101's 71.5x seed-side gap GENERAL, or specific to a three-segment chain?
 *
 * 🔑 THE QUESTION MATTERS MORE THAN THE NUMBER. `MATCH (a)-[:E]->(b) WHERE b.k = $x` — one hop, the
 * selective predicate on the FAR node — is one of the most common shapes there is. If it scans too,
 * item 2101 is a general planner finding rather than a long-chain curiosity, and the guidance ("write
 * from the selective end") applies to almost every query rather than to share dialogs.
 *
 * ⚠️ ONLY THE HOP COUNT VARIES. Same fixture, same index, same predicate on the far node, same answer
 * asserted between the two spellings at every depth — so a difference between depths is the depth and
 * not the shape. [[vary-only-the-projection]]'s discipline, applied to the pattern length.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 11);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  /*
   * ⚠️ `tag` IS HIGHLY SELECTIVE (one vertex in 2,000) because that is what makes a seed worth having.
   * A predicate matching a tenth of the graph would be answered as well by a scan, and the probe would
   * report "no gap" for a reason that has nothing to do with seeding.
   */
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { n: i % 97, tag: `t${i % 2000}` },
  });
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

/** Forward: written from the unconstrained end. Reverse: written from the predicate's end. */
const pairs = {
  '1 hop': [
    'MATCH (a:P)-[:E]->(b:P) WHERE b.tag = $t RETURN count(*) AS c',
    'MATCH (b:P)<-[:E]-(a:P) WHERE b.tag = $t RETURN count(*) AS c',
  ],
  '2 hops': [
    'MATCH (a:P)-[:E]->(m:P)-[:E]->(b:P) WHERE b.tag = $t RETURN count(*) AS c',
    'MATCH (b:P)<-[:E]-(m:P)<-[:E]-(a:P) WHERE b.tag = $t RETURN count(*) AS c',
  ],
  '3 hops': [
    'MATCH (a:P)-[:E]->(m:P)-[:E]->(m2:P)-[:E]->(b:P) WHERE b.tag = $t RETURN count(*) AS c',
    'MATCH (b:P)<-[:E]-(m2:P)<-[:E]-(m:P)<-[:E]-(a:P) WHERE b.tag = $t RETURN count(*) AS c',
  ],
};

const medianOf = (series) => {
  const kept = series.slice(4).sort((a, b) => a - b);

  return kept[Math.floor(kept.length / 2)];
};

const timeIt = (q) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, { t: 't7' });
    series.push(performance.now() - t0);
  }

  return { ms: medianOf(series), answer: JSON.stringify(rows) };
};

console.log(
  `  NODES=${NODES} FANOUT=${FANOUT}, tag selectivity 1/2000, indexed, median of ${REPS}\n`,
);
console.log(
  `  ${'depth'.padEnd(7)} ${'from the FREE end'.padStart(18)} ${'from the PREDICATE'.padStart(19)} ${'ratio'.padStart(7)}  answer`,
);

for (const [depth, [fwd, rev]] of Object.entries(pairs)) {
  const a = timeIt(fwd);
  const b = timeIt(rev);

  // ⚠️ The two spellings must be ONE question, or the ratio means nothing.
  if (a.answer !== b.answer) {
    throw new Error(`${depth}: the spellings disagree — ${a.answer} vs ${b.answer}`);
  }

  console.log(
    `  ${depth.padEnd(7)} ${a.ms.toFixed(2).padStart(18)} ${b.ms.toFixed(2).padStart(19)} ${(a.ms / b.ms).toFixed(2).padStart(6)}x  ${a.answer}`,
  );
}
