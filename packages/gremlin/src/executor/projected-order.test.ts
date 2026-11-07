import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import {
  V,
  both,
  dedupe,
  gt,
  has,
  id,
  identity,
  limit,
  order,
  Order,
  out,
  run,
  Scope,
  toArray,
  traversal,
  values,
} from '../index.js';
import { fusableProjectedOrder } from './aggregation.js';

/**
 * A fused hop walk whose residual is nothing but a global `order()` sorts the walk's raw values in
 * place (item 1630) — **2.35x** on `V().out(T).values(k).order()` and 2.23x on the descending
 * spelling, at 200,000 vertices / 1M edges, with `hopvaluesrows`, `hopbare` and `hopidrows` flat.
 *
 * ⚠️ ITEM 1394 CLOSED THIS ROW, correctly, and this does not re-attempt anything on its list. It
 * priced `evalBy` at 0.1% (refuted), the comparator at ~4.3% and `[...stream]` at ~5%. What it could
 * not price is a composite ROUTE: `hopValuesShortcut` consumed `[V, hop, values]` and handed back
 * `rest = [order]`, so a million raw values were wrapped in traversers one at a time, spread back
 * into an array by `orderStep`, and given a `{item, key}` wrapper plus three more passes by
 * `sortByBys` — when the walk already produces exactly the array the sort wants.
 *
 * ⚠️ THE ORACLE IS A TRAILING `identity()`. `rest.length !== 1` declines the fusion, so
 * `…values(k).order().identity()` asks the identical question down the general path. Gremlin stream
 * order is a TinkerPop contract compared ORDERED by the differential fuzzer, so every comparison
 * below is element for element.
 *
 * The fixture, and every literal in this file is derived from it. `>` is an `E` edge, in INSERTION
 * order, which is the order each bucket is walked in:
 *
 * ```text
 *   a  k=3      >b >c
 *   b  k=1      >d
 *   c  k=null   >e
 *   d  k=1      >f        a TIE with b
 *   e  (NO k)   >a        `values(k)` DROPS a far end lacking the key
 *   f  k=2      >f        a SELF-LOOP
 * ```
 */
const TABLE = [
  { id: 'a', k: 3, out: ['b', 'c'] },
  { id: 'b', k: 1, out: ['d'] },
  { id: 'c', k: null, out: ['e'] },
  { id: 'd', k: 1, out: ['f'] },
  { id: 'e', k: undefined, out: ['a'] },
  { id: 'f', k: 2, out: ['f'] },
] as const;

const g = ((): Graph => {
  const graph = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = { id: r.id };

    // ⚠️ `e` carries NO `k` AT ALL, which is not the same as `k: null`: `values(k)` drops the first
    // and emits the second, and `compareTotal` sorts a null FIRST. Both are in the fixture.
    if (r.k !== undefined) {
      properties.k = r.k;
    }

    graph.addVertex({ id: r.id, labels: ['P'], properties });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const to of r.out) {
      graph.addEdge({
        id: `e${n++}`,
        from: graph.getVertexById(r.id) as Vertex,
        to: graph.getVertexById(to) as Vertex,
        labels: ['E'],
        properties: {},
      });
    }
  }

  return graph;
})();

/**
 * DERIVED, per vertex in insertion order, far end by far end:
 *
 * ```text
 *   a > b(1), c(null)   b > d(1)   c > e(NO k, dropped)
 *   d > f(2)            e > a(3)   f > f(2)
 * ```
 *
 * so the walk emits `[1, null, 1, 2, 3, 2]` — six values, not seven, because `c`'s far end has no
 * `k`.
 */
const UNSORTED = [1, null, 1, 2, 3, 2];
/** Nulls FIRST (TinkerPop's `ORDERABILITY`), then 1, 1, 2, 2, 3. */
const ASC = [null, 1, 1, 2, 2, 3];
/** `desc` negates the SAME comparison, so the null lands last. */
const DESC = [3, 2, 2, 1, 1, null];

describe('the fused sort answers what the general path answers', () => {
  test('the walk really does emit the six values the literals are derived from', () => {
    expect(toArray(traversal(V(), out('E'), values('k')), g)).toEqual(UNSORTED);
  });

  test('ascending — the shape at 2.35x', () => {
    expect(toArray(traversal(V(), out('E'), values('k'), order()), g)).toEqual(ASC);
    // The oracle: a trailing `identity()` pushes `rest` to length 2 and declines the fusion.
    expect(toArray(traversal(V(), out('E'), values('k'), order(), identity()), g)).toEqual(ASC);
  });

  test('⚠️ descending via `Order.desc`, the spelling item 1591 got wrong', () => {
    /**
     * `order(Order.desc)` arrives as `bys: [{kind:'identity', direction:'desc'}]`, NOT as
     * `desc: true`. Item 1591's first gate refused any `bys`, which made its own `desc` parameter
     * dead code — the descending form silently took the unfused path while its tests appeared to
     * cover the fused one. A LITERAL is what caught that, so there is a literal here.
     */
    expect(toArray(traversal(V(), out('E'), values('k'), order(Order.desc)), g)).toEqual(DESC);
    expect(
      toArray(traversal(V(), out('E'), values('k'), order(Order.desc), identity()), g),
    ).toEqual(DESC);
  });

  test('`in` and `both` walks sort too, and agree with their oracles', () => {
    const inFast = toArray(traversal(V(), out('E'), values('k'), order()), g);
    const inSlow = toArray(traversal(V(), out('E'), values('k'), order(), identity()), g);

    expect(inFast).toEqual(inSlow);

    // `both(E)` has its own hand walk in `hop-values.ts` and emits a self-loop TWICE.
    const bothFast = toArray(traversal(V(), both('E'), values('k'), order()), g);
    const bothSlow = toArray(traversal(V(), both('E'), values('k'), order(), identity()), g);

    expect(bothFast).toEqual(bothSlow);
    expect(bothFast.length).toBeGreaterThan(UNSORTED.length);
  });

  test('the TWO-HOP walk (item 1614) feeds the sort as well', () => {
    /**
     * DERIVED two hops deep: `a>b>d`(1), `a>c>e`(no k, dropped), `b>d>f`(2), `c>e>a`(3),
     * `d>f>f`(2), `e>a>b`(1), `e>a>c`(null), `f>f>f`(2) — seven values, so
     * `[null, 1, 1, 2, 2, 2, 3]`.
     */
    expect(toArray(traversal(V(), out('E'), out('E'), values('k'), order()), g)).toEqual([
      null,
      1,
      1,
      2,
      2,
      2,
      3,
    ]);
    expect(
      toArray(traversal(V(), out('E'), out('E'), values('k'), order(), identity()), g),
    ).toEqual([null, 1, 1, 2, 2, 2, 3]);
  });

  test('the START-FILTERED walk (item 1535) feeds the sort as well', () => {
    /**
     * DERIVED. `has('k', gt(1))` keeps only `a`(3) and `f`(2): `c`'s `k` is null, `e` has none, and
     * `b`/`d` are 1. So `a > b(1), c(null)` and `f > f(2)` — `[null, 1, 2]`.
     */
    expect(toArray(traversal(V(), has('k', gt(1)), out('E'), values('k'), order()), g)).toEqual([
      null,
      1,
      2,
    ]);
    expect(
      toArray(traversal(V(), has('k', gt(1)), out('E'), values('k'), order(), identity()), g),
    ).toEqual([null, 1, 2]);
  });

  test('`toArray` (which reads `drain`) and `run` (which does not) agree', () => {
    // `toArray` takes the eager `drain` the fusion exposes; spreading `run` takes the generator.
    expect(toArray(traversal(V(), out('E'), values('k'), order()), g)).toEqual([
      ...run(traversal(V(), out('E'), values('k'), order()), g),
    ]);
  });

  test('constructing does no work, and a consumer may BREAK early', () => {
    // `order-step-laziness.test.ts` pins this contract for the general path; the fusion's iterator
    // is a generator for the same reason, and an eager `return sorted()` would break it.
    const stream = run(traversal(V(), out('E'), values('k'), order()), g);
    const first: unknown[] = [];

    for (const v of stream) {
      first.push(v);

      if (first.length === 2) {
        break;
      }
    }

    expect(first).toEqual([null, 1]);
  });
});

describe('the fusion declines what it must, and the answer is unchanged', () => {
  test('⚠️ an ELEMENT stream still throws — but from the STATIC check, not from the sort', () => {
    /**
     * ⚠️ THIS TEST PASSES FOR A DIFFERENT REASON THAN I WROTE IT FOR, and the difference matters.
     * I expected `sortByBys`' element pass to raise, which would make the value-mode gate the one
     * correctness question in the change. It is `assertFrontierTypes` that raises, at PLAN-CHECK
     * time, before any route is chosen — the stack is `checkStep` / `checkSteps` /
     * `assertFrontierTypes` / `run`. So an element walk cannot reach the sort at all, and the
     * value-mode gate is CONSERVATIVE rather than load-bearing — removing it is answer-equivalent
     * through the public API. The mutant is caught anyway, by the GATE's unit test below rather than
     * by anything here, which is the only instrument that can fail on a route choice.
     *
     * That is exactly the shape of the trap `fusedValuesTopK` documents for its own unreachable
     * guard, and of the test item 1576 shipped that covered a parse-time check while claiming the
     * runtime path. Recorded here rather than left implied, because the next reader of the gate
     * would otherwise trust the comment I first wrote.
     */
    expect(() => toArray(traversal(V(), out('E'), order()), g)).toThrow(
      /elements have no natural order/,
    );
  });

  test('`id()` mode declines and is still sorted correctly', () => {
    /**
     * DERIVED far-end ids: `a > b, c`; `b > d`; `c > e`; `d > f`; `e > a`; `f > f` — seven ids
     * `[b, c, d, e, f, a, f]`, sorted `[a, b, c, d, e, f, f]`. Nothing is dropped here: `id()` has
     * no missing-key case.
     */
    expect(toArray(traversal(V(), out('E'), id(), order()), g)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'f',
    ]);
  });

  test('a CAPPED order declines, and that is measured rather than assumed', () => {
    /**
     * `fuseOrderTake` folds the `limit` into the order as a `cap`, and `orderStep` already takes a
     * streaming top-k for it. Routing the cap through this fusion as well measured **FLAT** —
     * `hopordercap` 2988.4 ms PRE against 3035.2 / 2977.6 POST — so the cap declines and item 1591's
     * path keeps it. The answer is the first two of `ASC`.
     */
    expect(toArray(traversal(V(), out('E'), values('k'), order(), limit(2)), g)).toEqual([null, 1]);
  });

  test('`values(a, b)` declines — two keys fan out per element, a different shape', () => {
    const fast = toArray(traversal(V(), out('E'), values('k', 'id'), order()), g);
    const slow = toArray(traversal(V(), out('E'), values('k', 'id'), order(), identity()), g);

    expect(fast).toEqual(slow);
  });

  test('⚠️ a residual AFTER the `order` is not dropped', () => {
    /**
     * The oracle spelling above puts `identity()` after the sort, which is answer-equivalent — so a
     * mutant that stopped checking `rest.length` would survive every test that uses it. `dedupe()`
     * is not: DERIVED from `ASC` = [null, 1, 1, 2, 2, 3], distinct is [null, 1, 2, 3], and a route
     * that consumed the whole residual would return all six.
     */
    expect(toArray(traversal(V(), out('E'), values('k'), order(), dedupe()), g)).toEqual([
      null,
      1,
      2,
      3,
    ]);
  });

  test('the legacy `key` form declines — and a mutant admitting it SURVIVES', () => {
    /**
     * ⚠️ MEASURED, not assumed: `order({key: 'k'})` over a stream of numbers answers EXACTLY `ASC`,
     * because `evalBy` falls back to the value itself when the key cannot be projected off a
     * non-element. So admitting the key form into a sort-by-value is answer-equivalent on any
     * fixture this walk can produce, and the gate's `key` check is a narrowing choice rather than a
     * correctness one. The literal is here so the DECLINED path's answer is pinned either way.
     */
    expect(toArray(traversal(V(), out('E'), values('k'), order({ key: 'k' })), g)).toEqual(ASC);
  });

  test('⚠️ the ROUTE is asserted through `drain`, not inferred from the answer', () => {
    /**
     * A route choice is answer-equivalent, so `route/never-fires` and an off-by-one on the
     * last-consumed-step index both survive every assertion above. The fusion's return value
     * exposes `drain` (item 1412's eager terminal) and the general path's `unwrap` generator does
     * not, which makes the route OBSERVABLE.
     */
    const fused = run(traversal(V(), out('E'), values('k'), order()), g) as {
      drain?: () => unknown[];
    };
    const general = run(traversal(V(), out('E'), values('k'), order(), identity()), g) as {
      drain?: () => unknown[];
    };

    expect(typeof fused.drain).toBe('function');
    expect(general.drain).toBeUndefined();
    // And a DECLINED shape must not be on it either, for a reason the answer cannot show: `id()`
    // mode sorts strings, which a raw sort would get right, so only the route is observable.
    const ids = run(traversal(V(), out('E'), id(), order()), g) as { drain?: () => unknown[] };

    expect(ids.drain).toBeUndefined();
  });

  test('a local-scope sort declines', () => {
    /**
     * `order(Scope.local)` sorts WITHIN each value; over scalars it passes them through unchanged,
     * so the walk's own order survives.
     *
     * ⚠️ IT MUST BE THE SYMBOL. `order('local')` is silently accepted as a CONFIG OBJECT — the
     * overload is `order(symbol)` or `order({key?, desc?})`, and a string has neither field, so it
     * reads as a bare `order()` and sorts GLOBALLY. That spelling is what this test asserted first,
     * and it failed by returning the correctly-sorted stream.
     */
    expect(toArray(traversal(V(), out('E'), values('k'), order(Scope.local)), g)).toEqual(UNSORTED);
  });
});

/**
 * ⚠️ THE GATE AS A PURE FUNCTION, because a route choice is ANSWER-EQUIVALENT and every
 * `route/never-fires` mutant therefore survives the differential tests above by construction (item
 * 1619 recorded that for all twenty GQL rungs). These are the assertions that can fail on one.
 */
describe('fusableProjectedOrder', () => {
  const ORDER = { kind: 'order' } as const;
  const VALUES1 = { kind: 'values', keys: ['k'] } as const;

  test('admits the shape, with `desc` false', () => {
    expect(fusableProjectedOrder([ORDER], VALUES1)).toEqual({ desc: false });
  });

  test('reads `desc` from BOTH spellings', () => {
    expect(fusableProjectedOrder([{ kind: 'order', desc: true }], VALUES1)?.desc).toBe(true);
    expect(
      fusableProjectedOrder(
        [{ kind: 'order', bys: [{ kind: 'identity', direction: 'desc' }] }],
        VALUES1,
      )?.desc,
    ).toBe(true);
    // An identity by with an ASCENDING direction is still this shape, and must not read as desc.
    expect(
      fusableProjectedOrder(
        [{ kind: 'order', bys: [{ kind: 'identity', direction: 'asc' }] }],
        VALUES1,
      )?.desc,
    ).toBe(false);
  });

  test('⚠️ declines a CAP, on a measured flat result rather than a judgement', () => {
    // `hopordercap` 2988.4 / 3335.4 / 2942.1 ms PRE against 3035.2 / 2977.6 / 2988.6 POST when the
    // cap was admitted: flat, because a capped order never materialized and that is what this
    // change removes. So it keeps item 1591's streaming top-k.
    expect(fusableProjectedOrder([{ kind: 'order', cap: 10 }], VALUES1)).toBeUndefined();
  });

  test('declines a residual that is not exactly one `order`', () => {
    expect(fusableProjectedOrder([], VALUES1)).toBeUndefined();
    expect(fusableProjectedOrder([ORDER, { kind: 'identity' }], VALUES1)).toBeUndefined();
    expect(fusableProjectedOrder([{ kind: 'identity' }], VALUES1)).toBeUndefined();
  });

  test('declines a local scope, a legacy `key`, and a non-identity `by`', () => {
    expect(fusableProjectedOrder([{ kind: 'order', scope: 'local' }], VALUES1)).toBeUndefined();
    expect(fusableProjectedOrder([{ kind: 'order', key: 'k' }], VALUES1)).toBeUndefined();
    expect(
      fusableProjectedOrder([{ kind: 'order', bys: [{ kind: 'key', key: 'k' }] }], VALUES1),
    ).toBeUndefined();
    // TWO bys are tie-breakers, which the identity form cannot express.
    expect(
      fusableProjectedOrder(
        [{ kind: 'order', bys: [{ kind: 'identity' }, { kind: 'identity' }] }],
        VALUES1,
      ),
    ).toBeUndefined();
  });

  test('⚠️ declines unless the LAST CONSUMED step is a single-key `values`', () => {
    // This is the element-mode gate, and it is the one correctness question in the whole change.
    expect(fusableProjectedOrder([ORDER], undefined)).toBeUndefined();
    expect(fusableProjectedOrder([ORDER], { kind: 'id' })).toBeUndefined();
    expect(fusableProjectedOrder([ORDER], { kind: 'out', labels: ['E'] })).toBeUndefined();
    expect(fusableProjectedOrder([ORDER], { kind: 'values', keys: ['k', 'n'] })).toBeUndefined();
    expect(fusableProjectedOrder([ORDER], { kind: 'values', keys: [] })).toBeUndefined();
  });
});
