import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `RETURN <k> GROUP BY <k>` with no aggregate IS `RETURN DISTINCT <k>` — one row per distinct
// value of `k`, projecting `k`, in first-seen group order, which is the order DISTINCT keeps. It
// was 5.8x off the other spellings of that question, because `GROUP BY` takes a BOUND NAME and a
// `LET` is the only way to give the key one, so this is the spelling ISO pushes you toward
// (audit item 188).
//
// Three conditions decide correctness, and each has its own test because each is a WRONG ANSWER
// if dropped rather than merely a slow one:
//
//   - exactly ONE grouping element — `GROUP BY a, n.city` repeats `a` across rows;
//   - the projected item IS that element — `RETURN n.city GROUP BY a` projects a representative;
//   - no `HAVING` — it drops whole groups, and the walk has no groups to drop.
//
// The fixture makes the second key VARY WITHIN the first. With a constant second key the
// rewritten and un-rewritten answers coincide and the test proves nothing.
const build = (): Graph => {
  const g = new Graph();

  // a = 1 under two cities, a = 2 under one. So GROUP BY a, city is three rows with `a`
  // repeating, and DISTINCT a is two.
  g.addVertex({ id: 'p0', labels: ['P'], properties: { a: 1, city: 'X' } });
  g.addVertex({ id: 'p1', labels: ['P'], properties: { a: 1, city: 'Y' } });
  g.addVertex({ id: 'p2', labels: ['P'], properties: { a: 2, city: 'X' } });

  return g;
};

const g = build();

/** Forced to the general path by a second `LET`, which takes the clause count out of range. */
const viaGeneral = (q: string): unknown => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

describe('GROUP BY with no aggregate is DISTINCT', () => {
  test('one grouping element via a LET matches DISTINCT and the general path', () => {
    const grouped = query(g, 'MATCH (n:P) LET a = n.a RETURN a GROUP BY a');

    expect(grouped).toEqual([{ a: 1 }, { a: 2 }]);
    expect(grouped).toEqual(query(g, 'MATCH (n:P) LET a = n.a RETURN DISTINCT a'));
    expect(grouped).toEqual(viaGeneral('MATCH (n:P) LET a = n.a RETURN a GROUP BY a'));
  });

  test('the two-clause property spelling matches too', () => {
    const grouped = query(g, 'MATCH (n:P) RETURN n.a AS a GROUP BY n.a');

    expect(grouped).toEqual([{ a: 1 }, { a: 2 }]);
    expect(grouped).toEqual(query(g, 'MATCH (n:P) RETURN DISTINCT n.a AS a'));
  });

  test('TWO grouping elements must NOT be rewritten — the key repeats', () => {
    // Three rows, and `a` appears twice. A rewrite to DISTINCT a would return two.
    expect(query(g, 'MATCH (n:P) LET a = n.a RETURN a GROUP BY a, n.city')).toEqual([
      { a: 1 },
      { a: 1 },
      { a: 2 },
    ]);
  });

  test('a projection that is NOT the grouping element keeps its representative row', () => {
    // One row per distinct `a`, carrying THAT group's first city — not a dedup of city.
    expect(query(g, 'MATCH (n:P) LET a = n.a RETURN n.city AS c GROUP BY a')).toEqual([
      { c: 'X' },
      { c: 'X' },
    ]);
  });

  test('the same, in the TWO-CLAUSE spelling, which has no LET to decline on', () => {
    // The test above is held up by the LET guard (the projection is not the bound name) rather
    // than by the grouping-element check, so it passed while that check was mutated away. With
    // no LET there is nothing else to decline on: `GROUP BY n.a` projecting `n.city` keeps one
    // representative city per distinct `a` (X, X), where a dedup of city would be (X, Y).
    expect(query(g, 'MATCH (n:P) RETURN n.city AS c GROUP BY n.a')).toEqual([
      { c: 'X' },
      { c: 'X' },
    ]);
    expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.city AS c')).toEqual([{ c: 'X' }, { c: 'Y' }]);
  });

  test('a property key on the OTHER end of a hop is a different question', () => {
    // `GROUP BY m.k` with `n.k` projected: both edges land in one group (m.k is Z for both), so
    // the answer is that group's representative `n.k` — ONE row. Comparing grouping elements on
    // the key alone would match `m.k` to `n.k` and dedupe by `n.k` instead, giving two.
    const h = new Graph();
    const n1 = h.addVertex({ id: 'n1', labels: ['P'], properties: { k: 'A' } });
    const n2 = h.addVertex({ id: 'n2', labels: ['P'], properties: { k: 'B' } });
    const m1 = h.addVertex({ id: 'm1', labels: ['Q'], properties: { k: 'Z' } });
    const m2 = h.addVertex({ id: 'm2', labels: ['Q'], properties: { k: 'Z' } });
    h.addEdge({ from: n1, to: m1, labels: ['T'], properties: {} });
    h.addEdge({ from: n2, to: m2, labels: ['T'], properties: {} });

    expect(query(h, 'MATCH (n:P)-[:T]->(m) RETURN n.k AS a GROUP BY m.k')).toEqual([{ a: 'A' }]);
    expect(query(h, 'MATCH (n:P)-[:T]->(m) RETURN DISTINCT n.k AS a')).toEqual([
      { a: 'A' },
      { a: 'B' },
    ]);
  });

  test('HAVING still drops whole groups', () => {
    // HAVING is SELECT-statement only. Two rows have a = 1, one has a = 2.
    expect(query(g, 'SELECT n.a AS a FROM MATCH (n:P) GROUP BY n.a HAVING count(*) > 1')).toEqual([
      { a: 1 },
    ]);
  });

  test('an aggregate alongside the key still answers the grouped count', () => {
    expect(query(g, 'MATCH (n:P) LET a = n.a RETURN a, count(*) AS c GROUP BY a')).toEqual([
      { a: 1, c: 2 },
      { a: 2, c: 1 },
    ]);
  });

  test('groups come out in FIRST-SEEN order, not sorted', () => {
    const graph = new Graph();
    graph.addVertex({ id: 'z', labels: ['P'], properties: { a: 9 } });
    graph.addVertex({ id: 'y', labels: ['P'], properties: { a: 1 } });
    graph.addVertex({ id: 'x', labels: ['P'], properties: { a: 9 } });

    expect(query(graph, 'MATCH (n:P) LET a = n.a RETURN a GROUP BY a')).toEqual([
      { a: 9 },
      { a: 1 },
    ]);
  });

  test('ORDER BY declines and still sorts', () => {
    expect(query(g, 'MATCH (n:P) LET a = n.a RETURN a GROUP BY a ORDER BY a DESC')).toEqual([
      { a: 2 },
      { a: 1 },
    ]);
  });

  test('LIMIT declines and still pages', () => {
    expect(query(g, 'MATCH (n:P) LET a = n.a RETURN a GROUP BY a LIMIT 1')).toEqual([{ a: 1 }]);
  });

  test('a clause WHERE over the keyed end is carried', () => {
    const grouped = query(g, 'MATCH (n:P) WHERE n.a > 1 LET a = n.a RETURN a GROUP BY a');

    expect(grouped).toEqual([{ a: 2 }]);
    expect(grouped).toEqual(
      viaGeneral('MATCH (n:P) WHERE n.a > 1 LET a = n.a RETURN a GROUP BY a'),
    );
  });

  test('a hop keyed on the FAR end matches the general path', () => {
    const graph = new Graph();
    const s = graph.addVertex({ id: 's', labels: ['P'], properties: {} });
    const f1 = graph.addVertex({ id: 'f1', labels: ['Q'], properties: { a: 7 } });
    const f2 = graph.addVertex({ id: 'f2', labels: ['Q'], properties: { a: 7 } });
    const f3 = graph.addVertex({ id: 'f3', labels: ['Q'], properties: { a: 8 } });
    graph.addEdge({ from: s, to: f1, labels: ['T'], properties: {} });
    graph.addEdge({ from: s, to: f2, labels: ['T'], properties: {} });
    graph.addEdge({ from: s, to: f3, labels: ['T'], properties: {} });

    const grouped = query(graph, 'MATCH (x:P)-[:T]->(f) LET a = f.a RETURN a GROUP BY a');

    expect(grouped).toEqual([{ a: 7 }, { a: 8 }]);
    expect(grouped).toEqual(
      query(graph, 'MATCH (x:P)-[:T]->(f) LET _z = 1 LET a = f.a RETURN a GROUP BY a'),
    );
  });

  test('a non-property LET expression as the key', () => {
    const grouped = query(g, 'MATCH (n:P) LET a = n.a + 1 RETURN a GROUP BY a');

    expect(grouped).toEqual([{ a: 2 }, { a: 3 }]);
    expect(grouped).toEqual(viaGeneral('MATCH (n:P) LET a = n.a + 1 RETURN a GROUP BY a'));
  });

  test('a constant key reads no end, declines, and yields one row', () => {
    expect(query(g, 'MATCH (n:P) LET a = 1 RETURN a GROUP BY a')).toEqual([{ a: 1 }]);
  });

  test('a stored null and an absent key group together', () => {
    const graph = new Graph();
    graph.addVertex({ id: 'x', labels: ['P'], properties: { a: null } });
    graph.addVertex({ id: 'y', labels: ['P'], properties: {} });
    graph.addVertex({ id: 'z', labels: ['P'], properties: { a: 3 } });

    expect(query(graph, 'MATCH (n:P) LET a = n.a RETURN a GROUP BY a')).toEqual([
      { a: null },
      { a: 3 },
    ]);
  });

  test('the column is the LET name, not the expression', () => {
    const rows = query(g, 'MATCH (n:P) LET a = n.a RETURN a GROUP BY a');

    expect(Object.keys(rows[0])).toEqual(['a']);
  });

  test('an element-valued key groups by identity', () => {
    const rows = query(g, 'MATCH (n:P) LET a = n RETURN a GROUP BY a') as Array<{
      a: { id: string };
    }>;

    expect(rows.map((r) => r.a.id)).toEqual(['p0', 'p1', 'p2']);
  });

  test('an empty label bucket yields no rows', () => {
    expect(query(new Graph(), 'MATCH (n:P) LET a = n.a RETURN a GROUP BY a')).toEqual([]);
  });
});
