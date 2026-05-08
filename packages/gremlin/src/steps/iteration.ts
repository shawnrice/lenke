/* eslint-disable no-shadow -- parameter names match the gremlin builder API (e.g. `match` on branch.option) */
import {
  appendStep,
  buildPlan,
  type Plan,
  type StepFn,
  type SubPlan,
} from './framework.js';

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

// Declarative pattern match. STUBBED — executor throws.
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
// LIMITATION vs TinkerPop: until() placement (BEFORE→do-while vs AFTER→while)
// is not yet distinguished. Our until() always behaves as BEFORE-placement
// (do-while: check before applying body each iteration). Without `until()`
// and without `times()`, repeat is capped at 100 iterations.
type RepeatBuilder = StepFn & {
  times: (n: number) => RepeatBuilder;
  until: (pred: SubPlan) => RepeatBuilder;
  emit: (pred?: SubPlan) => RepeatBuilder;
  emitBefore: (pred?: SubPlan) => RepeatBuilder;
};

export const repeat = (body: SubPlan): RepeatBuilder => {
  const make = (config: {
    body: Plan;
    until?: Plan;
    emit?: Plan;
    emitBefore?: boolean;
    times?: number;
  }): RepeatBuilder => {
    const fn: StepFn = appendStep({ kind: 'repeat', ...config });
    return Object.assign(fn, {
      times: (n: number) => make({ ...config, times: n }),
      until: (pred: SubPlan) => make({ ...config, until: buildPlan(pred) }),
      emit: (pred?: SubPlan) =>
        make({ ...config, emit: pred ? buildPlan(pred) : { steps: [] }, emitBefore: false }),
      emitBefore: (pred?: SubPlan) =>
        make({ ...config, emit: pred ? buildPlan(pred) : { steps: [] }, emitBefore: true }),
    });
  };

  return make({ body: buildPlan(body) });
};

// --- branch (with builder) ---

// `branch(test).option(value, plan).option(value, plan).none(plan)`.
type BranchBuilder = StepFn & {
  option: (match: unknown, plan: SubPlan) => BranchBuilder;
  none: (plan: SubPlan) => BranchBuilder;
};

export const branch = (test: SubPlan): BranchBuilder => {
  const make = (config: {
    test: Plan;
    options: readonly { match: unknown; plan: Plan }[];
    default?: Plan;
  }): BranchBuilder => {
    const fn: StepFn = appendStep({ kind: 'branch', ...config });
    return Object.assign(fn, {
      option: (match: unknown, plan: SubPlan) =>
        make({ ...config, options: [...config.options, { match, plan: buildPlan(plan) }] }),
      none: (plan: SubPlan) => make({ ...config, default: buildPlan(plan) }),
    });
  };
  return make({ test: buildPlan(test), options: [] });
};
