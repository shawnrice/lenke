import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, inject, map, out, values } from '../steps.js';
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

    // doc-style: inject literal scalars then transform them with map(fn) —
    // injected values participate in the stream like any other traverser.
    test('injected objects can be transformed by map(closure)', () => {
      const result = arr(
        run(
          traversal(
            inject(1, 2, 3),
            map((v: unknown) => (v as number) * 10),
          ),
          tinkerGraph,
        ),
      );
      expect(result).toEqual([10, 20, 30]);
    });

    // Path tracks injected values too — the map closure can read traverser
    // path/loopCount/tags via the second argument.
    // doc: g.inject(1,2,3) — start a traversal from explicit values.
    test('inject as a source yields each value in order', () => {
      const result = arr(run(traversal(inject('a', 'b', 'c')), tinkerGraph));
      expect(result).toEqual(['a', 'b', 'c']);
    });

    // doc: g.inject([1,2,3],[4,5]) flattens? — TinkerPop yields lists as-is.
    test('inject preserves arrays as single values (no auto-unfold)', () => {
      const result = arr(run(traversal(inject([1, 2, 3], [4, 5])), tinkerGraph));
      expect(result).toEqual([[1, 2, 3], [4, 5]]);
    });

    test('injected objects work like others with path', () => {
      const result = arr(
        run(
          traversal(
            inject(1, 2, 3),
            map((_v: unknown, t) => t.path.length),
          ),
          tinkerGraph,
        ),
      );
      // each injected value's path is just [itself] — length 1
      expect(result).toEqual([1, 1, 1]);
    });
  });
});
