// Item 642. `ORDER BY <the expression a projected item already computes>` now resolves to that
// item's alias, so `RETURN n.k AS c ORDER BY n.k` takes the same ordered-column path as
// `… ORDER BY c` instead of falling to the general path (1.94x).
//
// The substitution is only sound if the ANSWER never moves, so these pin the shapes where it
// could: two items projecting the SAME property under different aliases, an item with no alias
// at all, DISTINCT, grouping, descending and NULLS ordering, and a shadowing name.
import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

let g: Graph;

const rows = (q: string): unknown[] => [...(query(g, q) as Iterable<unknown>)];

beforeAll(() => {
  g = new Graph();

  // `k` ascends, `j` descends, and one node has NO `k` at all so null ordering is exercised.
  for (const [id, k, j] of [
    ['a', 3, 10],
    ['b', 1, 30],
    ['c', 2, 20],
  ] as const) {
    g.addVertex({ id, labels: ['P'], properties: { k, j } });
  }

  g.addVertex({ id: 'd', labels: ['P'], properties: { j: 40 } });
});

describe('the two spellings of one ordering agree', () => {
  test('ascending by a plain column', () => {
    const byAlias = rows('MATCH (n:P) RETURN n.k AS c ORDER BY c');
    const byExpr = rows('MATCH (n:P) RETURN n.k AS c ORDER BY n.k');

    expect(byExpr).toEqual(byAlias);
    expect(byAlias).toEqual([{ c: 1 }, { c: 2 }, { c: 3 }, { c: null }]);
  });

  test('descending', () => {
    const byAlias = rows('MATCH (n:P) RETURN n.k AS c ORDER BY c DESC');
    const byExpr = rows('MATCH (n:P) RETURN n.k AS c ORDER BY n.k DESC');

    expect(byExpr).toEqual(byAlias);
  });

  test('with an explicit NULLS FIRST', () => {
    const byAlias = rows('MATCH (n:P) RETURN n.k AS c ORDER BY c NULLS FIRST');
    const byExpr = rows('MATCH (n:P) RETURN n.k AS c ORDER BY n.k NULLS FIRST');

    expect(byExpr).toEqual(byAlias);
    expect((byExpr[0] as { c: unknown }).c).toBeNull();
  });

  test('with a LIMIT, which is what puts the window on the sort', () => {
    const byAlias = rows('MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 2');
    const byExpr = rows('MATCH (n:P) RETURN n.k AS c ORDER BY n.k LIMIT 2');

    expect(byExpr).toEqual(byAlias);
    expect(byExpr).toEqual([{ c: 1 }, { c: 2 }]);
  });

  test('ordering by a DIFFERENT projected column than the first', () => {
    const byAlias = rows('MATCH (n:P) RETURN n.k AS c, n.j AS d ORDER BY d');
    const byExpr = rows('MATCH (n:P) RETURN n.k AS c, n.j AS d ORDER BY n.j');

    expect(byExpr).toEqual(byAlias);
    expect(byExpr).toEqual([
      { c: 3, d: 10 },
      { c: 2, d: 20 },
      { c: 1, d: 30 },
      { c: null, d: 40 },
    ]);
  });

  test('two keys, one spelled as an alias and one as its expression', () => {
    expect(rows('MATCH (n:P) RETURN n.k AS c, n.j AS d ORDER BY n.j, c')).toEqual(
      rows('MATCH (n:P) RETURN n.k AS c, n.j AS d ORDER BY d, c'),
    );
  });
});

describe('the shapes where substituting could change the answer', () => {
  test('the SAME property projected under two aliases', () => {
    // Both columns hold the same values, so ordering by either is identical — but the
    // substitution picks one, and this pins that the answer does not depend on which.
    const byExpr = rows('MATCH (n:P) RETURN n.k AS a, n.k AS b ORDER BY n.k');

    expect(byExpr).toEqual(rows('MATCH (n:P) RETURN n.k AS a, n.k AS b ORDER BY a'));
    expect(byExpr).toEqual(rows('MATCH (n:P) RETURN n.k AS a, n.k AS b ORDER BY b'));
  });

  test('an item with NO alias is not substituted', () => {
    // There is no explicit output name to sort by, so this must keep the general path and
    // still answer correctly.
    const got = rows('MATCH (n:P) RETURN n.k ORDER BY n.k') as Record<string, unknown>[];

    expect(got).toHaveLength(4);
    expect(Object.values(got[0])[0]).toBe(1);
    expect(Object.values(got[3])[0]).toBeNull();
  });

  test('DISTINCT, where the sort applies after dedup', () => {
    g.addVertex({ id: 'e', labels: ['P'], properties: { k: 1, j: 50 } });

    try {
      expect(rows('MATCH (n:P) RETURN DISTINCT n.k AS c ORDER BY n.k')).toEqual(
        rows('MATCH (n:P) RETURN DISTINCT n.k AS c ORDER BY c'),
      );
    } finally {
      g.removeVertex(g.getVertexById('e')!);
    }
  });

  test('a GROUPED projection ordering by its group key', () => {
    expect(rows('MATCH (n:P) RETURN n.k AS c, count(*) AS n2 ORDER BY n.k')).toEqual(
      rows('MATCH (n:P) RETURN n.k AS c, count(*) AS n2 ORDER BY c'),
    );
  });

  test('an alias that SHADOWS the property name it is built from', () => {
    // `AS k` names the output the same as the property key; ordering by `n.k` must still mean
    // the property on `n`, and both spellings must agree.
    expect(rows('MATCH (n:P) RETURN n.k AS k ORDER BY n.k')).toEqual(
      rows('MATCH (n:P) RETURN n.k AS k ORDER BY k'),
    );
  });

  test('TWO VARIABLES sharing a property name are not confused', () => {
    // Mutation found this one: dropping the `variable` match from the substitution SURVIVED
    // all twelve tests above, because none of them bind two variables that both have a `k`.
    // `ORDER BY m.k` would then resolve to the alias built from `n.k` — a wrong answer.
    //
    // The fixture makes the two orders DISAGREE, which is what makes the case discriminating:
    // n.k ascends along the edges while m.k descends.
    const h = new Graph();
    const x = h.addVertex({ id: 'x', labels: ['Q'], properties: { k: 1 } });
    const y = h.addVertex({ id: 'y', labels: ['Q'], properties: { k: 2 } });
    const z = h.addVertex({ id: 'z', labels: ['Q'], properties: { k: 3 } });
    h.addEdge({ id: 'r1', from: x, to: z, labels: ['R'], properties: {} });
    h.addEdge({ id: 'r2', from: y, to: y, labels: ['R'], properties: {} });
    h.addEdge({ id: 'r3', from: z, to: x, labels: ['R'], properties: {} });

    const q = (text: string): unknown[] => [...(query(h, text) as Iterable<unknown>)];

    // Ordering by the FAR end's `k`: pairs are (1,3), (2,2), (3,1), so this is c = 3, 2, 1.
    expect(q('MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY m.k')).toEqual([
      { c: 3 },
      { c: 2 },
      { c: 1 },
    ]);

    // And ordering by the NEAR end's own property is the opposite — so a substitution that
    // ignored the variable would return this instead.
    expect(q('MATCH (n:Q)-[:R]->(m:Q) RETURN n.k AS c ORDER BY n.k')).toEqual([
      { c: 1 },
      { c: 2 },
      { c: 3 },
    ]);
  });

  test('a COMPUTED key is left alone — it can fault, so it keeps the general path', () => {
    expect(rows('MATCH (n:P) RETURN n.k + 1 AS c ORDER BY n.k + 1')).toEqual(
      rows('MATCH (n:P) RETURN n.k + 1 AS c ORDER BY c'),
    );
  });
});
