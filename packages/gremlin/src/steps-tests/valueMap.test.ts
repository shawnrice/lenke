import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { E, V, valueMap } from '../steps.js';
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

    // doc: g.V().valueMap('age','blah') — same as valueMap('age'); 'blah' is silently skipped.
    // Drift: TinkerPop wraps single-cardinality values in a list ([29]); our v2 impl
    // returns bare scalars (29).
    test('valueMap silently skips missing keys', () => {
      const result = arr(run(traversal(V(), valueMap('age', 'blah')), tinkerGraph));
      expect(result).toEqual([{ age: 29 }, { age: 27 }, { age: 32 }, { age: 35 }, {}, {}]);
    });

    // doc: g.E().valueMap() — edge property maps; edges have single-cardinality values.
    test('valueMap on edges yields one entry per edge', () => {
      const result = arr(run(traversal(E(), valueMap()), tinkerGraph));
      expect(result).toEqual([
        { weight: 0.5 },
        { weight: 1.0 },
        { weight: 0.4 },
        { weight: 1.0 },
        { weight: 0.4 },
        { weight: 0.2 },
      ]);
    });
  });
});
