import { describe, expect, it } from 'bun:test';

import { DEFAULT_CONFIG, Graph } from '@lenke/core';

import type { Expr } from './ast.ts';
import { isConstExpr, isKnownScalarFn } from './executor/expr-analysis.ts';
import { callScalar } from './executor/scalars.ts';
import {
  BINARY_NUM,
  BINARY_STR_FN,
  DATE_PART_FNS,
  NONFINITE_CLASSIFIER,
  NUM_CONSTANTS,
  POLY_STR_LIST_FN,
  STR_NUM_FN,
  TEMPORAL_CTOR,
  TRIM_FNS,
  UNARY_NUM,
  UNARY_STR,
} from './executor/scalars.ts';
import { query } from './index.ts';

/**
 * Item 2463: `isKnownScalarFn` and `isConstExpr`, from item 2460's coverage map.
 *
 * `isKnownScalarFn` IS NOT A PERF GATE — it is the only one taken from that map so far whose wrong
 * answer is USER-VISIBLE in both directions. It backs eager compile-time rejection of unknown
 * function names, so a false negative REJECTS A VALID QUERY and a false positive lets a typo reach
 * runtime. That makes it worth more than a route detector, not less.
 *
 * Its mechanism is a try/catch, and the subtlety is which errors mean "known":
 *
 *     callScalar(name, FN_PROBE_ARGS, limits)   // FN_PROBE_ARGS is []
 *     -> returns            => known
 *     -> throws UnknownFunction => NOT known
 *     -> throws anything else   => known
 *
 * Probing with ZERO arguments means almost every real function throws an arity or type error, and
 * that counts as recognition. So the property worth asserting is not a handful of examples but
 * TOTALITY: every name the engine dispatches must be recognized, or the compiler rejects a query
 * the executor can actually answer.
 */

const NAME_TABLES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  BINARY_NUM,
  BINARY_STR_FN,
  NONFINITE_CLASSIFIER,
  NUM_CONSTANTS,
  POLY_STR_LIST_FN,
  STR_NUM_FN,
  UNARY_NUM,
  UNARY_STR,
  TEMPORAL_CTOR,
};
const NAME_SETS: Readonly<Record<string, ReadonlySet<string>>> = { DATE_PART_FNS, TRIM_FNS };

const dispatchNames = (): Map<string, string> => {
  const out = new Map<string, string>();

  for (const [table, rec] of Object.entries(NAME_TABLES)) {
    for (const name of Object.keys(rec)) {
      out.set(name, table);
    }
  }

  for (const [table, set] of Object.entries(NAME_SETS)) {
    for (const name of set) {
      out.set(name, table);
    }
  }

  return out;
};

// `ARITH` and `BOOL3` are deliberately absent: they are keyed by OPERATOR (`and`/`or`/`xor`, the
// arithmetic ops), not by a callable function name, so they are not part of this dispatch question.

describe('isKnownScalarFn', () => {
  it('collects a non-trivial number of dispatch names — guards against a VACUOUS pass', () => {
    /*
     * Without this, renaming or restructuring a table would make `Object.keys` yield nothing and
     * the totality test below would pass by examining zero names. Item 2453 shipped exactly that
     * failure in a spelling group: both arms answered `[]` and the group still flagged, because an
     * arm-against-arm check cannot tell that both are empty.
     */
    const names = dispatchNames();

    expect(names.size).toBeGreaterThanOrEqual(60);
    expect(names.has('trim')).toBe(true);
    expect(names.has('date')).toBe(true);
  });

  it('recognizes EVERY name the engine dispatches', () => {
    // Self-maintaining: add a function to any table above and it must be recognized here, or the
    // compiler will eagerly reject a query the executor can answer.
    const unrecognized = [...dispatchNames()]
      .filter(([name]) => !isKnownScalarFn(name))
      .map(([name, table]) => `${name} (${table})`);

    expect(unrecognized).toStrictEqual([]);
  });

  it('rejects names no table holds', () => {
    for (const bogus of ['definitely_not_a_function', 'zzz', '', 'SELECT', 'trimm', '_yearly']) {
      expect(isKnownScalarFn(bogus)).toBe(false);
    }
  });

  /*
   * THE CATCH'S "ANY OTHER THROW MEANS KNOWN" BRANCH IS UNREACHABLE FOR EVERY DISPATCH NAME, and
   * that is measured, not assumed. Called with `FN_PROBE_ARGS` (which is `[]`), all 63 names above
   * RETURN rather than throw — `callScalar` answers a zero-arg probe instead of raising an arity
   * error. So the success path is what recognizes them, and no input in the dispatch set reaches
   * the error classification.
   *
   * Two mutants therefore survive this file by construction (item 2463): replacing the catch's
   * return with `false`, and dropping its `ErrorCode.UnknownFunction` check. Both are defensive
   * against a `callScalar` behaviour it does not currently have — the function's own doc describes
   * the branch as covering a real per-row error such as bad arity — so they are kept and labelled
   * rather than "fixed" by a fixture that does not exist.
   */
  it('recognizes names through the SUCCESS path, not through an error', () => {
    // A zero-argument probe of a real scalar returns, so recognition does not depend on the catch.
    expect(() => callScalar('trim', [], DEFAULT_CONFIG.limits)).not.toThrow();
    expect(isKnownScalarFn('trim')).toBe(true);
  });

  it('is FALSE for aggregates, because they are not scalars', () => {
    // `callScalar('count', …)` raises `E_UNKNOWN_FUNCTION`, so this gate rejects every aggregate.
    // That is correct and not a defect: the call site in `core.ts` is reached only for a scalar
    // position, and `compile-state.ts` collects unknown names that resolved to NEITHER a scalar nor
    // an aggregate. The end-to-end assertion below is what makes that safe to rely on.
    for (const agg of ['count', 'sum', 'avg', 'min', 'max', 'collect', 'stddev_pop']) {
      expect(isKnownScalarFn(agg)).toBe(false);
    }
  });

  it('END TO END: an aggregate still answers, an unknown scalar is rejected', () => {
    /*
     * The gate alone cannot establish that rejecting aggregates is harmless, so this asserts the
     * consequence directly. Without it, "isKnownScalarFn('count') is false" reads like a bug.
     */
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

    expect(query(g, 'MATCH (p:P) RETURN count(*) AS c')).toStrictEqual([{ c: 2 }]);
    expect(query(g, 'MATCH (p:P) RETURN sum(p.k) AS s')).toStrictEqual([{ s: 3 }]);
    expect(() => query(g, 'MATCH (p:P) RETURN nosuchfn(p.k) AS x')).toThrow();
  });

  it('is case-sensitive, so an upper-case spelling is not recognized', () => {
    // Pinned because it is the kind of thing a normalization change would alter silently; GQL
    // function names reach here already lowered by the parser.
    expect(isKnownScalarFn('trim')).toBe(true);
    expect(isKnownScalarFn('TRIM')).toBe(false);
  });
});

describe('isConstExpr', () => {
  const expr = (kind: string): Expr => ({ kind }) as Expr;

  it('is true for a literal and for a param, and false for everything else', () => {
    const kinds = ['lit', 'param', 'var', 'prop', 'func', 'list', 'binop', 'case', 'map'];
    const got = kinds.map((k) => `${k}=${isConstExpr(expr(k))}`);

    expect(got).toStrictEqual([
      'lit=true',
      'param=true',
      'var=false',
      'prop=false',
      'func=false',
      'list=false',
      'binop=false',
      'case=false',
      'map=false',
    ]);
  });

  it('does not look INSIDE a composite whose parts are constant', () => {
    // A list of literals is not a const expr by this gate — `closedListValues` is the function that
    // answers that question, and conflating the two would widen index seeding.
    expect(isConstExpr({ kind: 'list', items: [expr('lit'), expr('lit')] })).toBe(false);
  });
});
