import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasLabel, order, tail, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP tail tests', () => {
    test('tail works', () => {
      const r = run(traversal(V(), hasLabel('PERSON'), values('name'), tail()), tinkerGraph);
      expect(arr(r)).toEqual(['peter']);
    });

    test('tail works with order', () => {
      const r = run(
        traversal(V(), hasLabel('PERSON'), values('name'), order(), tail()),
        tinkerGraph,
      );
      expect(arr(r)).toEqual(['vadas']);
    });

    test('tail works with order and an index', () => {
      const r1 = arr(
        run(traversal(V(), hasLabel('PERSON'), values('name'), order(), tail()), tinkerGraph),
      );
      const r2 = arr(
        run(traversal(V(), hasLabel('PERSON'), values('name'), order(), tail(1)), tinkerGraph),
      );
      expect(r1).toEqual(r2);
    });

    test('tail works with multiple items', () => {
      const r = run(traversal(V(), values('name'), order(), tail(3)), tinkerGraph);
      expect(arr(r)).toEqual(['peter', 'ripple', 'vadas']);
    });
  });
});
