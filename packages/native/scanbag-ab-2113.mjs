/*
 * Item 2113 — the A/B for admitting `store` to item 2078's fused scan-bag walk.
 *
 * 🔑 THE TARGET is `V().store(k).values(key)` — the bag step BEFORE the projection. `aggregate` in that
 * position has been fused since item 2078; `store` was refused there for item 2070's reason, which is
 * about a DRAINED result and does not describe this walk (a generator, already as lazy as `store` needs).
 *
 * ⚠️ THREE CONTROLS, each chosen because the gate CANNOT move it:
 *   - `agg_ctl`   — already fused before this item, so it must not move.
 *   - `floor_ctl` — the same scan with no bag at all: the floor the target should approach.
 *   - `hop_ctl`   — the HOP form (`out('E')` before the bag), which this fusion does not claim. ⚠️ It is
 *     the screen's heaviest store row, so a change here moving it would mean the gate is wider than it
 *     reads.
 */
import { Graph } from '@lenke/core';
import { aggregate, out, store, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200000);
const REPS = Number(process.env.REPS ?? 11);
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i % 97 } });
}

/*
 * ⚠️ The target shape never walks an edge, but `hop_ctl` does — so the edges are built for the control
 * and the target is unaffected by them.
 *
 * ⚠️ SPLIT ON THE REPEAT INDEX, not on `k % N`: CLAUDE.md's generator rule, since `(a*k+b) % N` is
 * invariant under `k -> k + N` and would send one vertex's whole fanout to a single target.
 */
let e = 0;

for (let d = 0; d < 3; d += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

const shapes = {
  target: () => traversal(V(), store('x'), values('n')),
  agg_ctl: () => traversal(V(), aggregate('x'), values('n')),
  floor_ctl: () => traversal(V(), values('n')),
  hop_ctl: () => traversal(V(), out('E'), store('x'), values('n')),
};
const printed = [];

for (const [name, make] of Object.entries(shapes)) {
  const plan = make();
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    toArray(plan, g);
    series.push(performance.now() - t0);
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  printed.push(`${name}=${kept[Math.floor(kept.length / 2)].toFixed(2)}`);
}

console.log(`  ${printed.join(' ')}`);
