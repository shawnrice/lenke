// Shared scaffolding for the executor. Per-category step-impl files import
// from here for the runtime types (`Traverser`, `RunContext`), traverser
// primitives, type guards, modulator evaluation, and the small set of
// generators (`mapTraverser`/`filterStream`/etc.) that show up in many
// places.
//
// What's NOT here: per-step implementations (those live in their category
// file), and the dispatcher (`applyStep` + `applyPlanToStream`, in
// `./dispatch.ts`). Those depend on each other recursively, so they stay
// adjacent.

import type { Edge, Graph, Vertex } from '@pl-graph/core';

import type { By, Plan } from '../ast.js';
// Cycle: `runtime.ts` ↔ `dispatch.ts`. ESM handles this safely because
// neither module dereferences the other at init time — `applyPlanToStream`
// is only called from inside `evalBy`, by which time both modules' exports
// are bound. Same shape as `applyStep`/`applyPlanToStream` mutual-recursion.
import { applyPlanToStream } from './dispatch.js';

// ---------- Traverser ----------

/**
 * Runtime traverser. Carries the current value and the path of values seen
 * to reach it. Path is immutable — branching produces fresh paths via
 * structural sharing.
 */
export type Traverser<T> = {
  readonly value: T;
  readonly path: readonly unknown[];
  /** Number of repeat-body iterations entered so far. 0 outside any repeat. */
  readonly loopCount: number;
  /**
   * Labeled positions tagged via `as(label)`, recalled by `select(label)`.
   * A label can accumulate multiple values inside iterative steps (e.g.
   * `repeat(out().as('a'))`); `select(Pop.first|last|all, 'a')` picks how
   * to read. The default `select('a')` returns the last tagged value.
   */
  readonly tags: ReadonlyMap<string, readonly unknown[]>;
};

export const emptyTags: ReadonlyMap<string, readonly unknown[]> = new Map();

export const isEmptyPlan = (plan: Plan): boolean => plan.steps.length === 0;

export const startTraverser = <T>(value: T): Traverser<T> => ({
  value,
  path: [value],
  loopCount: 0,
  tags: emptyTags,
});

export const extend = <T>(prev: Traverser<unknown>, value: T): Traverser<T> => ({
  value,
  path: [...prev.path, value],
  loopCount: prev.loopCount,
  tags: prev.tags,
});

export const incLoops = <T>(t: Traverser<T>): Traverser<T> => ({
  ...t,
  loopCount: t.loopCount + 1,
});

// ---------- Type guards ----------

export const isVertex = (x: unknown): x is Vertex =>
  typeof x === 'object' && x !== null && 'id' in x && !('from' in x);

export const isEdge = (x: unknown): x is Edge =>
  typeof x === 'object' && x !== null && 'from' in x && 'to' in x;

export const firstLabel = (s: ReadonlySet<string>): string | undefined => {
  for (const l of s) {
    return l;
  }
  return undefined;
};

// ---------- Run context ----------

/**
 * Per-run context — currently just the side-effects bag for
 * `aggregate(key)` / `cap(key)`. Passed by reference so all steps in a
 * single `run()` share the same bag.
 */
export type RunContext = {
  readonly sideEffects: Map<string, unknown[]>;
};

export const newContext = (): RunContext => ({ sideEffects: new Map() });

/**
 * Project a runtime `Traverser` plus the run's side-effects into the
 * read-only view that user closures see. Built lazily per-call (rather than
 * stored on every traverser) because side-effects are per-run, not per-
 * traverser; threading the same Map reference avoids per-traverser overhead.
 */
export const closureView = (
  t: Traverser<unknown>,
  ctx: RunContext,
): {
  value: unknown;
  path: readonly unknown[];
  loopCount: number;
  tags: ReadonlyMap<string, readonly unknown[]>;
  sideEffects: ReadonlyMap<string, readonly unknown[]>;
} => ({
  value: t.value,
  path: t.path,
  loopCount: t.loopCount,
  tags: t.tags,
  sideEffects: ctx.sideEffects,
});

// ---------- Stream-of-traversers helpers (used by many steps) ----------

export const unwrap = function* (
  stream: Iterable<Traverser<unknown>>,
): Iterable<unknown> {
  for (const t of stream) {
    yield t.value;
  }
};

export const hasAny = (stream: Iterable<Traverser<unknown>>): boolean => {
  for (const _ of stream) {
    return true;
  }
  return false;
};

export const mapTraverser = function* (
  stream: Iterable<Traverser<unknown>>,
  fn: (v: unknown, t: Traverser<unknown>) => unknown,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield extend(t, fn(t.value, t));
  }
};

export const filterStream = function* (
  stream: Iterable<Traverser<unknown>>,
  predicate: (v: unknown) => boolean,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (predicate(t.value)) {
      yield t;
    }
  }
};

export const filterTraverser = function* (
  stream: Iterable<Traverser<unknown>>,
  predicate: (t: Traverser<unknown>) => boolean,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (predicate(t)) {
      yield t;
    }
  }
};

// ---------- Local-scope iteration (Scope.local consumers) ----------

/**
 * True for non-string objects that expose `Symbol.iterator`. Used by every
 * `Scope.local` consumer (slice family + aggregation family) to decide
 * whether to operate on a traverser's value as a sequence or pass it through
 * unchanged. Strings are deliberately excluded — TinkerPop's `Scope.local`
 * doesn't treat a string as a sequence of characters.
 */
export const isSliceable = (v: unknown): v is Iterable<unknown> => {
  if (v === null || v === undefined || typeof v === 'string') {
    return false;
  }
  return typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
};

// ---------- Tag recall (select / where-compare / addE) ----------

export type Pop = 'first' | 'last' | 'all';

export const recallTag = (
  tags: ReadonlyMap<string, readonly unknown[]>,
  label: string,
  pop: Pop,
): { ok: true; value: unknown } | { ok: false } => {
  const list = tags.get(label);
  if (!list || list.length === 0) {
    return { ok: false };
  }
  if (pop === 'first') {
    return { ok: true, value: list[0] };
  }
  if (pop === 'last') {
    return { ok: true, value: list[list.length - 1] };
  }
  return { ok: true, value: [...list] };
};

// ---------- Tuple key (dedupe / group across multiple labels) ----------

// Build a stable string key from a tuple of values. Vertices/edges are keyed
// by `id` (graph-unique); other values fall through to JSON. NUL separates
// fields so distinct tuples can't collide via concatenation.
export const tupleKey = (parts: readonly unknown[]): string =>
  parts
    .map((p) => {
      if (isVertex(p) || isEdge(p)) {
        return `@${p.id}`;
      }
      return JSON.stringify(p) ?? 'undefined';
    })
    .join('\x00');

// ---------- by() modulator evaluation ----------

// `by` legacy fallback: if a step has no `bys`, reconstruct one from a legacy
// property-name field (e.g. `order.key`, `group.keyBy`).
export const keyToBy = (key: string | undefined): By =>
  key === undefined ? { kind: 'identity' } : { kind: 'key', key };

// Normalize legacy `key` field into a one-element `bys` array if `bys` is unset.
export const normalizeBys = (
  bys: readonly By[] | undefined,
  legacyKey: string | undefined,
): readonly By[] => {
  if (bys && bys.length > 0) {
    return bys;
  }
  if (legacyKey !== undefined) {
    return [{ kind: 'key', key: legacyKey }];
  }
  return [{ kind: 'identity' }];
};

// `T.id` / `T.label` / `T.key` / `T.value` projection.
export const projectToken = (
  token: 'id' | 'label' | 'key' | 'value',
  value: unknown,
): unknown => {
  if (token === 'id') {
    return isVertex(value) || isEdge(value) ? value.id : undefined;
  }
  if (token === 'label') {
    return isVertex(value) || isEdge(value) ? (firstLabel(value.labels) ?? null) : undefined;
  }
  // `T.key` / `T.value` apply to property objects of shape `{ key, value }`
  // (as produced by `properties()`). For anything else, undefined.
  if (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    'value' in value
  ) {
    return (value as { key: unknown; value: unknown })[token];
  }
  return undefined;
};

// Evaluate a `By` modulator against a single value. The traversal form runs
// the sub-plan with `value` as the starting traverser and projects to its
// first emitted result (or `undefined` if empty).
export const evalBy = (by: By, value: unknown, graph: Graph, ctx: RunContext): unknown => {
  switch (by.kind) {
    case 'identity':
      return value;
    case 'key':
      if (isVertex(value) || isEdge(value)) {
        return value.properties[by.key];
      }
      return value;
    case 'traversal': {
      const out = applyPlanToStream(by.plan, [startTraverser(value)], graph, ctx);
      for (const t of out) {
        return t.value;
      }
      return undefined;
    }
    case 'token':
      return projectToken(by.token, value);
  }
};
