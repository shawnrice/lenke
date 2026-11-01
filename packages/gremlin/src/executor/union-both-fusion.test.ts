/**
 * `union(out(T), in(T)).count()` fuses to `both(T).count()` (item 1311) — the rewrite, the tail
 * condition that makes it sound, and the branch shapes it refuses.
 *
 * ⚠️ THE TAIL CONDITION IS THE WHOLE ARGUMENT. `both` and `union(out, in)` are multiset-equal but
 * NOT sequence-equal — item 1308 measured that directly — so this may only fire where the order is
 * not observable. The row-returning cases below are therefore DECLINE tests, and one of them
 * asserts that the union still emits the union's own order, which is the property that would be
 * destroyed by a careless widening.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  both,
  bothE,
  count,
  dedupe,
  inE,
  in_,
  limit,
  out,
  outE,
  union,
  values,
} from '../steps.js';
import { traversal } from '../traversal.js';
import { effectivePlan, fuseUnionBoth, toArray } from './index.js';

/** Parallel edges, a MULTI-LABEL edge and a SELF-LOOP — built to break the equivalence. */
const build = (): Graph => {
  const g = new Graph();

  for (const [id, labels] of [
    ['a', ['P']],
    ['b', ['P']],
    ['c', ['Q']],
  ] as ReadonlyArray<readonly [string, string[]]>) {
    g.addVertex({ id, labels, properties: { k: id } });
  }

  const v = (id: string) => g.verticesById.get(id)!;

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: v('a'), to: v('b'), labels: ['T'], properties: {} });
  g.addEdge({ id: 'e3', from: v('b'), to: v('c'), labels: ['T', 'S'], properties: {} });
  g.addEdge({ id: 'e4', from: v('a'), to: v('a'), labels: ['T'], properties: {} });

  return g;
};

const kinds = (steps: readonly { kind: string }[]): string[] => steps.map((s) => s.kind);

describe('the union fuses under an order-free tail', () => {
  test('union(out, in) + count becomes both + count', () => {
    const fused = fuseUnionBoth(traversal(V(), union(out('T'), in_('T')), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'both', 'count']);
    expect((fused.steps[1] as { labels: readonly string[] }).labels).toEqual(['T']);
  });

  test('the branches may be written IN EITHER ORDER', () => {
    const fused = fuseUnionBoth(traversal(V(), union(in_('T'), out('T')), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'both', 'count']);
  });

  test('union(outE, inE) becomes bothE', () => {
    const fused = fuseUnionBoth(traversal(V(), union(outE('T'), inE('T')), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'bothE', 'count']);
  });

  test('a dedupe before the count still fuses — a SET is coarser than a multiset', () => {
    const fused = fuseUnionBoth(traversal(V(), union(out('T'), in_('T')), dedupe(), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'both', 'dedupe', 'count']);
  });

  test('an UNTYPED pair fuses, keeping the empty label list', () => {
    const fused = fuseUnionBoth(traversal(V(), union(out(), in_()), count()));

    expect(kinds(fused.steps)).toEqual(['V', 'both', 'count']);
    expect((fused.steps[1] as { labels: readonly string[] }).labels).toEqual([]);
  });

  test('it is WIRED into effectivePlan', () => {
    const fused = effectivePlan(traversal(V(), union(out('T'), in_('T')), count()), build(), false);

    expect(kinds(fused.steps)).toEqual(['V', 'both', 'count']);
  });

  test('a plan with no fusable union is returned UNCHANGED, by identity', () => {
    const plan = traversal(V(), both('T'), count());

    expect(fuseUnionBoth(plan)).toBe(plan);
  });
});

describe('the DECLINES, each a real non-equivalence', () => {
  const NO_FUSE: ReadonlyArray<readonly [string, ReturnType<typeof traversal>]> = [
    // THE TAIL. A row-returning traversal would have its ORDER changed, which is the one thing
    // this rewrite may not do.
    ['a row-returning tail', traversal(V(), union(out('T'), in_('T')))],
    ['a values() tail', traversal(V(), union(out('T'), in_('T')), values('k'))],
    ['a dedupe with NO count', traversal(V(), union(out('T'), in_('T')), dedupe())],
    // THE BRANCHES.
    ['different labels', traversal(V(), union(out('T'), in_('S')), count())],
    ['the same DIRECTION twice', traversal(V(), union(out('T'), out('T')), count())],
    ['an edge/vertex mix', traversal(V(), union(outE('T'), in_('T')), count())],
    [
      'a branch with two steps',
      traversal(V(), union(traversal(out('T'), dedupe()), in_('T')), count()),
    ],
    ['three branches', traversal(V(), union(out('T'), in_('T'), out('S')), count())],
  ];

  for (const [name, plan] of NO_FUSE) {
    test(`${name} does not fuse`, () => {
      expect(kinds(fuseUnionBoth(plan).steps)).toEqual(kinds(plan.steps));
    });
  }

  test('the union KEEPS its own emission order when it does not fuse', () => {
    const g = build();
    const ids = (rows: readonly unknown[]) =>
      rows.map((r) => (typeof r === 'object' && r !== null ? (r as { id: unknown }).id : r));

    // This is the property the tail condition protects. If these ever agree, either `both` and the
    // union have become sequence-equal — in which case the tail condition can be widened on
    // PURPOSE — or the rewrite has started firing on a row-returning plan, which is a bug.
    expect(ids(toArray(traversal(V(), union(out('T'), in_('T'))), g))).not.toEqual(
      ids(toArray(traversal(V(), both('T')), g)),
    );
  });
});

describe('the fused and unfused spellings answer identically under the tail', () => {
  const PAIRS: ReadonlyArray<
    readonly [string, ReturnType<typeof traversal>, ReturnType<typeof traversal>]
  > = [
    [
      'typed count',
      traversal(V(), both('T'), count()),
      traversal(V(), union(out('T'), in_('T')), count()),
    ],
    [
      'edge count',
      traversal(V(), bothE('T'), count()),
      traversal(V(), union(outE('T'), inE('T')), count()),
    ],
    [
      'untyped count',
      traversal(V(), both(), count()),
      traversal(V(), union(out(), in_()), count()),
    ],
    [
      'multi-type count',
      traversal(V(), both('T', 'S'), count()),
      traversal(V(), union(out('T', 'S'), in_('T', 'S')), count()),
    ],
    [
      'dedupe then count',
      traversal(V(), both('T'), dedupe(), count()),
      traversal(V(), union(out('T'), in_('T')), dedupe(), count()),
    ],
    // Item 1318 added `[hop, count]` to the shared `ORDER_FREE_TAILS`, so this caller newly
    // fuses a union with a hop before the count. Sound on this caller's own premise: the two
    // spellings are MULTISET-equal, and applying a hop elementwise sums each element's own
    // neighbours, so the result multiset does not depend on the input's order.
    [
      'hop then count',
      traversal(V(), both('T'), out('T'), count()),
      traversal(V(), union(out('T'), in_('T')), out('T'), count()),
    ],
    [
      'in-hop then count',
      traversal(V(), both('T'), in_('T'), count()),
      traversal(V(), union(out('T'), in_('T')), in_('T'), count()),
    ],
    // Item 1327 added `[hop, dedupe, count]` to the shared `ORDER_FREE_TAILS`, so this caller
    // newly fuses a union with a hop AND a dedupe before the count. Sound on this caller's own
    // premise: the two spellings are MULTISET-equal, a hop sums each element's own neighbours
    // irrespective of order, and `dedupe` then reduces that multiset to a SET — which `count`
    // reads the size of and nothing else.
    [
      'hop then dedupe then count',
      traversal(V(), both('T'), out('T'), dedupe(), count()),
      traversal(V(), union(out('T'), in_('T')), out('T'), dedupe(), count()),
    ],
  ];

  for (const [name, short, long] of PAIRS) {
    test(`${name} agrees`, () => {
      const g = build();

      expect(toArray(long, g)).toEqual(toArray(short, g));
    });
  }

  test('a union with a HOP before the count IS fused — the route, not just the answer', () => {
    // The agreement cases above cannot see this: fusion is answer-equivalent, so unwiring it
    // leaves them all green and only 8.28x slower. Measured 211.16 -> 25.50 ms at item 1318,
    // a win that arrived because `ORDER_FREE_TAILS` is shared with the multi-id seed.
    const fused = fuseUnionBoth(traversal(V(), union(out('T'), in_('T')), out('T'), count()));

    expect(fused.steps.map((s) => s.kind)).toEqual(['V', 'both', 'out', 'count']);
  });

  test('a union with a hop then a dedupe IS fused — the route, not just the answer', () => {
    // The agreement case above cannot see this: fusion is answer-equivalent, so unwiring it
    // leaves the rows right and only the route changes. Item 1327's mutants were caught by
    // id-seed.test.ts alone, which is the one-sided guarding item 1318 warned about.
    const fused = fuseUnionBoth(
      traversal(V(), union(out('T'), in_('T')), out('T'), dedupe(), count()),
    );

    expect(fused.steps.map((s) => s.kind)).toEqual(['V', 'both', 'out', 'dedupe', 'count']);
  });

  test('a union with a hop, a dedupe and then a WINDOW is NOT fused', () => {
    // Item 1318's rule applied consistently: an UNSOUND entry should be rejected by every caller
    // AND asserted at each, unlike a sound-but-unmeasured one where a single guard suffices. A
    // window reads the SEQUENCE, so `[hop, dedupe, take]` is unsound for both callers — and the
    // windowed case below has tail `[out, take]`, which never exercises the dedupe variant.
    const windowed = traversal(V(), union(out('T'), in_('T')), out('T'), dedupe(), limit(2));

    expect(fuseUnionBoth(windowed).steps.map((s) => s.kind)).toEqual([
      'V',
      'union',
      'out',
      'dedupe',
      'take',
    ]);
  });

  test('a union with a HOP then a WINDOW is NOT fused either', () => {
    // Guards the shared list from THIS side for a hop-length tail. Mutation showed that adding
    // `['out', 'take']` to `ORDER_FREE_TAILS` was caught only by the id-seed tests, because the
    // windowed case below has tail `[take]` and never exercises a two-step windowed tail. The
    // list is protected either way, but this caller's own behaviour under such a widening was
    // not asserted.
    const windowed = traversal(V(), union(out('T'), in_('T')), out('T'), limit(2));

    expect(fuseUnionBoth(windowed).steps.map((s) => s.kind)).toEqual(['V', 'union', 'out', 'take']);
  });

  test('a WINDOWED union is NOT fused — the shared order-free list must reject `take`', () => {
    // `ORDER_FREE_TAILS` lives in `index-seed.ts` since item 1317 and is shared with the
    // multi-id `hasId` seed. A mutation adding `['take']` to it was caught by item 1317's
    // `limit` test and by NOTHING in this file, because no case here windows a union — so the
    // shared list was guarded from one side only. This is the other side.
    //
    // It must stay unfused for this file's own reason: the two spellings are multiset-equal but
    // NOT sequence-equal, so a window selects different elements from each.
    const windowed = traversal(V(), union(out('T'), in_('T')), limit(2));

    expect(fuseUnionBoth(windowed).steps.map((s) => s.kind)).toEqual(['V', 'union', 'take']);
  });
});
