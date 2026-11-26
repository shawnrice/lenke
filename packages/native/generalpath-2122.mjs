/*
 * Item 2122 — the SIX shapes the extended census leaves on the general path. Which are costs?
 *
 * Item 2121 took the census to 100 shapes / 34-of-36 rungs. Six shapes reach NO rung at all:
 *
 * ```text
 *     node.limit               MATCH (n:P) RETURN n.k LIMIT 10
 *     hop.limit                MATCH (a:P)-[:E]->(b) RETURN b.k LIMIT 10
 *     hop.group.sum.crossend   MATCH (a:P)-[:E]->(b) RETURN a.k AS g, sum(b.k) AS s
 *     opt.group                MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c
 *     hop2.sum.end             MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN sum(c.k) AS s
 *     varlen.proj              MATCH (a:P)-[:E]->{1,3}(b) RETURN b.k
 * ```
 *
 * **A GENERAL-PATH SHAPE IS NOT A DEFECT** — the census says so itself, and most steps have no
 * shortcut and never will. What makes one a candidate is a FLOOR it misses, so each row below is paired
 * with the cheapest thing that answers the same question.
 *
 * THE TWO `LIMIT` ROWS ARE THE SHARPEST HYPOTHESIS. A `LIMIT 10` should exit after ten rows; if it
 * costs what the UNLIMITED twin costs, nothing is exiting early — the `eager-tail-cache` class, which
 * this repo has measured at 473x and 3680x in both engines. That is a per-row comparison against the
 * same query without the limit, which is the only pairing that can show it.
 *
 * `sum` IS DELIBERATELY NOT FOLDED over the level recurrence (items 1830/2010): a
 * multiplicity-weighted sum is different arithmetic from a per-path one and f64 addition is not
 * associative, so byte-identity with Rust forbids it. Those rows are priced to SIZE the standing refusal,
 * not to challenge it.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 9);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { k: i % 97, n: i % 97, tags: ['a', 'b'] },
  });
}

let e = 0;

for (let d = 0; d < 3; d += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

/** Each general-path shape paired with the FLOOR that answers the same question. */
const pairs = [
  ['node.limit', 'MATCH (n:P) RETURN n.k AS k LIMIT 10', 'MATCH (n:P) RETURN n.k AS k'],
  [
    'hop.limit',
    'MATCH (a:P)-[:E]->(b) RETURN b.k AS k LIMIT 10',
    'MATCH (a:P)-[:E]->(b) RETURN b.k AS k',
  ],
  [
    'hop.group.sum.crossend',
    'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, sum(b.k) AS s',
    /* The same grouping with a COUNT, which has a rung — so the gap is the `sum`, not the grouping. */
    'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, count(*) AS s',
  ],
  [
    'opt.group',
    'MATCH (a:P) OPTIONAL MATCH (a)-[:E]->(b) RETURN a.k AS g, count(*) AS c',
    /* The same question without OPTIONAL — so the gap is the OPTIONAL, not the grouping. */
    'MATCH (a:P)-[:E]->(b) RETURN a.k AS g, count(*) AS c',
  ],
  [
    'hop2.sum.end',
    'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN sum(c.k) AS s',
    /* `min` over the same chain DOES fold over the recurrence — so the gap is `sum`'s refusal. */
    'MATCH (a:P)-[:E]->(b)-[:E]->(c) RETURN min(c.k) AS s',
  ],
  [
    'varlen.proj',
    'MATCH (a:P)-[:E]->{1,3}(b) RETURN b.k AS k',
    /* The fixed three-hop chain, which has a rung — so the gap is the quantifier. */
    'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN d.k AS k',
  ],
];

const timeIt = (q) => {
  const series = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = query(g, q, {});

    series.push(performance.now() - t0);
    rows = got.length;
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], rows };
};

console.log(`  N=${N} edges=${e}, median of ${REPS}\n`);
console.log(
  `  ${'shape'.padEnd(24)} ${'general'.padStart(10)} ${'floor'.padStart(10)} ${'ratio'.padStart(8)}  rows (gen / floor)`,
);

for (const [name, q, floor] of pairs) {
  const a = timeIt(q);
  const b = timeIt(floor);
  const ratio = a.ms / b.ms;

  console.log(
    `  ${name.padEnd(24)} ${a.ms.toFixed(2).padStart(10)} ${b.ms.toFixed(2).padStart(10)} ${ratio.toFixed(2).padStart(7)}x  ${a.rows} / ${b.rows}${ratio > 2 ? '   CANDIDATE' : ''}`,
  );
}
