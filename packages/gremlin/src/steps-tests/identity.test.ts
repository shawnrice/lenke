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

    // doc: g.V().identity() — v[1]; v[2]; v[3]; v[4]; v[5]; v[6]
    test('identity emits each vertex unchanged (doc scenario)', () => {
      const r = arr(run(traversal(V(), identity()), tinkerGraph)) as Array<{
        id: string;
      }>;
      // Our fixture insertion order interleaves persons & software differently
      // than the canonical doc order, but the identity invariant holds:
      // the output equals the input of V().
      const direct = arr(run(traversal(V()), tinkerGraph)) as Array<{ id: string }>;
      expect(r.map((v) => v.id)).toEqual(direct.map((v) => v.id));
    });
  });
});
