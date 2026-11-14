/**
 * WHERE DOES THE FUSED THREE-HOP VALUES WALK SPEND ITS TIME? (item 1875)
 *
 * The largest absolute TS cost on the Gremlin bench is `V().out()x3.values(age)` at ~490 ms, and
 * item 1871's route census says it is already FUSED (`hop3: values` → SHORTCUT, 0.0x against the
 * pipeline). So this is not a route question — it is the Gremlin twin of item 1859's chain-walk
 * profile: given that the rung fires, where does its time go?
 *
 * ⚠️ ONE SHAPE, ONE PROCESS, and that is not a formality after the last two items. Item 1874
 * retracted a 1.73x that was a within-process cross-row ratio, and item 1870 measured a control
 * moving 1.7x purely by running last. Nothing here times a second shape, so no comparison between
 * rows is possible and none is made.
 *
 * ⚠️ ENOUGH ITERATIONS THAT STARTUP CANNOT DOMINATE, for item 1843's reason: its first profile spent
 * 22% of its samples in the lexer's keyword table, built once at import.
 *
 *     N=60000 REPS=12 node --cpu-prof hop3-values-prof-1875.mjs
 */
import { Graph } from '@lenke/core';
import { V, out, toArray, traversal, values } from '@lenke/gremlin';

/**
 * ⚠️⚠️ THE DEFAULTS ARE SIZED SO THE QUERY DOMINATES THE PROFILE, and the first run of this file is
 * why. At N=60000 FANOUT=1 REPS=12 the query took 93 ms of a 392 ms process and the profile came
 * back **76% FIXTURE BUILD** — `getVertexById` 11.6%, `indexEdgeLabel` 8.9%, `commitElementLabels`
 * 4.9%, `addVertex` 3.0%, two `#commitNormalized` frames, plus most of a 15.4% GC. Item 1859's
 * profile recorded the same trap and I reproduced it.
 *
 * ⚠️ AND FANOUT=1 WAS THE WRONG FIXTURE ANYWAY: with one out-edge per vertex a "three-hop" walk is
 * a CHAIN that never branches, so the stacked walk's branching arm is never exercised. The bench
 * this shape comes from uses five.
 *
 * The run now prints the fixture's own share so a future reader can see whether it still holds.
 */
const N = Number(process.env.N ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 6);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { age: i % 90, k: i % 997 } });
}

let e = 0;

for (let h = 0; h < FANOUT; h += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      // ⚠️ THE REPEAT INDEX IS IN THE EXPRESSION, which is CLAUDE.md's fix for the `(a*k+b) % N`
      // degeneracy: without it one vertex's FANOUT edges all land on the same target and every
      // k-hop count is `F^k * N` by construction while every degree statistic looks perfect.
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + h * 2_654_435_761) % N}`),
      labels: ['E'],
    });
    e += 1;
  }
}

/** The fixture must BRANCH at FANOUT > 1, or a 3-hop walk is a chain and measures a chain. */
if (FANOUT > 1) {
  const seen = new Set();

  for (let h = 0; h < FANOUT; h += 1) {
    // v0's targets: the generator's expression with `i = 0`, so the `i * 7` term drops out.
    seen.add((3 + h * 2_654_435_761) % N);
  }

  if (seen.size < 2) {
    throw new Error(`fixture is functional: v0 reaches ${String(seen.size)} distinct targets`);
  }
}

const built = performance.now();
const plan = traversal(V(), out('E'), out('E'), out('E'), values('age'));

let rows = 0;
const t0 = performance.now();

for (let r = 0; r < REPS; r += 1) {
  rows += toArray(plan, g).length;
}

const ms = performance.now() - t0;

console.log(
  `# fixture build ${built.toFixed(0)} ms, query ${ms.toFixed(0)} ms — the query is ` +
    `${((100 * ms) / (built + ms)).toFixed(0)}% of the process, and the profile is only as good as that`,
);
console.log(
  `${((ms * 1e6) / Math.max(rows, 1)).toFixed(1)} ns/row over ${String(rows)} rows in ` +
    `${ms.toFixed(0)} ms — V().out(E)x3.values(age) at N=${String(N)} FANOUT=${String(FANOUT)}`,
);
