// `V().coalesce(<one hop>, <one hop>).values(k)` fused (item 1998).
//
// ⚠️⚠️ **A ROUTE CHOICE, SO ANSWER-EQUIVALENT — the 2,435-test suite passes either way.** The route
// assertions below are the only thing that can see a gate mutant
// ([[perf-gate-needs-its-own-test]]), and the answer assertions are the only thing that can see a
// WALK mutant, because the general `coalesceStep` would answer identically.
//
// 🔑 THREE THINGS THIS FILE EXISTS FOR, each of which a naive test misses:
//
//   1. **A SINK.** `coalesce` differs from a plain hop ONLY on the rows arm 0 misses. Item 1995
//      verified that on a graph where every vertex has an arm-0 edge, `coalesce(out(E), in_(E))` is
//      POSITIONALLY IDENTICAL to a bare `out(E)` — so a fixture without a sink cannot tell this
//      route from a plain hop and a broken fallback passes.
//   2. **THREE ASKS.** The CSR arm is behind `seenBefore` (item 1889's second-ask policy), so ask 1
//      takes the BUCKET walk and asks 2+ the CSR. A single-ask test exercises half the module. Item
//      1983 lost a verdict to exactly this.
//   3. **A VERTEX MISSING THE PROJECTED KEY.** `any` is set per EDGE, before the projection, so a
//      vertex whose arm-0 edges all lack the key has still MATCHED arm 0 and emits nothing rather
//      than falling through. Setting `any` after the `drops` check would change the answer only on
//      a graph like this one.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { both, coalesce, id, identity, in_, out, toArray, traversal, V, values } from '../index.js';
import { coalesceHopValues } from './coalesce-hop-values.js';

const build = (): Graph => {
  const g = new Graph();

  for (const i of ['a', 'b', 'c', 'd', 'e', 'f']) {
    // ⚠️ `f` HAS NO `n`, which is requirement 3 above.
    g.addVertex({ id: i, labels: ['P'], properties: i === 'f' ? {} : { n: i } });
  }

  const E = (k: string, fr: string, t: string, l = 'E'): void => {
    g.addEdge({
      id: k,
      from: g.getVertexById(fr)!,
      to: g.getVertexById(t)!,
      labels: [l],
      properties: {},
    });
  };

  E('e1', 'a', 'b');
  E('e2', 'a', 'b'); // PARALLEL
  E('e3', 'b', 'c');
  E('e4', 'c', 'c'); // SELF-LOOP
  E('e5', 'd', 'a');
  E('e6', 'e', 'a', 'F'); // only an F edge — `e` is a SINK for E
  E('e7', 'a', 'f'); // reaches the key-less vertex

  return g;
};

/** Rows, asked THREE times — ask 1 is the bucket walk, asks 2-3 the CSR. All must agree. */
const stableRows = (g: Graph, make: () => ReturnType<typeof traversal>): unknown[] => {
  const one = toArray(make(), g);
  const two = toArray(make(), g);
  const three = toArray(make(), g);

  expect(two).toEqual(one);
  expect(three).toEqual(one);

  return one;
};

describe('coalesceHopValues: the route', () => {
  const g = build();
  const routed = (t: ReturnType<typeof traversal>): boolean =>
    coalesceHopValues(t, g) !== undefined;

  test('TAKES a two-arm coalesce of single hops with a single-key values', () => {
    expect(routed(traversal(V(), coalesce(out('E'), in_('E')), values('n')))).toBe(true);
  });

  test('TAKES the `id` and no-projection forms', () => {
    expect(routed(traversal(V(), coalesce(out('E'), in_('E')), id()))).toBe(true);
    expect(routed(traversal(V(), coalesce(out('E'), in_('E'))))).toBe(true);
  });

  test('DECLINES three arms', () => {
    expect(routed(traversal(V(), coalesce(out('E'), in_('E'), identity()), values('n')))).toBe(
      false,
    );
  });

  test('DECLINES a non-hop arm', () => {
    // `identity()` is not a vertex step, so this is item 1990's normalization's shape, not this one.
    expect(routed(traversal(V(), coalesce(out('E'), identity()), values('n')))).toBe(false);
    expect(routed(traversal(V(), coalesce(identity(), out('E')), values('n')))).toBe(false);
  });

  test('DECLINES a multi-step arm', () => {
    expect(routed(traversal(V(), coalesce(traversal(out('E'), out('E')), in_('E'))))).toBe(false);
  });

  test('the CSR arm waits for the SECOND ask', () => {
    // ⚠️ THIS IS A PERFORMANCE POLICY, SO IT IS ANSWER-IDENTICAL AND NO ANSWER TEST CAN SEE IT — the
    // mutation round's `csr-on-first-ask` (replacing `seenBefore(...)` with `true`) was the one
    // survivor of ten until this test existed. It needs no timing: only the CSR arm carries an
    // eager `drain`, so WHICH walk was handed back is readable straight off the returned object.
    const fresh = build();
    const ask = (): object => {
      const got = coalesceHopValues(
        traversal(V(), coalesce(out('E'), in_('E')), values('n')),
        fresh,
      );

      expect(got).toBeDefined();

      return got!.values as object;
    };

    // Ask 1 is the bucket walk — a one-shot query must not pay for a CSR build (item 1889's policy).
    expect('drain' in ask()).toBe(false);
    // Ask 2 on the same topology version gets it.
    expect('drain' in ask()).toBe(true);
  });

  test('DECLINES a narrowed source and a multi-key projection', () => {
    expect(routed(traversal(V('a'), coalesce(out('E'), in_('E')), values('n')))).toBe(false);
    expect(routed(traversal(V(), coalesce(out('E'), in_('E')), values('n', 'x')))).toBe(false);
  });
});

describe('coalesceHopValues: the answers', () => {
  test('arm 1 runs for each SINK, and the TWO kinds of sink differ', () => {
    const g = build();
    const rows = stableRows(g, () => traversal(V(), coalesce(out('E'), in_('E')), values('n')));
    const bare = toArray(traversal(V(), out('E'), values('n')), g);

    // ⚠️ THIS FIXTURE HAS BOTH KINDS OF SINK, and a route can be broken for one and right for the
    // other. `e`'s only edge is an F, so arm 1 misses it too and it emits NOTHING. `f`'s only E
    // edge is INBOUND (`a -> f`), so arm 1 finds it and emits `a`. An assertion that the answer
    // equals the bare hop — which is what this test said first — holds only if the graph has no
    // second-kind sink, and item 1995's whole finding was that such a graph cannot distinguish
    // this route from a plain hop.
    expect(rows).toEqual([...bare, 'a']);
    expect(rows).toHaveLength(bare.length + 1);
  });

  test('arm 1 SUPPLIES rows a plain hop would not', () => {
    const g = build();
    // Arm 0 is `out('F')`, which only `e` has — so every other vertex falls through to `out('E')`.
    const rows = stableRows(g, () => traversal(V(), coalesce(out('F'), out('E')), values('n')));

    // `e`'s own row is present AND the fallback rows are, which a plain `out('F')` would not give.
    expect(rows).toContain('a');
    expect(rows.length).toBeGreaterThan(toArray(traversal(V(), out('F'), values('n')), g).length);
  });

  test('a vertex whose arm-0 edges all lack the key emits NOTHING, not a fallback', () => {
    const g = new Graph();

    g.addVertex({ id: 'x', labels: ['P'], properties: { n: 'x' } });
    g.addVertex({ id: 'y', labels: ['P'], properties: {} }); // no `n`
    g.addEdge({
      id: 'xy',
      from: g.getVertexById('x')!,
      to: g.getVertexById('y')!,
      labels: ['E'],
      properties: {},
    });
    g.addEdge({
      id: 'yx',
      from: g.getVertexById('y')!,
      to: g.getVertexById('x')!,
      labels: ['E'],
      properties: {},
    });

    // `x`'s only arm-0 edge reaches `y`, which has no `n`. `x` MATCHED arm 0, so it must emit
    // nothing — NOT fall through to arm 1 and emit `y`'s in-neighbour. A route that set `any` after
    // the `drops` check would emit an extra row here and nowhere else.
    const rows = stableRows(g, () => traversal(V(), coalesce(out('E'), in_('E')), values('n')));

    expect(rows).toEqual(toArray(traversal(V(), out('E'), values('n')), g));
  });

  test('`both`, multi-type and untyped arms agree across all three asks', () => {
    const g = build();

    // These three take the BUCKET walk on every ask — `soleTypeBucket` refuses them and the CSR arm
    // declines them — so this is the cold path's own stability check.
    for (const make of [
      () => traversal(V(), coalesce(both('E'), out('E')), values('n')),
      () => traversal(V(), coalesce(out('E', 'F'), out('E')), values('n')),
      () => traversal(V(), coalesce(out(), out('E')), values('n')),
    ]) {
      expect(stableRows(g, make).length).toBeGreaterThan(0);
    }
  });

  test('PARALLEL edges and a SELF-LOOP keep their multiplicity', () => {
    const g = build();
    const rows = stableRows(g, () => traversal(V(), coalesce(out('E'), in_('E')), values('n')));

    // `a` has two parallel edges to `b`.
    expect(rows.filter((x) => x === 'b')).toHaveLength(2);
    // `b -> c` and `c -> c` both land on `c`.
    expect(rows.filter((x) => x === 'c')).toHaveLength(2);
  });
});
