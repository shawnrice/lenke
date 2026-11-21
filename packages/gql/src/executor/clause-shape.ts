/**
 * The clause-shape guards the detectors open with — the compile-time admission tests that every
 * fast path repeats before it looks at anything query-specific.
 *
 * ⚠️ COMPILE-TIME ONLY, AND THAT IS WHY THIS FILE EXISTS WHILE THE WALK BODIES STAY DUPLICATED.
 * `twoClauseReturn` runs once per `compileLinear`, so sharing it costs nothing measurable. The
 * duplicated HOT LOOPS in `hop-projection.ts` are a different question with a measured answer:
 * `ts-closure-size-is-load-bearing` found that a walk inlined into a returned closure gives
 * UNRELATED queries a new slow mode (4x), and items 1413/1415/1440/1442/1462 priced a new walk
 * variant at up to 16% on rows it does not touch. So a walk is copied here deliberately; a gate is
 * not.
 */

import type { Clause } from '../ast.js';
import type { CClause } from './core.js';

/**
 * `[anything, return]` with both clauses compiled — the exact prologue twelve detectors across five
 * files wrote out by hand (item 2391).
 *
 * ⚠️ THE FIRST CLAUSE'S KIND IS DELIBERATELY NOT CHECKED. Most callers go on to require
 * `match`, but not all do, and a helper that assumed it would silently stop those rungs firing —
 * which is the failure mode item 910 named when it made "a route assertion per detector" the
 * prerequisite for sharing any work between them. `routes-fired.test.ts` is that assertion, 66
 * rows of query-to-rung-fields, and it is what makes this extraction checkable rather than
 * hopeful. Each caller keeps its own `m.kind` / `m.optional` / `patterns.length` tests.
 *
 * 🔑 `compiled` is `clauses.map(compileClause)`, so its length is the same by construction and only
 * `clauses.length` is tested — the callers' own arity guard, unchanged.
 */
export type TwoClauseReturn = {
  readonly first: Clause;
  readonly ret: Extract<Clause, { kind: 'return' }>;
  readonly cfirst: CClause;
  readonly cret: Extract<CClause, { kind: 'return' }>;
};

export const twoClauseReturn = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): TwoClauseReturn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [first, ret] = clauses;
  const [cfirst, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  return { first, ret, cfirst, cret };
};
