/*
 * Item 2103 — is the 330x a FAST RUNG that is SLOWER than falling through to the generic matcher?
 *
 * 🔑 `matching.ts`'s `orient` already exists and does exactly the right thing — "pick which end of a
 * fixed-length path to seed from: the side with the smaller estimated seed" — and its own comment cites
 * THIS authz shape as its documented case. It has ONE caller, on `matchPattern`'s general branch.
 *
 * ⚠️ So if the row-returning query were reaching `matchPattern`, it would be oriented. The hypothesis:
 * it is taken by a fast RUNG that walks from the written start and never orients — a rung whose route
 * is WORSE than declining. [[rung-precedence-decides-speed]], and the 1.37-1.72x regression
 * [[vary-only-the-projection]] records for a helper that cannot decline.
 *
 * 🔑 THE TEST: make every rung decline WITHOUT changing the question, then compare. A trailing vacuous
 * `LIMIT` is the lever items 2079/2087 both used for exactly this — it defeats a length-gated rung and
 * cannot change the answer when it exceeds the row count.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 200000);
const TEAMS = 400;
const DOCS = 2000;
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

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

const BASE =
  'MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d RETURN u.name AS n';

const shapes = {
  'rows, as written (a rung takes it)': BASE,
  /*
   * ⚠️ `LIMIT 100000` CANNOT CHANGE THE ANSWER — the answer is 451 rows — but it puts a step after the
   * projection, which length-gated rungs refuse. If this is FASTER, the rung is losing to the generic
   * matcher and `orient` is the reason.
   */
  'rows + vacuous LIMIT (rungs decline)': `${BASE} LIMIT 100000`,
  'rows written from the DOC (item 2101)':
    'MATCH (d:Doc)<-[:CAN_VIEW]-(:Team)<-[:MEMBER_OF]-(u:User) WHERE d.name = $d RETURN u.name AS n',
};

const timeIt = (q) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, { d: 'd1' });
    series.push(performance.now() - t0);
  }

  const kept = series.slice(4).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], n: rows.length };
};

console.log(`  USERS=${USERS}, indexed, median of ${REPS}, doc d1\n`);

const counts = new Set();

for (const [name, q] of Object.entries(shapes)) {
  const r = timeIt(q);

  counts.add(r.n);
  console.log(`  ${name.padEnd(40)} ${r.ms.toFixed(2).padStart(8)} ms   ${r.n} rows`);
}

// ⚠️ All three must answer the SAME number of rows, or the comparison is of different questions.
if (counts.size !== 1) {
  throw new Error(`row counts differ across spellings: ${[...counts].join(', ')}`);
}
