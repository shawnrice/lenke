import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `ORDER BY <alias>` where the alias names a SUBQUERY item used to sort by nothing whenever the
// alias collided with a variable the subquery binds. Values were right; the order was not, and
// native disagreed — a live cross-engine divergence (audit item 213):
//
//     RETURN COUNT { MATCH (m)-[:T]->(c) } AS c ORDER BY c
//       ts      [2, 1]   <- unsorted
//       native  [1, 2]
//
// The mechanism: `aliasDefinition` substitutes a sort alias with the expression it names, guarded
// on no free name of that expression being an output name. `freePredicateVars` returns the EMPTY
// set for a subquery — it does not descend into one — so the guard saw no collision, substituted,
// and the sort key became the subquery itself. The output is then overlaid on the binding, which
// bound `c` to the COUNT VALUE, so the sub-pattern's `(c)` matched a number, counted 0 for every
// row, and every key compared equal.
//
// The fix declines substitution for any item containing a subquery, which sends it to the
// non-substituted path — sorting by the output column, as native does.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, label: string, props: Record<string, unknown> = {}) =>
    g.addVertex({ id, labels: [label], properties: props });
  const e = (f: ReturnType<typeof v>, t: ReturnType<typeof v>) =>
    g.addEdge({ from: f, to: t, labels: ['T'], properties: {} });

  const a = v('a', 'A');
  const m1 = v('m1', 'M', { k: 9 });
  const m2 = v('m2', 'M', { k: 5 });
  const c1 = v('c1', 'C');
  const c2 = v('c2', 'C');

  // m1 has two out-edges, m2 has one, so the counts differ and an order is observable. And m1
  // comes FIRST in insertion order while its count is LARGER — so an unsorted result is
  // distinguishable from an ascending one.
  e(a, m1);
  e(m1, c1);
  e(m1, c2);
  e(a, m2);
  e(m2, c1);

  return g;
};

const g = build();

describe('ORDER BY an alias naming a subquery item', () => {
  test('sorts when the alias COLLIDES with a variable the subquery binds', () => {
    expect(
      query(g, 'MATCH (a:A)-[:T]->(m:M) RETURN COUNT { MATCH (m)-[:T]->(c) } AS c ORDER BY c'),
    ).toEqual([{ c: 1 }, { c: 2 }]);
  });

  test('and still sorts when it does NOT collide — the two spellings agree', () => {
    const colliding = query(
      g,
      'MATCH (a:A)-[:T]->(m:M) RETURN COUNT { MATCH (m)-[:T]->(c) } AS c ORDER BY c',
    );
    const clean = query(
      g,
      'MATCH (a:A)-[:T]->(m:M) RETURN COUNT { MATCH (m)-[:T]->(z) } AS c ORDER BY c',
    );

    expect(colliding).toEqual(clean);
  });

  test('DESC, so the fix is not just "insertion order happened to be right"', () => {
    // Insertion order is m1 (count 2) then m2 (count 1), which IS descending — so ascending is the
    // direction that proves sorting, and descending proves the key is read rather than ignored.
    expect(
      query(g, 'MATCH (a:A)-[:T]->(m:M) RETURN COUNT { MATCH (m)-[:T]->(c) } AS c ORDER BY c DESC'),
    ).toEqual([{ c: 2 }, { c: 1 }]);
  });

  test('EXISTS and a nested expression, which take the same path', () => {
    expect(
      query(g, 'MATCH (a:A)-[:T]->(m:M) RETURN EXISTS { MATCH (m)-[:T]->(c) } AS c ORDER BY c'),
    ).toEqual([{ c: true }, { c: true }]);
    expect(
      query(g, 'MATCH (a:A)-[:T]->(m:M) RETURN COUNT { MATCH (m)-[:T]->(c) } + 0 AS c ORDER BY c'),
    ).toEqual([{ c: 1 }, { c: 2 }]);
  });

  test('ORDER BY with a LIMIT still pages the SORTED list', () => {
    // A wrong sort key with a LIMIT returns the wrong ROW, not merely the wrong order — the case
    // where this bug would have been silently load-bearing.
    expect(
      query(
        g,
        'MATCH (a:A)-[:T]->(m:M) RETURN COUNT { MATCH (m)-[:T]->(c) } AS c ORDER BY c LIMIT 1',
      ),
    ).toEqual([{ c: 1 }]);
  });

  test('a second column is carried correctly alongside', () => {
    expect(
      query(
        g,
        'MATCH (a:A)-[:T]->(m:M) RETURN m.k AS k, COUNT { MATCH (m)-[:T]->(c) } AS c ORDER BY c',
      ),
    ).toEqual([
      { k: 5, c: 1 },
      { k: 9, c: 2 },
    ]);
  });
});

describe('what the fix must not have broken', () => {
  test('a plain alias still substitutes and sorts', () => {
    expect(query(g, 'MATCH (m:M) RETURN m.k AS k ORDER BY k')).toEqual([{ k: 5 }, { k: 9 }]);
  });

  test('a COMPUTED alias still substitutes (item 145)', () => {
    expect(query(g, 'MATCH (m:M) RETURN m.k + 1 AS k ORDER BY k')).toEqual([{ k: 6 }, { k: 10 }]);
  });

  test('an alias shadowing an input variable still declines substitution and sorts', () => {
    expect(query(g, 'MATCH (m:M) RETURN m.k AS m ORDER BY m')).toEqual([{ m: 5 }, { m: 9 }]);
  });

  test('an aggregate alias still declines substitution and sorts BY THE AGGREGATE', () => {
    // An aggregate is defined over the GROUP, so substituting it into the sort key would evaluate
    // it per ROW instead. Groups must therefore have DIFFERENT sizes for that to be observable —
    // with one row each, `count(*)` is 1 either way and the mutant survives, which it did.
    const h = new Graph();
    const mk = (band: number) =>
      h.addVertex({ id: `v${h.vertexCount}`, labels: ['G'], properties: { band } });

    mk(1);
    mk(2);
    mk(2);
    mk(3);
    mk(3);
    mk(3);

    expect(
      query(h, 'MATCH (g:G) RETURN g.band AS b, count(*) AS n GROUP BY g.band ORDER BY n'),
    ).toEqual([
      { b: 1, n: 1 },
      { b: 2, n: 2 },
      { b: 3, n: 3 },
    ]);
    expect(
      query(h, 'MATCH (g:G) RETURN g.band AS b, count(*) AS n GROUP BY g.band ORDER BY n DESC'),
    ).toEqual([
      { b: 3, n: 3 },
      { b: 2, n: 2 },
      { b: 1, n: 1 },
    ]);
  });

  test('ORDER BY the subquery EXPRESSION, not an alias, is unaffected', () => {
    expect(
      query(
        g,
        'MATCH (a:A)-[:T]->(m:M) RETURN COUNT { MATCH (m)-[:T]->(c) } AS n ORDER BY COUNT { MATCH (m)-[:T]->(c) }',
      ),
    ).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
