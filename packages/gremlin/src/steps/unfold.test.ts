import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, fold, inject, out, unfold } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP unfold tests', () => {
    test('fold sets up correctly', () => {
      const r = arr(
        run(traversal(V('1'), out(), fold(), inject('gremlin', [1.23, 2.34])), tinkerGraph),
      );
      // v2 fixture's V(1).out() yields [vadas(2), josh(4), lop(3)] (KNOWS first).
      const v2 = tinkerGraph.getVertexById('2');
      const v3 = tinkerGraph.getVertexById('3');
      const v4 = tinkerGraph.getVertexById('4');
      expect(r).toEqual(['gremlin', [1.23, 2.34], [v2, v4, v3]]);
    });

    test('unfold, well, unfolds', () => {
      const r = arr(
        run(
          traversal(V('1'), out(), fold(), inject('gremlin', [1.23, 2.34]), unfold()),
          tinkerGraph,
        ),
      );
      const v2 = tinkerGraph.getVertexById('2');
      const v3 = tinkerGraph.getVertexById('3');
      const v4 = tinkerGraph.getVertexById('4');
      expect(r).toEqual(['gremlin', 1.23, 2.34, v2, v4, v3]);
    });

    test('unfold is not deep', () => {
      const r1 = run(traversal(inject(1, [2, 3, [4, 5, [6]]])), tinkerGraph);
      expect(arr(r1)).toEqual([1, [2, 3, [4, 5, [6]]]]);

      const r2 = run(traversal(inject(1, [2, 3, [4, 5, [6]]]), unfold()), tinkerGraph);
      expect(arr(r2)).toEqual([1, 2, 3, [4, 5, [6]]]);
    });
  });
});
