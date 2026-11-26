import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, both, id, in_, limit, order, out, run, toArray, traversal, values } from '../index.js';
import { hopValuesCsr, seenBefore } from './hop-values-csr.js';

/**
 * The ONE-hop CSR values walk (item 1889), and its second-call policy.
 *
 * THE ORACLE IS HAND-COMPUTED and every sequence assertion is `toStrictEqual` (item 1884 lost a
 * mutant to `toEqual`, which ignores `undefined` entries). The fixture is small enough to read off
 * and built to discriminate: a far vertex MISSING the projected key, two edge types on one vertex,
 * an edge carrying BOTH types, a self-loop, and an isolated vertex.
 */
const fixture = (): Graph => {
  const g = new Graph();

  for (const spec of [
    { id: 'a', n: 1 },
    { id: 'b', n: 2 },
    { id: 'c', n: 3 },
    { id: 'd', n: 4 },
  ]) {
    g.addVertex({ id: spec.id, labels: ['T'], properties: { n: spec.n } });
  }

  // `f` has NO `n`: `values('n')` must drop it and `id()` must not.
  g.addVertex({ id: 'f', labels: ['T'], properties: { other: 9 } });
  // `z` has no edges at all.
  g.addVertex({ id: 'z', labels: ['T'], properties: { n: 9 } });

  for (const spec of [
    { id: 'e1', from: 'a', to: 'b', labels: ['E'] },
    { id: 'e2', from: 'a', to: 'f', labels: ['E'] },
    { id: 'e3', from: 'b', to: 'c', labels: ['F'] },
    { id: 'e4', from: 'c', to: 'c', labels: ['E'] },
    // BOTH types on one edge — in the `E` bucket and the `F` bucket.
    { id: 'e5', from: 'd', to: 'a', labels: ['E', 'F'] },
  ]) {
    g.addEdge({
      id: spec.id,
      from: g.getVertexById(spec.from) as never,
      to: g.getVertexById(spec.to) as never,
      labels: spec.labels,
    });
  }

  return g;
};

/**
 * TWICE, BECAUSE THE RUNG DECLINES ITS OWN FIRST CALL. The second-call policy means a single
 * `toArray` measures the bucket walk, so every answer below is asserted on a REPEAT — and the two
 * are asserted equal, which is the real claim (the policy may not change the answer).
 */
const twice = (make: () => ReturnType<typeof traversal>, g: Graph): unknown[] => {
  const first = toArray(make(), g);
  const second = toArray(make(), g);

  expect(second).toStrictEqual(first);

  return second;
};

describe('hopValuesCsr — the answer, on the repeat call that takes it', () => {
  it('projects the far vertex, dropping one that lacks the key', () => {
    // `E` out-edges in vertex order a, b, c, d, f, z: a->b(2), a->f(DROPPED), c->c(3), d->a(1)
    expect(twice(() => traversal(V(), out('E'), values('n')), fixture())).toStrictEqual([2, 3, 1]);
  });

  it('serves `id()`, which drops nothing', () => {
    expect(twice(() => traversal(V(), out('E'), id()), fixture())).toStrictEqual([
      'b',
      'f',
      'c',
      'a',
    ]);
  });

  it('serves a bare hop', () => {
    const got = twice(() => traversal(V(), out('E')), fixture());

    expect(got.map((v) => (v as { id: string }).id)).toStrictEqual(['b', 'f', 'c', 'a']);
  });

  it('serves `in`, reading the other end', () => {
    // `E` in-edges per vertex: a <- d(4), b <- a(1), c <- c(3), f <- a(1)
    expect(twice(() => traversal(V(), in_('E'), values('n')), fixture())).toStrictEqual([
      4, 1, 3, 1,
    ]);
  });

  it('keeps the edge TYPE — an `F`-only edge is not followed', () => {
    // `F` out-edges: b->c(3) and d->a(1), the two-type edge counted ONCE.
    expect(twice(() => traversal(V(), out('F'), values('n')), fixture())).toStrictEqual([3, 1]);
  });

  /**
   * THIS TEST EXISTS BECAUSE A MUTANT SURVIVED EVERYTHING ELSE. The walk is written TWICE — a
   * lazy `[Symbol.iterator]` and an eager `drain` (item 1412: `toArray` prefers `drain`) — and an
   * off-by-one on the run bound was caught in the DRAIN and survived in the ITERATOR, because every
   * other test here goes through `toArray`. `toSet` is `new Set(run(plan, graph))`, so it consumes
   * the iterator, which is the only thing that reaches the other copy.
   */
  it('the LAZY iterator agrees with the eager drain — `toSet` consumes it', () => {
    const g = fixture();

    // Warm the policy, then spread `run` itself — which is the ITERATOR, in order, with duplicates
    // intact. `toSet` was the first attempt and it does NOT work: the off-by-one's extra reads
    // land on already-seen values, and a Set swallows them. The mutant survived it.
    expect(toArray(traversal(V(), out('E'), values('n')), g)).toStrictEqual([2, 3, 1]);
    expect([...run(traversal(V(), out('E'), values('n')), g)]).toStrictEqual([2, 3, 1]);
    expect([...run(traversal(V(), in_('E'), values('n')), g)]).toStrictEqual([4, 1, 3, 1]);
  });

  it('carries a residual step — the walk feeds it, and `drain` is not used there', () => {
    const g = fixture();

    // The first call warms the policy; both of these then ride the CSR walk with a residual.
    expect(toArray(traversal(V(), out('E'), values('n')), g)).toStrictEqual([2, 3, 1]);
    expect(toArray(traversal(V(), out('E'), values('n'), order()), g)).toStrictEqual([1, 2, 3]);
    expect(toArray(traversal(V(), out('E'), values('n'), limit(2)), g)).toStrictEqual([2, 3]);
  });
});

describe('hopValuesCsr — the route', () => {
  it('DECLINES its own first call and claims the second — the amortization policy', () => {
    const g = fixture();
    const plan = traversal(V(), out('E'), values('n'));

    expect(hopValuesCsr(plan, g)).toBeUndefined();
    expect(hopValuesCsr(plan, g)).not.toBeUndefined();
  });

  it('declines `both`, a multi-type hop, an untyped hop and a seeded source — on every call', () => {
    const g = fixture();

    for (const t of [
      traversal(V(), both('E'), values('n')),
      traversal(V(), out('E', 'F'), values('n')),
      traversal(V(), out(), values('n')),
      traversal(V('a'), out('E'), values('n')),
    ]) {
      expect(hopValuesCsr(t, g)).toBeUndefined();
      expect(hopValuesCsr(t, g)).toBeUndefined();
    }
  });

  it('declines a multi-key or keyless `values`, and a filtered start', () => {
    const g = fixture();

    for (const t of [
      traversal(V(), out('E'), values('n', 'other')),
      traversal(V(), out('E'), values()),
    ]) {
      expect(hopValuesCsr(t, g)).toBeUndefined();
      expect(hopValuesCsr(t, g)).toBeUndefined();
    }
  });
});

/**
 * THE POLICY AS A PURE FUNCTION, because a route choice is answer-equivalent and every mutant of
 * it survives the behavioural tests — [[perf-gate-needs-its-own-test]], and the same remedy item
 * 1776 applied to `unsortedPageRoute`.
 */
describe('seenBefore — the second-call policy', () => {
  it('is false the first time and true afterwards, per shape', () => {
    const g = fixture();

    expect(seenBefore(g, true, 'E')).toBe(false);
    expect(seenBefore(g, true, 'E')).toBe(true);
    expect(seenBefore(g, true, 'E')).toBe(true);
  });

  it('keys on the DIRECTION and the TYPE separately', () => {
    const g = fixture();

    expect(seenBefore(g, true, 'E')).toBe(false);
    expect(seenBefore(g, false, 'E')).toBe(false);
    expect(seenBefore(g, true, 'F')).toBe(false);
    expect(seenBefore(g, true, 'E')).toBe(true);
    expect(seenBefore(g, false, 'E')).toBe(true);
    expect(seenBefore(g, true, 'F')).toBe(true);
  });

  it('keys on the GRAPH, so two graphs do not share a generation', () => {
    const g1 = fixture();
    const g2 = fixture();

    expect(seenBefore(g1, true, 'E')).toBe(false);
    expect(seenBefore(g2, true, 'E')).toBe(false);
    expect(seenBefore(g1, true, 'E')).toBe(true);
  });

  /**
   * THE LOAD-BEARING HALF. A topology write invalidates the CSR, so the generation must reset —
   * otherwise a write/read/write/read workload would rebuild on every read, which is the case item
   * 1694 was most worried about and the reason this policy exists at all.
   */
  it('RESETS on a topology write, so a write-heavy workload never builds', () => {
    const g = fixture();

    expect(seenBefore(g, true, 'E')).toBe(false);
    expect(seenBefore(g, true, 'E')).toBe(true);

    g.addEdge({
      id: 'later',
      from: g.getVertexById('a') as never,
      to: g.getVertexById('b') as never,
      labels: ['E'],
    });

    expect(seenBefore(g, true, 'E')).toBe(false);
    expect(seenBefore(g, true, 'E')).toBe(true);
  });
});
