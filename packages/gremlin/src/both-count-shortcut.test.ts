/**
 * Item 1087: `both()` counts — the two rungs that declined it, and the self-loop that is why.
 *
 * `filteredHopCount` refused any hop that was not `out` or `in` with "`both` double-counts a
 * self-loop", and `vertexStepCount` refused it with "a self-loop is incident twice and the total is
 * not a bucket size". The double-count is real. **In Gremlin it is the correct answer**, so there
 * is nothing to correct and both rungs were leaving the work on the table:
 *
 *   both(T).has(k, gt(60)).count()            564.22 ms -> 33.33   16.9x
 *   hasLabel(P).both(T).has(k, gt(60)).count() 596.94 -> 32.77     18.2x
 *   both(T).count()                            330.49 ->  0.01     O(1)
 *
 * TINKERPOP 3.7.3 WAS ASKED RATHER THAN ASSUMED, on three `T` edges including a self-loop:
 *
 *   out 3   in 3   both 6   bothE 6   both.has(k,gt(0)) 6   both.has(k,eq(1)) 3
 *   hasLabel(P).both 5      hasLabel(P).both.has(k,eq(1)) 3
 *
 * and `GROUND_TRUTH` below is that run, reproduced here so a future change to either rung has to
 * answer to the console rather than to my reading of it.
 *
 * THE ISO-GQL TWIN IS THE OPPOSITE. `-[:T]-` emits a loop ONCE, so item 1086's GQL arm SUBTRACTS
 * the passing loops. Same shared walk, two surface languages, two semantics — which is why the
 * arithmetic lives per language and not in the walk.
 *
 * THE ORACLE IS A FORCED DECLINE, via `identity()` — a step the rung cannot absorb. Item 930
 * records why it must not be a duplicated filter: that rung learned to fold a filter CHAIN, so ten
 * comparisons silently became the shortcut against itself and the suite stayed green while
 * comparing one route to itself.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  both,
  bothE,
  count,
  eq,
  gt,
  has,
  hasLabel,
  identity,
  inE,
  in_,
  out,
  outE,
  toArray,
  traversal,
} from './index.js';

const n = (g: Graph, ...steps: readonly unknown[]): number =>
  toArray(traversal(...(steps as never[])), g)[0] as number;

/** The TinkerPop 3.7.3 fixture: three `T` edges, one of them a self-loop on a `P` vertex. */
const console3 = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: { w: 1 } });
  g.addEdge({ id: 'e2', labels: ['T'], from: b, to: c, properties: { w: 1 } });
  g.addEdge({ id: 'e3', labels: ['T'], from: a, to: a, properties: { w: 1 } });

  return g;
};

describe('the TinkerPop 3.7.3 console run, reproduced', () => {
  // Every number here was printed by `podman run -i docker.io/tinkerpop/gremlin-console:3.7.3`,
  // not derived. A change to either rung that breaks one of these breaks agreement with TinkerPop.
  test('out, in and both on a graph with a self-loop', () => {
    const g = console3();

    expect(n(g, V(), out('T'), count())).toBe(3);
    expect(n(g, V(), in_('T'), count())).toBe(3);
    // 6, NOT 5: the loop is incident twice and yielded twice. This single number is the whole
    // reason both rungs used to decline, and the reason they no longer need to.
    expect(n(g, V(), both('T'), count())).toBe(6);
    expect(n(g, V(), bothE('T'), count())).toBe(6);
  });

  test('a filter after both', () => {
    const g = console3();

    expect(n(g, V(), both('T'), has('k', gt(0)), count())).toBe(6);
    expect(n(g, V(), both('T'), has('k', eq(1)), count())).toBe(3);
  });

  test('a leading hasLabel', () => {
    const g = console3();

    expect(n(g, V(), hasLabel('P'), both('T'), count())).toBe(5);
    expect(n(g, V(), hasLabel('P'), both('T'), has('k', eq(1)), count())).toBe(3);
  });

  test('the shortcut and the forced decline agree on every one', () => {
    // The decline is the route these counts used to take, so this is the differential: same
    // question, two routes, `identity()` forcing the second.
    const g = console3();
    const pairs: ReadonlyArray<readonly [number, number]> = [
      [n(g, V(), both('T'), count()), n(g, V(), both('T'), identity(), count())],
      [
        n(g, V(), both('T'), has('k', eq(1)), count()),
        n(g, V(), both('T'), identity(), has('k', eq(1)), count()),
      ],
      [
        n(g, V(), hasLabel('P'), both('T'), has('k', eq(1)), count()),
        n(g, V(), hasLabel('P'), both('T'), identity(), has('k', eq(1)), count()),
      ],
    ];

    for (const [fast, slow] of pairs) {
      expect(fast).toBe(slow);
    }

    expect(pairs).toHaveLength(3);
  });
});

describe('the bare both count is twice the bucket', () => {
  test('and the self-loop is counted in BOTH halves', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
    expect(n(g, V(), both('T'), count())).toBe(2);

    g.addEdge({ id: 'loop', labels: ['T'], from: a, to: a, properties: {} });
    // 4, not 3: `2 * |E_T|` with no correction. The GQL twin answers 3 for `(a)-[:T]-(x)`, and
    // that difference IS the two languages' semantics rather than a bug in either.
    expect(n(g, V(), both('T'), count())).toBe(4);
    expect(n(g, V(), both('T'), identity(), count())).toBe(4);
  });

  test('an untyped both counts every edge twice', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'e2', labels: ['S'], from: b, to: a, properties: {} });

    expect(n(g, V(), both(), count())).toBe(4);
    expect(n(g, V(), both(), identity(), count())).toBe(4);
  });
});

describe('the EDGE steps are the same bucket (item 1088)', () => {
  // `vertexStepCount` had no edge-step arm at all, so `V().outE(T).count()` enumerated 600,000
  // edges at 125.54 ms where `V().out(T).count()` — the same number by the same arithmetic — was
  // already O(1). `inE` 119.15, `bothE` 224.95; all three now 0.01.
  //
  // The TinkerPop ground truth for this was ALREADY IN THE FILE, recorded on
  // `edgeHopSeededCount`: "on 4 `T` edges including a self-loop, `V().outE(T).count()` and
  // `V().inE(T).count()` are both 4 while `V().bothE(T).count()` is 8".
  test('outE and inE count the edges once, bothE twice', () => {
    const g = console3();

    expect(n(g, V(), outE('T'), count())).toBe(3);
    expect(n(g, V(), inE('T'), count())).toBe(3);
    expect(n(g, V(), bothE('T'), count())).toBe(6);
  });

  test("the four-edge fixture from this file's own TinkerPop note", () => {
    // Person->Co, Co->Person, Person->Person and a Person SELF-LOOP: 4 edges, so outE and inE are
    // 4 and bothE is 8 — the note's numbers exactly.
    const g = new Graph();
    const p1 = g.addVertex({ id: 'p1', labels: ['Person'], properties: {} });
    const p2 = g.addVertex({ id: 'p2', labels: ['Person'], properties: {} });
    const co = g.addVertex({ id: 'co', labels: ['Co'], properties: {} });

    g.addEdge({ id: 'a', labels: ['T'], from: p1, to: co, properties: {} });
    g.addEdge({ id: 'b', labels: ['T'], from: co, to: p2, properties: {} });
    g.addEdge({ id: 'c', labels: ['T'], from: p1, to: p2, properties: {} });
    g.addEdge({ id: 'd', labels: ['T'], from: p1, to: p1, properties: {} });

    expect(n(g, V(), outE('T'), count())).toBe(4);
    expect(n(g, V(), inE('T'), count())).toBe(4);
    expect(n(g, V(), bothE('T'), count())).toBe(8);
  });

  test('each agrees with its forced decline', () => {
    const g = console3();

    for (const [fast, slow] of [
      [n(g, V(), outE('T'), count()), n(g, V(), outE('T'), identity(), count())],
      [n(g, V(), inE('T'), count()), n(g, V(), inE('T'), identity(), count())],
      [n(g, V(), bothE('T'), count()), n(g, V(), bothE('T'), identity(), count())],
      [n(g, V(), outE(), count()), n(g, V(), outE(), identity(), count())],
      [n(g, V(), bothE(), count()), n(g, V(), bothE(), identity(), count())],
    ] as ReadonlyArray<readonly [number, number]>) {
      expect(fast).toBe(slow);
    }
  });

  test('a MULTI-LABEL edge step keeps the adjacentCount condition', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'two', labels: ['T', 'S'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'one', labels: ['T'], from: b, to: a, properties: {} });

    expect(g.multiTypeEdgeCount).toBe(1);
    // TWO edges: outE is 2 and bothE is 4. Summing per-label buckets would give |T| + |S| = 3.
    expect(n(g, V(), outE('T', 'S'), count())).toBe(2);
    expect(n(g, V(), outE('T', 'S'), identity(), count())).toBe(2);
    expect(n(g, V(), bothE('T', 'S'), count())).toBe(4);
    expect(n(g, V(), bothE('T', 'S'), identity(), count())).toBe(4);
  });
});

describe('what the both rungs must still decline', () => {
  test('a MULTI-LABEL hop on a graph holding a multi-type edge', () => {
    // `adjacentCount` declines this because summing per-label buckets counts a `T,S` edge once per
    // label, and doubling a wrong number is still wrong. The condition carries over to `both`
    // unchanged — this asserts the ANSWER, which is what a wrongly-admitted shape gets wrong.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

    g.addEdge({ id: 'two', labels: ['T', 'S'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'one', labels: ['T'], from: b, to: a, properties: {} });

    expect(g.multiTypeEdgeCount).toBe(1);
    // TWO edges, each yielded from both ends: 4. Summing buckets would give |T| + |S| = 3, doubled
    // to 6.
    expect(n(g, V(), both('T', 'S'), count())).toBe(4);
    expect(n(g, V(), both('T', 'S'), identity(), count())).toBe(4);
    // One label is always sound, multi-type edge or not.
    expect(n(g, V(), both('T'), count())).toBe(4);
    expect(n(g, V(), both('S'), count())).toBe(2);
  });

  test('a multi-label hop IS admitted when no edge carries two labels', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'e2', labels: ['S'], from: b, to: a, properties: {} });

    expect(g.multiTypeEdgeCount).toBe(0);
    expect(n(g, V(), both('T', 'S'), count())).toBe(4);
    expect(n(g, V(), both('T', 'S'), identity(), count())).toBe(4);
  });

  test('a filtered multi-label both, same condition', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

    g.addEdge({ id: 'two', labels: ['T', 'S'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'one', labels: ['T'], from: b, to: a, properties: {} });

    expect(n(g, V(), both('T', 'S'), has('k', gt(0)), count())).toBe(4);
    expect(n(g, V(), both('T', 'S'), identity(), has('k', gt(0)), count())).toBe(4);
    expect(n(g, V(), both('T', 'S'), has('k', eq(1)), count())).toBe(2);
    expect(n(g, V(), both('T', 'S'), identity(), has('k', eq(1)), count())).toBe(2);
  });
});
