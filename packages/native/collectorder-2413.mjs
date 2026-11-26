/**
 * DOES `collect`'s ELEMENT ORDER EQUAL THE `rows` ORDER AT EACH WIDTH? The question that decides
 * item 2413's design.
 *
 * At ONE hop the two already DISAGREE - `collect` takes `hopAggregate` and the row form takes
 * `hopProjection`, two routes and two orders - which is item 2404's owner ruling ("an
 * aggregate-built LIST's element order is UNSPECIFIED") showing up in the engine as it stands.
 *
 * WHY IT MATTERS FOR THE BUILD: `canonValue` compares every array POSITIONALLY, so the differential
 * fuzzer compares `collect`'s element order ACROSS ENGINES, and the workload's `aggregate` family
 * generates a 2-hop `collect(c.n)`. CLOSED.md names the consequence: "a future `collect` reordering"
 * needs a harness change first. So a rung that emits a DIFFERENT order would break that fuzzer, and
 * a rung that emits the SAME order needs no ruling, no harness change and no order question at all.
 *
 * Item 1831 proved the chain rung's ROW order identical to the general matcher's across 25 cases, so
 * collecting in the rung's own row order should land on the general path's list exactly. This probe
 * checks the premise that argument rests on, per width.
 *
 *     node collectorder-2413.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 40);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 7 } });
}

for (let i = 0; i < NODES; i += 1) {
  for (const step of [1, 2]) {
    g.addEdge({
      id: `e${i}-${step}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i + step) % NODES}`),
      labels: ['E'],
      properties: {},
    });
  }
}

const WIDTHS = [
  ['1 hop', '(a:P)-[:E]->(b:P)', 'b'],
  ['2 hops', '(a:P)-[:E]->(b:P)-[:E]->(c:P)', 'c'],
  ['3 hops', '(a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P)', 'd'],
];

const cmp = (a, b) => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

const sorted = (xs) => [...xs].sort(cmp);

for (const [name, pattern, far] of WIDTHS) {
  // eslint-disable-next-line lenke/no-raw-interpolation -- WIDTHS holds this file's own literals
  const rows = query(g, `MATCH ${pattern} RETURN ${far}.n AS x`, {}).map((r) => r.x);
  // eslint-disable-next-line lenke/no-raw-interpolation -- same literals as the line above.
  const coll = query(g, `MATCH ${pattern} RETURN collect(${far}.n) AS x`, {})[0].x;
  const order = JSON.stringify(rows) === JSON.stringify(coll);
  const multiset = JSON.stringify(sorted(rows)) === JSON.stringify(sorted(coll));

  console.log(
    `${name.padEnd(7)} len ${String(rows.length).padStart(6)}/${String(coll.length).padEnd(6)}  ` +
      `ORDER ${order ? 'SAME     ' : 'DIFFERENT'}  MULTISET ${multiset ? 'same' : 'DIFFERENT'}`,
  );

  if (!order) {
    console.log(`         rows    ${JSON.stringify(rows).slice(0, 86)}`);
    console.log(`         collect ${JSON.stringify(coll).slice(0, 86)}`);
  }
}
