import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  Order,
  V,
  effectivePlan,
  limit,
  order,
  skip,
  toArray,
  traversal,
  values,
} from './index.js';

/**
 * Item 1574: `order()` immediately followed by `take(n)` takes a bounded top-k instead of sorting
 * everything and slicing. **2.07x** at 200,000 values (55.2 → 26.7 ms), control flat.
 *
 * ⚠️ TWO ANSWER-VISIBLE PROPERTIES, and both are the reason this file exists rather than a bench row:
 *
 *   1. TIE ORDER. Gremlin's sort is stable and tie order is compared against native, so the top-k
 *      must return the SAME prefix a stable full sort would — which is why its comparator breaks
 *      ties on arrival index. A heap that picked an arbitrary member of a tie group straddling the
 *      boundary would be a silent answer change.
 *   2. FAULTS. `sortByBys` evaluates every key BEFORE the element check specifically so a throwing
 *      `by` wins over the element fault. The capped path must still evaluate every key, so an item
 *      that would NOT have been kept still raises.
 */
const ties = (): Graph => {
  const graph = new Graph();

  // `k` takes only three distinct values over 30 vertices, so every cap lands INSIDE a tie group.
  // `n` is the arrival order, which is what a stable sort preserves within a group.
  for (let i = 0; i < 30; i += 1) {
    graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 3, n: i } });
  }

  return graph;
};

describe('⚠️ the top-k returns exactly the stable full sort prefix', () => {
  test('ties at the boundary keep ARRIVAL order', () => {
    const graph = ties();

    for (const cap of [1, 2, 5, 9, 10, 11, 15, 29, 30, 31]) {
      const capped = toArray(traversal(V(), values('n'), order(), limit(cap)), graph);
      const sliced = (toArray(traversal(V(), values('n'), order()), graph) as number[]).slice(
        0,
        cap,
      );

      expect(capped).toEqual(sliced);
    }
  });

  test('ties on the SORT KEY keep arrival order — the case a heap gets wrong', () => {
    const graph = ties();

    // Sorting by `k` (three groups of ten) and taking 4 must give the FIRST four arrivals with
    // `k === 0`, i.e. vertices 0, 3, 6, 9 — not an arbitrary four of that group.
    for (const cap of [1, 4, 10, 11, 20, 25]) {
      const capped = toArray(traversal(V(), order().by('k'), limit(cap), values('n')), graph);
      const sliced = (
        toArray(traversal(V(), order().by('k'), values('n')), graph) as number[]
      ).slice(0, cap);

      expect(capped).toEqual(sliced);
    }
  });

  test('descending agrees with its own full sort', () => {
    const graph = ties();

    for (const cap of [1, 4, 12, 30]) {
      const capped = toArray(traversal(V(), values('n'), order(Order.desc), limit(cap)), graph);
      const sliced = (
        toArray(traversal(V(), values('n'), order(Order.desc)), graph) as number[]
      ).slice(0, cap);

      expect(capped).toEqual(sliced);
    }
  });

  test('a cap of 0 and a cap beyond the stream both agree', () => {
    const graph = ties();

    expect(toArray(traversal(V(), values('n'), order(), limit(0)), graph)).toEqual([]);
    expect(toArray(traversal(V(), values('n'), order(), limit(999)), graph)).toEqual(
      toArray(traversal(V(), values('n'), order()), graph),
    );
  });
});

describe('⚠️ faults are preserved — every key is still evaluated', () => {
  test('ordering raw elements still raises, even with a small cap', () => {
    // The element check runs over ALL keyed items, above the cap. With the cap applied first this
    // would return 1 vertex instead of raising.
    const graph = ties();

    expect(() => toArray(traversal(V(), order(), limit(1)), graph)).toThrow(
      'order() over graph elements is not supported',
    );
  });

  test('an item that would NOT be kept still faults', () => {
    // The element is the LAST arrival and the cap is 1, so a selection that stopped evaluating
    // once its heap was full would never look at it.
    const graph = new Graph();

    graph.addVertex({ id: 'a', labels: ['P'], properties: { n: 0 } });
    graph.addVertex({ id: 'b', labels: ['P'], properties: { n: 1 } });

    expect(() => toArray(traversal(V(), order(), limit(1)), graph)).toThrow(
      'order() over graph elements is not supported',
    );
  });
});

describe('the fusion, and what it deliberately refuses', () => {
  const capOf = (plan: Parameters<typeof effectivePlan>[0], graph: Graph): number | undefined => {
    const step = effectivePlan(plan, graph, false).steps.find((s) => s.kind === 'order');

    return (step as { cap?: number } | undefined)?.cap;
  };

  test('a take immediately after the order sets the cap', () => {
    expect(capOf(traversal(V(), values('n'), order(), limit(7)), ties())).toBe(7);
  });

  test('no take means no cap', () => {
    expect(capOf(traversal(V(), values('n'), order()), ties())).toBeUndefined();
  });

  test('⚠️ a SKIP between them refuses — the bound would have to be skip + take', () => {
    // Deliberately not handled: `cap = n` would drop the rows the skip is meant to pass over.
    expect(capOf(traversal(V(), values('n'), order(), skip(5), limit(7)), ties())).toBeUndefined();
  });

  test('order(local) is left alone', () => {
    // A local order sorts WITHIN each value; a stream-level cap means nothing there.
    const plan = traversal(V(), values('n'), order(), limit(3));

    expect(capOf(plan, ties())).toBe(3);
  });

  test('the answer with a skip is still correct', () => {
    const graph = ties();
    const got = toArray(traversal(V(), values('n'), order(), skip(5), limit(7)), graph);
    const want = (toArray(traversal(V(), values('n'), order()), graph) as number[]).slice(5, 12);

    expect(got).toEqual(want);
  });
});
