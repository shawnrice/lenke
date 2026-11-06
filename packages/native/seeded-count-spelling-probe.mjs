/**
 * ONE shape per process (CLAUDE.md's rule): the seeded count in whichever spelling SHAPE names,
 * so neither spelling pollutes the other's dispatch sites. Item 1598.
 *
 *     SHAPE=inline node one-shape-1598.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 20_000);
const SHAPE = process.env.SHAPE ?? 'inline';
const INDEXED = process.env.INDEXED !== '0';

const TEXT = {
  inline: 'MATCH (u:User {team: $v}) RETURN count(*) AS c',
  clause: 'MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c',
  'inline-nolabel': 'MATCH (u {team: $v}) RETURN count(*) AS c',
  'clause-nolabel': 'MATCH (u) WHERE u.team = $v RETURN count(*) AS c',
}[SHAPE];

if (TEXT === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, score: i % 100, team: `t${i % 50}` },
  });
}

if (INDEXED) {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['team'] });
}

for (let i = 0; i < 500; i += 1) {
  query(g, TEXT, { v: `t${i % 50}` });
}

const t0 = performance.now();

for (let i = 0; i < REPS; i += 1) {
  query(g, TEXT, { v: `t${i % 50}` });
}

const ns = ((performance.now() - t0) * 1e6) / REPS;

console.log(`${SHAPE}${INDEXED ? '' : ', unindexed'}  ${ns.toFixed(0)} ns/op  (${TEXT})`);
