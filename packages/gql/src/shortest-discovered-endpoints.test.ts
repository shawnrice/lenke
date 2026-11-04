import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * `ANY SHORTEST` emits its endpoints from the DISCOVERED set, not from a scan of every vertex
 * (item 1462) — **40.0x at 10,000 vertices**, and the same answer multiset.
 *
 * `shortestWalk` ran its endpoint loop over `graph.vertices`, so finding the endpoints a depth-bounded
 * BFS had *already discovered* cost O(V) per seed and an all-sources `ANY SHORTEST` was O(V²). At
 * out-degree 1 and depth 3 the BFS discovers ~3 vertices and the loop then scanned 10,000:
 *
 *   N= 2,000    62.09 ms -> 20.46    3.0x
 *   N= 5,000   330.66    -> 46.71    7.1x
 *   N=10,000  1295.16    -> 32.38   40.0x      (the plain `{1,3}` spelling answers the same in 2.23)
 *
 * ⚠️ IT CHANGES ROW ORDER, WHICH IS WHY THESE TESTS COMPARE MULTISETS. The old comment claimed
 * insertion order for determinism against native; that is stricter than the contract. GQL row order
 * without `ORDER BY` is unspecified, and `differential-fuzz` compares rows as a multiset unless
 * `totallyOrdered(q)` admits the query — so endpoint ORDER is free and endpoint SET is not.
 *
 * ⚠️ AND WHAT MUST NOT MOVE IS WHICH PATH EACH ENDPOINT GETS. `ANY SHORTEST` picks one path per
 * endpoint from the `pred` tree, filled in BFS discovery order, which this change does not touch. A
 * fixture with TWO equally short routes to one endpoint is therefore the load-bearing case here: the
 * chosen path must be the same one as before, not merely *a* shortest path. Without that fixture a
 * change that re-rooted the predecessor tree would pass every count below.
 */

const counts = (g: Graph, src: string): number => query<{ c: number }>(g, src)[0].c;

/** Rows as a sorted multiset, since the emission order is deliberately unspecified. */
const ns = (g: Graph, src: string): unknown[] =>
  query(g, src)
    .map((r) => r['n'])
    .slice()
    .sort((x, y) => Number(x) - Number(y));

describe('⚠️ TWO equally short routes: the CHOSEN path must not move (item 1462)', () => {
  /** `a->b->d` and `a->c->d`: two shortest routes to `d`, so `pred` has a real choice to make. */
  const diamond = (): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P', 'S'], properties: { n: 0 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { n: 1 } });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: { n: 2 } });
    const d = g.addVertex({ id: 'd', labels: ['P'], properties: { n: 3 } });

    g.addEdge({ id: 'ab', from: a, to: b, labels: ['E'], properties: {} });
    g.addEdge({ id: 'ac', from: a, to: c, labels: ['E'], properties: {} });
    g.addEdge({ id: 'bd', from: b, to: d, labels: ['E'], properties: {} });
    g.addEdge({ id: 'cd', from: c, to: d, labels: ['E'], properties: {} });

    return g;
  };

  test('the path to the diamond tip goes through `b`, the FIRST-discovered predecessor', () => {
    // THE PATH-IDENTITY GUARD. Both `a->b->d` and `a->c->d` are shortest; the BFS keeps whichever
    // predecessor it saw first, and `ab` is inserted before `ac`. If a future change re-rooted the
    // predecessor tree every count in this file would still pass and this would not.
    // `{1,2}`, because the parser admits ANY SHORTEST only for `min <= 1` (`*`, `+`, `{1,n}`) — a
    // `{2,2}` spelling is a syntax error, which this test learned the hard way.
    const g = diamond();
    const rows = query<{ mid: unknown }>(
      g,
      'MATCH p = ANY SHORTEST (a:S)-[:E]->{1,2}(b:P) WHERE b.n = 3 RETURN nodes(p)[1].n AS mid',
    );

    expect(rows.map((r) => r.mid)).toEqual([1]);
  });

  test('and one path per endpoint, not one per route', () => {
    // `d` is reachable two ways at distance 2; ANY SHORTEST yields it ONCE, so the endpoints are
    // exactly b, c and d.
    expect(
      counts(diamond(), 'MATCH ANY SHORTEST (a:S)-[:E]->{1,2}(b:P) RETURN count(*) AS c'),
    ).toBe(3);
    expect(ns(diamond(), 'MATCH ANY SHORTEST (a:S)-[:E]->{1,2}(b:P) RETURN b.n AS n')).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('the endpoint SET is unchanged by the discovered-set loop (item 1462)', () => {
  /** A path `v0 -> v1 -> … -> v5`, plus an unreachable island, so a scan would differ from a BFS. */
  const chain = (): Graph => {
    const g = new Graph();
    const vs = Array.from({ length: 6 }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: i === 0 ? ['P', 'S'] : ['P'], properties: { n: i } }),
    );

    for (let i = 0; i + 1 < 6; i += 1) {
      g.addEdge({ id: `e${i}`, from: vs[i], to: vs[i + 1], labels: ['E'], properties: {} });
    }

    // ⚠️ THE ISLAND. Unreachable from the seed, so the old whole-graph scan had to skip it by
    // `dist === undefined` while the new loop never visits it. If the new loop somehow admitted
    // undiscovered vertices this is what would catch it.
    g.addVertex({ id: 'island', labels: ['P'], properties: { n: 99 } });

    return g;
  };

  test('⚠️ an UNREACHABLE vertex is not an endpoint', () => {
    const g = chain();

    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,3}(b:P) RETURN b.n AS n')).toEqual([1, 2, 3]);
    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,5}(b:P) RETURN b.n AS n')).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  test('the hop CEILING bounds the discovered set', () => {
    const g = chain();

    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,1}(b:P) RETURN b.n AS n')).toEqual([1]);
    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,2}(b:P) RETURN b.n AS n')).toEqual([1, 2]);
  });

  test('an endpoint LABEL still filters, and the seed is not its own endpoint at min 1', () => {
    const g = chain();

    // `:S` is only on v0, the seed — and at `min >= 1` a zero-hop seed is not an endpoint, so with
    // no cycle back to it this is empty.
    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,5}(b:S) RETURN b.n AS n')).toEqual([]);
    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,5}(b:ZZZ) RETURN b.n AS n')).toEqual([]);
  });

  test('ALL SOURCES agrees with the plain quantifier on this fixture, as it must', () => {
    // At out-degree 1 every reachable pair has exactly ONE path, so `ANY SHORTEST` and the plain
    // quantified spelling count the same thing — which is what made the 40x visible at all.
    const g = chain();

    expect(counts(g, 'MATCH ANY SHORTEST (a:P)-[:E]->{1,3}(b:P) RETURN count(*) AS c')).toBe(
      counts(g, 'MATCH (a:P)-[:E]->{1,3}(b:P) RETURN count(*) AS c'),
    );
  });
});

describe('the SEED-CYCLE endpoint, which the seed sits in `dist` at distance 0 for (item 1462)', () => {
  /** A 3-cycle, so the seed is reachable from itself at distance 3. */
  const cycle = (): Graph => {
    const g = new Graph();
    const vs = Array.from({ length: 3 }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: i === 0 ? ['P', 'S'] : ['P'], properties: { n: i } }),
    );

    for (let i = 0; i < 3; i += 1) {
      g.addEdge({ id: `r${i}`, from: vs[i], to: vs[(i + 1) % 3], labels: ['E'], properties: {} });
    }

    return g;
  };

  test('⚠️ the seed IS an endpoint when a cycle closes within the ceiling', () => {
    // THE CASE THE DISCOVERED-SET LOOP COULD HAVE LOST. The seed is in `dist` at 0 and was emitted by
    // the old scan only via `isSeedCycle`; the new loop visits it from `queue` and must apply the
    // same rule.
    const g = cycle();

    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,3}(b:P) RETURN b.n AS n')).toEqual([0, 1, 2]);
  });

  test('and is NOT an endpoint when the ceiling is below the cycle length', () => {
    const g = cycle();

    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,2}(b:P) RETURN b.n AS n')).toEqual([1, 2]);
  });

  test('a SELF-LOOP closes the cycle at distance 1', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P', 'S'], properties: { n: 0 } });

    g.addEdge({ id: 'aa', from: a, to: a, labels: ['E'], properties: {} });

    expect(ns(g, 'MATCH ANY SHORTEST (a:S)-[:E]->{1,3}(b:P) RETURN b.n AS n')).toEqual([0]);
  });
});
