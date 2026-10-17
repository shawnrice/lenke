// Item 544. `detectCountShortcut` already explains why SKIP/LIMIT are NOT refused: an un-grouped
// `count(*)` with one item is exactly ONE ROW, so a page over it is arithmetic on a one-element
// list. DISTINCT and ORDER BY are identities on one row for the same reason, and refusing them
// cost a 0.00 ms answer 29.78 ms (`RETURN DISTINCT count(*)`) and 34.53 (`ORDER BY c`) at 200,000
// vertices.
//
// Neither spelling is contrived: ordering by the count you just asked for, or writing DISTINCT out
// of habit, is what a reader does.
//
// Every admitted case is asked TWICE — once as written and once with `FILTER true` inserted, which
// keeps every row but declines the shortcut, so the general path answers the same question. The
// REFUSALS matter as much: an ORDER BY key that is not the output column could FAULT while being
// evaluated, and a shortcut that skipped the sort would skip the fault with it.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { n: 2 } });
  g.addVertex({ id: 'c', labels: ['Q'], properties: { n: 3 } });

  return g;
};

const g = build();
const rows = (q: string): readonly unknown[] => query(g, q);

/** The shortcut's answer and the general path's, for the same question. */
const both = (tail: string, want: unknown[]): void => {
  const q = `MATCH (n:P) RETURN ${tail}`;

  expect(rows(q)).toEqual(want);
  // `FILTER true` keeps every row and declines the shortcut (`clauses` is no longer MATCH+RETURN).
  expect(rows(`MATCH (n:P) FILTER true RETURN ${tail}`)).toEqual(want);
};

describe('DISTINCT and ORDER BY over a one-row count (item 544)', () => {
  test('both are identities, and the two routes agree', () => {
    both('count(*) AS c', [{ c: 2 }]);
    both('DISTINCT count(*) AS c', [{ c: 2 }]);
    both('count(*) AS c ORDER BY c', [{ c: 2 }]);
    both('count(*) AS c ORDER BY c DESC', [{ c: 2 }]);
    both('DISTINCT count(*) AS c ORDER BY c', [{ c: 2 }]);
  });

  test('paging composes with them, including the empty page', () => {
    both('DISTINCT count(*) AS c ORDER BY c LIMIT 1', [{ c: 2 }]);
    both('count(*) AS c ORDER BY c SKIP 0 LIMIT 1', [{ c: 2 }]);
    // A ZERO limit keeps no rows — the sort key is never evaluated, which is the behaviour
    // `detectCountShortcut`'s `pageOneRow` already had and must keep.
    both('count(*) AS c ORDER BY c LIMIT 0', []);
    both('DISTINCT count(*) AS c SKIP 1', []);
  });

  test('the count itself is still the count', () => {
    // A different label, so a shortcut answering a constant would show.
    expect(rows('MATCH (n:Q) RETURN DISTINCT count(*) AS c ORDER BY c')).toEqual([{ c: 1 }]);
    expect(rows('MATCH (n) RETURN DISTINCT count(*) AS c ORDER BY c')).toEqual([{ c: 3 }]);
  });

  test('an ORDER BY key that is not the OUTPUT COLUMN is refused', () => {
    // `c + 0` is an expression, not a reference, so the shortcut declines and the general path
    // evaluates the key. That matters because a key can FAULT:
    expect(() => rows('MATCH (n:P) RETURN count(*) AS c ORDER BY 1 / 0')).toThrow();
    // …and the shortcut must not answer past that fault. The same query without the ORDER BY is
    // the control: it is answered, so the throw above is the KEY and not the count.
    expect(rows('MATCH (n:P) RETURN count(*) AS c')).toEqual([{ c: 2 }]);
  });

  test('a GROUPED count still declines — it is not one row', () => {
    // Two groups, so a shortcut that answered one global count would be a wrong answer. This is
    // the guard `detectCountShortcut` added after measuring exactly that.
    const grouped = rows('MATCH (n) RETURN n.n AS k, count(*) AS c') as Record<string, unknown>[];

    expect(grouped.length).toBe(3);
    expect(rows('MATCH (n) RETURN DISTINCT n.n AS k ORDER BY k')).toEqual([
      { k: 1 },
      { k: 2 },
      { k: 3 },
    ]);
  });
});

// Item 545 extends the same identity to the four AGGREGATE rungs, which refused both clauses for
// the same wrong reason. Priced at 200,000 vertices / 400,000 edges, one case per process:
//
//   MATCH (n:Person) RETURN max(n.age)                        12.28 ms
//   ...RETURN DISTINCT max(n.age)                             38.02
//   ...RETURN max(n.age) ORDER BY m                           37.06
//   MATCH (:Person)-[:KNOWS]->(b) RETURN max(b.age)           90.71
//   ...RETURN DISTINCT max(b.age)                            385.64
//   ...RETURN max(b.age) ORDER BY m                          428.73
//
// An un-grouped aggregate projection delivers exactly ONE row whatever the aggregate is, so the
// argument is `detectCountShortcut`'s unchanged. All four rungs share `sortsOnOutputOnly`.
describe('DISTINCT and ORDER BY over a one-row AGGREGATE (item 545)', () => {
  const agg = (tail: string, want: unknown[]): void => {
    expect(rows(`MATCH (n:P) RETURN ${tail}`)).toEqual(want);
    expect(rows(`MATCH (n:P) FILTER true RETURN ${tail}`)).toEqual(want);
  };

  test('the single-item NODE rung', () => {
    agg('max(n.n) AS m', [{ m: 2 }]);
    agg('DISTINCT max(n.n) AS m', [{ m: 2 }]);
    agg('max(n.n) AS m ORDER BY m', [{ m: 2 }]);
    agg('max(n.n) AS m ORDER BY m DESC', [{ m: 2 }]);
    agg('DISTINCT min(n.n) AS m ORDER BY m', [{ m: 1 }]);
    // `sum` and `collect` reach the rung through the VALUES path (items 530, 544's sibling).
    agg('DISTINCT sum(n.n) AS m', [{ m: 3 }]);
    agg('DISTINCT collect(n.n) AS m', [{ m: [1, 2] }]);
  });

  test('the MULTI-item node rung', () => {
    agg('DISTINCT count(*) AS c, max(n.n) AS m', [{ c: 2, m: 2 }]);
    agg('count(*) AS c, max(n.n) AS m ORDER BY m', [{ c: 2, m: 2 }]);
    // Ordering by the OTHER output column is equally an identity.
    agg('count(*) AS c, max(n.n) AS m ORDER BY c', [{ c: 2, m: 2 }]);
  });

  test('a GROUPED projection is NOT one row and still declines', () => {
    // The grouped rungs share their guard TEXT with the multi-item ones — three identical copies
    // in one file — so the anchor for this change had to be the comment above each. If a grouped
    // rung had been patched too, DISTINCT would collapse these three rows to fewer.
    expect(rows('MATCH (n) RETURN n.n AS k, count(*) AS c ORDER BY k')).toEqual([
      { k: 1, c: 1 },
      { k: 2, c: 1 },
      { k: 3, c: 1 },
    ]);
    expect((rows('MATCH (n) RETURN DISTINCT n.n AS k, count(*) AS c') as unknown[]).length).toBe(3);
  });

  test('a faulting sort key still raises on every rung', () => {
    expect(() => rows('MATCH (n:P) RETURN max(n.n) AS m ORDER BY 1 / 0')).toThrow();
    expect(() => rows('MATCH (n:P) RETURN count(*) AS c, max(n.n) AS m ORDER BY 1 / 0')).toThrow();
    // The controls: the same queries without the ORDER BY are answered, so the throw is the KEY.
    expect(rows('MATCH (n:P) RETURN max(n.n) AS m')).toEqual([{ m: 2 }]);
    expect(rows('MATCH (n:P) RETURN count(*) AS c, max(n.n) AS m')).toEqual([{ c: 2, m: 2 }]);
  });
});
