/**
 * Item 1106: the sweep remembers each slot's FAR SLOTS, so passes 2+ skip the string lookup.
 *
 * Item 1105 ablated the per-edge body and found `slotOf.get(farId)` is 24% of `count 4-hop`
 * (570.6 ms against 432.0 with the lookup removed). A sweep makes one pass per leg over the SAME
 * adjacency, so when every pass would resolve the same edges to the same slots, later passes can
 * read a remembered `Int32Array` instead. Alternated PRE/POST, min of three, 200,000 vertices:
 *
 *   count 4-hop               550.5 ms -> 297.5   1.85x
 *   count 4-hop + start filter 221.9    -> 205.7   1.08x
 *   count 3-hop (product arm)  316.0    -> 314.2   CONTROL, flat
 *
 * `passes > 2` is measured: with exactly two passes one building pass is refunded by one
 * consuming pass and it is a small LOSS (`count 3-hop + start filter` 162.0 -> 165.7).
 *
 * THE ORACLE IS A ROW PROJECTION (item 1095). `AND true` and `SKIP 0` are absorbed by any rung
 * already taking a predicate or a page bound, so they compare a route against itself; a
 * row-returning query cannot be answered by a count shortcut at all.
 *
 * WHAT A WRONG REMEMBERED LIST LOOKS LIKE, which is what these tests are built to catch: the memo
 * is keyed by SLOT and filled on first visit, so a fixture where the first pass visits a DIFFERENT
 * set of slots than later passes is where a stale or missing list shows up. `narrow()` below is
 * that fixture — a single start, so pass 1 visits one slot and pass 2 visits its neighbours, none
 * of which were visited before.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.ts';

/** The fast route and an INDEPENDENT (row-returning) route on ONE pattern. */
const both = (g: Graph, pattern: string, filter = ''): number => {
  const fast = query<{ c: number }>(g, `MATCH ${pattern} ${filter} RETURN count(*) AS c`)[0].c;
  const rows = query(g, `MATCH ${pattern} ${filter} RETURN a.k AS x`).length;

  expect(fast).toBe(rows);

  return fast;
};

/** Every vertex is a source, so pass 1 visits every slot the later passes will. */
const dense = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 7 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
  );

  // A ring plus two chords, so degrees differ and some slots are reached many ways.
  for (let i = 0; i < 7; i += 1) {
    g.addEdge({ id: `r${i}`, labels: ['T'], from: vs[i], to: vs[(i + 1) % 7], properties: {} });
  }

  g.addEdge({ id: 'c1', labels: ['T'], from: vs[0], to: vs[3], properties: {} });
  g.addEdge({ id: 'c2', labels: ['T'], from: vs[2], to: vs[5], properties: {} });
  g.addEdge({ id: 'loop', labels: ['T'], from: vs[4], to: vs[4], properties: {} });
  // A PARALLEL edge, so the remembered list must keep duplicates: two edges to one slot must
  // contribute twice, and a list that deduped would answer low.
  g.addEdge({ id: 'par', labels: ['T'], from: vs[1], to: vs[2], properties: {} });

  return g;
};

/** ONE start, so pass 1 visits a single slot and every later pass visits slots it never saw. */
const narrow = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 8 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: i === 0 ? ['S'] : ['P'], properties: { k: i } }),
  );

  g.addEdge({ id: 'a', labels: ['T'], from: vs[0], to: vs[1], properties: {} });
  g.addEdge({ id: 'b', labels: ['T'], from: vs[0], to: vs[2], properties: {} });
  g.addEdge({ id: 'c', labels: ['T'], from: vs[1], to: vs[3], properties: {} });
  g.addEdge({ id: 'd', labels: ['T'], from: vs[2], to: vs[3], properties: {} });
  g.addEdge({ id: 'e', labels: ['T'], from: vs[2], to: vs[4], properties: {} });
  g.addEdge({ id: 'f', labels: ['T'], from: vs[3], to: vs[5], properties: {} });
  g.addEdge({ id: 'g', labels: ['T'], from: vs[4], to: vs[5], properties: {} });
  g.addEdge({ id: 'h', labels: ['T'], from: vs[5], to: vs[6], properties: {} });
  g.addEdge({ id: 'i', labels: ['T'], from: vs[6], to: vs[7], properties: {} });
  g.addEdge({ id: 'j', labels: ['T'], from: vs[3], to: vs[3], properties: {} });

  return g;
};

describe('a bare directed chain deep enough to use the remembered slots', () => {
  for (const [name, fixture, head] of [
    ['every vertex a source', dense, '(a:P)'],
    ['a single source, so later passes visit new slots', narrow, '(a:S)'],
  ] as ReadonlyArray<readonly [string, () => Graph, string]>) {
    describe(name, () => {
      test('FOUR legs — three passes, two of them from the memo', () => {
        const g = fixture();

        expect(both(g, `${head}-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)`)).toBeGreaterThanOrEqual(
          0,
        );
      });

      test('FIVE and SIX legs, so a memo is read three and four times', () => {
        const g = fixture();

        expect(
          both(g, `${head}-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)-[:T]->(y)`),
        ).toBeGreaterThanOrEqual(0);
        expect(
          both(g, `${head}-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)-[:T]->(y)-[:T]->(z)`),
        ).toBeGreaterThanOrEqual(0);
      });

      test('the ALL-IN spelling, which is uniform in the other direction', () => {
        const g = fixture();

        expect(both(g, `${head}<-[:T]-(b)<-[:T]-(c)<-[:T]-(d)<-[:T]-(x)`)).toBeGreaterThanOrEqual(
          0,
        );
      });

      test('a START gate, which leaves the legs bare so the memo still applies', () => {
        const g = fixture();

        expect(
          both(g, `${head}-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)`, 'WHERE a.k >= 0'),
        ).toBeGreaterThanOrEqual(0);
        expect(
          both(g, `${head}-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)`, 'WHERE a.k = 2'),
        ).toBeGreaterThanOrEqual(0);
      });

      test('THREE legs — two passes, which the threshold excludes', () => {
        const g = fixture();

        expect(both(g, `${head}-[:T]->(b)-[:T]->(c)-[:T]->(d)`)).toBeGreaterThanOrEqual(0);
      });
    });
  }
});

describe('the conditions the memo must decline', () => {
  test('a MIXED direction chain, where there is no single index', () => {
    const g = dense();

    expect(both(g, '(a:P)-[:T]->(b)-[:T]->(c)<-[:T]-(d)-[:T]->(x)')).toBeGreaterThanOrEqual(0);
    expect(both(g, '(a:P)-[:T]-(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)')).toBeGreaterThanOrEqual(0);
  });

  test('DIFFERENT edge types per leg, which walk different subsets of one slot', () => {
    // Two types, so a memo built for `:T` must not be read by a `:U` leg. This is the condition
    // that cannot be caught on a single-type fixture, which every other test here is.
    const g = new Graph();
    const vs = Array.from({ length: 6 }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
    );

    g.addEdge({ id: 't1', labels: ['T'], from: vs[0], to: vs[1], properties: {} });
    g.addEdge({ id: 'u1', labels: ['U'], from: vs[1], to: vs[2], properties: {} });
    g.addEdge({ id: 't2', labels: ['T'], from: vs[1], to: vs[3], properties: {} });
    g.addEdge({ id: 'u2', labels: ['U'], from: vs[2], to: vs[3], properties: {} });
    g.addEdge({ id: 't3', labels: ['T'], from: vs[2], to: vs[4], properties: {} });
    g.addEdge({ id: 'u3', labels: ['U'], from: vs[3], to: vs[4], properties: {} });
    g.addEdge({ id: 't4', labels: ['T'], from: vs[4], to: vs[5], properties: {} });
    g.addEdge({ id: 'u4', labels: ['U'], from: vs[4], to: vs[0], properties: {} });

    for (const pattern of [
      '(a:P)-[:T]->(b)-[:U]->(c)-[:T]->(d)-[:U]->(x)',
      '(a:P)-[:T]->(b)-[:T]->(c)-[:U]->(d)-[:T]->(x)',
      '(a:P)-[:U]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)',
      // An UNTYPED leg is "any type", which matches only another untyped leg.
      '(a:P)-[]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)',
      '(a:P)-[]->(b)-[]->(c)-[]->(d)-[]->(x)',
    ]) {
      expect(both(g, pattern)).toBeGreaterThanOrEqual(0);
    }
  });

  test('an INTERIOR label and an INTERIOR gate, which decide admission per leg', () => {
    const g = dense();

    g.addVertex({ id: 'q', labels: ['Q'], properties: { k: 99 } });

    expect(both(g, '(a:P)-[:T]->(b:P)-[:T]->(c)-[:T]->(d)-[:T]->(x)')).toBeGreaterThanOrEqual(0);
    expect(both(g, '(a:P)-[:T]->(b)-[:T]->(c:P)-[:T]->(d)-[:T]->(x)')).toBeGreaterThanOrEqual(0);
    expect(both(g, '(a:P)-[:T]->(b {k: 2})-[:T]->(c)-[:T]->(d)-[:T]->(x)')).toBeGreaterThanOrEqual(
      0,
    );
    expect(
      both(g, '(a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)', 'WHERE c.k >= 1'),
    ).toBeGreaterThanOrEqual(0);
    // The LAST position gated, which takes the extra pass rather than the degree tail.
    expect(
      both(g, '(a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)', 'WHERE x.k = 3'),
    ).toBeGreaterThanOrEqual(0);
  });

  test('a shared node variable, which the sweep declines outright', () => {
    const g = dense();

    expect(
      query<{ c: number }>(
        g,
        'MATCH (a:P)-[:T]->(b)-[:T]->(c)-[:T]->(b)-[:T]->(x) RETURN count(*) AS c',
      )[0].c,
    ).toBe(query(g, 'MATCH (a:P)-[:T]->(b)-[:T]->(c)-[:T]->(b)-[:T]->(x) RETURN a.k AS x').length);
  });
});

describe('the memo survives a graph that grows the slot arrays', () => {
  test('a chain long enough and a graph wide enough to pass the initial cap', () => {
    // The initial `cap` is 256 and the arrays double on growth, which REASSIGNS `st.ways` and
    // `st.next`. The memo is indexed by slot and must stay aligned across that growth, so this
    // fixture crosses the boundary rather than sitting under it.
    const g = new Graph();
    const n = 400;
    const vs = Array.from({ length: n }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: i === 0 ? ['S'] : ['P'], properties: { k: i } }),
    );

    for (let i = 0; i < n; i += 1) {
      g.addEdge({ id: `e${i}`, labels: ['T'], from: vs[i], to: vs[(i + 1) % n], properties: {} });
      g.addEdge({
        id: `f${i}`,
        labels: ['T'],
        from: vs[i],
        to: vs[(i * 7 + 3) % n],
        properties: {},
      });
    }

    expect(both(g, '(a:S)-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)')).toBeGreaterThan(0);
    expect(both(g, '(a:P)-[:T]->(b)-[:T]->(c)-[:T]->(d)-[:T]->(x)')).toBeGreaterThan(0);
  });
});
