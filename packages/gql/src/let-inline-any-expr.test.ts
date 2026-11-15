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

// ————————————————————————————————————————————————————————————————————————————————————————————————
// Item 1927 — `subst` was ONE LEVEL ONLY: a bound name nested inside an operator was refused, and
// the stated reason was that a deeper walk "would drop the binder with the name still unbound" if
// it missed an arm of the 40-arm `Expr` union.
//
// 🔑 THAT PREMISE WAS AVOIDABLE. `substituteVarsDeep` is a WHITELIST and the `freePredicateVars`
// post-check (which this rewrite ALREADY did, one level up) turns a missed arm into a DECLINE. So
// the walk does not have to be exhaustive to be safe, only fail-safe. `letdeep-breadth-1927.ts`
// found 11 of 13 natural spellings stranded; measured at 200,000 vertices, one shape per process:
//
// ```text
//   LET c = n.n RETURN sum(c + 1)              77.91 ms ->  6.96   (hand twin  7.03)  11.2x
//   LET a = n.n RETURN n.k AS x ORDER BY a * 2 257.91   -> 33.88   (hand twin 39.29)   7.6x
//   LET a = n.n RETURN a * 2                    58.74   ->  9.27   (hand twin 12.77)   6.3x
//   LET a = n.n RETURN a > 5                    57.43   -> 10.07   (hand twin 10.86)   5.7x
//   CONTROL single (folded at 1926)              8.33   ->  8.28   flat
//   CONTROL plain                                6.64   ->  5.92   flat
// ```
describe('a bound name folds at any DEPTH inside a scalar expression', () => {
  /** Each pair must agree on rows AND compile to the same clauses as its hand-written twin. */
  const pairs: readonly (readonly [string, string, string])[] = [
    ['arith wrap', 'LET a = n.n RETURN a * 2 AS x', 'RETURN n.n * 2 AS x'],
    ['arith wrap, computed bind', 'LET a = n.n + 1 RETURN a * 2 AS x', 'RETURN (n.n + 1) * 2 AS x'],
    ['comparison', 'LET a = n.n RETURN a > 2 AS x', 'RETURN n.n > 2 AS x'],
    ['nested function arg', 'LET a = n.n RETURN abs(a + 1) AS x', 'RETURN abs(n.n + 1) AS x'],
    // ⚠️ THE OLD COMMENT'S OWN EXAMPLE of what it refused, and the family's biggest gap at 11.2x.
    ['aggregate over an expr', 'LET c = n.n RETURN sum(c + 1) AS x', 'RETURN sum(n.n + 1) AS x'],
    [
      'searched CASE',
      'LET a = n.n RETURN CASE WHEN a > 2 THEN 1 ELSE 0 END AS x',
      'RETURN CASE WHEN n.n > 2 THEN 1 ELSE 0 END AS x',
    ],
    [
      'simple CASE subject',
      'LET a = n.n RETURN CASE a WHEN 1 THEN 9 ELSE 0 END AS x',
      'RETURN CASE n.n WHEN 1 THEN 9 ELSE 0 END AS x',
    ],
    ['IN list', 'LET a = n.n RETURN a IN [1, 2] AS x', 'RETURN n.n IN [1, 2] AS x'],
    ['list element', 'LET a = n.n RETURN [a, 1] AS x', 'RETURN [n.n, 1] AS x'],
    ['map field', 'LET a = n.n RETURN {v: a} AS x', 'RETURN {v: n.n} AS x'],
    ['IS NULL', 'LET a = n.n RETURN a IS NULL AS x', 'RETURN n.n IS NULL AS x'],
    ['index base', 'LET a = n.n RETURN [10, 20, 30][a] AS x', 'RETURN [10, 20, 30][n.n] AS x'],
    ['string concat', "LET s = n.k RETURN s || '!' AS x", "RETURN n.k || '!' AS x"],
    ['nested string fns', 'LET s = n.k RETURN upper(trim(s)) AS x', 'RETURN upper(trim(n.k)) AS x'],
  ];

  for (const [label, letTail, handTail] of pairs) {
    test(`${label} folds and matches its hand-written twin`, () => {
      const viaLet = `MATCH (n:T) ${letTail} ORDER BY x`;
      const hand = `MATCH (n:T) ${handTail} ORDER BY x`;

      expect(clauseKinds(viaLet)).toEqual(['match', 'return']);
      expect(clauseKinds(hand)).toEqual(['match', 'return']);
      expect(rows(viaLet)).toEqual(rows(hand));
    });
  }

  test('ORDER BY wraps the name — 257.91 -> 33.88 ms, the family second-biggest gap', () => {
    const viaLet = 'MATCH (n:T) LET a = n.n RETURN n.k AS x ORDER BY a * 2, x';
    const hand = 'MATCH (n:T) RETURN n.k AS x ORDER BY n.n * 2, x';

    expect(clauseKinds(viaLet)).toEqual(['match', 'return']);
    expect(rows(viaLet)).toEqual(rows(hand));
  });

  test('a HOP shape folds too', () => {
    const viaLet = 'MATCH (a:T)-[:E]->(b:T) LET v = b.n RETURN v * 2 AS x ORDER BY x';
    const hand = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n * 2 AS x ORDER BY x';

    expect(clauseKinds(viaLet)).toEqual(['match', 'return']);
    expect(rows(viaLet)).toEqual(rows(hand));
  });
});

describe('the four omitted arms BIND names, so the rewrite declines rather than capturing', () => {
  /*
   * ⚠️⚠️ THIS IS THE SAFETY ARGUMENT FOR SUBSTITUTING AT DEPTH, and it is what makes the whitelist
   * sound. `exists` / `countSubquery` / `valueSubquery` carry `PathPattern`s whose variables share
   * a namespace with the bound name, and `letIn` introduces scoped locals that shadow it — so a
   * blind substitution inside any of them could CAPTURE. `substituteVarsDeep` leaves all four
   * alone, and the `freePredicateVars` post-check then declines the whole rewrite.
   *
   * Each case asserts the `LET` STANDS and the answer is the one the standing `LET` gives.
   */
  test('a name used free inside EXISTS: the LET stands', () => {
    const text =
      'MATCH (n:T) LET a = n.n + 1 RETURN exists { MATCH (n)-[:E]->(x:T) WHERE x.n = a } AS y ORDER BY y';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text).length).toBe(4);
  });

  test('a name used free inside COUNT { }: the LET stands', () => {
    const text =
      'MATCH (n:T) LET a = n.n + 1 RETURN COUNT { MATCH (n)-[:E]->(x:T) WHERE x.n = a } AS y ORDER BY y';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text).length).toBe(4);
  });

  test('a name used free inside LET … IN … END: the LET stands', () => {
    const text = 'MATCH (n:T) LET a = n.n + 1 RETURN (LET q = 5 IN a + q END) AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual(rows('MATCH (n:T) RETURN (n.n + 1) + 5 AS x ORDER BY x'));
  });

  test('a name SHADOWED inside LET … IN … END: the LET stands and the inner binding wins', () => {
    // Nothing needed substituting (the inner `a` is a different binding), and the outer `a` is read
    // ZERO times — which the once-read guard declines for a non-cheap binding.
    const text = 'MATCH (n:T) LET a = n.n + 1 RETURN (LET a = 5 IN a + 1 END) AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual([{ x: 6 }, { x: 6 }, { x: 6 }, { x: 6 }]);
  });

  test('a name in PROPERTY position (a.k) is a different transformation, so it declines', () => {
    // Substituting here would have to build `{kind:'field', base, key}`, not swap a node.
    // `prop` contributes its `variable` to `freePredicateVars`, so the post-check catches it.
    const text = 'MATCH (n:T) LET a = n RETURN a.k AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual([{ x: 'ka' }, { x: 'kb' }, { x: 'kc' }, { x: 'kd' }]);
  });
});

describe('the once-read guard still holds at depth', () => {
  test('read twice at DEPTH: the LET stands', () => {
    // Before item 1927 this declined on SHAPE (one-level `subst` refused the arith). Now the
    // substitution would reach both occurrences, so only the guard stops it — the count comes from
    // `substituteVarsDeep` itself, which reports 2.
    const text = 'MATCH (n:T) LET a = n.n + 1 RETURN (a * 2) + (a * 3) AS x ORDER BY x';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
    expect(rows(text)).toEqual(
      rows('MATCH (n:T) RETURN ((n.n + 1) * 2) + ((n.n + 1) * 3) AS x ORDER BY x'),
    );
  });

  test('read once in a nested position and once in ORDER BY: the LET stands', () => {
    const text = 'MATCH (n:T) LET a = n.n + 1 RETURN a * 2 AS x ORDER BY a + 1';

    expect(clauseKinds(text)).toEqual(['match', 'let', 'return']);
  });

  test('a CHEAP binding folds at depth however many times it is read', () => {
    const viaLet = 'MATCH (n:T) LET a = n.n RETURN (a * 2) + (a * 3) AS x ORDER BY x';
    const hand = 'MATCH (n:T) RETURN (n.n * 2) + (n.n * 3) AS x ORDER BY x';

    expect(clauseKinds(viaLet)).toEqual(['match', 'return']);
    expect(rows(viaLet)).toEqual(rows(hand));
  });
});
