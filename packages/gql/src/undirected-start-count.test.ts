/**
 * Item 1076: the constrained UNDIRECTED hop count, by degree sums over both adjacency boxes.
 *
 * `buildOneHopCount` declined every constrained undirected hop, so `(a:L)-[:T]-(x) WHERE <a-only>`
 * fell to the general path and built a binding and a row per edge — 242.78 ms against native's 2.29
 * at 200,000 vertices (item 1075).
 *
 * WHAT GIVES THESE TESTS TEETH. The arm is answer-equivalent to the route it replaces, so the
 * oracle is that route rather than a number I worked out: every case asserts the fast route against
 * the same pattern with `WHERE true`, which forces a real predicate and therefore the general path
 * (item 570's control). `undirected-hop-count.test.ts` already does this for the UNFILTERED route —
 * and it is what caught the first cut of this arm double-counting a multi-type edge, 6 against 4.
 *
 * The SELF-LOOP correction is the part with its own arithmetic: both adjacency boxes hold a loop
 * while `expand` emits it once, so a vertex with a loop would be counted one too many. Every case
 * below exists in a loop-free and a looped variant for that reason.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.ts';

/**
 * The fast route and the general path on ONE pattern, asserted equal and returned.
 *
 * `WHERE true` is what forces the general path: it is a real predicate, so no count shortcut
 * claims it, and it cannot change which rows match.
 */
/**
 * The fast route and an INDEPENDENT route on ONE pattern, asserted equal and returned.
 *
 * ⚠️ THE ORACLE IS A ROW PROJECTION, NOT `AND true` (corrected at item 1095). `AND true` was
 * item 570's decline-forcer for the UNFILTERED count, where adding any predicate does change the
 * route. **It does NOT decline a rung that is already taking a predicate**: tracing shows
 * `a.k >= 0` and `a.k >= 0 AND true` both enter `undirectedStartOnlyCount`, and both far-reading
 * spellings both enter `undirectedTally` — so every comparison here was the fast route against
 * itself. `SKIP 0` is absorbed too.
 *
 * Item 930 names this failure: "an oracle built from a shape the optimizer is allowed to learn
 * will eventually stop being an oracle, and it fails SILENTLY — green, and comparing one route to
 * itself." A ROW-RETURNING query cannot be answered by any count shortcut, so counting its rows is
 * an oracle by construction. (The hand-pinned literals below are what gave these tests their teeth
 * in the meantime; re-running item 1078's and 1086's mutants against the real oracle caught
 * nothing new, so no shipped answer was wrong — but the comparison was not doing the work its
 * comment claimed.)
 */
const both = (g: Graph, pattern: string, filter: string): number => {
  const fast = query<{ c: number }>(g, `MATCH ${pattern} ${filter} RETURN count(*) AS c`)[0].c;
  const enumerated = query(g, `MATCH ${pattern} ${filter} RETURN a.k AS x`).length;

  expect(fast).toBe(enumerated);

  return fast;
};

/** `loops` self-loops on the first `loops` vertices, so the correction is exercised or not. */
const fixture = (loops: number): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 6 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
  );

  // A path plus a reversed edge, so a vertex has entries in BOTH boxes and the two sums differ.
  g.addEdge({ id: 'e0', labels: ['T'], from: vs[0], to: vs[1], properties: { w: 1 } });
  g.addEdge({ id: 'e1', labels: ['T'], from: vs[1], to: vs[2], properties: { w: 1 } });
  g.addEdge({ id: 'e2', labels: ['T'], from: vs[3], to: vs[1], properties: { w: 1 } });
  g.addEdge({ id: 'e3', labels: ['T'], from: vs[4], to: vs[5], properties: { w: 1 } });
  // An edge of ANOTHER type, which the typed pattern must not count.
  g.addEdge({ id: 'o0', labels: ['S'], from: vs[0], to: vs[2], properties: { w: 1 } });

  for (let i = 0; i < loops; i++) {
    g.addEdge({ id: `l${i}`, labels: ['T'], from: vs[i], to: vs[i], properties: { w: 1 } });
  }

  return g;
};

describe('a constrained undirected hop count equals the general path', () => {
  for (const loops of [0, 1, 3]) {
    describe(`${loops} self-loops`, () => {
      // EVERY number here was read off the two routes on this fixture, not worked out by hand:
      // four of my hand-derived ones were wrong on the first run and `both`'s own equality was
      // what held. The literals pin them so a change that moves BOTH routes together is caught.
      const n = { 0: 8, 1: 9, 3: 11 }[loops] as number;

      test('a clause WHERE on the start', () => {
        const g = fixture(loops);

        expect(both(g, '(a:P)-[:T]-(x)', 'WHERE a.k >= 0')).toBe(n);
        expect(both(g, '(a:P)-[:T]-(x)', 'WHERE a.k > 0')).toBe(loops === 3 ? 9 : 7);
        expect(both(g, '(a:P)-[:T]-(x)', 'WHERE a.k > 3')).toBe(2);
        expect(both(g, '(a:P)-[:T]-(x)', 'WHERE a.k > 99')).toBe(0);
      });

      test('an INLINE start property', () => {
        const g = fixture(loops);

        expect(both(g, '(a:P {k: 1})-[:T]-(x)', 'WHERE true')).toBe(loops === 3 ? 4 : 3);
        expect(both(g, '(a:P {k: 5})-[:T]-(x)', 'WHERE true')).toBe(1);
      });

      test('the other TYPE is not counted', () => {
        const g = fixture(loops);

        expect(both(g, '(a:P)-[:S]-(x)', 'WHERE a.k >= 0')).toBe(2);
      });

      test('a vertex with a loop is counted ONCE for it, not twice', () => {
        const g = fixture(loops);

        // `v0` has `e0` over `T` plus `o0` over another type, and a loop when `loops > 0`. So
        // undirected over `T` is 1 without a loop and 2 with one — where summing both boxes
        // WITHOUT the correction would give 3, since a loop sits in `adjFrom` and `adjTo` both.
        expect(both(g, '(a:P {k: 0})-[:T]-(x)', 'WHERE true')).toBe(loops === 0 ? 1 : 2);
      });
    });
  }
});

/**
 * Item 1078: the MULTI-TYPE and UNTYPED spellings, which item 1076 declined outright.
 *
 * Its stated reason was wrong — `multiTypeEdgeCount === 0` is readable inside the closure, and the
 * branch beside this one already reads it there. So the arm now subtracts the overcount exactly:
 * a passing endpoint of an edge carrying `m` of the requested types is counted `m` times by the
 * bucket sums where it belongs once, and `2m` times when that edge is a SELF-LOOP.
 *
 * The `m >= 2` LOOP is the shape neither of item 1076's fixtures could reach — a loop carrying two
 * requested types is counted FOUR times and belongs once, so the correction is 3 and every simpler
 * formula (`m - 1`, `1`, `2m`) gets it wrong. It has its own cases below for that reason.
 */
describe('the multi-type and untyped spellings', () => {
  test('a multi-type alternation is not summed per bucket', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 0 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1 } });

    g.addEdge({ id: 'both', labels: ['T', 'S'], from: a, to: b, properties: { w: 1 } });
    g.addEdge({ id: 'tonly', labels: ['T'], from: b, to: a, properties: { w: 1 } });

    // ONE edge carries both types and must not be counted once per bucket. This is the assertion
    // the first cut of item 1076's arm failed, at 6 against 4 — and the arm declined this spelling
    // rather than get it right until item 1078.
    expect(both(g, '(a:P)-[:T|S]-(x)', 'WHERE a.k >= 0')).toBe(4);
    expect(both(g, '(a:P)-[:T]-(x)', 'WHERE a.k >= 0')).toBe(4);
    expect(both(g, '(a:P)-[:S]-(x)', 'WHERE a.k >= 0')).toBe(2);
    // The UNTYPED spelling spans every bucket, so it is the same question with `m = |labels|`.
    expect(both(g, '(a:P)-[]-(x)', 'WHERE a.k >= 0')).toBe(4);
  });

  test('a SELF-LOOP carrying two requested types is corrected by 3, not 1', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 0 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1 } });

    g.addEdge({ id: 'plain', labels: ['T'], from: a, to: b, properties: { w: 1 } });
    // Four bucket appearances — `adjFrom[T]`, `adjFrom[S]`, `adjTo[T]`, `adjTo[S]` — and ONE row.
    g.addEdge({ id: 'twoloop', labels: ['T', 'S'], from: a, to: a, properties: { w: 1 } });

    expect(both(g, '(a:P)-[:T|S]-(x)', 'WHERE a.k >= 0')).toBe(3);
    expect(both(g, '(a:P)-[]-(x)', 'WHERE a.k >= 0')).toBe(3);
    // The loop is on `a`, so a filter that excludes `a` must drop the correction with it.
    expect(both(g, '(a:P)-[:T|S]-(x)', 'WHERE a.k = 1')).toBe(1);
    expect(both(g, '(a:P)-[:T|S]-(x)', 'WHERE a.k = 0')).toBe(2);
    // ONE of the two types still sees the loop twice in the boxes and once in the answer.
    expect(both(g, '(a:P)-[:T]-(x)', 'WHERE a.k >= 0')).toBe(3);
    expect(both(g, '(a:P)-[:S]-(x)', 'WHERE a.k >= 0')).toBe(1);
  });

  test('a multi-type NON-loop edge is corrected at BOTH endpoints', () => {
    const g = new Graph();
    const vs = Array.from({ length: 3 }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
    );

    g.addEdge({ id: 'both', labels: ['T', 'S'], from: vs[0], to: vs[1], properties: { w: 1 } });
    g.addEdge({ id: 'also', labels: ['T', 'S'], from: vs[1], to: vs[2], properties: { w: 1 } });

    // Each endpoint of each two-type edge is overcounted by one, and a filter that passes only
    // ONE endpoint must subtract only that one — which is why the correction asks each separately.
    expect(both(g, '(a:P)-[:T|S]-(x)', 'WHERE a.k >= 0')).toBe(4);
    expect(both(g, '(a:P)-[:T|S]-(x)', 'WHERE a.k = 0')).toBe(1);
    expect(both(g, '(a:P)-[:T|S]-(x)', 'WHERE a.k = 1')).toBe(2);
    expect(both(g, '(a:P)-[:T|S]-(x)', 'WHERE a.k > 0')).toBe(3);
  });

  test('an INLINE start property on the multi-type spelling', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 0 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1 } });

    g.addEdge({ id: 'both', labels: ['T', 'S'], from: a, to: b, properties: { w: 1 } });
    g.addEdge({ id: 'loop', labels: ['T', 'S'], from: b, to: b, properties: { w: 1 } });

    expect(both(g, '(a:P {k: 0})-[:T|S]-(x)', 'WHERE true')).toBe(1);
    expect(both(g, '(a:P {k: 1})-[:T|S]-(x)', 'WHERE true')).toBe(2);
  });

  test('the UNTYPED spelling on the shared fixture, loop-free and looped', () => {
    for (const loops of [0, 1, 3]) {
      const g = fixture(loops);

      // Every edge here carries ONE label, so `multiTypeEdgeCount === 0` and the untyped sum is
      // sound on its own — only the loop correction applies. The `-[:S]-` edge is counted too.
      expect(both(g, '(a:P)-[]-(x)', 'WHERE a.k >= 0')).toBe(
        { 0: 10, 1: 11, 3: 13 }[loops] as number,
      );
    }
  });
});

describe('the shapes the arm must still decline', () => {
  // Each asserts the ANSWER, which is what a wrongly-admitted shape gets wrong — and `both`
  // compares against the general path on every one, so a decline that is not really a decline is
  // caught too.

  test('a FAR constraint, which a degree sum cannot apply', () => {
    const g = fixture(0);

    expect(both(g, '(a:P)-[:T]-(x:P)', 'WHERE a.k >= 0')).toBe(8);
    expect(both(g, '(a:P)-[:T]-(x {k: 1})', 'WHERE a.k >= 0')).toBe(3);
  });

  test('a predicate reading the FAR end', () => {
    const g = fixture(0);

    expect(both(g, '(a:P)-[:T]-(x)', 'WHERE x.k = 1')).toBe(3);
  });

  test('a REL constraint, which a degree sum never visits an edge to apply', () => {
    const g = fixture(0);

    expect(both(g, '(a:P)-[r:T]-(x)', 'WHERE r.w = 1')).toBe(8);
    expect(both(g, '(a:P)-[r:T]-(x)', 'WHERE r.w = 9')).toBe(0);
  });
});
