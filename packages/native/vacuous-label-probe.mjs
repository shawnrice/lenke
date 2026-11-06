/**
 * The vacuous-label elision, measured PER SITE (item 1609).
 *
 * Item 1608 priced the elision at 5.6x on the seeded count and reverted it, because eliding at ONE
 * site makes `count(*)` and the rows spelling of the same query disagree. The label-test line
 * appears at SEVEN sites in `shortcuts.ts`, across five detectors, and today none of them elides —
 * so the engine is consistent and only a uniform change keeps it that way.
 *
 * `executor-edits-perturb` prices a hot-walk edit at up to 16% on UNRELATED rows, so a seven-site
 * change has to be measured per site rather than on one row and assumed for the rest. One shape per
 * site:
 *
 * ```text
 *    count          buildNodeCount                 line 614
 *    values         detectNodeProjection streaming     10292
 *    values+order   its deferred sort-key walk          9806
 *    values+limit   its topK walk                       9975
 *    aggregate      detectNodeAggregate                11460 / 11508
 *    multi-agg      detectMultiNodeAggregate           11761
 * ```
 *
 * ⚠️ `MULTI=1` IS THE CONTROL, and it is the only honest one: the elision fires only when the
 * queried label covers EVERY vertex, so a multi-label graph must measure FLAT at every row. The
 * label is assigned on `i % 3` while the seek key is `i % 20` — decorrelated on purpose, because
 * item 1608's first attempt used `i % 2` against `i % 20` and every bucket came out single-label,
 * which makes a query resolve on the label alone.
 *
 *     SHAPE=count node vacuous-label-probe.mjs
 *     MULTI=1 SHAPE=count node vacuous-label-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const REPS = Number(process.env.REPS ?? 10_000);
const BUCKETS = Number(process.env.BUCKETS ?? 20);
const MULTI = process.env.MULTI === '1';
const SHAPE = process.env.SHAPE ?? 'count';

const TEXT = {
  count: 'MATCH (u:User) WHERE u.score = $s RETURN count(*) AS c',
  values: 'MATCH (u:User) WHERE u.score = $s RETURN u.n AS n',
  'values-order': 'MATCH (u:User) WHERE u.score = $s RETURN u.n AS n ORDER BY n',
  'values-limit': 'MATCH (u:User) WHERE u.score = $s RETURN u.n AS n ORDER BY n LIMIT 10',
  aggregate: 'MATCH (u:User) WHERE u.score = $s RETURN max(u.n) AS m',
  'multi-agg': 'MATCH (u:User) WHERE u.score = $s RETURN count(*) AS c, max(u.n) AS m',
  // NULL CONTROL: no label at all, so no site has a label test to elide.
  'count-nolabel': 'MATCH (u) WHERE u.score = $s RETURN count(*) AS c',
}[SHAPE];

if (TEXT === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}`);
}

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: `u${i}`,
    labels: MULTI && i % 3 === 0 ? ['Other'] : ['User'],
    properties: { n: i, score: i % BUCKETS },
  });
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['score'] });

const paramOf = (i) => ({ s: i % BUCKETS });

for (let i = 0; i < 400; i += 1) {
  query(g, TEXT, paramOf(i));
}

const rows = query(g, TEXT, paramOf(1));
const t0 = performance.now();

for (let i = 0; i < REPS; i += 1) {
  query(g, TEXT, paramOf(i));
}

const ns = ((performance.now() - t0) * 1e6) / REPS;

console.log(
  `${(MULTI ? `${SHAPE} MULTI` : SHAPE).padEnd(20)} ${ns.toFixed(0).padStart(8)} ns/op   ` +
    `${String(rows.length).padStart(5)} rows   ${JSON.stringify(rows[0] ?? null).slice(0, 34)}`,
);
