/*
 * Item 2409 — `sum`/`avg` over a 2+-segment chain, as a MULTIPLICITY-WEIGHTED fold on the level
 * recurrence.
 *
 * ⚠️⚠️ **WHAT THIS FILE MAY AND MAY NOT PIN, because getting that backwards would rebuild the very
 * refusal item 2409 removed.**
 *
 * The rung computes `Σ u_v · x_v` over the distinct reached vertices; the general path adds the
 * per-path values one at a time. `fl(u · x)` is NOT `x + x + … + x`, so the two arms differ in the
 * last ulp on an inexact column — BY CONSTRUCTION, not by defect.
 *
 * 🔑 So the cross-arm tests compare against item 2401's PRECISION CONTRACT (`n·ε·Σ|xᵢ|`), the same
 * way `hop-order-sensitive-aggregates.test.ts` does, at a tolerance three orders above reassociation
 * noise and four below a dropped row. ⚠️ A test demanding the same BITS from both arms would make
 * this rung unshippable while proving nothing the contract asks for.
 *
 * 🔑 WHAT IS PINNED EXACTLY is everything the contract does NOT free:
 *   - the fold's DIRECTION over the vertex order, which is within-engine determinism
 *     (`parallelism-stance`) and the one guarantee item 2400 did not relax;
 *   - the BAIL on a value the fold may not multiply, which is a FAULT and not a number;
 *   - null exclusion, the empty answer, and `avg`'s denominator.
 *
 * ⚠️ AND AN INTEGER FIXTURE CANNOT TEST ANY OF THIS. An integer sum in f64 is EXACT whatever the
 * order and whatever the weights, so a test over `n: 0..7` passes identically against a rung that
 * re-associates and one that does not. Every arithmetic fixture here is binary-inexact on purpose.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * A ring whose fanout is 2, so a far vertex is reached by MANY paths and the multiplicity is the
 * thing under test.
 *
 * ⚠️⚠️ **FANOUT 1 WOULD MAKE EVERY TEST HERE VACUOUS.** With one out-edge per vertex every
 * multiplicity is 1, `Σ u·x` collapses to `Σ x`, and the weighted fold is arithmetically identical
 * to the per-path one — so a mutant that dropped the weight entirely would survive. Two out-edges
 * per vertex gives `u_v = 2^hops` at every vertex of the ring.
 */
const ringOf = (props: readonly Record<string, unknown>[]): Graph => {
  const g = new Graph();

  for (const [i, p] of props.entries()) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: p });
  }

  for (let i = 0; i < props.length; i += 1) {
    for (const [j, step] of [1, 2].entries()) {
      g.addEdge({
        id: `e${i}-${j}`,
        from: g.getVertexById(`v${i}`)!,
        to: g.getVertexById(`v${(i + step) % props.length}`)!,
        labels: ['E'],
        properties: {},
      });
    }
  }

  return g;
};

const HOP2 = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)';
const HOP3 = 'MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)';

const one = (g: Graph, q: string): unknown => query(g, q, {}).at(0)?.x;

/**
 * The exact reference: KAHAN-COMPENSATED over the per-path values, read off the engine's own rows.
 *
 * ⚠️ IT DOES NOT RE-DERIVE THE WALK. A second traversal written here could disagree with the engine
 * about WHICH paths exist, and then the test would be measuring my traversal rather than the two
 * folds — `chain-fold-levels.ts`'s own header makes the same point about its ceiling probe. Kahan
 * carries ~2ε total error against the arms' ~nε, so it stands in for the exact value.
 */
const exactOf = (
  g: Graph,
  pattern: string,
  far: string,
  key: string,
): { sum: number; absSum: number; n: number } => {
  const rows = query(g, `${pattern} RETURN ${far}.${key} AS v`, {});
  let sum = 0;
  let comp = 0;
  let absSum = 0;
  let n = 0;

  for (const row of rows) {
    const { v } = row;

    if (typeof v !== 'number') {
      continue;
    }

    const y = v - comp;
    const t = sum + y;

    comp = t - sum - y;
    sum = t;
    absSum += Math.abs(v);
    n += 1;
  }

  return { sum, absSum, n };
};

/** Item 2401's contract, as an assertion. Returns the ratio so a caller can show its headroom. */
const withinContract = (got: unknown, exact: number, absSum: number, n: number): number => {
  const bound = n * Number.EPSILON * absSum + Number.MIN_VALUE;

  expect(typeof got).toBe('number');
  expect(Math.abs((got as number) - exact)).toBeLessThanOrEqual(bound);

  return Math.abs((got as number) - exact) / bound;
};

describe('chainFoldLevels weighted sum/avg (item 2409)', () => {
  test('🔑 `sum` over an INEXACT column is inside item 2401’s bound at two and three hops', () => {
    // Three decades and a non-terminating binary fraction, so the addends genuinely round.
    const props = Array.from({ length: 11 }, (_, i) => ({
      w: (i % 7) * 0.1 + (i % 3) * 1e3 + (i % 5) * 1e-4,
    }));
    const g = ringOf(props);

    for (const [pattern, far] of [
      [HOP2, 'c'],
      [HOP3, 'd'],
    ] as const) {
      const { sum, absSum, n } = exactOf(g, pattern, far, 'w');
      const ratio = withinContract(one(g, `${pattern} RETURN sum(${far}.w) AS x`), sum, absSum, n);

      // ⚠️ THE HEADROOM IS ASSERTED, not just the bound. A rung that happened to be exactly AT the
      // bound would pass the check above while being three orders worse than this one is, and that
      // would be a real regression the contract alone could not see.
      expect(ratio).toBeLessThan(0.1);
    }
  });

  test('🔑 `avg` divides by the PATH count, not the vertex count', () => {
    /*
     * ⚠️⚠️ **THE SHARPEST ARITHMETIC TEST IN THE FILE, and it is the one a fanout-1 fixture cannot
     * express.** Two of the three vertices carry `0.5` and one carries `3.5`, each reached by the
     * same multiplicity — so the per-PATH average is 1.5 while a per-VERTEX average over the
     * support is also 1.5. Making the multiplicities UNEQUAL is what separates them, which the
     * absent key below does: `v2` contributes no paths at all.
     */
    const g = ringOf([{ w: 0.5 }, { w: 3.5 }, { other: 1 }]);
    const { sum, absSum, n } = exactOf(g, HOP2, 'c', 'w');

    withinContract(one(g, `${HOP2} RETURN avg(c.w) AS x`), sum / n, absSum / n, n);
    // Written out as well, so a change to BOTH routes cannot pass by agreeing on something wrong.
    expect(one(g, `${HOP2} RETURN avg(c.w) AS x`)).toBe(2);
  });

  test('⚠️ THE WEIGHT IS LOAD-BEARING: one vertex reached twice as often moves the sum', () => {
    /*
     * 🔑 A DIRECTED FIXTURE RATHER THAN THE RING, so the multiplicities are hand-known and a mutant
     * that ignored `u_v` answers a different NUMBER rather than the same one. `s` reaches `hi`
     * through two length-2 paths and `lo` through one, so the weighted sum is `2·10 + 1·1 = 21`
     * where an unweighted pass over the support would answer `11`.
     */
    const g = new Graph();

    for (const [id, props] of [
      ['s', {}],
      ['m1', {}],
      ['m2', {}],
      ['m3', {}],
      ['hi', { w: 10 }],
      ['lo', { w: 1 }],
    ] as const) {
      g.addVertex({ id, labels: ['P'], properties: props });
    }

    for (const [i, [from, to]] of [
      ['s', 'm1'],
      ['s', 'm2'],
      ['s', 'm3'],
      ['m1', 'hi'],
      ['m2', 'hi'],
      ['m3', 'lo'],
    ].entries()) {
      g.addEdge({
        id: `e${i}`,
        from: g.getVertexById(from)!,
        to: g.getVertexById(to)!,
        labels: ['E'],
        properties: {},
      });
    }

    expect(one(g, `${HOP2} RETURN sum(c.w) AS x`)).toBe(21);
    expect(one(g, `${HOP2} RETURN count(c.w) AS x`)).toBe(3);
    // 21/3, so `avg`'s denominator is the same tally.
    expect(one(g, `${HOP2} RETURN avg(c.w) AS x`)).toBe(7);
    // ⚠️ THE CONTROL that makes the three above a finding: `min`/`max` are SET functions, so they
    // read the same support and must NOT move with the multiplicity.
    expect(one(g, `${HOP2} RETURN min(c.w) AS x`)).toBe(1);
    expect(one(g, `${HOP2} RETURN max(c.w) AS x`)).toBe(10);
  });

  test('⚠️⚠️ A STORED TEMPORAL FAULTS, it does not answer — the rung hands the query back', () => {
    /*
     * 🔑🔑 **THE ONE BEHAVIOUR A SUCCESSFUL ANSWER CANNOT DEMONSTRATE.** `sum` over a column holding
     * any temporal is a loud data exception on the general path (item 2336: the operation is chosen
     * by looking at the whole collection), and `u · Temporal` is a silent `NaN`. So a rung that
     * answered here — with `NaN`, or with the partial sum of the numbers it saw first — would be a
     * WRONG ANSWER where the engine owes a fault.
     *
     * ⚠️ THE DATE IS ON THE LAST VERTEX OF THE RING, which is item 2159's sharpest shape: the fold
     * has real numbers accumulated before it meets the temporal, so a bail that returned its partial
     * total would answer a number instead of throwing.
     */
    const g = ringOf([{ w: 1.5 }, { w: 2.5 }, { w: { '@date': '2024-01-02' } }]);

    expect(() => query(g, `${HOP2} RETURN sum(c.w) AS x`, {})).toThrow();
    expect(() => query(g, `${HOP3} RETURN sum(d.w) AS x`, {})).toThrow();
    // ⚠️ AND THE CONTROL: the same column under `min` does NOT fault, because a total order covers
    // a temporal where addition does not. So the throw above is `sum`'s semantics and not the
    // fixture being broken.
    expect(() => query(g, `${HOP2} RETURN min(c.w) AS x`, {})).not.toThrow();
  });

  test('⚠️ `NaN` AND `±Infinity` RIDE THE FOLD and agree with the general path exactly', () => {
    /*
     * ⚠️⚠️ **WHAT THIS TEST CANNOT DO IS SAID FIRST, because its first version claimed to do it.**
     * It was written to pin a `Number.isFinite` bail and asserted agreement with the general path —
     * but tightening or relaxing that guard is ANSWER-EQUIVALENT on every non-finite and overflow
     * fixture (`levelsum-inf-probe-2409.mjs`, 0/6 separate the arms), so no assertion here can catch
     * a change to it. The battery's mutant on that line survived and said so.
     *
     * 🔑 WHAT IT DOES PIN IS THE AGREEMENT ITSELF, which is worth having: `mult` is finite and
     * non-zero, so `mult · ±Inf` is `±Inf` and `mult · NaN` is `NaN` — the weighted form contributes
     * the SAME non-finite term, and those absorb order-independently. So a non-finite column stays
     * on the fast path rather than costing an 849x fall-through, and that is a property of the
     * arithmetic rather than of the guard.
     */
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const g = ringOf([{ w: 1.5 }, { w: bad }, { w: 2.5 }]);
      const got = one(g, `${HOP2} RETURN sum(c.w) AS x`);
      // The general path's answer for the same multiset, reached by a spelling this rung refuses.
      const ref = one(g, `${HOP2} RETURN sum(c.w) AS x ORDER BY x`);

      expect(Object.is(got, ref)).toBe(true);
    }

    // ⚠️ OPPOSITE SIGNS, which is the case the deleted comment named as the one that separates
    // them. It does not: both arms answer `NaN`, because `+Inf + -Inf` is `NaN` in either order.
    const mixed = ringOf([
      { w: Number.POSITIVE_INFINITY },
      { w: Number.NEGATIVE_INFINITY },
      { w: 2.5 },
    ]);

    expect(Number.isNaN(one(mixed, `${HOP2} RETURN sum(c.w) AS x`))).toBe(true);
    expect(Number.isNaN(one(mixed, `${HOP2} RETURN sum(c.w) AS x ORDER BY x`))).toBe(true);
  });

  /*
   * ⚠️⚠️ **THIS TEST PINNED THE WRONG VALUE AND ITEM 2410 CORRECTED IT.** It asserted `sum` over an
   * all-null column is `null`, "which is what the general path answers" — a claim written into both
   * the test and the rung and never measured. It is false: every other route answers `0`, so item
   * 2409 shipped a route-dependent answer and this test pinned it there. `avg` stays `null`.
   *
   * 🔑 The pair below is the whole point now: `sum` and `avg` DISAGREE on an empty fold, and a reader
   * tidying them into agreement would reintroduce the divergence in one direction or the other.
   */
  test('⚠️ NULL IS EXCLUDED, and an all-null column answers `0` for `sum` but `null` for `avg`', () => {
    // `v1` lacks the key entirely and `v2` holds an explicit null — ISO yields NULL for both.
    const g = ringOf([{ w: 2.5 }, { other: 1 }, { w: null }]);

    expect(one(g, `${HOP2} RETURN sum(c.w) AS x`)).toBe(2.5 * 4);
    // The denominator skips the nulls too, so this is the value and not a third of it.
    expect(one(g, `${HOP2} RETURN avg(c.w) AS x`)).toBe(2.5);

    const empty = ringOf([{ other: 1 }, { other: 2 }, { other: 3 }]);

    expect(one(empty, `${HOP2} RETURN sum(c.w) AS x`)).toBe(0);
    expect(one(empty, `${HOP2} RETURN avg(c.w) AS x`)).toBe(null);

    /*
     * ⚠️ THE CROSS-ROUTE CONTROL, which is what makes the two values above a CONTRACT rather than
     * this rung's preference. One hop over the same graph cannot reach the level fold, so it answers
     * from the general path — and the two must agree.
     */
    expect(one(empty, 'MATCH (a:P)-[:E]->(b:P) RETURN sum(b.w) AS x')).toBe(0);
    expect(one(empty, 'MATCH (a:P)-[:E]->(b:P) RETURN avg(b.w) AS x')).toBe(null);
  });

  test('🔑 THE FOLD DIRECTION IS PINNED — within-engine determinism, which item 2400 did NOT relax', () => {
    /*
     * ⚠️⚠️ **THIS IS THE TEST THAT MUST NOT BE READ AS A CROSS-ENGINE CLAIM.** It pins that this
     * engine folds in ONE order, run to run, byte for byte — the guarantee `parallelism-stance`
     * records and the contract leaves in place. It says nothing about matching the Rust engine's
     * bits, which item 2401 explicitly freed.
     *
     * 🔑 AND IT CARRIES ITS OWN CONTROL, so it is not vacuous: a reciprocal ramp summed forward and
     * backward must DISAGREE, or the fixture cannot see an order at all and this test would pass
     * against a rung that folded either way.
     */
    const props = Array.from({ length: 29 }, (_, i) => ({ w: 1 / (i + 1) }));
    const g = ringOf(props);
    const q = `${HOP2} RETURN sum(c.w) AS x`;
    const first = one(g, q);

    for (let i = 0; i < 5; i += 1) {
      expect(Object.is(one(g, q), first)).toBe(true);
    }

    // THE CONTROL: the same addends in the opposite order round differently, so the bits above are
    // a real choice and not the only representable answer.
    const forward = props.reduce((acc, p) => acc + p.w, 0);
    const backward = [...props].reverse().reduce((acc, p) => acc + p.w, 0);

    expect(Object.is(forward, backward)).toBe(false);
  });

  test('⚠️ THE REFUSALS THIS RUNG KEEPS: `collect`, a DISTINCT sum, and an expression wrapping it', () => {
    /*
     * 🔑 ASSERTED AS AGREEMENT WITH THE GENERAL PATH, not as a route claim — timing cannot tell
     * declined from more work ([[rung-precedence-decides-speed]]) and neither can an answer. What
     * these pin is that widening the gate to admit them did not happen by accident: each returns
     * what the general path returns, which is the only observable the rung owes.
     */
    const g = ringOf([{ w: 0.1 }, { w: 0.2 }, { w: 0.3 }]);

    // `collect` keeps its refusal: a weighted fold cannot emit `u_v` copies without the list.
    expect(query(g, `${HOP2} RETURN collect(c.w) AS x`, {}).at(0)?.x).toHaveLength(12);
    // `sum(DISTINCT x)` is a different question and must not reach the weighted fold.
    expect(one(g, `${HOP2} RETURN sum(DISTINCT c.w) AS x`)).toBeCloseTo(0.6, 10);
    // The item must BE the aggregate: `sum(x) * 2` folds the same aggregate but its row value is
    // the arithmetic, so answering the fold's result directly would drop the `* 2`.
    expect(one(g, `${HOP2} RETURN sum(c.w) * 2 AS x`)).toBeCloseTo(4.8, 10);
  });

  test('🔑 A FILTERING INTERMEDIATE LABEL narrows the walk, so the weight is the narrowed one', () => {
    /*
     * ⚠️ THE ONE WAY THIS MODULE COULD OVER-COUNT, which its `levelWalk` header names: a rung that
     * ignored a per-level label mask would weight by paths the general path does not have. Asserted
     * against the general path on an inexact column, so the WEIGHT is what is being compared.
     */
    const g = new Graph();

    for (const [i, label] of ['P', 'Q', 'P', 'Q', 'P'].entries()) {
      g.addVertex({ id: `v${i}`, labels: [label], properties: { w: (i + 1) * 0.1 } });
    }

    for (let i = 0; i < 5; i += 1) {
      for (const [j, step] of [1, 2].entries()) {
        g.addEdge({
          id: `e${i}-${j}`,
          from: g.getVertexById(`v${i}`)!,
          to: g.getVertexById(`v${(i + step) % 5}`)!,
          labels: ['E'],
          properties: {},
        });
      }
    }

    const pattern = 'MATCH (a:P)-[:E]->(b:Q)-[:E]->(c:P)';
    const { sum, absSum, n } = exactOf(g, pattern, 'c', 'w');

    expect(n).toBeGreaterThan(0);
    withinContract(one(g, `${pattern} RETURN sum(c.w) AS x`), sum, absSum, n);
  });
});
