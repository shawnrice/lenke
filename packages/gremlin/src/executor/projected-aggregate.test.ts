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
import { fusableProjectedAggregate } from './aggregation.js';

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
  single: [42],
};

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
        const expected =
          nonNull.length === 0
            ? null
            : nonNull.reduce((a, b) =>
                (kind === 'min' ? Number(b) < Number(a) : Number(b) > Number(a)) ? b : a,
              );

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

      expect(`${name}: ${JSON.stringify(got[0] ?? null)}`).toBe(
        `${name}: ${JSON.stringify(
          nonNull.length === 0 ? null : nonNull.reduce((a, b) => (Number(b) < Number(a) ? b : a)),
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
