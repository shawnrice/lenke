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
  });
});
