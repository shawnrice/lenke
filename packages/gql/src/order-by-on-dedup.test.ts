import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Adding `ORDER BY` to a dedup cost 10.3x — 13.90ms to 142.64ms on 200,000 nodes — to sort the
// NINETY rows it returns, because every dedup fast path declined on `orderBy.length > 0` and the
// general path then materialized and sorted every input row. Sorting a dedup by its OWN projected
// value is a sort of the ANSWER, so the walk does it afterwards (audit item 189).
//
// The two orders agree, and that is the whole argument: when the sort key IS the projected value,
// every row of a dedup group shares the key, so the general path's sort-then-dedup keeps the same
// representative (the rows are identical) and emits groups in key order — which is what
// dedup-then-sort gives. Each test therefore compares against a spelling that goes elsewhere.
//
// The fixture gives DUPLICATES whose first occurrence is out of sorted order, so a walk that
// forgot to sort, or sorted the wrong way, cannot agree by accident.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'v0', labels: ['P'], properties: { n: 20, s: 'mm' } });
  g.addVertex({ id: 'v1', labels: ['P'], properties: { n: 10, s: 'zz' } });
  g.addVertex({ id: 'v2', labels: ['P'], properties: { n: 20, s: 'aa' } });
  g.addVertex({ id: 'v3', labels: ['P'], properties: { n: 30, s: 'mm' } });
  g.addVertex({ id: 'v4', labels: ['P'], properties: { n: 10, s: 'qq' } });

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the dedup walk declines. */
const viaGeneral = (q: string): unknown => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

describe('ORDER BY over a dedup', () => {
  test('sorts ascending by the output column', () => {
    const sorted = query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY a');

    // Walk order is 20, 10, 30 — so this cannot pass without a sort.
    expect(sorted).toEqual([{ a: 10 }, { a: 20 }, { a: 30 }]);
    expect(sorted).toEqual(viaGeneral('MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY a'));
  });

  test('the ORDER BY <expression> spelling agrees', () => {
    expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY n.n')).toEqual([
      { a: 10 },
      { a: 20 },
      { a: 30 },
    ]);
  });

  test('DESC is honoured', () => {
    const sorted = query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY a DESC');

    expect(sorted).toEqual([{ a: 30 }, { a: 20 }, { a: 10 }]);
    expect(sorted).toEqual(viaGeneral('MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY a DESC'));
  });

  test('strings sort by the engine comparator, not by walk order', () => {
    const sorted = query(g, 'MATCH (n:P) RETURN DISTINCT n.s AS a ORDER BY a');

    expect(sorted).toEqual([{ a: 'aa' }, { a: 'mm' }, { a: 'qq' }, { a: 'zz' }]);
    expect(sorted).toEqual(viaGeneral('MATCH (n:P) RETURN DISTINCT n.s AS a ORDER BY a'));
  });

  test('a GROUP BY with no aggregate sorts the same way', () => {
    const sorted = query(g, 'MATCH (n:P) LET a = n.n RETURN a GROUP BY a ORDER BY a');

    expect(sorted).toEqual([{ a: 10 }, { a: 20 }, { a: 30 }]);
    expect(sorted).toEqual(
      query(g, 'MATCH (n:P) LET _z = 1 LET a = n.n RETURN a GROUP BY a ORDER BY a'),
    );
  });

  describe('null placement', () => {
    const withNull = (): Graph => {
      const n = new Graph();
      n.addVertex({ id: 'a', labels: ['P'], properties: { n: 2 } });
      n.addVertex({ id: 'b', labels: ['P'], properties: {} }); // absent → null
      n.addVertex({ id: 'c', labels: ['P'], properties: { n: 1 } });

      return n;
    };

    test('the engine default puts nulls LAST', () => {
      const n = withNull();

      expect(query(n, 'MATCH (x:P) RETURN DISTINCT x.n AS a ORDER BY a')).toEqual([
        { a: 1 },
        { a: 2 },
        { a: null },
      ]);
    });

    test('NULLS FIRST is honoured', () => {
      const n = withNull();

      expect(query(n, 'MATCH (x:P) RETURN DISTINCT x.n AS a ORDER BY a NULLS FIRST')).toEqual([
        { a: null },
        { a: 1 },
        { a: 2 },
      ]);
    });

    test('NULLS LAST with DESC is honoured', () => {
      const n = withNull();

      expect(query(n, 'MATCH (x:P) RETURN DISTINCT x.n AS a ORDER BY a DESC NULLS LAST')).toEqual([
        { a: 2 },
        { a: 1 },
        { a: null },
      ]);
    });
  });

  test('an alias that SHADOWS a pattern variable sorts by the output column', () => {
    // The output column wins over the input variable, which the general path already does — so
    // the walk must agree, and `a` here is both the node and the projected age.
    const sorted = query(g, 'MATCH (a:P) RETURN DISTINCT a.n AS a ORDER BY a');

    expect(sorted).toEqual([{ a: 10 }, { a: 20 }, { a: 30 }]);
  });

  test('a non-property source sorts by the alias', () => {
    const sorted = query(g, 'MATCH (n:P) LET a = n.n + 1 RETURN DISTINCT a ORDER BY a');

    expect(sorted).toEqual([{ a: 11 }, { a: 21 }, { a: 31 }]);
    expect(sorted).toEqual(
      query(g, 'MATCH (n:P) LET _z = 1 LET a = n.n + 1 RETURN DISTINCT a ORDER BY a'),
    );
  });

  test('a hop keyed on the far end sorts its output', () => {
    const h = new Graph();
    const s = h.addVertex({ id: 's', labels: ['P'], properties: {} });

    for (const [id, n] of [
      ['f0', 20],
      ['f1', 10],
      ['f2', 20],
      ['f3', 30],
    ] as Array<[string, number]>) {
      const f = h.addVertex({ id, labels: ['Q'], properties: { n } });
      h.addEdge({ from: s, to: f, labels: ['T'], properties: {} });
    }

    expect(query(h, 'MATCH (x:P)-[:T]->(f) RETURN DISTINCT f.n AS a ORDER BY a')).toEqual([
      { a: 10 },
      { a: 20 },
      { a: 30 },
    ]);
  });

  describe('shapes that must NOT take the walk', () => {
    test('a sort key the projection does not carry sorts the INPUT rows first', () => {
      // `ORDER BY n.s` sorts the five input rows by `s` and dedupes AFTER, which no post-sort of
      // the output can reproduce: by `s` the order is aa(20), mm(20), mm(30), qq(10), zz(10), so
      // the distinct `n` comes out 20, 30, 10 — NOT sorted.
      expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS x ORDER BY n.s')).toEqual([
        { x: 20 },
        { x: 30 },
        { x: 10 },
      ]);
    });

    // ORDER BY + LIMIT and ORDER BY + OFFSET moved OUT of this block in item 191, which takes
    // the window onto the walk when a sort is accepted. See `order-by-paged-dedup.test.ts`.

    test('ORDER BY with OFFSET, kept here as a second reading of the same answer', () => {
      expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY a OFFSET 1')).toEqual([
        { a: 20 },
        { a: 30 },
      ]);
    });

    test('a LIMIT with no ORDER BY keeps the lazy early exit', () => {
      // The walk scans the whole bucket; the general path is LAZY and stops after the first
      // distinct values — 0.05ms against the walk's 13.90ms at 200,000 nodes. So paging stays
      // with the general path, and this pins the ANSWER that goes with that decision: walk
      // order, not sorted order.
      expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS a LIMIT 2')).toEqual([
        { a: 20 },
        { a: 10 },
      ]);
    });

    test('two sort keys decline and still sort', () => {
      expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY a, n.n')).toEqual([
        { a: 10 },
        { a: 20 },
        { a: 30 },
      ]);
    });

    test('a LATER sort key still RAISES, which is why one key is the limit', () => {
      // The ORDER they produce cannot differ — the output rows are already distinct in the FIRST
      // key, so no tie exists for a later key to break, and dropping it looked free. It is not:
      // a later key is still EVALUATED per row and can raise, and a walk that never evaluates it
      // would swallow that. A mutant accepting any number of keys survived until this test
      // existed, because the fixture's second key agreed with the first.
      expect(() => query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY a, 1/0')).toThrow(
        /division by zero/,
      );
      // A PER-ROW divisor, so the raise depends on the data rather than on a folded constant.
      // (`1/n.absent` would NOT raise — an absent key reads null and `1/null` is null.)
      expect(() =>
        query(g, 'MATCH (n:P) RETURN DISTINCT n.n AS a ORDER BY a, 1/(n.n - 10)'),
      ).toThrow(/division by zero/);
    });

    test('an aggregate alongside the key is the tally, which does not sort here', () => {
      expect(
        query(g, 'MATCH (n:P) LET a = n.n RETURN a, count(*) AS c GROUP BY a ORDER BY a'),
      ).toEqual([
        { a: 10, c: 2 },
        { a: 20, c: 2 },
        { a: 30, c: 1 },
      ]);
    });
  });
});
