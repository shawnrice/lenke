import { describe, expect, test } from 'bun:test';

/**
 * A residual `sum`/`mean` folded into the fused values walk — item 2408, built and reverted at item
 * 1918.
 *
 * `V().out(E).values(k)` already rode a fused walk; a trailing `sum()` then went through the
 * traverser pipeline, wrapping every value it had just produced. The reduce cost 2.47x the walk
 * that MATERIALIZES all 800,000 values — 226.66 ms against 91.94 — which is the wrong way round for
 * an arm that allocates nothing.
 *
 * ⚠️⚠️ **WHY THIS FILE EXISTED ONCE BEFORE AND WAS DELETED.** Item 1918 built this fold and reverted
 * it: the refusal it overturns was made deliberately by items 1830/1831 and pinned by a test named
 * `sum and mean are NOT folded`, whose stated reason was that "byte-identity with the Rust engine is
 * a hard invariant". Item **2401** retired that in favour of a PRECISION contract — `sum`/`avg`
 * accurate to within `n·ε·Σ|xᵢ|`, explicitly NOT bit-identical across engines — and item **2400**
 * had already freed the walk-order premise underneath it.
 *
 * ⚠️ SO THIS FILE DOES NOT PIN BIT-IDENTITY, DELIBERATELY. Item 1918 measured 12/12 bit-identical
 * against the Rust engine over the FFI (`sumorder-native-1918.ts`) and that measurement is why
 * taking the fold costs nothing — but it is a fact about today's walks, not the contract. Pinning it
 * here would rebuild in a new place exactly the lock this item removed.
 *
 * ⚠️ THE ORACLE IS A PLAIN JAVASCRIPT REDUCE OVER THE WALK'S OWN OUTPUT, which is outside the
 * engine. `toArray` of the same traversal WITHOUT the aggregate gives exactly the values being
 * reduced, so `+` over them cannot share a mistake with either engine path — the standard
 * `projected-aggregate.test.ts` sets for the `min`/`max` twin, and item 1832's drift hazard is why
 * the two folds are not trusted to check each other.
 */
import { Graph } from '@lenke/core';

import { V, mean, out, sum, toArray, traversal, values } from '../index.js';
import { foldProjectedNumeric } from './aggregation.js';

/**
 * ⚠️ THE VALUES ARE CHOSEN SO THE FOLD'S FIVE RULES ARE EACH OBSERVABLE — every one of them is a
 * named mutant in `numfold-mutants-1918.mjs`: a stored `null` (SKIPPED, not added as 0 and not
 * counted by `mean`), an ABSENT key (never emitted by `values` at all), negatives and a zero (so a
 * falsy correct answer cannot be confused with "no answer"), and an all-null column (which must
 * answer `null` rather than 0).
 */
const build = (vals: readonly unknown[]): Graph => {
  const g = new Graph();

  for (const [i, v] of vals.entries()) {
    g.addVertex({
      id: `v${i}`,
      labels: ['T'],
      properties: v === undefined ? {} : { k: v },
    });
  }

  for (let i = 0; i < vals.length; i += 1) {
    const from = g.getVertexById(`v${i}`);
    const to = g.getVertexById(`v${(i + 1) % vals.length}`);

    if (from === null || to === null) {
      throw new Error('fixture is broken');
    }

    g.addEdge({ id: `e${i}`, from, to, labels: ['E'] });
  }

  return g;
};

const FIXTURES: Record<string, readonly unknown[]> = {
  plain: [3, 1, 4, 1, 5, 9, 2, 6],
  'with a stored null': [3, null, 1, null, 7],
  'with an absent key': [3, undefined, 1, undefined, 7],
  'negatives and zero': [-5, 0, 3, -1, 0],
  'all null': [null, null],
  single: [42],
  /**
   * ⚠️ A COLUMN THAT SUMS TO ZERO while every element is non-null — the one fixture that tells
   * `sawNonNull` apart from `total !== 0`. Without it, an implementation answering `null` whenever
   * the total is 0 passes every other case here.
   */
  'sums to zero': [5, -5, 2, -2],
  /**
   * ⚠️ NON-INTEGERS, so `mean`'s division is not exact and `sum`'s accumulation actually rounds.
   * An all-integer fixture cannot distinguish any two summation orders, which would make the
   * agreement tests below vacuous for the quantity this item is about.
   */
  fractional: [0.1, 0.2, 0.3, 0.7, 1.3],
};

describe('a residual sum/mean over the fused values walk', () => {
  test('agrees with a plain JavaScript reduce over the walk’s own output', () => {
    for (const [name, vals] of Object.entries(FIXTURES)) {
      const g = build(vals);
      // Exactly the values being reduced — the walk WITHOUT the aggregate.
      const walked = toArray(traversal(V(), out('E'), values('k')), g);
      const nonNull = walked.filter((v) => v !== null && v !== undefined) as number[];
      const total = nonNull.reduce((a, b) => a + b, 0);

      const gotSum = toArray(traversal(V(), out('E'), values('k'), sum()), g);
      const gotMean = toArray(traversal(V(), out('E'), values('k'), mean()), g);

      /**
       * ⚠️ THE LENGTH IS PART OF THE ASSERTION, and the value alone was not enough for the twin:
       * a mutant answering NOTHING for an all-null input instead of `[null]` survives, because
       * `undefined ?? null` and `null` render identically. These terminals always emit exactly one
       * value, so the arity is as much the contract as the number.
       *
       * ⚠️ Compared as a STRING so a `null` answer and a `0` answer cannot be confused — on
       * `sums to zero` the correct `sum` IS a falsy value, which is the point of that fixture.
       */
      expect(`${name}/sum: len=${String(gotSum.length)} ${JSON.stringify(gotSum[0] ?? null)}`).toBe(
        `${name}/sum: len=1 ${JSON.stringify(nonNull.length === 0 ? null : total)}`,
      );

      expect(
        `${name}/mean: len=${String(gotMean.length)} ${JSON.stringify(gotMean[0] ?? null)}`,
      ).toBe(
        `${name}/mean: len=1 ${JSON.stringify(
          nonNull.length === 0 ? null : total / nonNull.length,
        )}`,
      );
    }
  });

  test('agrees at two hops as well as one', () => {
    for (const [name, vals] of Object.entries(FIXTURES)) {
      const g = build(vals);
      const walked = toArray(traversal(V(), out('E'), out('E'), values('k')), g);
      const nonNull = walked.filter((v) => v !== null && v !== undefined) as number[];
      const got = toArray(traversal(V(), out('E'), out('E'), values('k'), sum()), g);

      expect(`${name}: ${JSON.stringify(got[0] ?? null)}`).toBe(
        `${name}: ${JSON.stringify(
          nonNull.length === 0 ? null : nonNull.reduce((a, b) => a + b, 0),
        )}`,
      );
    }
  });

  /**
   * ⚠️ THE SCAN SPELLING IS THE SECOND OPINION, and for this pair it is a REAL second
   * implementation rather than a courtesy: `V().values(k).sum()` goes through
   * `fusedValuesAggregate`'s numeric arm — which this fold mirrors line for line, and which the
   * route screen already reports as `agg: values sum  SHORTCUT`. Two near-twins that must stay
   * identical are item 1832's drift hazard, so they are checked against each other as well as
   * against the plain reduce above.
   *
   * ⚠️⚠️ **AND THIS IS THE ONE PLACE A TOLERANCE IS CORRECT RATHER THAN A WEAKENING, which is
   * item 2401's contract doing real work.** The ring fixture gives every vertex exactly one
   * in-edge, so the hop visits the same MULTISET as the scan — but in a ROTATION of its order, and
   * a left fold over a rotation re-associates. Within-engine determinism (`parallelism-stance`)
   * binds the same query run twice, which the tests above assert exactly; these are two DIFFERENT
   * queries, so what they owe each other is the precision contract — `n·ε·Σ|xᵢ|`. ⚠️ The
   * tolerance is kept far enough below a real defect to still catch one: `1e-9` sits orders above
   * reassociation noise on these fixtures and orders below a dropped or double-counted row, which
   * is the margin `hop-order-sensitive-aggregates.test.ts` reasons from.
   */
  test('agrees with the element-reading arm to within the precision contract', () => {
    const agrees = (a: unknown, b: unknown, label: string): void => {
      if (typeof a === 'number' && typeof b === 'number') {
        const scale = Math.max(Math.abs(a), Math.abs(b), 1);

        expect(`${label}: within 1e-9`).toBe(
          `${label}: ${Math.abs(a - b) / scale < 1e-9 ? 'within 1e-9' : `${a} vs ${b}`}`,
        );

        return;
      }

      // A non-number is `null` here, and THAT is exact: an all-null column answers null on both.
      expect(`${label}: ${JSON.stringify(a ?? null)}`).toBe(
        `${label}: ${JSON.stringify(b ?? null)}`,
      );
    };

    for (const [name, vals] of Object.entries(FIXTURES)) {
      const g = build(vals);

      agrees(
        toArray(traversal(V(), out('E'), values('k'), sum()), g)[0],
        toArray(traversal(V(), values('k'), sum()), g)[0],
        `${name}/sum`,
      );
      agrees(
        toArray(traversal(V(), out('E'), values('k'), mean()), g)[0],
        toArray(traversal(V(), values('k'), mean()), g)[0],
        `${name}/mean`,
      );
    }
  });

  /**
   * ⚠️ `asNumber` THROWS rather than coercing, because TinkerPop's `sum`/`mean` require `Number`s
   * and raise on anything else — and that is the ONE behaviour of this fold a successful answer
   * cannot demonstrate. A mutant dropping `asNumber` makes a numeric string CONCATENATE
   * (`'1' + '2'` is `'12'`), which is a wrong answer rather than an error.
   */
  test('a non-numeric value faults rather than coercing', () => {
    const g = build([3, 'seven', 1]);

    expect(() => toArray(traversal(V(), out('E'), values('k'), sum()), g)).toThrow(
      /numeric aggregation requires a number/,
    );
    expect(() => toArray(traversal(V(), out('E'), values('k'), mean()), g)).toThrow(
      /numeric aggregation requires a number/,
    );
  });
});

/**
 * ⚠️⚠️ **THE FOLD IS DRIVEN DIRECTLY HERE, AND THAT IS NOT A SHORTCUT.** The generic pipeline
 * answers every shape above IDENTICALLY — that equality is the whole claim of the item — so a
 * mutant that merely declines the route survives every test in the describe block above. Its own
 * gates are the two instruments (`numfold-mutants-1918.mjs` names it an EXPECTED SURVIVOR, and the
 * route screen's `agg: hop values sum` row reads `SHORTCUT, 0` where it read `generic, 1`). What
 * these tests cover instead is the fold's own arithmetic, called as a pure function:
 * [[perf-gate-needs-its-own-test]].
 */
describe('foldProjectedNumeric as a pure function', () => {
  test('sums and means a plain array, skipping nulls in both', () => {
    expect(foldProjectedNumeric([1, 2, 3, 4], 'sum')).toStrictEqual([10]);
    expect(foldProjectedNumeric([1, 2, 3, 4], 'mean')).toStrictEqual([2.5]);
    // The null is skipped by BOTH, so the mean divides by 4 and not 5.
    expect(foldProjectedNumeric([1, null, 2, 3, 4], 'sum')).toStrictEqual([10]);
    expect(foldProjectedNumeric([1, null, 2, 3, 4], 'mean')).toStrictEqual([2.5]);
  });

  test('an input with no non-null value answers [null], not [0]', () => {
    expect(foldProjectedNumeric([], 'sum')).toStrictEqual([null]);
    expect(foldProjectedNumeric([], 'mean')).toStrictEqual([null]);
    expect(foldProjectedNumeric([null, null], 'sum')).toStrictEqual([null]);
    expect(foldProjectedNumeric([null, null], 'mean')).toStrictEqual([null]);
    // ⚠️ AND A REAL ZERO IS NOT THAT CASE: `sawNonNull` is not `total !== 0`.
    expect(foldProjectedNumeric([5, -5], 'sum')).toStrictEqual([0]);
    expect(foldProjectedNumeric([5, -5], 'mean')).toStrictEqual([0]);
  });

  test('sum and mean are not swapped', () => {
    // Chosen so the two differ and neither equals the other for any count: 24 vs 6.
    expect(foldProjectedNumeric([2, 4, 6, 12], 'sum')).toStrictEqual([24]);
    expect(foldProjectedNumeric([2, 4, 6, 12], 'mean')).toStrictEqual([6]);
  });

  /**
   * ⚠️⚠️ **THE ADDITION IS A LEFT FOLD IN THE WALK'S OWN ORDER, AND THIS IS THE TEST FOR THE ONE
   * MUTANT THAT MATTERS.** `numfold-mutants-1918.mjs`'s named hazard is a REVERSED addition order:
   * every value present, the right count, and a wrong answer in the last ulp — invisible to any
   * assertion that compares rounded output.
   *
   * 🔑 **WHAT IS ASSERTED IS THE FOLD DIRECTION, NOT CROSS-ENGINE IDENTITY.** Item 2401's contract
   * explicitly permits the Rust engine to re-associate, so a test demanding the same bits from both
   * engines would be asserting a contract this repo does not have. What this engine does owe is
   * within-engine determinism (`parallelism-stance`): the same query over the same graph answers
   * the same way every run, which a left fold in walk order gives and a direction-dependent
   * implementation detail does not.
   *
   * ⚠️ THE CONTROL COMES FIRST, or the test is vacuous: the two orders of these values must
   * actually differ in f64, and on a reciprocal ramp they do.
   */
  test('adds as a left fold in the input’s order', () => {
    const ramp = Array.from({ length: 1000 }, (_, i) => 1 / (i + 1));
    const forward = ramp.reduce((a, b) => a + b, 0);
    const backward = [...ramp].reverse().reduce((a, b) => a + b, 0);

    // THE CONTROL: without this the assertion below holds for either direction.
    expect(forward).not.toBe(backward);

    expect(foldProjectedNumeric(ramp, 'sum')).toStrictEqual([forward]);
    expect(foldProjectedNumeric([...ramp].reverse(), 'sum')).toStrictEqual([backward]);
  });

  /**
   * ⚠️⚠️ **IT TAKES THE WALK'S `drain`, AND THE FIRST VERSION OF THIS TEST PINNED THE OPPOSITE.**
   * I reasoned that item 1919's drain was worth 2.09x on a STRING column but only 1.15x on a
   * numeric one, that a `sum` column is numeric by construction, and that an 800,000-slot
   * allocation was therefore not worth ~15% — wrote that down as fact, and then measured it:
   * **1.58x on `sum` and 1.49x on `mean`**, with the fold landing 1.03x over the bare walk where it
   * had been 1.57x above it. `foldProjectedNumeric`'s own note has the table and what refuted the
   * prediction (the twin's number in the same run).
   *
   * ⚠️ AND THIS IS NOT A ROUTE-ONLY CHANGE DRESSED AS A TEST: taking a walk's `drain` yields the
   * same elements in the same order, so no answer test can see it — `projected-fold.test.ts` hit
   * exactly this. A walk whose `drain` and iterator DISAGREE is what makes the choice observable,
   * and without this a mutant reverting the drain survives the whole suite.
   */
  test('takes the walk DRAIN when the walk offers one', () => {
    let drained = 0;
    let iterated = 0;
    const walk = {
      *[Symbol.iterator]() {
        iterated += 1;

        yield 1;

        yield 2;
      },
      drain: () => {
        drained += 1;

        return [100, 200];
      },
    };

    // 300 is the sum of the DRAINED values; 3 is what the iterator would have given.
    expect(foldProjectedNumeric(walk, 'sum')).toStrictEqual([300]);
    expect(drained).toBe(1);
    expect(iterated).toBe(0);
  });

  test('and falls back to iteration when the walk offers no drain', () => {
    let iterated = 0;
    const walk = {
      *[Symbol.iterator]() {
        iterated += 1;

        yield 1;

        yield 2;

        yield 3;
      },
    };

    expect(foldProjectedNumeric(walk, 'sum')).toStrictEqual([6]);
    expect(iterated).toBe(1);
    // A plain array has no `drain` either, which is how every other test here calls it.
    expect(foldProjectedNumeric([1, 2, 3], 'mean')).toStrictEqual([2]);
  });
});
