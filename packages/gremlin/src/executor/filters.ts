import { isTemporal } from '@lenke/core';
import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { By, Plan, Predicate, Step } from '../ast.js';
import { matches } from '../predicates.js';
import { applyPlanToStream } from './dispatch.js';
import { byOr, evalBy, hasAny, recallTag, type RunContext, type Traverser } from './runtime.js';

// `fail` throws as soon as the first traverser arrives. Useful as an
// assertion: `traversal(V(), hasLabel('Person'), out('knows'), fail('expected no neighbors'))`.
// The message and `E_FAIL` code match the Rust engine byte-for-byte.
// eslint-disable-next-line require-yield -- throws before yielding; the generator shape is required by the step protocol
export const failStep = function* (
  stream: Iterable<Traverser<unknown>>,
  message: string | undefined,
): Iterable<Traverser<unknown>> {
  for (const _ of stream) {
    throw new LenkeError(message ?? 'fail() reached', { code: ErrorCode.Fail });
  }
};

// Sub-plan form: keep traversers whose sub-plan emits anything.
export const whereSubPlanStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (hasAny(applyPlanToStream(plan, [t], graph, ctx))) {
      yield t;
    }
  }
};

// Two-key form: compare the value tagged at `startKey` to the value tagged
// at `pred.value` (treated as another `as_` label name) via the predicate's
// op. `bys` apply round-robin: bys[0] to start, bys[1] to end (falling back
// to bys[0] if only one is given, then to identity).
export const whereCompareStep = function* (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'where'; startKey: string }>,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const { startKey, pred, bys } = step;
  // Range predicates (between/inside/outside) carry `min`/`max` instead of a
  // single `value`, so they can't reference an end tag. The cross-tag form
  // only makes sense for single-value comparison predicates.
  const valueBearing = pred as Predicate & { value: unknown };

  if (!('value' in valueBearing)) {
    throw new LenkeError(
      `where('${startKey}', ...): only single-value predicates are supported (eq, neq, gt, gte, lt, lte). Got op '${pred.op}'.`,
      { code: ErrorCode.Unsupported },
    );
  }

  const endKey = valueBearing.value as string;
  const startBy: By = bys?.[0] ?? { kind: 'identity' };
  const endBy: By = bys?.[1] ?? startBy;

  for (const t of stream) {
    const start = recallTag(t.tags, startKey, 'last');
    const end = recallTag(t.tags, endKey, 'last');

    if (!start.ok || !end.ok) {
      continue;
    }

    // Coerce a no-value by() to `undefined` (this where-comparison keeps its prior
    // behavior; only the keying steps opt into NO_VALUE filtering).
    const startValue = byOr(evalBy(startBy, start.value, graph, ctx));
    const endValue = byOr(evalBy(endBy, end.value, graph, ctx));
    // Substitute the resolved end-tag value in for the predicate's raw
    // label name. e.g. `gt('b')` becomes `gt(endValue)` at evaluation.
    const resolved = { ...pred, value: endValue } as Predicate;

    if (matches(resolved, startValue)) {
      yield t;
    }
  }
};

// Predicate-only `where(neq('me'))`: compare the CURRENT traverser value to the
// value tagged at `pred.value` (a step label), via the predicate's op. Mirrors
// `whereCompareStep` but with the current value as the start (no `startKey`).
export const whereCurrentStep = function* (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'where'; pred: Predicate }>,
): Iterable<Traverser<unknown>> {
  const { pred } = step;
  const valueBearing = pred as Predicate & { value: unknown };

  if (!('value' in valueBearing)) {
    throw new LenkeError(
      `where(predicate): only single-value predicates are supported (eq, neq, gt, gte, lt, lte). Got op '${pred.op}'.`,
      { code: ErrorCode.Unsupported },
    );
  }

  const endKey = valueBearing.value as string;
  /*
   * The OP IS FIXED FOR THE WHOLE STREAM, so the comparator is chosen once (item 1900). Before
   * this, every row rebuilt `{ ...pred, value: end.value }` and re-entered `matches`' switch — on
   * the Gremlin surface's largest shape, `V().as_(a).out(E).where(neq(a))` at 800,000 rows, that
   * was 22.8% of the profile's self time.
   *
   *     200,000 vertices / 1,000,000 edges, one shape per process, min of 3 alternated rounds:
   *       the per-row clone + dispatch   234.47 ms
   *       one clone, mutated per row     224.85      ⬅ the allocation alone, 1.04x
   *       the comparator chosen once     215.37      ⬅ 1.09x, control flat at 41-42
   *
   * ⚠️ SOUND ONLY FOR eq/neq, AND ONLY OFF THE TEMPORAL PATH. `matches`' eq/neq arm is `valueEq`,
   * which is `v === b` for every non-temporal operand — the same derivation `specializePredicate`
   * carries for the fixed-operand twin. The ORDERING ops are deliberately not specialized: their
   * `predCmp` filters a cross-type pair to false via NaN, which does not reduce to an operator, and
   * a mutant routing `gt` through this branch keeps every row that is merely DIFFERENT.
   *
   * ⚠️ THE `isTemporal` GUARD IS INSURANCE WHOSE BRANCH MAY BE UNREACHABLE, and that is a declared
   * expected survivor in `where-mutants-1900.mjs` rather than a silence. The tag and the current
   * value share one traverser lineage and no step between them mints a new temporal of equal value,
   * so an equal-but-not-identical pair probably cannot meet here — but that is an argument over
   * every value-rebinding step, not a proof from this branch's own conditions, and the downside of
   * being wrong is a silent wrong answer rather than one typeof per row.
   *
   * ⚠️ `whereCompareStep` BELOW STILL CLONES PER ROW, left alone deliberately: it is the arm that
   * must not move in the A/B above, and `neq-prof-1900.mjs`'s `wherecmp` prices it at 329 ms — the
   * larger shape, and the follow-up.
   */
  const eqish = pred.op === 'eq' || pred.op === 'neq';
  const want = pred.op === 'eq';
  const resolved = { ...pred } as Predicate & { value: unknown };

  for (const t of stream) {
    const end = recallTag(t.tags, endKey, 'last');

    if (!end.ok) {
      continue; // the referenced label isn't bound → drop, as whereCompareStep does
    }

    if (eqish && !isTemporal(end.value)) {
      if ((t.value === end.value) === want) {
        yield t;
      }

      continue;
    }

    resolved.value = end.value;

    if (matches(resolved, t.value)) {
      yield t;
    }
  }
};

export const hasRevisit = (path: readonly unknown[]): boolean => {
  const seen = new Set<unknown>();

  for (const x of path) {
    if (seen.has(x)) {
      return true;
    }

    seen.add(x);
  }

  return false;
};
