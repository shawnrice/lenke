/**
 * `count()` over an ID-SEEDED source (item 1649): `V(ids).count()` and `V(ids).<one hop>.count()`
 * now answer from the graph's own indexes instead of walking the traverser pipeline.
 *
 * ⚠️ THE ORACLE IS THE ENGINE'S GENERAL PATH, NOT A HAND-COUNTED LITERAL. A route choice is
 * answer-equivalent by definition, so what has to be pinned is that the two routes AGREE — and this
 * corpus has shipped three seeding bugs whose hand-written expectation was simply wrong (item 1306's
 * `hasId` rewrite raised where the filter did not AND failed to dedupe; item 1643 repeated the
 * raise half). So every case below compares `…count()` against the LENGTH of the same traversal
 * without the `count()`, which the shortcut cannot answer and which therefore runs the walk.
 *
 * The fixture carries every shape that can make the arithmetic differ from a naive label sum:
 * PARALLEL edges, a SELF-LOOP, a MULTI-LABEL edge, and an isolated vertex.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import type { Plan } from './ast.js';
import { toArray } from './executor.js';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- the rung under test
import { countShortcut } from './executor/count-shortcut.js';
import {
  E,
  V,
  both,
  bothE,
  count,
  has,
  hasId,
  in_,
  inE,
  inV,
  out,
  outE,
  traversal,
} from './index.js';

const build = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd']) {
    g.addVertex({ id, labels: ['P'], properties: { k: id } });
  }

  const v = (id: string): Vertex => g.getVertexById(id) as Vertex;

  // PARALLEL: a->b twice, both labelled T.
  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: v('a'), to: v('b'), labels: ['T'], properties: {} });
  // MULTI-LABEL: one edge in two buckets, so a label sum would double-count it.
  g.addEdge({ id: 'e3', from: v('a'), to: v('c'), labels: ['T', 'S'], properties: {} });
  // A SELF-LOOP, which `both` sees twice.
  g.addEdge({ id: 'e4', from: v('a'), to: v('a'), labels: ['T'], properties: {} });
  // An incoming edge of another type, so `in`/`both` have something asymmetric to find.
  g.addEdge({ id: 'e5', from: v('b'), to: v('a'), labels: ['U'], properties: {} });
  // `d` stays isolated.

  return g;
};

const g = build();

/** The same traversal without its `count()`, which the shortcut cannot answer. */
const CASES: readonly (readonly [string, Plan, Plan])[] = [
  ['one id', traversal(V('a'), count()), traversal(V('a'))],
  ['a missing id', traversal(V('zz'), count()), traversal(V('zz'))],
  ['two ids, one missing', traversal(V('a', 'zz'), count()), traversal(V('a', 'zz'))],
  // ⚠️ DUPLICATES ARE NOT DEDUPED — `sourceFromIds` yields one traverser per resolving id.
  ['a duplicate id', traversal(V('a', 'a'), count()), traversal(V('a', 'a'))],
  ['every id', traversal(V('a', 'b', 'c', 'd'), count()), traversal(V('a', 'b', 'c', 'd'))],
  ['an isolated vertex', traversal(V('d'), count()), traversal(V('d'))],

  ['out, one label', traversal(V('a'), out('T'), count()), traversal(V('a'), out('T'))],
  // The multi-label edge: a label sum would count `e3` twice.
  [
    'out, two labels incl. a multi-label edge',
    traversal(V('a'), out('T', 'S'), count()),
    traversal(V('a'), out('T', 'S')),
  ],
  [
    'out, the other order',
    traversal(V('a'), out('S', 'T'), count()),
    traversal(V('a'), out('S', 'T')),
  ],
  [
    'out, a label with no edges',
    traversal(V('a'), out('ZZ'), count()),
    traversal(V('a'), out('ZZ')),
  ],
  // ⚠️ EVERY DIRECTION OF THE UNTYPED HOP, not just `out()`. A mutant that made the INWARD helper
  // answer 0 for an untyped hop instead of declining SURVIVED the first version of this file,
  // because `out()` exercises only the outward helper — so `V(id).in_().count()` would have
  // answered 0. One case per helper arm.
  ['out, UNTYPED', traversal(V('a'), out(), count()), traversal(V('a'), out())],
  ['in, UNTYPED', traversal(V('a'), in_(), count()), traversal(V('a'), in_())],
  ['both, UNTYPED', traversal(V('a'), both(), count()), traversal(V('a'), both())],
  ['outE, UNTYPED', traversal(V('a'), outE(), count()), traversal(V('a'), outE())],
  ['inE, UNTYPED', traversal(V('a'), inE(), count()), traversal(V('a'), inE())],
  ['bothE, UNTYPED', traversal(V('a'), bothE(), count()), traversal(V('a'), bothE())],
  ['in, one label', traversal(V('a'), in_('U'), count()), traversal(V('a'), in_('U'))],
  ['in, the self-loop label', traversal(V('a'), in_('T'), count()), traversal(V('a'), in_('T'))],
  // ⚠️ `both` sees the self-loop TWICE: one edge from its source and one from its target.
  [
    'both, the self-loop label',
    traversal(V('a'), both('T'), count()),
    traversal(V('a'), both('T')),
  ],
  [
    'both, two labels',
    traversal(V('a'), both('T', 'U'), count()),
    traversal(V('a'), both('T', 'U')),
  ],
  ['outE', traversal(V('a'), outE('T'), count()), traversal(V('a'), outE('T'))],
  ['inE', traversal(V('a'), inE('U'), count()), traversal(V('a'), inE('U'))],
  ['bothE', traversal(V('a'), bothE('T'), count()), traversal(V('a'), bothE('T'))],
  ['a hop from a MISSING id', traversal(V('zz'), out('T'), count()), traversal(V('zz'), out('T'))],
  [
    'a hop from several ids incl. a duplicate',
    traversal(V('a', 'a', 'b'), out('T'), count()),
    traversal(V('a', 'a', 'b'), out('T')),
  ],
  [
    'a hop from an isolated vertex',
    traversal(V('d'), out('T'), count()),
    traversal(V('d'), out('T')),
  ],

  // Shapes the rung must DECLINE and the general path must still answer.
  [
    'a filter after the seed',
    traversal(V('a', 'b'), has('k', 'a'), count()),
    traversal(V('a', 'b'), has('k', 'a')),
  ],
  [
    'TWO hops',
    traversal(V('a'), out('T'), out('T'), count()),
    traversal(V('a'), out('T'), out('T')),
  ],
  [
    'a filter after a hop',
    traversal(V('a'), out('T'), has('k', 'b'), count()),
    traversal(V('a'), out('T'), has('k', 'b')),
  ],

  // THE OTHER SPELLING. `hasId` is a FILTER over the element set, so its multiplicity differs from
  // the seeded source's — asserted explicitly in `the two spellings are NOT the same question`.
  ['hasId, one id', traversal(V(), hasId('a'), count()), traversal(V(), hasId('a'))],
  ['hasId, missing', traversal(V(), hasId('zz'), count()), traversal(V(), hasId('zz'))],
  [
    'hasId, several',
    traversal(V(), hasId('a', 'b', 'c'), count()),
    traversal(V(), hasId('a', 'b', 'c')),
  ],
  ['hasId, a duplicate', traversal(V(), hasId('a', 'a'), count()), traversal(V(), hasId('a', 'a'))],
  [
    'hasId, one missing',
    traversal(V(), hasId('a', 'zz'), count()),
    traversal(V(), hasId('a', 'zz')),
  ],
  ['hasId, a NUMBER', traversal(V(), hasId(5), count()), traversal(V(), hasId(5))],
  [
    'hasId, a number among strings',
    traversal(V(), hasId('a', 5), count()),
    traversal(V(), hasId('a', 5)),
  ],
  ['hasId on EDGES', traversal(E(), hasId('e1', 'e2'), count()), traversal(E(), hasId('e1', 'e2'))],
  [
    'hasId on edges, a duplicate',
    traversal(E(), hasId('e1', 'e1'), count()),
    traversal(E(), hasId('e1', 'e1')),
  ],

  // `hasId` + ONE HOP, the other spelling of the seeded hop above.
  [
    'hasId + hop',
    traversal(V(), hasId('a'), out('T'), count()),
    traversal(V(), hasId('a'), out('T')),
  ],
  [
    'hasId + hop, several ids',
    traversal(V(), hasId('a', 'b'), out('T'), count()),
    traversal(V(), hasId('a', 'b'), out('T')),
  ],
  [
    'hasId + hop, a DUPLICATE id',
    traversal(V(), hasId('a', 'a'), out('T'), count()),
    traversal(V(), hasId('a', 'a'), out('T')),
  ],
  [
    'hasId + hop, a missing id',
    traversal(V(), hasId('a', 'zz'), out('T'), count()),
    traversal(V(), hasId('a', 'zz'), out('T')),
  ],
  [
    'hasId + hop, two labels incl. a multi-label edge',
    traversal(V(), hasId('a'), out('T', 'S'), count()),
    traversal(V(), hasId('a'), out('T', 'S')),
  ],
  [
    'hasId + both, the self-loop label',
    traversal(V(), hasId('a'), both('T'), count()),
    traversal(V(), hasId('a'), both('T')),
  ],
  [
    'hasId + an UNTYPED hop',
    traversal(V(), hasId('a'), out(), count()),
    traversal(V(), hasId('a'), out()),
  ],
  [
    'hasId + an untyped hop, NO id resolving',
    traversal(V(), hasId('zz'), out(), count()),
    traversal(V(), hasId('zz'), out()),
  ],
  [
    'hasId + hop, a NUMBER id',
    traversal(V(), hasId(5), out('T'), count()),
    traversal(V(), hasId(5), out('T')),
  ],

  // ⚠️ A TRAILING FILTER AFTER A `hasId` HOP. A mutant that widened the `hasId` arm from two mid
  // steps to three SURVIVED without this: `[hasId, out, has]` would have been answered as
  // `[hasId, out]`, silently dropping the filter and over-counting. The seeded twin was covered and
  // the `hasId` spelling was not.
  [
    'hasId + hop + a filter',
    traversal(V(), hasId('a'), out('T'), has('k', 'b'), count()),
    traversal(V(), hasId('a'), out('T'), has('k', 'b')),
  ],
  [
    'hasId + a filter + a hop',
    traversal(V(), hasId('a', 'b'), has('k', 'a'), out('T'), count()),
    traversal(V(), hasId('a', 'b'), has('k', 'a'), out('T')),
  ],
  [
    'hasId + TWO hops',
    traversal(V(), hasId('a'), out('T'), out('T'), count()),
    traversal(V(), hasId('a'), out('T'), out('T')),
  ],

  ['an edge id', traversal(E('e1'), count()), traversal(E('e1'))],
  ['edge ids, one missing', traversal(E('e1', 'zz'), count()), traversal(E('e1', 'zz'))],
  ['a duplicate edge id', traversal(E('e1', 'e1'), count()), traversal(E('e1', 'e1'))],
];

describe('⚠️ the seeded count agrees with the walk it replaces', () => {
  for (const [label, counted, streamed] of CASES) {
    test(label, () => {
      const viaWalk = toArray(streamed, g).length;
      const viaCount = toArray(counted, g);

      expect(viaCount, `${label}: count() must be the walk's length (${viaWalk})`).toEqual([
        viaWalk,
      ]);
    });
  }
});

describe('⚠️ the rung is actually TAKEN, and declines where it should', () => {
  /**
   * ⚠️ WITHOUT THIS THE WHOLE FILE CAN PASS VACUOUSLY. A route choice is answer-equivalent, so
   * every test above stays green if the rung is never reached — and `rung-precedence-decides-speed`
   * records that a WILLING rung starved by a broader one above it in the chain looks exactly like a
   * rung that works. `countShortcut` returning a number IS the route.
   */
  for (const [label, plan] of [
    ['one id', traversal(V('a'), count())],
    ['a missing id', traversal(V('zz'), count())],
    ['a duplicate id', traversal(V('a', 'a'), count())],
    ['out, one label', traversal(V('a'), out('T'), count())],
    ['out, two labels', traversal(V('a'), out('T', 'S'), count())],
    ['hasId, one id', traversal(V(), hasId('a'), count())],
    ['hasId, several', traversal(V(), hasId('a', 'b'), count())],
    ['hasId on EDGES', traversal(E(), hasId('e1'), count())],
    ['hasId + hop', traversal(V(), hasId('a'), out('T'), count())],
    ['hasId + hop, a duplicate', traversal(V(), hasId('a', 'a'), out('T'), count())],
    ['both', traversal(V('a'), both('T'), count())],
    ['outE', traversal(V('a'), outE('T'), count())],
    ['an edge id', traversal(E('e1'), count())],
  ] as const) {
    test(`TAKES ${label}`, () => {
      expect(countShortcut(plan, g), label).toBeTypeOf('number');
    });
  }

  for (const [label, plan] of [
    ['an UNTYPED out', traversal(V('a'), out(), count())],
    ['hasId + an UNTYPED hop', traversal(V(), hasId('a'), out(), count())],
    // ⚠️ THE ROUTE MUST NOT DEPEND ON THE DATA. Nothing resolves here, so an eligibility test made
    // per resolving id would never run and the rung would answer 0 — right by luck, for a query it
    // declines when an id does resolve.
    ['hasId + an untyped hop, NO id resolving', traversal(V(), hasId('zz'), out(), count())],
    ['a seeded UNTYPED hop, NO id resolving', traversal(V('zz'), out(), count())],
    ['an UNTYPED in', traversal(V('a'), in_(), count())],
    ['an UNTYPED both', traversal(V('a'), both(), count())],
    ['an UNTYPED outE', traversal(V('a'), outE(), count())],
    ['an UNTYPED inE', traversal(V('a'), inE(), count())],
    ['an UNTYPED bothE', traversal(V('a'), bothE(), count())],
    ['a filter after the seed', traversal(V('a', 'b'), has('k', 'a'), count())],
    ['TWO hops', traversal(V('a'), out('T'), out('T'), count())],
    ['a filter after a hop', traversal(V('a'), out('T'), has('k', 'b'), count())],
    ['hasId + hop + a filter', traversal(V(), hasId('a'), out('T'), has('k', 'b'), count())],
    ['hasId + a filter + a hop', traversal(V(), hasId('a', 'b'), has('k', 'a'), out('T'), count())],
    ['a hop from an EDGE source', traversal(E('e1'), inV(), count())],
  ] as const) {
    test(`DECLINES ${label}`, () => {
      expect(countShortcut(plan, g), label).toBeUndefined();
    });
  }

  test('and the whole-graph source still reaches its own rungs', () => {
    expect(countShortcut(traversal(V(), count()), g)).toBe(4);
    expect(countShortcut(traversal(V(), out('T'), count()), g)).toBeTypeOf('number');
  });
});

describe('the arithmetic is pinned, not only self-consistent', () => {
  /**
   * ⚠️ A SELF-CONSISTENT PAIR CAN BOTH BE WRONG. The table above would pass if the walk itself were
   * broken, so these few assert the numbers the fixture was BUILT to produce — and the three that
   * matter are the ones a naive implementation gets wrong.
   */
  test('a multi-label edge is counted ONCE across two labels', () => {
    // `a` has e1, e2 (T, parallel), e3 (T+S) and e4 (T self-loop) going out = 4 T edges.
    expect(toArray(traversal(V('a'), out('T'), count()), g)).toEqual([4]);
    // Adding S must add NOTHING, because the only S edge is e3, already counted as a T.
    expect(toArray(traversal(V('a'), out('T', 'S'), count()), g)).toEqual([4]);
    // And S alone is just e3.
    expect(toArray(traversal(V('a'), out('S'), count()), g)).toEqual([1]);
  });

  test('a self-loop is counted twice by both() and once by each direction', () => {
    // Out: e1, e2, e3, e4 = 4. In: just e4 (the loop). Both: 5.
    expect(toArray(traversal(V('a'), out('T'), count()), g)).toEqual([4]);
    expect(toArray(traversal(V('a'), in_('T'), count()), g)).toEqual([1]);
    expect(toArray(traversal(V('a'), both('T'), count()), g)).toEqual([5]);
  });

  test('parallel edges count separately and a duplicate id counts twice', () => {
    expect(toArray(traversal(V('a', 'a'), count()), g)).toEqual([2]);
    expect(toArray(traversal(V('a', 'a'), out('T'), count()), g)).toEqual([8]);
  });
});

describe('⚠️ the two spellings are NOT the same question', () => {
  /**
   * ⚠️ ITEM 1306'S FINDING, PINNED. `V(ids)` walks the id LIST, so a duplicate id yields two
   * traversers; `hasId(ids)` FILTERS the element set, so each element is tested once. The two rungs
   * must therefore disagree here — a single shared implementation would be a wrong answer for one
   * of them, and it is the reason `hasId(ids)` is not rewritten to `V(ids)` wholesale.
   */
  test('a duplicate id counts twice when seeded and once when filtered', () => {
    expect(toArray(traversal(V('a', 'a'), count()), g)).toEqual([2]);
    expect(toArray(traversal(V(), hasId('a', 'a'), count()), g)).toEqual([1]);
  });

  test('and the same asymmetry survives a hop', () => {
    // `a` has 4 outgoing T edges, so seeded-with-a-duplicate is 8 and filtered is 4.
    expect(toArray(traversal(V('a', 'a'), out('T'), count()), g)).toEqual([8]);
    expect(toArray(traversal(V(), hasId('a', 'a'), out('T'), count()), g)).toEqual([4]);
  });

  test('a non-string id RAISES when seeded and matches nothing when filtered', () => {
    expect(() => toArray(traversal(V(5), count()), g)).toThrow();
    expect(toArray(traversal(V(), hasId(5), count()), g)).toEqual([0]);
  });
});

describe('⚠️ it RAISES where the general path raises', () => {
  /**
   * Element ids are strings in this engine and a numeric literal is a type error at resolution, not
   * a coercion (`asStringId`, matching TinkerPop's string id manager). A rung that resolved ids
   * itself would ANSWER here — which is item 1306's and item 1643's bug, twice shipped.
   */
  for (const [label, plan] of [
    ['a numeric vertex id', traversal(V(5), count())],
    ['a numeric vertex id before a hop', traversal(V(5), out('T'), count())],
    ['a numeric edge id', traversal(E(5), count())],
    ['a numeric id among strings', traversal(V('a', 5), count())],
  ] as const) {
    test(label, () => {
      expect(() => toArray(plan, g), `${label}: call 1`).toThrow();
      // And again, since items 1647/1648 cache per-plan verdicts nearby.
      expect(() => toArray(plan, g), `${label}: call 2`).toThrow();
    });
  }
});
