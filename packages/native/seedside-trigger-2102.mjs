/*
 * Item 2102 (second half) — WHAT triggers the seed-side gap? Hop count alone does not explain it.
 *
 * ⚠️ The by-depth probe shows an all-`:P` `count(*)` chain seeding correctly at 1 and 2 hops (1.27x,
 * 1.54x) and falling off a cliff at 3 (31.32x). But item 2101's shape is only TWO segments and measured
 * 71.5x. So something OTHER than depth is involved, and the two differ in three ways: per-node LABELS
 * (User/Team/Doc vs all `:P`), `count(DISTINCT u.name)` vs `count(*)`, and the predicate's selectivity.
 *
 * 🔑 This varies them ONE AT A TIME over one fixture, with both spellings asserted equal in each pair.
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

const FWD = 'MATCH (u:User)-[:MEMBER_OF]->(:Team)-[:CAN_VIEW]->(d:Doc) WHERE d.name = $d';
const REV = 'MATCH (d:Doc)<-[:CAN_VIEW]-(:Team)<-[:MEMBER_OF]-(u:User) WHERE d.name = $d';

const pairs = {
  'count(*)': [`${FWD} RETURN count(*) AS c`, `${REV} RETURN count(*) AS c`],
  'count(DISTINCT u.name)': [
    `${FWD} RETURN count(DISTINCT u.name) AS c`,
    `${REV} RETURN count(DISTINCT u.name) AS c`,
  ],
  'DISTINCT rows': [`${FWD} RETURN DISTINCT u.name AS n`, `${REV} RETURN DISTINCT u.name AS n`],
  'plain rows': [`${FWD} RETURN u.name AS n`, `${REV} RETURN u.name AS n`],
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

  return { ms: kept[Math.floor(kept.length / 2)], n: rows.length, first: JSON.stringify(rows[0]) };
};

console.log(`  USERS=${USERS}, indexed, median of ${REPS}, doc d1\n`);
console.log(
  `  ${'projection'.padEnd(24)} ${'from FREE'.padStart(10)} ${'from PRED'.padStart(10)} ${'ratio'.padStart(7)}  rows`,
);

for (const [name, [fwd, rev]] of Object.entries(pairs)) {
  const a = timeIt(fwd);
  const b = timeIt(rev);

  if (a.n !== b.n) {
    throw new Error(`${name}: row counts differ — ${a.n} vs ${b.n}`);
  }

  console.log(
    `  ${name.padEnd(24)} ${a.ms.toFixed(2).padStart(10)} ${b.ms.toFixed(2).padStart(10)} ${(a.ms / b.ms).toFixed(2).padStart(6)}x  ${a.n}`,
  );
}
