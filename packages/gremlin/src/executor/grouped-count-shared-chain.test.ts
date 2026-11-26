import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, both, groupCount, out, toArray, traversal } from '../index.js';

/**
 * `V().out(T).groupCount().by(k)` AFTER item 1892 ROUTED IT THROUGH THE SHARED RUNG CHAIN.
 *
 * IT HAD ITS OWN COPY OF THE ROUTE LIST, which is why it was the Gremlin screen's slowest shape
 * at 200,000 vertices (**142.58 ms** against its own `values` twin's 71.24). Items 1883/1884/1889
 * added three rungs to `fusedProjectedValues` — one of them the CSR walk, at the TOP — and none
 * reached this call site. Kill-switch A/B at 200,000 vertices / 1,000,000 edges: **109.0 → 53.4 ms,
 * 2.04x**, with `group2` (two hops, a different rung) and `optional` flat as controls.
 *
 * **THE RISK THIS FILE EXISTS FOR IS GROUP ORDER, NOT THE COUNTS.** `groupCount` returns a
 * `Map`, whose iteration order is FIRST-OCCURRENCE order of the keys — observable, and byte-identity
 * with the Rust engine is a hard invariant. The tally now rides a different walk, so the keys are
 * first seen in that walk's order. Item 1889's oracle established that the CSR walk emits the
 * identical SEQUENCE to the bucket walk; these tests pin the consequence for the tally directly.
 *
 * AND EVERY CASE RUNS TWICE, because the CSR arm declines its own first ask (the amortization
 * policy): a single call measures the bucket walk and says nothing about the new route. Item 1891
 * lost five mutants to exactly that.
 */
const fixture = (): Graph => {
  const g = new Graph();

  // `n` repeats so there are real groups, and the ORDER the keys are first seen in differs from
  // their sorted order — otherwise a reordering would be invisible.
  for (const spec of [
    { id: 'a', n: 7 },
    { id: 'b', n: 1 },
    { id: 'c', n: 7 },
    { id: 'd', n: 3 },
    { id: 'e', n: 1 },
  ]) {
    g.addVertex({ id: spec.id, labels: ['T'], properties: { n: spec.n } });
  }

  // `f` has no `n` — `values`-style projection drops it, so it must not become a group.
  g.addVertex({ id: 'f', labels: ['T'], properties: { other: 1 } });

  for (const spec of [
    { id: 'e1', from: 'a', to: 'd', labels: ['E'] },
    { id: 'e2', from: 'a', to: 'b', labels: ['E'] },
    { id: 'e3', from: 'b', to: 'c', labels: ['E'] },
    { id: 'e4', from: 'c', to: 'f', labels: ['E'] },
    { id: 'e5', from: 'd', to: 'e', labels: ['F'] },
    { id: 'e6', from: 'e', to: 'a', labels: ['E'] },
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

/** Both calls, asserted equal — the first is the bucket walk and the second the CSR arm. */
const twice = (make: () => ReturnType<typeof traversal>, g: Graph): unknown => {
  const first = toArray(make(), g);
  const second = toArray(make(), g);

  expect(second).toStrictEqual(first);

  return second[0];
};

describe('the grouped count over a hop agrees across both routes', () => {
  it('counts each far value, dropping a far vertex that lacks the key', () => {
    const g = fixture();
    const got = twice(() => traversal(V(), out('E'), groupCount().by('n')), g);

    // `E` far ends in vertex order a, b, c, d, e, f: a->d(3), a->b(1), b->c(7), c->f(no `n`),
    // e->a(7). So 3 once, 1 once, 7 twice — and `f` is not a group at all.
    expect([...(got as Map<unknown, unknown>).entries()]).toStrictEqual([
      [3, 1],
      [1, 1],
      [7, 2],
    ]);
  });

  /**
   * THE ORDER ASSERTION, SEPARATELY. The entries above are in FIRST-OCCURRENCE order of the
   * walk — `3` before `1` before `7` — which is not the sorted order and not the insertion order of
   * the vertices. A tally riding a differently-ordered walk would still have the right counts.
   */
  it("keeps the keys in the WALK's first-occurrence order", () => {
    const g = fixture();
    const got = twice(() => traversal(V(), out('E'), groupCount().by('n')), g);

    expect([...(got as Map<unknown, unknown>).keys()]).toStrictEqual([3, 1, 7]);
  });

  it('agrees on `both`, which keeps the bucket walk', () => {
    const g = fixture();
    const got = twice(() => traversal(V(), both('E'), groupCount().by('n')), g);

    // RE-DERIVED: `n = 7` is `a` and `c`, and the undirected far ends reaching one of them are
    // b->c, b->a, d->a, e->a and f->c — five, not the three the first draft guessed.
    expect((got as Map<unknown, unknown>).get(7)).toBe(5);
  });

  it('agrees on the TWO-hop shape, which rides a different rung', () => {
    const g = fixture();
    const got = twice(() => traversal(V(), out('E'), out('E'), groupCount().by('n')), g);

    // a->d (no E out), a->b->c(7), b->c->f(no `n`), e->a->d(3), e->a->b(1).
    expect([...(got as Map<unknown, unknown>).entries()]).toStrictEqual([
      [7, 1],
      [3, 1],
      [1, 1],
    ]);
  });
});
