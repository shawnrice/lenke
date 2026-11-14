/**
 * `V().out(E)xK.values(k)` — ONE SHAPE PER PROCESS, for item 1875's `valueAt` deletion test.
 *
 * ⚠️ THE CONTROL IS A DEPTH, NOT A DIFFERENT QUERY. `valueAt` is defined inside `stackedWalk`,
 * which `hop-chain-values.ts` uses from depth THREE up — depth 2 "keeps the literal nesting here".
 * So `DEPTH=2` exercises a loop the change cannot reach while sharing the fixture, the engine and
 * the harness with `DEPTH=3`. If both move, it is the build or the machine.
 *
 *     DEPTH=3 bun hop-depth-ab-1875.mjs    # the target
 *     DEPTH=2 bun hop-depth-ab-1875.mjs    # the control
 */
import { Graph } from '@lenke/core';
import { V, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const DEPTH = Number(process.env.DEPTH ?? 3);
const REPS = Number(process.env.REPS ?? 15);

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { age: i % 90 } });
}

let e = 0;

for (let h = 0; h < FANOUT; h += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + h * 2_654_435_761) % N}`),
      labels: ['E'],
    });
    e += 1;
  }
}

const hops = Array.from({ length: DEPTH }, () => out('E'));
const plan = traversal(V(), ...hops, values('age'));
const series = [];
let rows = 0;

for (let r = 0; r < REPS + 3; r += 1) {
  const t0 = performance.now();
  const got = toArray(plan, g);
  const ms = performance.now() - t0;

  if (r >= 3) {
    series.push(ms);
  }

  rows = got.length;
}

series.sort((a, b) => a - b);

const median = series[series.length >> 1];

console.log(
  `DEPTH=${String(DEPTH)}  median ${median.toFixed(1)} ms  min ${series[0].toFixed(1)}  ` +
    `${((median * 1e6) / rows).toFixed(2)} ns/row over ${String(rows)} rows`,
);
