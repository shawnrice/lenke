import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, count, has, hasLabel, inE, out, outV, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('STEP count tests', () => {
    test('count works', () => {
      const r = run(traversal(V(), count()), tinkerGraph);
      expect(arr(r)).toEqual([6]);
    });

    test('count works, again', () => {
      const r = run(traversal(V(), hasLabel('PERSON'), count()), tinkerGraph);
      expect(arr(r)).toEqual([4]);
    });

    // doc: g.V().has('name','marko').out('knows').count() — 2
    test('count after has + out', () => {
      const r = arr(
        run(traversal(V(), has('name', eq('marko')), out('KNOWS'), count()), tinkerGraph),
      );
      expect(r).toEqual([2]);
    });

    // doc: g.V().hasLabel("software").inE("created").outV().count() — 4
    test('count software creators (inE outV)', () => {
      const r = arr(
        run(traversal(V(), hasLabel('SOFTWARE'), inE('CREATED'), outV(), count()), tinkerGraph),
      );
      expect(r).toEqual([4]);
    });

    // doc: g.V().hasLabel("software").inE("created").count() — 4
    test('count software inE(created)', () => {
      const r = arr(
        run(traversal(V(), hasLabel('SOFTWARE'), inE('CREATED'), count()), tinkerGraph),
      );
      expect(r).toEqual([4]);
    });

    test('count works again and again', () => {
      const r1 = run(traversal(V(), hasLabel('PERSON'), out(), count()), tinkerGraph);
      const r2 = run(traversal(V(), hasLabel('PERSON'), out(), values('name')), tinkerGraph);

      expect(arr(r1)).toEqual([6]);
      expect(arr(r2)).toEqual(['vadas', 'josh', 'lop', 'ripple', 'lop', 'lop']);
    });
  });
});
