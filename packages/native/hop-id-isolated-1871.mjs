/**
 * `V().out(T).id()` — the ONE rung item 1871's census flagged, measured in isolation.
 *
 * The census put it at **1.54x SLOWER than the pipeline** (6.331 against 4.118 ms). That census
 * runs 24 shapes in one process, which is sound for comparing a shape against ITSELF across two
 * builds and nothing more — so its own output says each flag needs an isolated A/B. This is that.
 *
 * ⚠️ ONE SHAPE PER PROCESS (item 762), and the control is a SIBLING ARM OF THE SAME RUNG:
 * `V().out(T).values(k)` goes through `hopValuesShortcut` too, by a different `pick`. If the id arm
 * is genuinely losing, the values arm should be unmoved — and if BOTH move, the difference is the
 * build or the machine rather than the arm.
 *
 *     SHAPE=id bun hop-id-isolated-1871.mjs
 *     SHAPE=values bun hop-id-isolated-1871.mjs
 */
import { Graph } from '@lenke/core';
import { V, id, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const REPS = Number(process.env.REPS ?? 11);
const SHAPE = process.env.SHAPE ?? 'id';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 997 } });
}

for (let i = 0; i < N; i += 1) {
  g.addEdge({
    id: `e${i}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3) % N}`),
    labels: ['E'],
  });
}

const plan =
  SHAPE === 'id' ? traversal(V(), out('E'), id()) : traversal(V(), out('E'), values('k'));

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
  `${SHAPE.padEnd(8)} median ${median.toFixed(2)} ms  min ${series[0].toFixed(2)}  ` +
    `max ${series[series.length - 1].toFixed(2)}  ${String(rows)} rows`,
);
