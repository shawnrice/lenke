import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, identity } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, id tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('identity works', () => {
      const r = run(traversal(V(), identity()), tinkerGraph);
      const xs = arr(r) as Array<{ id: string }>;
      const expected = ['1', '2', '4', '6', '3', '5'].map((x) => tinkerGraph.getVertexById(x));
      expect(xs).toEqual(expected as Array<{ id: string }>);
      expect(xs.map((x) => x.id)).toEqual(['1', '2', '4', '6', '3', '5']);
    });
  });
});
