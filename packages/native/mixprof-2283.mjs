/**
 * A realistic MIXED workload over ONE graph, for CPU profiling (item 2283).
 *
 * 🔑 One graph, because items 2281/2282 showed a fresh graph per rep changes what the profile measures.
 * Several query shapes interleaved, because a single-shape profile nominates that shape's frames and a real
 * application sends a mix. Both surfaces, because the loop optimizes GQL and Gremlin.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, has, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const N = 60_000;
const ROUNDS = Number(process.env.ROUNDS ?? 12);

const g = new Graph();
const TEAMS = ['core', 'platform', 'data', 'infra'];

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `p${i}`,
    labels: ['Person'],
    properties: { name: `n${i}`, team: TEAMS[i % 4], seniority: i % 7, active: i % 3 !== 0 },
  });
}

let s = 0x5eed | 0;
const rnd = () => {
  s = (Math.imul(s, 1_103_515_245) + 12_345) | 0;

  return (s >>> 1) % 1_000_000_007;
};

for (let i = 0; i < N; i += 1) {
  for (let f = 0; f < 3; f += 1) {
    const to = g.getVertexById(`p${(rnd() + f * 7919) % N}`);

    if (to) {
      g.addEdge({
        id: `e${i}_${f}`,
        from: g.getVertexById(`p${i}`),
        to,
        labels: ['WORKS_WITH'],
        properties: {},
      });
    }
  }
}

const gremCount = traversal(V(), hasLabel('Person'), has('team', 'core'), count());
const gremHop = traversal(V(), hasLabel('Person'), out('WORKS_WITH'), values('name'), count());

let acc = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  acc += query(g, 'MATCH (p:Person) WHERE p.team = $t RETURN count(*) AS c', { t: 'core' })[0].c;
  acc += query(g, 'MATCH (p:Person)-[:WORKS_WITH]->(q:Person) RETURN count(*) AS c', {})[0].c;
  acc += query(g, 'MATCH (p:Person) WHERE p.seniority >= $s RETURN p.name AS name LIMIT 500', {
    s: 5,
  }).length;
  acc += query(g, 'MATCH (p:Person) RETURN p.team AS t, count(*) AS c', {}).length;
  acc += query(
    g,
    'MATCH (p:Person) WHERE p.active = true RETURN p.name AS n ORDER BY n LIMIT 200',
    {},
  ).length;
  acc += Number(toArray(gremCount, g)[0]);
  acc += Number(toArray(gremHop, g)[0]);
}

console.log(`  rounds=${ROUNDS} acc=${acc}`);
