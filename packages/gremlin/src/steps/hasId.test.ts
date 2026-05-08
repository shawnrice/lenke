import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { E, V, hasId, out, outV } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('hasId tests', () => {
    test('we can filter just by id', () => {
      const result = arr(run(traversal(V(), hasId('1')), tinkerGraph)) as Array<{
        id: string;
        properties: { name: string };
      }>;
      expect(result.map((x) => x.id)).toEqual(['1']);
      expect(result.map((x) => x.properties.name)).toEqual(['marko']);
    });

    test('we can filter by ids out of order', () => {
      const result = arr(run(traversal(V(), hasId('6', '2', '1', '4')), tinkerGraph)) as Array<{
        id: string;
        properties: { name: string };
      }>;
      expect(result.map((x) => x.id)).toEqual(['1', '2', '4', '6']);
      expect(result.map((x) => x.properties.name)).toEqual(['marko', 'vadas', 'josh', 'peter']);
    });

    test('we can call it on edges', () => {
      const result = arr(run(traversal(E(), hasId('7', '8')), tinkerGraph)) as Array<{
        id: string;
      }>;
      expect(result.map((x) => x.id)).toEqual(['7', '8']);
    });

    test('we can do something more complex', () => {
      const result = arr(
        run(traversal(E(), hasId('7', '8'), outV(), out(), out(), hasId('5')), tinkerGraph),
      ) as Array<{ id: string }>;
      expect(result.map((x) => x.id)).toEqual(['5', '5']);
    });
  });
});
