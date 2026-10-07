import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `MATCH (n:L) WHERE <row-local pred> RETURN <row-local items>` — a label scan, a filter and a
// projection. The simplest query there is, and the one shape in the shortcut file that had no
// fast path: the count form had one, a hop had one, a DISTINCT had one, and a plain point lookup
// fell through to the general pipeline, which allocates a binding per SCANNED row.
//
//     a hand-written label-bucket loop            6.8ns a vertex
//     count(*) over the same scan (its shortcut)  30.6ns
//     the projection form, before                 83.3ns
//     the projection form, after                  34.8ns
//
// Two things here are only correct because a test said so, and both are in the fixture
// deliberately (audit item 204):
//
//   - a SEEDED candidate set is a SUPERSET. An index hint is a necessary condition, not a
//     sufficient one, so it can return a same-named vertex of the WRONG LABEL. The bucket walk
//     excludes those by construction; the seek does not. Written without the re-check this
//     returned wrong ROWS, and two existing tests caught it.
//   - the binding map is REUSED across the whole scan, so a stale entry would leak one row's
//     node into the next row's projection.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'p1', labels: ['P'], properties: { k: 'a', n: 1, tag: 'x' } });
  g.addVertex({ id: 'p2', labels: ['P'], properties: { k: 'b', n: 2, tag: 'y' } });
  g.addVertex({ id: 'p3', labels: ['P'], properties: { k: 'a', n: 3, tag: 'z' } });
  // Same `k` as p1/p3 but a DIFFERENT LABEL — the wrong-label candidate an index seek can hand
  // back, and the reason the fast path re-checks the label when it seeds.
  g.addVertex({ id: 'q1', labels: ['Q'], properties: { k: 'a', n: 99, tag: 'w' } });
  // No `k` at all: a three-valued predicate must not match it.
  g.addVertex({ id: 'p4', labels: ['P'], properties: { n: 4, tag: 'v' } });

  return g;
};

const g = build();

/** The same question with a third clause, which declines the two-clause fast path. */
const viaGeneral = (q: string, params?: Record<string, unknown>) =>
  query(g, q.replace(' RETURN ', ' LET _z = 1 RETURN '), params);

const agree = (q: string, params?: Record<string, unknown>) => {
  const fast = query(g, q, params);

  expect(fast).toEqual(viaGeneral(q, params));

  return fast;
};

describe('the node-scan projection answers as the general path does', () => {
  test('one property, filtered by a clause WHERE', () => {
    expect(agree("MATCH (n:P) WHERE n.k = 'a' RETURN n.n AS v")).toEqual([{ v: 1 }, { v: 3 }]);
  });

  test('the inline spelling of the same filter', () => {
    expect(agree("MATCH (n:P {k: 'a'}) RETURN n.n AS v")).toEqual([{ v: 1 }, { v: 3 }]);
  });

  test('a param, which is what an index would seed from', () => {
    expect(agree('MATCH (n:P) WHERE n.k = $k RETURN n.n AS v', { k: 'a' })).toEqual([
      { v: 1 },
      { v: 3 },
    ]);
  });

  test('SEVERAL projected items, in column order', () => {
    const rows = agree("MATCH (n:P) WHERE n.k = 'a' RETURN n.n AS v, n.tag AS t, n.k AS kk");

    expect(rows).toEqual([
      { v: 1, t: 'x', kk: 'a' },
      { v: 3, t: 'z', kk: 'a' },
    ]);
    expect(Object.keys(rows[0])).toEqual(['v', 't', 'kk']);
  });

  test('a computed item, not just a bare property', () => {
    expect(agree("MATCH (n:P) WHERE n.k = 'a' RETURN n.n + 10 AS v")).toEqual([
      { v: 11 },
      { v: 13 },
    ]);
  });

  test('a function call over the node', () => {
    expect(agree("MATCH (n:P) WHERE n.k = 'a' RETURN upper(n.tag) AS t")).toEqual([
      { t: 'X' },
      { t: 'Z' },
    ]);
  });

  test('a literal item that reads no variable at all', () => {
    expect(agree("MATCH (n:P) WHERE n.k = 'a' RETURN 1 AS one")).toEqual([{ one: 1 }, { one: 1 }]);
  });

  test('no WHERE at all — every vertex of the label', () => {
    expect(agree('MATCH (n:P) RETURN n.n AS v')).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }]);
  });

  test('no LABEL either — every vertex in the graph', () => {
    expect(agree('MATCH (n) RETURN n.n AS v').length).toBe(5);
  });

  test('the node itself as the item', () => {
    const rows = agree("MATCH (n:P) WHERE n.k = 'b' RETURN n AS node");

    expect(rows.length).toBe(1);
    expect((rows[0].node as { id: string }).id).toBe('p2');
  });

  test('nothing matches', () => {
    expect(agree("MATCH (n:P) WHERE n.k = 'nope' RETURN n.n AS v")).toEqual([]);
  });

  test('an absent key does not match — ISO three-valued', () => {
    // p4 has no `k`, so `n.k = 'a'` is UNKNOWN for it and it must not appear.
    expect(agree("MATCH (n:P) WHERE n.k = 'a' RETURN n.n AS v")).not.toContainEqual({ v: 4 });
  });
});

describe('the label is re-checked when the scan is SEEDED', () => {
  const seeded = (): Graph => {
    const h = build();

    h.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

    return h;
  };

  test('a same-named WRONG-LABEL vertex is excluded', () => {
    // q1 carries k='a' and label Q. An index on `k` seeds it; only the label check drops it.
    const h = seeded();
    const rows = query(h, "MATCH (n:P) WHERE n.k = 'a' RETURN n.n AS v");

    expect(rows).toEqual([{ v: 1 }, { v: 3 }]);
    expect(rows).not.toContainEqual({ v: 99 });
  });

  test('the indexed and unindexed graphs agree, for both spellings', () => {
    for (const q of [
      "MATCH (n:P) WHERE n.k = 'a' RETURN n.n AS v",
      "MATCH (n:P {k: 'a'}) RETURN n.n AS v",
    ]) {
      expect(query(seeded(), q)).toEqual(query(build(), q));
    }
  });

  test('an unlabelled pattern over an index keeps the wrong-label vertex', () => {
    // The mirror of the test above: with no label to constrain it, q1 SHOULD appear. A label
    // check that rejected everything would pass the test above and fail this one.
    const rows = query(seeded(), "MATCH (n) WHERE n.k = 'a' RETURN n.n AS v");

    expect(rows.map((r) => r.v).sort((a, b) => Number(a) - Number(b))).toEqual([1, 3, 99]);
  });
});

describe('the reused binding does not leak between rows', () => {
  test('two surviving rows each project their OWN node', () => {
    // Both rows match, and they differ in the projected property. A binding written once and
    // never updated would give both rows the first node's value.
    expect(agree("MATCH (n:P) WHERE n.k = 'a' RETURN n.tag AS t")).toEqual([
      { t: 'x' },
      { t: 'z' },
    ]);
  });

  test('a projection reading the node TWICE agrees within one row', () => {
    expect(agree("MATCH (n:P) WHERE n.k = 'a' RETURN n.n AS v, n.n + 0 AS w")).toEqual([
      { v: 1, w: 1 },
      { v: 3, w: 3 },
    ]);
  });
});

describe('the shapes it must decline', () => {
  const declines = (q: string, params?: Record<string, unknown>) => {
    expect(query(g, q, params)).toEqual(viaGeneral(q, params));
  };

  test('RETURN * — it needs the binding’s whole shape', () => {
    // Asserted directly rather than against `viaGeneral`: a dead `LET` is what forces the
    // general path here, and `RETURN *` would then PROJECT that `_z`, so the comparison would
    // be against a different question.
    const rows = query(g, 'MATCH (n:P) RETURN *');

    expect(rows.length).toBe(4);
    expect(Object.keys(rows[0])).toEqual(['n']);
  });

  test('an aggregate in an item needs the group this path never builds', () => {
    expect(query(g, 'MATCH (n:P) RETURN count(*) AS c')).toEqual([{ c: 4 }]);
    expect(query(g, 'MATCH (n:P) RETURN max(n.n) AS m')).toEqual([{ m: 4 }]);
  });

  test('a subquery in an item needs the general matcher', () => {
    // The ALLOWLIST is what stops this, and it has to be: `freePredicateVars` returns the EMPTY
    // set for a subquery — it does not descend into one — so a free-variable check sees nothing
    // inside an `EXISTS { … }` at all. (An earlier version of this comment had that backwards;
    // item 213 established the truth while tracking an `ORDER BY` bug caused by exactly it.)
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a' } });
    const b = h.addVertex({ id: 'b', labels: ['P'], properties: { k: 'b' } });

    h.addEdge({ from: a, to: b, labels: ['T'], properties: {} });

    expect(query(h, 'MATCH (n:P) RETURN n.k AS k, EXISTS { MATCH (n)-[:T]->() } AS has')).toEqual([
      { k: 'a', has: true },
      { k: 'b', has: false },
    ]);
  });

  test('a WHERE reading another variable', () => {
    declines("MATCH (n:P), (m:P) WHERE m.k = 'b' RETURN n.n AS v");
  });

  test('a hop is not a node scan', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = h.addVertex({ id: 'b', labels: ['Q'], properties: { k: 'z' } });

    h.addEdge({ from: a, to: b, labels: ['T'], properties: {} });

    expect(query(h, 'MATCH (x:P)-[:T]->(f) RETURN f.k AS k')).toEqual([{ k: 'z' }]);
  });

  test('ORDER BY, SKIP and LIMIT each still work', () => {
    expect(query(g, 'MATCH (n:P) RETURN n.n AS v ORDER BY v DESC')).toEqual([
      { v: 4 },
      { v: 3 },
      { v: 2 },
      { v: 1 },
    ]);
    expect(query(g, 'MATCH (n:P) RETURN n.n AS v ORDER BY v LIMIT 2')).toEqual([
      { v: 1 },
      { v: 2 },
    ]);
    expect(query(g, 'MATCH (n:P) RETURN n.n AS v ORDER BY v OFFSET 3')).toEqual([{ v: 4 }]);
  });

  test('DISTINCT keeps its own walk', () => {
    expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS k')).toEqual(
      query(g, 'MATCH (n:P) LET _z = 1 RETURN DISTINCT n.k AS k'),
    );
  });

  test('DISTINCT over TWO items still dedupes', () => {
    // The one that matters, and the one a single-item fixture cannot see:
    // `detectDistinctProjection` runs BEFORE this path in the ladder but accepts only ONE item,
    // so a two-item DISTINCT declines it and arrives here — where nothing dedupes. The fixture
    // therefore needs two vertices agreeing on BOTH projected values; with only one duplicate
    // column the mutant that drops the `distinct` guard survives.
    const h = new Graph();

    h.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a', t: 'x' } });
    h.addVertex({ id: 'b', labels: ['P'], properties: { k: 'a', t: 'x' } });
    h.addVertex({ id: 'c', labels: ['P'], properties: { k: 'b', t: 'y' } });

    expect(query(h, 'MATCH (n:P) RETURN DISTINCT n.k AS k, n.t AS t')).toEqual([
      { k: 'a', t: 'x' },
      { k: 'b', t: 'y' },
    ]);
  });

  test('GROUP BY keeps the tally', () => {
    expect(query(g, 'MATCH (n:P) RETURN n.k AS k, count(*) AS c')).toEqual([
      { k: 'a', c: 2 },
      { k: 'b', c: 1 },
      { k: null, c: 1 },
    ]);
  });

  test('an OPTIONAL MATCH', () => {
    expect(query(g, "OPTIONAL MATCH (n:P) WHERE n.k = 'nope' RETURN n.n AS v")).toEqual([
      { v: null },
    ]);
  });
});
