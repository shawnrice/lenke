import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  both,
  identity,
  in_,
  limit,
  order,
  out,
  run,
  toArray,
  traversal,
  values,
} from './index.js';

/**
 * The EAGER DRAIN ROUTE for `toArray` (item 1412).
 *
 * `hopValuesShortcut` answers `V().out(T)[.values(k)|.id()]` with one fused walk, returned as a lazy
 * generator. Item 1411 measured the generator PROTOCOL at 1.9-2.2x a plain array loop over the same
 * body, holding at 1M edges — and measured the pipeline on top of that generator at **1.00x**, so
 * the protocol is the whole gap. `toArray` is defined as `[...run(plan, graph)]`, so it already
 * drains the walk in full; taking an eager route there is the same answer by a cheaper route.
 *
 * ⚠️ `run` MUST STAY LAZY. A caller may `break` out of it, and `eager-tail-cache` records a 473x and
 * a 3680x from filling eagerly under a LIMIT. So `drain` is an ADDITION to the walk object, never a
 * replacement for its iterator, and only `toArray` reads it.
 *
 * ⚠️ ROW ORDER IS A TINKERPOP CONTRACT HERE, not an unspecified-order liberty. Unlike GQL, the
 * differential fuzzer compares Gremlin results ORDERED, so the drain must emit the same rows in the
 * same sequence as the generator — which is why every equivalence test below compares `toEqual` on
 * the whole array rather than lengths, sets or sorted copies.
 *
 * THE TESTS COME IN THREE KINDS, because no one of them is sufficient:
 *
 *   1. EQUIVALENCE — `toArray` against `[...run]`, the two routes over one plan.
 *   2. THE DECISION — `drain` present exactly where the route should be taken. An eager route is
 *      answer-preserving, so a mutant that never offers `drain` passes every equivalence test in
 *      the package; the route has to be asserted directly (the lesson item 1289 paid for).
 *   3. LAZINESS — that iterating does not go through `drain` at all.
 */

/**
 * `a(P) -> b`, `a -> c` on `E`; `b -> c` on `F`; a SELF-LOOP `c -> c` on `E`; and one edge carrying
 * BOTH labels (`a -> d`), so the multi-type walk's earlier-buckets dedupe is exercised rather than
 * merely present. `iso` has no edges. `d` has no `k`, so the `values(k)` drop path is reached.
 */
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, props: Record<string, unknown>): void => {
    g.addVertex({ id, labels: ['P'], properties: props });
  };

  v('a', { k: 1 });
  v('b', { k: 2 });
  v('c', { k: 3 });
  v('d', {}); // no `k` at all — `values('k')` must DROP it
  v('iso', { k: 9 });

  const e = (id: string, from: string, to: string, labels: string[]): void => {
    g.addEdge({ id, from: g.getVertexById(from)!, to: g.getVertexById(to)!, labels });
  };

  e('ab', 'a', 'b', ['E']);
  e('ac', 'a', 'c', ['E']);
  e('bc', 'b', 'c', ['F']);
  e('cc', 'c', 'c', ['E']); // self-loop
  e('ad', 'a', 'd', ['E', 'F']); // in BOTH buckets — the dedupe case

  return g;
};

/** Every shape that should take the route, and every near-miss that should not. */
const TAKES = {
  'bare out, one type': () => traversal(V(), out('E')),
  'out + values': () => traversal(V(), out('E'), values('k')),
  'in + values': () => traversal(V(), in_('E'), values('k')),
  'bare out, two types': () => traversal(V(), out('E', 'F')),
  'two types + values': () => traversal(V(), out('E', 'F'), values('k')),
  'two types REVERSED': () => traversal(V(), out('F', 'E'), values('k')),
  // `both` with ONE type, added at item 1432 — out-bucket then in-bucket per vertex, which is
  // `iterBoth`'s TinkerPop ordering without its four-deep generator chain.
  'both, one type': () => traversal(V(), both('E'), values('k')),
  // ⚠️ MOVED FROM `DECLINES` AT ITEM 1630, which fused a residual global `order()`: the sort now
  // drains the walk eagerly and re-exposes `drain` over the sorted array, so `toArray` does not
  // copy it a second time. Same shape as `both, one type` below — the assertion failed the moment
  // its reason stopped being true, which is the test doing its job.
  'residual order (fused at 1630)': () => traversal(V(), out('E'), values('k'), order()),
};

const DECLINES = {
  // ⚠️ `both('E')` MOVED TO `TAKES` at item 1432, which gave it a hand walk. This assertion used to
  // read "`both` uses the shared helpers rather than a hand walk, so it has no drain" — true when
  // written, and it failed the moment that stopped being true, which is the test doing its job.
  // Kept as the MULTI-TYPE case, which still falls to the general tail: `bothOneType` requires
  // exactly one label.
  'both, two types': () => traversal(V(), both('E', 'F'), values('k')),
  // A RESIDUAL: the shortcut still fires but `rest` is non-empty, so `run` wraps the values in
  // traversers and the route must not be offered. ⚠️ A GLOBAL `order()` residual is the EXCEPTION
  // since item 1630 and has moved to `TAKES`; a CAPPED one has not, because that fusion measured
  // flat and declines. `limit(2)` arrives here as its own step rather than as a cap.
  'residual limit': () => traversal(V(), out('E'), values('k'), limit(2)),
  'residual identity': () => traversal(V(), out('E'), values('k'), identity()),
};

const drainOf = (it: Iterable<unknown>): unknown => (it as { drain?: unknown }).drain;

describe('toArray and run agree, row for row and in order (item 1412)', () => {
  for (const [name, make] of Object.entries({ ...TAKES, ...DECLINES })) {
    test(`${name}: toArray === [...run]`, () => {
      const g = build();

      expect(toArray(make(), g)).toEqual([...run(make(), g)]);
    });
  }

  test('on an EMPTY graph too, where the eager accumulator starts and ends empty', () => {
    const g = new Graph();

    for (const make of Object.values(TAKES)) {
      expect(toArray(make(), g)).toEqual([...run(make(), g)]);
      expect(toArray(make(), g)).toEqual([]);
    }
  });

  test('and on a graph with vertices but NO edges', () => {
    const g = new Graph();

    g.addVertex({ id: 'lonely', labels: ['P'], properties: { k: 1 } });

    for (const make of Object.values(TAKES)) {
      expect(toArray(make(), g)).toEqual([]);
    }
  });

  test('`values(k)` DROPS the far vertex lacking `k` on both routes', () => {
    const g = build();
    // `a->d` lands on `d`, which has no `k`. Both routes must omit it rather than emit undefined.
    const eager = toArray(traversal(V(), out('E'), values('k')), g);

    expect(eager).toEqual([...run(traversal(V(), out('E'), values('k')), g)]);
    expect(eager).not.toContain(undefined);
    // The bare hop drops nothing, so it must be STRICTLY longer — `d` is reached but has no `k`.
    expect(toArray(traversal(V(), out('E')), g).length).toBeGreaterThan(eager.length);
  });

  test('the SELF-LOOP is emitted once by both routes', () => {
    const g = build();
    const vals = toArray(traversal(V(), out('E'), values('k')), g);

    // `c -> c` contributes exactly one `3`, and `a -> c` another, so `3` appears twice. Asserted
    // as a count rather than a position, since what matters is that the two routes agree and that
    // the loop is not dropped or doubled.
    expect(vals.filter((x) => x === 3)).toHaveLength(2);
    expect(vals).toEqual([...run(traversal(V(), out('E'), values('k')), g)]);
  });

  test('⚠️ the multi-type dedupe and the label-arg ORDER survive the eager route', () => {
    const g = build();
    // `ad` carries both `E` and `F`, so it is in both buckets and must be emitted ONCE. And
    // `out('F','E')` walks the buckets in the named order, which is a TinkerPop contract — so the
    // two spellings are NOT expected to be equal to each other, only each to its own lazy twin.
    const ef = traversal(V(), out('E', 'F'), values('k'));
    const fe = traversal(V(), out('F', 'E'), values('k'));

    expect(toArray(ef, g)).toEqual([...run(traversal(V(), out('E', 'F'), values('k')), g)]);
    expect(toArray(fe, g)).toEqual([...run(traversal(V(), out('F', 'E'), values('k')), g)]);
    // The dedupe: the same edge set either way, so the two orderings are permutations.
    expect([...toArray(ef, g)].sort()).toEqual([...toArray(fe, g)].sort());
  });
});

describe('THE DECISION: drain is offered exactly where the route applies (item 1412)', () => {
  // An eager route is answer-preserving, so a mutant that never offers `drain` passes every
  // equivalence test above. These assert the route itself.
  for (const [name, make] of Object.entries(TAKES)) {
    test(`${name}: offers drain`, () => {
      expect(typeof drainOf(run(make(), build()))).toBe('function');
    });
  }

  for (const [name, make] of Object.entries(DECLINES)) {
    test(`${name}: does NOT offer drain`, () => {
      expect(drainOf(run(make(), build()))).toBeUndefined();
    });
  }

  test('an empty graph still offers drain — the route is a PLAN property', () => {
    // Vacuity of the graph must not change the decision, or the route becomes data-dependent in a
    // way nothing else here accounts for.
    expect(typeof drainOf(run(traversal(V(), out('E')), new Graph()))).toBe('function');
  });
});

describe('LAZINESS: iterating never goes through drain (item 1412)', () => {
  test('a poisoned drain is not touched by iteration', () => {
    // The direct test that `run`s iterator path is independent of `drain`: replace `drain` with a
    // thrower and iterate. If iteration consulted it, this fails.
    const walk = run(traversal(V(), out('E'), values('k')), build()) as {
      drain?: () => unknown[];
    };

    walk.drain = (): unknown[] => {
      throw new Error('iteration must not consult drain');
    };

    expect([...(walk as Iterable<unknown>)].length).toBeGreaterThan(0);
  });

  test('a break after one element still works', () => {
    let seen = 0;

    for (const _ of run(traversal(V(), out('E'), values('k')), build())) {
      seen += 1;

      break;
    }

    expect(seen).toBe(1);
  });

  test('the walk is RE-ITERABLE, which the eager route must not have broken', () => {
    // `run` returns the walk object itself for this shape, and nothing says a caller iterates it
    // once. Two passes must agree.
    const walk = run(traversal(V(), out('E'), values('k')), build());

    expect([...walk]).toEqual([...walk]);
  });
});
