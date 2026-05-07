import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, both, inject, repeat, sum, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP sum tests', () => {
    test('sum works with numbers', () => {
      const r = run(traversal(V(), values('age'), sum()), tinkerGraph);
      expect(arr(r)).toEqual([123]);
    });

    test('sum works with repeat', () => {
      const r = run(
        traversal(V(), repeat(both()).times(3), values('age'), sum()),
        tinkerGraph,
      );
      expect(arr(r)).toEqual([1471]);
    });

    test('sum filters out null', () => {
      const r = run(traversal(inject(null, 10, 9, null), sum()), tinkerGraph);
      expect(arr(r)).toEqual([19]);
    });

    test('sum takes null if that is all it got', () => {
      const r = run(traversal(inject(null, null, null, null), sum()), tinkerGraph);
      expect(arr(r)).toEqual([null]);
    });
  });
});
