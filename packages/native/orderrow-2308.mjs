/**
 * Is `traverse 1-hop project + order by` a regression, and did MY ships cause it? (item 2308)
 *
 * `bun run bench` reads this row at **826.3 ms** where the audit records 221.2 (after a 5.14x ship),
 * 226.6, and 300.9 — the last with the note *"barely examined (2 mentions, no entry)"*.
 *
 * **AND THE ROW'S OWN COMMENT NAMES THE WALK I JUST CHANGED**: *"Sorting also forces the
 * START-DRIVEN walk, because the far-driven one reorders rows deliberately and tie order under ORDER BY is
 * observable between the engines."* Items 2297/2298 admitted more shapes to the far-driven walk, so ruling
 * my own ships out comes before anything else — via the env switch inside ONE binary (item 2294).
 *
 * The UNORDERED twin is the control the bench itself designates: *"a change admitting the sort must move
 * this row and leave that one alone."*
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const SHAPE = process.env.SHAPE ?? 'ordered';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `p${i}`,
    labels: ['Person'],
    properties: { name: `n${String(i).padStart(7, '0')}` },
  });
}

for (let i = 0; i < N; i += 1) {
  g.addEdge({
    id: `k${i}`,
    from: g.getVertexById(`p${i}`),
    to: g.getVertexById(`p${(i * 7919) % N}`),
    labels: ['KNOWS'],
    properties: {},
  });
}

const QUERIES = {
  ordered: 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n ORDER BY n',
  plain: 'MATCH (a:Person)-[:KNOWS]->(x) RETURN x.name AS n',
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

console.log(
  `  SHAPE=${SHAPE.padEnd(7)} median ${med(ts).toFixed(1).padStart(8)} ms   rows=${rows}`,
);
