import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasLabel, limit, skip, values } from '../steps.js';
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
  });
});
