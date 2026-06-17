// match() — declarative pattern matching across `as`-bound labels.
//
// Each pattern is a traversal `as(start) … [as(end)]`. match() treats it as a
// constraint: from the value bound to `start`, run the inner traversal; the
// result must equal the value bound to `end` (if `end` is already bound) or
// *bind* `end` to it (if not). A pattern with no trailing `as` is a pure filter
// on `start`; a pattern wrapped in `not(...)` (or `where(...)`) is a filter that
// must (not) hold. match() emits one traverser per consistent assignment of
// values to labels, carrying the bindings as tags so `select(...)` reads them.
//
// The solver is a depth-first join: seed the "source" label from the incoming
// traverser, then repeatedly run any pattern whose start label is already
// bound (preferring binding patterns over filters), branching the stream per
// candidate, until every pattern has been applied.

import type { Graph } from '@pl-graph/core';
import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import type { Plan, Step } from '../ast.js';

import { applyPlanToStream } from './dispatch.js';
import {
  extend,
  hasAny,
  isEdge,
  isVertex,
  recallTag,
  type RunContext,
  type Traverser,
  tupleKey,
} from './runtime.js';

/** A match pattern lowered to its solver shape. */
type Pattern = {
  /** Label whose bound value seeds the inner traversal. */
  readonly startKey: string;
  /** Label the inner traversal's output binds/filters; absent ⇒ pure filter. */
  readonly endKey?: string;
  /** Steps between the leading `as(start)` and trailing `as(end)`. */
  readonly inner: Plan;
  /** `not(...)`-wrapped: the constraint must NOT hold. */
  readonly negated: boolean;
};

/** Identity for graph elements (by id), strict equality otherwise. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if ((isVertex(a) || isEdge(a)) && (isVertex(b) || isEdge(b))) {
    return a.id === b.id;
  }
  return a === b;
};

/** Lower one pattern plan into a {@link Pattern}. */
const parsePattern = (plan: Plan): Pattern => {
  const { steps } = plan;
  const first = steps[0];

  // `not(inner)` / `where(inner)` filter wrappers: parse the inner pattern and
  // flip negation (where keeps it positive). These don't bind new labels.
  if (
    steps.length === 1 &&
    first &&
    (first.kind === 'not' || (first.kind === 'where' && 'plan' in first))
  ) {
    const inner = parsePattern((first as Extract<Step, { kind: 'not' }>).plan);
    return { ...inner, negated: first.kind === 'not' ? !inner.negated : inner.negated };
  }

  if (!first || first.kind !== 'as') {
    throw new PlGraphError('a match() pattern must begin with as(label)', {
      code: ErrorCode.Syntax,
    });
  }
  const startKey = first.label;
  const last = steps[steps.length - 1]!;
  if (steps.length >= 2 && last.kind === 'as') {
    return { startKey, endKey: last.label, inner: { steps: steps.slice(1, -1) }, negated: false };
  }
  return { startKey, inner: { steps: steps.slice(1) }, negated: false };
};

/**
 * The label that seeds the join: a pattern *start* that is never a binding
 * *end* (a source). The incoming traverser's value binds here. Falls back to the
 * first pattern's start when every start is also an end (a fully-cyclic match).
 */
const computeStartLabel = (patterns: readonly Pattern[]): string => {
  const ends = new Set<string>();
  for (const p of patterns) {
    if (!p.negated && p.endKey !== undefined) {
      ends.add(p.endKey);
    }
  }
  for (const p of patterns) {
    if (!ends.has(p.startKey)) {
      return p.startKey;
    }
  }
  return patterns[0]!.startKey;
};

/** A traverser identical to `t` but with `value` reset to a label's bound value. */
const fromBinding = (t: Traverser<unknown>, value: unknown): Traverser<unknown> => ({
  value,
  path: t.path,
  loopCount: t.loopCount,
  tags: t.tags,
});

/** `t` with `key` bound to `value` (single-valued; match binds each label once). */
const bind = (t: Traverser<unknown>, key: string, value: unknown): Traverser<unknown> => {
  const tags = new Map<string, readonly unknown[]>(t.tags);
  tags.set(key, [value]);
  return { ...t, tags };
};

/**
 * Apply one pattern to a traverser, returning the consistent continuations
 * (zero or more). A binding pattern branches per distinct candidate; a filter
 * or already-bound end keeps `t` once iff the constraint holds; a negated
 * pattern keeps `t` iff the constraint does NOT hold.
 */
const applyPattern = (
  p: Pattern,
  t: Traverser<unknown>,
  graph: Graph,
  ctx: RunContext,
): Traverser<unknown>[] => {
  const start = recallTag(t.tags, p.startKey, 'last');
  if (!start.ok) {
    return [];
  }
  const out = applyPlanToStream(p.inner, [fromBinding(t, start.value)], graph, ctx);

  const boundEnd = p.endKey !== undefined ? recallTag(t.tags, p.endKey, 'last') : undefined;

  if (p.negated) {
    // The inner constraint is satisfiable when some output matches the bound
    // end (or, if the end is unbound/absent, when any output exists at all).
    let satisfiable = false;
    for (const o of out) {
      if (boundEnd?.ok ? sameValue(o.value, boundEnd.value) : true) {
        satisfiable = true;
        break;
      }
    }
    return satisfiable ? [] : [t];
  }

  if (p.endKey === undefined) {
    return hasAny(out) ? [t] : []; // pure filter on start
  }
  if (boundEnd?.ok) {
    for (const o of out) {
      if (sameValue(o.value, boundEnd.value)) {
        return [t]; // end already bound and consistent
      }
    }
    return [];
  }
  // Bind the end label, one branch per distinct candidate value.
  const seen = new Set<string>();
  const branches: Traverser<unknown>[] = [];
  for (const o of out) {
    const k = tupleKey([o.value]);
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    branches.push(bind(t, p.endKey, o.value));
  }
  return branches;
};

/** Pick a not-yet-applied pattern whose start is bound, preferring binders. */
const pickRunnable = (
  patterns: readonly Pattern[],
  done: ReadonlySet<number>,
  t: Traverser<unknown>,
): number => {
  let negatedIdx = -1;
  for (let i = 0; i < patterns.length; i++) {
    if (done.has(i) || !t.tags.has(patterns[i]!.startKey)) {
      continue;
    }
    if (!patterns[i]!.negated) {
      return i; // run binders/filters before negated constraints
    }
    if (negatedIdx === -1) {
      negatedIdx = i;
    }
  }
  return negatedIdx;
};

export const matchStep = function* (
  stream: Iterable<Traverser<unknown>>,
  patternPlans: readonly Plan[],
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const patterns = patternPlans.map(parsePattern);
  const startLabel = computeStartLabel(patterns);

  const solve = function* (
    t: Traverser<unknown>,
    done: ReadonlySet<number>,
  ): Iterable<Traverser<unknown>> {
    if (done.size === patterns.length) {
      // Emit the binding map as the value (TinkerPop-faithful); tags carry the
      // bindings for any following select(...).
      const bindings = new Map<string, unknown>();
      for (const [label, values] of t.tags) {
        bindings.set(label, values[values.length - 1]);
      }
      yield extend(t, bindings);
      return;
    }
    const idx = pickRunnable(patterns, done, t);
    if (idx === -1) {
      return; // no runnable pattern: this branch is stuck, drop it
    }
    const next = new Set(done).add(idx);
    for (const t2 of applyPattern(patterns[idx]!, t, graph, ctx)) {
      yield* solve(t2, next);
    }
  };

  for (const t of stream) {
    // Seed the source label from the incoming value (unless already bound).
    const seed = t.tags.has(startLabel) ? t : bind(t, startLabel, t.value);
    yield* solve(seed, new Set());
  }
};
