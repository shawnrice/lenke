/*
 * Item 2108 — `SEEK_MAX_FRACTION` is ONE constant serving TWO shapes with DIFFERENT break-evens.
 *
 * WHY THIS PROBE EXISTS. Raising the fraction gave a 1-hop aggregate **3.05x at 13.3% selectivity**
 * and no regression up to 50%. That CONTRADICTS the constant's own rationale, which cites item 409
 * measuring the seek **1.96x SLOWER at 30% and 5.02x at 60%** — so one of the two is shape-specific, and
 * raising the constant on my shape's evidence alone would ship the 3.1x regression the rationale warns
 * about.
 *
 * SO BOTH SHAPES ARE MEASURED IN ONE PROCESS, ON ONE FIXTURE, AT THE SAME SELECTIVITIES:
 *
 *   - `plain` — item 409's shape: a NODE scan with a range predicate, no hop. The seek's cost is the
 *     whole query, so an unselective seek is pure waste.
 *   - `hop`   — a one-hop aggregate. Each seeded vertex then costs an adjacency walk, which DWARFS the
 *     seed materialization — so a wider seek is cheap relative to the work it saves.
 *
 * THE HYPOTHESIS THIS TESTS: the break-even is not a property of the index, it is a property of HOW
 * MUCH WORK EACH SEEDED VERTEX CAUSES. If `plain` degrades where `hop` improves, one global constant
 * cannot serve both and the rationale's asymmetry argument is right for `plain` and wrong for `hop`.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 11);
const MOD = 1000;

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { n: i % 97, sel: (i * 7919) % MOD },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 13) % NODES}`),
    labels: ['E'],
    properties: {},
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['sel'] });

const timeIt = (q, params) => {
  const series = [];
  let rows = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    rows = query(g, q, params);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], answer: JSON.stringify(rows) };
};

const FRAC = process.env.FRAC ?? '?';

console.log(`  FRAC=${FRAC}  NODES=${NODES} FANOUT=${FANOUT}, median of ${REPS}`);
console.log(
  `  ${'%graph'.padStart(7)} ${'plain ms'.padStart(9)} ${'hop ms'.padStart(9)}   (409's shape | the hop shape)`,
);

for (const oneIn of (process.env.ONEIN ?? '16,8,7,6,5,4,3.5,3,2.8,2.5,2').split(',').map(Number)) {
  const hi = Math.max(1, Math.round(MOD / oneIn));
  const plain = timeIt('MATCH (b:P) WHERE b.sel < $hi RETURN min(b.n) AS c', { hi });
  const hop = timeIt('MATCH (a:P)-[:E]->(b:P) WHERE b.sel < $hi RETURN min(a.n) AS c', { hi });

  console.log(
    `  ${((100 * hi) / MOD).toFixed(1).padStart(7)} ${plain.ms.toFixed(3).padStart(9)} ${hop.ms.toFixed(3).padStart(9)}`,
  );
}
