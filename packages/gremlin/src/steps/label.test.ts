import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, label, outE, properties } from '../steps.js';
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

    // doc: g.V('1').properties().label() — on a `{key, value}` property object,
    // `label()` returns the property's key (TinkerPop treats the key as the
    // property's label).
    test('label() on a property object returns its key', () => {
      const result = arr(run(traversal(V('1'), properties(), label()), tinkerGraph));
      // marko's properties: name, age (insertion order)
      expect((result as string[]).sort()).toEqual(['age', 'name']);
    });
  });
});
