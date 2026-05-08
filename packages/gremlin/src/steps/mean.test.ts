import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, both, inject, mean, repeat, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP mean tests', () => {
    test('mean works with numbers', () => {
      const r = run(traversal(V(), values('age'), mean()), tinkerGraph);
      expect(arr(r)).toEqual([30.75]);
    });

    // The TinkerPop reference docs publish [30.75] for
    //   g.V().repeat(both()).times(3).values('age').mean()
    // against the Modern graph, but that value cannot be reproduced from the
    // graph's actual topology under standard path-enumeration semantics. A
    // brute-force adjacency-list walk over 3 `both()` hops from each of the 6
    // vertices yields 72 terminal traversers with the per-vertex composition:
    //   marko=17, vadas=7, josh=17, peter=7, lop=17, ripple=7
    // Filtering to traversers with an `age` (the four persons) gives 48 values
    // summing to 1471, so the true mean is 1471/48 ≈ 30.6458. Our executor
    // matches this independently-derived ground truth, so we assert it here
    // rather than the doc value.
    test('mean works with repeat', () => {
      const r = run(
        traversal(V(), repeat(both()).times(3), values('age'), mean()),
        tinkerGraph,
      );
      expect(arr(r)).toEqual([1471 / 48]);
    });

    test('mean filters out null', () => {
      const r = run(traversal(inject(null, 10, 9, null), mean()), tinkerGraph);
      expect(arr(r)).toEqual([9.5]);
    });

    test('mean takes null if that is all it got', () => {
      const r = run(traversal(inject(null, null, null, null), mean()), tinkerGraph);
      expect(arr(r)).toEqual([null]);
    });
  });
});
