/**
 * Item 1302: a far-end `hasLabel` after a vertex hop — `V().out(T).hasLabel(X).count()`.
 *
 * The START side of a hop has always admitted `hasLabel` (`collectVertexFilters`); the FAR side's
 * two readers (`hasChain`, `collectHasFilters`) admitted only `has`. So moving the label test
 * across the hop — the same kind of test, one position different — fell off every rung onto the
 * general traversal. Measured at 200,000 vertices / 200,000 `T` edges, min of three rounds:
 *
 *   V().out(T).has(age, gt(44)).count()     90.13 ns/v   served, and AT the hand-written floor
 *   V().out(T).hasLabel(E).count()         612.45        declined every rung       6.40x
 *   hand-written loop, the same work       119.70        the floor                 5.12x off
 *
 * A count shortcut is ANSWER-PRESERVING by design, so the tests that matter assert the DECISION:
 * `countShortcut` returns a number for each shape it now claims, and `undefined` where it must
 * still decline. A mutant that never claims the shape passes every row assertion in the package —
 * item 1289 had two such mutants survive until the route was asserted explicitly.
 *
 * THE SECOND ORACLE is a forced `identity()` decline, this suite's idiom: a step the rung cannot
 * absorb, so the same question runs down the general path and the two must agree. (Item 930: a
 * decline forced with a shape the optimizer may LATER learn fails silently, green, comparing one
 * route to itself — `identity()` is the one step chosen because nothing will absorb it.)
 *
 * ⚠️ EVERY LABEL USED AS A FILTER HERE IS NON-VACUOUS, and that is load-bearing.
 * `dropVacuousLabels` (item 540) deletes a `hasLabel` whose bucket holds every live element, so a
 * fixture where every vertex carries `P` would silently test the BARE plan and report success for a
 * rung that was never reached. This cost a measurement earlier in this item: the start-filtered arm
 * was timed with `hasLabel('Person')` on a fixture where every vertex was a `Person`, and the two
 * arms agreeing to within 3% was the giveaway.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { countShortcut } from './executor/count-shortcut.js';
import {
  E,
  V,
  both,
  count,
  dedupe,
  gt,
  has,
  hasLabel,
  identity,
  in_,
  out,
  outE,
  toArray,
  traversal,
  values,
} from './index.js';

/**
 * `a(P)`, `b(P,E)`, `c(E)`, `d(Q)`, plus `iso(P,E)` with no edges at all.
 *
 * `T` edges: `a->b`, `a->c`, `b->c`, `c->d`, and a SELF-LOOP `a->a`. One `S` edge `b->d`, so a
 * multi-type hop has something to name and `S` is not vacuous either.
 *
 * No label is carried by every vertex (`P` misses `c`/`d`, `E` misses `a`/`d`, `Q` only `d`), so
 * `dropVacuousLabels` removes nothing and every assertion below reaches the rung it means to.
 */
const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P', 'E'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['E'], properties: { k: 3 } });
  const d = g.addVertex({ id: 'd', labels: ['Q'], properties: { k: 4 } });

  g.addVertex({ id: 'iso', labels: ['P', 'E'], properties: { k: 5 } });

  g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
  g.addEdge({ id: 'e2', labels: ['T'], from: a, to: c, properties: {} });
  g.addEdge({ id: 'e3', labels: ['T'], from: b, to: c, properties: {} });
  g.addEdge({ id: 'e4', labels: ['T'], from: c, to: d, properties: {} });
  g.addEdge({ id: 'e5', labels: ['T'], from: a, to: a, properties: {} });
  g.addEdge({ id: 's1', labels: ['S'], from: b, to: d, properties: {} });

  return g;
};

/**
 * A fixture reaching `filteredHopCount`'s EDGE-DRIVEN arm, which the one above cannot.
 *
 * That arm needs `hop.labels.length !== 1 && multiTypeEdgeCount !== 0` to get past the far-driven
 * arm, and then `bucketsFor` declines a MULTI-type hop whenever a two-type edge exists — so the
 * only reachable combination is an UNTYPED hop (`out()`) on a graph carrying at least one
 * multi-label edge. Found by mutation: a mutant deleting that arm's label test SURVIVED all 948
 * tests, because nothing in the suite had a two-type edge.
 *
 * Edges also carry `w`, so the EDGE-hop rung can be exercised with a non-empty `has` chain — the
 * shape that makes a widened `hasChain` observable. With a single `hasLabel` and nothing else,
 * `hasChain` returns `undefined` for an empty filter list either way, so that mutant was invisible.
 */
const buildMulti = (): Graph => {
  const g = new Graph();
  const x = g.addVertex({ id: 'x', labels: ['P'], properties: { k: 1 } });
  const y = g.addVertex({ id: 'y', labels: ['E'], properties: { k: 2 } });
  const z = g.addVertex({ id: 'z', labels: ['Q'], properties: { k: 3 } });

  g.addEdge({ id: 'm1', labels: ['T', 'S'], from: x, to: y, properties: { w: 1 } });
  g.addEdge({ id: 't1', labels: ['T'], from: x, to: z, properties: { w: 2 } });
  g.addEdge({ id: 's1', labels: ['S'], from: y, to: z, properties: { w: 3 } });

  // AN EDGE INDEX, because `edgeHopSeededCount` returns `undefined` at `if (!best)` when no
  // filter is seekable — so without one the EDGE-hop rung is never reached and a widened
  // `hasChain` cannot be observed at all. Found by mutation: the `haschain-widened-to-labels`
  // mutant survived twice, first for the empty-chain reason and then for this one.
  //
  // HASH, with an EQUALITY predicate to match: a hash index cannot serve `gt`, so a range
  // predicate would leave `best` null and put the decline back.
  g.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });

  return g;
};

const g = build();
const n = (...steps: readonly unknown[]): number =>
  toArray(traversal(...(steps as never[])), g)[0] as number;

/** The rung's answer and the general path's, which must be the same number. */
const both_ = (...steps: readonly unknown[]): [number | undefined, number] => [
  countShortcut(traversal(...(steps as never[]), count()), g),
  n(...steps, identity(), count()),
];

describe('the decision: the far-end label shapes are claimed', () => {
  test('out: `V().out(T).hasLabel(E).count()` is claimed', () => {
    // `T` far ends in edge order: b(P,E) yes, c(E) yes, c(E) yes, d(Q) no, a(P) no  => 3
    expect(countShortcut(traversal(V(), out('T'), hasLabel('E'), count()), g)).toBe(3);
    expect(n(V(), out('T'), hasLabel('E'), count())).toBe(3);
  });

  test('in: the far end of an `in` hop is the SOURCE of the edge', () => {
    // Sources of `T` edges: a(P), a(P), b(P,E), c(E), a(P). `E` keeps b and c => 2
    expect(countShortcut(traversal(V(), in_('T'), hasLabel('E'), count()), g)).toBe(2);
  });

  test('both: `out` plus `in`, with the self-loop counted TWICE', () => {
    // `both` is out+in exactly (item 1087), so this is 3 + 2 = 5. The self-loop on `a` is incident
    // twice and `a` is not an `E`, so it contributes 0 to either arm — a fixture where the loop
    // vertex carried the label would be the sharper test, and `hasLabel('P')` below is it.
    expect(countShortcut(traversal(V(), both('T'), hasLabel('E'), count()), g)).toBe(5);
    // `P` far ends: out => b, a(loop) = 2; in => a, a, b, a = 4 (c is not P). Total 6, and the
    // loop is one of the out hits and one of the in hits.
    expect(countShortcut(traversal(V(), both('T'), hasLabel('P'), count()), g)).toBe(6);
  });

  test('a label test MIXED with a has chain, in either order', () => {
    // `E` far ends of `T` are b(k=2), c(k=3), c(k=3); `k > 2` keeps the two c's => 2
    expect(
      countShortcut(traversal(V(), out('T'), hasLabel('E'), has('k', gt(2)), count()), g),
    ).toBe(2);
    // The SAME question with the two steps swapped. Equivalent spellings must not differ — and
    // because the rung splits the chain into two groups, written order is not preserved, so this
    // asserts the regrouping is sound rather than that it is a no-op.
    expect(
      countShortcut(traversal(V(), out('T'), has('k', gt(2)), hasLabel('E'), count()), g),
    ).toBe(2);
  });

  test('TWO `hasLabel` steps are ANDed, and a multi-label one is an OR', () => {
    // b is the only `T` far end carrying BOTH P and E.
    expect(countShortcut(traversal(V(), out('T'), hasLabel('P'), hasLabel('E'), count()), g)).toBe(
      1,
    );
    // `hasLabel(E, Q)` is a union: b, c, c (E) plus d (Q) => 4
    expect(countShortcut(traversal(V(), out('T'), hasLabel('E', 'Q'), count()), g)).toBe(4);
  });

  test('the BOTH-SIDES rung takes it too, with a NON-VACUOUS start label', () => {
    // `hasLabel('P')` keeps a, b, iso. Their `T` out-edges: a->b, a->c, a->a, b->c. Far ends
    // b(E) yes, c(E) yes, a no, c(E) yes => 3.
    expect(countShortcut(traversal(V(), hasLabel('P'), out('T'), hasLabel('E'), count()), g)).toBe(
      3,
    );
    // And with a far `has` as well, which is the shape `tallyFarEnds` serves.
    expect(
      countShortcut(
        traversal(V(), hasLabel('P'), out('T'), hasLabel('E'), has('k', gt(2)), count()),
        g,
      ),
    ).toBe(2);
  });

  test('an UNTYPED hop, and a MULTI-TYPE hop', () => {
    // Untyped `out()`: every out-edge. Far ends b,c,c,d,a plus S's d => `E` keeps b,c,c = 3
    expect(countShortcut(traversal(V(), out(), hasLabel('E'), count()), g)).toBe(3);
    // `out('T','S')` names two types and no edge here carries both, so the far-driven arm serves
    // it: T gives b,c,c,d,a and S gives d => `E` keeps 3.
    expect(countShortcut(traversal(V(), out('T', 'S'), hasLabel('E'), count()), g)).toBe(3);
  });
});

describe('the ORACLE: the rung and the general path agree', () => {
  const shapes: readonly (readonly unknown[])[] = [
    [V(), out('T'), hasLabel('E')],
    [V(), out('T'), hasLabel('P')],
    [V(), out('T'), hasLabel('Q')],
    [V(), in_('T'), hasLabel('E')],
    [V(), both('T'), hasLabel('E')],
    [V(), both('T'), hasLabel('P')],
    [V(), out('T'), hasLabel('E'), has('k', gt(2))],
    [V(), out('T'), has('k', gt(2)), hasLabel('E')],
    [V(), out('T'), hasLabel('P'), hasLabel('E')],
    [V(), out('T'), hasLabel('E', 'Q')],
    [V(), hasLabel('P'), out('T'), hasLabel('E')],
    [V(), hasLabel('P'), out('T'), hasLabel('E'), has('k', gt(2))],
    [V(), out(), hasLabel('E')],
    [V(), out('T', 'S'), hasLabel('E')],
    // A label NOTHING carries, and one EVERY far end carries — the two ends of the range.
    [V(), out('T'), hasLabel('NOSUCH')],
    [V(), in_('T'), hasLabel('P')],
  ];

  test('every shape: the rung claims it AND matches the forced decline', () => {
    for (const steps of shapes) {
      const [fast, slow] = both_(...steps);

      // Claimed — without this the oracle compares the general path with itself and passes for a
      // rung that was never reached.
      expect(fast).toBeDefined();
      expect(fast).toBe(slow);
    }
  });
});

describe('the EDGE-DRIVEN arm, reachable only with a two-type edge', () => {
  const gm = buildMulti();
  const nm = (...steps: readonly unknown[]): number =>
    toArray(traversal(...(steps as never[])), gm)[0] as number;

  test('an UNTYPED hop on a graph with a multi-label edge takes the edge-driven arm', () => {
    // `multiTypeEdgeCount` is 1 (`m1` carries T and S), so `out()` cannot use the far-driven arm.
    expect(gm.multiTypeEdgeCount).toBe(1);

    // Out-edges: m1 -> y(E), t1 -> z(Q), s1 -> z(Q). `E` keeps m1 alone => 1.
    expect(countShortcut(traversal(V(), out(), hasLabel('E'), count()), gm)).toBe(1);
    expect(nm(V(), out(), hasLabel('E'), identity(), count())).toBe(1);

    // With a far `has` as well, and the two steps in both orders.
    expect(countShortcut(traversal(V(), out(), hasLabel('E'), has('k', gt(1)), count()), gm)).toBe(
      1,
    );
    expect(countShortcut(traversal(V(), out(), has('k', gt(1)), hasLabel('E'), count()), gm)).toBe(
      1,
    );
    // `Q` far ends: t1 and s1 both land on z => 2.
    expect(countShortcut(traversal(V(), out(), hasLabel('Q'), count()), gm)).toBe(2);
    expect(nm(V(), out(), hasLabel('Q'), identity(), count())).toBe(2);
  });

  test('a MULTI-type hop still DECLINES here, so no edge is counted twice', () => {
    // `bucketsFor` refuses `out(T, S)` while a two-type edge exists, because m1 sits in both
    // buckets and the walk would yield it twice. The general path answers, and the rung must not.
    expect(
      countShortcut(traversal(V(), out('T', 'S'), hasLabel('E'), count()), gm),
    ).toBeUndefined();
    // THE WALK YIELDS A TWO-TYPE EDGE ONCE — which is the whole reason the rung must decline, and
    // it is `bucketsFor`'s own stated reason ("summing across types would visit it twice while the
    // walk yields it once"). So m1 contributes ONE traversal, landing on y(E), and s1 -> z(Q) is
    // rejected: the answer is 1. A rung that summed the T and S buckets would answer 2.
    expect(nm(V(), out('T', 'S'), hasLabel('E'), count())).toBe(1);
    expect(nm(V(), out('T', 'S'), hasLabel('E'), identity(), count())).toBe(1);
  });

  test('⚠️ the EDGE-hop rung with a non-empty has chain refuses a vertex label', () => {
    // THE SHAPE THAT MAKES A WIDENED `hasChain` OBSERVABLE, and it needs all three of: a non-empty
    // `has` chain (an empty one declines on `filters.length === 0`), an EDGE INDEX (no seekable
    // filter declines at `if (!best)`), and an EQUALITY predicate the hash index can serve.
    //
    // No edge here is labelled `E`, so the honest answer is 0. A reader that silently dropped the
    // `hasLabel` would answer 1 — m1, the one `T` edge with `w === 1`.
    expect(nm(V(), outE('T'), hasLabel('E'), has('w', 1), count())).toBe(0);
    expect(nm(V(), outE('T'), hasLabel('E'), has('w', 1), identity(), count())).toBe(0);
    // THE CONTROL that proves the rung is reached at all: the edge's OWN label passes, and m1 is
    // the `T` edge with `w === 1`. If this were 0 the assertion above would be vacuous.
    expect(nm(V(), outE('T'), hasLabel('T'), has('w', 1), count())).toBe(1);
  });
});

describe('the declines that must survive', () => {
  test('⚠️ `hasLabel` after an EDGE hop is the EDGE label, not the far vertex', () => {
    // THE DANGEROUS CASE, and the reason `hasChain` was not simply widened. After `outE`, the
    // frontier is EDGES, so `hasLabel('T')` tests the edge's own label — all five `T` edges pass.
    // If this were absorbed as a far-VERTEX label test it would ask whether each edge's target is
    // labelled `T`, which nothing is, and answer 0.
    expect(n(V(), outE('T'), hasLabel('T'), count())).toBe(5);
    // And a vertex label used as an edge label matches nothing, where a far-vertex reading of it
    // would answer 3.
    expect(n(V(), outE('T'), hasLabel('E'), count())).toBe(0);
    // The oracle agrees, so neither number is this engine talking to itself.
    expect(n(V(), outE('T'), hasLabel('T'), identity(), count())).toBe(5);
    expect(n(V(), outE('T'), hasLabel('E'), identity(), count())).toBe(0);
  });

  test('`[hop, dedupe]` still reaches the distinct-endpoint rung', () => {
    // `farFilters` returns undefined for an empty chain, which is what lets `dedupe` fall through
    // to `distinctHopCount`. Distinct `T` targets: b, c, d, a => 4.
    expect(countShortcut(traversal(V(), out('T'), dedupe(), count()), g)).toBe(4);
  });

  test('`values(k)` must be LAST: a `hasLabel` after it declines', () => {
    // `values(k)` emits SCALARS, so a label test on them is a different question. `farFilters`
    // carries `hasChain`'s rule verbatim and must refuse this.
    expect(
      countShortcut(traversal(V(), out('T'), values('k'), hasLabel('E'), count()), g),
    ).toBeUndefined();
    // The trailing form is still absorbed as a presence filter (item 1141): all five far ends of
    // `T` carry `k`.
    expect(countShortcut(traversal(V(), out('T'), values('k'), count()), g)).toBe(5);
  });

  test('a bare `E()` source is untouched', () => {
    expect(n(E(), hasLabel('T'), count())).toBe(5);
  });
});

describe('the zero-label form answers the same on both routes', () => {
  test('`hasLabel()` keeps nothing, and the general path says so too', () => {
    // `some` over an empty list is false, so a vacuous-in-the-other-direction `hasLabel()` keeps
    // NOTHING. This is not a choice made in the rung: it is what the start side has always done
    // and what the general path does. Asserted as an AGREEMENT rather than as a number, so the
    // day the surface decides otherwise this test moves with it.
    const fast = countShortcut(traversal(V(), out('T'), hasLabel(), count()), g);
    const slow = n(V(), out('T'), hasLabel(), identity(), count());

    expect(fast).toBeDefined();
    expect(fast).toBe(slow);
  });
});
