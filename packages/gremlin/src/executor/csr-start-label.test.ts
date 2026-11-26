/*
 * Item 2040 — a leading `hasLabel` admitted into the CSR hop walk and tested PER SLOT.
 *
 * **THE SUITE PASSING SAYS NOTHING ABOUT THE ROUTE, AND ITEM 1870 IS THE PROOF.** There, a rung
 * stopped claiming its headline shape and "the whole gremlin suite passes with the refusal in place"
 * — a 678x regression sat in a shipped rung invisibly because no test asserted it CLAIMED anything.
 * So every route here is asserted directly against `hopValuesCsr`.
 *
 * `seenBefore` IS THE SECOND-ASK POLICY: this arm declines the FIRST time a (direction, type) pair
 * is asked for and serves it afterwards. Every route assertion below therefore calls twice and reads
 * the second — otherwise the arm looks broken when it is merely cold.
 */
import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { count, hasLabel, out, toArray, traversal, V, values } from '../index.js';
import { hopValuesCsr } from './hop-values-csr.js';

/** `cover` of the vertices carry `P`; the rest carry `R`. Every vertex gets one out-edge. */
const build = (cover: number): Graph => {
  const g = new Graph();
  const n = 100;

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: [i / n < cover ? 'P' : 'R'], properties: { k: i } });
  }

  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`)!,
      to: g.getVertexById(`v${(i + 1) % n}`)!,
      labels: ['E'],
    });
  }

  return g;
};

const broad = build(1);
const selective = build(0.02);

/** The second ask, because `seenBefore` declines the first. */
const claims = (t: ReturnType<typeof traversal>, g: Graph): boolean => {
  hopValuesCsr(t, g);

  return hopValuesCsr(t, g) !== undefined;
};

describe('CSR start-label arm (item 2040)', () => {
  beforeAll(() => {
    // Warm the second-ask policy for both graphs so a route assertion never reads a cold arm.
    toArray(traversal(V(), out('E'), values('k')), broad);
    toArray(traversal(V(), out('E'), values('k')), selective);
  });

  test('THE ROUTE: a broad label is CLAIMED, a selective one DECLINES', () => {
    /*
     * The gate is `coverage >= 0.1`. `broad` is 1.0 and `selective` is 0.02 — the two sides of a
     * crossover measured at between 0.02 and 0.1 (CLOSED.md item 2040). Both must hold: claiming the
     * selective case would be the regression item 1870 recorded, and declining the broad case would
     * silently give back this item's 3.50x.
     */
    expect(claims(traversal(V(), hasLabel('P'), out('E'), values('k')), broad)).toBe(true);
    expect(claims(traversal(V(), hasLabel('P'), out('E'), values('k')), selective)).toBe(false);
  });

  test('a MULTI-NAME hasLabel declines — it is a union, a different predicate', () => {
    expect(claims(traversal(V(), hasLabel('P', 'R'), out('E'), values('k')), broad)).toBe(false);
  });

  test('the label is actually APPLIED: off-label starts contribute nothing', () => {
    /*
     * THE ORACLE IS THE SAME QUESTION ASKED OF A GRAPH WHERE THE LABEL EXCLUDES HALF. A fusion that
     * ignored `startTest` would answer the unlabelled hop's rows, which is strictly more.
     */
    const half = build(0.5);

    toArray(traversal(V(), out('E'), values('k')), half);

    const labelled = toArray(traversal(V(), hasLabel('P'), out('E'), values('k')), half);
    const unlabelled = toArray(traversal(V(), out('E'), values('k')), half);

    expect(labelled.length).toBe(50);
    expect(unlabelled.length).toBe(100);

    // Every emitted value is the `k` of a neighbour of a `P` vertex, i.e. 1..50.
    expect([...labelled].sort((a, b) => Number(a) - Number(b))).toStrictEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
  });

  test('the ARM and the SEEDED walk agree exactly, element for element and IN ORDER', () => {
    /*
     * **THE ORDER IS THE RISK THIS ARM CARRIES.** It emits in CSR SLOT order (which is
     * `verticesById` order) while the walk it replaces iterates `verticesByLabel`'s bucket. Gremlin
     * results are compared ORDERED by the differential fuzzer, so if those two orders could differ
     * the arm would be a cross-engine failure, not a speed-up. Here the same query is answered on a
     * graph whose coverage puts it EITHER side of the gate, and the sequences must match.
     */
    const half = build(0.5);
    const tiny = build(0.02);

    toArray(traversal(V(), out('E'), values('k')), half);
    toArray(traversal(V(), out('E'), values('k')), tiny);

    // `half` takes the arm (0.5 >= 0.1); `tiny` declines it (0.02 < 0.1). Both describe "the k of
    // every neighbour of a P vertex", so each must equal its own label-free prefix.
    const armed = toArray(traversal(V(), hasLabel('P'), out('E'), values('k')), half);
    const seeded = toArray(traversal(V(), hasLabel('P'), out('E'), values('k')), tiny);

    expect(armed).toStrictEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(seeded).toStrictEqual([1, 2]);
  });

  test('a TRAILING step lands in `rest` with the label step accounted for', () => {
    /*
     * THE LABEL STEP SHIFTS EVERY INDEX BY ONE. An off-by-one in the `rest` slice would re-run the
     * hop or drop the count, and `count()` is the cheapest shape that would show it.
     */
    const half = build(0.5);

    toArray(traversal(V(), out('E'), values('k')), half);

    expect(
      toArray(traversal(V(), hasLabel('P'), out('E'), values('k'), count()), half),
    ).toStrictEqual([50]);
  });

  test('the ITERATOR and `drain` skip the identical slots', () => {
    const half = build(0.5);

    toArray(traversal(V(), out('E'), values('k')), half);

    const claimed = hopValuesCsr(traversal(V(), hasLabel('P'), out('E'), values('k')), half);

    expect(claimed).toBeDefined();

    const lazy = [...(claimed!.values as Iterable<unknown>)];
    const eager = (claimed!.values as { drain: () => unknown[] }).drain();

    expect(lazy).toStrictEqual(eager);
    expect(lazy.length).toBe(50);
  });

  test('an UNLABELLED plan is unchanged — the arm it already served still works', () => {
    expect(claims(traversal(V(), out('E'), values('k')), broad)).toBe(true);
    expect(toArray(traversal(V(), out('E'), values('k')), broad).length).toBe(100);
  });
});
