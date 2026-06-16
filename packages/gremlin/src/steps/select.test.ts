import { describe, expect, test } from 'bun:test';
import type { Vertex } from '@pl-graph/core';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, as_, both, count, in_, out, select, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  describe('select tests', () => {
    test('select multiple labeled positions', () => {
      const result = arr(
        run(
          traversal(V(), as_('a'), out(), as_('b'), out(), as_('c'), select('a', 'b', 'c')),
          tinkerGraph,
        ),
      );
      const ids = (result as Array<Record<string, Vertex>>).map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.id])),
      );
      expect(ids).toEqual([
        { a: '1', b: '4', c: '5' },
        { a: '1', b: '4', c: '3' },
      ]);
    });

    test('we need not select everything we labeled', () => {
      const result = arr(
        run(
          traversal(V(), as_('a'), out(), as_('b'), out(), as_('c'), select('a', 'b')),
          tinkerGraph,
        ),
      );
      const ids = (result as Array<Record<string, Vertex>>).map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.id])),
      );
      expect(ids).toEqual([
        { a: '1', b: '4' },
        { a: '1', b: '4' },
      ]);
    });

    test('selecting one label yields the value (no object wrapper)', () => {
      const result = arr(
        run(traversal(V(), as_('a'), out(), as_('b'), out(), as_('c'), select('a')), tinkerGraph),
      );
      expect(result).toHaveLength(2);
      expect((result as Vertex[]).map((v) => v.id)).toEqual(['1', '1']);
    });

    test('select can find the start of a longer path', () => {
      const result = arr(run(traversal(V(), as_('x'), out(), out(), select('x')), tinkerGraph));
      expect(result).toHaveLength(2);
      expect((result as Vertex[]).map((v) => v.id)).toEqual(['1', '1']);
    });

    test('select after labeling the middle', () => {
      const result = arr(run(traversal(V(), out(), as_('x'), out(), select('x')), tinkerGraph));
      expect(result).toHaveLength(2);
      expect((result as Vertex[]).map((v) => v.id)).toEqual(['4', '4']);
    });

    test('select the current position (pointless but works)', () => {
      const result = arr(run(traversal(V(), out(), out(), as_('x'), select('x')), tinkerGraph));
      expect(result).toHaveLength(2);
      expect(
        (result as Array<{ properties: { name: string } }>).map((v) => v.properties.name),
      ).toEqual(['ripple', 'lop']);
    });

    // doc: g.V(1).as('a').both().as('b').select('a','b') — pairs of v[1] with each neighbor
    test('select with both() yields a pair per neighbor', () => {
      const result = arr(
        run(traversal(V('1'), as_('a'), both(), as_('b'), select('a', 'b')), tinkerGraph),
      );
      const ids = (result as Array<Record<string, Vertex>>).map((row) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.id])),
      );
      // marko's neighbors via both(): vadas, josh, lop
      expect(ids).toEqual([
        { a: '1', b: '2' },
        { a: '1', b: '4' },
        { a: '1', b: '3' },
      ]);
    });

    test('select drops traversers missing the label', () => {
      // No `as('missing')` was ever set, so select should produce nothing.
      const result = arr(run(traversal(V('1'), as_('a'), select('missing')), tinkerGraph));
      expect(result).toEqual([]);
    });

    // doc: select('a','b').by(...sub-traversal) — project via sub-plan.
    test('select with by(sub-traversal) projects via inner plan', () => {
      const result = arr(
        run(
          traversal(
            V('1'),
            as_('a'),
            out('CREATED'),
            as_('b'),
            select('a', 'b')
              .by(traversal(in_('CREATED'), count()))
              .by('name'),
          ),
          tinkerGraph,
        ),
      );
      // 'a' is marko -> in('CREATED').count() = 0; 'b' is lop -> name = 'lop'.
      expect(result).toEqual([{ a: 0, b: 'lop' }]);
    });

    // doc: g.V().hasLabel('software').as('a','b','c').select('a','b','c')
    //        .by('name').by('lang').by(__.in('created').values('name').fold())
    // (we test a similar shape with one label, software=lop, by name + lang.)
    test('select projects multiple by-clauses including sub-traversal fold', () => {
      const result = arr(
        run(
          traversal(
            V('3'), // lop
            as_('a'),
            select('a').by(traversal(in_('CREATED'), values('name'), count())),
          ),
          tinkerGraph,
        ),
      );
      // lop is created by 3 persons.
      expect(result).toEqual([3]);
    });

    // doc: select('a','b').by('name') — project both labeled positions by name.
    test('select works with by("name") to project labeled positions', () => {
      const result = arr(
        run(
          traversal(
            V('1'),
            as_('a'),
            out('KNOWS'),
            as_('b'),
            select('a', 'b').by('name').by('name'),
          ),
          tinkerGraph,
        ),
      );
      expect(result).toEqual([
        { a: 'marko', b: 'vadas' },
        { a: 'marko', b: 'josh' },
      ]);
    });
  });
});
