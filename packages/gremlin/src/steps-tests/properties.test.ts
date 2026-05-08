import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, count, hasId, properties } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, properties tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it gets the specified property as {key, value} for one vertex', () => {
      const result = arr(run(traversal(V(), hasId('1'), properties('name')), tinkerGraph));
      expect(result).toEqual([{ key: 'name', value: 'marko' }]);
    });

    test('it gets all named properties across all vertices', () => {
      const result = arr(run(traversal(V(), properties('name')), tinkerGraph));
      expect(result).toEqual([
        { key: 'name', value: 'marko' },
        { key: 'name', value: 'vadas' },
        { key: 'name', value: 'josh' },
        { key: 'name', value: 'peter' },
        { key: 'name', value: 'lop' },
        { key: 'name', value: 'ripple' },
      ]);
    });

    test('multiple keys flatten across each element', () => {
      const result = arr(run(traversal(V(), hasId('1'), properties('name', 'age')), tinkerGraph));
      expect(result).toEqual([
        { key: 'name', value: 'marko' },
        { key: 'age', value: 29 },
      ]);
    });

    test('no keys yields all properties of each element', () => {
      const result = arr(run(traversal(V(), hasId('3'), properties()), tinkerGraph));
      expect(result).toEqual([
        { key: 'name', value: 'lop' },
        { key: 'lang', value: 'java' },
      ]);
    });

    // doc: g.V(v).properties('name').count() — count of name properties for one vertex.
    test('properties + count returns the number of property objects', () => {
      const result = arr(
        run(traversal(V(), hasId('1'), properties('name'), count()), tinkerGraph),
      );
      expect(result).toEqual([1]);
    });
  });
});
