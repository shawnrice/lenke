/**
 * ⚠️⚠️ **CAN A 16% REGRESSION ON THE READ RUNGS EVEN BE DETECTED? (item 2314)**
 *
 * Item 2180 declined its target one because a new rung in that file risks **up to 16% on unrelated rows**
 * (`executor-edits-perturb`), and item 2313 re-priced the gain at **2.39x** — so the decision now turns on
 * an A/B over those rows.
 *
 * ⚠️ **But item 2299 measured `noderows` at 1.86x spread ON AN IDENTICAL BINARY**, and `hop3sel` at
 * 1.15x. A row that moves 86% by itself cannot adjudicate a 16% effect, so the A/B the decision needs may
 * not be possible with the harness that produced those numbers.
 *
 * 🔑 **THIS IS THE INSTRUMENT QUESTION, ASKED BEFORE THE CHANGE.** Items 2302/2303 cost two published
 * numbers to a single-call timer; the fix — inner-iteration calibration — is what might make these rows
 * tight enough to judge. If it does, the A/B is possible. If it does not, item 2180's decline is permanent
 * for want of an instrument, which is worth knowing BEFORE writing a rung.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 20_000);
const FAN = Number(process.env.FAN ?? 4);
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 25);
const SHAPE = process.env.SHAPE ?? 'noderows';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 977 } });
}

for (let k = 0; k < N * FAN; k += 1) {
  const to = ((k % N) * 104_729 + Math.floor(k / N) * 977) % N;

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`v${(k * 7919) % N}`),
    to: g.getVertexById(`v${to}`),
    labels: ['E'],
    properties: {},
  });
}

const QUERIES = {
  noderows: 'MATCH (n:P) RETURN n.k AS k',
  nodecount: 'MATCH (n:P) RETURN count(*) AS c',
  orderedrows: 'MATCH (n:P) RETURN n.k AS k ORDER BY k',
  groupednode: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
  hoprows: 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k',
};

const text = QUERIES[SHAPE];
const run = () => query(g, text, {}).length;

for (let w = 0; w < 200; w += 1) {
  run();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 100_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t = performance.now();

  for (let i = 0; i < inner; i += 1) {
    run();
  }

  ts.push((performance.now() - t) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const spread = sorted[sorted.length - 1] / sorted[0];

console.log(
  `  SHAPE=${SHAPE.padEnd(12)} median ${med.toFixed(4).padStart(9)} ms   inner=${String(inner).padStart(6)}   within-run spread ${spread.toFixed(3)}x`,
);
