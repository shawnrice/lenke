import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, valueMap } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, valueMap tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it can get all properties', () => {
      const result = arr(run(traversal(V(), valueMap()), tinkerGraph));
      expect(result).toEqual([
        { name: 'marko', age: 29 },
        { name: 'vadas', age: 27 },
        { name: 'josh', age: 32 },
        { name: 'peter', age: 35 },
        { name: 'lop', lang: 'java' },
        { name: 'ripple', lang: 'java' },
      ]);
    });

    test('it can get a single property', () => {
      const result = arr(run(traversal(V(), valueMap('age')), tinkerGraph));
      expect(result).toEqual([{ age: 29 }, { age: 27 }, { age: 32 }, { age: 35 }, {}, {}]);
    });
  });
});
