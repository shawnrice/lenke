/**
 * A TWO-VARIABLE CLAUSE `AND` OVER THE TWO INTERIOR POSITIONS IS 978x ITS INLINE TWIN (item 1700).
 *
 * `MATCH (a)-[:K]->(b)-[:K]->(c)-[:K]->(d) WHERE b.age = 7 AND c.age > 60` and
 * `MATCH (a)-[:K]->(b {age: 7})-[:K]->(c WHERE c.age > 60)-[:K]->(d)` are ONE QUESTION, return the
 * same count, and differ by three orders of magnitude. That is the equivalent-spelling failure
 * family this engine's spelling discipline exists for — "each cost 100-300x and each returned the
 * correct answer, so no correctness test could catch it".
 *
 * At 20,000 vertices / 100,000 edges, warm:
 *
 * ```text
 *    WHERE b.age = 7                           4.0 ms   count    27,875
 *    WHERE c.age > 60                          3.1      count   804,750
 *    WHERE b.age = 7 AND c.age > 60         1466.3      count     9,275   <- the gap
 *    (b {age: 7}) + (c WHERE c.age > 60)       1.5      count     9,275   <- same answer
 *    WHERE a.age = 7 AND c.age > 60            2.2      count     9,290
 *    WHERE b.age = 7 AND d.age > 60            2.7      count     9,290
 * ```
 *
 * ⚠️ ONLY THE b+c PAIR COLLAPSES, and only in the clause spelling — a START+interior or
 * interior+END pair is fine. A route counter says why:
 *
 * ```text
 *    b only      neither counter      -> the gated degree product (item 1689)
 *    b AND c     threeSegDecline      -> declines, and NO sweep route exists at 3 segments
 *    a AND c     longChain            -> the sweep
 *    b AND d     longChain            -> the sweep
 * ```
 *
 * `interiorPredOf`'s `readsOnly(name)` requires EVERY free variable of the clause to be that one
 * name, so a conjunction over both interior positions returns `null`; `patternCountOf` then declines
 * and the three-segment path has no second route (the sweep is entered at `>= 4` segments, or via
 * `endGatedChainCount` when the END is constrained). So the query falls to the general row pipeline.
 *
 * ⚠️ THE MACHINERY TO ANSWER IT ALREADY EXISTS. The product carries `interior: { b, c }` — two
 * independent gate lists — and the INLINE spelling fills both, which is why it runs in 1.5 ms. Only
 * the CLAUSE reader refuses to produce two. `chainGatesOf` already splits a clause `WHERE` across
 * the positions it names (item 305) for the sweep, so the splitting logic exists too.
 *
 *   node gql-interior-and-probe.mjs
 *   N=200000 node gql-interior-and-probe.mjs   # the clause form did not finish in 600s at 200k
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20_000);
const REPS = Number(process.env.REPS ?? 5);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: i % 90 } }));
}

// `bench-gremlin.ts`'s edge expression, including item 1632's repeat-index split so the graph is
// not functional, and scattered insertion so the adjacency layout matches the bench (item 1694).
for (let k = 0; k < N * 5; k += 1) {
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  g.addEdge({
    id: `e${k}`,
    from: vs[(k * 7919) % N],
    to: vs[to],
    labels: ['KNOWS'],
    properties: {},
  });
}

const distinct = new Set();

for (const e of g.edges) {
  distinct.add(e.to);
}

if (distinct.size < N / 2) {
  throw new Error(`FIXTURE DEGENERATE: ${distinct.size} distinct endpoints`);
}

const P = '(a:Person)-[:KNOWS]->(b)-[:KNOWS]->(c)-[:KNOWS]->(d)';

const ROWS = {
  bOnly: `MATCH ${P} WHERE b.age = 7 RETURN count(*) AS c`,
  cOnly: `MATCH ${P} WHERE c.age > 60 RETURN count(*) AS c`,
  bAndC: `MATCH ${P} WHERE b.age = 7 AND c.age > 60 RETURN count(*) AS c`,
  bAndCInline:
    'MATCH (a:Person)-[:KNOWS]->(b {age: 7})-[:KNOWS]->(c WHERE c.age > 60)-[:KNOWS]->(d) RETURN count(*) AS c',
  aAndC: `MATCH ${P} WHERE a.age = 7 AND c.age > 60 RETURN count(*) AS c`,
  bAndD: `MATCH ${P} WHERE b.age = 7 AND d.age > 60 RETURN count(*) AS c`,
};

const PICK = process.env.ROW;
const chosen = PICK === undefined ? Object.keys(ROWS) : [PICK];

if (chosen.some((k) => ROWS[k] === undefined)) {
  throw new Error(`set ROW to one of: ${Object.keys(ROWS).join(', ')}`);
}

console.log(`\n${N} vertices / ${g.edgeCount} edges, median of ${REPS}\n`);
console.log('row              ms      count');

/** ⚠️ The two spellings must AGREE, or the comparison is of two different questions. */
let bAndCCount;
let inlineCount;

for (const name of chosen) {
  const q = ROWS[name];
  const series = [];
  let count = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    count = Number(query(g, q)[0].c);
    series.push(performance.now() - t0);
  }

  if (name === 'bAndC') {
    bAndCCount = count;
  }

  if (name === 'bAndCInline') {
    inlineCount = count;
  }

  series.sort((a, b) => a - b);
  console.log(
    `${name.padEnd(14)} ${series[Math.floor(series.length / 2)].toFixed(1).padStart(9)} ${String(count).padStart(10)}`,
  );
}

if (bAndCCount !== undefined && inlineCount !== undefined && bAndCCount !== inlineCount) {
  throw new Error(`THE SPELLINGS DISAGREE: clause ${bAndCCount} vs inline ${inlineCount}`);
}
