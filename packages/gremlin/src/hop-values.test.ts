import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  both,
  count,
  in_,
  out,
  path,
  run,
  toArray,
  traversal,
  unfold,
  values,
} from './index.js';

// `V().out(T).values(k)` is answered by one fused walk instead of the traverser pipeline
// (audit item 170): 464-542ms down to 273-282 over 1,000,000 edges, and 14.6x behind native
// down to 8.8x.
//
// THE ORACLE IS `unfold()`. Gremlin stream ORDER is a contract — TinkerPop guarantees
// `V()`-then-adjacency and the differential fuzzer compares ordered — so the fused walk must
// produce the identical SEQUENCE, not just the same multiset. `unfold()` over a stream of
// scalars is a no-op that makes the plan four steps, so the shortcut declines and the same
// question goes through the pipeline. (`dedupe()` is NOT usable here: the frontier after
// `out()` has duplicates, which is the trap item 168 fell into.)

/** `a` has two out-edges, `b` one, `c` none; degrees are uneven on purpose. */
const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { age: 10, n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { age: 20, n: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: { age: 30, n: 3 } });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: a, to: c, labels: ['E'], properties: {} });
  g.addEdge({ id: 'e3', from: b, to: c, labels: ['F'], properties: {} });

  return g;
};

const fused = (g: Graph, ...steps: Parameters<typeof traversal>): unknown[] =>
  toArray(traversal(...steps), g);

/** The same question with a trailing no-op, which forces the pipeline. */
const piped = (g: Graph, ...steps: Parameters<typeof traversal>): unknown[] =>
  toArray(traversal(...steps, unfold()), g);

describe('the fused hop-values walk agrees with the pipeline, in order', () => {
  test('a single-type out hop', () => {
    const g = build();

    expect(fused(g, V(), out('E'), values('age'))).toEqual([20, 30]);
    expect(fused(g, V(), out('E'), values('age'))).toEqual(piped(g, V(), out('E'), values('age')));
  });

  test('the IN direction', () => {
    const g = build();

    expect(fused(g, V(), in_('E'), values('age'))).toEqual(piped(g, V(), in_('E'), values('age')));
    expect(fused(g, V(), in_('E'), values('age'))).toEqual([10, 10]);
  });

  test('BOTH, where a self-loop and the two-sided walk are at stake', () => {
    const g = build();
    const a = g.getVertexById('a')!;

    g.addEdge({ id: 'loop', from: a, to: a, labels: ['E'], properties: {} });

    // `both` goes through the general helpers precisely so this matches whatever the engine
    // does with an edge that is in both adjacency indexes.
    expect(fused(g, V(), both('E'), values('age'))).toEqual(
      piped(g, V(), both('E'), values('age')),
    );
  });

  test('an UNTYPED hop', () => {
    const g = build();

    expect(fused(g, V(), out(), values('age'))).toEqual(piped(g, V(), out(), values('age')));
    expect(fused(g, V(), out(), values('age'))).toEqual([20, 30, 30]);
  });

  test('a MULTI-TYPE hop, where the pipeline dedupes a two-type edge', () => {
    // `iterLabeled` dedupes an edge carrying two of the named types; the fused walk routes
    // multi-type through that same helper rather than re-deriving it, so this must agree.
    const g = build();
    const a = g.getVertexById('a')!;
    const c = g.getVertexById('c')!;

    g.addEdge({ id: 'both', from: a, to: c, labels: ['E', 'F'], properties: {} });

    expect(fused(g, V(), out('E', 'F'), values('age'))).toEqual(
      piped(g, V(), out('E', 'F'), values('age')),
    );
  });

  test('ORDER, not just the multiset', () => {
    // A fixture where the two differ: `a`'s targets are c then b by edge insertion, so a walk
    // that visited vertices or edges in another order would still produce {20, 30}.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { age: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { age: 20 } });
    const c = g.addVertex({ id: 'c', labels: ['P'], properties: { age: 30 } });

    g.addEdge({ id: 'e1', from: a, to: c, labels: ['E'], properties: {} });
    g.addEdge({ id: 'e2', from: a, to: b, labels: ['E'], properties: {} });

    expect(fused(g, V(), out('E'), values('age'))).toEqual([30, 20]);
    expect(fused(g, V(), out('E'), values('age'))).toEqual(piped(g, V(), out('E'), values('age')));
  });
});

describe('values() keeps its TinkerPop semantics in the fused walk', () => {
  test('an element LACKING the key is dropped, not emitted as null', () => {
    // Verified against a real TinkerPop console: `V().count()` is 6 where
    // `V().values('age').count()` is 4. A fused walk that emitted null would inflate the
    // stream — and `count()` over it would disagree with the pipeline.
    const g = build();
    const a = g.getVertexById('a')!;
    const d = g.addVertex({ id: 'd', labels: ['P'], properties: { n: 4 } });

    g.addEdge({ id: 'e4', from: a, to: d, labels: ['E'], properties: {} });

    // LENGTH and `toStrictEqual`, not `toEqual`, and that is load-bearing: a mutant that
    // yielded the missing key as `undefined` SURVIVED this test, because bun's `toEqual`
    // compares `[20, 30]` equal to `[20, 30, undefined]` — so even the comparison against the
    // piped oracle passed. An inflated stream has to be caught by its length.
    const rows = fused(g, V(), out('E'), values('age'));

    expect(rows.length).toBe(2);
    expect(rows).toStrictEqual([20, 30]);

    const viaPipeline = piped(g, V(), out('E'), values('age'));

    expect(rows.length).toBe(viaPipeline.length);
    expect(rows).toStrictEqual(viaPipeline);
    // The hop itself reaches three targets; the projection keeps two.
    expect(toArray(traversal(V(), out('E'), count()), g)).toEqual([3]);
  });

  test('a missing key is dropped on the GENERAL path too (both / multi-type)', () => {
    // The fast path and the general path have their OWN copy of the presence check, and only
    // the fast path's was covered: a mutant that emitted `undefined` from the general branch
    // survived. `both` and a multi-type hop both route there, so each needs a reachable far
    // vertex LACKING the key — fixture blindness for the fifth time in this audit.
    const g = build();
    const a = g.getVertexById('a')!;
    const d = g.addVertex({ id: 'd', labels: ['P'], properties: { n: 4 } });

    g.addEdge({ id: 'e6', from: a, to: d, labels: ['E'], properties: {} });
    g.addEdge({ id: 'e7', from: a, to: d, labels: ['F'], properties: {} });

    for (const hop of [both('E'), out('E', 'F'), out()]) {
      const rows = fused(g, V(), hop, values('age'));
      const viaPipeline = piped(g, V(), hop, values('age'));

      expect(rows.length).toBe(viaPipeline.length);
      expect(rows).toStrictEqual(viaPipeline);
      // And nothing `undefined` leaked in, which a length check alone can miss when the
      // pipeline is wrong in the same way.
      expect(rows.every((v) => v !== undefined)).toBe(true);
    }
  });

  test('a STORED null IS emitted — it is a present value, not absence', () => {
    const g = build();
    const a = g.getVertexById('a')!;
    const z = g.addVertex({ id: 'z', labels: ['P'], properties: { age: null } });

    g.addEdge({ id: 'e5', from: a, to: z, labels: ['E'], properties: {} });

    const rows = fused(g, V(), out('E'), values('age'));

    expect(rows.length).toBe(3);
    expect(rows).toStrictEqual([20, 30, null]);
    expect(rows).toStrictEqual(piped(g, V(), out('E'), values('age')));
  });

  test('a vertex with no outgoing edge of the type contributes nothing', () => {
    const g = build();

    // `c` has no `E` out-edge, and `b`'s only out-edge is `F`.
    expect(fused(g, V(), out('F'), values('age'))).toEqual([30]);
    expect(fused(g, V(), out('F'), values('age'))).toEqual(piped(g, V(), out('F'), values('age')));
  });
});

describe('the fused walk declines where it must', () => {
  test('V(ids) enumerates a given set, not the whole graph', () => {
    const g = build();

    expect(fused(g, V('a'), out('E'), values('age'))).toEqual(
      piped(g, V('a'), out('E'), values('age')),
    );
    expect(fused(g, V('a'), out('E'), values('age'))).toEqual([20, 30]);
  });

  test('values() with no key, and with two keys', () => {
    // No key emits every property value; two keys fan out per key. Both are other shapes.
    const g = build();

    expect(fused(g, V(), out('E'), values())).toEqual(piped(g, V(), out('E'), values()));
    expect(fused(g, V(), out('E'), values('age', 'n'))).toEqual(
      piped(g, V(), out('E'), values('age', 'n')),
    );
  });

  test('a path-tracking plan still carries its path', () => {
    // The fused walk emits bare values and builds no traverser, so it has no path to carry —
    // the hook is guarded on `tracksPath` for exactly this.
    const g = build();
    const withPath = toArray(traversal(V(), out('E'), values('age'), path()), g);

    expect(withPath.length).toBe(2);
    expect(Array.isArray(withPath[0])).toBe(true);
  });

  test('a longer plan is untouched', () => {
    const g = build();

    expect(toArray(traversal(V(), out('E'), values('age'), count()), g)).toEqual([2]);
  });
});

describe('the fused walk stays LAZY', () => {
  test('one value can be taken without materializing the stream', () => {
    // `run` returns an iterable and the engines already differ on laziness under a zero-row
    // slice, so an eager array here would change observable behaviour. Taking a single value
    // must work and must match the pipeline's first value.
    const g = build();
    const it = run(traversal(V(), out('E'), values('age')), g)[Symbol.iterator]();
    const first = it.next();

    expect(first.done).toBe(false);
    expect(first.value).toBe(20);
    expect(piped(g, V(), out('E'), values('age'))[0]).toBe(20);
  });

  test('the iterable is re-iterable', () => {
    // `toArray` spreads it, and a caller may spread twice; a bare generator would be exhausted.
    const g = build();
    const stream = run(traversal(V(), out('E'), values('age')), g);

    expect([...stream]).toEqual([20, 30]);
    expect([...stream]).toEqual([20, 30]);
  });
});
