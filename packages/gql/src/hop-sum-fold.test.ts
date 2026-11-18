/*
 * Item 2159 — `sum()` over a hop streams into an accumulator instead of collecting an array.
 *
 * ⚠️⚠️ **THE WIN IS ~1.1x, NOT THE 3.6x THE BENCH ROW SUGGESTED, AND THE DIFFERENCE IS A CORRECTNESS
 * REQUIREMENT.** `max` costs 14.5 ms on this shape where `sum` costs 93.5, and that gap is the WALK:
 * `max` is order-insensitive so the planner takes the far-driven walk, while `sum` must take the
 * start-driven one. Float addition is not associative, so reordering the addends changes the last ulp and
 * breaks byte-identity with the Rust engine. 🔑 An ablation isolates it — `sum(1)` 48.25 ms against
 * `max(1)` 12.88 with no property read at all.
 *
 * ⚠️ So what this fold removes is only the `values` array plus `aggregateOverValues`' three further
 * passes (`some(isTemporal)`, `some(Array.isArray)`, `reduce`): measured 1.09x on the far side and 1.15x
 * on the start side, answers identical.
 *
 * 🔑🔑 **THE TESTS THAT MATTER ARE THE FALLBACK ONES.** `SUM_FOLD` bails on anything that is not a plain
 * number, because a column containing any temporal must route to `temporalSum`, which needs every value
 * in hand. A bail must produce the SAME answer or the SAME error as before the fold existed.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** `n` numeric, `s` a string, and one hop per vertex so a hop aggregate has rows. */
const graphOf = (values: readonly unknown[]): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'src', labels: ['P'], properties: { n: 1, s: 'a' } });

  for (const [i, v] of values.entries()) {
    g.addVertex({ id: `t${i}`, labels: ['P'], properties: { n: v, s: `s${i}` } });
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById('src')!,
      to: g.getVertexById(`t${i}`)!,
      labels: ['T'],
      properties: { w: i },
    });
  }

  return g;
};

const HOP_SUM = 'MATCH (a:P)-[:T]->(b) RETURN sum(b.n) AS c';

describe('the hop sum fold (item 2159)', () => {
  describe('🔑 the arithmetic', () => {
    test('sums the far-side column', () => {
      // 1 + 2 + 3 = 6; `src`'s own n = 1 is not a far end of any edge.
      expect(query(graphOf([1, 2, 3]), HOP_SUM)[0].c).toBe(6);
    });

    test('⚠️ NULLs are skipped, not coerced to zero', () => {
      /*
       * 🔑 `isNullish` filtering happens in the caller, BEFORE either arm — so this pins that the fold
       * did not duplicate (or drop) that rule. A `null` coerced to 0 would still give 6 here, which is
       * why the count below matters too.
       */
      const g = graphOf([1, null, 2, 3]);

      expect(query(g, HOP_SUM)[0].c).toBe(6);
      // ⚠️ And the walk really did see four rows, so the null was skipped rather than absent.
      expect(query(g, 'MATCH (a:P)-[:T]->(b) RETURN count(*) AS c')[0].c).toBe(4);
    });

    test('an EMPTY input sums to 0, as `reduce(…, 0)` did', () => {
      const g = new Graph();

      g.addVertex({ id: 'lonely', labels: ['P'], properties: { n: 5 } });

      expect(query(g, HOP_SUM)[0].c).toBe(0);
    });

    test('⚠️ every value NULL also sums to 0', () => {
      expect(query(graphOf([null, null]), HOP_SUM)[0].c).toBe(0);
    });

    test('negatives and floats', () => {
      expect(query(graphOf([1.5, -2.5, 1]), HOP_SUM)[0].c).toBe(0);
      expect(query(graphOf([0.1, 0.2]), HOP_SUM)[0].c).toBeCloseTo(0.3, 10);
    });

    test('🔑 the START-side and EDGE-side spellings agree with the engine', () => {
      const g = graphOf([1, 2, 3]);

      // `src` is the start of all three edges, so sum(a.n) is 1+1+1.
      expect(query(g, 'MATCH (a:P)-[:T]->(b) RETURN sum(a.n) AS c')[0].c).toBe(3);
      // Edge `w` values are 0, 1, 2.
      expect(query(g, 'MATCH (a:P)-[e:T]->(b) RETURN sum(e.w) AS c')[0].c).toBe(3);
    });
  });

  describe('⚠️⚠️ the BAIL-OUT, which must not change an answer or an error', () => {
    test('a STRING column still throws, with the same code', () => {
      /*
       * 🔑 The sentinel is caught and the collecting arm re-runs, which is what produces this error —
       * so the message and code come from `aggregateOverValues` exactly as before. ⚠️ A fold that let
       * its own `Symbol` escape would surface an unhelpful throw instead.
       */
      const run = (): unknown =>
        query(graphOf([1, 2]), 'MATCH (a:P)-[:T]->(b) RETURN sum(b.s) AS c');

      expect(run).toThrow();
      // ⚠️ A real engine error with its own code, not a leaked sentinel.
      expect(run).toThrow(expect.objectContaining({ code: 'E_INVALID_VALUE' }));
    });

    test('⚠️ a column that is numeric UNTIL the last row still bails correctly', () => {
      /*
       * 🔑 THE SHARPEST BAIL CASE: the fold has already accumulated three numbers when it meets the
       * string, so the fallback must discard that partial sum and re-run from scratch. A fold that
       * returned its partial accumulator would answer 6 instead of throwing.
       */
      const g = graphOf([1, 2, 3]);

      g.addVertex({ id: 'bad', labels: ['P'], properties: { n: 'not a number' } });
      g.addEdge({
        id: 'ebad',
        from: g.getVertexById('src')!,
        to: g.getVertexById('bad')!,
        labels: ['T'],
        properties: {},
      });

      expect(() => query(g, HOP_SUM)).toThrow();
    });

    test('a LIST value throws', () => {
      expect(() =>
        query(graphOf([1, 2]), 'MATCH (a:P)-[:T]->(b) RETURN sum([1, 2]) AS c'),
      ).toThrow();
    });

    test('🔑 a BOOLEAN is not a plain number and so bails', () => {
      expect(() => query(graphOf([1, true, 2]), HOP_SUM)).toThrow();
    });
  });

  describe('⚠️ the aggregates that must NOT have changed', () => {
    test.each([
      ['max', 'MATCH (a:P)-[:T]->(b) RETURN max(b.n) AS c', 3],
      ['min', 'MATCH (a:P)-[:T]->(b) RETURN min(b.n) AS c', 1],
      ['count', 'MATCH (a:P)-[:T]->(b) RETURN count(b.n) AS c', 3],
      ['count(*)', 'MATCH (a:P)-[:T]->(b) RETURN count(*) AS c', 3],
    ])('%s', (_name, q, want) => {
      expect(query(graphOf([1, 2, 3]), q)[0].c).toBe(want);
    });

    test('avg still collects and still answers', () => {
      expect(query(graphOf([1, 2, 3]), 'MATCH (a:P)-[:T]->(b) RETURN avg(b.n) AS c')[0].c).toBe(2);
    });

    test('⚠️ sum over a plain SCAN is a different path and unchanged', () => {
      // src.n = 1 plus 1 + 2 + 3.
      expect(query(graphOf([1, 2, 3]), 'MATCH (a:P) RETURN sum(a.n) AS c')[0].c).toBe(7);
    });

    test('collect still returns every value, in walk order', () => {
      const rows = query(graphOf([1, 2, 3]), 'MATCH (a:P)-[:T]->(b) RETURN collect(b.n) AS c');

      expect(rows[0].c).toStrictEqual([1, 2, 3]);
    });
  });
});
