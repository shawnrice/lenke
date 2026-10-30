import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Expr } from './ast.js';
import { compilePredicate } from './executor.js';
import { query } from './index.js';

// `directEqProps` declines its WHOLE chain on the first conjunct it cannot read, and a NESTED `and`
// — which is what parentheses produce — used to be one of those. The note it carried said "the
// parser produces one flat `items` list for `a AND b AND c`, so the nested shape arrives only from
// parenthesisation, and declining it is a missed optimisation, not a wrong answer". Both halves
// true, conclusion wrong: a cost that PARENTHESES alone turn on is this engine's named bug class.
// 200,000 vertices, all three answering an identical 2000 (item 1271):
//
//     a=50 AND b=0 AND c=0      3.558 ms -> 3.641    17.8 -> 18.2 ns/vertex   (control)
//     (a=50 AND b=0) AND c=0    7.615    -> 3.471    38.1 -> 17.4            2.19x
//     a=50 AND (b=0 AND c=0)    6.732    -> 3.740    33.7 -> 18.7            1.80x
//
// ⚠️ WHAT THIS FILE GUARDS is that parenthesisation changes NOTHING observable: not the answer, and
// not whether the query throws. The flatten is depth-first and left to right so the conjuncts
// arrive in WRITTEN order — the same order the flat spelling produces — because this loop groups
// what it lifts into families and the arrival order is the order a RAISE is reached in.
const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'all', labels: ['P'], properties: { a: 1, b: 2, c: 3, s: 'xx' } });
  g.addVertex({ id: 'two', labels: ['P'], properties: { a: 1, b: 2, c: 9, s: 'xx' } });
  g.addVertex({ id: 'one', labels: ['P'], properties: { a: 1, b: 9, c: 9, s: 'xx' } });
  g.addVertex({ id: 'none', labels: ['P'], properties: { a: 9, b: 9, c: 9, s: 'xx' } });
  g.addVertex({ id: 'nulled', labels: ['P'], properties: { a: 1, b: null, c: 3, s: 'xx' } });
  g.addVertex({ id: 'absent', labels: ['P'], properties: { a: 1, c: 3, s: 'xx' } });

  return g;
};

const g = build();
const countOf = (q: string): number => Number(query(g, q)[0].c);

describe('a nested AND is flattened into its conjuncts (item 1271)', () => {
  test('every parenthesisation of one conjunction answers the same', () => {
    // `all` is the only vertex matching all three. `nulled` and `absent` fail on `b` with UNKNOWN,
    // which a filter drops — and must drop identically however the conjunction is bracketed.
    const expected = 1;

    for (const where of [
      'n.a = 1 AND n.b = 2 AND n.c = 3',
      '(n.a = 1 AND n.b = 2) AND n.c = 3',
      'n.a = 1 AND (n.b = 2 AND n.c = 3)',
      '(n.a = 1) AND (n.b = 2) AND (n.c = 3)',
      '((n.a = 1 AND n.b = 2) AND n.c = 3)',
      '(n.a = 1 AND (n.b = 2 AND n.c = 3))',
    ]) {
      expect(countOf(`MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)).toBe(expected);
    }
  });

  test('nesting across DIFFERENT lifted families is also one answer', () => {
    // Three families at once — an equality, an ordering compare and a null test — bracketed four
    // ways. `all` and `nulled` carry c = 3; only `all` has b = 2.
    for (const where of [
      'n.a = 1 AND n.c > 2 AND n.b IS NOT NULL',
      '(n.a = 1 AND n.c > 2) AND n.b IS NOT NULL',
      'n.a = 1 AND (n.c > 2 AND n.b IS NOT NULL)',
      '(n.a = 1) AND (n.c > 2 AND n.b IS NOT NULL)',
    ]) {
      // `all`, `two` and `one` carry a = 1 with c > 2 and a non-null b; `nulled` and `absent` fail
      // the null test, and `none` fails on a.
      expect(countOf(`MATCH (n:P) WHERE ${where} RETURN count(*) AS c`)).toBe(3);
    }
  });

  test('⚠️ parenthesisation does not change WHETHER the query throws', () => {
    // `n.s` is a string in boolean context and must RAISE. Whether it is reached depends on what
    // the conjuncts before it do, so this is the assertion that a reordering flatten would break:
    // both spellings must behave alike, whichever way that is.
    const flat = () => query(g, 'MATCH (n:P) WHERE n.a = 1 AND n.s RETURN count(*) AS c');
    const nested = () => query(g, 'MATCH (n:P) WHERE (n.a = 1 AND n.s) RETURN count(*) AS c');
    const nestedDeep = () =>
      query(g, 'MATCH (n:P) WHERE ((n.a = 1) AND (n.s)) RETURN count(*) AS c');

    expect(flat).toThrow();
    expect(nested).toThrow();
    expect(nestedDeep).toThrow();
  });

  test('⚠️ ROUTE: a nested AND lifts EVERY conjunct, not just the outer level', () => {
    // Answer-equivalent, so only the compiler can see it: before the flatten, `compilePredicate`
    // returned a generic `where` and NO lifted lists for these trees.
    const eq = (key: string, value: number): Expr => ({
      kind: 'compare',
      op: '=',
      left: { kind: 'prop', variable: 'n', key },
      right: { kind: 'lit', value },
    });

    const nested: Expr = {
      kind: 'and',
      items: [{ kind: 'and', items: [eq('a', 1), eq('b', 2)] }, eq('c', 3)],
    };
    const nestedRight: Expr = {
      kind: 'and',
      items: [eq('a', 1), { kind: 'and', items: [eq('b', 2), eq('c', 3)] }],
    };

    for (const where of [nested, nestedRight]) {
      const pred = compilePredicate(undefined, where, 'n');

      expect(pred.eqProps?.length ?? 0).toBe(3);
      // A successful lift EMPTIES `where`; a partial lift would leave the rest behind and apply it
      // twice.
      expect(pred.where).toBeUndefined();
    }

    // WRITTEN ORDER, depth-first: the keys must come back a, b, c for both shapes. A flatten that
    // reversed or reordered would still answer correctly here, so the order is asserted directly.
    for (const where of [nested, nestedRight]) {
      expect(compilePredicate(undefined, where, 'n').eqProps?.map((p) => p.key)).toEqual([
        'a',
        'b',
        'c',
      ]);
    }
  });

  test('an UNLIFTABLE conjunct inside the nest still declines the whole chain', () => {
    // The decline is per-chain, not per-level: one conjunct this loop cannot read takes the whole
    // predicate to the generic evaluator. Flattening must not change that, only what counts as
    // readable. `n.a + 1 = 2` is an arithmetic left operand, which `asPropCompare` does not match.
    const where: Expr = {
      kind: 'and',
      items: [
        {
          kind: 'and',
          items: [
            {
              kind: 'compare',
              op: '=',
              left: {
                kind: 'arith',
                head: { kind: 'prop', variable: 'n', key: 'a' },
                tail: [['+', { kind: 'lit', value: 1 }]],
              },
              right: { kind: 'lit', value: 2 },
            },
          ],
        },
        {
          kind: 'compare',
          op: '=',
          left: { kind: 'prop', variable: 'n', key: 'c' },
          right: { kind: 'lit', value: 3 },
        },
      ],
    };
    const pred = compilePredicate(undefined, where, 'n');

    expect(pred.eqProps).toBeUndefined();
    expect(pred.where).toBeDefined();

    // And it still answers: `all`, `nulled` and `absent` all have a = 1, c = 3.
    expect(countOf('MATCH (n:P) WHERE (n.a + 1 = 2) AND n.c = 3 RETURN count(*) AS c')).toBe(3);
  });
});
