/**
 * WHY DOES ONE `.has()` COST 42 ms ON A HOP COUNT THAT IS OTHERWISE FREE? (item 2126, Gremlin)
 *
 * 🔑 `bun run bench:gremlin` nominates this with no interpretation needed, at 200,000 vertices /
 * 1,000,000 edges:
 *
 * ```text
 *     V().out().count()           0.0 ms ts    0.00 native
 *     V().out().has().count()    42.1         1.05          <- 39.9x native, and the TS bare twin is FREE
 * ```
 *
 * ⚠️⚠️ **THE SAME SIGNATURE AS THE LAST SEVEN GQL ITEMS: a rung for each half and none for the pair.** The
 * bare hop count has a shortcut that answers without walking; `.has()` on the far end falls off it and
 * the walk materializes a million elements. Native answers the FILTERED form in 1.05 ms, so the shape is
 * reachable — this is a missing TS route, not a cost of the question.
 *
 * ⚠️ **THE PROFILE IS WINDOWED TO THE TRAVERSAL LOOP** — V8's profiler starts after the fixture is built
 * and stops before teardown, so `PROBES.md`'s closed frames (`indexEdgeLabel`, `commitElementLabels`,
 * `#commitNormalized`; six prior arrivals between them) are structurally absent rather than something to
 * remember to ignore. Item 2125's pattern. ⚠️ Run with `node`, not `bun`.
 *
 * ⚠️⚠️ **READ A CALLEE AND ITS CALLER AS ONE NUMBER.** Item 2125 measured the same two frames at 8.1 /
 * 18.2 / 40.1 / 13.3% across four runs of one binary — V8's inlining varies per run and adjacent frames
 * TRADE self time while their sum stays put. A nomination that depends on which of two adjacent frames is
 * hot is not a finding; sum them, or ablate with a control.
 *
 * The arms, each isolating one term:
 *
 *   - `filtered`   the target: `V().out().has(age, gt).count()`.
 *   - `bare`       `V().out().count()` — the rung, so the difference is what `.has()` costs.
 *   - `vacuous`    `.has(age, gt(-1))`, which keeps EVERY row. 🔑 If this costs what `filtered` costs, the
 *                  cost is the ROUTE and not the rows it rejects — the `WHERE true` control's logic
 *                  (item 570), which is THE control for "why is the filtered version slower".
 *   - `nearside`   `V().has(age, gt).out().count()` — the same predicate on the START, which the bench
 *                  reads at 21.1 ms, half the far-side cost. Says whether the end matters.
 */
import { Session } from 'node:inspector';

import { Graph } from '@lenke/core';
import { V, count, dedupe, gt, has, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 20);
const ARM = process.env.ARM ?? 'filtered';

const graph = new Graph();

for (let i = 0; i < N; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: ['Person'],
    properties: { age: i % 90, name: `p${i}` },
  });
}

let e = 0;

/*
 * ⚠️ THE REPEAT INDEX IS THE SECOND TERM, NOT `k` ALONE. `to = (a*k + b) % N` is INVARIANT under
 * `k -> k + N`, so a flat `for (k = 0; k < N*FANOUT; k++)` loop sends all of one vertex's FANOUT edges to
 * the SAME target — out-degree looks perfect and the graph is FUNCTIONAL (items 1516/1518). Splitting on
 * `d` is what makes the fan-out real, and the assertion below is what proves it.
 */
for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    graph.addEdge({
      id: `e${e}`,
      from: graph.getVertexById(`v${i}`),
      to: graph.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['KNOWS'],
      properties: {},
    });
    e += 1;
  }
}

/* 🔑 COUNT THE DISTINCT ENDPOINTS OF v0's EDGES — a degenerate generator passes every degree check. */
const sample = graph.getVertexById('v0');
const targets = new Set();

for (const edge of sample.adjFrom?.get('KNOWS') ?? []) {
  targets.add(edge.to.id);
}

if (targets.size !== FANOUT) {
  throw new Error(
    `fixture is degenerate: v0 reaches ${targets.size} distinct targets, want ${FANOUT}`,
  );
}

const PLANS = {
  filtered: traversal(V(), out('KNOWS'), has('age', gt(44)), count()),
  bare: traversal(V(), out('KNOWS'), count()),
  vacuous: traversal(V(), out('KNOWS'), has('age', gt(-1)), count()),
  nearside: traversal(V(), has('age', gt(44)), out('KNOWS'), count()),
  /* 🔑 SELECTIVE — where a predicate-first order should pay most, and vacuous where it pays least. */
  selective: traversal(V(), out('KNOWS'), has('age', gt(85)), count()),
  dedupe_count: traversal(V(), out('KNOWS'), dedupe(), count()),
  /* 🔑 ITEM 2128's TARGETS, nominated by ABSOLUTE cost: 244 ms and 135 ms, both healthy in ratio. */
  twohop_vac: traversal(V(), out('KNOWS'), out('KNOWS'), has('age', gt(-1)), count()),
  twohop_half: traversal(V(), out('KNOWS'), out('KNOWS'), has('age', gt(44)), count()),
  values_vac: traversal(V(), out('KNOWS'), has('age', gt(-1)), values('age')),
  /* ⚠️ CONTROLS this rung cannot reach. */
  twohop_ctl: traversal(V(), out('KNOWS'), out('KNOWS'), count()),
  values_ctl: traversal(V(), out('KNOWS'), has('age', gt(44)), values('age')),
};
const plan = PLANS[ARM];
/* 🔑 The plan is built ONCE, outside the window — this measures execution, not plan construction. */
const run = plan === undefined ? undefined : () => toArray(plan, graph);

if (run === undefined) {
  throw new Error(`ARM must be one of ${Object.keys(ARMS).join(', ')}`);
}

for (let r = 0; r < 4; r += 1) {
  run();
}

const session = new Session();

session.connect();

const call = (method, params) =>
  new Promise((resolve, reject) => {
    session.post(method, params, (err, res) => (err ? reject(err) : resolve(res)));
  });

await call('Profiler.enable');
await call('Profiler.setSamplingInterval', { interval: 100 });
await call('Profiler.start');

const t0 = performance.now();
let answer = 0;

for (let r = 0; r < REPS; r += 1) {
  [answer] = run();
}

const wall = performance.now() - t0;
const { profile } = await call('Profiler.stop');

session.disconnect();

const total = profile.nodes.reduce((acc, n) => acc + (n.hitCount ?? 0), 0);
const byFn = new Map();

for (const node of profile.nodes) {
  const hits = node.hitCount ?? 0;

  if (hits === 0) {
    continue;
  }

  const { functionName, url, lineNumber } = node.callFrame;
  const parts = String(url).split('/');
  const [file] = parts.slice(-1);
  /* ⚠️ A LENGTH TEST, NOT `??` — an anonymous frame's name is '', falsy but not nullish (item 2117). */
  const name = functionName.length > 0 ? functionName : '(anonymous)';

  byFn.set(
    `${name}  ${file}:${lineNumber + 1}`,
    (byFn.get(`${name}  ${file}:${lineNumber + 1}`) ?? 0) + hits,
  );
}

console.log(
  `\n  ARM=${ARM}  N=${N} edges=${e} fanout=${FANOUT}  ${REPS} reps in ${wall.toFixed(0)} ms (${(wall / REPS).toFixed(1)} ms/rep)  answer=${answer}`,
);
console.log(`  ${total} samples in the WINDOW (fixture build excluded by construction)\n`);
console.log(`  ${'self%'.padStart(7)}  ${'samples'.padStart(8)}  frame`);

for (const [key, hits] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) {
  console.log(
    `  ${((hits / total) * 100).toFixed(1).padStart(6)}%  ${String(hits).padStart(8)}  ${key}`,
  );
}
