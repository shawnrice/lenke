/** Which START-filter form costs 18x per row on a 1-hop projection? (item 2309) */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 50_000);
const FAN = Number(process.env.FAN ?? 5);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const SHAPE = process.env.SHAPE ?? 'plain';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['Person'],
    properties: { age: i % 90, name: `person${i}` },
  });
}

/* The bench's repeat-index split (item 1633), so a vertex's FAN out-edges do not collapse to one target. */
for (let k = 0; k < N * FAN; k += 1) {
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`v${(k * 7919) % N}`),
    to: g.getVertexById(`v${to}`),
    labels: ['KNOWS'],
    properties: {},
  });
}

const QUERIES = {
  plain: 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n',
  startCmp: 'MATCH (a:Person)-[:KNOWS]->(x) WHERE a.age > 60 RETURN x.name AS n',
  startEq: 'MATCH (a:Person)-[:KNOWS]->(x) WHERE a.age = 60 RETURN x.name AS n',
  startInline: 'MATCH (a:Person {age: 60})-[:KNOWS]->(x) RETURN x.name AS n',
  farCmp: 'MATCH (a:Person)-[:KNOWS]->(x) WHERE x.age > 60 RETURN x.name AS n',
  startTrue: 'MATCH (a:Person)-[:KNOWS]->(x) WHERE true RETURN x.name AS n',
  /*
   * **THE NARROWER FOLD'S CASE (item 2310).** Item 2287 built a vacuous-`WHERE` fold and reverted it
   * because a BARE `WHERE true` is a load-bearing route ORACLE in this repo's tests. The obvious escape
   * is to fold `true` out of an AND and leave the bare form alone — oracle kept, query builders helped.
   * These two arms test whether that is worth anything: if `true AND cond` costs the same as `cond`, the
   * narrower fold has no route to recover and the trade-off is irreducible.
   */
  cmpOnly: 'MATCH (a:Person)-[:KNOWS]->(x) WHERE a.age > 60 RETURN x.name AS n',
  trueAndCmp: 'MATCH (a:Person)-[:KNOWS]->(x) WHERE true AND a.age > 60 RETURN x.name AS n',
};

const text = QUERIES[SHAPE];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (let w = 0; w < 3; w += 1) {
  query(g, text, {});
}

const ts = [];
let rows = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const t = performance.now();

  rows = query(g, text, {}).length;
  ts.push(performance.now() - t);
}

const ms = med(ts);

console.log(
  `  SHAPE=${SHAPE.padEnd(11)} ${ms.toFixed(1).padStart(7)} ms   rows=${String(rows).padStart(7)}   ${((ms * 1e6) / Math.max(rows, 1)).toFixed(0).padStart(5)} ns/row`,
);
