import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, both, path, simplePath } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('simplePath tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V(1).both().both() — v[1]; v[4]; v[6]; v[1]; v[5]; v[3]; v[1]
  test('both().both() emits 7 traversers (sanity for simplePath setup)', () => {
    const r = arr(run(traversal(V('1'), both(), both()), tinkerGraph)) as Array<{
      id: string;
    }>;
    expect(r.length).toBe(7);
  });

  // doc: g.V(1).both().both().simplePath() — v[4]; v[6]; v[5]; v[3]
  test('simplePath drops cyclic traversers', () => {
    const r = arr(
      run(traversal(V('1'), both(), both(), simplePath()), tinkerGraph),
    ) as Array<{ id: string }>;
    expect(new Set(r.map((v) => v.id))).toEqual(new Set(['3', '4', '5', '6']));
    expect(r.length).toBe(4);
  });

  // doc: g.V(1).both().both().simplePath().path() — [v[1],v[?],v[?]] x 4
  test('simplePath().path() yields 4 acyclic length-3 paths', () => {
    const r = arr(
      run(traversal(V('1'), both(), both(), simplePath(), path()), tinkerGraph),
    ) as Array<Array<{ id: string }>>;
    expect(r.length).toBe(4);
    // Each path begins at v[1] and has 3 distinct vertices.
    for (const p of r) {
      const ids = p.map((e) => e.id);
      expect(ids[0]).toBe('1');
      expect(new Set(ids).size).toBe(3);
    }
  });
});
