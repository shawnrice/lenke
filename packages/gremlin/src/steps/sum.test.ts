import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { Scope, V, both, fold, inject, max, mean, min, repeat, sum, values } from '../steps.js';
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
      const r = run(traversal(V(), repeat(both()).times(3), values('age'), sum()), tinkerGraph);
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

    // doc: g.V().values('age').fold().sum(Scope.local) — 123
    test('sum(Scope.local) sums elements of a folded list', () => {
      const r = arr(run(traversal(V(), values('age'), fold(), sum(Scope.local)), tinkerGraph));
      // Persons: marko=29, vadas=27, josh=32, peter=35. 29+27+32+35 = 123.
      expect(r).toEqual([123]);
    });

    // doc: g.V().values('age').fold().min(Scope.local) — 27
    test('min(Scope.local) picks min element of a folded list', () => {
      const r = arr(run(traversal(V(), values('age'), fold(), min(Scope.local)), tinkerGraph));
      expect(r).toEqual([27]);
    });

    // doc: g.V().values('age').fold().max(Scope.local) — 35
    test('max(Scope.local) picks max element of a folded list', () => {
      const r = arr(run(traversal(V(), values('age'), fold(), max(Scope.local)), tinkerGraph));
      expect(r).toEqual([35]);
    });

    // doc: g.V().values('age').fold().mean(Scope.local) — 30.75
    test('mean(Scope.local) averages elements of a folded list', () => {
      const r = arr(run(traversal(V(), values('age'), fold(), mean(Scope.local)), tinkerGraph));
      expect(r).toEqual([30.75]);
    });

    // Empty folds → null (matches global-scope behavior on empty streams).
    test('sum(Scope.local) on an empty fold yields null', () => {
      const r = arr(run(traversal(inject([]), sum(Scope.local)), tinkerGraph));
      expect(r).toEqual([null]);
    });
  });
});
