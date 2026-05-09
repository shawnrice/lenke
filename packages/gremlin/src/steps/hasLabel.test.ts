import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { gt } from '../predicates.js';
import { E, V, has, hasLabel, range } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('hasLabel tests', () => {
    test('we can get all the person vertices', () => {
      const result = arr(run(traversal(V(), hasLabel('PERSON')), tinkerGraph));
      expect(result).toHaveLength(4);
    });

    test('we have stable query order', () => {
      const result = arr(run(traversal(V(), hasLabel('PERSON')), tinkerGraph)) as Array<{
        properties: { name: string };
      }>;
      expect(result.map((x) => x.properties.name)).toEqual(['marko', 'vadas', 'josh', 'peter']);
    });

    test('we can get a vertex', () => {
      const result = arr(run(traversal(V('1'), hasLabel('PERSON')), tinkerGraph)) as Array<{
        properties: { name: string };
      }>;
      expect(result[0].properties.name).toBe('marko');
    });

    // doc: g.E().hasLabel('knows').has('weight', gt(0.75)) — e[8][1-knows->4]
    test('hasLabel on edges + has(weight, gt) yields a single edge', () => {
      const r = arr(
        run(traversal(E(), hasLabel('KNOWS'), has('weight', gt(0.75))), tinkerGraph),
      ) as Array<{ id: string }>;
      expect(r.map((e) => e.id)).toEqual(['8']);
    });

    // doc: g.V().hasLabel('person').range(0,2) — v[1]; v[2]
    test('hasLabel + range slices the vertex stream', () => {
      const r = arr(
        run(traversal(V(), hasLabel('PERSON'), range(0, 2)), tinkerGraph),
      ) as Array<{ id: string }>;
      expect(r.map((v) => v.id)).toEqual(['1', '2']);
    });

    // doc: g.V().hasLabel('person') — v[1]; v[2]; v[4]; v[6]
    test('hasLabel(person) returns all four person vertices', () => {
      const r = arr(run(traversal(V(), hasLabel('PERSON')), tinkerGraph)) as Array<{
        id: string;
      }>;
      expect(r.map((v) => v.id)).toEqual(['1', '2', '4', '6']);
    });
  });
});
