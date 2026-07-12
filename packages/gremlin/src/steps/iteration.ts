/* eslint-disable no-shadow -- parameter names match the gremlin builder API (e.g. `match` on branch.option) */
import { appendStep, buildPlan, type Plan, type StepFn, type SubPlan } from './framework.js';

// Run each sub-plan from the current traverser; merge outputs in order.
export const union = (...plans: SubPlan[]): StepFn =>
  appendStep({ kind: 'union', plans: plans.map(buildPlan) });

// First non-empty sub-plan wins per traverser.
export const coalesce = (...plans: SubPlan[]): StepFn =>
  appendStep({ kind: 'coalesce', plans: plans.map(buildPlan) });

// If/then[/else] over sub-plans.
export const choose = (test: SubPlan, thenPlan: SubPlan, elsePlan?: SubPlan): StepFn =>
  appendStep({
    kind: 'choose',
    test: buildPlan(test),
    thenPlan: buildPlan(thenPlan),
    elsePlan: elsePlan ? buildPlan(elsePlan) : undefined,
  });

// Run a sub-plan with a barrier: each traverser sees only itself.
export const local = (plan: SubPlan): StepFn =>
  appendStep({ kind: 'local', plan: buildPlan(plan) });

// Inside a `repeat`, the current iteration count (0-indexed).
export const loops = (): StepFn => appendStep({ kind: 'loops' });

// Declarative pattern match: keep traversers satisfying every sub-pattern,
// binding their `as(...)` tags into scope (see executor `matchStep`).
export const match = (...patterns: SubPlan[]): StepFn =>
  appendStep({ kind: 'match', patterns: patterns.map(buildPlan) });

// --- repeat (with builder) ---

// Iteration: `repeat(body)` followed by `.times(n)` / `.until(...)` / `.emit(...)` /
// `.emitBefore(...)` modifiers.
//
// `.emit(pred?)` is TinkerPop's `repeat(body).emit(pred?)` post-form: emits
// AFTER each body application. `.emitBefore(pred?)` is the pre-form (TP's
// `emit(pred?).repeat(body)`): emits BEFORE each body application, including
// the input traverser at level 0.
//
// `.until(pred)` is TinkerPop's `repeat(body).until(pred)` post-form: checks the
// condition AFTER the body (do-while — the body runs at least once).
// `.untilBefore(pred)` is the pre-form (TP's `until(pred).repeat(body)`): checks
// BEFORE the body (while-do — a satisfier never enters the body). Without
// `until()` and without `times()`, repeat is capped at 100 iterations.
type RepeatBuilder = StepFn & {
  times: (n: number) => RepeatBuilder;
  until: (pred: SubPlan) => RepeatBuilder;
  untilBefore: (pred: SubPlan) => RepeatBuilder;
  emit: (pred?: SubPlan) => RepeatBuilder;
  emitBefore: (pred?: SubPlan) => RepeatBuilder;
};

const makeRepeat = (config: {
  body: Plan;
  until?: Plan;
  untilBefore?: boolean;
  emit?: Plan;
  emitBefore?: boolean;
  times?: number;
}): RepeatBuilder => {
  const fn: StepFn = appendStep({ kind: 'repeat', ...config });

  return Object.assign(fn, {
    times: (n: number) => makeRepeat({ ...config, times: n }),
    until: (pred: SubPlan) => makeRepeat({ ...config, until: buildPlan(pred), untilBefore: false }),
    untilBefore: (pred: SubPlan) =>
      makeRepeat({ ...config, until: buildPlan(pred), untilBefore: true }),
    emit: (pred?: SubPlan) =>
      makeRepeat({ ...config, emit: pred ? buildPlan(pred) : { steps: [] }, emitBefore: false }),
    emitBefore: (pred?: SubPlan) =>
      makeRepeat({ ...config, emit: pred ? buildPlan(pred) : { steps: [] }, emitBefore: true }),
  });
};

export const repeat = (body: SubPlan): RepeatBuilder => makeRepeat({ body: buildPlan(body) });

// --- branch (with builder) ---

// `branch(test).option(value, plan).option(value, plan).none(plan)`.
type BranchBuilder = StepFn & {
  option: (match: unknown, plan: SubPlan) => BranchBuilder;
  none: (plan: SubPlan) => BranchBuilder;
};

const makeBranch = (config: {
  test: Plan;
  options: readonly { match: unknown; plan: Plan }[];
  default?: Plan;
}): BranchBuilder => {
  const fn: StepFn = appendStep({ kind: 'branch', ...config });

  return Object.assign(fn, {
    option: (match: unknown, plan: SubPlan) =>
      makeBranch({ ...config, options: [...config.options, { match, plan: buildPlan(plan) }] }),
    none: (plan: SubPlan) => makeBranch({ ...config, default: buildPlan(plan) }),
  });
};

export const branch = (test: SubPlan): BranchBuilder =>
  makeBranch({ test: buildPlan(test), options: [] });
