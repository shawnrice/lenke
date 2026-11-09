// The far-filtered hop's flat-array drain (item 1692), and the shapes that must decline it.
//
// ⚠️ THE ORACLE IS THE SAME TRAVERSAL WITH A TRAILING `limit`, WHICH IS AN INDEPENDENT ROUTE. Any
// step after the projection lands in `rest`, and `drain` is read only when `rest` is empty, so the
// limited spelling takes the LAZY generator while the bare one takes the arm. Comparing the two is
// therefore a comparison of two routes answering one question — not two copies of my arithmetic.
//
// ⚠️ AND THE COMPARISON IS **ORDERED**. Gremlin stream order is a TinkerPop contract that the
// differential fuzzer compares ordered, unlike GQL rows whose order is unspecified. A sorted
// comparison here would pass for an arm that emits the right multiset in the wrong sequence, which
// is precisely the cross-engine failure `start-filtered-hop-values.ts` warns a "cleverer structure"
// would cause.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  V,
  both,
  eq,
  gt,
  has,
  hasLabel,
  id,
  limit,
  out,
  toArray,
  traversal,
  values,
} from '../index.js';

/**
 * ⚠️ Split on the REPEAT INDEX, not on `k` alone — items 1516/1518: a linear `(a*k+b) % N` is a
 * bijection per layer, which makes the graph FUNCTIONAL (every vertex one distinct out-neighbour)
 * while out-degree, in-degree and isolated counts all look perfect. A functional graph turns this
 * row into a chain and the arm's fan-out would never be exercised.
 */
const build = (n = 240, fanout = 4): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(
      g.addVertex({
        id: `u${i}`,
        labels: ((i * 40_503) >>> 3) % 3 === 0 ? ['User', 'Admin'] : ['User'],
        // ⚠️ Some vertices carry NO `k` at all, so `values('k')`'s drop path is exercised.
        properties: i % 11 === 0 ? { n: i } : { k: i % 7, n: i },
      }),
    );
  }

  let e = 0;

  for (let r = 0; r < fanout; r += 1) {
    for (let i = 0; i < n; i += 1) {
      const to = (i * 7 + r * 2657 + 1) % n;

      g.addEdge({ id: `e${e}`, from: vs[i], to: vs[to], labels: ['E'], properties: {} });
      e += 1;
    }
  }

  return g;
};

const g = build();

describe('⚠️ the fixture, before any agreement is believed', () => {
  test('branching exists and some vertices lack the filtered key', () => {
    expect(new Set([...g.edges].map((x) => x.to)).size).toBeGreaterThan(g.vertexCount / 2);
    expect([...g.vertices].filter((v) => v.properties.k === undefined).length).toBeGreaterThan(5);
    // The filter must keep some rows and drop some, or the case proves nothing either way.
    const kept = [...g.edges].filter((x) => x.to.properties.k === 1).length;

    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan([...g.edges].length);
  });
});

describe('the arm agrees with the lazy route, IN ORDER', () => {
  const CASES: [string, unknown[], unknown[]][] = [
    [
      'out + has + id',
      [V(), out('E'), has('k', eq(1)), id()],
      [V(), out('E'), has('k', eq(1)), id(), limit(1_000_000)],
    ],
    [
      'in + has + id',
      [V(), out('E'), has('k', eq(1)), id()],
      [V(), out('E'), has('k', eq(1)), id(), limit(1_000_000)],
    ],
    [
      'out + has + values',
      [V(), out('E'), has('k', eq(1)), values('n')],
      [V(), out('E'), has('k', eq(1)), values('n'), limit(1_000_000)],
    ],
    [
      'out + has(gt) + id',
      [V(), out('E'), has('k', gt(2)), id()],
      [V(), out('E'), has('k', gt(2)), id(), limit(1_000_000)],
    ],
    [
      'out + has, BARE hop',
      [V(), out('E'), has('k', eq(1))],
      [V(), out('E'), has('k', eq(1)), limit(1_000_000)],
    ],
    [
      'start filter + out + has + id',
      [V(), hasLabel('Admin'), out('E'), has('k', eq(1)), id()],
      [V(), hasLabel('Admin'), out('E'), has('k', eq(1)), id(), limit(1_000_000)],
    ],
    [
      'start has + out + has + values',
      [V(), has('n', gt(20)), out('E'), has('k', eq(3)), values('n')],
      [V(), has('n', gt(20)), out('E'), has('k', eq(3)), values('n'), limit(1_000_000)],
    ],
    // ⚠️ A key SOME far vertices lack: `values('k')` must drop those, and the filter must not
    // accidentally admit them.
    [
      'values on the filtered key',
      [V(), out('E'), has('k', eq(1)), values('k')],
      [V(), out('E'), has('k', eq(1)), values('k'), limit(1_000_000)],
    ],
  ];

  for (const [name, armed, lazy] of CASES) {
    test(`${name} — identical SEQUENCE, not just the same multiset`, () => {
      const a = toArray(traversal(...(armed as Parameters<typeof traversal>)), g);
      const b = toArray(traversal(...(lazy as Parameters<typeof traversal>)), g);

      expect(a).toEqual(b);
      expect(a.length).toBeGreaterThan(0);
    });
  }

  /**
   * ⚠️ THE ORDER TEST WITH TEETH: the arm walks slots in `graph.verticesById` order and each slot's
   * run in bucket order. If it instead walked, say, accepted slots first, the multiset would be
   * right and this is the only assertion that would move.
   */
  test('⚠️ the emitted sequence is not merely a permutation', () => {
    const got = toArray(traversal(V(), out('E'), has('k', eq(1)), id()), g);
    const expected: unknown[] = [];

    for (const v of g.vertices) {
      for (const edge of v.adjFrom?.get('E') ?? []) {
        if (edge.to.properties.k === 1) {
          expected.push(edge.to.id);
        }
      }
    }

    expect(got).toEqual(expected);
    // Guard against a fixture where the orders coincide: the accepted ids must not be sorted.
    expect(got).not.toEqual([...got].sort());
  });
});

describe('⚠️ the shapes that must DECLINE, each still answering correctly', () => {
  /**
   * `both` interleaves a vertex's OUT bucket then its IN bucket, so its order spans two directions
   * per vertex where one CSR run holds one — and it carries the self-loop rule items 1092/1093
   * settled. A `hasLabel` far filter and a MULTI-filter far run keep the general path too.
   */
  const CASES: [string, unknown[], unknown[]][] = [
    [
      'both + has + id',
      [V(), both('E'), has('k', eq(1)), id()],
      [V(), both('E'), has('k', eq(1)), id(), limit(1_000_000)],
    ],
    [
      'hasLabel far filter',
      [V(), out('E'), hasLabel('Admin'), id()],
      [V(), out('E'), hasLabel('Admin'), id(), limit(1_000_000)],
    ],
    [
      'two far filters',
      [V(), out('E'), has('k', eq(1)), has('n', gt(10)), id()],
      [V(), out('E'), has('k', eq(1)), has('n', gt(10)), id(), limit(1_000_000)],
    ],
  ];

  for (const [name, armed, lazy] of CASES) {
    test(`${name} — declines and still agrees in order`, () => {
      const a = toArray(traversal(...(armed as Parameters<typeof traversal>)), g);
      const b = toArray(traversal(...(lazy as Parameters<typeof traversal>)), g);

      expect(a).toEqual(b);
      expect(a.length).toBeGreaterThan(0);
    });
  }

  /** ⚠️ A SELF-LOOP under `both` is the case that exclusion exists for. */
  test('⚠️ a self-loop under both() is unaffected', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['User'], properties: { k: 1 } });
    const b = h.addVertex({ id: 'b', labels: ['User'], properties: { k: 1 } });

    h.addEdge({ id: 'loop', from: a, to: a, labels: ['E'], properties: {} });
    h.addEdge({ id: 'ab', from: a, to: b, labels: ['E'], properties: {} });

    expect(toArray(traversal(V(), both('E'), has('k', eq(1)), id()), h)).toEqual(
      toArray(traversal(V(), both('E'), has('k', eq(1)), id(), limit(1_000_000)), h),
    );
  });
});

describe('⚠️ EARLY EXIT is why the arm serves drain only', () => {
  /**
   * The arm runs a mark pass over V+E before the first row, so wiring it into the LAZY iterator
   * would destroy early exit — the 473x/3680x failure the eager-tail-cache entry records for both
   * engines. A `limit` lands in `rest`, which takes the iterator, so this asserts the limited
   * spelling is still a PREFIX of the full answer rather than something the arm reordered.
   */
  test('limit(k) returns the first k of the full sequence', () => {
    const full = toArray(traversal(V(), out('E'), has('k', eq(1)), id()), g);

    for (const k of [1, 2, 7, 50]) {
      expect(toArray(traversal(V(), out('E'), has('k', eq(1)), id(), limit(k)), g)).toEqual(
        full.slice(0, k),
      );
    }
  });
});

describe('a write between two drains is seen', () => {
  const run = (h: Graph): unknown[] => toArray(traversal(V(), out('E'), has('k', eq(1)), id()), h);

  test('an added edge is seen by the second drain', () => {
    const h = build(60, 3);

    // The first run populates the CSR cache; its value is not the assertion.
    run(h);
    h.addEdge({
      id: 'extra',
      from: h.getVertexById('u3')!,
      to: h.getVertexById('u8')!,
      labels: ['E'],
      properties: {},
    });

    const fresh = build(60, 3);

    fresh.addEdge({
      id: 'extra',
      from: fresh.getVertexById('u3')!,
      to: fresh.getVertexById('u8')!,
      labels: ['E'],
      properties: {},
    });

    expect(run(h)).toEqual(run(fresh));
  });

  /**
   * ⚠️ A PROPERTY WRITE MUST BE SEEN THOUGH `topologyVersion` DOES NOT MOVE. The accept mask reads
   * properties and is rebuilt per drain; cached on that signal it would go stale with no signal to
   * catch it.
   */
  test('⚠️ a property write changes the result with the topology unchanged', () => {
    const h = build(60, 3);
    const before = run(h);
    const tv = h.topologyVersion;

    for (const v of h.vertices) {
      v.setProperty('k', 1);
    }

    expect(h.topologyVersion).toBe(tv);

    const after = run(h);

    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toEqual(
      toArray(traversal(V(), out('E'), has('k', eq(1)), id(), limit(1_000_000)), h),
    );
  });
});

describe('⚠️ the drop sentinel, which a mutation pass found UNCOVERED', () => {
  /**
   * `M8` replaced `if (!drops || value !== undefined)` with `if (true)` and SURVIVED, because every
   * case above either projects a key the filter guarantees (`has('k', …)` then `values('k')`) or a
   * key every vertex carries. The gap is a far vertex that PASSES the filter and lacks the
   * PROJECTED key — then `values` must drop it, and without the sentinel the arm emits `undefined`.
   */
  test('a far vertex passing the filter but lacking the projected key is dropped', () => {
    const h = new Graph();
    const a = h.addVertex({ id: 'a', labels: ['User'], properties: { k: 1, m: 9 } });
    const b = h.addVertex({ id: 'b', labels: ['User'], properties: { k: 1 } });
    const c = h.addVertex({ id: 'c', labels: ['User'], properties: { k: 1, m: 7 } });

    h.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e2', from: a, to: c, labels: ['E'], properties: {} });
    h.addEdge({ id: 'e3', from: b, to: a, labels: ['E'], properties: {} });

    const armed = toArray(traversal(V(), out('E'), has('k', eq(1)), values('m')), h);

    // `b` passes `has('k', eq(1))` and has no `m`, so it contributes NO row.
    expect(armed).toEqual([7, 9]);
    expect(armed).toEqual(
      toArray(traversal(V(), out('E'), has('k', eq(1)), values('m'), limit(1_000_000)), h),
    );
  });
});
