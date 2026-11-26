/**
 * The clause-shape guards the detectors open with — the compile-time admission tests that every
 * fast path repeats before it looks at anything query-specific.
 *
 * COMPILE-TIME ONLY, AND THAT IS WHY THIS FILE EXISTS WHILE THE WALK BODIES STAY DUPLICATED.
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
 * THE FIRST CLAUSE'S KIND IS DELIBERATELY NOT CHECKED. Most callers go on to require
 * `match`, but not all do, and a helper that assumed it would silently stop those rungs firing —
 * which is the failure mode item 910 named when it made "a route assertion per detector" the
 * prerequisite for sharing any work between them. `routes-fired.test.ts` is that assertion, 66
 * rows of query-to-rung-fields, and it is what makes this extraction checkable rather than
 * hopeful. Each caller keeps its own `m.kind` / `m.optional` / `patterns.length` tests.
 *
 * `compiled` is `clauses.map(compileClause)`, so its length is the same by construction and only
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

/**
 * `[non-optional single-pattern match, return]`, both compiled — the STRICTER shape three detectors
 * wrote out identically on top of the prologue above (`chain-projection`, `hop2-projection`,
 * `reachability`, item 2406).
 *
 * THE WIN HERE IS NOT LINES, it is one definition. Three sites at 17 lines become three at 7
 * plus this, which is roughly a wash — what it buys is that "non-optional, exactly one pattern" has
 * a single spelling, so a change to the admitted shape cannot land in two of the three. That is the
 * drift `twoClauseReturn` above exists to prevent, and the reason this is a SECOND helper rather
 * than a widening of that one: its twelve callers deliberately disagree about the first clause's
 * kind, and folding this requirement into it would silently stop the ones that do not want it.
 *
 * Checkable rather than hopeful for the same reason as above: these three rungs are
 * answer-equivalent, so a detector that stops firing returns identical rows by the general path.
 * `routes-fired.test.ts` is what sees it.
 */
export type OnePatternMatchReturn = {
  readonly m: Extract<Clause, { kind: 'match' }>;
  readonly ret: Extract<Clause, { kind: 'return' }>;
  readonly cm: Extract<CClause, { kind: 'match' }>;
  readonly cret: Extract<CClause, { kind: 'return' }>;
};

export const onePatternMatchReturn = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): OnePatternMatchReturn | null => {
  // SELF-CONTAINED RATHER THAN BUILT ON `twoClauseReturn`, and the six duplicated lines below are
  // the deliberate price. Delegating would allocate TWO records per gate — that helper's, then this
  // one's — where the inline code it replaces allocated none. One record per gate is the cost item
  // 2391 measured as free across its twelve sites; two is a cost nobody has priced, and this
  // harness cannot price it: a compile is ~0.4 us and the probe's own control moved 2.5x between
  // rounds, so a few nanoseconds is far under the noise. Matching the blessed shape exactly settles
  // the question by construction instead of by a measurement that cannot resolve it.
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [cm, cret] = compiled;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.patterns.length !== 1 ||
    ret.kind !== 'return' ||
    cm.kind !== 'match' ||
    cret.kind !== 'return'
  ) {
    return null;
  }

  return { m, ret, cm, cret };
};
