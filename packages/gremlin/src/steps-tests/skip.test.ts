import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, range, skip, values } from '../steps.js';
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
  });
});
