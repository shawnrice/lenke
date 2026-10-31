/**
 * `hasId` seeds from the id map instead of scanning (item 1306) — the SEED, its EXCLUSIONS, and
 * the two semantics that make it sound.
 *
 * TWO KINDS OF ASSERTION, because the change has two kinds of failure.
 *
 * Seeding is ANSWER-EQUIVALENT where it applies, so a seed that silently stops firing returns the
 * same rows by the scan, more slowly, and no answer test can see it. That is the failure
 * `perf-gate-needs-its-own-test` names, and item 1303 measured how blunt the alternative is: a
 * route assertion that only asked "which detector fired" passed with the whole rewrite disabled.
 * So `seedFromIndex` is called DIRECTLY here and the seed is asserted as a seed — it returns a
 * plan, the `hasId` step is REMOVED from the residual, and the stream holds exactly the element.
 *
 * Getting the seed WRONG is a wrong answer rather than a slow one, and three cases decide it: a
 * non-string id must not raise, duplicate ids must not double, and a multi-id `hasId` must keep
 * the source's order. Those assert answers.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run, toArray } from '../executor.js';
import { E, V, count, dedupe, has, hasId, hasLabel, limit, out, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { seedFromIndex } from './index-seed.js';

const build = (): Graph => {
  const g = new Graph();

  for (const [id, labels, k] of [
    ['a', ['P'], 1],
    ['b', ['P', 'Q'], 2],
    ['c', ['Q'], 3],
  ] as ReadonlyArray<readonly [string, string[], number]>) {
    g.addVertex({ id, labels, properties: { k } });
  }

  const v = (id: string) => g.verticesById.get(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['T'], properties: { w: 10 } });
  g.addEdge({ id: 'e2', from: v('b'), to: v('c'), labels: ['T'], properties: { w: 20 } });

  return g;
};

const ids = (rows: readonly unknown[]): unknown[] =>
  rows.map((r) => (typeof r === 'object' && r !== null ? (r as { id: unknown }).id : r));

describe('a single-id hasId is SEEDED, not scanned', () => {
  test('the seed fires, drops the step, and holds exactly the element', () => {
    const g = build();
    const seeded = seedFromIndex(traversal(V(), hasId('b'), count()), g, false);

    // Non-null is the claim: a `null` here means the plan fell back to a scan, which answers the
    // same thing and is the regression this test exists to see.
    expect(seeded).not.toBeNull();
    // The `hasId` step is REMOVED — the seed set IS the filter's output, so re-applying it would
    // be pure waste. `count()` is all that should be left.
    expect(seeded!.steps.map((s) => s.kind)).toEqual(['count']);

    const got = [...seeded!.stream].map((t) => (t.value as { id: string }).id);

    expect(got).toEqual(['b']);
  });

  test('an EDGE source seeds the same way', () => {
    const g = build();
    const seeded = seedFromIndex(traversal(E(), hasId('e2'), count()), g, false);

    expect(seeded).not.toBeNull();
    expect(seeded!.steps.map((s) => s.kind)).toEqual(['count']);
    expect([...seeded!.stream].map((t) => (t.value as { id: string }).id)).toEqual(['e2']);
  });

  test('an ABSENT id seeds the empty set rather than scanning', () => {
    const g = build();
    const seeded = seedFromIndex(traversal(V(), hasId('nope'), count()), g, false);

    expect(seeded).not.toBeNull();
    expect([...seeded!.stream]).toEqual([]);
  });

  test('a residual filter still applies after the seed', () => {
    const g = build();

    // `b` is the seeded element; the residual `hasLabel('Q')` keeps it and `hasLabel('P')` on `c`
    // would not. A seed that dropped its residuals would answer 1 for both.
    expect(Number(toArray(traversal(V(), hasId('b'), hasLabel('Q'), count()), g)[0])).toBe(1);
    expect(Number(toArray(traversal(V(), hasId('c'), hasLabel('P'), count()), g)[0])).toBe(0);
    expect(Number(toArray(traversal(V(), hasId('b'), has('k', 2), count()), g)[0])).toBe(1);
    expect(Number(toArray(traversal(V(), hasId('b'), has('k', 99), count()), g)[0])).toBe(0);
  });

  test('a projection off the seed reads the right element', () => {
    const g = build();

    expect(toArray(traversal(V(), hasId('c'), values('k')), g)).toEqual([3]);
  });
});

describe('the semantics that make the seed sound', () => {
  test('a NON-STRING id answers EMPTY and does not raise, where V(id) raises', () => {
    const g = build();

    // `dispatch.ts` filters with `ids.includes(v.id)`; ids here are strings, so a numeric id
    // matches nothing. The seed must reach the same answer through the raw id map — going through
    // `asStringId` would turn this empty result into a FAULT.
    expect(Number(toArray(traversal(V(), hasId(5), count()), g)[0])).toBe(0);
    expect(Number(toArray(traversal(E(), hasId(5), count()), g)[0])).toBe(0);
    // The seeded SOURCE keeps raising, which is TinkerPop's string-id-manager behaviour and must
    // not be softened by this change.
    expect(() => toArray(traversal(V(5), count()), g)).toThrow();
  });

  test('hasId() with NO ids keeps nothing', () => {
    const g = build();

    expect(Number(toArray(traversal(V(), hasId(), count()), g)[0])).toBe(0);
  });

  test('DUPLICATE ids yield the element once', () => {
    const g = build();

    expect(Number(toArray(traversal(V(), hasId('a', 'a'), count()), g)[0])).toBe(1);
    expect(ids(toArray(traversal(V(), hasId('a', 'a')), g))).toEqual(['a']);
  });
});

describe('the multi-id DECLINE, which is about order', () => {
  test('several ids are NOT seeded, so the source order survives', () => {
    const g = build();
    // The plan here carries NO order-free tail, which is the whole point of the case: item 1317
    // admits the multi-id seed only where the order cannot be observed, so the decline has to be
    // asserted on a plan where it CAN be. The original wrote this with a `count()` tail, which
    // was incidental scaffolding rather than the contract — the second assertion always used the
    // bare form, and it is the one that pins the behaviour the test is named for.
    const seeded = seedFromIndex(traversal(V(), hasId('c', 'a')), g, false);

    // Declining is the point: seeding would emit in the order the ids were WRITTEN, and
    // `hasId.test.ts`'s "we can filter by ids out of order" pins the opposite.
    expect(seeded).toBeNull();
    expect(ids(toArray(traversal(V(), hasId('c', 'a')), g))).toEqual(['a', 'c']);
  });

  test('a LIMIT after the ids still declines — the window makes order observable', () => {
    const g = build();

    expect(seedFromIndex(traversal(V(), hasId('c', 'a'), limit(1)), g, false)).toBeNull();
  });

  test('an order-free tail ADMITS the multi-id seed (item 1317)', () => {
    // The narrowing, asserted as a route and not only as an answer: under `count()` the seeded
    // and scanned paths yield the same SET and the tail reads neither sequence, so there is no
    // order to preserve and no TinkerPop decision to make.
    const g = build();
    const seeded = seedFromIndex(traversal(V(), hasId('c', 'a'), count()), g, false);

    expect(seeded).not.toBeNull();
    // `hasId` is REMOVED from the residual plan — the seed replaced it rather than narrowing it.
    expect(seeded?.steps.map((s) => s.kind)).toEqual(['count']);
    expect(Number(toArray(traversal(V(), hasId('c', 'a'), count()), g)[0])).toBe(2);
  });

  test('`dedupe().count()` is admitted too, and agrees', () => {
    const g = build();
    const seeded = seedFromIndex(traversal(V(), hasId('c', 'a'), dedupe(), count()), g, false);

    expect(seeded).not.toBeNull();
    expect(Number(toArray(traversal(V(), hasId('c', 'a'), dedupe(), count()), g)[0])).toBe(2);
  });

  test('a seeded multi-id count agrees with the scanned one on every shape', () => {
    // The equivalence the narrowing rests on, checked rather than argued: a missing id, a
    // repeated id, and ids written out of order must each give the filter's own answer.
    const g = build();

    for (const [arg, want] of [
      [['c', 'a'], 2],
      [['a', 'c'], 2],
      [['a', 'a'], 1],
      [['a', 'nope'], 1],
      [['nope', 'gone'], 0],
    ] as const) {
      expect(Number(toArray(traversal(V(), hasId(...arg), count()), g)[0])).toBe(want);
    }
  });

  test('a HOP after the ids is not admitted yet — priced at 213x, its own item', () => {
    const g = build();

    expect(seedFromIndex(traversal(V(), hasId('c', 'a'), out('R'), count()), g, false)).toBeNull();
  });

  test('the single-id path cannot disturb order, which is why it is allowed', () => {
    const g = build();

    // One element has one position, so the seeded sequence and the scanned sequence are identical
    // — that equivalence is what limits the seed to this case.
    expect(ids(toArray(traversal(V(), hasId('c')), g))).toEqual(['c']);
    // Through `run` as well as `toArray`: `run` is the lazy generator and `toArray` drains it, so
    // a seed that only reached one of the two entry points would show up here.
    expect(ids([...run(traversal(V(), hasId('c')), g)])).toEqual(['c']);
  });
});
