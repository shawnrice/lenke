import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq, gt } from '../predicates.js';
import { V, has, out, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  describe('STEP, values tests', () => {
    const tinkerGraph = createTestTinkerGraph();

    test('it can get all values', () => {
      const result = arr(run(traversal(V('1'), values()), tinkerGraph));
      expect(result).toEqual(['marko', 29]);
    });

    test('it filters out vertices without specified value', () => {
      const result = arr(run(traversal(V(), values('age')), tinkerGraph));
      expect(result).toEqual([29, 27, 32, 35]);
    });

    test('it can get multiple values', () => {
      const result = arr(run(traversal(V(), values('name', 'age')), tinkerGraph));
      expect(result).toEqual(['marko', 29, 'vadas', 27, 'josh', 32, 'peter', 35, 'lop', 'ripple']);
    });

    // doc: g.V().has('name','marko').out('knows').values('name') — vadas; josh
    test('chained has + out + values', () => {
      const r = arr(
        run(traversal(V(), has('name', eq('marko')), out('KNOWS'), values('name')), tinkerGraph),
      );
      expect(r).toEqual(['vadas', 'josh']);
    });

    // doc: g.V(1).out().values('name') — lop; vadas; josh (doc order)
    // v2 fixture inserts KNOWS edges before CREATED, so order is vadas, josh, lop.
    test('out then values (v2 fixture yields vadas, josh, lop)', () => {
      const r = arr(run(traversal(V('1'), out(), values('name')), tinkerGraph));
      expect(r).toEqual(['vadas', 'josh', 'lop']);
    });

    // doc: g.V().values('name') — all six names
    test('all names', () => {
      const r = arr(run(traversal(V(), values('name')), tinkerGraph));
      expect(r).toEqual(['marko', 'vadas', 'josh', 'peter', 'lop', 'ripple']);
    });

    // doc: g.V(1).out('knows').values('name') — vadas; josh
    test('out by label then values', () => {
      const r = arr(run(traversal(V('1'), out('KNOWS'), values('name')), tinkerGraph));
      expect(r).toEqual(['vadas', 'josh']);
    });

    // doc: g.V().has('name','marko').out('created').values('name') — lop
    test('has + out(created) + values', () => {
      const r = arr(
        run(traversal(V(), has('name', eq('marko')), out('CREATED'), values('name')), tinkerGraph),
      );
      expect(r).toEqual(['lop']);
    });

    // doc: g.V().has('name','marko').values('age') — 29
    test('has + values(age)', () => {
      const r = arr(run(traversal(V(), has('name', eq('marko')), values('age')), tinkerGraph));
      expect(r).toEqual([29]);
    });

    // doc: g.V().out().out().values('name') — ripple; lop
    test('out().out().values()', () => {
      const r = arr(run(traversal(V(), out(), out(), values('name')), tinkerGraph));
      expect(r).toEqual(['ripple', 'lop']);
    });

    // doc: g.V().has('name','marko').out('knows').has('age', gt(29)).values('name') — josh
    test('chained predicate has on age', () => {
      const r = arr(
        run(
          traversal(
            V(),
            has('name', eq('marko')),
            out('KNOWS'),
            has('age', gt(29)),
            values('name'),
          ),
          tinkerGraph,
        ),
      );
      expect(r).toEqual(['josh']);
    });
  });
});
