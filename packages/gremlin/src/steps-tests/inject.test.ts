import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, inject, out, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP inject tests', () => {
    test('it can inject a string', () => {
      const result = arr(
        run(traversal(V('4'), out(), values('name'), inject('daniel')), tinkerGraph),
      );
      expect(result).toEqual(['daniel', 'ripple', 'lop']);
    });

    // v2 has no `map(fn)` step.
    test.skip('it injected objects work like others (map step not in v2)', () => {});
    test.skip('it injected objects work like others with path (map step not in v2)', () => {});
  });
});
