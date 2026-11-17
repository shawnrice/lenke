import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { V, both, count, dedupe, eq, gt, has, hasLabel, in_, out, traversal } from '../index.js';
import type { Plan } from '../index.js';
import { countShortcut } from './count-shortcut.js';

/**
 * `V()[…filters] out(T) […filters] out(U) …filters .count()` — a TRAILING filter after the LAST hop,
 * which reached none of `countShortcut`'s rungs and fell to the traverser pipeline at **214x**
 * (item 1612).
 *
 * Item 1602 named this shape and left it: the final contribution stops being a DEGREE once the far
 * end is filtered, so the last level has to be walked. Measured on 20,000 vertices / ~80,000 edges:
 *
 * ```text
 *    V().hasLabel(U).out(E).out(E).count()                   464445 ns   closed form (item 574)
 *    V().hasLabel(U).out(E).out(E).has(team,eq).count()    99515343      THE PIPELINE   214x
 *    a hand-written FAR-DRIVEN floor                         354162      the ceiling
 *    ... after this rung                                     467028      on the floor
 * ```
 *
 * Same walk, same 319,972 traversers, one `has` at the end — and the no-filter twin being
 * closed-form is what makes it a cliff rather than honest work.
 *
 * ⚠️ EVERY LITERAL BELOW IS DERIVED FROM THE TABLE BY A SCRIPT, with no engine involved, before this
 * file was written. Items 1602 and 1611 both wrote literals by eye and both were wrong while the
 * engine was right — 1611's `max` could not even discriminate the property it was testing.
 *
 * `>` is an `E` edge, `~` an `F` edge:
 *
 * ```text
 *   a  [User]        team=t1  >b >c ~d
 *   b  [User]        team=t1  >c >e
 *   c  [Admin]       team=t2  >c          a SELF-LOOP
 *   d  [User,Admin]  team=t1  >a >b       TWO labels, so hasLabel is not a partition
 *   e  [Admin]       (no team)            a MISSING property, which `has` must reject
 *   f  [User]        team=t2  >e >c
 * ```
 */
const TABLE = [
  {
    id: 'a',
    labels: ['User'],
    team: 't1',
    out: [
      ['b', 'E'],
      ['c', 'E'],
      ['d', 'F'],
    ],
  },
  {
    id: 'b',
    labels: ['User'],
    team: 't1',
    out: [
      ['c', 'E'],
      ['e', 'E'],
    ],
  },
  { id: 'c', labels: ['Admin'], team: 't2', out: [['c', 'E']] },
  {
    id: 'd',
    labels: ['User', 'Admin'],
    team: 't1',
    out: [
      ['a', 'E'],
      ['b', 'E'],
    ],
  },
  { id: 'e', labels: ['Admin'], team: undefined, out: [] },
  {
    id: 'f',
    labels: ['User'],
    team: 't2',
    out: [
      ['e', 'E'],
      ['c', 'E'],
    ],
  },
] as const;

const build = (): Graph => {
  const g = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = {};

    if (r.team !== undefined) {
      properties.team = r.team;
    }

    g.addVertex({ id: r.id, labels: [...r.labels], properties });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const [to, label] of r.out) {
      g.addEdge({
        id: `e${n++}`,
        from: g.getVertexById(r.id) as Vertex,
        to: g.getVertexById(to) as Vertex,
        labels: [label],
        properties: {},
      });
    }
  }

  return g;
};

const g = build();
const answered = (plan: Plan): number | undefined => countShortcut(plan, g);

describe('a trailing filter after the last hop', () => {
  test('one trailing `has`', () => {
    expect(answered(traversal(V(), out('E'), out('E'), has('team', eq('t1')), count()))).toBe(1);
  });

  test('⚠️ a leading filter that DISCRIMINATES — found by mutation', () => {
    /**
     * ⚠️ `team = 't2'`, NOT `t1`. Dropping the lead filter entirely, and reading the WRONG endpoint
     * of the arriving edge, both SURVIVED the first pass — because with a trailing `t1` the answer
     * is 1 whether the starts are all vertices, `User`s or `Admin`s. Derived over the table:
     *
     * ```text
     *    trailing         no lead   User lead   Admin lead
     *      team = t1          1         1            1      <- cannot discriminate
     *      team = t2          7         6            3
     *      hasLabel(Admin)    9         8            4
     *      (no filter)       10         9            5
     * ```
     *
     * So the lead arm needs a trailing filter whose three columns differ, and `Admin` as a lead
     * separates hardest.
     */
    expect(answered(traversal(V(), out('E'), out('E'), has('team', eq('t2')), count()))).toBe(7);
    expect(
      answered(
        traversal(V(), hasLabel('User'), out('E'), out('E'), has('team', eq('t2')), count()),
      ),
    ).toBe(6);
    expect(
      answered(
        traversal(V(), hasLabel('Admin'), out('E'), out('E'), has('team', eq('t2')), count()),
      ),
    ).toBe(3);
    // And with a trailing `hasLabel` rather than a `has`, so both filter kinds see a filtered lead.
    expect(
      answered(traversal(V(), hasLabel('Admin'), out('E'), out('E'), hasLabel('Admin'), count())),
    ).toBe(4);
    // The original row, kept: a lead that happens NOT to change the answer must still answer it.
    expect(
      answered(
        traversal(V(), hasLabel('User'), out('E'), out('E'), has('team', eq('t1')), count()),
      ),
    ).toBe(1);
  });

  test('a trailing `hasLabel`, where the SELF-LOOP and the two-label vertex both count', () => {
    expect(answered(traversal(V(), out('E'), out('E'), hasLabel('Admin'), count()))).toBe(9);
  });

  test('⚠️ an INTERIOR filter as well — item 1602’s other open shape, same rung', () => {
    /**
     * `out(E).has(team,t1).out(E).has(team,t2)` measured 16.2 ms before this rung and 440 us after
     * — 36.8x. It takes the same walk: a middle failing the interior test contributes zero
     * arrivals, so one rung closes both holes item 1602 left.
     */
    expect(
      answered(
        traversal(V(), out('E'), has('team', eq('t1')), out('E'), has('team', eq('t2')), count()),
      ),
    ).toBe(3);
  });

  test('TWO trailing filters', () => {
    expect(
      answered(
        traversal(V(), out('E'), out('E'), hasLabel('Admin'), has('team', eq('t2')), count()),
      ),
    ).toBe(7);
  });

  test('a MISSING property is rejected, not treated as a match', () => {
    // `e` has no `team`, so a trailing `has('team', …)` must never admit it — but `hasLabel` does.
    expect(answered(traversal(V(), out('E'), out('E'), has('team', eq('t9')), count()))).toBe(0);
    expect(answered(traversal(V(), out('E'), out('E'), hasLabel('Admin'), count()))).toBe(9);
  });

  test('`in` hops on both sides', () => {
    /**
     * The direction mirror: arrivals reach the far end along its OUT-edges for an `in` hop.
     *
     * ⚠️ 8, and my first guess of 5 was the ONE literal in this file I did not derive from the
     * script — the engine was right. Reversing both hops is not symmetric with the `out` form on
     * this fixture, because the in-degree distribution is not the out-degree distribution.
     */
    expect(answered(traversal(V(), in_('E'), in_('E'), has('team', eq('t1')), count()))).toBe(8);
  });

  test('an ORDERING predicate, so the rung is not quietly equality-only', () => {
    expect(answered(traversal(V(), out('E'), out('E'), has('team', gt('t1')), count()))).toBe(7);
  });
});

describe('the rung declines what it must', () => {
  test('a `both` hop on either side', () => {
    expect(
      answered(traversal(V(), both('E'), out('E'), has('team', eq('t1')), count())),
    ).toBeUndefined();
    expect(
      answered(traversal(V(), out('E'), both('E'), has('team', eq('t1')), count())),
    ).toBeUndefined();
  });

  test('⚠️ a THIRD hop is now ANSWERED, by item 2130\u2019s reversal — and the answer is right', () => {
    /*
     * ⚠️⚠️ **THIS TEST ASSERTED `toBeUndefined()` AND ITEM 2130 WIDENED THE ROUTE DELIBERATELY.** It was a
     * ROUTE assertion ("a deeper chain keeps the pipeline"), not an answer one, and the pipeline is no
     * longer where this shape should go: `reversedTrailChain` rewrites `[out, out, out, has]` as
     * `[has, in, in, in]`, which `hopChainCount` answers through the CSR propagation at any depth.
     *
     * 🔑 THE REWRITE IS A BIJECTION ON PATHS — the k-hop OUT-paths ending at a passing vertex correspond
     * one-to-one with the k-hop IN-paths starting at one — so the count is identical, and `0` here is
     * the right answer for this fixture (verified against a brute-force enumeration).
     *
     * ⚠️ `0` IS A WEAK CONFIRMATION ON ITS OWN, so item 2130 pinned the rewrite against brute force on a
     * fixture with plenty of deep paths: 2/3/4 hops at 216/648/1944, `hasLabel` at 405, two trailing
     * filters at 135, and the `in` direction at 648 — all exact. Those live in
     * `reversed-trail-chain.test.ts`; this one keeps the shape in THIS fixture's table.
     */
    expect(
      answered(traversal(V(), out('E'), out('E'), out('E'), has('team', eq('t1')), count())),
    ).toBe(0);
  });

  test('nothing trailing — that is `interleavedHopChainCount`’s shape or `hopChainCount`’s', () => {
    // Both still answer, through their own rungs: 10 two-hop paths, and 3 one-hop E-targets at t1.
    expect(answered(traversal(V(), out('E'), out('E'), count()))).toBe(10);
    expect(answered(traversal(V(), out('E'), has('team', eq('t1')), count()))).toBe(3);
  });

  test('a step after the hops that is not a vertex filter', () => {
    /**
     * ⚠️ THIS ROW FLIPPED AT ITEM 1855, and only its OWNER changed — THIS rung still declines
     * `dedupe`, exactly as the comment said. What changed is that a different rung now claims the
     * shape: `dedupedHopChainCount` answers a K-hop `dedupe().count()` by expanding a SET per
     * level, which closed a **398x** cliff (0.64 ms at one hop against 254.62 at two).
     *
     * The expected 3 is hand-checked against this fixture rather than copied from the engine:
     * E-edges give S1 = {a,b,c,e} and S2 = {b,c,e}.
     */
    expect(answered(traversal(V(), out('E'), out('E'), dedupe(), count()))).toBe(3);
  });

  test('⚠️ a MULTI-TYPE graph with an untyped hop', () => {
    /**
     * `degreeOfTypes` sums the per-type buckets, which is a degree only when the wanted set is ONE
     * bucket. `hopChainShape`'s note records **13 divergences** from getting this wrong, every one
     * an untyped `out()` at depth 2 or more — exactly this rung's depth.
     */
    const multi = new Graph();

    for (const id of ['x', 'y', 'z']) {
      multi.addVertex({ id, labels: ['User'], properties: { team: 't1' } });
    }

    multi.addEdge({
      id: 'm1',
      from: multi.getVertexById('x') as Vertex,
      to: multi.getVertexById('y') as Vertex,
      labels: ['E', 'F'],
      properties: {},
    });
    multi.addEdge({
      id: 'm2',
      from: multi.getVertexById('y') as Vertex,
      to: multi.getVertexById('z') as Vertex,
      labels: ['E'],
      properties: {},
    });

    expect(multi.multiTypeEdgeCount).toBeGreaterThan(0);
    expect(
      countShortcut(traversal(V(), out(), out(), has('team', eq('t1')), count()), multi),
    ).toBeUndefined();
    // A SINGLE named type stays safe on the same graph, so the guard narrows rather than disabling.
    expect(
      countShortcut(traversal(V(), out('E'), out('E'), has('team', eq('t1')), count()), multi),
    ).toBe(1);
  });
});
