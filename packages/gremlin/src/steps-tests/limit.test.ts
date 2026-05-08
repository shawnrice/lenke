import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasLabel, limit, range, skip, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, limit tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it limits to three', () => {
      const r = run(traversal(V(), limit(3), values('name')), tinkerGraph);
      expect(arr(r)).toEqual(['marko', 'vadas', 'josh']);
    });

    test('it can skip and take', () => {
      const r = run(traversal(V(), values('age'), skip(2), limit(1)), tinkerGraph);
      expect(arr(r)).toEqual([32]);
    });

    test('it can have an open end', () => {
      const r = run(traversal(V(), hasLabel('SOFTWARE'), values('name'), limit(90)), tinkerGraph);
      expect(arr(r)).toEqual(['lop', 'ripple']);
    });

    // doc: g.V().limit(2) — v[1]; v[2]
    test('limit(2) yields the first two vertices', () => {
      const r = arr(run(traversal(V(), limit(2)), tinkerGraph)) as Array<{ id: string }>;
      expect(r.map((v) => v.id)).toEqual(['1', '2']);
    });

    // doc: limit(2) is equivalent to range(0, 2)
    test('limit(n) is equivalent to range(0, n)', () => {
      const lim = arr(run(traversal(V(), limit(2)), tinkerGraph)) as Array<{ id: string }>;
      const rng = arr(run(traversal(V(), range(0, 2)), tinkerGraph)) as Array<{ id: string }>;
      expect(lim.map((v) => v.id)).toEqual(rng.map((v) => v.id));
    });
  });
});
