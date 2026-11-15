import { describe, expect, test } from 'bun:test';

/**
 * A residual `min`/`max` folded into the fused values walk — item 1857.
 *
 * `V().out(E).values(k)` already rode a fused walk; a trailing `min()` then went through the
 * traverser pipeline, which wraps every value it produced. The reduce cost MORE than the walk it
 * reduces — 21.93 ms against the walk's 9.48 — and now folds in place at 12.36 (1.77x), 2.47x for
 * `max`.
 *
 * ⚠️ THE ORACLE IS A PLAIN JAVASCRIPT REDUCE OVER THE WALK'S OWN OUTPUT, which is outside the
 * engine. The new fold mirrors `fusedValuesAggregate`'s non-numeric arm, and two near-twins that
 * must stay identical are item 1832's drift hazard — so neither is trusted to check the other.
 * `toArray` of the same traversal WITHOUT the aggregate gives exactly the values being reduced;
 * `Math.min` over them cannot share a mistake with either engine path.
 *
 * ⚠️ `sum`/`mean` MUST STAY REFUSED, and that is tested rather than assumed. They are
 * order-sensitive in the last ulp of an f64 addition, the fused walk's order is not the pipeline's,
 * and byte-identity with the Rust engine is a hard invariant. A test that only checked `min`/`max`
 * would not notice the pair being quietly admitted.
 */
import { Graph } from '@lenke/core';

import { V, max, mean, min, out, sum, toArray, traversal, values } from '../index.js';
import { foldProjectedMinMax, fusableProjectedAggregate } from './aggregation.js';

/**
 * ⚠️ THE VALUES ARE CHOSEN SO THE FOLD'S RULES ARE OBSERVABLE: a stored `null` (skipped), an
 * ABSENT key (never emitted by `values`), a negative, a zero, and on one fixture STRINGS mixed
 * with numbers so `compareTotal`'s total order matters rather than `<`.
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
  'mixed strings and numbers': [3, 'b', 1, 'a', 7],
  /**
   * ⚠️ AN ALL-STRING COLUMN, added at item 1919 because the win there is 2.00x on exactly this and
   * the file had no such fixture — only the MIXED one, whose numbers mean `compareTotal`'s type
   * rank decides the answer before any string comparison happens. A column that is wholly strings
   * is a different path through the comparator.
   */
  'all strings': ['pear', 'apple', 'fig', 'apple', 'quince'],
  single: [42],
};

/**
 * The oracle's comparison, chosen by the COLUMN'S TYPE.
 *
 * ⚠️ WHY THIS IS NOT RE-IMPLEMENTING THE THING UNDER TEST, which the note below rightly warns
 * against for the MIXED fixture: a cross-type order needs `compareTotal`'s type ranks, and copying
 * those here would make the oracle a second copy of the engine. A column that is wholly numbers or
 * wholly strings needs no ranks at all — `<` on two ASCII strings IS code-point order — so each
 * single-type column gets the plain JavaScript comparison for its type and the mixed one stays
 * excluded.
 *
 * ⚠️ AND THE NUMERIC ORACLE WAS SILENTLY WRONG FOR STRINGS, which is how item 1919 found this:
 * `Number('apple')` is NaN, so every `Number(b) < Number(a)` was false and the reduce returned the
 * FIRST element — reporting `fig` as the minimum of `[pear, apple, fig, apple, quince]` while the
 * engine correctly said `apple`. An oracle that cannot read its own fixture's type is not an oracle.
 */
const lessThan = (vals: readonly unknown[]): ((a: unknown, b: unknown) => boolean) =>
  vals.every((v) => v === null || v === undefined || typeof v === 'string')
    ? (a, b) => String(b) < String(a)
    : (a, b) => Number(b) < Number(a);

const greaterThan = (vals: readonly unknown[]): ((a: unknown, b: unknown) => boolean) =>
  vals.every((v) => v === null || v === undefined || typeof v === 'string')
    ? (a, b) => String(b) > String(a)
    : (a, b) => Number(b) > Number(a);

describe('a residual min/max over the fused values walk', () => {
  test('agrees with a plain JavaScript reduce over the walk’s own output', () => {
    for (const [name, vals] of Object.entries(FIXTURES)) {
      if (name === 'mixed strings and numbers') {
        continue; // see the note on the oracle below
      }

      const g = build(vals);
      // Exactly the values being reduced — the walk WITHOUT the aggregate.
      const walked = toArray(traversal(V(), out('E'), values('k')), g);

      for (const kind of ['min', 'max'] as const) {
        const got = toArray(
          traversal(V(), out('E'), values('k'), kind === 'min' ? min() : max()),
          g,
        );
        const nonNull = walked.filter((v) => v !== null && v !== undefined);
        /**
         * ⚠️ A NUMERIC reduce, and the first version of this oracle compared as STRINGS — which
         * made it report `-1` as the minimum of `[-5, 0, 3, -1, 0]`, because `'-1' < '-5'`
         * lexicographically. The engine was right and the oracle was wrong. The mixed-type fixture
         * is excluded below for the same reason: replicating `compareTotal`'s cross-type order here
         * would be re-implementing the thing under test, so that case is covered by the
         * element-reading arm instead.
         */
        const cmp = kind === 'min' ? lessThan(vals) : greaterThan(vals);
        const expected =
          nonNull.length === 0 ? null : nonNull.reduce((a, b) => (cmp(a, b) ? b : a));

        /**
         * ⚠️ THE LENGTH IS PART OF THE ASSERTION, and `got[0] ?? null` alone was not enough: a
         * mutant that answered NOTHING for an all-null input instead of `[null]` survived, because
         * `undefined ?? null` and `null` render identically. These four terminals always emit
         * exactly one value, so the arity is as much the contract as the value.
         *
         * ⚠️ Compared as a STRING so a `null` answer and a `0` answer cannot be confused — on the
         * `negatives and zero` fixture the correct `min` IS a falsy value.
         */
        expect(`${name}/${kind}: len=${String(got.length)} ${JSON.stringify(got[0] ?? null)}`).toBe(
          `${name}/${kind}: len=1 ${JSON.stringify(expected ?? null)}`,
        );
      }
    }
  });

  test('agrees at two hops as well as one', () => {
    for (const [name, vals] of Object.entries(FIXTURES)) {
      if (name === 'mixed strings and numbers') {
        continue;
      }

      const g = build(vals);
      const walked = toArray(traversal(V(), out('E'), out('E'), values('k')), g);
      const got = toArray(traversal(V(), out('E'), out('E'), values('k'), min()), g);
      const nonNull = walked.filter((v) => v !== null && v !== undefined);

      const cmp = lessThan(vals);

      expect(`${name}: ${JSON.stringify(got[0] ?? null)}`).toBe(
        `${name}: ${JSON.stringify(
          nonNull.length === 0 ? null : nonNull.reduce((a, b) => (cmp(a, b) ? b : a)),
        )}`,
      );
    }
  });

  /**
   * ⚠️ THE SCAN SPELLING IS THE SECOND OPINION. `V().values(k).min()` goes through
   * `fusedValuesAggregate`'s element-reading arm — the near-twin this fold mirrors — so agreeing
   * with it on the same values is what shows the two have not drifted.
   */
  test('agrees with the element-reading arm on the same values', () => {
    for (const vals of Object.values(FIXTURES)) {
      const g = build(vals);

      for (const kind of ['min', 'max'] as const) {
        const agg = kind === 'min' ? min : max;
        const viaScan = toArray(traversal(V(), values('k'), agg()), g);
        const viaHop = toArray(traversal(V(), out('E'), values('k'), agg()), g);

        // Every vertex has exactly one in-edge here, so the hop visits the same multiset.
        expect(JSON.stringify(viaHop[0] ?? null)).toBe(JSON.stringify(viaScan[0] ?? null));
      }
    }
  });
});

describe('the residual fold refuses what it must', () => {
  test('sum and mean are NOT folded', () => {
    expect(fusableProjectedAggregate([{ kind: 'sum' }] as never)).toBeUndefined();
    expect(fusableProjectedAggregate([{ kind: 'mean' }] as never)).toBeUndefined();
    expect(fusableProjectedAggregate([{ kind: 'min' }] as never)).toBe('min');
    expect(fusableProjectedAggregate([{ kind: 'max' }] as never)).toBe('max');
  });

  test('a non-global scope, a longer residual and an empty one are refused', () => {
    expect(fusableProjectedAggregate([{ kind: 'min', scope: 'local' }] as never)).toBeUndefined();
    expect(
      fusableProjectedAggregate([{ kind: 'min' }, { kind: 'count' }] as never),
    ).toBeUndefined();
    expect(fusableProjectedAggregate([])).toBeUndefined();
  });

  /** And `sum`/`mean` still ANSWER correctly down the pipeline. */
  test('sum and mean still answer', () => {
    const g = build(FIXTURES.plain);
    const walked = toArray(traversal(V(), out('E'), values('k')), g) as number[];
    const total = walked.reduce((a, b) => a + b, 0);

    expect(toArray(traversal(V(), out('E'), values('k'), sum()), g)[0]).toBe(total);
    expect(toArray(traversal(V(), out('E'), values('k'), mean()), g)[0]).toBe(
      total / walked.length,
    );
  });
});

/**
 * THE EAGER DRAIN (item 1919) — **2.00x on `values(s).min()` and 1.93x on `max`**, interleaved over
 * 3 rounds at 200,000 vertices / 1,000,000 edges with both controls flat:
 *
 *     values(s).min()   191.53 -> 95.62 ms    its own floor, values(s), is 75.10
 *     values(s).max()   176.52 -> 91.61
 *     values(k).min()    71.94 -> 67.74       numeric, already near its 62.81 floor
 *
 * ⚠️ WHY THE STRING KEY GAINS 8x WHAT THE NUMERIC ONE DOES, because it is NOT the comparator:
 * `strcmp-ceiling-1919.mjs` priced all 800,000 string comparisons at ~11 ms in a tight loop against
 * a 123 ms gap. Both profiles put >52% in the SAME frame — the CSR walk's lazy iterator — costing
 * ~105 ns an element for numbers and ~210 for strings, because the fixture's numbers yield as SMIs
 * where a string yields a HEAP POINTER across the generator boundary. Removing the generator
 * removes that difference.
 *
 * ⚠️ AND THESE TESTS EXIST SO THE DRAIN IS NOT A ROUTE-ONLY CHANGE. Taking a walk's `drain` yields
 * the same elements in the same order, so no answer test can see it — `projected-fold.test.ts` hit
 * exactly this and solved it the same way, with a walk whose `drain` and iterator DISAGREE. Without
 * these two, a mutant reverting the drain survives the whole suite.
 */
describe('the min/max fold takes the walk drain', () => {
  test('foldProjectedMinMax uses the walk DRAIN when present', () => {
    let drained = 0;
    const walk = {
      *[Symbol.iterator]() {
        yield 999;
      },
      drain: () => {
        drained += 1;

        return [5, 3, 7];
      },
    };

    // 3 is the min of the DRAINED values; 999 is what the iterator would have given.
    expect(foldProjectedMinMax(walk, 'min')).toStrictEqual([3]);
    expect(drained).toBe(1);
  });

  test('and falls back to iteration when the walk offers no drain', () => {
    let iterated = 0;
    const walk = {
      *[Symbol.iterator]() {
        iterated += 1;

        yield 5;

        yield 3;

        yield 7;
      },
    };

    expect(foldProjectedMinMax(walk, 'max')).toStrictEqual([7]);
    expect(iterated).toBe(1);
    // A plain array has no `drain` either, which is how every other test here calls it.
    expect(foldProjectedMinMax([5, 3, 7], 'min')).toStrictEqual([3]);
  });

  /** The drain must not change WHICH value wins for a string column — the shape item 1919 sped up. */
  test('a string column answers the same through either path', () => {
    const g = build(FIXTURES['all strings']);
    const walked = toArray(traversal(V(), out('E'), values('k')), g) as string[];
    // Code-point order for ASCII; `localeCompare` would be a different order and not the contract.
    const oracle = [...walked].sort((a, b) => {
      if (a < b) {
        return -1;
      }

      return a > b ? 1 : 0;
    });

    expect(toArray(traversal(V(), out('E'), values('k'), min()), g)).toStrictEqual([oracle[0]]);
    expect(toArray(traversal(V(), out('E'), values('k'), max()), g)).toStrictEqual([
      oracle[oracle.length - 1],
    ]);
  });
});
