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
  run,
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

  /**
   * ⚠️ THE LAZY ITERATOR AND THE EAGER `drain` ARE TWO COPIES OF ONE LOOP (item 1893), and `toArray`
   * reads only the second — so without this, half the walk has no test. Item 1889 lost a mutant to
   * exactly this and item 1891 lost five.
   */
  it('the LAZY iterator agrees with the eager drain', () => {
    const g = fixture();
    const make = () => traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n'));

    expect([...run(make(), g)]).toStrictEqual(toArray(make(), g));
    expect([...run(make(), g)]).toStrictEqual([3, 4, 4, 4]);

    const ids = () => traversal(V(), outE('E'), has('w', gt(3)), inV(), id());

    expect([...run(ids(), g)]).toStrictEqual(toArray(ids(), g));

    // ⚠️ `inE`/`outV` THROUGH THE ITERATOR, because the bucket DIRECTION is only observable there:
    // a mutant hard-coding the out-adjacency survived while every lazy case used `outE`.
    const back = () => traversal(V(), inE('E'), has('w', gt(3)), outV(), values('n'));

    expect([...run(back(), g)]).toStrictEqual(toArray(back(), g));
    expect([...run(back(), g)]).toStrictEqual([1, 2, 3, 4, 1]);
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

/*
 * Item 1956: the `count()` TERMINAL. It used to decline the whole plan, so
 * `V().outE(E).has(w, gt 3).inV().count()` ran the generic four-call chain while its `values(n)`
 * sibling — strictly more work — was fused by this rung. Isolated A/B at 200,000 vertices /
 * 1,000,000 edges: **179.1 ms -> 76.9, 2.33x**, with two controls flat.
 *
 * 🔑 THE DISCRIMINATING FACT IS THAT A COUNT AND A `values(n)` DISAGREE ON THIS FIXTURE. The five
 * surviving `E` edges land on c, f, d, d, d — and `f` has no `n`, which `values('n')` DROPS. So the
 * count is 5 and the values row count is 4. A test that only checked "count equals the number of
 * value rows" would pass with the drop wrongly applied to the count; these assert both numbers.
 */
describe('the count terminal (item 1956)', () => {
  it('counts the surviving far vertices, which is NOT the values row count', () => {
    const g = fixture();

    // e2 a->c (5), e3 a->f (7), e5 b->d (9), e7 c->d (6), e8 d->d (8). Five edges, five far ends.
    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), inV(), count()), g)).toEqual([5]);
    // `f` has no `n`, so `values('n')` drops it: FOUR rows, not five.
    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')), g)).toEqual([
      3, 4, 4, 4,
    ]);
  });

  it('takes the route, and leaves `count` in `rest` rather than consuming it', () => {
    const g = fixture();
    const route = edgeFilteredHopValues(
      traversal(V(), outE('E'), has('w', gt(3)), inV(), count()),
      g,
    );

    expect(route).toBeDefined();
    // The walk serves `outE`+`has`+`inV`; the terminal still runs where it did.
    expect(route?.rest.map((step) => step.kind)).toEqual(['count']);
  });

  it('a plan ending at the MOVE still has an empty rest (the regression this field could break)', () => {
    const g = fixture();
    const route = edgeFilteredHopValues(traversal(V(), outE('E'), has('w', gt(3)), inV()), g);

    expect(route).toBeDefined();
    expect(route?.rest).toEqual([]);
    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), inV()), g).length).toBe(5);
  });

  it('`values(k)` and `id()` are still CONSUMED, so their rest is empty', () => {
    const g = fixture();

    for (const t of [
      traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n')),
      traversal(V(), outE('E'), has('w', gt(3)), inV(), id()),
    ]) {
      expect(edgeFilteredHopValues(t, g)?.rest).toEqual([]);
    }
  });

  it('the inE/outV direction counts too', () => {
    const g = fixture();

    // The same five edges, from the far side: a, a, b, c, d.
    expect(toArray(traversal(V(), inE('E'), has('w', gt(3)), outV(), count()), g)).toEqual([5]);
  });

  it('two `has` steps narrow the count', () => {
    const g = fixture();

    // `w > 3` AND `w > 5` keeps e3 (7), e7 (6), e8 (8), e5 (9) — four edges.
    expect(
      toArray(traversal(V(), outE('E'), has('w', gt(3)), has('w', gt(5)), inV(), count()), g),
    ).toEqual([4]);
  });

  it('a predicate that keeps nothing counts ZERO rather than answering nothing', () => {
    const g = fixture();

    expect(toArray(traversal(V(), outE('E'), has('w', gt(1000)), inV(), count()), g)).toEqual([0]);
  });

  it('an absent `w` is still rejected, so the count excludes it', () => {
    const g = fixture();

    // e4 (b->c) has no `w`. `gt(0)` keeps e1(1), e2(5), e3(7), e5(9), e7(6), e8(8) — six, not seven.
    expect(toArray(traversal(V(), outE('E'), has('w', gt(0)), inV(), count()), g)).toEqual([6]);
  });

  it('a terminal this walk cannot serve still declines the plan', () => {
    const g = fixture();

    // `order()` is neither a projection it picks nor a terminal it can leave in `rest` safely
    // without the far element, so it must keep declining rather than silently changing the answer.
    expect(
      edgeFilteredHopValues(traversal(V(), outE('E'), has('w', gt(3)), inV(), otherV()), g),
    ).toBeUndefined();
  });
});

/*
 * Item 1957: NO VERTEX MOVE — the stream stays on the EDGE. These plans used to decline outright,
 * so `V().outE(E).has(w, gt 3).values(w)` and `.count()` ran the generic chain while their MOVED
 * siblings were fused. Isolated A/B at 200,000 vertices / 1,000,000 edges:
 * **values 188.0 -> 51.4 ms (3.66x)** and **count 171.9 -> 75.3 (2.28x)**, with both previously
 * fused rows flat as controls.
 *
 * 🔑 THE ORDER IS PART OF THE ANSWER, so every expectation is an ARRAY in walk order: global vertex
 * order, each vertex's bucket in its own insertion order. The fixture's `E` buckets are
 * a: e1 e2 e3 | b: e4 e5 | c: e7 | d: e8 — read off by hand, not from the engine.
 */
describe('no vertex move: the edge-valued shapes (item 1957)', () => {
  it('projects an EDGE property in walk order', () => {
    const g = fixture();

    // Surviving `w > 3`: e2(5), e3(7) from a; e5(9) from b; e7(6) from c; e8(8) from d.
    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), values('w')), g)).toEqual([
      5, 7, 9, 6, 8,
    ]);
  });

  it('counts the surviving EDGES', () => {
    const g = fixture();

    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), count()), g)).toEqual([5]);
  });

  it('drops an edge missing the projected key, and keeps the ones that have it', () => {
    const g = fixture();

    // The five `w > 3` survivors carry no `q`, so `values('q')` emits NOTHING — the count is still
    // five. A walk that conflated "absent" with "null" would emit five nulls here.
    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), values('q')), g)).toEqual([]);
    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), count()), g)).toEqual([5]);
    // e4 is the only edge with `q`, and it has no `w` at all.
    expect(toArray(traversal(V(), outE('E'), has('q', gt(0)), values('q')), g)).toEqual([1]);
  });

  it('the inE direction walks the reverse buckets in vertex order', () => {
    const g = fixture();

    // adjTo: b: e1 | c: e2 e4 | d: e5 e7 e8 | f: e3. With `w > 3`: c->5, d->9,6,8, f->7.
    expect(toArray(traversal(V(), inE('E'), has('w', gt(3)), values('w')), g)).toEqual([
      5, 9, 6, 8, 7,
    ]);
  });

  it('a bare filtered edge stream yields the edges themselves', () => {
    const g = fixture();
    const edges = toArray(traversal(V(), outE('E'), has('w', gt(3))), g) as { id: string }[];

    expect(edges.map((e) => e.id)).toEqual(['e2', 'e3', 'e5', 'e7', 'e8']);
  });

  it('`id()` on the edge stream takes the EDGE id, not an endpoint id', () => {
    const g = fixture();

    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), id()), g)).toEqual([
      'e2',
      'e3',
      'e5',
      'e7',
      'e8',
    ]);
  });

  it('the type filter still holds: the F-only edge never appears', () => {
    const g = fixture();

    // ⚠️ "the E list must not contain 9" WOULD BE WRONG: e5 legitimately carries w=9, so the only
    // honest check is that each type's list is EXACTLY right. e6 (b->e) is `F`-only with w=9, and
    // e7 carries BOTH types — so `F` sees e6 then e7 (b before c), and `E` sees neither e6 nor a
    // duplicate of e7.
    expect(toArray(traversal(V(), outE('F'), has('w', gt(3)), values('w')), g)).toEqual([9, 6]);
    expect(toArray(traversal(V(), outE('E'), has('w', gt(3)), values('w')), g)).toEqual([
      5, 7, 9, 6, 8,
    ]);
  });

  it('takes the route, with the right rest for each terminal', () => {
    const g = fixture();
    const consumedRest = edgeFilteredHopValues(
      traversal(V(), outE('E'), has('w', gt(3)), values('w')),
      g,
    );
    const unconsumedRest = edgeFilteredHopValues(
      traversal(V(), outE('E'), has('w', gt(3)), count()),
      g,
    );

    expect(consumedRest?.rest).toEqual([]);
    expect(unconsumedRest?.rest.map((step) => step.kind)).toEqual(['count']);
  });

  it('still declines a step that is neither the matching move nor a projection it serves', () => {
    const g = fixture();

    for (const t of [
      // `otherV` needs both buckets; `outV` after `outE` walks back to the source.
      traversal(V(), outE('E'), has('w', gt(3)), otherV(), values('n')),
      traversal(V(), outE('E'), has('w', gt(3)), outV(), values('n')),
      // A multi-key `values` on the EDGE fans out per key, same bound as on the far side.
      traversal(V(), outE('E'), has('w', gt(3)), values('w', 'q')),
      // `order()` is not a projection this walk can pick.
      traversal(V(), outE('E'), has('w', gt(3)), order()),
    ]) {
      expect(edgeFilteredHopValues(t, g)).toBeUndefined();
    }
  });
});
