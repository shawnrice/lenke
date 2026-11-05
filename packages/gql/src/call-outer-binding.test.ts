import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1471 made the `CALL` row builder skip copying the outer binding when it is EMPTY
 * (`new Map(emptyMap)` costs 2.5x a fresh `new Map()` over 2M constructions, because copying must
 * obtain an iterator and step it even with nothing to copy) and hoisted the per-bind `column ===
 * 'node'` test out of the per-row loop.
 *
 * ⚠️ THE SUITE HAD NO MATCH-THEN-CALL TEST AT ALL, which is exactly the non-empty-outer-binding
 * branch the change introduces. A bug in that branch drops the outer variables **silently** — the
 * query still returns the right NUMBER of rows, with the outer columns gone or null. All thirteen
 * existing `CALL` tests begin with `CALL`, so every one of them exercises only the empty branch.
 */

const twoPeople = (): Graph => {
  const g = new Graph();
  const v = (id: string, name: string) =>
    g.addVertex({ id, labels: ['Person'], properties: { name } });
  const a = v('a', 'a');
  const b = v('b', 'b');

  g.addEdge({ from: a, to: b, labels: ['KNOWS'], properties: {} });

  return g;
};

describe('a CALL after a MATCH keeps the outer binding', () => {
  test('the outer variable survives into every row', () => {
    const rows = query(
      twoPeople(),
      'MATCH (p:Person) CALL degree() YIELD node, degree ' +
        'RETURN p.name AS pn, node.name AS nn, degree AS d ORDER BY pn, nn',
    );

    // 2 outer bindings x 2 result rows. `pn` coming back undefined/null for any row is the
    // failure this test exists for.
    expect(rows).toEqual([
      { pn: 'a', nn: 'a', d: 1 },
      { pn: 'a', nn: 'b', d: 0 },
      { pn: 'b', nn: 'a', d: 1 },
      { pn: 'b', nn: 'b', d: 0 },
    ]);
  });

  test('the cross product has the right cardinality', () => {
    expect(query(twoPeople(), 'MATCH (p:Person) CALL degree() RETURN count(*) AS n')).toEqual([
      { n: 4 },
    ]);
  });

  test('a one-row outer binding still carries its variable', () => {
    const rows = query(
      twoPeople(),
      "MATCH (p:Person) WHERE p.name = 'a' CALL degree() YIELD node, degree " +
        'RETURN p.name AS pn, node.name AS nn ORDER BY nn',
    );

    expect(rows).toEqual([
      { pn: 'a', nn: 'a' },
      { pn: 'a', nn: 'b' },
    ]);
  });

  test('two outer variables both survive', () => {
    const rows = query(
      twoPeople(),
      'MATCH (p:Person)-[:KNOWS]->(q:Person) CALL degree() YIELD node ' +
        'RETURN p.name AS pn, q.name AS qn, node.name AS nn ORDER BY nn',
    );

    expect(rows).toEqual([
      { pn: 'a', qn: 'b', nn: 'a' },
      { pn: 'a', qn: 'b', nn: 'b' },
    ]);
  });

  test('a leading CALL (the empty-outer branch) is unaffected', () => {
    expect(query(twoPeople(), 'CALL degree() YIELD node, degree RETURN count(*) AS n')).toEqual([
      { n: 2 },
    ]);
  });
});

describe('the node bind and the column bind are distinguished per bind', () => {
  test('YIELD node alone binds the vertex handle, usable for property access', () => {
    const rows = query(twoPeople(), 'CALL degree() YIELD node RETURN node.name AS nn ORDER BY nn');

    expect(rows).toEqual([{ nn: 'a' }, { nn: 'b' }]);
  });

  test('YIELD of the result column alone binds the raw value', () => {
    const rows = query(twoPeople(), 'CALL degree() YIELD degree RETURN degree AS d ORDER BY d');

    expect(rows).toEqual([{ d: 0 }, { d: 1 }]);
  });

  test('an aliased YIELD binds under the alias, in either order', () => {
    expect(
      query(
        twoPeople(),
        'CALL degree() YIELD degree AS d, node AS v RETURN v.name AS nn, d ORDER BY nn',
      ),
    ).toEqual([
      { nn: 'a', d: 1 },
      { nn: 'b', d: 0 },
    ]);
  });

  test('the vertex handle is the live element, not a copy of its id', () => {
    // `node.name` resolving proves the bind went through `verticesById`, which is the branch the
    // hoisted `isNode` flag selects.
    // A bare `WHERE` cannot follow `YIELD` — it needs a `WITH` first, which is the idiom the
    // existing suite uses too.
    const rows = query(
      twoPeople(),
      "CALL degree() YIELD node AS v, degree AS d WITH v, d WHERE v.name = 'a' RETURN d",
    );

    expect(rows).toEqual([{ d: 1 }]);
  });
});
