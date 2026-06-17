import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, fail, fold, has, hasLabel } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP fail tests', () => {
    test('fail works', () => {
      // v1: g.V().has('person', 'name', 'peter').fold().fail('Test Fail')
      // v2: hasLabel + has, then fold (one-element list), then fail throws.
      const t = traversal(
        V(),
        hasLabel('PERSON'),
        has('name', eq('peter')),
        fold(),
        fail('Test Fail'),
      );
      expect(() => arr(run(t, tinkerGraph))).toThrow('Test Fail');
    });

    test('fail does not throw on an empty stream', () => {
      // No vertex named 'nobody' — fail() never sees a traverser, never throws.
      const t = traversal(V(), has('name', eq('nobody')), fail('should not fire'));
      expect(arr(run(t, tinkerGraph))).toEqual([]);
    });

    test('fail without a message uses a default', () => {
      const t = traversal(V(), fail());
      expect(() => arr(run(t, tinkerGraph))).toThrow('fail() reached');
    });
  });
});
