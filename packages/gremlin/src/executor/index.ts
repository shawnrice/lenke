// Public API of the gremlin executor.
//
// `run(plan, graph)` is the primary entry point — runs a plan and yields the
// final traverser values. `toArray` and `toSet` are eager terminals.
//
// Implementation lives in sibling files: `_internals.ts` for shared types
// and helpers, `dispatch.ts` for the kind-routing switch + recursive
// `applyPlanToStream`, and per-category files (`movement.ts`, `filters.ts`,
// `aggregation.ts`, etc.) for the step-impl generators.

import type { Graph } from '@pl-graph/core';

import type { Plan } from '../ast.js';
import { newContext, type Traverser, unwrap } from './_internals.js';
import { applyStep } from './dispatch.js';
import { applySource } from './sources.js';

/**
 * Run a plan against a graph. Always returns an `Iterable<unknown>` —
 * terminal steps (`count`, `fold`, `toList`) yield exactly one value; other
 * steps yield zero or more. This matches Gremlin's "every step is a stream"
 * model and keeps `pipe(count(), is(gt(5)))` composable.
 */
export const run = (plan: Plan, graph: Graph): Iterable<unknown> => {
  const ctx = newContext();
  let stream: Iterable<Traverser<unknown>> | null = null;

  for (const step of plan.steps) {
    if (stream === null) {
      stream = applySource(step, graph);
      continue;
    }
    stream = applyStep(step, stream, graph, ctx);
  }

  return unwrap(stream ?? []);
};

/**
 * Eager terminal: run the plan and collect every emitted value into an array.
 *
 * Equivalent to `[...run(plan, graph)]`. Provided for parity with legacy and
 * because the intent ("I want the answer as an array, not a lazy iterable")
 * is common enough to deserve a name.
 */
export const toArray = (plan: Plan, graph: Graph): unknown[] => [...run(plan, graph)];

/**
 * Eager terminal: run the plan and collect emitted values into a Set, dropping
 * duplicates by JS reference/primitive equality.
 *
 * Equivalent to `new Set(run(plan, graph))`. For value-based de-duplication
 * over vertices/edges/objects, prefer the `dedupe()` step inside the plan —
 * a `Set` only de-dupes by `===`, so two distinct vertex objects with the same
 * `id` would both be retained.
 */
export const toSet = (plan: Plan, graph: Graph): Set<unknown> => new Set(run(plan, graph));
