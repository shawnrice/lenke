// Item 1933 — the GQL `SET` profile with THE FIXTURE BUILD EXCLUDED.
//
// ⚠️ A CPU PROFILE CANNOT EXCLUDE THE BUILD THE WAY A TIMER CAN. `setgap-prof-1933.mjs` rebuilds a
// fresh graph per rep (correct, because a write is not idempotent) and its profile therefore came
// back 25% fixture construction — `addVertex` 7.68%, `commitElementLabels` 6.04%,
// `indexVertexLabel` 5.69%, `build` 5.15% — which is attribution noise, not the subject.
//
// 🔑 ONE MEASUREMENT MAKES A CLEAN PROFILE POSSIBLE: `SET n.n = n.n`, which changes nothing, costs
// 529 ns a row against a real change's 549. The per-row cost is VALUE-INDEPENDENT, so repeating the
// same SET on ONE graph exercises the same machinery with no rebuild in the profile.
//
//     bun --cpu-prof setprof-clean-1933.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20000);
const ROUNDS = Number(process.env.ROUNDS ?? 25);
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    properties: { n: i % 97, k: `s${String(i)}`, w: i % 7 },
  });
}

const t0 = performance.now();

for (let r = 0; r < ROUNDS; r += 1) {
  query(g, 'MATCH (n:T) SET n.n = 1', {});
}

const ms = performance.now() - t0;

console.log(
  `${ROUNDS} rounds of SET over ${NODES} vertices: ${ms.toFixed(2)} ms total, ` +
    `${((ms * 1e6) / (ROUNDS * NODES)).toFixed(0)} ns a row`,
);
