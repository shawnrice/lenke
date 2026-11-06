/**
 * Does GQL's filtered node count SEEK, and what does it pay afterwards? (item 1597)
 *
 * Item 1596's pricing left GQL losing to Gremlin on the 400-hit seeded count — 14.5 us against
 * 948 ns. The obvious story is "the count shortcut does not use the index", which `buildNodeCount`
 * invites: it is O(1) only when UNCONSTRAINED and otherwise tallies.
 *
 * ⚠️ THAT STORY IS WRONG, and this probe is what rules it out. Item 149's own tell for a lost index
 * is two identical `bench:usage` columns, so the test is the same query with and without the index.
 * It seeks: 10.78x at 400 hits and 142.78x at one. What it pays is AFTER the seek — a profile puts
 * ~75% in predicate evaluation per candidate and ~9% in `evalLabelExpr`, while `countEquals` (the
 * seek itself) is 1%.
 *
 * The cause is that `indexCandidates` yields `{ count, build }` with no flag saying whether the seek
 * is EXACT, so every candidate is re-validated — correct for a seed HINT lifted from an AND-chain,
 * unnecessary for a lone `k = v`. Gremlin's `index-seed.ts` draws that distinction and calls it
 * `removable`.
 *
 *     node gql-seek-revalidation-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 20_000);

const make = (indexed) => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `u${i}`,
      labels: ['User'],
      properties: { name: `user${i}`, score: i % 100, team: `t${i % 50}` },
    });
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['team'] });
  }

  return g;
};

const nsPerOp = (g, text, paramsOf) => {
  for (let i = 0; i < 500; i += 1) {
    query(g, text, paramsOf(i));
  }

  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    query(g, text, paramsOf(i));
  }

  return ((performance.now() - t0) * 1e6) / REPS;
};

const SHAPES = [
  {
    name: 'count, 400 hits',
    text: 'MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c',
    paramsOf: (i) => ({ v: `t${i % 50}` }),
  },
  {
    name: 'count, 1 hit',
    text: 'MATCH (u:User) WHERE u.name = $v RETURN count(*) AS c',
    paramsOf: (i) => ({ v: `user${i % NODES}` }),
  },
  {
    name: 'values, 400 hits',
    text: 'MATCH (u:User) WHERE u.team = $v RETURN u.score AS s',
    paramsOf: (i) => ({ v: `t${i % 50}` }),
  },
  {
    // The UNLABELLED twin: no label means no `evalLabelExpr` per candidate, so the gap between
    // this and the labelled row above is what the label test costs.
    name: 'count, 400 hits, no label',
    text: 'MATCH (u) WHERE u.team = $v RETURN count(*) AS c',
    paramsOf: (i) => ({ v: `t${i % 50}` }),
  },
  {
    // The ISO equality spelling of the same question, which reaches the seed by a different route
    // (`node.pred.props` rather than a lifted hint) and so is worth watching separately.
    name: 'count, 400 hits, inline',
    text: 'MATCH (u:User {team: $v}) RETURN count(*) AS c',
    paramsOf: (i) => ({ v: `t${i % 50}` }),
  },
];

const plain = make(false);
const indexed = make(true);

console.log(`${NODES} vertices, ${REPS} ops. ns per operation.\n`);

for (const shape of SHAPES) {
  const a = JSON.stringify(query(plain, shape.text, shape.paramsOf(1)));
  const b = JSON.stringify(query(indexed, shape.text, shape.paramsOf(1)));
  const u = nsPerOp(plain, shape.text, shape.paramsOf);
  const s = nsPerOp(indexed, shape.text, shape.paramsOf);

  // ⚠️ An index may change the cost and must NEVER change the count — item 149's contract — so a
  // ratio near 1 is the tell for a LOST index, and a disagreement is a far worse bug than either.
  const verdict = a === b ? 'answers agree' : `⚠ DIFFER ${a} vs ${b}`;
  const lost = u / s < 1.2 ? '   <-- INDEX NOT USED' : '';

  console.log(
    `${shape.name.padEnd(26)} unindexed ${u.toFixed(0).padStart(7)}  indexed ${s.toFixed(0).padStart(6)}  ${(u / s).toFixed(2)}x  ${verdict}${lost}`,
  );
}
