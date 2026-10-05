import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `detectDistinctProjection` refused every three-clause query, so `LET a = n.k RETURN DISTINCT a`
// went through the general path at 108.17ms where `RETURN DISTINCT n.k` took the walk at
// 11.91ms — one question, two spellings, 9.1x apart (audit item 187). `GROUP BY` takes a BOUND
// NAME, so a `LET` is the only way ISO lets you name a grouping key, and a reader who has
// written one writes the DISTINCT spelling the same way.
//
// Every case compares the LET spelling against a spelling that goes elsewhere, because the
// shortcut changes no rows — so the answer, the ORDER and the COLUMN NAME are the whole
// contract, and order is where this family has gone wrong before (item 142 gave back a 7.4x for
// meeting elements in the wrong order).
//
// The fixture inserts edges OUT of walk order on purpose, mirroring `distinct-projection.test.ts`.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], props: Record<string, unknown>) =>
    g.addVertex({ id, labels, properties: props });

  const a = v('a', ['P'], { k: 'ka', n: 1 });
  const b = v('b', ['P'], { k: 'kb', n: 2 });
  const y = v('y', ['P', 'Q'], { k: 'KY', n: 10 });
  const z = v('z', ['P'], { k: 'KZ', n: 20 });

  v('w', ['P'], { k: 'KW', n: 30 }); // no edges
  v('nok', ['P'], { n: 40 }); // no `k` at all
  // b's edge inserted FIRST, so the indexes see z before y while the walk sees y first.
  g.addEdge({ from: b, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: y, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: y, labels: ['T'], properties: {} }); // duplicate value
  g.addEdge({ from: a, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: y, to: y, labels: ['T'], properties: {} }); // self-loop
  g.addEdge({ from: b, to: y, labels: ['S'], properties: {} }); // other type

  return g;
};

const g = build();

/**
 * The same question with a DEAD `LET` added, which the shortcut declines (the projection is
 * not the bound name) — so this is the general path, and it is also the device
 * `distinct-projection.test.ts` uses.
 */
const viaGeneral = (q: string): unknown => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

describe('DISTINCT over a LET-bound name', () => {
  test('a bare node scan matches the general path, in order', () => {
    const viaLet = query(g, 'MATCH (n:P) LET a = n.k RETURN DISTINCT a');

    expect(viaLet).toEqual(viaGeneral('MATCH (n:P) RETURN DISTINCT n.k AS a'));
    expect(viaLet).toEqual([
      { a: 'ka' },
      { a: 'kb' },
      { a: 'KY' },
      { a: 'KZ' },
      { a: 'KW' },
      { a: null },
    ]);
  });

  test('the column is the LET name, not the expression', () => {
    // A `LET` names a BINDING, not an output column, so the column stays `a` — and a shortcut
    // that took its name from the expression it evaluates would say `k` here.
    const rows = query(g, 'MATCH (n:P) LET a = n.k RETURN DISTINCT a');

    expect(Object.keys(rows[0])).toEqual(['a']);
  });

  test('a hop keyed on the FAR end matches the general path, in order', () => {
    const viaLet = query(g, 'MATCH (s:P)-[:T]->(f) LET a = f.k RETURN DISTINCT a');

    expect(viaLet).toEqual(viaGeneral('MATCH (s:P)-[:T]->(f) RETURN DISTINCT f.k AS a'));
    // y before z: the walk meets a's edges in insertion order, which is NOT the index order.
    expect(viaLet).toEqual([{ a: 'KY' }, { a: 'KZ' }]);
  });

  test('a hop keyed on the START end matches the general path, in order', () => {
    const viaLet = query(g, 'MATCH (s:P)-[:T]->(f) LET a = s.k RETURN DISTINCT a');

    expect(viaLet).toEqual(viaGeneral('MATCH (s:P)-[:T]->(f) RETURN DISTINCT s.k AS a'));
    expect(viaLet).toEqual([{ a: 'ka' }, { a: 'kb' }, { a: 'KY' }]);
  });

  test('a clause WHERE over the keyed end is carried', () => {
    const viaLet = query(g, 'MATCH (n:P) WHERE n.n > 5 LET a = n.k RETURN DISTINCT a');

    expect(viaLet).toEqual(viaGeneral('MATCH (n:P) WHERE n.n > 5 RETURN DISTINCT n.k AS a'));
    expect(viaLet).toEqual([{ a: 'KY' }, { a: 'KZ' }, { a: 'KW' }, { a: null }]);
  });

  test('a far-end label filter is carried', () => {
    const viaLet = query(g, 'MATCH (s:P)-[:T]->(f:Q) LET a = f.k RETURN DISTINCT a');

    expect(viaLet).toEqual(viaGeneral('MATCH (s:P)-[:T]->(f:Q) RETURN DISTINCT f.k AS a'));
    expect(viaLet).toEqual([{ a: 'KY' }]);
  });

  test('a LET the projection ignores still answers through the general path', () => {
    // The decline that keeps `viaGeneral` honest. If this ever took the shortcut, every
    // comparison in this file and in distinct-projection.test.ts would be against itself.
    expect(query(g, 'MATCH (n:P) LET _z = 1 RETURN DISTINCT n.k AS a')).toEqual(
      query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS a'),
    );
  });

  test('a projection mixing the bound name with another read is correct', () => {
    // Not one expression over one end, so it declines — the answer is what matters.
    expect(query(g, 'MATCH (n:P) LET a = n.n RETURN DISTINCT a + n.n AS d')).toEqual([
      { d: 2 },
      { d: 4 },
      { d: 20 },
      { d: 40 },
      { d: 60 },
      { d: 80 },
    ]);
  });

  test('two LET items decline and stay correct', () => {
    expect(query(g, 'MATCH (n:P) LET a = n.k, b = 1 RETURN DISTINCT a')).toEqual(
      query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS a'),
    );
  });

  test('a LET that binds the SAME name twice takes the LAST definition', () => {
    // `LET a = n.k, a = 1` is accepted and the second definition wins, so a shortcut that
    // resolved a projected name against `items[0]` would answer with `n.k`'s values. This is
    // why the one-item bound is load-bearing and not merely conservative — relaxing it
    // returns ka/kb here, and the whole 1098-test suite passes while it does.
    expect(query(g, 'MATCH (n:P) LET a = n.k, a = 1 RETURN DISTINCT a')).toEqual([{ a: 1 }]);
  });

  test('a later LET item may read an earlier one', () => {
    expect(query(g, 'MATCH (n:P) LET a = n.k, b = a RETURN DISTINCT b')).toEqual(
      query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS b'),
    );
  });

  test('a constant LET reads no end, declines, and dedupes to one row', () => {
    expect(query(g, 'MATCH (n:P) LET a = 1 RETURN DISTINCT a')).toEqual([{ a: 1 }]);
  });

  test('ORDER BY sorts, and item 189 lets the walk do it', () => {
    expect(query(g, 'MATCH (n:P) LET a = n.n RETURN DISTINCT a ORDER BY a')).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 10 },
      { a: 20 },
      { a: 30 },
      { a: 40 },
    ]);
  });

  test('LIMIT declines and still pages', () => {
    expect(query(g, 'MATCH (n:P) LET a = n.k RETURN DISTINCT a LIMIT 2')).toEqual([
      { a: 'ka' },
      { a: 'kb' },
    ]);
  });

  test('a LET over a whole element dedupes by element identity', () => {
    const viaLet = query(g, 'MATCH (s:P)-[:T]->(f) LET a = f RETURN DISTINCT a') as Array<{
      a: { id: string };
    }>;

    expect(viaLet.map((r) => r.a.id)).toEqual(['y', 'z']);
  });

  test('a LET expression that is not a plain property still works', () => {
    const viaLet = query(g, 'MATCH (n:P) LET a = n.n + 1 RETURN DISTINCT a');

    expect(viaLet).toEqual(viaGeneral('MATCH (n:P) RETURN DISTINCT n.n + 1 AS a'));
  });

  test('the two-clause spelling is unchanged', () => {
    expect(query(g, 'MATCH (n:P) RETURN DISTINCT n.k AS a')).toEqual([
      { a: 'ka' },
      { a: 'kb' },
      { a: 'KY' },
      { a: 'KZ' },
      { a: 'KW' },
      { a: null },
    ]);
  });

  test('an absent key and a stored null dedupe together', () => {
    const graph = new Graph();
    graph.addVertex({ id: 'x', labels: ['P'], properties: { k: null } });
    graph.addVertex({ id: 'y', labels: ['P'], properties: {} });
    graph.addVertex({ id: 'z', labels: ['P'], properties: { k: 'v' } });

    expect(query(graph, 'MATCH (n:P) LET a = n.k RETURN DISTINCT a')).toEqual([
      { a: null },
      { a: 'v' },
    ]);
  });

  test('an empty label bucket yields no rows', () => {
    expect(query(new Graph(), 'MATCH (n:P) LET a = n.k RETURN DISTINCT a')).toEqual([]);
  });

  // A `LET` may REBIND a name the pattern already bound, and it is reachable — all three
  // shapes below answer rather than raise. That matters here because it is the one case where
  // choosing the walk's end from the PROJECTION instead of the `LET` stops declining and
  // starts answering wrongly: `LET a = f.k` projected as `a` reads only `a`, which is ALSO the
  // start variable, so the walk would key on the start and evaluate `f.k` against a binding
  // that never holds `f` — every row null. A mutant doing exactly that survived the first
  // sweep because no test shadowed a name.
  describe('a LET that rebinds a pattern variable', () => {
    test('rebinding the START name while reading the FAR end', () => {
      const viaLet = query(g, 'MATCH (a:P)-[:T]->(f) LET a = f.k RETURN DISTINCT a');

      // Forced to the general path by a second LET, which takes the clause count out of range.
      expect(viaLet).toEqual(
        query(g, 'MATCH (a:P)-[:T]->(f) LET _z = 1 LET a = f.k RETURN DISTINCT a'),
      );
      expect(viaLet).toEqual([{ a: 'KY' }, { a: 'KZ' }]);
    });

    test('rebinding the START name while reading the START end', () => {
      const viaLet = query(g, 'MATCH (a:P)-[:T]->(f) LET a = a.k RETURN DISTINCT a');

      expect(viaLet).toEqual(
        query(g, 'MATCH (a:P)-[:T]->(f) LET _z = 1 LET a = a.k RETURN DISTINCT a'),
      );
      expect(viaLet).toEqual([{ a: 'ka' }, { a: 'kb' }, { a: 'KY' }]);
    });

    test('rebinding to a constant declines and yields one row', () => {
      expect(query(g, 'MATCH (n:P) LET n = 1 RETURN DISTINCT n')).toEqual([{ n: 1 }]);
    });

    test('rebinding a node-scan name from its own property', () => {
      const viaLet = query(g, 'MATCH (a:P) LET a = a.k RETURN DISTINCT a');

      expect(viaLet).toEqual(query(g, 'MATCH (a:P) LET _z = 1 LET a = a.k RETURN DISTINCT a'));
      expect(viaLet).toEqual([
        { a: 'ka' },
        { a: 'kb' },
        { a: 'KY' },
        { a: 'KZ' },
        { a: 'KW' },
        { a: null },
      ]);
    });
  });
});
