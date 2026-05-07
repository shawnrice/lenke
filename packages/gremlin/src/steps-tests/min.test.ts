import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, inject, min, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP min tests', () => {
    test('min works with numbers', () => {
      const r = run(traversal(V(), values('age'), min()), tinkerGraph);
      expect(arr(r)).toEqual([27]);
    });

    test('min works with strings, again', () => {
      const r = run(traversal(V(), values('name'), min()), tinkerGraph);
      expect(arr(r)).toEqual(['josh']);
    });

    test('min filters out null', () => {
      const r = run(traversal(inject(null, 10, 9, null), min()), tinkerGraph);
      expect(arr(r)).toEqual([9]);
    });

    test('min takes null if that is all it got', () => {
      const r = run(traversal(inject(null, null, null, null), min()), tinkerGraph);
      expect(arr(r)).toEqual([null]);
    });
  });
});
