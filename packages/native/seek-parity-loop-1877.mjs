/**
 * DOES THE `seek-count` SURFACE GAP SURVIVE A LOOP-AMORTIZED HARNESS? (item 1877)
 *
 * `surface-parity-probe.ts` reports GQL 18.6 us against Gremlin 7.5 for an equality seek then
 * `count(*)` — stable over three rounds. But it times ONE CALL PER REP with `performance.now()`,
 * and at 5-19 us that is close to timer resolution and includes per-call overhead the engines do not
 * control. A loop-amortized measurement of the GQL side on an equivalent fixture read 4.97 us, not
 * 18.6 — so the ratio may be the harness.
 *
 * THIS LOOPS BOTH SURFACES IDENTICALLY, on ONE graph built the parity probe's way (addVertex +
 * addEdge + createIndex), one surface per process. If the 2.5x survives it is the engines; if it
 * collapses it was the harness, and the parity probe's fast arms need a loop.
 *
 *     SURFACE=gql bun seek-parity-loop-1877.mjs
 *     SURFACE=grm bun seek-parity-loop-1877.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, has, hasLabel, toArray, traversal } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 20_000);
const SURFACE = process.env.SURFACE ?? 'gql';

const graph = new Graph();
const vs = Array.from({ length: N }, (_, i) =>
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { age: i % 90, tag: `t${i % 7}` } }),
);

for (let i = 0; i + 1 < N; i += 1) {
  graph.addEdge({ id: `e${i}`, from: vs[i], to: vs[i + 1], labels: ['E'], properties: {} });
}

graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['age'] });

/**
 * THE `floor` ARMS SEPARATE THE TWO EXPLANATIONS. GQL takes TEXT so it parses and compiles per
 * call (cached, but not free); Gremlin takes an OBJECT and item 1841 priced its builder at 0.188 us,
 * ~5% of a call. So a gap on a near-empty query is FIXED COST, and only the excess above that is
 * the seek. `RETURN 1` does no graph work at all on either surface.
 */
const SHAPE = process.env.SHAPE ?? 'seek';
const GQL =
  SHAPE === 'floor' ? 'RETURN 1 AS c' : 'MATCH (n:P) WHERE n.age = 42 RETURN count(*) AS c';
const GRM =
  SHAPE === 'floor'
    ? traversal(V(), hasLabel('ZZZ_NONE'), count())
    : traversal(V(), hasLabel('P'), has('age', 42), count());
let acc = 0;

// Warm both arms' code paths the same number of times before timing.
for (let r = 0; r < 200; r += 1) {
  acc += SURFACE === 'gql' ? query(graph, GQL)[0].c : toArray(GRM, graph)[0];
}

const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  acc += SURFACE === 'gql' ? query(graph, GQL)[0].c : toArray(GRM, graph)[0];
}

const ms = performance.now() - t0;

console.log(
  `${SURFACE}  ${((ms * 1000) / REPS).toFixed(2)} us/call over ${String(REPS)} calls  acc ${String(acc)}`,
);
