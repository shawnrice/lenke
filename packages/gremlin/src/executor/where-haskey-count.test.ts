/*
 * Item 2061 — the fused COUNT of the existence-filtered scan, reached through the `hasKey` spelling.
 *
 * ⚠️⚠️ **THE CENTRAL RISK HERE IS A WRONG ANSWER, NOT A SLOW ONE.** This rung substitutes a `values(k)`
 * projection for the `hasKey(k)` step the engine's rewrite produced, which is sound ONLY because the
 * residual is a `count()` that cannot tell vertices from values apart. Under `order()`, `min()`,
 * `max()` or `fold()` the same substitution would sort or fold the VALUES where the plan asks for the
 * VERTICES. Every one of those is asserted to decline.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  count,
  fold,
  id,
  max,
  min,
  order,
  out,
  toArray,
  traversal,
  V,
  values,
  where,
} from '../index.js';
import { scanWhereHasKeyCountResidual } from './node-values.js';

/** The post-rewrite shape the engine actually hands the rung: `values(k) … count()` -> `hasKey(k) … count()`. */
const rewritten = (keys: readonly string[], tail: unknown): never =>
  ({
    steps: [
      { kind: 'V' },
      { kind: 'where', plan: traversal(out('E')) },
      { kind: 'hasKey', keys },
      tail,
    ],
  }) as never;

const build = (): Graph => {
  const g = new Graph();

  // Has an out-E edge AND the key: counted.
  g.addVertex({ id: 'a', labels: ['T'], properties: { n: 10, u: 1 } });
  g.addVertex({ id: 'b', labels: ['T'], properties: { n: 20, u: 1 } });
  // Has an out-E edge but NO `n`: the key test must drop it.
  g.addVertex({ id: 'c', labels: ['T'], properties: { other: 1, u: 1 } });
  // Has `n` but NO out-E edge: the existence hop must drop it.
  g.addVertex({ id: 'd', labels: ['T'], properties: { n: 30, u: 1 } });

  g.addEdge({
    id: 'e1',
    from: g.getVertexById('a')!,
    to: g.getVertexById('b')!,
    labels: ['E'],
    properties: {},
  });
  g.addEdge({
    id: 'e2',
    from: g.getVertexById('b')!,
    to: g.getVertexById('a')!,
    labels: ['E'],
    properties: {},
  });
  g.addEdge({
    id: 'e3',
    from: g.getVertexById('c')!,
    to: g.getVertexById('a')!,
    labels: ['E'],
    properties: {},
  });

  return g;
};

describe('fused where+hasKey+count (item 2061)', () => {
  const g = build();

  test('THE ROUTE: the rung claims the post-rewrite shape', () => {
    const claimed = scanWhereHasKeyCountResidual(rewritten(['n'], { kind: 'count' }), g);

    expect(claimed).toBeDefined();
    expect(claimed!.rest.map((s) => s.kind)).toStrictEqual(['count']);
  });

  test('the ANSWER is the vertices with BOTH an out-E edge and the key', () => {
    /*
     * 🔑 `a` and `b` qualify. `c` has the edge but no `n`; `d` has `n` but no edge. Both exclusions
     * matter: dropping either test would answer 3, and dropping both 4.
     */
    expect(
      toArray(traversal(V(), where(traversal(out('E'))), values('n'), count()), g),
    ).toStrictEqual([2]);
  });

  test('the fused count equals the count of the fused values walk', () => {
    const claimed = scanWhereHasKeyCountResidual(rewritten(['n'], { kind: 'count' }), g);

    expect(claimed).toBeDefined();
    // The prefix it built is the values walk, so its length IS the count the plan asks for.
    expect(claimed!.values.drain!()).toStrictEqual([10, 20]);
  });

  test('⚠️⚠️ an `order` residual DECLINES — substituting the projection there would sort VALUES, not VERTICES', () => {
    expect(
      scanWhereHasKeyCountResidual(rewritten(['n'], { kind: 'order', bys: [] }), g),
    ).toBeUndefined();
  });

  test('⚠️ `min`, `max` and `fold` residuals DECLINE for the same reason', () => {
    expect(scanWhereHasKeyCountResidual(rewritten(['n'], { kind: 'min' }), g)).toBeUndefined();
    expect(scanWhereHasKeyCountResidual(rewritten(['n'], { kind: 'max' }), g)).toBeUndefined();
    expect(scanWhereHasKeyCountResidual(rewritten(['n'], { kind: 'fold' }), g)).toBeUndefined();
  });

  test('and those spellings still ANSWER correctly through whatever route they take', () => {
    /*
     * ⚠️ A DECLINE IS ONLY HALF THE ASSERTION. [[rung-precedence-hides-the-code-under-test]]: a rung
     * that declines must leave a path that still answers, so each of these is run end to end. They
     * project VERTICES (the `hasKey` form keeps elements), so a route that sorted values would be
     * visibly wrong rather than merely slow.
     */
    expect(
      toArray(traversal(V(), where(traversal(out('E'))), values('n'), min()), g),
    ).toStrictEqual([10]);
    expect(
      toArray(traversal(V(), where(traversal(out('E'))), values('n'), max()), g),
    ).toStrictEqual([20]);
    expect(
      toArray(traversal(V(), where(traversal(out('E'))), values('n'), fold()), g),
    ).toStrictEqual([[10, 20]]);
    expect(
      toArray(traversal(V(), where(traversal(out('E'))), values('n'), order()), g),
    ).toStrictEqual([10, 20]);
  });

  test('⚠️⚠️ THE COUNT METHOD AGREES EXACTLY WITH THE WALK IT CLAIMS TO COUNT (item 2062)', () => {
    /*
     * ⚠️⚠️ **THIS IS THE WRONG-ANSWER GUARD FOR THE WHOLE FAST PATH.** `nodeValuesWhereCount` is a
     * SECOND implementation of the walk's predicate — the existence hop AND the `key in props` drop
     * that is `values(k)`'s contract. If the two ever disagree, every `… count()` on this shape
     * silently returns a different number from the rows it is supposed to be counting, and no test of
     * the walk alone would see it.
     *
     * The fixture is built so each clause matters independently: `c` has the edge but no key, `d` has
     * the key but no edge. A count missing the key test answers 3; missing the hop test, 3; missing
     * both, 4.
     */
    const claimed = scanWhereHasKeyCountResidual(rewritten(['n'], { kind: 'count' }), g);

    expect(claimed).toBeDefined();
    expect(claimed!.values.count).toBeDefined();
    expect(claimed!.values.count!()).toBe(claimed!.values.drain!().length);
    expect(claimed!.values.count!()).toBe([...claimed!.values].length);
    expect(claimed!.values.count!()).toBe(2);
  });

  test('the count method agrees with the walk on a key NO vertex carries, and on one EVERY vertex carries', () => {
    /*
     * ⚠️ THE TWO DEGENERATE ENDS, because an off-by-one in a tight loop shows up at the boundaries:
     * a key nothing has must count 0, and one everything has must count exactly the vertices passing
     * the existence hop (3 of 4 here — `d` has no out-E edge).
     */
    const none = scanWhereHasKeyCountResidual(rewritten(['__absent__'], { kind: 'count' }), g);

    expect(none!.values.count!()).toBe(0);
    expect(none!.values.count!()).toBe(none!.values.drain!().length);

    /*
     * ⚠️ `u` IS ON EVERY VERTEX, which is what makes this the OTHER end rather than the absent case
     * twice. My first attempt used `id` — not a property here — so it re-tested 0 under a name that
     * claimed otherwise. The answer is the vertices passing the existence hop: `a`, `b`, `c` have an
     * out-E edge and `d` does not.
     */
    const every = scanWhereHasKeyCountResidual(rewritten(['u'], { kind: 'count' }), g);

    expect(every!.values.count!()).toBe(3);
    expect(every!.values.count!()).toBe(every!.values.drain!().length);
  });

  test('a MULTI-KEY hasKey declines — `hasKey(a, b)` is "either is present", not one projection', () => {
    expect(
      scanWhereHasKeyCountResidual(rewritten(['n', 'other'], { kind: 'count' }), g),
    ).toBeUndefined();
  });

  test('a FIVE-step plan declines — a further residual would see the wrong element type', () => {
    const five = {
      steps: [
        { kind: 'V' },
        { kind: 'where', plan: traversal(out('E')) },
        { kind: 'hasKey', keys: ['n'] },
        { kind: 'count' },
        { kind: 'fold' },
      ],
    } as never;

    expect(scanWhereHasKeyCountResidual(five, g)).toBeUndefined();
  });

  test('⚠️ a NON-hasKey projection declines — and would THROW if the gate were removed', () => {
    /*
     * ⚠️⚠️ THIS CASE IS HERE BECAUSE A MUTANT SURVIVED MY FILE. Deleting the
     * `projection?.kind !== 'hasKey'` gate makes the rung accept ANY step in the projection slot and
     * then read `projection.keys[0]` off it — `id()` carries no `keys`, so it is a TypeError, not a
     * wrong route. The wide suite caught it; this file had nothing that put a keyless step there.
     *
     * `V().where(hop).id().count()` is an ordinary query, so the decline is asserted alongside the
     * answer it must still produce.
     */
    const withId = {
      steps: [
        { kind: 'V' },
        { kind: 'where', plan: traversal(out('E')) },
        { kind: 'id' },
        { kind: 'count' },
      ],
    } as never;

    expect(scanWhereHasKeyCountResidual(withId, g)).toBeUndefined();
    expect(toArray(traversal(V(), where(traversal(out('E'))), id(), count()), g)).toStrictEqual([
      3,
    ]);
  });

  test('a non-`where` middle step declines — this rung owns only the existence-filtered prefix', () => {
    const plan = {
      steps: [
        { kind: 'V' },
        { kind: 'hasLabel', labels: ['T'] },
        { kind: 'hasKey', keys: ['n'] },
        { kind: 'count' },
      ],
    } as never;

    expect(scanWhereHasKeyCountResidual(plan, g)).toBeUndefined();
  });
});
