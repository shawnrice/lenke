/**
 * THE PROFILING COMPANION to `gremlin-match-selectivity-floor.ts` (item 1658).
 *
 * ⚠️ WHY A SECOND FILE RATHER THAN A FLAG ON THE FIRST. Item 1657 wanted to profile the selective
 * `match()` shape and could not: `node --cpu-prof` cannot run a `.ts` probe and `bun` has no
 * `--cpu-prof`, so a `PROF=` knob on the TypeScript probe is dead weight (one was added and removed
 * in that tick). Every profilable probe in this directory is `.mjs` for the same reason.
 *
 * ⚠️ AND NOT A SHAPE ON `runtime-profile-gremlin-probe.mjs`, which is the other obvious home: that
 * probe's fixture carries ONE edge type, and a selective second type can only be added by adding
 * edges — which changes the graph every other shape in it is measured against. Its numbers are
 * quoted across a dozen audit items.
 *
 * THE QUESTION. Item 1656 measured the solver at **11.07 ms for 6 solutions** and ~31.4 ms for
 * 29,990 — its cost is driven by the |V| x deg(T) candidates it enumerates and discards, not by the
 * answer. That is ~370 ns per discarded candidate, which looks like a constant worth removing. This
 * says where it goes.
 *
 *     node --cpu-prof --cpu-prof-dir=<dir> gremlin-match-selectivity-prof.mjs [rarity] [reps]
 *
 * ONE SHAPE PER PROCESS (item 762). The fixture build is ~0.4 s, so pick `reps` to put the query
 * well above it — 400 reps at rarity 500 is ~4.4 s of query against that.
 */
import { Graph } from '@lenke/core';
import { V, as_, count, match, out, pipe, toArray, traversal } from '@lenke/gremlin';

const RARITY = Number(process.argv[2] ?? 500);
const REPS = Number(process.argv[3] ?? 400);
const NODES = Number(process.env.NODES ?? 3000);
const DEG = Number(process.env.DEG ?? 10);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: {} });
}

const v = (i) => g.getVertexById(`v${i}`);

for (let i = 0; i < NODES; i += 1) {
  for (let j = 1; j <= DEG; j += 1) {
    const to = (i * 7919 + j * 104_729) % NODES;

    if (to !== i) {
      g.addEdge({ id: `t${i}_${j}`, from: v(i), to: v(to), labels: ['T'], properties: {} });
    }
  }
}

let sEdges = 0;

for (let i = 0; i < NODES; i += RARITY) {
  const to = (i * 31 + 7) % NODES;

  if (to !== i) {
    g.addEdge({ id: `s${i}`, from: v(i), to: v(to), labels: ['S'], properties: {} });
    sEdges += 1;
  }
}

const plan = traversal(
  V(),
  match(pipe(as_('a'), out('T'), as_('b')), pipe(as_('b'), out('S'), as_('c'))),
  count(),
);

// Warm, then the timed/profiled loop.
toArray(plan, g);

const t0 = performance.now();
let sink = 0;

for (let r = 0; r < REPS; r += 1) {
  sink += toArray(plan, g)[0];
}

const ms = performance.now() - t0;

console.log(
  JSON.stringify({
    rarity: RARITY,
    sEdges,
    reps: REPS,
    solutions: sink / REPS,
    msPerCall: Number((ms / REPS).toFixed(2)),
    queryMs: Number(ms.toFixed(0)),
  }),
);
