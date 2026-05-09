import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasKey, properties, value } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('hasKey tests', () => {
    test('we can filter vertices by a property key', () => {
      // Only PERSON vertices have an `age` property.
      const result = arr(run(traversal(V(), hasKey('age')), tinkerGraph)) as Array<{ id: string }>;
      expect(result.map((x) => x.id)).toEqual(['1', '2', '4', '6']);
    });

    test('we can filter vertices by any of several keys', () => {
      // Every vertex has a `name` property — should return all.
      const result = arr(run(traversal(V(), hasKey('name')), tinkerGraph)) as Array<{
        id: string;
      }>;
      expect(result.map((x) => x.id)).toEqual(['1', '2', '4', '6', '3', '5']);
    });

    test('a missing key filters out everything', () => {
      const result = arr(run(traversal(V(), hasKey('idonotexist')), tinkerGraph));
      expect(result).toEqual([]);
    });

    // doc: g.V().properties().hasKey('age').value() — filter the property
    // stream by key, then unwrap to the value.
    test('we can filter properties stream by key', () => {
      const result = arr(
        run(traversal(V(), properties(), hasKey('age'), value()), tinkerGraph),
      );
      // Persons' ages: marko=29, vadas=27, josh=32, peter=35.
      expect((result as number[]).sort((a, b) => a - b)).toEqual([27, 29, 32, 35]);
    });
  });
});
