/**
 * **DO ITEM 2180's TARGET-ONE NUMBERS STILL HOLD? (item 2313)** It priced "a write clause
 * disqualifies EVERY read rung" at ~1.48x and declined to build it, because a new rung in that file costs
 * up to 16% on unrelated rows (`executor-edits-perturb`) for a gain on one shape.
 *
 * This tick does NOT re-open that decision — my own three ships this session were GATE RELAXATIONS, not
 * new walk variants, so they change nothing about the trade. The bounded question is whether the GAP is
 * still what 2180 measured:
 *
 * ```text
 *     WHERE + count(*)          countShortcut      2.79 ms
 *     WHERE + RETURN a.k        nodeProjection     3.59
 *     WHERE + SET + count(*)    NO RUNG            6.82      <- ~1.48x headroom
 * ```
 *
 * A write MUTATES, so each rep writes a DIFFERENT value; and the filtered arms must keep the SAME row
 * count as each other or the comparison is the match-the-fixture trap.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const SHAPE = process.env.SHAPE ?? 'whereCount';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 97, n: i } });
}

/*
 * **THE CHEAP EXPLANATION, CHECKED BEFORE THE EXPENSIVE ONE (item 2315).** Item 2313 priced "a write
 * clause disqualifies every read rung" at 2.39x on THIS fixture — which has NO INDEX. Item 2301
 * measured an index on the lookup key at hundreds of times, so a filtered write's cost may be an unindexed
 * SCAN rather than a missing rung. If `INDEX=1` collapses the write arm, there is no engine defect here.
 */
if (process.env.INDEX === '1') {
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
}

const ARMS = {
  whereCount: () => query(g, 'MATCH (a:T) WHERE a.k = 5 RETURN count(*) AS c', {})[0].c,
  whereProject: () => query(g, 'MATCH (a:T) WHERE a.k = 5 RETURN a.n AS n', {}).length,
  whereSetCount: (v) =>
    query(g, 'MATCH (a:T) WHERE a.k = 5 SET a.n = $v RETURN count(*) AS c', { v })[0].c,
  /* The write with no filter, which 2180 also records as having NO RUNG. */
  setNoWhere: (v) => query(g, 'MATCH (a:T) SET a.n = $v RETURN count(*) AS c', { v })[0].c,
};

const run = ARMS[SHAPE];
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (let w = 0; w < 3; w += 1) {
  run(-1 - w);
}

const ts = [];
let answer = 0;

for (let r = 0; r < ROUNDS; r += 1) {
  const t = performance.now();

  answer = run(r);
  ts.push(performance.now() - t);
}

console.log(`  SHAPE=${SHAPE.padEnd(13)} ${med(ts).toFixed(2).padStart(7)} ms   rows=${answer}`);
