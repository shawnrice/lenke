/*
 * Item 2173 — `coalesce` stops at the first non-nullish argument, but ONLY when no later argument can
 * raise.
 *
 * ```text
 *     one shape per PROCESS, median of reps 26-40, order alternated
 *     row                     BEFORE     NEW
 *     coalesce 4 args           9.72     6.58    1.48x — now EQUAL to the bare sum floor
 *     coalesce 2 args           7.25     6.60    1.10x
 *     1st arg always null       8.17     7.95    flat, nothing to save
 *     a raising later arg       8.37     8.40    flat — the declining path is untouched
 *     sum(a.k) [floor]          5.91     6.30    +6.6% (executor-edits-perturb's range)
 * ```
 *
 * **THE POINT OF THIS FILE IS THE SEMANTIC `coalesceCall`'s NOTE PROTECTS, AND THAT NOTE IS RIGHT.**
 * `coalesce(a.k, f())` must keep raising whatever `f()` raises even when `a.k` is non-null, because which
 * errors surface is behaviour, not speed. So the gate is on the ARGUMENTS: a literal, a property read
 * and a variable read cannot raise (a missing property normalizes to `null`), and only then may the loop
 * stop early. **Both closures exist and the compiler picks per call site.**
 *
 * IMPORTS COME FROM `./index.js`, THE SOURCE — item 2169 lost a whole mutation round to importing the
 * built package instead.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/** `a` has `k`; `b` has an explicit null `k`; `c` has no `k` at all. All three carry `j`. */
const g = (): Graph => {
  const graph = new Graph();

  graph.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, j: 10, s: 'x' } });
  graph.addVertex({ id: 'b', labels: ['P'], properties: { k: null, j: 20, s: 'y' } });
  graph.addVertex({ id: 'c', labels: ['P'], properties: { j: 30, s: 'z' } });

  return graph;
};

const col = (q: string): unknown[] => {
  const out = query(g(), q) as unknown as { rows?: Record<string, unknown>[] };
  const rows = out.rows ?? (out as unknown as Record<string, unknown>[]);

  return rows.map((r) => r.c);
};

describe('the coalesce short-circuit (item 2173)', () => {
  describe('the short-circuiting form answers what the evaluating form answers', () => {
    test('a property fallback, over present / null / absent', () => {
      // a.k=1 wins; b.k is null so j=20; c has no k so j=30.
      expect(col('MATCH (a:P) RETURN coalesce(a.k, a.j) AS c ORDER BY c')).toStrictEqual([
        1, 20, 30,
      ]);
    });

    test('a literal fallback', () => {
      expect(col('MATCH (a:P) RETURN coalesce(a.k, 0) AS c ORDER BY c')).toStrictEqual([0, 0, 1]);
    });

    test('FOUR arguments — the form the 1.48x came from', () => {
      /*
       * The first non-nullish wins and the REST ARE NEVER EVALUATED now. The answer must not change:
       * a.k=1 for `a`, then j for the other two.
       */
      expect(col('MATCH (a:P) RETURN coalesce(a.k, a.j, a.j, 0) AS c ORDER BY c')).toStrictEqual([
        1, 20, 30,
      ]);
    });

    test('EVERY argument nullish yields null, not the last value', () => {
      expect(col('MATCH (a:P) RETURN coalesce(a.nope, a.alsoNope) AS c')).toStrictEqual([
        null,
        null,
        null,
      ]);
    });

    test('the FIRST non-nullish wins, not the last', () => {
      // Both present: `j` must not overwrite `k`.
      expect(col('MATCH (a:P) WHERE a.k = 1 RETURN coalesce(a.k, a.j) AS c')).toStrictEqual([1]);
    });

    test('a single argument is the identity', () => {
      expect(col('MATCH (a:P) RETURN coalesce(a.j) AS c ORDER BY c')).toStrictEqual([10, 20, 30]);
    });

    test('a STRING argument, so the fast path is not numeric-only', () => {
      expect(col('MATCH (a:P) RETURN coalesce(a.missing, a.s) AS c ORDER BY c')).toStrictEqual([
        'x',
        'y',
        'z',
      ]);
    });
  });

  describe('the semantic the gate protects', () => {
    test('a RAISING later argument still raises, even when the first is non-null', () => {
      /*
       * THE WHOLE REASON THE GATE EXISTS. `coalesce(a.k, <raises>)` raised before this change and
       * must raise after it: which errors surface is behaviour. The gate refuses to short-circuit when
       * any later argument is anything but a literal, a property read or a variable — so this spelling
       * keeps the original evaluate-everything closure.
       *
       * `a.s` is the STRING 'x', so the arithmetic is a type error on every row — including the rows
       * where `a.k` is non-null, which is exactly the case a short-circuit would have hidden.
       */
      expect(() => col('MATCH (a:P) RETURN coalesce(a.k, a.s + 1) AS c')).toThrow();
    });

    test('ONE SAFE argument before a RAISING one still raises', () => {
      /*
       * THE GAP THE MUTATION ROUND FOUND. A gate written `.some(cannotRaise)` instead of
       * `.every(cannotRaise)` is indistinguishable when there is exactly ONE later argument — a raising
       * one makes both false. With a SAFE argument beside it, `.some` is satisfied by `a.j` alone and
       * would short-circuit past `a.s + 1`, hiding the error this engine must still raise.
       */
      expect(() => col('MATCH (a:P) RETURN coalesce(a.k, a.j, a.s + 1) AS c')).toThrow();
    });

    test('a function call as a later argument is NOT short-circuited, and the answer is unchanged', () => {
      // `abs` cannot raise on these rows, but the gate refuses it anyway — conservative by design.
      expect(col('MATCH (a:P) RETURN coalesce(a.k, abs(a.j)) AS c ORDER BY c')).toStrictEqual([
        1, 20, 30,
      ]);
    });

    test('a raising argument FIRST still raises — the gate only looks at LATER arguments', () => {
      /*
       * The first argument is always evaluated by both closures, so a raise there is unconditional and
       * the gate has nothing to say about it.
       */
      expect(() => col('MATCH (a:P) RETURN coalesce(a.s + 1, a.k) AS c')).toThrow();
    });
  });

  test('nested inside an aggregate, which is where the row was measured', () => {
    expect(col('MATCH (a:P) RETURN sum(coalesce(a.k, a.j, a.j, 0)) AS c')).toStrictEqual([51]);
    // 1 + 20 + 30 = 51, derived: a.k=1 wins for `a`, then j for b and c.
  });
});
