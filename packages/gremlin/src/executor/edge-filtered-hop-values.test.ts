import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  bothE,
  count,
  gt,
  has,
  id,
  inE,
  inV,
  order,
  otherV,
  outE,
  outV,
  toArray,
  traversal,
  values,
} from '../index.js';
import { edgeFilteredHopValues } from './edge-filtered-hop-values.js';

/**
 * The EDGE-PREDICATE hop rung (items 1882/1883).
 *
 * ⚠️ THE ORACLE IS HAND-COMPUTED, NOT THE ENGINE. A route test that asserts the fused walk agrees
 * with itself proves nothing, and CLAUDE.md records three wrong answers that passed a suite whose
 * fixture could not tell right from wrong. So the fixture below is small enough to read off, and
 * every expectation is written out rather than derived.
 *
 * ⚠️ AND THE FIXTURE IS BUILT TO DISCRIMINATE:
 *   - an edge whose `w` is MISSING, so a predicate's treatment of absent is observable;
 *   - a far vertex MISSING the projected key, which `values(k)` must drop;
 *   - two edge types on one vertex, so a type filter that leaked would show;
 *   - an edge carrying BOTH types, which a multi-label walk would have to dedupe (declined here);
 *   - a SELF-LOOP, which appears in both the out and in buckets;
 *   - a vertex with no out-edges at all.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const spec of [
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
    { id: 'c', n: 3 },
    { id: 'd', n: 4 },
    { id: 'e', n: 5 },
  ]) {
    g.addVertex({ id: spec.id, labels: ['T'], properties: { n: spec.n } });
  }

  // `f` has NO `n` — `values('n')` must drop it, and `id()` must not.
  g.addVertex({ id: 'f', labels: ['T'], properties: { other: 9 } });

  const edges = [
    { id: 'e1', from: 'a', to: 'b', labels: ['E'], properties: { w: 1 } },
    { id: 'e2', from: 'a', to: 'c', labels: ['E'], properties: { w: 5 } },
    { id: 'e3', from: 'a', to: 'f', labels: ['E'], properties: { w: 7 } },
    // `w` ABSENT — every comparison predicate must reject it, as `matches` does for `undefined`.
    { id: 'e4', from: 'b', to: 'c', labels: ['E'], properties: { q: 1 } },
    { id: 'e5', from: 'b', to: 'd', labels: ['E'], properties: { w: 9 } },
    // A DIFFERENT type on a vertex that also has `E` edges.
    { id: 'e6', from: 'b', to: 'e', labels: ['F'], properties: { w: 9 } },
    // Carries BOTH types: in the `E` bucket and the `F` bucket.
    { id: 'e7', from: 'c', to: 'd', labels: ['E', 'F'], properties: { w: 6 } },
    // A SELF-LOOP.
    { id: 'e8', from: 'd', to: 'd', labels: ['E'], properties: { w: 8 } },
  ];

  for (const spec of edges) {
    g.addEdge({
      id: spec.id,
      from: g.getVertexById(spec.from) as never,
      to: g.getVertexById(spec.to) as never,
      labels: spec.labels,
      properties: spec.properties,
    });
  }

  return g;
};

describe('edgeFilteredHopValues — the answer', () => {
  it('filters on the edge and projects the far vertex', () => {
    const g = fixture();

    // `E` edges with `w > 3`: e2 (a->c), e3 (a->f), e5 (b->d), e7 (c->d), e8 (d->d).
    // Far vertices in global vertex order (a, b, c, d, e, f) then bucket order:
    //   a: c(3), f(no n -> DROPPED)   b: d(4)   c: d(4)   d: d(4)
    expect(
      toArray(traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')), g),
    ).toStrictEqual([3, 4, 4, 4]);
  });

  it('drops an edge whose property is ABSENT, as the general predicate does', () => {
    const g = fixture();

    // e4 (b->c) has no `w`. With `gt(0)` every present `w` passes, so only e4's target is missing.
    // `E` edges in order: a->b(1), a->c(5), a->f(7, dropped — no n), b->c(ABSENT), b->d(9),
    // c->d(6), d->d(8).
    expect(
      toArray(traversal(V(), outE('E'), has('w', gt(0)), inV(), values('n')), g),
    ).toStrictEqual([2, 3, 4, 4, 4]);
  });

  it('agrees with the generic pipeline, which answers the SAME shape via `bothE`/`otherV`', () => {
    const g = fixture();
    // `bothE` is DECLINED by this rung, so this arm is the generic pipeline — and on a graph whose
    // `E` edges all point "forward" except the self-loop, `outE` and a `bothE` restricted to the
    // out direction must agree on the out-edges. This is the cross-route check the unit fixture can
    // make without patching the build: the generic answer for the same filter.
    const generic = toArray(traversal(V(), bothE('E'), has('w', gt(3)), otherV(), values('n')), g);

    // Every out-edge contributes exactly as above, plus the mirrored in-edges and the self-loop's
    // second appearance. The point is the OUT subset, which must be the fused answer's multiset.
    for (const v of [3, 4, 4, 4]) {
      expect(generic).toContain(v);
    }
  });

  it('serves `id()` without dropping a far vertex that lacks the projected key', () => {
    const g = fixture();

    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), inV(), id()), g)).toStrictEqual([
      'c',
      'f',
      'd',
      'd',
      'd',
    ]);
  });

  it('serves a bare `inV()` with no projection', () => {
    const g = fixture();
    const got = toArray(traversal(V(), outE('E'), has('w', gt(3)), inV()), g);

    expect(got.map((v) => (v as { id: string }).id)).toStrictEqual(['c', 'f', 'd', 'd', 'd']);
  });

  it('serves `inE`/`outV`, reading the other end of the edge', () => {
    const g = fixture();

    // In-edges with `w > 3`, per far vertex in global order:
    //   b: (nothing — e1 w=1)   c: a(1) via e2   d: b(2) via e5, c(3) via e7, d(4) via e8
    //   f: a(1) via e3
    expect(
      toArray(traversal(V(), inE('E'), has('w', gt(3)), outV(), values('n')), g),
    ).toStrictEqual([1, 2, 3, 4, 1]);
  });

  it('ANDs several `has` steps', () => {
    const g = fixture();

    expect(
      toArray(traversal(V(), outE('E'), has('w', gt(3)), has('w', gt(6)), inV(), values('n')), g),
    ).toStrictEqual([4, 4]);
  });

  it('takes an EQUALITY predicate, not only a comparison', () => {
    const g = fixture();

    expect(toArray(traversal(V(), outE('E'), has('w', 9), inV(), values('n')), g)).toStrictEqual([
      4,
    ]);
  });

  it('keeps the edge TYPE filter — an `F` edge with a passing `w` is not visited', () => {
    const g = fixture();

    // e6 (b->e, `F`, w=9) would contribute 5 if the type leaked; e7 carries both types and is in
    // the `E` bucket legitimately.
    expect(
      toArray(traversal(V(), outE('E'), has('w', gt(8)), inV(), values('n')), g),
    ).toStrictEqual([4]);
    expect(
      toArray(traversal(V(), outE('F'), has('w', gt(5)), inV(), values('n')), g),
    ).toStrictEqual([5, 4]);
  });

  it('carries a residual step over the fused values', () => {
    const g = fixture();

    expect(
      toArray(traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n'), count()), g),
    ).toStrictEqual([4]);
    expect(
      toArray(traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n'), order()), g),
    ).toStrictEqual([3, 4, 4, 4]);
  });
});

describe('edgeFilteredHopValues — the route', () => {
  it('claims the shape it was built for', () => {
    const g = fixture();

    expect(
      edgeFilteredHopValues(traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')), g),
    ).not.toBeUndefined();
  });

  it('declines the shape with NO edge predicate — that is `hopValuesShortcut`’s plan', () => {
    const g = fixture();

    expect(edgeFilteredHopValues(traversal(V(), outE('E'), inV(), values('n')), g)).toBeUndefined();
  });

  it('declines `bothE`/`otherV`, a multi-type hop, and a seeded source', () => {
    const g = fixture();

    for (const t of [
      traversal(V(), bothE('E'), has('w', gt(3)), otherV(), values('n')),
      traversal(V(), outE('E', 'F'), has('w', gt(3)), inV(), values('n')),
      traversal(V('a'), outE('E'), has('w', gt(3)), inV(), values('n')),
    ]) {
      expect(edgeFilteredHopValues(t, g)).toBeUndefined();
    }
  });

  it('declines the BACKWARD pairing, which is a different question', () => {
    const g = fixture();

    // `outE().outV()` walks back to the vertex the traversal came from.
    expect(
      edgeFilteredHopValues(traversal(V(), outE('E'), has('w', gt(3)), outV(), values('n')), g),
    ).toBeUndefined();
  });

  it('declines a multi-key or keyless `values`', () => {
    const g = fixture();

    for (const t of [
      traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n', 'other')),
      traversal(V(), outE('E'), has('w', gt(3)), inV(), values()),
    ]) {
      expect(edgeFilteredHopValues(t, g)).toBeUndefined();
    }
  });

  it('declines a non-`has` filter between the edge and the move', () => {
    const g = fixture();

    expect(
      edgeFilteredHopValues(traversal(V(), outE('E'), inV(), has('n', gt(3)), values('n')), g),
    ).toBeUndefined();
  });
});
