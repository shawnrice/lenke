/**
 * Item 1091: a hop CHAIN containing `both` — `V().both(T).both(T).count()` and deeper.
 *
 * `hopChainCount`'s `HopStep` excluded `both` "for the self-loop reason the rungs above give",
 * which item 1087 refuted. The chain had no rung at all, so it enumerated:
 *
 *   both.both       6265.95 ms (declined) -> 81.35    77.0x   20,000,000 paths
 *   both.both.both  47,842.02             -> 697.18   68.6x  200,000,000 paths
 *
 * TINKERPOP 3.7.3 IS THE ORACLE for the arithmetic, on `a->b`, `b->c` and a SELF-LOOP on `a`:
 *
 *   both 6   both.both 14   both.both.both 34   P both.both 12   both.out 8   out.both 6
 *
 * Every number below was printed by that console run, not derived. The MIXED pair matters most:
 * `both.out` is 8 and `out.both` is 6, so a symmetric implementation gets one of them wrong, and
 * a `both` hop's arrival and departure factors coinciding is the thing that makes them differ.
 *
 * THE SECOND ORACLE is a forced `identity()` decline — a step the rung cannot absorb, which is
 * this suite's idiom (item 930: forcing a decline with a shape the optimizer may later learn fails
 * SILENTLY, green, comparing one route to itself).
 *
 * WHY `bothChainCount` IS A SEPARATE FUNCTION, since a test is where someone will look before
 * merging the two: folding `both` into the shared arms was built and measured, and the `out.out`
 * CONTROL regressed **46.76 -> 72.19 ms (1.54x)** while the target improved 75x. Split, the
 * control reads 46.64. Items 159 and 1033 measured the same effect in this file before.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  both,
  count,
  gt,
  has,
  hasLabel,
  identity,
  in_,
  out,
  toArray,
  traversal,
} from './index.js';

const n = (g: Graph, ...steps: readonly unknown[]): number =>
  toArray(traversal(...(steps as never[])), g)[0] as number;

/** The TinkerPop fixture: `a->b`, `b->c`, and a SELF-LOOP on `a`. `a`,`b` are P; `c` is Q. */
const console3 = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
  g.addEdge({ id: 'e2', labels: ['T'], from: b, to: c, properties: {} });
  g.addEdge({ id: 'e3', labels: ['T'], from: a, to: a, properties: {} });

  return g;
};

describe('the TinkerPop console run for both chains', () => {
  test('both.both is 14 and both.both.both is 34', () => {
    const g = console3();

    expect(n(g, V(), both('T'), both('T'), count())).toBe(14);
    expect(n(g, V(), both('T'), both('T'), both('T'), count())).toBe(34);
  });

  test('THE MIXED PAIR: both.out is 8 and out.both is 6', () => {
    // The asymmetry is the whole content of the arithmetic. A `both` hop's arrival degree equals
    // its departure degree, while an `out` hop arrives along in-edges and departs along out-edges
    // — so which position the `both` occupies changes the answer.
    const g = console3();

    expect(n(g, V(), both('T'), out('T'), count())).toBe(8);
    expect(n(g, V(), out('T'), both('T'), count())).toBe(6);
    expect(n(g, V(), both('T'), in_('T'), count())).toBe(
      n(g, V(), both('T'), in_('T'), identity(), count()),
    );
    expect(n(g, V(), in_('T'), both('T'), count())).toBe(
      n(g, V(), in_('T'), both('T'), identity(), count()),
    );
  });

  test('a LABEL on the start, both halves of the partition', () => {
    const g = console3();

    expect(n(g, V(), hasLabel('P'), both('T'), both('T'), count())).toBe(12);
    expect(n(g, V(), hasLabel('Q'), both('T'), both('T'), count())).toBe(2);
    // 12 + 2 = 14, the unlabelled total — so the partition is exhaustive and neither half is
    // silently dropping the self-loop's second traversal.
    expect(12 + 2).toBe(14);
  });

  test('the out/in chains are UNCHANGED by the new routing', () => {
    const g = console3();

    expect(n(g, V(), out('T'), out('T'), count())).toBe(3);
    expect(n(g, V(), in_('T'), in_('T'), count())).toBe(3);
    expect(n(g, V(), out('T'), out('T'), out('T'), count())).toBe(
      n(g, V(), out('T'), out('T'), out('T'), identity(), count()),
    );
  });
});

describe('every both chain agrees with its forced decline', () => {
  test('across depth, direction mix and start filters', () => {
    const g = console3();
    const pairs: ReadonlyArray<readonly [number, number]> = [
      [
        n(g, V(), both('T'), both('T'), count()),
        n(g, V(), both('T'), both('T'), identity(), count()),
      ],
      [
        n(g, V(), both('T'), both('T'), both('T'), count()),
        n(g, V(), both('T'), both('T'), both('T'), identity(), count()),
      ],
      [
        n(g, V(), both('T'), both('T'), both('T'), both('T'), count()),
        n(g, V(), both('T'), both('T'), both('T'), both('T'), identity(), count()),
      ],
      [
        n(g, V(), hasLabel('P'), both('T'), both('T'), count()),
        n(g, V(), hasLabel('P'), both('T'), both('T'), identity(), count()),
      ],
      [
        n(g, V(), has('k', gt(1)), both('T'), both('T'), count()),
        n(g, V(), has('k', gt(1)), both('T'), both('T'), identity(), count()),
      ],
      [
        n(g, V(), both('T'), out('T'), both('T'), count()),
        n(g, V(), both('T'), out('T'), both('T'), identity(), count()),
      ],
    ];

    for (const [fast, slow] of pairs) {
      expect(fast).toBe(slow);
    }

    expect(pairs).toHaveLength(6);
  });

  test('a graph with NO self-loop, so the loop is not carrying the tests', () => {
    // Every case above has a self-loop, which is the interesting part — but a rung that only
    // worked on looped graphs would pass all of them. This is the control for that.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'e2', labels: ['T'], from: b, to: c, properties: {} });

    // both-degrees are a:1, b:2, c:1 → 1*1 + 2*2 + 1*1 = 6.
    expect(n(g, V(), both('T'), both('T'), count())).toBe(6);
    expect(n(g, V(), both('T'), both('T'), identity(), count())).toBe(6);
    expect(n(g, V(), both('T'), both('T'), both('T'), count())).toBe(
      n(g, V(), both('T'), both('T'), both('T'), identity(), count()),
    );
  });
});

describe('an out/in hop inside the WALK path, which mutation found uncovered', () => {
  // TWO MUTANTS SURVIVED until this block existed — `walk-in-takes-adjfrom` (an `in` hop reading
  // the out-box during propagation) and `lasthop-reversed` (the last hop's degree taken from the
  // wrong side). Both need an `out`/`in` hop in a chain that reaches the MULTIPLICITY WALK, and
  // every mixed case above is a 2-hop unfiltered chain, which takes the inner product instead.
  //
  // A `both` last hop cannot catch `lasthop-reversed` either: its arrival and departure degrees
  // coincide, so reversing it is a no-op. The last hop has to be `out` or `in`.
  const mixed = (g: Graph, ...steps: readonly unknown[]): void => {
    // The oracle is the forced decline, so no literal here was worked out by hand.
    const fast = n(g, ...steps, count());
    const slow = n(g, ...steps, identity(), count());

    expect(fast).toBe(slow);
  };

  test('three hops with an in or out in every position', () => {
    const g = console3();

    mixed(g, V(), both('T'), in_('T'), both('T'));
    mixed(g, V(), in_('T'), both('T'), both('T'));
    mixed(g, V(), both('T'), both('T'), in_('T'));
    mixed(g, V(), both('T'), both('T'), out('T'));
    mixed(g, V(), both('T'), out('T'), in_('T'));
    mixed(g, V(), in_('T'), out('T'), both('T'));
  });

  test('a FILTERED two-hop chain, which also takes the walk rather than the inner product', () => {
    const g = console3();

    mixed(g, V(), has('k', gt(0)), both('T'), out('T'));
    mixed(g, V(), has('k', gt(0)), both('T'), in_('T'));
    mixed(g, V(), hasLabel('P'), both('T'), out('T'));
    mixed(g, V(), hasLabel('P'), out('T'), both('T'));
  });

  test('and on a loop-free graph too, so the loop is not carrying these either', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: { k: 3 } });

    g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'e2', labels: ['T'], from: b, to: c, properties: {} });

    mixed(g, V(), both('T'), both('T'), in_('T'));
    mixed(g, V(), both('T'), in_('T'), both('T'));
    mixed(g, V(), hasLabel('P'), both('T'), out('T'));
  });
});

describe('what the both chain must still decline', () => {
  test('a MULTI-LABEL hop on a graph holding a multi-type edge', () => {
    // `hopChainShape` refuses `labels.length !== 1` when `multiTypeEdgeCount !== 0`, because a
    // per-label bucket sum is only a degree when the wanted set is a single bucket — item 573
    // shipped exactly that bug on the GQL side. The guard is upstream of the `both` routing, so
    // this asserts it still holds for `both`.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'two', labels: ['T', 'S'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'one', labels: ['T'], from: b, to: a, properties: {} });

    expect(g.multiTypeEdgeCount).toBe(1);

    for (const [fast, slow] of [
      [
        n(g, V(), both('T', 'S'), both('T', 'S'), count()),
        n(g, V(), both('T', 'S'), both('T', 'S'), identity(), count()),
      ],
      [n(g, V(), both(), both(), count()), n(g, V(), both(), both(), identity(), count())],
    ] as ReadonlyArray<readonly [number, number]>) {
      expect(fast).toBe(slow);
    }
  });
});
