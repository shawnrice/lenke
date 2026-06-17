import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, order, range, skip, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, skip tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it gets the first three', () => {
      const r = run(traversal(V(), range(0, 3)), tinkerGraph);
      const xs = arr(r) as Array<{ properties: { name: string } }>;
      expect(xs.map((x) => x.properties.name)).toEqual(['marko', 'vadas', 'josh']);
    });

    test('it can skip on the low end', () => {
      const r = run(traversal(V(), values('age'), skip(2)), tinkerGraph);
      expect(arr(r)).toEqual([32, 35]);
    });

    test('it can have an open end', () => {
      const r = run(traversal(V(), values('name'), skip(3)), tinkerGraph);
      expect(arr(r)).toEqual(['peter', 'lop', 'ripple']);
    });

    // doc: g.V().values('age').order() — 27; 29; 32; 35
    test('order() on age gives the natural ordering (sanity for skip)', () => {
      const r = arr(run(traversal(V(), values('age'), order()), tinkerGraph));
      expect(r).toEqual([27, 29, 32, 35]);
    });

    // doc: g.V().values('age').order().skip(2) — 32; 35
    test('order().skip(2) drops the two lowest ages', () => {
      const r = arr(run(traversal(V(), values('age'), order(), skip(2)), tinkerGraph));
      expect(r).toEqual([32, 35]);
    });

    // doc: skip(n) is equivalent to range(n, -1)
    test('skip(n) is equivalent to range(n, -1)', () => {
      const a = arr(run(traversal(V(), values('age'), order(), skip(2)), tinkerGraph));
      const b = arr(run(traversal(V(), values('age'), order(), range(2, -1)), tinkerGraph));
      expect(a).toEqual(b);
    });
  });
});
