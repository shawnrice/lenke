/**
 * THE PROFILE HARNESS FOR `slotChainCount`, kept separate from `gremlin-chain-memo-probe.mjs`
 * because the probe builds a FRESH GRAPH PER REP and that ingest work would dominate any profile
 * taken through it.
 *
 * Target: the ~63 ms FIXED per-call cost of a gremlin 3-hop chain count, which is nearly flat in the
 * number of hops — +2.4 ms for a whole extra hop against a 67 ms base, so the cost is not the walk.
 * One graph built once, then many measured calls, so the fixture cannot dominate — the mistake item
 * 1671 made, where a 4x200,000-vertex fixture against ~22,000 measured ops put ~97% of the samples in
 * `build()`.
 *
 * At 100,000 vertices / 400,000 edges, 100 calls, 67.40 ms/call:
 *
 *     28.9%  walkBucket          the memo FILL
 *     24.0%  degreeOfTypes       the LAST hop's degree sum, not memoized
 *     16.9%  slotChainCount
 *      9.9%  expandSlot          the memo fill's per-slot half
 *      0.4%  memoReserve
 *
 * ⚠️ ~8% OF THE SAMPLES ARE STILL FIXTURE (`indexEdgeLabel` 2.5%, `getEdgeById` 1.8%,
 * `#commitNormalized` 1.3%, `commitElementLabels` 1.1%, plus `addVertex`/`insertEdge`). Raise CALLS
 * before reading anything below a couple of percent here.
 */
import { Graph } from '@lenke/core';
import { count, hasLabel, out, toArray, traversal, V } from '@lenke/gremlin';

const N = Number(process.env.N ?? 100_000);
const FANOUT = Number(process.env.FANOUT ?? 4);
const CALLS = Number(process.env.CALLS ?? 100);

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
}

let e = 0;

for (let i = 0; i < N; i += 1) {
  const deg = 1 + ((i * 2654435761) % (2 * FANOUT - 1));

  for (let r = 0; r < deg; r += 1) {
    g.addEdge({
      id: `e${e}`,
      from: vs[i],
      to: vs[(i * 7919 + r * 104_729 + 13) % N],
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }
}

const plan = traversal(V(), hasLabel('P'), out('E'), out('E'), out('E'), count());

toArray(plan, g); // warm

const t0 = performance.now();

for (let i = 0; i < CALLS; i += 1) {
  toArray(plan, g);
}

const ms = performance.now() - t0;
console.log(`${CALLS} calls, ${(ms / CALLS).toFixed(2)} ms/call over ${N}v/${g.edgeCount}e`);
