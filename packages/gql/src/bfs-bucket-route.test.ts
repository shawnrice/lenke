/*
 * Item 2149 — the BFS behind `ANY SHORTEST` / `ALL SHORTEST` walks the typed adjacency bucket DIRECTLY.
 *
 * THE SAVING IS NOT A BETTER LOOKUP. `expand` already reads this exact bucket; what it also does is
 * **yield a `{ edge, node }` wrapper per edge**. A profile of `ANY SHORTEST …{1,10}` put `expand` at 38.0%
 * self with the GC at 2.9% beside it, against `flatAdj`'s 17.3% on the all-paths arm, which walks a flat
 * array. Measured 1.42x at depth 12 and 1.44x at depth 8.
 *
 * **TWO THINGS HERE CANNOT BE ASSUMED AND SO GET THEIR OWN TESTS.**
 *
 *  1. **The INCOMING direction.** The wrapper carried `node`; the direct read must derive it, as
 *     `direction === 'out' ? edge.to : edge.from`. A route that always took `edge.to` would answer
 *     correctly for every OUT query and walk BACKWARDS for every IN one.
 *  2. **THE SECOND BFS.** The same loop appears twice — once in `shortestWalk` and once in the
 *     all-predecessors variant behind `ALL SHORTEST` — and both were routed. A test of only one selector
 *     would leave the other's edit unexercised.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * A directed chain `v0 → v1 → v2 → v3` plus a shortcut `v0 → v3`, and a back edge `v3 → v0`.
 *
 * THE SHORTCUT IS WHAT MAKES "SHORTEST" MEAN ANYTHING: `v0` reaches `v3` in one hop via the shortcut
 * or three along the chain, so a walk that ignored the selector would report a different distance.
 * THE BACK EDGE exercises the seed-cycle branch, which is the one case a plain `dist.has` check misses.
 */
const chain = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 4; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
  }

  const e = (id: string, from: string, to: string, label = 'E'): void =>
    void g.addEdge({
      id,
      from: g.getVertexById(from)!,
      to: g.getVertexById(to)!,
      labels: [label],
      properties: { w: id === 'short' ? 99 : 1 },
    });

  e('c0', 'v0', 'v1');
  e('c1', 'v1', 'v2');
  e('c2', 'v2', 'v3');
  e('short', 'v0', 'v3');
  e('back', 'v3', 'v0');
  // A second edge label, so a typed walk has something to exclude.
  e('f0', 'v0', 'v2', 'F');

  return g;
};

const g = chain();
const ks = (q: string): unknown[] =>
  query(g, q)
    .map((r) => r.k)
    .sort((a, b) => Number(a) - Number(b));

describe('the direct-bucket BFS route (item 2149)', () => {
  describe('ANY SHORTEST over the OUT direction', () => {
    test('one hop reaches v1 and v3 (the shortcut)', () => {
      expect(ks('MATCH ANY SHORTEST (a:P)-[:E]->{1,1}(b:P) WHERE a.k = 0 RETURN b.k AS k')).toEqual(
        [1, 3],
      );
    });

    test('the SHORTCUT wins: v3 is at distance 1, not 3', () => {
      /*
       * `v0` reaches `v3` two ways — `short` in one hop, or `c0,c1,c2` in three. A shortest walk
       * reports ONE path to `v3`, so widening the ceiling must not add a second.
       */
      const atOne = ks('MATCH ANY SHORTEST (a:P)-[:E]->{1,1}(b:P) WHERE a.k = 0 RETURN b.k AS k');
      const atThree = ks('MATCH ANY SHORTEST (a:P)-[:E]->{1,3}(b:P) WHERE a.k = 0 RETURN b.k AS k');

      // v3 appears exactly once at each ceiling: the longer route is not a second shortest path.
      expect(atOne.filter((x) => x === 3)).toHaveLength(1);
      expect(atThree.filter((x) => x === 3)).toHaveLength(1);
    });

    test('three hops reach all four — the SEED INCLUDED, via the back edge', () => {
      /*
       * DERIVED, not eyeballed: v1 at 1 (`c0`), v3 at 1 (`short`), v2 at 2 (`c0,c1`), and **v0 itself
       * at 2** (`short,back`). I first wrote `[1, 2, 3]` here and the engine was right — the seed is a
       * legitimate endpoint once a cycle closes on it, which is exactly what the `seedCycle` branch is for.
       */
      expect(ks('MATCH ANY SHORTEST (a:P)-[:E]->{1,3}(b:P) WHERE a.k = 0 RETURN b.k AS k')).toEqual(
        [0, 1, 2, 3],
      );
    });

    test('the SEED CYCLE: the ceiling is what admits v0, at exactly 2 hops', () => {
      /*
       * THE SHARPEST ASSERTION IN THIS FILE, because it brackets the branch: `v0 → v3 → v0` is TWO
       * hops, so the seed is ABSENT at a ceiling of 1 and PRESENT from 2 up. A route that lost the
       * `seedCycle` bookkeeping would omit it at every ceiling and still answer the other three right.
       */
      expect(
        ks('MATCH ANY SHORTEST (a:P)-[:E]->{1,1}(b:P) WHERE a.k = 0 RETURN b.k AS k'),
      ).not.toContain(0);
      expect(
        ks('MATCH ANY SHORTEST (a:P)-[:E]->{1,2}(b:P) WHERE a.k = 0 RETURN b.k AS k'),
      ).toContain(0);
    });
  });

  describe('the INCOMING direction — the branch that derives `node` as `edge.from`', () => {
    test('what reaches v3 in one hop', () => {
      /*
       * THE WRONG ANSWER THIS GUARDS. `v3`'s in-edges are `c2` (from `v2`) and `short` (from `v0`). A
       * route that took `edge.to` instead of `edge.from` would answer `[3, 3]` — the edges' own target,
       * which is `v3` itself — or walk forward and report `v0`'s successors.
       */
      expect(ks('MATCH ANY SHORTEST (a:P)<-[:E]-{1,1}(b:P) WHERE a.k = 3 RETURN b.k AS k')).toEqual(
        [0, 2],
      );
    });

    test('and two hops back from v3 reaches all four', () => {
      /*
       * DERIVED backwards from v3: v0 at 1 (`short`), v2 at 1 (`c2`), then v1 at 2 (`c1` into v2), and
       * **v3 itself at 2** — `back` runs v3 → v0, so walking IN from v0 lands on v3.
       */
      expect(ks('MATCH ANY SHORTEST (a:P)<-[:E]-{1,2}(b:P) WHERE a.k = 3 RETURN b.k AS k')).toEqual(
        [0, 1, 2, 3],
      );
    });

    test('the two directions give DIFFERENT answers, so the fixture can tell them apart', () => {
      const out = ks('MATCH ANY SHORTEST (a:P)-[:E]->{1,1}(b:P) WHERE a.k = 3 RETURN b.k AS k');
      const inn = ks('MATCH ANY SHORTEST (a:P)<-[:E]-{1,1}(b:P) WHERE a.k = 3 RETURN b.k AS k');

      expect(out).toEqual([0]); // v3 → v0 via `back`
      expect(inn).toEqual([0, 2]); // v0 → v3 via `short`, v2 → v3 via `c2`
      expect(out).not.toEqual(inn);
    });
  });

  describe('ALL SHORTEST — the SECOND routed BFS', () => {
    test('it answers over the same fixture', () => {
      /*
       * The all-predecessors variant holds the second copy of the edited loop. Without this, that
       * edit is unexercised and a mutation to it survives every other test here.
       */
      expect(ks('MATCH ALL SHORTEST (a:P)-[:E]->{1,3}(b:P) WHERE a.k = 0 RETURN b.k AS k')).toEqual(
        [0, 1, 2, 3],
      );
    });

    test('and over the INCOMING direction too', () => {
      expect(ks('MATCH ALL SHORTEST (a:P)<-[:E]-{1,1}(b:P) WHERE a.k = 3 RETURN b.k AS k')).toEqual(
        [0, 2],
      );
    });
  });

  describe('the shapes the gate declines keep taking the generator', () => {
    test('a BOTH-direction walk', () => {
      // Undirected from v1: v0 (c0) and v2 (c1) at one hop.
      expect(ks('MATCH ANY SHORTEST (a:P)-[:E]-{1,1}(b:P) WHERE a.k = 1 RETURN b.k AS k')).toEqual([
        0, 2,
      ]);
    });

    test('an UNTYPED walk sees the F edge too', () => {
      /*
       * Untyped from `v0` at one hop: `v1` (c0), `v3` (short) AND `v2` (f0, an `F` edge). The typed
       * walk above returns only `[1, 3]`, so this pins that the decline really widens the edge set.
       */
      expect(ks('MATCH ANY SHORTEST (a:P)->{1,1}(b:P) WHERE a.k = 0 RETURN b.k AS k')).toEqual([
        1, 2, 3,
      ]);
    });

    test('a vertex with no edge of that type yields nothing', () => {
      // v1 has no F edge at all.
      expect(ks('MATCH ANY SHORTEST (a:P)-[:F]->{1,2}(b:P) WHERE a.k = 1 RETURN b.k AS k')).toEqual(
        [],
      );
    });
  });

  test('an EDGE PREDICATE still filters the BFS', () => {
    /*
     * `edgePasses` runs per edge on the new route as it did on the old. The shortcut carries `w = 99`
     * and every chain edge `w = 1`, so excluding it forces the three-hop route to `v3`.
     */
    expect(
      ks('MATCH ANY SHORTEST (a:P)-[:E {w: 1}]->{1,1}(b:P) WHERE a.k = 0 RETURN b.k AS k'),
    ).toEqual([1]);
    expect(
      ks('MATCH ANY SHORTEST (a:P)-[:E {w: 1}]->{1,3}(b:P) WHERE a.k = 0 RETURN b.k AS k'),
    ).toEqual([1, 2, 3]);
  });
});
