// `mergeBinding` — the per-row binding merge in the matcher's product paths (item 2022).
//
// ⚠️⚠️ **KEY ORDER IS THE CONTRACT, NOT THE VALUES.** `visitRemaining` documents the merge order as
// "outer keys, then `pat`'s, then the tail's — which `RETURN *` projects in", and column order is
// bytes ([[column-order-is-observable]]). The change replaced
//
//     new Map([...outer, ...inner])        with     copy outer, then set inner's entries
//
// which is 1.79x and must be indistinguishable. `Map.set` on an EXISTING key keeps that key's
// original position, so the two agree even where the sides OVERLAP — which they always do here,
// because both sides carry the outer binding.
//
// 🔑 THE OBSERVABLE IS `RETURN *`: it copies binding entries into the row in binding order, so a
// merge that reordered keys shows up as reordered COLUMNS. Every assertion below reads
// `Object.keys`, not just the values.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  for (const [id, n] of [
    ['a1', 1],
    ['a2', 2],
  ] as const) {
    g.addVertex({ id, labels: ['A'], properties: { n } });
  }

  for (const [id, m] of [
    ['b1', 10],
    ['b2', 20],
  ] as const) {
    g.addVertex({ id, labels: ['B'], properties: { m } });
  }

  g.addEdge({
    id: 'e1',
    from: g.getVertexById('a1')!,
    to: g.getVertexById('a2')!,
    labels: ['E'],
    properties: {},
  });
  g.addEdge({
    id: 'f1',
    from: g.getVertexById('b1')!,
    to: g.getVertexById('b2')!,
    labels: ['F'],
    properties: {},
  });

  return g;
};

const rows = (g: Graph, q: string): Record<string, unknown>[] =>
  [...query(g, q)] as Record<string, unknown>[];

/**
 * ⚠️⚠️ **THE KEY ORDER OF *EVERY* ROW, NOT ROW ZERO — AND TWO MUTANTS PROVED WHY.** The product has
 * two paths: the FIRST outer row streams the tail through `recordTail` while filling the cache, and
 * every LATER row reads the filled cache. They are different merge call sites. Checking
 * `Object.keys(got[0])` exercises only the first, so swapping the merge arguments on the CACHED path
 * changed the column order of rows 2..n and survived this whole file and the entire @lenke/gql suite.
 */
const keyOrders = (got: Record<string, unknown>[]): string[][] => got.map((r) => Object.keys(r));

describe('the uncorrelated product keeps its key ORDER', () => {
  const g = build();

  test('`RETURN *` over a comma pattern projects outer keys, then each leg’s', () => {
    /*
     * ⚠️ THIS IS THE SHAPE THE MERGE SERVES — two independent legs, so the tail is uncorrelated and
     * `visitRemaining` forms the product from a cached tail (item 121). `RETURN *` is what makes the
     * merge's key order observable.
     */
    const got = rows(g, 'MATCH (a:A)-[:E]->(c:A), (b:B)-[:F]->(d:B) RETURN *');

    expect(got).toHaveLength(1);
    expect(keyOrders(got)).toEqual([['a', 'c', 'b', 'd']]);
  });

  test('a THREE-pattern product, so the tail itself merges a tail', () => {
    // The recursion merges twice, which is where a reordering would compound.
    const got = rows(g, 'MATCH (a:A), (b:B), (c:A) RETURN *');

    expect(got).toHaveLength(8);
    // ⚠️ ALL EIGHT: row 0 took the first-row path, rows 1-7 the cached one.
    expect(keyOrders(got)).toEqual(Array.from({ length: 8 }, () => ['a', 'b', 'c']));
  });

  test('the product’s ROW multiset is the legs’ product', () => {
    // 2 A-vertices x 2 B-vertices = 4, and the values pair every a with every b.
    const got = rows(g, 'MATCH (a:A), (b:B) RETURN a.n AS x, b.m AS y ORDER BY x, y');

    expect(got.map((r) => [r.x, r.y])).toEqual([
      [1, 10],
      [1, 20],
      [2, 10],
      [2, 20],
    ]);
  });

  test('a CORRELATED second pattern still works — it takes the other branch', () => {
    /*
     * ⚠️ THE MERGE IS ONLY REACHED ON THE UNCORRELATED PATH; a correlated tail recurses per outer
     * row instead (`tailIsUncorrelated` decides). Both must answer, and this is the control that
     * says the change did not disturb the branch it does not serve.
     */
    const got = rows(g, 'MATCH (a:A), (a)-[:E]->(c:A) RETURN a.n AS x, c.n AS y');

    expect(got.map((r) => [r.x, r.y])).toEqual([[1, 2]]);
  });
});

describe('the OPTIONAL and multi-clause merges', () => {
  const g = build();

  test('an uncorrelated second MATCH clause merges into the first’s rows', () => {
    // `clauses.ts`'s other two merge sites: a whole CLAUSE whose names are disjoint from the
    // incoming binding is matched once and cached, then merged per outer row.
    const got = rows(g, 'MATCH (a:A) MATCH (b:B) RETURN a.n AS x, b.m AS y ORDER BY x, y');

    expect(got.map((r) => [r.x, r.y])).toEqual([
      [1, 10],
      [1, 20],
      [2, 10],
      [2, 20],
    ]);
  });

  test('`RETURN *` across two clauses keeps the clause order', () => {
    const got = rows(g, 'MATCH (a:A) MATCH (b:B) RETURN *');

    expect(got).toHaveLength(4);
    // ⚠️ ALL FOUR, for the same reason: the clause cache serves rows 2..n from a different call site.
    expect(keyOrders(got)).toEqual(Array.from({ length: 4 }, () => ['a', 'b']));
  });

  test('an EMPTY incoming binding passes the matcher’s own binding through unchanged', () => {
    /*
     * ⚠️ THE `bare` FAST PATH, which the merge must not have disturbed: a leading MATCH has nothing
     * to merge, and copying it anyway measured 1.93x on a 20,000-row scan. So this shape must NOT
     * go through `mergeBinding` at all — and the only way to see that from outside is that it still
     * answers correctly with the key order intact.
     */
    const got = rows(g, 'MATCH (a:A) RETURN *');

    expect(got).toHaveLength(2);
    expect(keyOrders(got)).toEqual([['a'], ['a']]);
  });

  test('OPTIONAL MATCH that misses yields a null-filled row, not a dropped one', () => {
    const got = rows(
      g,
      'MATCH (a:A) OPTIONAL MATCH (a)-[:NOPE]->(z:A) RETURN a.n AS x, z.n AS y ORDER BY x',
    );

    expect(got.map((r) => [r.x, r.y])).toEqual([
      [1, null],
      [2, null],
    ]);
  });
});
