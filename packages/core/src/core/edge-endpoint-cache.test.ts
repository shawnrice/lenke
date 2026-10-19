// `Edge.from` / `Edge.to` cache the resolved endpoint VERTEX, so a consumer that walks adjacency
// stops paying a string-keyed `getVertexById` per edge (item 595: 2.4-2.6x on the shapes that read
// an endpoint per edge). `adjacency-box.test.ts` makes the same argument for `Vertex.adjFrom`, and
// its header is the rule this file follows too: a cache over graph-owned state is wrong only on the
// SECOND read, so a suite that builds a graph and queries it once misses every failure.
//
// A cached REFERENCE is a stronger claim than the box cache's, because a box is a stable container
// the graph mutates in place while a vertex object can in principle be REPLACED. Four paths have
// to hold for it to be safe, and this file pins the two that are reachable from the public API:
//
//   - `addVertex` with an existing id RETURNS the existing vertex and never replaces the object;
//   - `removeVertex` cascades to the incident edges, so no edge outlives its endpoint;
//   - a rollback re-adds the vertex FIRST and then its edges, both as fresh objects;
//   - `set graph` drops the cache, which is what a graph MOVE needs.
//
// The last one is why this file exists: a mutant deleting the invalidation from `set graph`
// SURVIVED the whole suite — 4,671 tests across 347 files — because nothing moved an edge between
// graphs and then read its endpoints.
import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

describe('the Edge endpoint cache', () => {
  test('the SECOND read returns the same vertex as the first', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: { n: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: { n: 2 } });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect(e.from).toBe(a);
    expect(e.to).toBe(b);
    // Again, now that the fields are populated — the read that a cache can get wrong.
    expect(e.from).toBe(a);
    expect(e.to).toBe(b);
    expect(e.from.properties.n).toBe(1);
    expect(e.to.properties.n).toBe(2);
  });

  test('a GRAPH MOVE re-resolves both endpoints in the new graph', () => {
    const g1 = new Graph();
    const a1 = g1.addVertex({ id: 'a', labels: ['N'], properties: { which: 'g1' } });
    const b1 = g1.addVertex({ id: 'b', labels: ['N'], properties: { which: 'g1' } });
    const e = g1.addEdge({ id: 'e', from: a1, to: b1, labels: ['E'], properties: {} });

    // Populate the cache against g1 FIRST, which is what makes the move observable.
    expect(e.from).toBe(a1);
    expect(e.to).toBe(b1);

    // A second graph with its own vertex objects under the SAME ids. Without the invalidation in
    // `set graph`, the edge keeps handing back g1's objects — and every property read through the
    // endpoint then reports the wrong graph's data while every id still looks right.
    const g2 = new Graph();
    const a2 = g2.addVertex({ id: 'a', labels: ['N'], properties: { which: 'g2' } });
    const b2 = g2.addVertex({ id: 'b', labels: ['N'], properties: { which: 'g2' } });

    e.graph = g2;

    expect(e.from).toBe(a2);
    expect(e.to).toBe(b2);
    expect(e.from).not.toBe(a1);
    expect(e.to).not.toBe(b1);
    // The ids are identical either way, so an id-level assertion would pass against the stale
    // objects. The PROPERTY is what distinguishes them.
    expect(e.from.properties.which).toBe('g2');
    expect(e.to.properties.which).toBe('g2');
  });

  test('`addVertex` on an existing id does not swap the object under a live edge', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: { n: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: { n: 2 } });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect(e.to).toBe(b);

    // This is one of the four paths the cache's safety rests on: a duplicate add RETURNS the
    // existing vertex. If it ever replaced it, every edge already holding the old reference would
    // be stale with no invalidation hook to catch it.
    const again = g.addVertex({ id: 'b', labels: ['Other'], properties: { n: 99 } });

    expect(again).toBe(b);
    expect(e.to).toBe(b);
    expect(e.to.properties.n).toBe(2);
  });

  test('removing a vertex takes its edges with it, so no edge outlives an endpoint', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });

    g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });
    expect(g.getEdgeById('e')).toBeTruthy();

    g.removeVertex(b);

    // The cascade is the third path the cache rests on: with the edge gone there is no holder of a
    // reference to the removed vertex, so a re-add under the same id cannot be observed stale.
    expect(g.getEdgeById('e')).toBeFalsy();

    const b2 = g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    const e2 = g.addEdge({ id: 'e2', from: a, to: b2, labels: ['E'], properties: {} });

    expect(e2.to).toBe(b2);
  });
});
