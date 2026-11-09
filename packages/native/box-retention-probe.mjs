/**
 * DOES `Graph.elementProperties` RETAIN THE BOX OF A REMOVED ELEMENT? (item 1765)
 *
 * Found while pricing `#commitNormalized` on the insert path (item 1764): across `Graph.ts`,
 * `Vertex.ts` and `Edge.ts` the map is only ever `new Map()`, `.get()` and `.set()` — **there is no
 * `.delete()` anywhere.** If that means a removed element's property box stays, the map grows
 * without bound under remove-churn, which is a memory question rather than a speed one and is not
 * something any existing probe looks at.
 *
 * ⚠️ IT IS NOT A WRONG ANSWER, checked first: `#commitNormalized` always REPLACES `box.bag`, so an
 * id that is removed and re-added overwrites the stale bag rather than inheriting it. So this is
 * about retention, not correctness — which is exactly why no correctness test would ever see it.
 *
 * Reported as counts, not as a leak verdict: `elementLabels` is checked alongside because it is the
 * sibling map with the same shape, and the vertex/edge count is the baseline the boxes should track.
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 20_000);
const ROUNDS = Number(process.env.ROUNDS ?? 3);

const sizeOf = (m) => (m instanceof Map ? m.size : -1);

// Heap is reported alongside the counts so the retention has a SIZE and not just a cardinality.
// ⚠️ `--expose-gc` makes this meaningful; without it the reading includes uncollected garbage and
// overstates retention. The probe says which mode it ran in rather than pretending.
const heapMb = () => {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }

  return Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
};

const snapshot = (g, when) => ({
  when,
  vertices: g.vertexCount,
  edges: g.edgeCount,
  elementProperties: sizeOf(g.elementProperties),
  elementLabels: sizeOf(g.elementLabels),
  heapMb: heapMb(),
  forcedGc: typeof globalThis.gc === 'function',
});

const g = new Graph();
const out = [snapshot(g, 'empty')];

for (let r = 0; r < ROUNDS; r += 1) {
  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${r}-${i}`, labels: ['P'], properties: { n: i, s: `s${i}` } });
  }

  out.push(snapshot(g, `after add round ${r}`));

  for (let i = 0; i < N; i += 1) {
    const v = g.getVertexById(`v${r}-${i}`);

    if (v) {
      g.removeVertex(v);
    }
  }

  out.push(snapshot(g, `after remove round ${r}`));
}

for (const s of out) {
  console.log(JSON.stringify(s));
}
