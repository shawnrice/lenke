/**
 * **PROFILE THE INDEXED WORKLOAD — THE ONE A REAL APPLICATION RUNS (item 2316).**
 *
 * Three targets dissolved this session the moment an index was added (items 2301, 2315), and the serving
 * bench's worst TS rows were all unindexed scans (item 2301). **Every profile I have taken was therefore of
 * a configuration the guide tells callers not to use.** This one has the index in place.
 *
 * One process, a realistic serving mix, and the fixture built ONCE so the profile is query-dominated:
 * each shape runs `ROUNDS` times with inner iterations, and the build is a single pass.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const USERS = Number(process.env.USERS ?? 50_000);
const ROUNDS = Number(process.env.ROUNDS ?? 400);

const g = new Graph();
const TEAMS = ['core', 'platform', 'data', 'infra'];

for (let i = 0; i < USERS; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: ['User'],
    properties: { name: `user${i}`, team: TEAMS[i % 4], score: i % 100 },
  });
}

let s = 0x5eed | 0;
const rnd = () => {
  s = (Math.imul(s, 1_103_515_245) + 12_345) | 0;

  return (s >>> 1) % 1_000_000_007;
};

for (let i = 0; i < USERS; i += 1) {
  for (let f = 0; f < 3; f += 1) {
    const to = g.getVertexById(`u${(rnd() + f * 7919) % USERS}`);

    if (to) {
      g.addEdge({
        id: `f${i}_${f}`,
        from: g.getVertexById(`u${i}`),
        to,
        labels: ['FOLLOWS'],
        properties: {},
      });
    }
  }
}

/* THE POINT OF THIS PROBE: the index is present, as the guide's first rule requires. */
g.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

let acc = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const n = `user${r % USERS}`;

  acc += query(g, 'MATCH (u:User) WHERE u.name = $n RETURN u.score AS s', { n }).length;
  acc += query(g, 'MATCH (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*) AS c', { n })[0]
    .c;
  acc += query(
    g,
    'MATCH (u:User)-[:FOLLOWS]->()-[:FOLLOWS]->(y) WHERE u.name = $n RETURN count(*) AS c',
    { n },
  )[0].c;
  acc += query(g, 'MATCH (u:User) WHERE u.name = $n SET u.score = $v RETURN count(*) AS c', {
    n,
    v: r % 100,
  })[0].c;
  acc += query(g, 'MATCH (u:User) WHERE u.name = $n RETURN u AS u', { n }).length;
}

console.log(`  USERS=${USERS} ROUNDS=${ROUNDS} acc=${acc}`);
