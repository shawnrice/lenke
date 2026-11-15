import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

// Item 1926 — `boundExprs` admitted only `cheapPureExpr(expr) || SUBQUERY_EXPRS.has(expr.kind)`, so
// a `LET` bound to ARITHMETIC never folded and the query kept a standing `LET` — which is off every
// one of the twenty-one rungs. Measured at 200,000 vertices, one shape per process:
//
// ```text
//   MATCH (n:T) LET a = n.n + 1 RETURN a AS x    54.99 ms -> 8.33   the LET folds
//   MATCH (n:T) RETURN (n.n + 1) * 2 AS x        12.45            the folded ceiling (TWO ops)
//   MATCH (n:T) RETURN n.n AS x                   7.16            the control, flat
// ```
//
// ⚠️⚠️ THE FOLD IS ANSWER-EQUIVALENT, so NO test over rows can tell a folded plan from a standing
// one ([[perf-gate-needs-its-own-test]]). Every case here therefore asserts BOTH: the rows (the
// fold must not change them) and the CLAUSE KINDS `compileLinear` ended up with (the fold must
// actually happen, or not happen, as the case requires).
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, props: Record<string, unknown>) =>
    g.addVertex({ id, labels: ['T'], properties: props });

  const a = v('a', { n: 1, k: 'ka' });
  const b = v('b', { n: 2, k: 'kb' });

  v('c', { n: 3, k: 'kc' });
  v('nonum', { k: 'kd' }); // no `n` at all, so arithmetic over it is NULL
  g.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
  g.addEdge({ from: b, to: a, labels: ['E'], properties: {} });

  return g;
};

const g = build();

/** The clause kinds the planner ended up with — `let` present means the binder still stands. */
const clauseKinds = (text: string): readonly string[] => {
  const parsed = parse(text) as { parts?: readonly unknown[] };
  const linear = (parsed.parts === undefined ? parsed : parsed.parts[0]) as Parameters<
    typeof compileLinear
  >[0];

  return compileLinear(linear).clauses.map((c) => c.kind);
};

const rows = (text: string) => query(g, text, {});

describe('a trailing LET of ANY expression folds when its name is read exactly once', () => {
  test('arithmetic folds, and answers what its hand-folded spelling answers', () => {
    const viaLet = 'MATCH (n:T) LET a = n.n + 1 RETURN a AS x ORDER BY x';
    const hand = 'MATCH (n:T) RETURN (n.n + 1) AS x ORDER BY x';

    expect(clauseKinds(viaLet)).toEqual(['match', 'return']);
    expect(clauseKinds(hand)).toEqual(['match', 'return']);
    expect(rows(viaLet)).toEqual(rows(hand));
    // The absent `n` row is the one a fold could change: NULL arithmetic must stay NULL.
    expect(rows(viaLet)).toEqual([{ x: 2 }, { x: 3 }, { x: 4 }, { x: null }]);
  });

  test('the COLUMN NAME survives an un-aliased RETURN of the bound name', () => {
    // A `LET` names a BINDING and an un-aliased `RETURN a` takes its column name from the
    // expression, so substituting without pinning the alias would rename `a` to the arithmetic.
    const out = rows('MATCH (n:T) LET a = n.n + 1 RETURN a ORDER BY a');

    expect(Object.keys(out[0] as object)).toEqual(['a']);
  });

  test('a function call folds through the function-argument arm', () => {
    const viaLet = 'MATCH (n:T) LET a = n.n + 1 RETURN abs(a) AS x ORDER BY x';

    expect(clauseKinds(viaLet)).toEqual(['match', 'return']);
    expect(rows(viaLet)).toEqual(rows('MATCH (n:T) RETURN abs(n.n + 1) AS x ORDER BY x'));
  });

  test('a hop shape folds too — the admission is not node-specific', () => {
    const viaLet = 'MATCH (a:T)-[:E]->(b:T) LET v = b.n + 1 RETURN v AS x ORDER BY x';

    expect(clauseKinds(viaLet)).toEqual(['match', 'return']);
    expect(rows(viaLet)).toEqual(rows('MATCH (a:T)-[:E]->(b:T) RETURN (b.n + 1) AS x ORDER BY x'));
  });
});

describe('the once-read guard is what makes admitting any expression sound', () => {
  test('read TWICE inside one expression: the LET STANDS', () => {
    // `subst` is one level only, so `a + a` is not a bare name and not a function argument — it
    // leaves a mention and the rewrite declines. Folding it would evaluate `n.n + 1` twice a row.
    const text = 'MATCH (n:T) LET a = n.n + 1 RETURN a + a AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual([{ x: 4 }, { x: 6 }, { x: 8 }, { x: null }]);
  });

  test('read TWICE as two FUNCTION ARGUMENTS: the LET STANDS', () => {
    // ⚠️ THE CASE THE OLD COUNTER GOT WRONG. `reads` counted guarded NAMES whose free-var set
    // intersects, not OCCURRENCES, so this scored 1, passed the guard, and `subst`'s
    // function-argument arm then substituted BOTH — doubling the work the guard holds constant.
    const text = 'MATCH (n:T) LET a = n.n + 1 RETURN power(a, a) AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual(rows('MATCH (n:T) RETURN power(n.n + 1, n.n + 1) AS x ORDER BY x'));
  });

  test('read ONCE in the projection and ONCE in ORDER BY: the LET STANDS', () => {
    const text = 'MATCH (n:T) LET a = n.n + 1 RETURN a AS x ORDER BY a';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual([{ x: 2 }, { x: 3 }, { x: 4 }, { x: null }]);
  });

  test('read ZERO times: the LET STANDS, so an expression that could fault still runs', () => {
    const text = 'MATCH (n:T) LET a = n.n + 1 RETURN n.k AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual([{ x: 'ka' }, { x: 'kb' }, { x: 'kc' }, { x: 'kd' }]);
  });

  test('a CHEAP binding is NOT guarded, so it folds read twice and read zero times', () => {
    // `cheapPureExpr` — property, variable, literal, parameter — may be duplicated or dropped
    // freely, which is why the guard applies to its complement and not to everything.
    const twice = 'MATCH (n:T) LET a = n.n RETURN a + a AS x ORDER BY x';
    const zero = 'MATCH (n:T) LET a = n.n RETURN n.k AS x ORDER BY x';

    // `a + a` is still not a bare name, so the one-level `subst` declines it on SHAPE — but the
    // ORDER BY twin is a bare name and folds, which is the distinction that matters.
    expect(clauseKinds('MATCH (n:T) LET a = n.n RETURN a AS x ORDER BY a')).toEqual([
      'match',
      'return',
    ]);
    expect(clauseKinds(zero)).toEqual(['match', 'return']);
    expect(rows(twice)).toEqual([{ x: 2 }, { x: 4 }, { x: 6 }, { x: null }]);
    expect(rows(zero)).toEqual([{ x: 'ka' }, { x: 'kb' }, { x: 'kc' }, { x: 'kd' }]);
  });

  test('a SUBQUERY binding still behaves exactly as it did before the widening', () => {
    const once = 'MATCH (n:T) LET c = COUNT { MATCH (n)-[:E]->(x) } RETURN c AS x ORDER BY x';
    const twice = 'MATCH (n:T) LET c = COUNT { MATCH (n)-[:E]->(x) } RETURN c + c AS x ORDER BY x';

    expect(clauseKinds(once)).toEqual(['match', 'return']);
    expect(clauseKinds(twice)).toEqual(['match', 'let', 'return']);
    expect(rows(once)).toEqual([{ x: 0 }, { x: 0 }, { x: 1 }, { x: 1 }]);
    expect(rows(twice)).toEqual([{ x: 0 }, { x: 0 }, { x: 2 }, { x: 2 }]);
  });
});

describe('what the widening does NOT change', () => {
  test('TWO LET items in one clause still decline', () => {
    // A later item may READ an earlier one, so one substitution map would rewrite `b` to `a` with
    // `a` no longer bound.
    const text = 'MATCH (n:T) LET a = n.n + 1, b = a * 2 RETURN b AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual([{ x: 4 }, { x: 6 }, { x: 8 }, { x: null }]);
  });

  test('a CHAIN of LETs folds only the LAST one, leaving one standing', () => {
    // `inlineTrailingLet` runs ONCE, not to a fixpoint. The incidental gain is that the last
    // binder now folds at all: 74.15 -> 63.38 ms at 200,000 rows.
    const text = 'MATCH (n:T) LET a = n.n + 1 LET b = a * 2 RETURN b AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual([{ x: 4 }, { x: 6 }, { x: 8 }, { x: null }]);
  });
});
