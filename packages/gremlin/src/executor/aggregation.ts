import type { Graph } from '@pl-graph/core';

import type { By } from '../ast.js';
import {
  evalBy,
  isSliceable,
  type RunContext,
  startTraverser,
  type Traverser,
} from './_internals.js';

export const aggregateNumber = function* (
  stream: Iterable<Traverser<unknown>>,
  kind: 'sum' | 'mean',
): Iterable<Traverser<unknown>> {
  let sum = 0;
  let count = 0;
  let sawNonNull = false;
  for (const t of stream) {
    if (t.value == null) {
      continue;
    }
    sawNonNull = true;
    sum += Number(t.value);
    count++;
  }
  if (!sawNonNull) {
    yield startTraverser(null);
    return;
  }
  yield startTraverser(kind === 'sum' ? sum : sum / count);
};

export const aggregateComparable = function* (
  stream: Iterable<Traverser<unknown>>,
  kind: 'min' | 'max',
): Iterable<Traverser<unknown>> {
  let best: unknown;
  let sawNonNull = false;
  for (const t of stream) {
    if (t.value == null) {
      continue;
    }
    if (!sawNonNull) {
      best = t.value;
      sawNonNull = true;
    } else if (
      kind === 'min'
        ? (t.value as number | string) < (best as number | string)
        : (t.value as number | string) > (best as number | string)
    ) {
      best = t.value;
    }
  }
  if (!sawNonNull) {
    yield startTraverser(null);
    return;
  }
  yield startTraverser(best);
};

export const countStep = function* (
  stream: Iterable<Traverser<unknown>>,
): Iterable<Traverser<unknown>> {
  let n = 0;
  for (const _ of stream) {
    n++;
  }
  yield startTraverser(n);
};

// ---------- Scope.local aggregations (per-traverser) ----------
//
// Each `*Local` helper computes the aggregate of a single traverser's
// iterable VALUE (post-`fold()` array, list-cardinality projection, etc.).
// For non-iterable values, the traverser is treated as a one-element
// sequence — `count` returns 1, `sum`/`min`/`max`/`mean` return the value
// itself when numeric. Empty iterables return `null` to mirror the
// global-scope behavior on empty streams.

const elementsOf = (v: unknown): unknown[] => (isSliceable(v) ? [...v] : [v]);

export const countLocal = (v: unknown): number => elementsOf(v).length;

export const sumLocal = (v: unknown): number | null => {
  const items = elementsOf(v).filter((x) => x != null);
  if (items.length === 0) {
    return null;
  }
  return items.reduce<number>((s, x) => s + Number(x), 0);
};

export const meanLocal = (v: unknown): number | null => {
  const items = elementsOf(v).filter((x) => x != null);
  if (items.length === 0) {
    return null;
  }
  return items.reduce<number>((s, x) => s + Number(x), 0) / items.length;
};

export const minLocal = (v: unknown): unknown =>
  reduceComparable(elementsOf(v), 'min');

export const maxLocal = (v: unknown): unknown =>
  reduceComparable(elementsOf(v), 'max');

const reduceComparable = (items: readonly unknown[], kind: 'min' | 'max'): unknown => {
  let best: unknown;
  let saw = false;
  for (const x of items) {
    if (x == null) {
      continue;
    }
    if (!saw) {
      best = x;
      saw = true;
      continue;
    }
    const lhs = x as number | string;
    const rhs = best as number | string;
    if (kind === 'min' ? lhs < rhs : lhs > rhs) {
      best = x;
    }
  }
  return saw ? best : null;
};

// `order` materializes the stream, sorts, then re-yields. Boundary step.
// `bys` is non-empty (caller normalizes legacy `key` into a one-element array).
// The first by is the primary sort key; subsequent bys are tie-breakers, in
// order. `desc` flips ALL keys uniformly — comparator-per-by would need
// closures and is deferred.
export const orderStep = function* (
  stream: Iterable<Traverser<unknown>>,
  bys: readonly By[],
  desc: boolean,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  const items = [...stream];
  const projected = items.map((t) => ({
    traverser: t,
    sortKeys: bys.map((by) => evalBy(by, t.value, graph, ctx)),
  }));
  // Per-by direction: prefer the By's `direction` field; fall back to the
  // step-level `desc` (legacy / `order({ desc: true })` form).
  const dirs = bys.map((by) => (by.direction ?? (desc ? 'desc' : 'asc')));
  projected.sort((a, b) => {
    for (let i = 0; i < bys.length; i++) {
      const sa = a.sortKeys[i] as number | string;
      const sb = b.sortKeys[i] as number | string;
      const flip = dirs[i] === 'desc' ? -1 : 1;
      if (sa < sb) {
        return -1 * flip;
      }
      if (sa > sb) {
        return 1 * flip;
      }
    }
    return 0;
  });
  for (const { traverser } of projected) {
    yield traverser;
  }
};
