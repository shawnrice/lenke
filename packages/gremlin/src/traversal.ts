import { emptyPlan, type Plan } from './ast.js';

type StepFn = (plan: Plan) => Plan;

/**
 * Build a `Plan` from a sequence of step constructors.
 *
 * @example
 * ```ts
 * const plan = traversal(V(1), out('knows'), has('age', gt(30)), take(5));
 * ```
 *
 * Use this instead of (or alongside) `pipe` when you want a clearly-named
 * traversal entry point. Both produce the same `Plan` value.
 */
export const traversal = (...steps: StepFn[]): Plan =>
  steps.reduce<Plan>((p, step) => step(p), emptyPlan);
