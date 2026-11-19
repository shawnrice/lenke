/**
 * ⚠️⚠️ **TWO PUBLISHED NUMBERS FOR THE SAME THING DISAGREE 5x (item 2343).**
 *
 * `docs/guides/query-cost.md`'s "Hoist a Gremlin traversal out of the request path" says building a plan
 * per request costs **about 18% (332 ns)** of a small traversal, citing item 2272's probe. ⚠️ But item
 * 2325 read `bench:usage`'s `gremlin(built) read: point lookup` at **457.6k ops/s** against
 * `reused plan` at **1.81M** — 3.96x, which is **1640 ns** of difference, not 332.
 *
 * 🔑 Both cannot be right about the same quantity. Either construction is ~332 ns and the bench's 3.96x
 * includes something else, or it is ~1640 ns and the guide understates it by 5x. **A user-facing number
 * that is 5x off is worth settling**, and the resolution matters for the advice: a FIXED construction cost
 * is a small share of a big traversal and a large multiple of a tiny one, which is more useful guidance
 * than either figure alone.
 *
 * ✅ So: build-once against build-per-call, for a TINY shape (an indexed point lookup) and a BIG one (a
 * whole-label projection), in the same process with the same fixture.
 */
import { Graph } from '@lenke/core';
import { V, eq, has, hasLabel, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 9);
const ARM = process.env.ARM ?? 'tinyReused';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['N'], properties: { k: i % 97, name: `n${i}` } });
}

graph.createIndex({ on: 'vertex', kind: 'hash', keys: ['name'] });

/* ✅ The two shapes, built ONCE for the reused arms. */
const tinyPlan = traversal(V(), hasLabel('N'), has('name', eq('n12345')), values('k'));
const bigPlan = traversal(V(), hasLabel('N'), values('k'));

/* ⚠️ The builders, identical in content — so the ONLY difference is when `traversal(...)` runs. */
const buildTiny = () => traversal(V(), hasLabel('N'), has('name', eq('n12345')), values('k'));
const buildBig = () => traversal(V(), hasLabel('N'), values('k'));

const ARMS = {
  tinyReused: () => toArray(tinyPlan, graph).length,
  tinyRebuilt: () => toArray(buildTiny(), graph).length,
  bigReused: () => toArray(bigPlan, graph).length,
  bigRebuilt: () => toArray(buildBig(), graph).length,
  /* ✅ CONSTRUCTION ALONE, executing nothing — the fixed cost both arms differ by. */
  buildOnly: () => buildTiny().steps.length,
};

const arm = ARMS[ARM];

for (let w = 0; w < 200; w += 1) {
  arm();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 200_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];

console.log(
  `  ARM=${ARM.padEnd(12)} ${(med * 1_000_000).toFixed(0).padStart(7)} ns  inner=${String(inner).padStart(6)}  rows=${arm()}`,
);
