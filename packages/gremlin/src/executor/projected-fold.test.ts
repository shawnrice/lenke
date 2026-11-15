import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, both, fold, id, in_, limit, out, run, toArray, traversal, values } from '../index.js';
import { fusableProjectedFold, foldProjectedList } from './aggregation.js';

/**
 * A residual global `fold()` over a fused projection (item 1909).
 *
 * ⚠️⚠️ **A FOLD'S ELEMENT ORDER IS ITS ANSWER**, which is the whole correctness surface and what
 * makes this different from the `min`/`max` residual (item 1857, order-invariant) and the `order()`
 * residual (item 1630, which destroys the input order). So every assertion below is on the LIST
 * CONTENTS IN ORDER, and the fused answer is compared against a spelling that does NOT take the
 * fusion.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const spec of [
    { id: 'a', k: 1 },
    { id: 'b', k: 2 },
    { id: 'c', k: 2 },
    { id: 'd', k: 3 },
  ]) {
    g.addVertex({ id: spec.id, labels: ['T'], properties: { k: spec.k } });
  }

  // `f` has NO `k`, so `values('k')` drops it — the list must not carry a hole.
  g.addVertex({ id: 'f', labels: ['T'], properties: { other: 9 } });
  // `z` is isolated.
  g.addVertex({ id: 'z', labels: ['T'], properties: { k: 9 } });

  for (const spec of [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'a', to: 'c' },
    { id: 'e3', from: 'a', to: 'f' },
    { id: 'e4', from: 'b', to: 'd' },
    { id: 'e5', from: 'c', to: 'b' },
    { id: 'e6', from: 'd', to: 'd' },
  ]) {
    g.addEdge({
      id: spec.id,
      from: g.getVertexById(spec.from) as never,
      to: g.getVertexById(spec.to) as never,
      labels: ['E'],
    });
  }

  return g;
};

/** The one list a fold yields, unwrapped. */
const listOf = (rows: unknown[]): unknown[] => {
  expect(rows).toHaveLength(1);
  expect(Array.isArray(rows[0])).toBe(true);

  return rows[0] as unknown[];
};

describe('a residual fold over a fused projection', () => {
  it('yields the projected values as ONE list, in walk order', () => {
    const g = fixture();
    const folded = listOf(toArray(traversal(V(), out('E'), values('k'), fold()), g));

    // ⚠️ THE ORACLE IS THE SAME PROJECTION WITHOUT THE FOLD, which does not take this path: the
    // list must be exactly those rows, in that order.
    expect(folded).toStrictEqual(toArray(traversal(V(), out('E'), values('k')), g));
    // And spelled out, so a change to BOTH spellings at once cannot pass:
    // `E` out-edges in vertex order a, b, c, d: a->b(2) a->c(2) a->f(NO KEY) b->d(3) c->b(2) d->d(3)
    expect(folded).toStrictEqual([2, 2, 3, 2, 3]);
  });

  it('serves `in` and `both`', () => {
    const g = fixture();

    for (const step of [in_('E'), both('E')]) {
      const folded = listOf(toArray(traversal(V(), step, values('k'), fold()), g));

      expect(folded).toStrictEqual(toArray(traversal(V(), step, values('k')), g));
    }
  });

  it('serves `id()` as the projection', () => {
    const g = fixture();
    const folded = listOf(toArray(traversal(V(), out('E'), id(), fold()), g));

    expect(folded).toStrictEqual(toArray(traversal(V(), out('E'), id()), g));
  });

  it('an EMPTY stream folds to an empty list, not to no rows', () => {
    const g = fixture();
    const folded = listOf(toArray(traversal(V(), out('NOSUCH'), values('k'), fold()), g));

    expect(folded).toStrictEqual([]);
  });

  /**
   * ⚠️ THE LAZY PATH TOO. `toArray` prefers a walk's `drain`, and this fusion calls `drain` itself —
   * so a consumer that spreads `run` instead must get the same list. Item 1889 caught a run-bound
   * off-by-one that lived in one of those two copies only.
   */
  it('the lazy iterator yields the same single list', () => {
    const g = fixture();
    const make = () => traversal(V(), out('E'), values('k'), fold());

    toArray(make(), g);

    expect([...run(make(), g)]).toStrictEqual([[2, 2, 3, 2, 3]]);
  });

  it('a step AFTER the fold still runs', () => {
    const g = fixture();

    // `limit(1)` over a one-row stream keeps it; `limit(0)` drops it. Both say the tail is applied.
    expect(toArray(traversal(V(), out('E'), values('k'), fold(), limit(1)), g)).toHaveLength(1);
    expect(toArray(traversal(V(), out('E'), values('k'), fold(), limit(0)), g)).toHaveLength(0);
  });
});

/**
 * The ELEMENT fold (item 1910) — `V().out(T).fold()`, with no projection between.
 *
 * ⚠️⚠️ ASSERTED ON THE REPEAT CALL, because this shape now rides item 1889's CSR and its
 * SECOND-ASK policy: the first ask declines and records, so a single `toArray` measures the bucket
 * walk and a repeat measures the CSR. Both must answer identically — five mutants survived a
 * single-`toArray` suite at item 1889 for exactly this reason.
 */
describe('a residual fold over a BARE hop', () => {
  const twice = (make: () => ReturnType<typeof traversal>, g: Graph): unknown[] => {
    const first = toArray(make(), g);
    const second = toArray(make(), g);

    expect(second).toStrictEqual(first);

    return second;
  };

  const ids = (list: unknown[]): unknown[] => list.map((v) => (v as { id: string }).id);

  it('folds the far ELEMENTS into one list, in walk order', () => {
    const g = fixture();
    const folded = listOf(twice(() => traversal(V(), out('E'), fold()), g));

    // The same elements the bare hop emits, in the same order — asserted against that walk AND
    // spelled out, so a change to both at once cannot pass.
    expect(ids(folded)).toStrictEqual(ids(twice(() => traversal(V(), out('E')), g)));
    expect(ids(folded)).toStrictEqual(['b', 'c', 'f', 'd', 'b', 'd']);
  });

  it('serves `in`, and `both` through the non-CSR arm', () => {
    const g = fixture();

    for (const step of [in_('E'), both('E')]) {
      const folded = listOf(twice(() => traversal(V(), step, fold()), g));

      expect(ids(folded)).toStrictEqual(ids(twice(() => traversal(V(), step), g)));
    }
  });

  it('a hop matching nothing folds to an empty list', () => {
    expect(listOf(twice(() => traversal(V(), out('NOSUCH'), fold()), fixture()))).toStrictEqual([]);
  });

  it('the lazy iterator agrees with the drained fold', () => {
    const g = fixture();
    const make = () => traversal(V(), out('E'), fold());

    toArray(make(), g);

    const lazy = [...run(make(), g)];

    expect(lazy).toHaveLength(1);
    expect(ids(lazy[0] as unknown[])).toStrictEqual(['b', 'c', 'f', 'd', 'b', 'd']);
  });

  it('a step AFTER the element fold still runs', () => {
    const g = fixture();

    expect(toArray(traversal(V(), out('E'), fold(), limit(0)), g)).toHaveLength(0);
    expect(toArray(traversal(V(), out('E'), fold(), limit(1)), g)).toHaveLength(1);
  });
});

describe('fusableProjectedFold — what it admits', () => {
  const stepsOf = (p: ReturnType<typeof traversal>) => p.steps;

  it('admits a lone global fold', () => {
    expect(fusableProjectedFold(stepsOf(traversal(fold())))).toBe(true);
  });

  it('declines an empty residual, so the no-tail case keeps its own route', () => {
    expect(fusableProjectedFold([])).toBe(false);
  });

  it('declines a fold with anything after it', () => {
    expect(fusableProjectedFold(stepsOf(traversal(fold(), limit(1))))).toBe(false);
  });

  it('declines any other step', () => {
    expect(fusableProjectedFold(stepsOf(traversal(limit(1))))).toBe(false);
  });

  /** ⚠️ `foldProjectedList` must wrap, not flatten: one row whose value is the list. */
  it('foldProjectedList yields exactly one row holding the list', () => {
    expect(foldProjectedList([1, 2, 3])).toStrictEqual([[1, 2, 3]]);
    expect(foldProjectedList([])).toStrictEqual([[]]);
  });

  /** And it prefers a `drain` when the walk offers one — the reason the fusion is worth 3.14x. */
  it('foldProjectedList uses the walk DRAIN when present', () => {
    let drained = 0;
    const walk = {
      *[Symbol.iterator]() {
        yield 'ITERATED';
      },
      drain: () => {
        drained += 1;

        return ['DRAINED'];
      },
    };

    expect(foldProjectedList(walk)).toStrictEqual([['DRAINED']]);
    expect(drained).toBe(1);
  });
});
