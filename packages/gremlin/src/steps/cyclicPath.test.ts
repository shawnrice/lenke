import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, both, cyclicPath, path } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('cyclicPath tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V(1).both().both().cyclicPath() — v[1]; v[1]; v[1]
  test('cyclicPath keeps only traversers whose path repeats', () => {
    const r = arr(
      run(traversal(V('1'), both(), both(), cyclicPath()), tinkerGraph),
    ) as Array<{ id: string }>;
    expect(r.map((v) => v.id)).toEqual(['1', '1', '1']);
  });

  // doc: g.V(1).both().both().cyclicPath().path() — [v[1],v[?],v[1]] x 3
  test('cyclicPath().path() yields 3 cyclic length-3 paths', () => {
    const r = arr(
      run(traversal(V('1'), both(), both(), cyclicPath(), path()), tinkerGraph),
    ) as Array<Array<{ id: string }>>;
    expect(r.length).toBe(3);
    for (const p of r) {
      const ids = p.map((e) => e.id);
      expect(ids[0]).toBe('1');
      expect(ids[ids.length - 1]).toBe('1');
    }
  });
});
