/*
 * Item 2101 — does the planner seed from a selective predicate on the FAR node?
 *
 * Item 2100 measured `list: subjects for object` at 30.5 ms unindexed and 31.7 INDEXED — the index
 * did not help. That row is `MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name =
 * $d`: the selective predicate is on `d`, the LAST node, while the pattern is written from `u`.
 *
 * THE QUESTION: is the engine scanning all users because the predicate is at the far end? If the
 * SAME question written from `d` is much faster, the planner is not choosing its seed — and this is the
 * "who can see this document" query, i.e. a share dialog, not a synthetic shape.
 *
 * BOTH SPELLINGS MUST RETURN THE SAME ANSWER and it is asserted. Two spellings of one question that
 * disagree would make the comparison meaningless, and a reversed pattern is exactly where a
 * self-inflicted wrong answer would hide.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 200000);
const TEAMS = Number(process.env.TEAMS ?? 400);
const DOCS = Number(process.env.DOCS ?? 2000);
const REPS = Number(process.env.REPS ?? 11);

const g = new Graph();

for (let u = 0; u < USERS; u += 1) {
  g.addVertex({ id: `u${u}`, labels: ['User'], properties: { name: `u${u}` } });
}

for (let t = 0; t < TEAMS; t += 1) {
  g.addVertex({ id: `t${t}`, labels: ['Team'], properties: { name: `t${t}` } });
}

for (let d = 0; d < DOCS; d += 1) {
  g.addVertex({ id: `d${d}`, labels: ['Doc'], properties: { name: `d${d}` } });
}

let e = 0;

for (let u = 0; u < USERS; u += 1) {
  const team = u % 10 === 0 ? 0 : 1 + (u % (TEAMS - 1));

  g.addEdge({
    id: `m${e}`,
    from: g.getVertexById(`u${u}`),
    to: g.getVertexById(`t${team}`),
    labels: ['MEMBER_OF'],
    properties: {},
  });
  e += 1;
}

for (let t = 0; t < TEAMS; t += 1) {
  g.addEdge({
    id: `c${e}`,
    from: g.getVertexById(`t${t}`),
    to: g.getVertexById(`d${t % DOCS}`),
    labels: ['CAN_VIEW'],
    properties: {},
  });
  e += 1;
}

if (process.env.INDEXED !== '0') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });
}

/*
 * `d1` IS CHOSEN DELIBERATELY: team 1 is one of the SMALL teams, so the correct answer is a few
 * hundred users rather than the 20,000 in the skewed team 0. A seeded walk should finish in the time
 * its own answer takes; a full user scan cannot tell the two docs apart.
 */
const shapes = {
  'written from the USER (item 2100 row)':
    'MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d RETURN count(DISTINCT u.name) AS n',
  'written from the DOC, same question':
    'MATCH (d:Doc)<-[:CAN_VIEW]-(:Team)<-[:MEMBER_OF]-(u:User) WHERE d.name = $d RETURN count(DISTINCT u.name) AS n',
};

console.log(
  `  USERS=${USERS} TEAMS=${TEAMS} DOCS=${DOCS}, indexed=${process.env.INDEXED !== '0'}, median of ${REPS}\n`,
);

const answers = new Set();

for (const [name, q] of Object.entries(shapes)) {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, { d: process.env.DOC ?? 'd1' });
    series.push(performance.now() - t0);
  }

  answers.add(JSON.stringify(rows));

  const kept = series.slice(4).sort((a, b) => a - b);

  console.log(
    `  ${name.padEnd(42)} ${kept[Math.floor(kept.length / 2)].toFixed(2).padStart(8)} ms   ${JSON.stringify(rows)}`,
  );
}

if (answers.size !== 1) {
  throw new Error(`the two spellings disagree: ${[...answers].join(' vs ')}`);
}

console.log(`\n  both spellings agree: ${[...answers][0]}`);
