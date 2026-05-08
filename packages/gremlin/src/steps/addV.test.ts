import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, addV, hasLabel, property } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('addV() mutation', () => {
  test('addV(label) inserts a new vertex and emits it', () => {
    const g = createTestTinkerGraph();
    const before = g.vertices.size;
    const r = arr(run(traversal(addV('PERSON'), property('name', 'kuppitz')), g));
    expect(g.vertices.size).toBe(before + 1);
    expect(r).toHaveLength(1);
    const v = r[0] as { properties: Record<string, unknown>; labels: Set<string> };
    expect(v.labels.has('PERSON')).toBe(true);
    expect(v.properties.name).toBe('kuppitz');
  });

  test('addV() with no label creates a label-less vertex', () => {
    const g = createTestTinkerGraph();
    const r = arr(run(traversal(addV()), g));
    const v = r[0] as { labels: Set<string> };
    expect(v.labels.size).toBe(0);
  });

  test('addV() mid-traversal emits one new vertex per upstream traverser', () => {
    const g = createTestTinkerGraph();
    const before = g.vertices.size;
    // For each PERSON, create a SHADOW vertex.
    arr(run(traversal(V(), hasLabel('PERSON'), addV('SHADOW')), g));
    expect(g.vertices.size).toBe(before + 4); // 4 persons in fixture
    const shadows = arr(run(traversal(V(), hasLabel('SHADOW')), g));
    expect(shadows).toHaveLength(4);
  });
});
