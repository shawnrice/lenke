// `vertexVersion` is the NARROWER sibling of `topologyVersion`: it answers "did the vertex set
// itself change?" so a consumer can keep the part of a cached adjacency structure that only depends
// on which vertices exist. `csr-cache.ts`'s `vertexIndexFor` holds a CSR's `order` array and its
// vertex-to-index `Map` against it, which item 2435 priced at 41% of a rebuild.
//
// THREE PROPERTIES MAKE IT USABLE, and each is a separate failure if it breaks:
//
//   1. It advances SYNCHRONOUSLY. `version` and `epoch` are deferred to a task drain, so a cache
//      keyed on either serves a stale structure to the ordinary `g.addVertex(...); query(g, …)`
//      shape. This is the same contract `topology-version.test.ts` pins for its sibling.
//   2. It does NOT advance on an EDGE write. That is the whole point — if it did, the split would
//      be a no-op that still looked like an optimization, and nothing about the ANSWER would change
//      so no other test would notice. This is the load-bearing case.
//   3. It DOES advance on every vertex add and remove, including a remove-then-add that leaves
//      `vertexCount` unchanged. Under-invalidating here serves a WRONG ANSWER: reusing an `order`
//      array that no longer matches `verticesById` maps a CSR index to the wrong vertex.
import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph';

describe('vertexVersion advances on a vertex write and NOT on an edge write', () => {
  const addVertices = (g: Graph, n: number, from = 0) =>
    Array.from({ length: n }, (_, i) =>
      g.addVertex({ id: `v${from + i}`, labels: ['P'], properties: {} }),
    );

  test('a vertex add bumps it SYNCHRONOUSLY, with no drain', () => {
    const g = new Graph();
    const before = g.vertexVersion;

    addVertices(g, 3);

    // Synchronous: no await, no drain. Three adds, three bumps.
    expect(g.vertexVersion).toBe(before + 3);
  });

  test('an EDGE write does NOT bump it, while topologyVersion DOES', () => {
    const g = new Graph();
    const [a, b] = addVertices(g, 2);

    const vvBefore = g.vertexVersion;
    const tvBefore = g.topologyVersion;

    const e = g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });

    // THE LOAD-BEARING ASSERTION. An edge write leaves the vertex set alone, so the CSR's `order`
    // and `idx` stay valid and must be reusable. If this ever bumps, the split silently stops
    // paying without changing any answer.
    expect(g.vertexVersion).toBe(vvBefore);
    expect(g.topologyVersion).not.toBe(tvBefore);

    // And removing the edge is the same story.
    const tvAfterAdd = g.topologyVersion;

    g.removeEdge(e);

    expect(g.vertexVersion).toBe(vvBefore);
    expect(g.topologyVersion).not.toBe(tvAfterAdd);
  });

  test('a vertex remove bumps it, and so does a remove-then-add that leaves vertexCount equal', () => {
    const g = new Graph();
    const [a, b] = addVertices(g, 2);

    const afterAdds = g.vertexVersion;

    g.removeVertex(a);

    expect(g.vertexVersion).toBe(afterAdds + 1);

    // A remove plus an add leaves `vertexCount` where it started, which is exactly why
    // `vertexCount` cannot stand in for this counter. The ITERATION ORDER of `verticesById` has
    // changed, so a cached `order` array built before this is now wrong.
    const countBefore = g.vertexCount;
    const vvBefore = g.vertexVersion;

    g.removeVertex(b);
    addVertices(g, 1, 7);

    expect(g.vertexCount).toBe(countBefore);
    expect(g.vertexVersion).toBe(vvBefore + 2);
  });

  test('a vertex PROPERTY write does not bump it', () => {
    const g = new Graph();
    const [a] = addVertices(g, 1);

    const before = g.vertexVersion;

    a.setProperty('k', 1);

    // Neither which vertices exist nor the order they iterate in has changed.
    expect(g.vertexVersion).toBe(before);
  });
});
