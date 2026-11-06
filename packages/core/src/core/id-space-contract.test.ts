import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';

/**
 * Ids must be unique across BOTH element kinds, not merely within each (item 1588, decided at
 * 1589).
 *
 * ⚠️ THIS FILE PINS A LIMITATION, NOT A DESIRED BEHAVIOUR. `verticesById` and `edgesById` are
 * separate maps, but `elementProperties` and `elementLabels` are each keyed by the BARE id and
 * shared, so an edge reusing a vertex's id replaces that vertex's labels and properties. The
 * owner's decision was to document that rather than split the storage per kind.
 *
 * It is tested anyway, for two reasons:
 *
 *   - **so the documented contract cannot drift silently.** `addEdge`'s doc comment makes a
 *     specific promise about what happens; if someone later changes the storage, these tests fail
 *     and the doc gets updated with it. A limitation recorded only in prose is one nobody notices
 *     going stale.
 *   - **so the SHAPE of the loss is pinned, not just its existence.** The dangerous part is not the
 *     overwrite, it is that `vertexCount`, the vertex object's identity and the label index all
 *     survive it — which is what makes a label-index count still answer 2 while a property filter
 *     answers 0. Anyone reading only the first of those would conclude the graph is fine.
 *
 * ⚠️ NOT GUARDED, deliberately: the Rust engine ACCEPTS a colliding id and answers correctly, so
 * throwing here would trade silent data loss for a cross-engine divergence.
 */
describe('ids are expected to be unique across vertices AND edges', () => {
  const colliding = (): { graph: Graph; vertex: ReturnType<Graph['addVertex']> } => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'x', labels: ['P'], properties: { k: 1 } });
    const b = graph.addVertex({ id: 'y', labels: ['P'], properties: { k: 2 } });

    graph.addEdge({ id: 'x', from: a, to: b, labels: ['E'] });

    return { graph, vertex: a };
  };

  test('the uncollided case is unaffected — the control', () => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'x', labels: ['P'], properties: { k: 1 } });
    const b = graph.addVertex({ id: 'y', labels: ['P'], properties: { k: 2 } });

    graph.addEdge({ id: 'e1', from: a, to: b, labels: ['E'] });

    expect([...a.labels]).toEqual(['P']);
    expect(a.properties.k).toBe(1);
  });

  test('an edge reusing a vertex id replaces that vertex LABELS and PROPERTIES', () => {
    const { vertex } = colliding();

    // The documented loss. If this starts failing because the storage was split per kind, that is
    // the FIX — update `addEdge`'s doc comment and this file together.
    expect([...vertex.labels]).toEqual(['E']);
    expect(vertex.properties).toEqual({});
  });

  test('⚠️ and the loss is SILENT: identity, counts and the label index all survive it', () => {
    const { graph, vertex } = colliding();

    // Every cheap sanity check still passes, which is what makes this worth documenting.
    expect(graph.vertexCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    // O(1) access by id still returns the same object — a stated project invariant, unaffected.
    expect(graph.verticesById.get('x')).toBe(vertex);
    expect(graph.edgesById.get('x')).toBeDefined();
    // The label index still lists the vertex under its ORIGINAL label, which no longer matches the
    // labels the element itself reports. That inconsistency is the shape of the hazard.
    expect([...(graph.verticesByLabel.get('P') ?? [])].map((v) => v.id).sort()).toEqual(['x', 'y']);
    expect([...vertex.labels]).not.toContain('P');
  });

  test('a VERTEX reusing an edge id loses in the same way, in the other order', () => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = graph.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
    const e = graph.addEdge({ id: 'shared', from: a, to: b, labels: ['E'], properties: { w: 7 } });

    expect(e.properties.w).toBe(7);

    graph.addVertex({ id: 'shared', labels: ['Q'], properties: { z: 9 } });

    // The collision is symmetric: whichever element is added SECOND wins the shared box. Pinned so
    // the contract reads as "unique across both kinds" and not "edges must avoid vertex ids".
    expect([...e.labels]).toEqual(['Q']);
    expect(e.properties.w).toBeUndefined();
  });
});
