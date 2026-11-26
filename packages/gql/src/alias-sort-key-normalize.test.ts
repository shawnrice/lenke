/**
 * Item 1929: `normalizeAliasSortKeys` — an output ALIAS inside an `ORDER BY` key EXPRESSION.
 *
 * THIS WAS AN ABSENCE OF A RUNG, NOT A SLOW ONE, which is why no profile nominated it: the
 * general matcher is not a hot frame. `ORDER BY x + 1` and `ORDER BY n.n + 1` are the SAME question
 * — `x` IS `n.n`, by the projection's own definition — and the alias spelling, the more natural one
 * to write, reached nothing at all. Measured at 200,000 vertices, one shape per process:
 *
 * ```text
 *   RETURN n.n AS x ORDER BY x + 1               320.49 ms ->  94.32   3.40x  (twin 95.63)
 *   HOP  RETURN b.n AS x ORDER BY x + 1          392.88    -> 121.72   3.23x  (twin 123.71)
 *   RETURN n.n AS x ORDER BY x + 1, x            322.52    ->  85.85   3.76x
 *   CONTROL ORDER BY x                            48.16    ->  49.81   flat
 *   CONTROL HOP ORDER BY x                        72.75    ->  72.53   flat
 *   CONTROL ORDER BY n.n + 1                      96.58    ->  95.63   flat
 * ```
 *
 * WHAT GIVES THESE TESTS TEETH. The rewrite IS answer-equivalent, so the ROUTE is asserted as
 * well as the answer ([[perf-gate-needs-its-own-test]]) — and every answer is checked against the
 * spelling it must equal, as a QUERY rather than as a hand-written literal. That is deliberate: in
 * this session hand-written row literals have been wrong six times (NULL sorts LAST, not first),
 * while the engine was right each time.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { freePredicateVars } from './executor/expr-analysis.js';
import { compileLinear, normalizeAliasSortKeys } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

/** The fast-path detectors that fire for `src` — `routes-fired.test.ts`'s helper. */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([, v]) => typeof v === 'function')
    .map(([k]) => k)
    .sort();
};

/**
 * The `kind` of each resolved `ORDER BY` key expression, which is how a substitution is OBSERVED:
 * the rewrite is value-equal, so the rows cannot show whether it fired.
 */
const sortKeyKinds = (src: string): string[] => {
  // THE PASS'S OWN OUTPUT, not `compileLinear`'s — the compiled clause carries no AST `expr`,
  // so reading it threw. The pass is exported for exactly this: the rewrite is value-equal, so its
  // output PLAN is the only thing that can observe whether it fired ([[rewrite-composition-is-not-free]]).
  const q = parse(src) as never as { parts: readonly { clauses: readonly never[] }[] };
  const out = normalizeAliasSortKeys(q.parts[0].clauses) as unknown as readonly {
    projection?: { orderBy?: readonly { expr: { kind: string } }[] };
  }[];
  const last = out[out.length - 1];

  // THE FREE VARIABLES, NOT THE TOP-LEVEL `kind`. My first version read the kind, and it
  // CANNOT see the substitution: `c + 1` is an `arith` before and after, since only the leaf
  // changes. The free names show it exactly — an ALIAS name surviving means not substituted, the
  // scan variable means substituted.
  return (last.projection?.orderBy ?? []).map((k) =>
    [...freePredicateVars(k.expr as never)].sort().join('+'),
  );
};

/*
 * DISTINCT SORT KEYS, AND AN ORDER THAT IS NOT ARRIVAL ORDER. Item 1903 established that a
 * tie-heavy fixture lets a WRONG order share its first rows with the right one — on the perf
 * screen's own fixture a broken sort measured 7.6x faster and looked like a win. Here `n` is
 * distinct and deliberately anti-correlated with insertion order, and the edges point so that the
 * hop's arrival order differs from the sorted order too.
 */
const build = (): Graph => {
  const g = new Graph();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const ns = [40, 10, 50, 20, 30];

  ids.forEach((id, i) => {
    g.addVertex({ id, labels: ['T'], properties: { n: ns[i], k: `s${String(ns.length - i)}` } });
  });
  // One vertex with NO `n` at all, so every ordering has to place a NULL key.
  g.addVertex({ id: 'z', labels: ['T'], properties: { k: 's0' } });

  for (const [from, to] of [
    ['a', 'c'],
    ['b', 'a'],
    ['c', 'e'],
    ['d', 'b'],
    ['e', 'd'],
  ]) {
    const src = g.getVertexById(from);
    const dst = g.getVertexById(to);

    if (src === null || dst === null) {
      throw new Error(`fixture: missing ${from} or ${to}`);
    }

    g.addEdge({ from: src, to: dst, labels: ['E'], properties: {} });
  }

  return g;
};

const g = build();
const rows = (q: string) => query(g, q, {});

describe('an alias inside a sort-key EXPRESSION resolves to the expression it names', () => {
  /** `[label, the alias spelling, the property spelling it must equal]` */
  const pairs: readonly (readonly [string, string, string])[] = [
    [
      'arithmetic over the alias',
      'MATCH (n:T) RETURN n.n AS x ORDER BY x + 1',
      'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1',
    ],
    [
      'arithmetic, DESC',
      'MATCH (n:T) RETURN n.n AS x ORDER BY x + 1 DESC',
      'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1 DESC',
    ],
    [
      'a function over the alias',
      'MATCH (n:T) RETURN n.n AS x ORDER BY abs(x - 25)',
      'MATCH (n:T) RETURN n.n AS x ORDER BY abs(n.n - 25)',
    ],
    [
      'two terms, the first an expression over an alias',
      'MATCH (n:T) RETURN n.n AS x, n.k AS y ORDER BY x + 1, y',
      'MATCH (n:T) RETURN n.n AS x, n.k AS y ORDER BY n.n + 1, n.k',
    ],
    [
      'a CASE over the alias',
      'MATCH (n:T) RETURN n.n AS x ORDER BY CASE WHEN x > 25 THEN 0 ELSE 1 END, x',
      'MATCH (n:T) RETURN n.n AS x ORDER BY CASE WHEN n.n > 25 THEN 0 ELSE 1 END, n.n',
    ],
    [
      'an un-aliased item, whose column name is its own expression',
      'MATCH (n:T) RETURN n.n ORDER BY n.n + 1',
      'MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1',
    ],
  ];

  for (const [label, aliasForm, propForm] of pairs) {
    test(`${label}: same route, same rows`, () => {
      expect(routes(aliasForm)).toEqual(routes(propForm));
      expect(routes(aliasForm)).toContain('nodeProjection');
      // THE COLUMN BY POSITION, NOT BY NAME. The un-aliased pair spells its column `n.n` on one
      // side and `x` on the other, so reading `.x` compared `undefined` against a real value —
      // which would also have passed VACUOUSLY had both sides been un-aliased.
      const firstCol = (rs: readonly unknown[]) => rs.map((r) => Object.values(r as object)[0]);

      expect(firstCol(rows(aliasForm))).toEqual(firstCol(rows(propForm)));
      expect(firstCol(rows(aliasForm)).length).toBe(6);
    });
  }

  test('the HOP shape, where the absolute gap is largest', () => {
    const aliasForm = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY x + 1';
    const propForm = 'MATCH (a:T)-[:E]->(b:T) RETURN b.n AS x ORDER BY b.n + 1';

    expect(routes(aliasForm)).toContain('hopProjection');
    expect(routes(aliasForm)).toEqual(routes(propForm));
    expect(rows(aliasForm)).toEqual(rows(propForm));
  });

  test('the NULL key is placed identically by both spellings', () => {
    // The fixture's `z` has no `n`, so `x` and `x + 1` are both NULL for it. A rewrite that moved
    // NULLs would show here and nowhere else.
    const out = rows('MATCH (n:T) RETURN n.n AS x ORDER BY x + 1');

    expect(out).toEqual(rows('MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1'));
    expect((out[out.length - 1] as { x: unknown }).x).toBeNull();
  });
});

describe('what the pass must NOT rewrite', () => {
  test('a BARE alias key is left alone — rewriting it would leave the FASTER arm', () => {
    // `outputColumnSorts` wants a key that NAMES a column; turning `ORDER BY x` into
    // `ORDER BY n.n` would take the query off that arm, which is the opposite of the point.
    const bare = 'MATCH (n:T) RETURN n.n AS x ORDER BY x';

    expect(routes(bare)).toContain('nodeProjection');
    expect(rows(bare)).toEqual(rows('MATCH (n:T) RETURN n.n AS x ORDER BY n.n'));
  });

  test('a NON-CHEAP alias is not substituted, so its evaluation is not duplicated', () => {
    // Substituting duplicates the aliased expression's evaluation — once for the column, once for
    // the key. A property read is free and cannot fault; a subquery is neither.
    /*
     * THE FIRST VERSION OF THIS TEST WAS VACUOUS — `expect(rows(text)).toEqual(rows(text))` —
     * and the mutation battery said so: admitting a non-cheap alias SURVIVED. The guard's effect is
     * not on the rows (substituting is value-equal) but on the PLAN, so the plan is what to assert.
     *
     * And it is load-bearing rather than merely tidy: substituting a subquery into a sort key was
     * a live CROSS-ENGINE DIVERGENCE at item 213, and `deferredSortKeys` declines a subquery key for
     * that reason. So the substituted spelling must stay off that arm.
     */
    const subq =
      'MATCH (n:T) RETURN COUNT { MATCH (n)-[:E]->(z:T) } AS c, n.n AS y ORDER BY c + 1, y';
    // The same shape with a CHEAP alias in the same position, which the pass DOES rewrite — so this
    // pins that the refusal above is about the alias's expression and not about the shape.
    const cheap = 'MATCH (n:T) RETURN n.k AS c, n.n AS y ORDER BY c + 1, y';

    // The subquery alias `c` SURVIVES in the key (not substituted); the cheap alias is replaced by
    // the scan variable it names. The second term is a bare alias and is short-circuited in both,
    // which is why only the first term differs.
    expect(sortKeyKinds(subq)).toEqual(['c', 'y']);
    expect(sortKeyKinds(cheap)).toEqual(['n', 'y']);
    expect(rows(subq).length).toBe(6);
  });

  test('a COLLIDING output name declines the whole pass', () => {
    // In the sort scope the output columns are OVERLAID on the binding, so with `n.k AS n` the name
    // `n` in a substituted `n.n` would resolve to that COLUMN rather than the element and read a
    // property of the wrong value. The pass refuses rather than reproduce the overlay rule.
    const text = 'MATCH (n:T) RETURN n.n AS x, n.k AS n ORDER BY x + 1';
    const out = rows(text) as { x: unknown }[];

    expect(out.map((r) => r.x)).toEqual([10, 20, 30, 40, 50, null]);
  });

  test('a query with no ORDER BY is untouched', () => {
    expect(rows('MATCH (n:T) RETURN n.n AS x').length).toBe(6);
  });

  test('a sort key naming NO alias is untouched', () => {
    const text = 'MATCH (n:T) RETURN n.n AS x ORDER BY n.k';

    expect(routes(text)).toContain('nodeProjection');
    expect(rows(text).length).toBe(6);
  });
});
