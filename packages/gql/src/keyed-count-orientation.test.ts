import { describe, expect, test } from 'bun:test';

/**
 * `keyedCountOf` with the shared variable at EITHER end — item 1863.
 *
 * The rung answered `MATCH (a)-[:E]->(q), (b)-[:E]->(q)` — shared ENDPOINT, `SUM indeg^2` — in
 * closed form, and refused the mirror `MATCH (a)-[:E]->(b), (a)-[:E]->(c)`, shared START,
 * `SUM outdeg^2`. Same identity, same machinery, 125x apart (0.2 ms against 25.0 at 3,200
 * vertices), and the gap grows with degree because one side sums squares and the other enumerates
 * pairs.
 *
 * ⚠️⚠️ **ITEM 1864 SHADOWED THE START-START SHAPE, AND THIS FILE SAYS SO RATHER THAN QUIETLY
 * PASSING.** That item splices `(a)-[:E]->(b), (a)-[:E]->(c)` into the single pattern
 * `(b)<-[:E]-(a)-[:E]->(c)` BEFORE any rung is offered the clause list, so the start-start cases
 * below now take the CHAIN count rung and never reach `keyedCountOf` at all — their
 * `takesTheRung` assertions still pass, for a different reason than they were written for. The
 * MIXED case is what still uniquely exercises this item's widening, because the splice declines it
 * (the two patterns start on different variables). Keep the mixed case if these are ever pruned.
 *
 * ⚠️ **A RING FIXTURE CANNOT CHECK THIS, which `keyedCountOf`'s own doc says in terms**: with every
 * degree 1, `SUM d^2`, `SUM d` and the edge count all coincide, so a wrong formula agrees with a
 * right one. The fixture below is a STAR with uneven out-degrees (3, 2, 1, 0) whose squares
 * (9 + 4 + 1 + 0 = 14) differ from their sum (6) and from any other plausible formula.
 *
 * ⚠️ **AND THE ORACLE IS THE GENERAL MATCHER, not arithmetic I write here.** Every case asserts
 * against the same query with a `WHERE true` on the clause — which `keyedCountOf` refuses outright
 * ("a clause WHERE can correlate the two sides") and which cannot change the answer. So the two
 * arms are the same question down two different routes, which is what a route change has to
 * preserve; the closed-form numbers are stated as well, so that two routes making the same mistake
 * cannot agree their way to a pass.
 */
import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

/**
 * ⚠️ THE ROUTE IS ASSERTED, NOT INFERRED FROM THE ANSWER. Every case below returns the same number
 * down the general matcher, so a test that only checked answers would pass just as well with this
 * item reverted — which is `perf-gate-needs-its-own-test`'s whole point. `countShortcut` being a
 * FUNCTION is what says the closed form was selected.
 */
const takesTheRung = (src: string): boolean => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return typeof cl.countShortcut === 'function';
};

/**
 * ⚠️ THIS FIXTURE IS BUILT TO MAKE WRONG FORMULAS DISAGREE, which the first version did not: three
 * mutants SURVIVED against it because the right and wrong answers COINCIDED. Each addition below
 * exists to break one of those coincidences, and the mutant it kills is named.
 *
 *   - `t0`/`t1` carry `:U` as well as `:T`, so a far-side label selects a NON-EMPTY subset. With
 *     nothing labelled `:U`, the far-label case was 0 whether the label was read off the far node
 *     or the key, and `far label read off the KEY node` survived.
 *   - `t0 -E-> s0` gives `s0` an in-edge that is NOT a self-loop. Without it, in-degree and
 *     self-loop count were equal at `s0` and `self-loop pattern ADMITTED` survived.
 *   - the `n` properties are distinct, so an INLINE constraint can be written on either end; with
 *     no inline test at all, `key/far swapped for the INLINE predicates` survived.
 *
 * Out-degrees under `:E` are s0=3, s1=3 (e4 and e7 are parallel), s2=1, s3=0, t0=1 — so SUM d^2 is
 * 9+9+1+0+1 = 20, where SUM d would be 8. In-degrees are t0=3, t1=3, t2=1, s0=1: SUM d^2 = 20 too.
 */
const build = (): Graph => {
  const g = new Graph();

  for (const id of ['s0', 's1', 's2', 's3', 't2']) {
    g.addVertex({ id, labels: ['T'], properties: { n: id } });
  }

  // `:U` as a SECOND label, so a far-side `:U` is selective rather than vacuous.
  for (const id of ['t0', 't1']) {
    g.addVertex({ id, labels: ['T', 'U'], properties: { n: id } });
  }

  const edge = (id: string, from: string, to: string, label: string): void => {
    const f = g.getVertexById(from);
    const t = g.getVertexById(to);

    if (f === null || t === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id, from: f, to: t, labels: [label] });
  };

  edge('e0', 's0', 't0', 'E');
  edge('e1', 's0', 't1', 'E');
  edge('e2', 's0', 't2', 'E');
  edge('e3', 's1', 't0', 'E');
  edge('e4', 's1', 't1', 'E');
  edge('e5', 's2', 't0', 'E');
  edge('e6', 's0', 't0', 'F'); // a different type
  edge('e7', 's1', 't1', 'E'); // PARALLEL to e4 — a hop counts EDGES, not neighbours
  edge('e8', 't0', 's0', 'E'); // s0 gains a NON-self-loop in-edge

  return g;
};

const countOf = (g: Graph, text: string): number => {
  const [row] = query(g, text);

  return row.c as number;
};

/**
 * The same query with a clause `WHERE true`, which `keyedCountOf` refuses and which cannot change
 * the answer — so it is the general matcher's reading of the identical question.
 */
const viaGeneral = (g: Graph, text: string): number =>
  countOf(g, text.replace(' RETURN ', ' WHERE true RETURN '));

describe('the shared variable may be either end of both patterns', () => {
  /**
   * Out-degrees under `:E` are s0=3, s1=3 (e4 and e7 are parallel), s2=1, s3=0, and the targets
   * have 0 — so SUM d^2 = 9 + 9 + 1 = 19, where SUM d would be 7.
   */
  test('shared START — the out-star, which had no rung', () => {
    const g = build();
    const q = 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN count(*) AS c';

    expect(takesTheRung(q)).toBe(true);
    expect(countOf(g, q)).toBe(20);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });

  /** In-degrees under `:E` are t0=3, t1=3, t2=1 — SUM d^2 = 19 again, by symmetry of this star. */
  test('shared END — the in-star, which already had one', () => {
    const g = build();
    const q = 'MATCH (a:T)-[:E]->(q:T), (b:T)-[:E]->(q) RETURN count(*) AS c';

    expect(takesTheRung(q)).toBe(true);
    expect(countOf(g, q)).toBe(20);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });

  /**
   * MIXED: `a` is the START of one pattern and the END of the other, so the product is
   * outdeg x indeg. Only s0..s2 have out-edges and only t0..t2 have in-edges, and no vertex has
   * both — so the answer is 0, which is a real and easily-broken case.
   */
  test('MIXED orientation — out-degree times in-degree', () => {
    const g = build();
    const q = 'MATCH (a:T)-[:E]->(b:T), (c:T)-[:E]->(a) RETURN count(*) AS c';

    expect(takesTheRung(q)).toBe(true);
    expect(countOf(g, q)).toBe(6);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });

  /** A TYPE filter on one side only: s0's `F` out-degree is 1, so 3*1 for s0 and 0 elsewhere. */
  test('the two sides may carry different edge types', () => {
    const g = build();
    const q = 'MATCH (a:T)-[:E]->(b:T), (a)-[:F]->(c:T) RETURN count(*) AS c';

    expect(takesTheRung(q)).toBe(true);
    expect(countOf(g, q)).toBe(3);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });

  /**
   * ⚠️ A FAR-SIDE LABEL must filter the counted edges rather than being ignored. Nothing carries
   * `:U`, so every product collapses to zero — and a rung that dropped the far label would return
   * 19 here.
   */
  test('a far-side label filters the count', () => {
    const g = build();
    const q = 'MATCH (a:T)-[:E]->(b:U), (a)-[:E]->(c:T) RETURN count(*) AS c';

    expect(countOf(g, q)).toBe(16);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });

  /**
   * ⚠️ A SELF-LOOP PATTERN IS REFUSED, not answered. `(a)-[:E]->(a)` has the key at BOTH ends;
   * `repeatsNodeVariable` records that every hop rung over-counted this shape. The answer must
   * still be right, which means the general matcher has to get it.
   */
  test('a pattern whose own ends are both the key still answers correctly', () => {
    const g = build();

    g.addEdge({
      id: 'loop',
      from: g.getVertexById('s0') as never,
      to: g.getVertexById('s0') as never,
      labels: ['E'],
    });

    const q = 'MATCH (a:T)-[:E]->(a), (a)-[:E]->(c:T) RETURN count(*) AS c';

    expect(takesTheRung(q)).toBe(false); // REFUSED — the key is at both ends of one pattern
    // s0 now has one self-loop and an out-degree of 4 under `:E`, so 1 * 4.
    expect(countOf(g, q)).toBe(4);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });

  /**
   * ⚠️ AN INLINE CONSTRAINT MUST LAND ON THE END THAT WROTE IT, and nothing tested this until a
   * mutant swapping the key's and the far's inline predicates SURVIVED. The two ends are read
   * differently — the key's predicate gates which CANDIDATES are summed, the far's filters which
   * EDGES each side counts — so a swap changes the answer without changing the shape.
   */
  test('an inline constraint on the KEY gates the candidates', () => {
    const g = build();
    const q = "MATCH (a:T {n: 's0'})-[:E]->(b:T), (a)-[:E]->(c:T) RETURN count(*) AS c";

    // Only s0 is summed, and its out-degree under `:E` is 3.
    expect(countOf(g, q)).toBe(9);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });

  test('an inline constraint on the FAR end filters that side’s edges', () => {
    const g = build();
    const q = "MATCH (a:T)-[:E]->(b:T {n: 't0'}), (a)-[:E]->(c:T) RETURN count(*) AS c";

    // (edges landing on t0) x (out-degree): s0 1x3, s1 1x3, s2 1x1, t0 0x1.
    expect(countOf(g, q)).toBe(7);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });

  /**
   * ⚠️ THE DIAGONAL IS PART OF THE ANSWER. `b` and `c` are distinct variables with no inequality
   * between them, so the pair (x, x) matches — which is exactly what squaring the degree gets
   * right for free, and what a rung that tried to exclude it would get wrong.
   */
  test('the pairs include the diagonal', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['T'], properties: {} });
    g.addVertex({ id: 'x', labels: ['T'], properties: {} });
    g.addEdge({
      id: 'only',
      from: g.getVertexById('a') as never,
      to: g.getVertexById('x') as never,
      labels: ['E'],
    });

    const q = 'MATCH (a:T)-[:E]->(b:T), (a)-[:E]->(c:T) RETURN count(*) AS c';

    expect(takesTheRung(q)).toBe(true);
    // One out-edge, so 1 * 1 = 1: the single pair is (x, x).
    expect(countOf(g, q)).toBe(1);
    expect(countOf(g, q)).toBe(viaGeneral(g, q));
  });
});
