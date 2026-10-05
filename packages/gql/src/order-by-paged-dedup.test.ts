import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 189 carried a single `ORDER BY` onto the dedup walk but left the window with the general
// path, so `ORDER BY a LIMIT 5` was 138.83ms where the same query WITHOUT the limit was 14.11ms —
// adding a `LIMIT` made it 9.8x slower. Once a sort is in the way neither path can exit early, so
// the walk takes the window too and applies it AFTER the sort (audit item 191).
//
// An UN-ORDERED window still declines, and that is measured rather than cautious: the general
// path is lazy there and `RETURN DISTINCT n.age AS a LIMIT 5` is 0.11ms against the walk's
// 14.11ms, because the walk scans the whole bucket.
//
// The fixture makes FIRST-SEEN order differ from SORTED order, so paging the wrong one picks
// different rows:
//
//   first-seen distinct: 20, 10, 30        sorted: 10, 20, 30
//   so `ORDER BY a LIMIT 2` is 10, 20 — and a page over first-seen order would say 20, 10.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'v0', labels: ['P'], properties: { n: 20 } });
  g.addVertex({ id: 'v1', labels: ['P'], properties: { n: 10 } });
  g.addVertex({ id: 'v2', labels: ['P'], properties: { n: 20 } });
  g.addVertex({ id: 'v3', labels: ['P'], properties: { n: 30 } });
  g.addVertex({ id: 'v4', labels: ['P'], properties: { n: 10 } });

  return g;
};

const g = build();

/** Forced to the general path by a dead `LET`, which the dedup walk declines. */
const viaGeneral = (q: string) => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

const D = 'MATCH (n:P) RETURN DISTINCT n.n AS a';

describe('a window over a sorted dedup', () => {
  test('LIMIT takes the SORTED head, not the first-seen one', () => {
    const paged = query(g, `${D} ORDER BY a LIMIT 2`);

    expect(paged).toEqual([{ a: 10 }, { a: 20 }]);
    expect(paged).toEqual(viaGeneral(`${D} ORDER BY a LIMIT 2`));
    // The distinguishing comparison: first-seen order would have answered 20, 10.
    expect(query(g, `${D} LIMIT 2`)).toEqual([{ a: 20 }, { a: 10 }]);
  });

  test('OFFSET skips from the sorted head', () => {
    const paged = query(g, `${D} ORDER BY a OFFSET 1`);

    expect(paged).toEqual([{ a: 20 }, { a: 30 }]);
    expect(paged).toEqual(viaGeneral(`${D} ORDER BY a OFFSET 1`));
  });

  test('OFFSET and LIMIT together', () => {
    const paged = query(g, `${D} ORDER BY a OFFSET 1 LIMIT 1`);

    expect(paged).toEqual([{ a: 20 }]);
    expect(paged).toEqual(viaGeneral(`${D} ORDER BY a OFFSET 1 LIMIT 1`));
  });

  test('DESC with a LIMIT takes the other end', () => {
    const paged = query(g, `${D} ORDER BY a DESC LIMIT 2`);

    expect(paged).toEqual([{ a: 30 }, { a: 20 }]);
    expect(paged).toEqual(viaGeneral(`${D} ORDER BY a DESC LIMIT 2`));
  });

  test('a LIMIT past the end keeps every row', () => {
    expect(query(g, `${D} ORDER BY a LIMIT 99`)).toEqual([{ a: 10 }, { a: 20 }, { a: 30 }]);
  });

  test('an OFFSET past the end keeps none', () => {
    expect(query(g, `${D} ORDER BY a OFFSET 99`)).toEqual([]);
  });

  test('the bounds may be params, resolved per execution', () => {
    expect(query(g, `${D} ORDER BY a OFFSET $o LIMIT $l`, { o: 1, l: 1 })).toEqual([{ a: 20 }]);
    expect(query(g, `${D} ORDER BY a OFFSET $o LIMIT $l`, { o: 0, l: 2 })).toEqual([
      { a: 10 },
      { a: 20 },
    ]);
  });

  test('a GROUP BY with no aggregate pages the same way', () => {
    const paged = query(g, 'MATCH (n:P) LET a = n.n RETURN a GROUP BY a ORDER BY a LIMIT 2');

    expect(paged).toEqual([{ a: 10 }, { a: 20 }]);
    expect(paged).toEqual(
      query(g, 'MATCH (n:P) LET _z = 1 LET a = n.n RETURN a GROUP BY a ORDER BY a LIMIT 2'),
    );
  });

  test('a hop keyed on the far end pages its sorted output', () => {
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

    expect(query(h, 'MATCH (x:P)-[:T]->(f) RETURN DISTINCT f.n AS a ORDER BY a LIMIT 2')).toEqual([
      { a: 10 },
      { a: 20 },
    ]);
  });

  describe('LIMIT 0 must emit nothing WITHOUT evaluating', () => {
    test('a zero limit yields no rows', () => {
      expect(query(g, `${D} ORDER BY a LIMIT 0`)).toEqual([]);
    });

    test('a zero limit does not raise on a projection that would fault', () => {
      // The general path returns `[]` from `applyProjection` BEFORE projecting anything, so a
      // walk that ran first and sliced afterwards would raise where the query does not. This is
      // the rule `pageIsEmpty` exists for in the tally, and it is why the guard runs before the
      // walk rather than after it.
      const z = new Graph();
      z.addVertex({ id: 'a', labels: ['P'], properties: { n: 10 } }); // n - 10 === 0
      z.addVertex({ id: 'b', labels: ['P'], properties: { n: 20 } });

      expect(
        query(z, 'MATCH (n:P) LET a = 1/(n.n - 10) RETURN DISTINCT a ORDER BY a LIMIT 0'),
      ).toEqual([]);
      // At any non-zero limit the same query DOES raise, in both engines, which is what makes
      // the zero case a rule rather than an accident.
      expect(() =>
        query(z, 'MATCH (n:P) LET a = 1/(n.n - 10) RETURN DISTINCT a ORDER BY a LIMIT 1'),
      ).toThrow(/division by zero/);
    });

    test('a zero limit from a PARAM also yields no rows', () => {
      expect(query(g, `${D} ORDER BY a LIMIT $l`, { l: 0 })).toEqual([]);
    });
  });

  describe('an UN-ORDERED window still declines', () => {
    test('a LIMIT with no ORDER BY keeps the general path lazy', () => {
      // 0.11ms against the walk's 14.11ms at 200,000 nodes, because the general path stops after
      // the first few distinct values and the walk scans the whole bucket. The ANSWER that goes
      // with that decision is walk order, NOT sorted order.
      expect(query(g, `${D} LIMIT 2`)).toEqual([{ a: 20 }, { a: 10 }]);
    });

    test('an un-ordered LIMIT is RAISE PARITY, not just speed', () => {
      // The lazy path stops after the first few distinct values, so a row it never reaches
      // cannot fault. The walk scans the whole bucket, so it would. That makes the decline a
      // correctness rule and not only a performance one — a mutant taking the un-ordered
      // window survived until this test, because walk order and lazy order AGREE and no
      // answer-shaped assertion could tell them apart.
      const z = new Graph();
      z.addVertex({ id: 'a', labels: ['P'], properties: { n: 20 } }); // 1/(20-10) is fine
      z.addVertex({ id: 'b', labels: ['P'], properties: { n: 10 } }); // 1/(10-10) raises
      z.addVertex({ id: 'c', labels: ['P'], properties: { n: 30 } });

      const Q = 'MATCH (n:P) LET a = 1/(n.n - 10) RETURN DISTINCT a';

      expect(query(z, `${Q} LIMIT 1`)).toEqual([{ a: 0.1 }]);
      // Two rows reaches the faulting one, so it raises — the limit is doing real work.
      expect(() => query(z, `${Q} LIMIT 2`)).toThrow(/division by zero/);
      // And WITH an ORDER BY it raises even at LIMIT 1, because a sort must see every row —
      // which is exactly why the walk may take the window there and not here.
      expect(() => query(z, `${Q} ORDER BY a LIMIT 1`)).toThrow(/division by zero/);
    });

    test('an OFFSET with no ORDER BY declines too, and the order is unspecified', () => {
      // Measured at 95.24ms against ~11ms if the walk took it: an OFFSET cannot exit early, so
      // there IS ~8.8x here. It is left alone deliberately — paging without an ORDER BY is a
      // window over an unspecified order, and splitting the rule on WHICH paging clause is
      // present would add a branch for a query nobody should write. Recorded, not taken.
      expect(query(g, `${D} OFFSET 1`)).toEqual([{ a: 10 }, { a: 30 }]);
    });
  });
});
