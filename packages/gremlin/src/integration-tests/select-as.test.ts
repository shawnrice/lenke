import { describe, expect, test } from 'bun:test';
import type { Vertex } from '@pl-graph/core';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, as_, has, out, select } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Labeled-position queries (as/select)', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().as('a').out().as('b').out().as('c').select('a','b','c')
  test('three-step labeled walk yields {a,b,c} per traverser', () => {
    const r = arr(
      run(
        traversal(V(), as_('a'), out(), as_('b'), out(), as_('c'), select('a', 'b', 'c')),
        g,
      ),
    );
    const ids = (r as Array<Record<string, Vertex>>).map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.id])),
    );
    expect(ids).toEqual([
      { a: '1', b: '4', c: '5' },
      { a: '1', b: '4', c: '3' },
    ]);
  });

  // Selecting only some of the labeled positions.
  test('select subset of labeled positions', () => {
    const r = arr(
      run(
        traversal(V(), as_('a'), out(), as_('b'), out(), as_('c'), select('a', 'c')),
        g,
      ),
    );
    const ids = (r as Array<Record<string, Vertex>>).map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v.id])),
    );
    expect(ids).toEqual([
      { a: '1', c: '5' },
      { a: '1', c: '3' },
    ]);
  });

  // Single-label select returns the value itself (no wrapper).
  test('single-label select unwraps to the value', () => {
    const r = arr(
      run(traversal(V(), as_('a'), out(), as_('b'), select('b')), g),
    );
    const ids = (r as Vertex[]).map((v) => v.id);
    expect(ids.slice().sort()).toEqual(['2', '3', '3', '3', '4', '5']);
  });

  // select.by('name') projects each labeled vertex by name.
  test('select.by("name") projects names per slot', () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          as_('a'),
          out('CREATED'),
          as_('b'),
          select('a', 'b').by('name').by('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual([{ a: 'marko', b: 'lop' }]);
  });

  // Labeled walk over CREATED: a=person, b=software.
  test('select labels for marko -> CREATED -> software', () => {
    const r = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          as_('person'),
          out('CREATED'),
          as_('software'),
          select('person', 'software').by('name').by('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual([{ person: 'marko', software: 'lop' }]);
  });
});
