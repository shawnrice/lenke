/**
 * What is the FLOOR for GQL's seeded projection, and how much of the gap is reachable? (item 1600)
 *
 * Item 1598 gave the seeded COUNT a specialized predicate and left the seeded PROJECTION on the
 * general matcher. The measured per-row costs now diverge sharply — 30 ns a row for the count
 * against 65 for the projection — and a profile of the projection puts ~41% in the label test and
 * ~26% in `satisfies`/`inlineHolds`/`propOf`, i.e. the per-candidate machinery item 1598's
 * specializer does not reach.
 *
 * ⚠️ A FLOOR IS THE RIGHT INSTRUMENT BEFORE BUILDING A SHORTCUT, and memory's
 * `gremlin-ts-unmeasured` is why: a floor per shape RETRACTED two of three targets there, because
 * the big ratio turned out to be data layout rather than overhead. So this measures the minimum any
 * implementation must do for the same answer — walk the seeded candidates, test the label, read one
 * property, build one row object each — against what the engine charges.
 *
 * The floor's bucket is a plain `Map<value, Vertex[]>` built once. That is not how the engine stores
 * its index, and it does not need to be: the floor is a LOWER BOUND on the work, so a hand-built
 * bucket that is at least as fast as a real one keeps it a lower bound.
 *
 *     node gql-seeded-projection-floor.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 6_000);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % 100, team: `t${i % 50}` },
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['team'] });

// The hand-built bucket the floor seeks in.
const byTeam = new Map();

for (const v of g.vertices) {
  const k = v.properties.team;

  (byTeam.get(k) ?? byTeam.set(k, []).get(k)).push(v);
}

const paramOf = (i) => ({ v: `t${i % 50}` });

const ARMS = [
  {
    name: 'engine   clause  RETURN u.score',
    run: (i) => query(g, 'MATCH (u:User) WHERE u.team = $v RETURN u.score AS s', paramOf(i)),
  },
  {
    name: 'engine   inline  RETURN u.score',
    run: (i) => query(g, 'MATCH (u:User {team: $v}) RETURN u.score AS s', paramOf(i)),
  },
  {
    name: 'engine   clause  RETURN count(*)',
    // The sibling shape item 1598 DID reach, as the control: whatever a seeded projection could
    // cost, it cannot plausibly go below a seeded count over the same candidates.
    run: (i) => query(g, 'MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c', paramOf(i)),
    rows: 1,
  },
  {
    name: 'FLOOR    bucket + label + one row',
    run: (i) => {
      const rows = [];

      for (const v of byTeam.get(`t${i % 50}`)) {
        if (v.labels.has('User')) {
          rows.push({ s: v.properties.score });
        }
      }

      return rows;
    },
  },
  {
    name: 'FLOOR    no row objects (tally only)',
    // Splits the floor in two: how much of it is the walk + label + property read, and how much is
    // allocating one object per row. A shortcut can skip the binding but never the row.
    run: (i) => {
      let n = 0;

      for (const v of byTeam.get(`t${i % 50}`)) {
        if (v.labels.has('User')) {
          n += v.properties.score;
        }
      }

      return n;
    },
  },
];

// Every arm must agree on how many rows it produced, or one is not doing the same work.
const expect = byTeam.get('t1').length;

console.log(`${NODES} vertices, ${expect} rows a query, ${REPS} reps. ns per operation.\n`);

// ⚠️ ONE ARM PER PROCESS when it matters (items 737, 762). Running all five in one process moved
// the clause row from 26111 to 31249 depending on its POSITION, so `ARM=<substring>` selects.
const chosen =
  process.env.ARM === undefined ? ARMS : ARMS.filter((a) => a.name.includes(process.env.ARM));

if (chosen.length === 0) {
  throw new Error(`ARM=${process.env.ARM} matched none of: ${ARMS.map((a) => a.name).join(' | ')}`);
}

for (const arm of chosen) {
  const want = arm.rows ?? expect;
  const probe = arm.run(1);
  const rows = Array.isArray(probe) ? probe.length : want;

  if (rows !== want) {
    throw new Error(`${arm.name} produced ${rows} rows, expected ${want}`);
  }

  for (let i = 0; i < 300; i += 1) {
    arm.run(i);
  }

  const t0 = performance.now();

  for (let i = 0; i < REPS; i += 1) {
    arm.run(i);
  }

  const ns = ((performance.now() - t0) * 1e6) / REPS;

  console.log(
    `${arm.name.padEnd(36)} ${ns.toFixed(0).padStart(7)} ns  ${(ns / expect).toFixed(1)} ns/row`,
  );
}
