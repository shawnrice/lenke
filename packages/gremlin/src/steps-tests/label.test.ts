import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, label, outE } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, label tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it can get the label', () => {
      const result = arr(run(traversal(V(), label()), tinkerGraph));
      expect(result).toEqual(['PERSON', 'PERSON', 'PERSON', 'PERSON', 'SOFTWARE', 'SOFTWARE']);
    });

    test('it can get specific labels', () => {
      const result = arr(run(traversal(V('1'), outE(), label()), tinkerGraph));
      expect(result).toEqual(['KNOWS', 'KNOWS', 'CREATED']);
    });

    // properties() step is not in v2 — label() acting as keys() requires it.
    test.skip('it acts as `keys` when used on a regular object (properties() not in v2)', () => {});
  });
});
