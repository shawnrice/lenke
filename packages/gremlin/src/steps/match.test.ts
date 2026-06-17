import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { neq } from '../predicates.js';
import { V, as_, has, in_, match, not, out, pipe, select, where } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

// Sort {a,c,...}-shaped binding maps so set comparisons are order-independent.
const sortMaps = (rows: unknown[]): unknown[] =>
  [...rows].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));

describe('match() — declarative pattern matching', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().match(__.as('a').out('CREATED').as('b'),
  //                  __.as('b').has('name','lop'),
  //                  __.as('b').in('CREATED').as('c'),
  //                  __.as('c').has('age',29)).select('a','c').by('name')
  test('declarative AND of as-pattern fragments', () => {
    const r = arr(
      run(
        traversal(
          V(),
          match(
            pipe(as_('a'), out('CREATED'), as_('b')),
            pipe(as_('b'), has('name', 'lop')),
            pipe(as_('b'), in_('CREATED'), as_('c')),
            pipe(as_('c'), has('age', 29)),
          ),
          select('a', 'c').by('name'),
        ),
        g,
      ),
    );
    expect(sortMaps(r)).toEqual(
      sortMaps([
        { a: 'marko', c: 'marko' },
        { a: 'josh', c: 'marko' },
        { a: 'peter', c: 'marko' },
      ]),
    );
  });

  // doc: g.V().match(__.as('a').out('CREATED').has('name','lop').as('b'),
  //                  __.as('b').in('CREATED').has('age',29).as('c')).select('a','c').by('name')
  test('chained pattern with embedded has', () => {
    const r = arr(
      run(
        traversal(
          V(),
          match(
            pipe(as_('a'), out('CREATED'), has('name', 'lop'), as_('b')),
            pipe(as_('b'), in_('CREATED'), has('age', 29), as_('c')),
          ),
          select('a', 'c').by('name'),
        ),
        g,
      ),
    );
    expect(sortMaps(r)).toEqual(
      sortMaps([
        { a: 'marko', c: 'marko' },
        { a: 'josh', c: 'marko' },
        { a: 'peter', c: 'marko' },
      ]),
    );
  });

  // doc: g.V().match(__.as('a').out('CREATED').as('b'),
  //                  __.as('b').in('CREATED').as('c')).where('a',neq('c')).select('a','c').by('name')
  test('combined with where(neq) over labels', () => {
    const r = arr(
      run(
        traversal(
          V(),
          match(pipe(as_('a'), out('CREATED'), as_('b')), pipe(as_('b'), in_('CREATED'), as_('c'))),
          where('a', neq('c')),
          select('a', 'c').by('name'),
        ),
        g,
      ),
    );
    expect(sortMaps(r)).toEqual(
      sortMaps([
        { a: 'marko', c: 'josh' },
        { a: 'marko', c: 'peter' },
        { a: 'josh', c: 'marko' },
        { a: 'josh', c: 'peter' },
        { a: 'peter', c: 'marko' },
        { a: 'peter', c: 'josh' },
      ]),
    );
  });

  // doc: g.V().as('a').out('KNOWS').as('b').
  //         match(__.as('b').out('CREATED').as('c'),
  //                __.not(__.as('c').in('CREATED').as('a'))).select('a','b','c').by('name')
  test('nested not() inside match', () => {
    const r = arr(
      run(
        traversal(
          V(),
          as_('a'),
          out('KNOWS'),
          as_('b'),
          match(
            pipe(as_('b'), out('CREATED'), as_('c')),
            not(pipe(as_('c'), in_('CREATED'), as_('a'))),
          ),
          select('a', 'b', 'c').by('name'),
        ),
        g,
      ),
    );
    expect(r).toEqual([{ a: 'marko', b: 'josh', c: 'ripple' }]);
  });
});
