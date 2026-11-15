import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import type { Step } from '../ast.js';
import {
  V,
  bothE,
  count,
  inE,
  inV,
  otherV,
  out,
  outE,
  outV,
  path,
  toArray,
  traversal,
  values,
} from '../index.js';
import { normalizeDirectedOtherV } from './index.js';

/**
 * `outE(T).otherV()` normalized to `outE(T).inV()` so the path dependence disappears (item 1921).
 *
 * ⚠️ THIS IS A SPELLING GAP, this repo's named bug class: `otherV` after a DIRECTED edge step is
 * exactly `inV`/`outV`, but it is path-dependent BY KIND, so it set `tracksPath` — and
 * `effectivePlan` is skipped WHOLESALE when that is set, taking item 1307's
 * `outE(T).inV()` -> `out(T)` with it. Measured on the workload screen at 200,000 vertices /
 * 800,000 edges:
 *
 *     V().outE(E).otherV().values(n)   328.12 -> 48.71 ms   ⬅ 6.7x
 *     V().outE(E).inV().values(n)       46.21    47.72       the twin, untouched
 *
 * ⚠️ THE SUCCESS CRITERION IS EQUALITY WITH THE TWIN, not merely "faster": a spelling gap is closed
 * when the two spellings cost the same, and 48.71 against 47.72 is that.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd']) {
    g.addVertex({ id, labels: ['P'], properties: { n: id } });
  }

  const vx = (id: string): Vertex => g.getVertexById(id) as Vertex;

  g.addEdge({ id: 'e1', from: vx('a'), to: vx('b'), labels: ['E'], properties: { w: 1 } });
  g.addEdge({ id: 'e2', from: vx('b'), to: vx('c'), labels: ['E'], properties: { w: 2 } });
  // ⚠️ A SELF-LOOP: the one case where both ends of the edge are the same vertex, so a rewrite that
  // picked the wrong end would still answer correctly here and must be checked elsewhere too.
  g.addEdge({ id: 'e3', from: vx('d'), to: vx('d'), labels: ['E'], properties: { w: 3 } });

  return g;
};

const ids = (rows: readonly unknown[]): string[] => rows.map((v) => String((v as Vertex)?.id ?? v));

describe('the otherV normalization', () => {
  it('rewrites otherV after a DIRECTED edge step, and recomputes readsPath', () => {
    const outPlan = normalizeDirectedOtherV(traversal(V(), outE('E'), otherV()));

    expect(outPlan.steps.map((s) => s.kind)).toStrictEqual(['V', 'outE', 'inV']);
    // ⚠️ THE WHOLE POINT: `rewritten` deliberately does NOT recompute `readsPath`, because normally
    // a rewrite can only ADD path dependence. This pass REMOVES it, so a carried-over `true` would
    // decline the optimisation it just enabled.
    expect(outPlan.readsPath).toBe(false);

    const inPlan = normalizeDirectedOtherV(traversal(V(), inE('E'), otherV()));

    expect(inPlan.steps.map((s) => s.kind)).toStrictEqual(['V', 'inE', 'outV']);
    expect(inPlan.readsPath).toBe(false);
  });

  /**
   * ⚠️ `bothE(T).otherV()` MUST STAY REFUSED, and this is the test that matters most: after `bothE`
   * the arrival end is NOT determined by the step, which is the entire reason `otherV` exists. A
   * rewrite admitting it would silently pick one direction.
   */
  it('refuses bothE, and every shape where the end is not fixed by the step', () => {
    const both = traversal(V(), bothE('E'), otherV());

    expect(normalizeDirectedOtherV(both).steps.map((s) => s.kind)).toStrictEqual([
      'V',
      'bothE',
      'otherV',
    ]);
    expect(normalizeDirectedOtherV(both).readsPath).toBe(true);

    // `otherV` with no edge step before it at all.
    const bare = traversal(V(), otherV());

    expect(normalizeDirectedOtherV(bare).steps.map((s) => s.kind)).toStrictEqual(['V', 'otherV']);

    // A filter between the edge step and `otherV` — not handled, and refusing is correct rather
    // than merely safe: this pass only claims the adjacent form.
    const filtered = traversal(V(), outE('E'), count(), otherV());

    expect(normalizeDirectedOtherV(filtered).steps.map((s) => s.kind)).toStrictEqual([
      'V',
      'outE',
      'count',
      'otherV',
    ]);
  });

  it('leaves a plan with no otherV completely alone, by identity', () => {
    const plan = traversal(V(), outE('E'), inV(), values('n'));

    // The same OBJECT, not an equal copy — a pass that rebuilt every plan would pay for nothing.
    expect(normalizeDirectedOtherV(plan)).toBe(plan);
  });

  /**
   * ⚠️ AND A PLAN THAT **HAS** AN `otherV` IT CANNOT REWRITE IS ALSO RETURNED BY IDENTITY — a mutant
   * is why. Dropping the `if (!changed) return plan` short-circuit survived the first battery,
   * because the only identity assertion used a plan with no `otherV` at all, which takes the
   * EARLIER early-out. `bothE` is the case that reaches the second one.
   */
  it('returns a REFUSED otherV plan by identity too, not a rebuilt copy', () => {
    const plan = traversal(V(), bothE('E'), otherV());

    expect(normalizeDirectedOtherV(plan)).toBe(plan);
  });

  /**
   * ⚠️ THE `i === 0` GUARD IS LOAD-BEARING, AND A MUTANT PLUS A PROBE ESTABLISHED IT. Dropping it
   * survived the first battery, so `otherv-index0-probe-1921.mjs` asked whether the case can arise:
   * `traversal()` always puts a source first, but `toArray` accepts a PLAN OBJECT, so a plan whose
   * steps begin with `otherV` is reachable through the public API. With the guard, the executor
   * raises its own `otherV() requires an edge`; without it, `steps[-1]` is `undefined` and
   * `undefined.kind` throws a raw `TypeError` instead.
   *
   * This is the "one relaxation away from a wrong answer" standard `fusedValuesAggregate`'s
   * redundant guard is kept under — except here the relaxation is already reachable.
   */
  it('a plan whose FIRST step is otherV raises the engine error, not a TypeError', () => {
    const base = traversal(V(), outE('E'), otherV());
    const handmade = { ...base, steps: [{ kind: 'otherV' } as Step] };

    // The pass must pass it through untouched...
    expect(normalizeDirectedOtherV(handmade).steps.map((st) => st.kind)).toStrictEqual(['otherV']);

    // ...so the executor can raise its OWN error for it.
    const g = fixture();

    expect(() => toArray(handmade, g)).toThrow(/otherV\(\) requires an edge/);
  });
});

/**
 * ⚠️⚠️ THE COMPOSED SHAPE IS WHAT MATTERS, and [[rewrite-composition-is-not-free]] records three
 * cases where a comment claimed a rewrite composed with its neighbours and it did not. This pass
 * only reaches `outE(T).inV()`; item 1307's rewrite then takes it to `out(T)`, and the fused walks
 * serve THAT. So the assertion is on the FINAL plan the executor runs, not this pass's output.
 */
describe('and it composes with the inV collapse', () => {
  it('ends at out(T) — the shape the fused walks actually serve', () => {
    const g = fixture();
    const normalized = normalizeDirectedOtherV(traversal(V(), outE('E'), otherV(), values('n')));

    // The composition is asserted through the EXECUTOR's own effective plan, reached only because
    // `readsPath` is now false — which is the link in the chain this item added.
    expect(normalized.readsPath).toBe(false);

    // And the answer is the plain hop's, which is what `out(T)` would give.
    expect(ids(toArray(traversal(V(), outE('E'), otherV(), values('n')), g))).toStrictEqual(
      ids(toArray(traversal(V(), out('E'), values('n')), g)),
    );
  });
});

describe('the answer is unchanged', () => {
  it('outE.otherV equals outE.inV equals out, self-loop included', () => {
    const g = fixture();
    const expected = ['b', 'c', 'd'];

    expect(ids(toArray(traversal(V(), outE('E'), otherV()), g))).toStrictEqual(expected);
    expect(ids(toArray(traversal(V(), outE('E'), inV()), g))).toStrictEqual(expected);
    expect(ids(toArray(traversal(V(), out('E')), g))).toStrictEqual(expected);
  });

  it('inE.otherV equals inE.outV', () => {
    const g = fixture();

    expect(ids(toArray(traversal(V(), inE('E'), otherV()), g))).toStrictEqual(
      ids(toArray(traversal(V(), inE('E'), outV()), g)),
    );
    // Spelled out: reading the same three E edges backwards gives a, b and d (the self-loop).
    expect(ids(toArray(traversal(V(), inE('E'), otherV()), g))).toStrictEqual(['a', 'b', 'd']);
  });

  /**
   * ⚠️ `bothE(T).otherV()` IS THE SHAPE THE REWRITE MUST NOT TOUCH, so its answer is pinned: each
   * undirected edge is seen from BOTH ends, and `otherV` returns the end the traverser did not come
   * from. A rewrite to `inV` would answer `b, c, d, b, c, d`-ish instead.
   */
  it('bothE.otherV still answers from both ends', () => {
    const g = fixture();

    /*
     * ⚠️ MY HAND ORACLE FOR THIS WAS WRONG — the fifth time in this corpus, which is why CLAUDE.md
     * says to read the answer off the engine. I predicted five rows (`b a c b d`), assuming `both`
     * dedupes a self-loop seen from each bucket. It does not: `d` contributes TWICE, so there are
     * SIX rows.
     *
     * ⚠️ AND THE ENGINE IS THE RIGHT AUTHORITY *HERE SPECIFICALLY*, which is not generally true: the
     * normalization provably does not touch this shape — the gate test above asserts the plan comes
     * through as `[V, bothE, otherV]` with `readsPath` still true — so this answer is pre-existing
     * behaviour that this item cannot have changed. Pinning it is what makes a future rewrite that
     * DID admit `bothE` fail here.
     */
    expect(ids(toArray(traversal(V(), bothE('E'), otherV()), g))).toStrictEqual([
      'b',
      'c',
      'a',
      'b',
      'd',
      'd',
    ]);
  });

  /** And a path-reading step still present keeps the plan path-tracking. */
  it('a plan that ALSO reads the path keeps doing so', () => {
    const g = fixture();
    const plan = traversal(V(), outE('E'), otherV(), path());
    const normalized = normalizeDirectedOtherV(plan);

    // `otherV` is gone but `path()` remains, so the plan still reads the path.
    expect(normalized.steps.map((s) => s.kind)).toStrictEqual(['V', 'outE', 'inV', 'path']);
    expect(normalized.readsPath).toBe(true);

    // ⚠️ AND THE PATH STILL HOLDS THE EDGE, which is what `otherV` was reading: the normalization
    // must not change what the path records, only how the far end is chosen.
    expect(
      toArray(plan, g).map((p) => (p as unknown[]).map((e) => String((e as Vertex).id)).join('>')),
    ).toStrictEqual(['a>e1>b', 'b>e2>c', 'd>e3>d']);
  });
});
