import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// The grouped-count tally declined every `ORDER BY`, and its own note said why: the sort
// reorders the groups BEFORE the window and the tally did not sort. So `ORDER BY c DESC` — the
// top-categories-by-count shape — went through the general path at 75.67ms where the tally alone
// is 8.35ms (audit item 190).
//
// The tally's output is ONE ROW PER GROUP, which is the answer, and both possible sort keys are
// OUTPUT COLUMNS of it: the group key and the count. That is what makes several keys safe here
// where item 189 had to refuse them — an output column's value is already computed, so nothing
// is left unevaluated and no raise can be swallowed.
//
// The fixture gives every group a DIFFERENT size and inserts them out of both orders, so
// key-order, count-order and first-seen order are three DIFFERENT answers. A fixture where they
// coincide cannot tell a correct sort from a missing one.
//
//   first-seen:  b, a, d, c        by key:  a, b, c, d
//   by count desc: b(3), c(2), d(2), a(1)   — with c/d tied, so a second key is observable
const build = (): Graph => {
  const g = new Graph();
  const add = (id: string, k: string) => g.addVertex({ id, labels: ['P'], properties: { k } });

  add('v0', 'b');
  add('v1', 'a');
  add('v2', 'd');
  add('v3', 'c');
  add('v4', 'b');
  add('v5', 'c');
  add('v6', 'b');
  add('v7', 'd');

  return g;
};

const g = build();

/** Forced to the general path by a second `LET`, which takes the clause count out of range. */
const viaGeneral = (q: string): unknown => {
  const i = q.indexOf(' LET ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

const TALLY = 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a';

describe('ORDER BY over a grouped count', () => {
  test('without an ORDER BY the groups stay FIRST-SEEN, which is the pinned contract', () => {
    expect(query(g, TALLY)).toEqual([
      { a: 'b', c: 3 },
      { a: 'a', c: 1 },
      { a: 'd', c: 2 },
      { a: 'c', c: 2 },
    ]);
  });

  test('ORDER BY the key sorts by the key, not by the count', () => {
    const sorted = query(g, `${TALLY} ORDER BY a`);

    expect(sorted).toEqual([
      { a: 'a', c: 1 },
      { a: 'b', c: 3 },
      { a: 'c', c: 2 },
      { a: 'd', c: 2 },
    ]);
    expect(sorted).toEqual(viaGeneral(`${TALLY} ORDER BY a`));
  });

  test('ORDER BY the key DESC', () => {
    const sorted = query(g, `${TALLY} ORDER BY a DESC`);

    expect(sorted).toEqual([
      { a: 'd', c: 2 },
      { a: 'c', c: 2 },
      { a: 'b', c: 3 },
      { a: 'a', c: 1 },
    ]);
    expect(sorted).toEqual(viaGeneral(`${TALLY} ORDER BY a DESC`));
  });

  test('ORDER BY the COUNT descending — the top-categories shape', () => {
    const sorted = query(g, `${TALLY} ORDER BY c DESC`);

    // b(3) first; c and d tie at 2 and keep their first-seen order relative to each other.
    expect(sorted).toEqual(viaGeneral(`${TALLY} ORDER BY c DESC`));
    expect((sorted as Array<{ c: number }>).map((r) => r.c)).toEqual([3, 2, 2, 1]);
    expect((sorted as Array<{ a: string }>)[0].a).toBe('b');
  });

  test('ORDER BY the COUNT ascending', () => {
    const sorted = query(g, `${TALLY} ORDER BY c`);

    expect(sorted).toEqual(viaGeneral(`${TALLY} ORDER BY c`));
    expect((sorted as Array<{ c: number }>).map((r) => r.c)).toEqual([1, 2, 2, 3]);
  });

  test('TWO keys: the count then the group key breaks the tie', () => {
    const sorted = query(g, `${TALLY} ORDER BY c DESC, a`);

    expect(sorted).toEqual([
      { a: 'b', c: 3 },
      { a: 'c', c: 2 },
      { a: 'd', c: 2 },
      { a: 'a', c: 1 },
    ]);
    expect(sorted).toEqual(viaGeneral(`${TALLY} ORDER BY c DESC, a`));
  });

  test('TWO keys with the tiebreak reversed', () => {
    const sorted = query(g, `${TALLY} ORDER BY c DESC, a DESC`);

    expect(sorted).toEqual([
      { a: 'b', c: 3 },
      { a: 'd', c: 2 },
      { a: 'c', c: 2 },
      { a: 'a', c: 1 },
    ]);
    expect(sorted).toEqual(viaGeneral(`${TALLY} ORDER BY c DESC, a DESC`));
  });

  test('the window applies AFTER the sort', () => {
    // The whole point of the old decline: a page over first-seen order is a different answer.
    expect(query(g, `${TALLY} ORDER BY c DESC LIMIT 2`)).toEqual([
      { a: 'b', c: 3 },
      { a: 'd', c: 2 },
    ]);
    expect(query(g, `${TALLY} ORDER BY a OFFSET 2`)).toEqual([
      { a: 'c', c: 2 },
      { a: 'd', c: 2 },
    ]);
    expect(query(g, `${TALLY} ORDER BY a OFFSET 1 LIMIT 2`)).toEqual([
      { a: 'b', c: 3 },
      { a: 'c', c: 2 },
    ]);
  });

  test('LIMIT 0 yields no rows', () => {
    expect(query(g, `${TALLY} ORDER BY c DESC LIMIT 0`)).toEqual([]);
  });

  test('the two-clause property spelling sorts by the key expression', () => {
    const sorted = query(g, 'MATCH (n:P) RETURN n.k AS a, count(*) AS c ORDER BY n.k');

    expect(sorted).toEqual([
      { a: 'a', c: 1 },
      { a: 'b', c: 3 },
      { a: 'c', c: 2 },
      { a: 'd', c: 2 },
    ]);
  });

  test('the count-first column order is preserved under a sort', () => {
    const rows = query(g, 'MATCH (n:P) RETURN count(*) AS c, n.k AS a ORDER BY a');

    // COLUMN order is bytes, and the tally builds the row count-first for this spelling.
    expect(Object.keys(rows[0])).toEqual(['c', 'a']);
    expect(rows).toEqual([
      { c: 1, a: 'a' },
      { c: 3, a: 'b' },
      { c: 2, a: 'c' },
      { c: 2, a: 'd' },
    ]);
  });

  test('a null key sorts where the engine default puts it — LAST', () => {
    const n = new Graph();
    n.addVertex({ id: 'x', labels: ['P'], properties: { k: 'z' } });
    n.addVertex({ id: 'y', labels: ['P'], properties: {} });
    n.addVertex({ id: 'w', labels: ['P'], properties: { k: 'a' } });

    expect(query(n, `${TALLY} ORDER BY a`)).toEqual([
      { a: 'a', c: 1 },
      { a: 'z', c: 1 },
      { a: null, c: 1 },
    ]);
  });

  test('NULLS FIRST on the key is honoured', () => {
    const n = new Graph();
    n.addVertex({ id: 'x', labels: ['P'], properties: { k: 'z' } });
    n.addVertex({ id: 'y', labels: ['P'], properties: {} });

    expect(query(n, `${TALLY} ORDER BY a NULLS FIRST`)).toEqual([
      { a: null, c: 1 },
      { a: 'z', c: 1 },
    ]);
  });

  test('a grouped count over a HOP sorts too — the second tally', () => {
    const h = new Graph();
    const s = h.addVertex({ id: 's', labels: ['P'], properties: {} });
    const mk = (id: string, k: string) => {
      const f = h.addVertex({ id, labels: ['Q'], properties: { k } });
      h.addEdge({ from: s, to: f, labels: ['T'], properties: {} });
    };

    mk('f0', 'b');
    mk('f1', 'a');
    mk('f2', 'b');

    expect(
      query(h, 'MATCH (x:P)-[:T]->(f) LET a = f.k RETURN a, count(*) AS c GROUP BY a ORDER BY c'),
    ).toEqual([
      { a: 'a', c: 1 },
      { a: 'b', c: 2 },
    ]);
  });

  describe('shapes that must NOT take the tally', () => {
    test('a sort key that is not an output column', () => {
      const n = new Graph();
      n.addVertex({ id: 'x', labels: ['P'], properties: { k: 'b', other: 1 } });
      n.addVertex({ id: 'y', labels: ['P'], properties: { k: 'a', other: 2 } });

      // The general path sorts the INPUT rows by `other` and groups after, which the tally's
      // output cannot be post-sorted into.
      expect(query(n, 'MATCH (n:P) RETURN n.k AS a, count(*) AS c ORDER BY n.other')).toEqual([
        { a: 'b', c: 1 },
        { a: 'a', c: 1 },
      ]);
    });

    test('a sort key that is an EXPRESSION over a column', () => {
      // `c * 2` is not a bare column, so it declines — and still sorts correctly.
      expect(query(g, `${TALLY} ORDER BY c * 2 DESC`)).toEqual([
        { a: 'b', c: 3 },
        { a: 'd', c: 2 },
        { a: 'c', c: 2 },
        { a: 'a', c: 1 },
      ]);
    });

    test('two items sharing ONE output name are ambiguous and decline', () => {
      // Both items are named `x`, so the row carries one `x` and a sort key `x` cannot say
      // which column it means. Refused rather than guessed.
      const rows = query(g, 'MATCH (n:P) RETURN n.k AS x, count(*) AS x ORDER BY x');

      expect(Object.keys(rows[0])).toEqual(['x']);
      // The ORDER is what distinguishes a decline from a guess, and asserting only the keys and
      // the length let a mutant accepting the ambiguity survive. The general path sorts by the
      // output column `x` resolved to the KEY (a, b, c, d → counts 1, 3, 2, 2); a tally reading
      // `row.x` would find the COUNT there, since the second item overwrites the first, and
      // answer 1, 2, 2, 3.
      expect(rows).toEqual([{ x: 1 }, { x: 3 }, { x: 2 }, { x: 2 }]);
      expect(rows).toEqual(
        query(g, 'MATCH (n:P) LET _z = 1 RETURN n.k AS x, count(*) AS x ORDER BY x'),
      );
    });

    test('an un-grouped count keeps declining, which a whole test file relies on', () => {
      // `count-shortcut.test.ts` uses `ORDER BY c` as its ORACLE: adding it forces the general
      // path so a shortcut can be compared against it. That device only works while the
      // un-grouped count refuses ordering, so this pins the answer and the file's premise.
      expect(query(g, 'MATCH (n:P) RETURN count(*) AS c ORDER BY c')).toEqual([{ c: 8 }]);
    });
  });
});
