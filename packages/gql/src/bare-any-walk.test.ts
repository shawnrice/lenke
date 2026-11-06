import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * `anyWalk` — GQL's bare-`ANY` TRAIL ENUMERATOR, which had no test in any suite (item 1616).
 *
 * ⚠️ FOUND MECHANICALLY, not by reading. Item 1616 duplicated every bare `yield` in the GQL
 * executor one at a time and ran the suite: ten of eleven sites died, and `matching.ts`'s `anyWalk`
 * emission survived. A duplicated emission makes every bare-`ANY` row come out twice, so nothing
 * drained that generator at all.
 *
 * Why it was invisible: `pickSeedDriver` sends `ANY` to the O(V+E) BFS driver whenever
 * `bfsReducible` holds — one segment, `min <= 1`, no inline predicate — and EVERY existing
 * bare-`ANY` test uses `*` (min 0) or `{1,1}`. All of them exercised `shortestWalk`; the
 * enumerate-trails arm beneath it was reached by no spelling anyone had written. `{2,3}` is the
 * cheapest spelling that gets there, because `min = 2` makes the pattern non-reducible.
 *
 * ⚠️ AND THIS FILE HAS TO LIVE IN THE `gql` PACKAGE. The byte-identity twin
 * (`packages/native/src/bare-any-walk-parity.test.ts`) imports `@lenke/gql`, which resolves to the
 * BUILT DIST — so it cannot pin a `src` path at all until a rebuild, and a mutation pass against
 * `src` sails straight past it. That is `fuzzers-read-built-dists` applied to a unit test, and it is
 * the reason the same claim is asserted in two places rather than one.
 *
 * ```text
 *   a -> b -> c -> d -> e
 *   a -> c        so `c` is reachable in 1 hop and in 2
 *   b -> d        so `d` is reachable in 2 hops and in 3
 * ```
 *
 * TWO ROUTES to `c` and `d` on purpose: "one arbitrary path per endpoint" is only a real choice when
 * an endpoint has more than one path, and a path graph makes the ANY and the all-trails answers
 * COINCIDE — the fixture defect item 614 recorded for this very selector, where both counts were 6.
 */
const EDGES: readonly [string, string][] = [
  ['a', 'b'],
  ['b', 'c'],
  ['c', 'd'],
  ['a', 'c'],
  ['b', 'd'],
  ['d', 'e'],
];

const g = ((): Graph => {
  const graph = new Graph();

  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    graph.addVertex({ id, labels: ['N'], properties: { id } });
  }

  EDGES.forEach(([from, to], i) => {
    graph.addEdge({
      id: `r${i}`,
      from: graph.getVertexById(from)!,
      to: graph.getVertexById(to)!,
      labels: ['R'],
      properties: {},
    });
  });

  return graph;
})();

describe('bare `ANY` over a non-reducible quantifier', () => {
  test('ONE row per endpoint, not one per path — the selector’s whole claim', () => {
    /**
     * ⚠️ DERIVED, and this is the assertion the duplicated-`yield` mutant dies on. From `a` with
     * `{2,3}`: the 2-hop ends are `c` (a>b>c) and `d` (a>b>d, a>c>d); the 3-hop ends are `d`
     * (a>b>c>d) and `e` (a>b>d>e, a>c>d>e). Distinct endpoints c, d, e — THREE rows.
     */
    expect(
      query(g, `MATCH ANY (a:N {id:'a'})-[:R]->{2,3}(x) RETURN x.id AS id ORDER BY id`),
    ).toEqual([{ id: 'c' }, { id: 'd' }, { id: 'e' }]);
  });

  test('and the ALL-TRAILS spelling of the same walk answers SIX', () => {
    // So the three above is the selector working, not the fixture having only three paths. Without
    // this control the test would pass on a graph where every endpoint has exactly one path.
    expect(query(g, `MATCH (a:N {id:'a'})-[:R]->{2,3}(x) RETURN count(*) AS c`)).toEqual([
      { c: 6 },
    ]);
  });

  test('the per-endpoint `seen` set is PER SEED, not global', () => {
    /**
     * Every start, so an endpoint reached from two different seeds must appear once per seed. `d` is
     * reached from `a` and from `b`; `e` from `a`, `b` and `c`. A `seen` set hoisted out of the
     * per-seed call would drop those rows.
     */
    expect(
      query(g, `MATCH ANY (a:N)-[:R]->{2,3}(x) RETURN a.id AS s, x.id AS id ORDER BY s, id`),
    ).toEqual([
      { s: 'a', id: 'c' },
      { s: 'a', id: 'd' },
      { s: 'a', id: 'e' },
      { s: 'b', id: 'd' },
      { s: 'b', id: 'e' },
      { s: 'c', id: 'e' },
    ]);
  });

  test('a count over the same shape, which a shortcut could claim separately', () => {
    expect(query(g, `MATCH ANY (a:N {id:'a'})-[:R]->{2,4}(x) RETURN count(*) AS c`)).toEqual([
      { c: 3 },
    ]);
  });

  test('an endpoint predicate narrows AFTER the one-witness-per-endpoint rule', () => {
    expect(
      query(
        g,
        `MATCH ANY (a:N {id:'a'})-[:R]->{2,3}(x) WHERE x.id <> 'e' RETURN x.id AS id ORDER BY id`,
      ),
    ).toEqual([{ id: 'c' }, { id: 'd' }]);
  });

  test('a seed with nothing downstream, and a bound nothing satisfies', () => {
    expect(query(g, `MATCH ANY (a:N {id:'e'})-[:R]->{2,3}(x) RETURN x.id AS id`)).toEqual([]);
    expect(query(g, `MATCH ANY (a:N {id:'a'})-[:R]->{9,9}(x) RETURN count(*) AS c`)).toEqual([
      { c: 0 },
    ]);
  });

  test('the REDUCIBLE twin takes the BFS driver and must agree where they overlap', () => {
    // `min <= 1` routes to `shortestWalk` instead. Both drivers claim "one path per endpoint", so
    // the endpoint SETS have to match on a shape both can answer.
    expect(
      query(g, `MATCH ANY (a:N {id:'a'})-[:R]->{1,3}(x) RETURN x.id AS id ORDER BY id`),
    ).toEqual([{ id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]);
    expect(query(g, `MATCH ANY (a:N {id:'a'})-[:R]->*(x) RETURN x.id AS id ORDER BY id`)).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
    ]);
  });
});
