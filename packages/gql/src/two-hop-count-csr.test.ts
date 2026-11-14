import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  csrAskedBefore,
  twoHopCsrProduct,
  twoHopUnfilteredCsrApplies,
} from './executor/csr-cache.ts';
import { query } from './index.ts';

/**
 * THE TWO-HOP COUNT'S CSR DEGREE PRODUCT (item 1890), and its second-ask policy.
 *
 * ⚠️ THE TWO ROUTES RETURN THE SAME NUMBER, so no answer test can tell them apart — which is why
 * the gate and the policy are pure exported functions with their own tests here
 * ([[perf-gate-needs-its-own-test]]). What the answer tests pin is that the CSR arm, which only runs
 * from the SECOND ask on, agrees with the loop that answered the first.
 *
 * ⚠️ AND EVERY ANSWER IS ASSERTED ON BOTH CALLS, because a single `query` measures only the loop.
 */
const fixture = (): Graph => {
  const g = new Graph();

  // a -> b -> c, a -> b2 -> c, and d with no edges. In-degree x out-degree per middle is the count.
  for (const id of ['a', 'b', 'b2', 'c', 'd']) {
    g.addVertex({ id, labels: id === 'd' ? ['Q'] : ['P'], properties: { k: id.length } });
  }

  for (const spec of [
    { id: 'e1', from: 'a', to: 'b' },
    { id: 'e2', from: 'a', to: 'b2' },
    { id: 'e3', from: 'b', to: 'c' },
    { id: 'e4', from: 'b2', to: 'c' },
    // A second edge into `c` from `b`, so one middle has out-degree 2.
    { id: 'e5', from: 'b', to: 'c' },
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

/** Both calls, asserted equal — the first is the loop and the second the CSR arm. */
const twice = (g: Graph, q: string): unknown => {
  const first = query(g, q);
  const second = query(g, q);

  expect(second).toStrictEqual(first);

  return first[0];
};

describe('the two-hop count agrees across both routes', () => {
  it('counts the degree product over the middles', () => {
    const g = fixture();

    // Middles: b (in 1, out 2) = 2, b2 (in 1, out 1) = 1, c (in 3, out 0) = 0, a (in 0) = 0.
    expect(twice(g, 'MATCH (x)-[:E]->(y)-[:E]->(z) RETURN count(*) AS c')).toStrictEqual({ c: 3 });
  });

  it('counts a REVERSED pair of directions', () => {
    const g = fixture();

    // ⚠️ RE-DERIVED BY HAND after the first draft got this one wrong. Both legs leaving `y` makes it
    // the sum of SQUARED out-degrees: a 2^2 + b 2^2 + b2 1^2 + c 0 = 9.
    expect(twice(g, 'MATCH (x)<-[:E]-(y)-[:E]->(z) RETURN count(*) AS c')).toStrictEqual({ c: 9 });
    // Both legs ARRIVING at `y` — squared in-degrees: b 1 + b2 1 + c 3^2 = 11.
    expect(twice(g, 'MATCH (x)-[:E]->(y)<-[:E]-(z) RETURN count(*) AS c')).toStrictEqual({ c: 11 });
  });

  it('respects the EDGE TYPE', () => {
    const g = fixture();

    g.addEdge({
      id: 'f1',
      from: g.getVertexById('c') as never,
      to: g.getVertexById('d') as never,
      labels: ['F'],
    });

    // `E` then `F`: only `b`/`b2` -> c -> d, i.e. in(E) of c = 3 times out(F) of c = 1.
    expect(twice(g, 'MATCH (x)-[:E]->(y)-[:F]->(z) RETURN count(*) AS c')).toStrictEqual({ c: 3 });
    expect(twice(g, 'MATCH (x)-[:F]->(y)-[:E]->(z) RETURN count(*) AS c')).toStrictEqual({ c: 0 });
  });

  /**
   * ⚠️ THE SHAPES THE GATE REFUSES, asserted on their ANSWERS — a wrongly-widened gate would answer
   * these differently, and they are the only behavioural evidence that the refusals matter.
   */
  it('answers the refused shapes correctly — labels, `both`, and a middle constraint', () => {
    const g = fixture();

    // A non-vacuous END label: `d` carries `Q`, nothing else does.
    expect(twice(g, 'MATCH (x:P)-[:E]->(y)-[:E]->(z:Q) RETURN count(*) AS c')).toStrictEqual({
      c: 0,
    });
    // A MIDDLE label.
    expect(twice(g, 'MATCH (x)-[:E]->(y:P)-[:E]->(z) RETURN count(*) AS c')).toStrictEqual({
      c: 3,
    });
    // `both` on either leg — the undirected side is two boxes plus a loop correction. ⚠️ ALSO
    // re-derived: undirected degree times out-degree, a 2x2 + b 3x2 + b2 2x1 + c 3x0 = 12.
    expect(twice(g, 'MATCH (x)-[:E]-(y)-[:E]->(z) RETURN count(*) AS c')).toStrictEqual({ c: 12 });
    // A middle CONSTRAINT, which the loop gates once per middle. ⚠️ `k` is the id's LENGTH, so only
    // `b2` has `k = 2` — in-degree 1 times out-degree 1. (The first draft said 2, reading `b` as
    // k=2.)
    expect(
      twice(g, 'MATCH (x)-[:E]->(y)-[:E]->(z) WHERE y.k = 2 RETURN count(*) AS c'),
    ).toStrictEqual({ c: 1 });
  });

  it('still answers after a topology WRITE, which resets both caches', () => {
    const g = fixture();

    expect(twice(g, 'MATCH (x)-[:E]->(y)-[:E]->(z) RETURN count(*) AS c')).toStrictEqual({ c: 3 });

    g.addEdge({
      id: 'e6',
      from: g.getVertexById('a') as never,
      to: g.getVertexById('c') as never,
      labels: ['E'],
    });

    // `a` now reaches `c`, so `c`'s in-degree is 4 and the middles are b(1x2), b2(1x1).
    expect(twice(g, 'MATCH (x)-[:E]->(y)-[:E]->(z) RETURN count(*) AS c')).toStrictEqual({ c: 3 });
  });
});

describe('twoHopUnfilteredCsrApplies — the gate', () => {
  const ok = {
    firstBoth: false,
    secondBoth: false,
    aEff: undefined,
    cEff: undefined,
    midEff: undefined,
    gated: false,
  };
  const label = { kind: 'label', name: 'P' } as never;

  it('admits the plain unfiltered product', () => {
    expect(twoHopUnfilteredCsrApplies(ok)).toBe(true);
  });

  it('refuses an undirected leg on either side', () => {
    expect(twoHopUnfilteredCsrApplies({ ...ok, firstBoth: true })).toBe(false);
    expect(twoHopUnfilteredCsrApplies({ ...ok, secondBoth: true })).toBe(false);
  });

  it('refuses a non-vacuous label at any of the three positions', () => {
    expect(twoHopUnfilteredCsrApplies({ ...ok, aEff: label })).toBe(false);
    expect(twoHopUnfilteredCsrApplies({ ...ok, cEff: label })).toBe(false);
    expect(twoHopUnfilteredCsrApplies({ ...ok, midEff: label })).toBe(false);
  });

  it('refuses a gated middle', () => {
    expect(twoHopUnfilteredCsrApplies({ ...ok, gated: true })).toBe(false);
  });
});

describe('twoHopCsrProduct — the policy AT THE CALL SITE, not just as a function', () => {
  /**
   * ⚠️ THIS TEST EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT. Taking the CSR on the FIRST ask is
   * answer-equivalent — every behavioural test above passes either way — so the only evidence that
   * the policy is wired is the entry point returning `null` the first time and a number the second.
   * `csrAskedBefore`'s own tests below cover the function; this covers its USE.
   */
  it('declines the first ask and answers the second', () => {
    const g = fixture();
    const spec = {
      firstBoth: false,
      secondBoth: false,
      aEff: undefined,
      cEff: undefined,
      midEff: undefined,
      gated: false,
      toAOut: false,
      t1: ['E'],
      fromCOut: true,
      t2: ['E'],
    };

    expect(twoHopCsrProduct(g, spec)).toBeNull();
    expect(twoHopCsrProduct(g, spec)).toBe(3);
  });

  /**
   * ⚠️ AND THE KEY MUST NAME BOTH LEGS, which only this test can see: a coarser key would let one
   * shape's first ask pay for ANOTHER shape's build, so the second shape would be answered on its
   * own first ask. A mutant reducing the key to the first leg's direction survived everything else.
   */
  it('does not let one leg shape amortize another', () => {
    const g = fixture();
    const base = {
      firstBoth: false,
      secondBoth: false,
      aEff: undefined,
      cEff: undefined,
      midEff: undefined,
      gated: false,
      toAOut: false,
      fromCOut: true,
    };

    expect(twoHopCsrProduct(g, { ...base, t1: ['E'], t2: ['E'] })).toBeNull();
    // A DIFFERENT second leg — same directions, so a key built from direction alone would collapse
    // the two and answer this one immediately.
    expect(twoHopCsrProduct(g, { ...base, t1: ['E'], t2: ['F'] })).toBeNull();
    expect(twoHopCsrProduct(g, { ...base, t1: ['E'], t2: ['F'] })).toBe(0);
  });

  it('declines a refused shape on EVERY ask', () => {
    const g = fixture();
    const spec = {
      firstBoth: true,
      secondBoth: false,
      aEff: undefined,
      cEff: undefined,
      midEff: undefined,
      gated: false,
      toAOut: false,
      t1: ['E'],
      fromCOut: true,
      t2: ['E'],
    };

    expect(twoHopCsrProduct(g, spec)).toBeNull();
    expect(twoHopCsrProduct(g, spec)).toBeNull();
  });
});

describe('csrAskedBefore — the second-ask policy', () => {
  it('is false the first time and true afterwards, per key', () => {
    const g = fixture();

    expect(csrAskedBefore(g, '>E|>E')).toBe(false);
    expect(csrAskedBefore(g, '>E|>E')).toBe(true);
    expect(csrAskedBefore(g, '>E|<E')).toBe(false);
    expect(csrAskedBefore(g, '>E|>E')).toBe(true);
  });

  it('keys on the GRAPH', () => {
    const g1 = fixture();
    const g2 = fixture();

    expect(csrAskedBefore(g1, '>E|>E')).toBe(false);
    expect(csrAskedBefore(g2, '>E|>E')).toBe(false);
    expect(csrAskedBefore(g1, '>E|>E')).toBe(true);
  });

  /**
   * ⚠️ THE LOAD-BEARING HALF: a topology write invalidates the CSR, so the generation must reset or
   * a write/count/write/count workload would rebuild on every count — the case this policy exists
   * to avoid.
   */
  it('RESETS on a topology write', () => {
    const g = fixture();

    expect(csrAskedBefore(g, '>E|>E')).toBe(false);
    expect(csrAskedBefore(g, '>E|>E')).toBe(true);

    g.addEdge({
      id: 'later',
      from: g.getVertexById('a') as never,
      to: g.getVertexById('c') as never,
      labels: ['E'],
    });

    expect(csrAskedBefore(g, '>E|>E')).toBe(false);
    expect(csrAskedBefore(g, '>E|>E')).toBe(true);
  });
});
