import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Two changes, and the first is why the second had no effect on its own.
//
// The grouped-count tally accepted `GROUP BY` only in the `LET` form, naming the bound variable.
// ISO's SELECT spelling writes the PROPERTY and has no `LET` to name, so it declined the tally
// entirely — with or without a `HAVING`:
//
//   MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a          3.96ms
//   SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k       52.36ms
//
// One question, 13x apart. `HAVING` is then a post-filter on the tally's own rows — one row per
// group already exists — provided every aggregate in it is `count(*)`, which is all the tally
// has. Anything else (`sum`, `avg`, `collect`) needs the group's members and declines (item 199).
//
// The delicate part is the REPRESENTATIVE: a `HAVING` may read a non-key property, and the
// general path evaluates it against `group[0]` — the first row of the group. The tally keeps the
// vertex that OPENED each group, and visits vertices in the general path's order, so the two pick
// the same row. The fixture below makes that observable: within one group the first and second
// members disagree on `tag`.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, k: string, tag: number) =>
    g.addVertex({ id, labels: ['P'], properties: { k, tag } });

  // Group 'x' has THREE members; its first is tag 1 and the others are tag 9.
  v('x1', 'x', 1);
  v('y1', 'y', 7);
  v('x2', 'x', 9);
  v('z1', 'z', 7);
  v('x3', 'x', 9);
  v('y2', 'y', 9);

  return g;
};

const g = build();

const S = 'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k';
const L = 'MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a';

// Forced to the general path by a THIRD projected item: the tally wants exactly two, a key and a
// `count(*)`. `1 AS _z` is a constant, so the general path evaluates it on the group's first row
// and every group answers 1 — it changes which plan runs and nothing else. The extra column is
// stripped so the two plans' rows compare directly.
//
// A dead `LET` is the usual way to do this and it does NOT work here: ISO's `FROM MATCH` takes no
// `LET`, so `SELECT … FROM MATCH (n:P) LET _z = 1 GROUP BY …` is a syntax error, not a slow plan.
const viaGeneral = (q: string) => {
  const forced = q.replace(' AS c FROM MATCH ', ' AS c, 1 AS _z FROM MATCH ');

  expect(forced).not.toBe(q);

  return query(g, forced).map(({ _z, ...rest }) => rest);
};

describe('the SELECT spelling reaches the tally', () => {
  test('the property GROUP BY answers as the LET spelling does, in the same order', () => {
    expect(query(g, S)).toEqual([
      { a: 'x', c: 3 },
      { a: 'y', c: 2 },
      { a: 'z', c: 1 },
    ]);
    expect(query(g, S)).toEqual(query(g, L));
  });

  test('the two-clause RETURN spelling still works', () => {
    expect(query(g, 'MATCH (n:P) RETURN n.k AS a, count(*) AS c')).toEqual(query(g, S));
  });

  test('a grouping element that is NOT the key item declines', () => {
    // Grouping by `tag` while projecting `k` is a different question: one row per TAG, carrying a
    // representative k. A tally keyed on `k` cannot answer it — three tags, not three k's — and
    // the counts differ too.
    const q = 'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.tag';

    expect(query(g, q)).toEqual(viaGeneral(q));
    expect(query(g, q)).toEqual([
      { a: 'x', c: 1 }, // tag 1
      { a: 'y', c: 2 }, // tag 7: y1, z1
      { a: 'x', c: 3 }, // tag 9: x2, x3, y2
    ]);
  });

  test('TWO grouping elements decline', () => {
    const q = 'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k, n.tag';

    expect(query(g, q)).toEqual(viaGeneral(q));
    // Five (k, tag) pairs: x/1, y/7, x/9, z/7, y/9 — so `a` REPEATS, which a tally keyed on `k`
    // alone could not produce at all.
    expect(query(g, q).length).toBe(5);
  });
});

describe('HAVING on the tally', () => {
  test('on the COUNT', () => {
    expect(query(g, `${S} HAVING count(*) > 1`)).toEqual([
      { a: 'x', c: 3 },
      { a: 'y', c: 2 },
    ]);
    expect(query(g, `${S} HAVING count(*) > 1`)).toEqual(viaGeneral(`${S} HAVING count(*) > 1`));
  });

  test('on the KEY', () => {
    expect(query(g, `${S} HAVING n.k > 'x'`)).toEqual([
      { a: 'y', c: 2 },
      { a: 'z', c: 1 },
    ]);
    expect(query(g, `${S} HAVING n.k > 'x'`)).toEqual(viaGeneral(`${S} HAVING n.k > 'x'`));
  });

  test('on the count AND the key together', () => {
    const q = `${S} HAVING count(*) > 1 AND n.k > 'x'`;

    expect(query(g, q)).toEqual([{ a: 'y', c: 2 }]);
    expect(query(g, q)).toEqual(viaGeneral(q));
  });

  test('a HAVING nothing satisfies yields no rows', () => {
    expect(query(g, `${S} HAVING count(*) > 99`)).toEqual([]);
  });

  test('a HAVING everything satisfies yields every group', () => {
    expect(query(g, `${S} HAVING count(*) > 0`)).toEqual(query(g, S));
  });

  test('NULL drops the group, like false — ISO three-valued', () => {
    // `n.missing > 1` is UNKNOWN for every group, and UNKNOWN is not TRUE, so nothing survives.
    const q = `${S} HAVING n.missing > 1`;

    expect(query(g, q)).toEqual([]);
    expect(query(g, q)).toEqual(viaGeneral(q));
  });

  test('a HAVING reading a NON-KEY property uses the group’s FIRST row', () => {
    // The representative test. Group 'x' is three members: tag 1, then 9, then 9. The general
    // path evaluates HAVING against `group[0]` — tag 1 — so `n.tag > 5` DROPS group x even though
    // two of its three members have tag 9. A tally keeping the wrong representative, or the last
    // one, would keep it.
    const q = `${S} HAVING n.tag > 5`;

    expect(query(g, q)).toEqual(viaGeneral(q));
    expect(query(g, q)).toEqual([
      { a: 'y', c: 2 },
      { a: 'z', c: 1 },
    ]);
  });

  test('HAVING runs BEFORE the sort and the window', () => {
    expect(query(g, `${S} HAVING count(*) > 1 ORDER BY c DESC`)).toEqual([
      { a: 'x', c: 3 },
      { a: 'y', c: 2 },
    ]);
    expect(query(g, `${S} HAVING count(*) > 1 ORDER BY c LIMIT 1`)).toEqual([{ a: 'y', c: 2 }]);
    // Paging a filtered list, not filtering a page: without the HAVING, LIMIT 1 would give z.
    expect(query(g, `${S} ORDER BY c LIMIT 1`)).toEqual([{ a: 'z', c: 1 }]);
  });

  test('the count-first column order survives a HAVING', () => {
    const rows = query(
      g,
      `SELECT count(*) AS c, n.k AS a FROM MATCH (n:P) GROUP BY n.k HAVING count(*) > 2`,
    );

    expect(Object.keys(rows[0])).toEqual(['c', 'a']);
    expect(rows).toEqual([{ c: 3, a: 'x' }]);
  });

  describe('aggregates the tally cannot evaluate decline', () => {
    test('sum() in the HAVING', () => {
      const q = `${S} HAVING sum(n.tag) > 10`;

      expect(query(g, q)).toEqual(viaGeneral(q));
      // x sums 19, y sums 16, z sums 7 — so z drops, which needs the group's MEMBERS.
      expect(query(g, q)).toEqual([
        { a: 'x', c: 3 },
        { a: 'y', c: 2 },
      ]);
    });

    test('count(DISTINCT …) in the HAVING', () => {
      const q = `${S} HAVING count(DISTINCT n.tag) > 1`;

      expect(query(g, q)).toEqual(viaGeneral(q));
      // x has tags {1,9} and y has {7,9}; z has one. A star-count-only rule must refuse this.
      expect(query(g, q)).toEqual([
        { a: 'x', c: 3 },
        { a: 'y', c: 2 },
      ]);
    });

    test('an aggregate nested inside an expression also declines', () => {
      const q = `${S} HAVING count(*) + sum(n.tag) > 20`;

      expect(query(g, q)).toEqual(viaGeneral(q));
    });
  });

  test('a HAVING over a HOP-grouped count', () => {
    const h = new Graph();
    const s = h.addVertex({ id: 's', labels: ['P'], properties: {} });
    const mk = (id: string, k: string) => {
      const f = h.addVertex({ id, labels: ['Q'], properties: { k } });
      h.addEdge({ from: s, to: f, labels: ['T'], properties: {} });
    };

    mk('f1', 'a');
    mk('f2', 'b');
    mk('f3', 'b');

    expect(
      query(
        h,
        'SELECT f.k AS a, count(*) AS c FROM MATCH (x:P)-[:T]->(f) GROUP BY f.k HAVING count(*) > 1',
      ),
    ).toEqual([{ a: 'b', c: 2 }]);
  });
});
