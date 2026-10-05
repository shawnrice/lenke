import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `detectDistinctProjection` (audit item 143): `RETURN DISTINCT <one expr>` dedupes by the
// projected VALUE while walking, so a duplicate costs neither a row object nor a row key.
//
// DISTINCT keeps the FIRST occurrence in stream order, so every comparison is order-sensitive.
// The fixture inserts edges OUT of walk order on purpose — item 142 gave back a 7.4x for
// getting exactly that wrong on a grouped count.
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

/** The same question through the general path, which applies DISTINCT after projection. */
const viaGeneral = (g: Graph, q: string) => {
  const i = q.indexOf(' RETURN ');

  return query(g, `${q.slice(0, i)} LET _z = 1${q.slice(i)}`);
};

const bothWays = (g: Graph, q: string) => [query(g, q), viaGeneral(g, q)] as const;

describe('distinct projection', () => {
  test('a far property over a hop: values and ORDER match the general path', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) RETURN DISTINCT w.k AS a';
    const [fast, slow] = bothWays(g, q);

    // Walk order is a (→y, →y, →z), then b (→z), then y (→y): KY first even though the
    // adjacency indexes hold z first.
    expect(fast).toEqual([{ a: 'KY' }, { a: 'KZ' }]);
    expect(fast).toEqual(slow);
  });

  test('a START property over a hop', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) RETURN DISTINCT x.k AS a';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([{ a: 'ka' }, { a: 'kb' }, { a: 'KY' }]);
    expect(fast).toEqual(slow);
  });

  test('a bare node scan', () => {
    const g = build();
    const q = 'MATCH (n:P) RETURN DISTINCT n.n AS a';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([{ a: 1 }, { a: 2 }, { a: 10 }, { a: 20 }, { a: 30 }, { a: 40 }]);
    expect(fast).toEqual(slow);
  });

  test('DISTINCT over the ELEMENT, not a property', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) RETURN DISTINCT w AS a';
    const [fast, slow] = bothWays(g, q);

    expect((fast as unknown[]).length).toBe(2);
    expect(fast).toEqual(slow);
  });

  test('an ABSENT property dedupes to one null, distinct from a present value', () => {
    const g = build();
    const q = 'MATCH (n:P) RETURN DISTINCT n.k AS a';
    const [fast, slow] = bothWays(g, q);

    // `nok` has no `k`, so it contributes exactly one null row.
    expect(fast).toContainEqual({ a: null });
    expect((fast as unknown[]).filter((r) => (r as { a: unknown }).a === null).length).toBe(1);
    expect(fast).toEqual(slow);
  });

  test('a computed expression dedupes on its VALUE', () => {
    const g = build();
    // `n % 10` collapses 10, 20, 30, 40 to 0 and keeps 1 and 2 — so the dedup must be on the
    // computed value, not on the element.
    const q = 'MATCH (n:P) RETURN DISTINCT n.n % 10 AS a';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([{ a: 1 }, { a: 2 }, { a: 0 }]);
    expect(fast).toEqual(slow);
  });

  test('the FAR label is applied', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w:Q) RETURN DISTINCT w.k AS a';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([{ a: 'KY' }]);
    expect(fast).toEqual(slow);
  });

  test('a clause WHERE on the keyed end is applied', () => {
    const g = build();
    const q = 'MATCH (x:P)-[:T]->(w) WHERE w.n > 15 RETURN DISTINCT w.k AS a';
    const [fast, slow] = bothWays(g, q);

    expect(fast).toEqual([{ a: 'KZ' }]);
    expect(fast).toEqual(slow);
  });

  test('a reversed hop and an untyped hop agree on the VALUES', () => {
    const g = build();
    // Compared as a MULTISET, not in order. Item 198 let the far-driven walk take an un-ordered
    // dedup, which meets the far vertices in a different order than the start-driven walk does —
    // and row order without an `ORDER BY` is unspecified in this engine, the same as SQL without
    // one. The reversed hop here is the spelling whose order actually moved.
    //
    // Where order IS specified it is still asserted in order: see the sorted cases below and in
    // `order-by-on-dedup.test.ts`.
    const sorted = (rows: unknown): unknown[] =>
      (rows as Array<{ a: unknown }>).map((r) => JSON.stringify(r.a)).sort();

    for (const q of [
      'MATCH (x:P)<-[:T]-(w) RETURN DISTINCT w.k AS a',
      'MATCH (x:P)-[]->(w) RETURN DISTINCT w.k AS a',
    ]) {
      expect(sorted(query(g, q))).toEqual(sorted(viaGeneral(g, q)));
    }
  });

  test('a sorted dedup over a hop still matches the general path IN ORDER', () => {
    const g = build();
    // The other half of item 198's decision: unspecified only means unspecified WITHOUT a sort.

    for (const q of [
      'MATCH (x:P)<-[:T]-(w) RETURN DISTINCT w.k AS a ORDER BY a',
      'MATCH (x:P)-[:T]->(w) RETURN DISTINCT w.k AS a ORDER BY a DESC',
    ]) {
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    }
  });

  test('-0 and 0 dedupe together, as the general path has them', () => {
    const g = new Graph();

    g.addVertex({ id: 'p', labels: ['P'], properties: { n: 0 } });
    g.addVertex({ id: 'q', labels: ['P'], properties: { n: -0 } });

    const q = 'MATCH (n:P) RETURN DISTINCT n.n AS a';

    // `valueKey` puts `-0` and `0` in one bucket, which is the general path's own rule.
    expect((query(g, q) as unknown[]).length).toBe(1);
    expect(query(g, q)).toEqual(viaGeneral(g, q));
  });

  test('each declining shape still answers correctly', () => {
    const g = build();

    for (const q of [
      // TWO items: the row itself is the key, so nothing is saved and it declines.
      'MATCH (x:P)-[:T]->(w) RETURN DISTINCT w.k AS a, w.n AS b',
      // reads BOTH ends
      'MATCH (x:P)-[:T]->(w) RETURN DISTINCT x.n + w.n AS a',
      // a filter on the OTHER end
      'MATCH (x:P)-[:T]->(w) WHERE x.n < 2 RETURN DISTINCT w.k AS a',
      // paging and ordering need the whole set
      'MATCH (n:P) RETURN DISTINCT n.k AS a ORDER BY a',
      'MATCH (n:P) RETURN DISTINCT n.k AS a LIMIT 2',
      'MATCH (n:P) RETURN DISTINCT n.k AS a SKIP 1',
      // an aggregate
      'MATCH (n:P) RETURN DISTINCT count(*) AS a',
      // structural declines
      'MATCH (x:P)-[r:T]->(w) RETURN DISTINCT w.k AS a',
      'MATCH p = (x:P)-[:T]->(w) RETURN DISTINCT w.k AS a',
      'MATCH (x:P)-[:T]->(m)-[:T]->(w) RETURN DISTINCT w.k AS a',
      'MATCH (x:P&Q)-[:T]->(w) RETURN DISTINCT w.k AS a',
      // not DISTINCT at all
      'MATCH (n:P) RETURN n.k AS a',
    ]) {
      expect(query(g, q)).toEqual(viaGeneral(g, q));
    }
  });

  test('a start vertex with no edges contributes nothing over a hop', () => {
    const g = build();
    const rows = query(g, 'MATCH (x:P)-[:T]->(w) RETURN DISTINCT x.k AS a');

    expect(rows).not.toContainEqual({ a: 'KW' });
  });
});
