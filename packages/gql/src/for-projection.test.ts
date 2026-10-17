// `MATCH (n[:L]) FOR t IN <list> RETURN <items>` — the `FOR` PROJECTION off the label bucket.
//
// Items 515 and 518 gave the `count(*)` form the arithmetic; a projection has to emit the rows,
// so the cost is the walk and the general path paid three allocations an ELEMENT for it (a
// binding copy per element, an array of those per input row, and a final map walk). 95.2ms at
// 200,000 vertices with three elements each, against native's 50.8 (item 528).
//
// Every case is asked TWICE — once admitted, once with a `FILTER true` inserted, which keeps
// every row but takes the clause count to four so the rung declines and the general path
// answers. Row order without ORDER BY is unspecified, so the two are compared as multisets.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1, tags: [10, 20, 30] } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2, tags: [40] } });
  // An EMPTY list: the anchor's row disappears entirely.
  g.addVertex({ id: 'c', labels: ['P'], properties: { n: 3, tags: [] } });
  // A SCALAR where a list is expected: unwinds as a one-element list.
  g.addVertex({ id: 'd', labels: ['P'], properties: { n: 4, tags: 'solo' } });
  // NO `tags` key at all, and a NULL one — both contribute nothing.
  g.addVertex({ id: 'e', labels: ['P'], properties: { n: 5 } });
  g.addVertex({ id: 'f', labels: ['P'], properties: { n: 6, tags: null } });
  // A different label, so `(n:P)` is not every vertex.
  g.addVertex({ id: 'q', labels: ['Q'], properties: { n: 7, tags: [99] } });

  return g;
};

const g = build();

const bag = (rows: unknown[]): string =>
  JSON.stringify([...rows].map((r) => JSON.stringify(r)).sort());

/** The rung's answer and the general path's, as multisets. */
const both = (q: string, want: unknown[], params?: Record<string, unknown>): void => {
  const rows = query(g, q, params) as unknown[];

  expect(bag(rows)).toBe(bag(want));

  // `FILTER true` keeps every row and takes the clause count to four, which the rung refuses.
  const twin = q.replace(' RETURN ', ' FILTER true RETURN ');

  expect(bag(query(g, twin, params) as unknown[])).toBe(bag(want));
};

describe('the FOR projection off the label bucket (item 528)', () => {
  test('one row per element, and ISO unwind for everything that is not a list', () => {
    both('MATCH (n:P) FOR t IN n.tags RETURN t AS t', [
      { t: 10 },
      { t: 20 },
      { t: 30 },
      { t: 40 },
      // `c`'s empty list and `e`/`f`'s absent-or-null key contribute NOTHING; `d`'s scalar
      // contributes exactly one row.
      { t: 'solo' },
    ]);
    both('MATCH (n:Q) FOR t IN n.tags RETURN t AS t', [{ t: 99 }]);
    // Unlabelled: every vertex.
    both('MATCH (n) FOR t IN n.tags RETURN t AS t', [
      { t: 10 },
      { t: 20 },
      { t: 30 },
      { t: 40 },
      { t: 'solo' },
      { t: 99 },
    ]);
    // A key nothing carries.
    both('MATCH (n:P) FOR t IN n.nope RETURN t AS t', []);
  });

  test('the projection may read the ANCHOR as well as the element', () => {
    both('MATCH (n:P) FOR t IN n.tags RETURN n.n AS k, t AS t', [
      { k: 1, t: 10 },
      { k: 1, t: 20 },
      { k: 1, t: 30 },
      { k: 2, t: 40 },
      { k: 4, t: 'solo' },
    ]);
    // An EXPRESSION over the element, so the item is not just a variable read.
    both('MATCH (n:Q) FOR t IN n.tags RETURN t + 1 AS k', [{ k: 100 }]);
    // …and one over both.
    both('MATCH (n:Q) FOR t IN n.tags RETURN n.n + t AS k', [{ k: 106 }]);
  });

  test('a ROW-INVARIANT list is evaluated once and shared', () => {
    both('MATCH (n:Q) FOR x IN [1, 2, 3] RETURN x AS x', [{ x: 1 }, { x: 2 }, { x: 3 }]);
    // Seven `:P` and `:Q` vertices, two elements each.
    both('MATCH (n) FOR x IN [1, 2] RETURN x AS x', [
      { x: 1 },
      { x: 1 },
      { x: 1 },
      { x: 1 },
      { x: 1 },
      { x: 1 },
      { x: 1 },
      { x: 2 },
      { x: 2 },
      { x: 2 },
      { x: 2 },
      { x: 2 },
      { x: 2 },
      { x: 2 },
    ]);
    both('MATCH (n:Q) FOR x IN [] RETURN x AS x', []);
    // A PARAM is fixed for the run, so the list is still row-invariant.
    both('MATCH (n:Q) FOR x IN $xs RETURN x AS x', [{ x: 7 }, { x: 8 }], { xs: [7, 8] });
  });

  test('WITH ORDINALITY and WITH OFFSET', () => {
    both('MATCH (n:Q) FOR x IN [5, 6] WITH ORDINALITY i RETURN x AS x, i AS i', [
      { x: 5, i: 1 },
      { x: 6, i: 2 },
    ]);
    both('MATCH (n:Q) FOR x IN [5, 6] WITH OFFSET i RETURN x AS x, i AS i', [
      { x: 5, i: 0 },
      { x: 6, i: 1 },
    ]);
    // The ordinal RESTARTS per anchor, which is what says the counter is not global.
    both('MATCH (n:P) FOR t IN n.tags WITH ORDINALITY i RETURN i AS i', [
      { i: 1 },
      { i: 2 },
      { i: 3 },
      { i: 1 },
      { i: 1 },
    ]);
  });

  test('the shapes the rung refuses are unchanged', () => {
    const rows = (q: string): unknown[] => query(g, q);

    // AGGREGATING — items 515 and 518 own this, and the row count proves which answered.
    expect(rows('MATCH (n:P) FOR t IN n.tags RETURN count(*) AS c')).toEqual([{ c: 5 }]);
    // DISTINCT, ORDER BY and paging all leave `plainRowProjection`.
    expect(bag(rows('MATCH (n) FOR x IN [1, 1] RETURN DISTINCT x AS x'))).toBe(bag([{ x: 1 }]));
    expect(rows('MATCH (n:P) FOR t IN n.tags RETURN t AS t ORDER BY t LIMIT 2')).toEqual([
      { t: 10 },
      { t: 20 },
    ]);
    expect(bag(rows('MATCH (n:P) FOR t IN n.tags RETURN t AS t LIMIT 1')).length).toBeGreaterThan(
      0,
    );
    // An inline constraint on the anchor, and a clause `WHERE`: both refused, both still right.
    expect(bag(rows('MATCH (n:P {n: 1}) FOR t IN n.tags RETURN t AS t'))).toBe(
      bag([{ t: 10 }, { t: 20 }, { t: 30 }]),
    );
    expect(bag(rows('MATCH (n:P) WHERE n.n = 2 FOR t IN n.tags RETURN t AS t'))).toBe(
      bag([{ t: 40 }]),
    );
    // A hop, so the anchor is not a lone node.
    expect(rows('MATCH (n:P)-[:T]->(m) FOR t IN n.tags RETURN t AS t')).toEqual([]);
  });

  test('a list read off a NON-anchor is refused, and still answered', () => {
    // `m.tags` is not the anchor's property, so the rung declines; the general path binds `m`.
    expect(bag(query(g, 'MATCH (n:Q), (m:P) FOR t IN m.tags RETURN t AS t') as unknown[])).toBe(
      bag([{ t: 10 }, { t: 20 }, { t: 30 }, { t: 40 }, { t: 'solo' }]),
    );
  });
});
