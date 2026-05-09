import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { E, V, drop, hasLabel } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('drop() mutation', () => {
  test('drop() on a vertex removes it from the graph and emits nothing', () => {
    const g = createTestTinkerGraph();
    const before = g.vertices.size;
    const r = arr(run(traversal(V('2'), drop()), g));
    expect(r).toEqual([]);
    expect(g.vertices.size).toBe(before - 1);
    expect(g.getVertexById('2')).toBeNull();
  });

  test('drop() on a vertex cascades to its incident edges', () => {
    const g = createTestTinkerGraph();
    // Marko (id=1) has 3 outgoing edges in the fixture.
    const edgesBefore = g.edges.size;
    const incidentEdgeCount = [...g.edges].filter(
      (e) => e.from.id === '1' || e.to.id === '1',
    ).length;
    expect(incidentEdgeCount).toBeGreaterThan(0);
    arr(run(traversal(V('1'), drop()), g));
    expect(g.edges.size).toBe(edgesBefore - incidentEdgeCount);
  });

  test('drop() on edges removes them but leaves vertices intact', () => {
    const g = createTestTinkerGraph();
    const vBefore = g.vertices.size;
    arr(run(traversal(E(), hasLabel('CREATED'), drop()), g));
    // All CREATED edges gone; vertex count unchanged.
    expect(g.vertices.size).toBe(vBefore);
    expect([...g.edges].some((e) => e.labels.has('CREATED'))).toBe(false);
  });
});
