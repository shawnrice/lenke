import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { E, V, drop, hasLabel, properties, property, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('drop() mutation', () => {
  test('drop() on a vertex removes it from the graph and emits nothing', () => {
    const g = createTestTinkerGraph();
    const before = g.vertexCount;
    const r = arr(run(traversal(V('2'), drop()), g));
    expect(r).toEqual([]);
    expect(g.vertexCount).toBe(before - 1);
    expect(g.getVertexById('2')).toBeNull();
  });

  test('drop() on a vertex cascades to its incident edges', () => {
    const g = createTestTinkerGraph();
    // Marko (id=1) has 3 outgoing edges in the fixture.
    const edgesBefore = g.edgeCount;
    const incidentEdgeCount = [...g.edges].filter(
      (e) => e.from.id === '1' || e.to.id === '1',
    ).length;
    expect(incidentEdgeCount).toBeGreaterThan(0);
    arr(run(traversal(V('1'), drop()), g));
    expect(g.edgeCount).toBe(edgesBefore - incidentEdgeCount);
  });

  test('drop() on edges removes them but leaves vertices intact', () => {
    const g = createTestTinkerGraph();
    const vBefore = g.vertexCount;
    arr(run(traversal(E(), hasLabel('CREATED'), drop()), g));
    // All CREATED edges gone; vertex count unchanged.
    expect(g.vertexCount).toBe(vBefore);
    expect([...g.edges].some((e) => e.labels.has('CREATED'))).toBe(false);
  });
});

describe('.properties(k).drop() removes a property (null is first-class)', () => {
  // Divergence from TinkerPop: `property(k, null)` STORES a present null rather
  // than disallowing/removing it. The Gremlin-native way to DELETE a property is
  // to traverse to the property element and `.drop()` it.
  test('property(k, null) stores a present null; .properties(k).drop() deletes it', () => {
    const g = createTestTinkerGraph();

    // property('nick', null) stores a present null (visible, not a removal).
    arr(run(traversal(V('1'), property('nick', null)), g));
    const v = g.getVertexById('1')!;
    expect('nick' in v.properties).toBe(true);
    expect(v.properties.nick).toBe(null);
    expect(arr(run(traversal(V('1'), values('nick')), g))).toEqual([null]);

    // .properties('nick').drop() removes it outright.
    arr(run(traversal(V('1'), properties('nick'), drop()), g));
    expect('nick' in g.getVertexById('1')!.properties).toBe(false);
    expect(arr(run(traversal(V('1'), values('nick')), g))).toEqual([]);
  });

  test('.properties(k).drop() removes a real-valued property too', () => {
    const g = createTestTinkerGraph();
    arr(run(traversal(V('1'), properties('age'), drop()), g));
    expect('age' in g.getVertexById('1')!.properties).toBe(false);
  });
});
