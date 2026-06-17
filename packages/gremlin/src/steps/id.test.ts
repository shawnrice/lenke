import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, id, is, out, outE } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, id tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('id works', () => {
      const result = arr(run(traversal(V(), id()), tinkerGraph));
      expect(result).toEqual(['1', '2', '4', '6', '3', '5']);
    });

    // is() on the result of id() — v2 uses string IDs and predicate-form is().
    test('id with is can filter', () => {
      const result = arr(run(traversal(V('1'), out(), id(), is(eq('2'))), tinkerGraph));
      expect(result).toEqual(['2']);
    });

    test('we can get some from other vertices', () => {
      const result = arr(run(traversal(V('1'), outE(), id()), tinkerGraph));
      expect(result).toEqual(['7', '8', '9']);
    });
  });
});
