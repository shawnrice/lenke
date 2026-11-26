/**
 * **WHICH SHAPE OWNS THE 42%? (item 2283)** The mixed profile nominated `degreeOfTypes` at 42.24% self
 * time — but that frame is **already-refuted ground** for some shapes (items 1065 and 1546 refuted a
 * single-type fast path, 2171 closed the `out().values().count()` row, 2243 closed `count hop + far has`)
 * and **OPEN** for another (item 2128 priced the FILTERED two-hop count at 20x and did not build it).
 *
 * So the nomination means nothing until the time is attributed to a shape. Same workload, one graph, each
 * shape timed on its own.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, has, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const N = 60_000;
const ROUNDS = Number(process.env.ROUNDS ?? 9);

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
const gremHop2 = traversal(V(), hasLabel('Person'), out('WORKS_WITH'), out('WORKS_WITH'), count());

const SHAPES = [
  [
    'gql label+prop count',
    () => query(g, 'MATCH (p:Person) WHERE p.team = $t RETURN count(*) AS c', { t: 'core' })[0].c,
  ],
  [
    'gql 1-hop typed count',
    () => query(g, 'MATCH (p:Person)-[:WORKS_WITH]->(q:Person) RETURN count(*) AS c', {})[0].c,
  ],
  [
    'gql 1-hop + far filter',
    () =>
      query(
        g,
        'MATCH (p:Person)-[:WORKS_WITH]->(q:Person) WHERE q.team = $t RETURN count(*) AS c',
        { t: 'core' },
      )[0].c,
  ],
  [
    'gql scan + LIMIT 500',
    () =>
      query(g, 'MATCH (p:Person) WHERE p.seniority >= $s RETURN p.name AS name LIMIT 500', { s: 5 })
        .length,
  ],
  [
    'gql grouped count',
    () => query(g, 'MATCH (p:Person) RETURN p.team AS t, count(*) AS c', {}).length,
  ],
  [
    'gql ORDER BY + LIMIT',
    () =>
      query(g, 'MATCH (p:Person) WHERE p.active = true RETURN p.name AS n ORDER BY n LIMIT 200', {})
        .length,
  ],
  ['grem label+prop count', () => Number(toArray(gremCount, g)[0])],
  ['grem 1-hop values count', () => Number(toArray(gremHop, g)[0])],
  ['grem 2-hop count', () => Number(toArray(gremHop2, g)[0])],
];

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
let acc = 0;

console.log(`  N=${N}, 3 edges/vertex, median of ${ROUNDS}`);
console.log(`    shape                      median ms`);

for (const [label, fn] of SHAPES) {
  const ts = [];

  for (let r = 0; r < ROUNDS; r += 1) {
    const t = performance.now();

    acc += fn();
    ts.push(performance.now() - t);
  }

  console.log(`    ${label.padEnd(26)} ${med(ts).toFixed(2).padStart(9)}`);
}

console.log(`  acc=${acc}`);
