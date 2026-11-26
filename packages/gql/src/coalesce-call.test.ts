/*
 * Item 2165 — `coalesce(…)` compiled to a dedicated closure instead of the generic scalar call.
 *
 * ```text
 *     WHERE coalesce(a.k, 0) = 1     10.4 ms -> 8.0    1.27x
 *     WHERE coalesce(a.k, 0) = 0     10.5    -> 7.9    1.27x
 *     sum(coalesce(a.k, 0))          11.3    -> 8.2    1.31x
 *     coalesce(a.s, a.k, 0) (3 args) 14.2    -> 11.6   1.23x
 *     a.k = 1 / upper(a.s) [controls]            flat
 * ```
 *
 * `bufferedScalarCall` pays per ROW for things constant per call site: a `buf` array fill,
 * `assertScalarArgTypes`, and two table lookups before reaching the `coalesce` case.
 *
 * **THE 6.3x GAP TO `WHERE a.k = 1` IS NOT CLOSED — 8.0 against 2.6 is still 3.1x.** Item 2164
 * established that an AST rewrite folding the two spellings is a NO-OP (the engine already converges them
 * below the AST), so what remains is per-row closure cost, not a routing difference.
 *
 * **THE SEMANTIC THIS FILE EXISTS TO PIN: every argument is still EVALUATED.** Short-circuiting would
 * be faster again, but `coalesce(a.k, <raises>)` raises today even when `a.k` is non-null, and changing
 * which errors surface is a semantic change rather than a speed-up.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** One vertex per row of the table: a present value, an explicit null, and an ABSENT property. */
const g = (() => {
  const graph = new Graph();

  graph.addVertex({ id: 'has', labels: ['P'], properties: { k: 7, s: 'x', tag: 'has' } });
  graph.addVertex({ id: 'isnull', labels: ['P'], properties: { k: null, s: null, tag: 'isnull' } });
  graph.addVertex({ id: 'absent', labels: ['P'], properties: { tag: 'absent' } });

  return graph;
})();

const val = (expr: string, tag: string): unknown =>
  query(g, `MATCH (a:P) WHERE a.tag = '${tag}' RETURN ${expr} AS c`)[0]?.c;

describe('the coalesce closure (item 2165)', () => {
  describe('the FIRST non-nullish argument wins', () => {
    test('a present first argument is returned', () => {
      expect(val('coalesce(a.k, 0)', 'has')).toBe(7);
    });

    test('an explicit NULL falls through to the default', () => {
      expect(val('coalesce(a.k, 0)', 'isnull')).toBe(0);
    });

    test('an ABSENT property falls through too', () => {
      /*
       * A missing property reads as `undefined` rather than `null`, and both are nullish here — a
       * closure testing only `=== null` would return `undefined` for this row.
       */
      expect(val('coalesce(a.k, 0)', 'absent')).toBe(0);
    });

    test('the FIRST non-nullish, not the last', () => {
      // Both present: `a.k` wins.
      expect(val('coalesce(a.k, 99)', 'has')).toBe(7);
      // First nullish, second present, third present: the SECOND wins.
      expect(val('coalesce(a.k, 5, 99)', 'isnull')).toBe(5);
    });

    test('ALL arguments nullish answers NULL, not undefined', () => {
      /*
       * `firstNonNullish` returns `null`, and a closure returning `undefined` instead would be a wrong
       * answer that `toBeNull` catches and a loose check would not.
       */
      expect(val('coalesce(a.k, a.s)', 'isnull')).toBeNull();
      expect(val('coalesce(a.k, a.s)', 'absent')).toBeNull();
    });

    test('a ONE-argument coalesce is the identity, or null', () => {
      expect(val('coalesce(a.k)', 'has')).toBe(7);
      expect(val('coalesce(a.k)', 'isnull')).toBeNull();
    });

    test('FOUR arguments, with the live one last', () => {
      expect(val('coalesce(a.k, a.s, a.k, 42)', 'absent')).toBe(42);
    });

    test('a non-numeric value passes through unchanged', () => {
      expect(val('coalesce(a.s, 0)', 'has')).toBe('x');
    });
  });

  describe('every argument is still EVALUATED — no short-circuit', () => {
    test('a later argument that RAISES still raises, even when the first is non-null', () => {
      /*
       * THE SEMANTIC THE CLOSURE DELIBERATELY PRESERVES. `a.k` is 7 on this row, so a short-circuiting
       * coalesce would never evaluate the second argument and would answer 7. The generic path
       * evaluated all arguments and raised; this must too, or the change alters which errors surface.
       */
      expect(() =>
        query(g, "MATCH (a:P) WHERE a.tag = 'has' RETURN coalesce(a.k, upper(a.k)) AS c"),
      ).toThrow();
    });

    test('and the same expression with the raising argument FIRST also raises', () => {
      expect(() =>
        query(g, "MATCH (a:P) WHERE a.tag = 'has' RETURN coalesce(upper(a.k), a.k) AS c"),
      ).toThrow();
    });
  });

  describe('in the positions the measurement used', () => {
    test('as a filter', () => {
      expect(query(g, 'MATCH (a:P) WHERE coalesce(a.k, 0) = 7 RETURN count(*) AS c')[0].c).toBe(1);
      // `= 0` also matches the two nullish rows, which is why item 2164's rewrite needed `v !== d`.
      expect(query(g, 'MATCH (a:P) WHERE coalesce(a.k, 0) = 0 RETURN count(*) AS c')[0].c).toBe(2);
    });

    test('inside an aggregate', () => {
      // 7 + 0 + 0.
      expect(query(g, 'MATCH (a:P) RETURN sum(coalesce(a.k, 0)) AS c')[0].c).toBe(7);
    });

    test('a PROJECTION keeps NULL, where a filter would drop the row', () => {
      expect(val('coalesce(a.k, a.s)', 'isnull')).toBeNull();
      expect(query(g, 'MATCH (a:P) RETURN count(coalesce(a.k, a.s)) AS c')[0].c).toBe(1);
    });

    test('other scalars are untouched', () => {
      expect(val('upper(a.s)', 'has')).toBe('X');
      expect(val('nullif(a.k, 7)', 'has')).toBeNull();
      expect(val('nullif(a.k, 1)', 'has')).toBe(7);
    });
  });
});
