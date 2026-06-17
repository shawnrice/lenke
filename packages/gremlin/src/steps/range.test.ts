import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, range } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, range tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it gets the first three', () => {
      const r = run(traversal(V(), range(0, 3)), tinkerGraph);
      const xs = arr(r) as Array<{ properties: { name: string } }>;
      expect(xs.map((x) => x.properties.name)).toEqual(['marko', 'vadas', 'josh']);
    });

    test('it can skip on the low end', () => {
      const r = run(traversal(V(), range(3, 5)), tinkerGraph);
      const xs = arr(r) as Array<{ properties: { name: string } }>;
      expect(xs.map((x) => x.properties.name)).toEqual(['peter', 'lop']);
    });

    test('it can have an open end', () => {
      const r = run(traversal(V(), range(3, -1)), tinkerGraph);
      const xs = arr(r) as Array<{ properties: { name: string } }>;
      expect(xs.map((x) => x.properties.name)).toEqual(['peter', 'lop', 'ripple']);
    });

    // doc: g.V().range(0, 3) — v[1]; v[2]; v[3]
    test('range(0, 3) yields the first three vertices', () => {
      const xs = arr(run(traversal(V(), range(0, 3)), tinkerGraph)) as Array<{
        id: string;
      }>;
      // v2 fixture order: 1, 2, 4, 6, 3, 5
      expect(xs.map((v) => v.id)).toEqual(['1', '2', '4']);
    });

    // doc: g.V().range(1, 3) — v[2]; v[3]
    test('range(1, 3) skips first and yields next two', () => {
      const xs = arr(run(traversal(V(), range(1, 3)), tinkerGraph)) as Array<{
        id: string;
      }>;
      expect(xs.map((v) => v.id)).toEqual(['2', '4']);
    });

    // doc: g.V().range(1, -1) — v[2]; v[3]; v[4]; v[5]; v[6]
    test('range(1, -1) skips first and emits the rest', () => {
      const xs = arr(run(traversal(V(), range(1, -1)), tinkerGraph)) as Array<{
        id: string;
      }>;
      expect(xs.map((v) => v.id)).toEqual(['2', '4', '6', '3', '5']);
    });
  });
});
