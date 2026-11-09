/**
 * DOES AN INDEX ON THE FILTERED KEY MAKE THE CLAUSE SPELLING DECLINE THE INTERIOR ARM? (item 1702)
 *
 * `bun run spelling` flags ONE group at 29.18x / 31.18x / 29.33x across three isolated runs, same
 * answer: `WHERE c.k = 2` at 334-371 ms against `(c WHERE c.k = 2)` and `(c {k: 2})` at 11.5-12.6.
 *
 * ⚠️ ITEM 1701 SHOULD ALREADY HANDLE A SINGLE `c` CONJUNCT — it widened the clause reader to bucket
 * per interior position, and measured `WHERE c.k > 9` at 2.0 ms. So the flagged group differs in
 * something else, and the candidate is the FIXTURE: `spelling-probe.ts` calls
 * `createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] })`, and the flagged query is an EQUALITY
 * on that indexed key. Item 1701's probe had no index.
 *
 * ONE VARIABLE: the same graph, the same queries, with and without the index.
 *
 *   ARM=noIndex   node gql-indexed-interior-probe.mjs
 *   ARM=indexed   node gql-indexed-interior-probe.mjs
 *
 * ⚠️ Both arms assert the three spellings AGREE, or the comparison is of different questions.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 50_000);
const REPS = Number(process.env.REPS ?? 7);
const ARM = process.env.ARM ?? 'noIndex';
const MULTI = process.env.MULTI === '1';

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 17, s: `s${i % 7}` } }));
}

// Scattered insertion and a nonlinear target, so the graph is neither functional nor in-regular.
for (let m = 0; m < N * 5; m += 1) {
  const to = ((m % N) * 104_729 + Math.floor(m / N) * 977) % N;

  // ⚠️ MULTI=1 gives one edge in eleven a SECOND label, as `spelling-probe.ts`'s fixture does
  // (`e % 11 === 0 ? ["E","F"] : ["E"]`). The count rungs carry a multi-type guard, because one
  // edge can sit in two buckets and a degree read would double-count it — so this is the candidate
  // for why the probe's clause form declines where mine does not.
  g.addEdge({
    id: `e${m}`,
    from: vs[(m * 7919) % N],
    to: vs[to],
    labels: MULTI && m % 11 === 0 ? ['E', 'F'] : ['E'],
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

/**
 * ⚠️ FOUR EDGELESS VERTICES UNDER ANOTHER LABEL, which item 1703's bisection identified as the whole
 * cause of a 29x clause-vs-inline gap: `EXTRA=0` took the replica's clause form from 515.07 ms to
 * 17.71 while fanout, selectivity, scatter, edge properties and the loader all left it at 374-568.
 *
 * The mechanism to confirm: with ONLY `P` vertices, `(a:P)` is VACUOUS and `effectiveLabel` returns
 * `undefined`, so `csrDegreeProductApplies` (which requires `aEff === undefined`) admits the arm.
 * Four non-`P` vertices make the label real, and the arm declines.
 */
if (process.env.OTHERLABEL === '1') {
  for (let i = 0; i < 4; i += 1) {
    g.addVertex({ id: `s${i}`, labels: ['S', 'Univ'], properties: { k: i, s: `t${i}` } });
  }
}

// ⚠️ THE ONE VARIABLE. `spelling-probe.ts` builds this index; item 1701's probe did not.
if (ARM === 'indexed') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

const SPELLINGS = {
  clause: 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k = 2 RETURN count(*) AS c',
  inlineWhere: 'MATCH (a:P)-[:E]->(b)-[:E]->(c WHERE c.k = 2)-[:E]->(d) RETURN count(*) AS c',
  inlineProp: 'MATCH (a:P)-[:E]->(b)-[:E]->(c {k: 2})-[:E]->(d) RETURN count(*) AS c',
  // An ORDERING clause on the same key, which item 1701 measured as fast — so if the equality is
  // slow and this is not, the INDEX (which only an equality can seek) is implicated.
  clauseOrdering: 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE c.k > 9 RETURN count(*) AS c',
};

const counts = {};

for (const [name, q] of Object.entries(SPELLINGS)) {
  counts[name] = Number(query(g, q)[0].c);
}

if (counts.clause !== counts.inlineWhere || counts.clause !== counts.inlineProp) {
  throw new Error(
    `THE SPELLINGS DISAGREE: ${counts.clause} / ${counts.inlineWhere} / ${counts.inlineProp}`,
  );
}

console.log(`\nARM=${ARM} — ${N}v / ${g.edgeCount}e, median of ${REPS}\n`);
console.log('spelling          ms       count');

for (const [name, q] of Object.entries(SPELLINGS)) {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    query(g, q);
    series.push(performance.now() - t0);
  }

  series.sort((a, b) => a - b);
  console.log(
    `${name.padEnd(16)} ${series[Math.floor(series.length / 2)].toFixed(1).padStart(8)} ${String(counts[name]).padStart(11)}`,
  );
}
