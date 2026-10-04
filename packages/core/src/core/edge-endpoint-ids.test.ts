import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

// `Edge.fromId`/`toId` and the single-lookup `indexEdgeLabel` (audit item 140).
//
// The accessors must agree with `from.id`/`to.id` in every case, because the adjacency index
// is keyed by whichever one it reads — if they can ever disagree, the index keys and the
// traversal's lookups part company and every query over that edge silently misses it.

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: {} });
  g.addVertex({ id: 'b', labels: ['P'], properties: {} });
  g.addVertex({ id: 'c', labels: ['P'], properties: {} });

  return g;
};

const v = (g: Graph, id: string) => {
  const found = g.getVertexById(id);

  if (found === null) {
    throw new Error(`fixture lost ${id}`);
  }

  return found;
};

describe('Edge endpoint ids', () => {
  test('agree with the resolved vertices', () => {
    const g = build();
    const e = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });

    expect(e.fromId).toBe('a');
    expect(e.toId).toBe('b');
    expect(e.fromId).toBe(e.from.id);
    expect(e.toId).toBe(e.to.id);
  });

  test('agree for a SELF-LOOP, where both ends are one vertex', () => {
    const g = build();
    const e = g.addEdge({ from: v(g, 'a'), to: v(g, 'a'), labels: ['T'], properties: {} });

    expect(e.fromId).toBe('a');
    expect(e.toId).toBe('a');
    expect(e.fromId).toBe(e.from.id);
  });

  test('do not resolve the vertex, so they survive a removed endpoint', () => {
    const g = build();
    const e = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });

    g.removeVertex(v(g, 'b'));

    // The id is stored on the edge, so it reads back even though `to` can no longer resolve.
    // This is what lets `deIndexEdgeLabel` clean up after a cascade.
    expect(e.toId).toBe('b');
  });
});

describe('the adjacency index after the single-lookup rewrite', () => {
  test('an edge lands in all three indexes under its label', () => {
    const g = build();
    const e = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });

    expect([...(g.edgesByLabel.get('T') ?? [])]).toEqual([e]);
    expect([...(g.edgesFromByLabel.get('a')?.get('T') ?? [])]).toEqual([e]);
    expect([...(g.edgesToByLabel.get('b')?.get('T') ?? [])]).toEqual([e]);
    // And NOT in the opposite direction's bucket.
    expect(g.edgesToByLabel.get('a')?.get('T')).toBeUndefined();
  });

  test('a MULTI-label edge is indexed under every label, and counted once', () => {
    const g = build();
    const before = g.multiTypeEdgeCount;
    const e = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T', 'S'], properties: {} });

    expect([...(g.edgesFromByLabel.get('a')?.get('T') ?? [])]).toEqual([e]);
    expect([...(g.edgesFromByLabel.get('a')?.get('S') ?? [])]).toEqual([e]);
    expect(g.multiTypeEdgeCount).toBe(before + 1);
  });

  test('a single-label edge does NOT bump the multi-type count', () => {
    const g = build();
    const before = g.multiTypeEdgeCount;

    g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });

    expect(g.multiTypeEdgeCount).toBe(before);
  });

  test('PARALLEL edges both land in the same bucket', () => {
    const g = build();
    const e1 = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });
    const e2 = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });

    expect(e1).not.toBe(e2);
    expect([...(g.edgesFromByLabel.get('a')?.get('T') ?? [])]).toEqual([e1, e2]);
    expect([...(g.edgesToByLabel.get('b')?.get('T') ?? [])]).toEqual([e1, e2]);
  });

  test('a SELF-LOOP is in both the from and to buckets of its one vertex', () => {
    const g = build();
    const e = g.addEdge({ from: v(g, 'a'), to: v(g, 'a'), labels: ['T'], properties: {} });

    expect([...(g.edgesFromByLabel.get('a')?.get('T') ?? [])]).toEqual([e]);
    expect([...(g.edgesToByLabel.get('a')?.get('T') ?? [])]).toEqual([e]);
  });

  test('several labels on one vertex keep separate buckets', () => {
    const g = build();
    const t = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });
    const s = g.addEdge({ from: v(g, 'a'), to: v(g, 'c'), labels: ['S'], properties: {} });

    // The per-vertex map must hold BOTH labels — a create-if-absent that overwrote the map
    // instead of reusing it would lose the first.
    expect([...(g.edgesFromByLabel.get('a')?.get('T') ?? [])]).toEqual([t]);
    expect([...(g.edgesFromByLabel.get('a')?.get('S') ?? [])]).toEqual([s]);
    expect(g.edgesFromByLabel.get('a')?.size).toBe(2);
  });

  test('removal de-indexes and drops the emptied label entry', () => {
    const g = build();
    const e = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });

    g.removeEdge(e);

    expect(g.edgesFromByLabel.get('a')?.get('T')).toBeUndefined();
    expect(g.edgesToByLabel.get('b')?.get('T')).toBeUndefined();
    expect(g.edgesByLabel.get('T')?.size ?? 0).toBe(0);
  });

  test('removing one of two parallel edges leaves the other indexed', () => {
    const g = build();
    const e1 = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });
    const e2 = g.addEdge({ from: v(g, 'a'), to: v(g, 'b'), labels: ['T'], properties: {} });

    g.removeEdge(e1);

    expect([...(g.edgesFromByLabel.get('a')?.get('T') ?? [])]).toEqual([e2]);
  });
});
