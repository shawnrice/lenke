import type { Graph } from '@pl-graph/core';

import type { By, Plan, Predicate, Step } from '../ast.js';
import { matches } from '../predicates.js';
import {
  evalBy,
  hasAny,
  recallTag,
  type RunContext,
  type Traverser,
} from './runtime.js';
import { applyPlanToStream } from './dispatch.js';

// `fail` throws as soon as the first traverser arrives. Useful as an
// assertion: `traversal(V(), hasLabel('Person'), out('knows'), fail('expected no neighbors'))`.
// eslint-disable-next-line require-yield -- throws before yielding; the generator shape is required by the step protocol
export const failStep = function* (
  stream: Iterable<Traverser<unknown>>,
  message: string | undefined,
): Iterable<Traverser<unknown>> {
  for (const _ of stream) {
    throw new Error(message ?? 'fail() reached');
  }
};

// Sub-plan form: keep traversers whose sub-plan emits anything.
export const whereSubPlanStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (hasAny(applyPlanToStream(plan, [t], graph))) {
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
    throw new Error(
      `where('${startKey}', ...): only single-value predicates are supported (eq, neq, gt, gte, lt, lte, within, without). Got op '${pred.op}'.`,
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
    const startValue = evalBy(startBy, start.value, graph, ctx);
    const endValue = evalBy(endBy, end.value, graph, ctx);
    // Substitute the resolved end-tag value in for the predicate's raw
    // label name. e.g. `gt('b')` becomes `gt(endValue)` at evaluation.
    const resolved = { ...pred, value: endValue } as Predicate;
    if (matches(resolved, startValue)) {
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
