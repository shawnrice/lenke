/**
 * DO THE GQL CSR ARMS PASS ITEM 1695's CRITERION — walk cost > rebuild cost?
 *
 * Item 1695 measured the Gremlin far-filtered arm and found it safe at any write rate, because its
 * ~182 ms rebuild is cheaper than the ~192 ms walk it replaces. Its entry says explicitly that the
 * GQL arms (items 1685, 1688, 1689, 1690) are "a separate instance of the criterion, not an
 * inheritance, and none has been measured under writes".
 *
 * ⚠️ AND THERE IS A REASON TO EXPECT A DIFFERENT ANSWER. The Gremlin arm builds ONE CSR. The GQL
 * three-hop arms call `csrFor` THREE times — `aSide`, `mid`, `dSide`, one per leg, three distinct
 * shapes and so three separate builds — and the two-hop arm calls it twice. A write drops the whole
 * generation, so the rebuild is 2-3x the Gremlin arm's against a walk that is often CHEAPER
 * (`count 3-hop` is 463.9 ms, but `count 2-hop + start filter` is ~130).
 *
 * ⚠️ SCATTERED FIXTURE, for item 1694's reason: a grouped insertion order understates both the walk
 * and the rebuild, and it is the rebuild that decides this question.
 *
 *   ROW=<name> ARM=warm   node gql-csr-invalidation-probe.mjs
 *   ROW=<name> ARM=write1 node gql-csr-invalidation-probe.mjs
 *
 * Rows: h3 (item 1685), h3start (1688), h3interior (1689), h2start (1690).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 10);
const READS = Number(process.env.READS ?? 6);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

// `bench-gremlin.ts`'s own edge expression, including item 1632's repeat-index split. The `from`
// scatter is the point: each vertex's five edges land ~200,000 insertions apart.
for (let k = 0; k < N * 5; k += 1) {
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  g.addEdge({
    id: `e${k}`,
    from: vs[(k * 7919) % N],
    to: vs[to],
    labels: ['KNOWS'],
    properties: { w: k % 7 },
  });
}

const distinct = new Set();

for (const edge of g.edges) {
  distinct.add(edge.to);
}

if (distinct.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${distinct.size} distinct endpoints`);
}

const ROWS = {
  h3: 'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) RETURN count(*) AS c',
  h3start:
    'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE a.age > 60 RETURN count(*) AS c',
  h3interior:
    'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d) WHERE c.age > 60 RETURN count(*) AS c',
  h2start: 'MATCH (a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c) WHERE a.age > 60 RETURN count(*) AS c',
};

const ROW = process.env.ROW ?? 'h3';

if (ROWS[ROW] === undefined) {
  throw new Error(`set ROW to one of: ${Object.keys(ROWS).join(', ')}`);
}

const q = ROWS[ROW];
let extra = 0;

/** One `addEdge`: a few microseconds of work that drops every cached CSR generation. */
const write = () => {
  g.addEdge({
    id: `x${extra}`,
    from: vs[extra % N],
    to: vs[(extra * 31 + 7) % N],
    labels: ['KNOWS'],
    properties: {},
  });
  extra += 1;
};

const ARMS = {
  warm: () => {
    for (let i = 0; i < READS; i += 1) {
      query(g, q);
    }
  },
  write1: () => {
    for (let i = 0; i < READS; i += 1) {
      write();
      query(g, q);
    }
  },
};

const ARM = process.env.ARM ?? 'warm';

if (ARMS[ARM] === undefined) {
  throw new Error(`set ARM to warm or write1`);
}

// Warm the parse/plan caches and the CSRs once, outside the measurement.
const answer = Number(query(g, q)[0].c);

if (answer === 0) {
  throw new Error(`ROW ${ROW} counted 0 — it would prove nothing`);
}

const series = [];

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  ARMS[ARM]();
  series.push((performance.now() - t0) / READS);
}

/** ⚠️ MEDIAN of the warm reps, per READ. */
const warm = series.slice(3).sort((a, b) => a - b);

console.log(
  `${ROW.padEnd(11)} ${ARM.padEnd(7)} ms/read median=${warm[Math.floor(warm.length / 2)].toFixed(2).padStart(9)} count=${answer} series=${series.map((x) => x.toFixed(1)).join(' ')}`,
);
