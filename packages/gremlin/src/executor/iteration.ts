import type { Graph } from '@pl-graph/core';
import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import type { Plan, Step } from '../ast.js';
import { applyPlanToStream } from './dispatch.js';
import { hasAny, incLoops, isEmptyPlan, type RunContext, type Traverser } from './runtime.js';

/**
 * Per-`repeat()` cap on the total traversers its body produces. A
 * `repeat(both())` with no `until`/`times` on a cyclic or dense graph grows the
 * frontier multiplicatively each level (bounded only by the 100-iteration cap,
 * which bounds depth, not work), so it can exhaust memory long before it stops.
 * Past this budget we raise `ResourceExhausted` rather than hang/OOM.
 */
const REPEAT_BUDGET = 1_000_000;

export const unionStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plans: readonly Plan[],
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    for (const plan of plans) {
      yield* applyPlanToStream(plan, [t], graph);
    }
  }
};

export const coalesceStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plans: readonly Plan[],
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    for (const plan of plans) {
      const out = [...applyPlanToStream(plan, [t], graph)];

      if (out.length > 0) {
        yield* out;
        break;
      }
    }
  }
};

export const optionalStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const out = [...applyPlanToStream(plan, [t], graph)];

    if (out.length > 0) {
      yield* out;
    } else {
      yield t;
    }
  }
};

export const chooseStep = function* (
  stream: Iterable<Traverser<unknown>>,
  test: Plan,
  thenPlan: Plan,
  elsePlan: Plan | undefined,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const branch = hasAny(applyPlanToStream(test, [t], graph)) ? thenPlan : elsePlan;

    if (branch) {
      yield* applyPlanToStream(branch, [t], graph);
    } else {
      // Per TinkerPop spec: if test fails and no elsePlan, traverser passes
      // through unchanged (identity behavior).
      yield t;
    }
  }
};

// --- Repeat -------------------------------------------------------------

export const repeatStep = function* (
  stream: Iterable<Traverser<unknown>>,
  step: Extract<Step, { kind: 'repeat' }>,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  // Cap iterations to `times` if given; else 100 to avoid runaway.
  const maxIterations = step.times ?? 100;
  // `until(plan)` empty means "no until" — let `times` be the only stopper.
  // `emit(plan)` empty means "emit every traverser at every level".
  const hasUntil = step.until !== undefined && !isEmptyPlan(step.until);
  const hasEmit = step.emit !== undefined;
  const emitAll = hasEmit && step.emit !== undefined && isEmptyPlan(step.emit);
  const emitBefore = step.emitBefore === true;

  const matchesEmit = (t: Traverser<unknown>): boolean => {
    if (emitAll) {
      return true;
    }

    return hasAny(applyPlanToStream(step.emit!, [t], graph));
  };

  let frontier: Traverser<unknown>[] = [...stream].map(incLoops);
  let work = 0;

  for (let i = 0; i < maxIterations && frontier.length > 0; i++) {
    // Pre-form emit (TinkerPop's `emit(...).repeat(body)`): emit before each
    // body application, including the input traverser at level 0.
    if (hasEmit && emitBefore) {
      for (const t of frontier) {
        if (matchesEmit(t)) {
          yield t;
        }
      }
    }

    // Apply the body to advance the frontier.
    const next: Traverser<unknown>[] = [];
    const survivors: Traverser<unknown>[] = [];

    for (const t of frontier) {
      // until(plan) is checked BEFORE applying the body each iteration.
      if (hasUntil && hasAny(applyPlanToStream(step.until!, [t], graph))) {
        // This traverser is "done"; yield it and stop iterating it.
        yield t;
        continue;
      }

      survivors.push(t);
    }

    // Advance survivors through the body.
    for (const t of applyPlanToStream(step.body, survivors, graph)) {
      work += 1;

      if (work > REPEAT_BUDGET) {
        throw new PlGraphError(
          'repeat() exceeded the traversal budget; add a tighter until()/times()',
          { code: ErrorCode.ResourceExhausted },
        );
      }

      next.push(incLoops(t));
    }

    frontier = next;

    // Post-form emit (TinkerPop's default `repeat(body).emit(...)`): emit
    // after each body application. The final iteration's body output is
    // emitted here, so no additional post-loop yield is needed.
    if (hasEmit && !emitBefore) {
      for (const t of frontier) {
        if (matchesEmit(t)) {
          yield t;
        }
      }
    }
  }

  // Post-loop yield rules:
  //   - With `until()`: traversers exit via the until-yield above; nothing more.
  //   - With post-form emit: every body output was already emitted; nothing more.
  //   - With pre-form emit: pre-emit caught input + intermediates, but the
  //     final body output never had a "next iteration" to be pre-emitted, so
  //     yield it here.
  //   - With no emit: yield the final frontier (the natural repeat result).
  if (!hasUntil && (!hasEmit || emitBefore)) {
    yield* frontier;
  }
};

// `local` runs the sub-plan against each traverser independently, so steps
// like `count()` or `fold()` operate per-traverser instead of over the whole
// stream.
export const localStep = function* (
  stream: Iterable<Traverser<unknown>>,
  plan: Plan,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield* applyPlanToStream(plan, [t], graph, ctx);
  }
};

// `branch(test).option(v, plan)...none(plan)` — per traverser, run the test
// plan, take its first result, and route to the matching option's plan
// (deep-equality on `match`), else `default` if present.
export const branchStep = function* (
  stream: Iterable<Traverser<unknown>>,
  test: Plan,
  options: readonly { match: unknown; plan: Plan }[],
  defaultPlan: Plan | undefined,
  graph: Graph,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    let testResult: unknown = undefined;
    let sawResult = false;

    for (const r of applyPlanToStream(test, [t], graph)) {
      testResult = r.value;
      sawResult = true;
      break;
    }

    let matched: Plan | undefined;

    if (sawResult) {
      for (const opt of options) {
        if (Object.is(opt.match, testResult) || opt.match === testResult) {
          matched = opt.plan;
          break;
        }
      }
    }

    const target = matched ?? defaultPlan;

    if (target) {
      yield* applyPlanToStream(target, [t], graph);
    }
  }
};
