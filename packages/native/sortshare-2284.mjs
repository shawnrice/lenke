/**
 * **HOW MUCH OF THE `ORDER BY + LIMIT` ROW IS THE SORT AT ALL? (item 2284)** Both spellings came out
 * FLAT across a 600x range of `cap`, which looks like the top-K heap not engaging. But flatness has a
 * second explanation that costs nothing to rule out: **if PROJECTING the rows dominates, the sort is a small
 * term and no top-K can help**, because every arm still projects every row before any selection.
 *
 * The decomposition, each arm doing strictly more than the last:
 *
 *   count       closed form, no projection, no sort       — the scan's floor
 *   project     project all rows, no ORDER BY, no LIMIT   — adds projection
 *   ordered     project all rows, ORDER BY, no LIMIT      — adds the full sort
 *   topk        project, ORDER BY, LIMIT 100              — what a heap could serve
 *
 * `project` must NOT carry a LIMIT: `take` short-circuits, so `LIMIT 100` without an ORDER BY stops
 * after 100 rows and would measure a 600x smaller scan — an unfair floor of exactly the kind item 2262 had
 * to correct three times.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = 60_000;
const ROUNDS = Number(process.env.ROUNDS ?? 11);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `p${i}`,
    labels: ['Person'],
    properties: { name: `n${String(i).padStart(7, '0')}`, seniority: i % 7 },
  });
}

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const ARMS = [
  ['count   (scan floor)', 'MATCH (p:Person) RETURN count(*) AS c'],
  ['project (all rows)', 'MATCH (p:Person) RETURN p.name AS n'],
  ['ordered (full sort)', 'MATCH (p:Person) RETURN p.name AS n ORDER BY n'],
  ['topk    (LIMIT 100)', 'MATCH (p:Person) RETURN p.name AS n ORDER BY n LIMIT 100'],
];

/* Warm every arm before timing any of them. */
for (const [, text] of ARMS) {
  for (let w = 0; w < 4; w += 1) {
    query(g, text, {});
  }
}

const out = [];

for (const [label, text] of ARMS) {
  const ts = [];

  for (let r = 0; r < ROUNDS; r += 1) {
    const t = performance.now();

    query(g, text, {});
    ts.push(performance.now() - t);
  }

  out.push([label, med(ts)]);
}

console.log(`  N=${N}, median of ${ROUNDS} (ms)`);

let prev = 0;

for (const [label, ms] of out) {
  console.log(
    `    ${label.padEnd(22)} ${ms.toFixed(2).padStart(7)}   +${(ms - prev).toFixed(2)} over the arm above`,
  );
  prev = ms;
}

const proj = out[1][1] - out[0][1];
const sort = out[2][1] - out[1][1];

console.log(
  `\n    projection term ${proj.toFixed(2)} ms;  sort term ${sort.toFixed(2)} ms;  sort is ${((100 * sort) / out[2][1]).toFixed(0)}% of the ordered row`,
);
console.log(
  `    a PERFECT top-K would remove at most the sort term, taking ${out[3][1].toFixed(2)} -> ~${(out[3][1] - sort).toFixed(2)} ms`,
);
