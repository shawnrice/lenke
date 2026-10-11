// `Vertex.adjFrom` / `adjTo` cache the vertex's adjacency box, which the graph keys by ID STRING,
// so every consumer that already holds the vertex object stops hashing (audit items 162, 321).
//
// A cache over graph-owned state fails in exactly four ways, and every one of them is wrong only
// on the SECOND read — which is why a suite that builds a graph and queries it once would miss
// all four.
import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

describe('the adjacency box', () => {
  test('a zero-degree vertex picks up its FIRST edge', async () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });

    // Read the box BEFORE any edge exists. The graph has no entry for `a` yet, so there is
    // nothing to cache — and `??=` must therefore not remember the absence.
    expect(g.outDegree(a, 'E')).toBe(0);
    expect(a.adjFrom).toBeUndefined();

    g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    // The box exists now. A cache that had stored `undefined` would still read 0 here.
    expect(g.outDegree(a, 'E')).toBe(1);
    expect(g.inDegree(b, 'E')).toBe(1);
    // Asserted POSITIVELY as well, because `toBeUndefined()` also passes when the property does
    // not exist at all — on its own it is satisfied by an engine with no box.
    expect(a.adjFrom?.get('E')?.size).toBe(1);
    expect(b.adjTo?.get('E')?.size).toBe(1);

    await Promise.resolve();
  });

  test('a cached box tracks later edges on the same vertex', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['N'], properties: {} });

    g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    expect(g.outDegree(a, 'E')).toBe(1); // caches the box

    // `insertEdge` MUTATES the inner map in place rather than replacing it, which is what makes
    // holding the reference sound. If it ever replaced it, this would read 1 forever.
    g.addEdge({ id: 'e2', from: a, to: c, labels: ['E'], properties: {} });
    expect(g.outDegree(a, 'E')).toBe(2);

    // ...and a NEW edge type on an already-cached vertex, which adds a key to the same map.
    g.addEdge({ id: 'e3', from: a, to: c, labels: ['OTHER'], properties: {} });
    expect(g.outDegree(a, 'OTHER')).toBe(1);
    expect(g.outDegree(a, 'E')).toBe(2);
  });

  test('a removal is visible through a cached box', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect(g.outDegree(a, 'E')).toBe(1); // caches the box

    g.removeEdge(e);

    expect(g.outDegree(a, 'E')).toBe(0);
    expect(g.inDegree(b, 'E')).toBe(0);
  });

  test('an evicted vertex does not keep reading the graph it left', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });

    g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });
    expect(g.outDegree(a, 'E')).toBe(1); // caches the box

    g.removeVertex('a');

    // `evict` drops the box, so the detached vertex reads a null graph rather than the adjacency
    // it remembered. Through the public surface that is an empty set, not a stale edge.
    expect(a.edgesFromByLabel('E').size).toBe(0);
    expect(a.adjFrom).toBeUndefined();
  });

  test('a re-added vertex of the same id reads the LIVE adjacency', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });

    g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });
    expect(g.outDegree(a, 'E')).toBe(1);

    g.removeVertex('a');
    const a2 = g.addVertex({ id: 'a', labels: ['N'], properties: {} });

    // The id is the same, so the graph's own map may still hold the old box under that key. The
    // re-added vertex must report what the graph says NOW, and the old handle must not resurrect.
    expect(g.outDegree(a2, 'E')).toBe(g.edgesFromByLabel.get('a')?.get('E')?.size ?? 0);
    expect(a.adjFrom).toBeUndefined();
  });

  test('a cloned graph reads its own adjacency, not the source graph', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });

    g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });
    expect(g.outDegree(a, 'E')).toBe(1); // caches on the SOURCE's vertex

    const clone = g.clone();
    const ca = clone.getVertexById('a');
    const cb = clone.getVertexById('b');

    expect(ca).toBeDefined();
    expect(clone.outDegree(ca!, 'E')).toBe(1);

    // The two graphs are independent: a write to the clone must not be visible through the
    // source's cached box, which is the failure a box shared across graphs would produce.
    clone.addEdge({ id: 'e2', from: ca!, to: cb!, labels: ['E'], properties: {} });

    expect(clone.outDegree(ca!, 'E')).toBe(2);
    expect(g.outDegree(a, 'E')).toBe(1);
  });

  test('a vertex reassigned to a new graph does not read the old adjacency', () => {
    // The twin of `label-box.test.ts`'s "reassigned to a new graph" case, which exercises the
    // same public setter for `#lbox` and `#box`. The adjacency box was NOT covered by it, and the
    // mutant that deletes its clearing in `set graph` survived until this test existed — the same
    // symmetric-case gap item 314 recorded, where a hazard is tested for one box and read off for
    // the others.
    const g1 = new Graph();
    const a = g1.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g1.addVertex({ id: 'b', labels: ['N'], properties: {} });

    g1.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });
    expect(g1.outDegree(a, 'E')).toBe(1); // caches the box, pointing into g1's map

    const g2 = new Graph();

    a.graph = g2;

    // g2 knows nothing about this id, so there is no adjacency to read. A box that survived the
    // move would report g1's edge from a vertex that is no longer in g1.
    expect(a.adjFrom).toBeUndefined();
    expect(a.edgesFromByLabel('E').size).toBe(0);
    expect(g2.outDegree(a, 'E')).toBe(0);

    // ...and the ORIGINAL graph still holds its own adjacency, untouched.
    expect(g1.edgesFromByLabel.get('a')?.get('E')?.size).toBe(1);
  });

  test('findEdge reads the box', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['N'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['N'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['N'], properties: {} });

    const e = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: {} });

    expect(g.findEdge(a, b, 'E')).toBe(e);
    expect(g.findEdge(a, c, 'E')).toBeUndefined();

    // After a second edge is added to an already-cached box.
    const e2 = g.addEdge({ id: 'e2', from: a, to: c, labels: ['E'], properties: {} });
    expect(g.findEdge(a, c, 'E')).toBe(e2);
  });
});
