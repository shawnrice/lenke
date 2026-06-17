import {
  appendStep,
  buildPlan,
  isPredicate,
  type Predicate,
  type StepFn,
  type SubPlan,
} from './framework.js';

// Logical combinators over sub-plans, each starting from the current traverser.
export const and = (...plans: SubPlan[]): StepFn =>
  appendStep({ kind: 'and', plans: plans.map(buildPlan) });

export const or = (...plans: SubPlan[]): StepFn =>
  appendStep({ kind: 'or', plans: plans.map(buildPlan) });

// `not` is polymorphic:
//   not(subPlan)   → a step that filters out traversers whose sub-plan emits
//   not(predicate) → a negated predicate, usable inside has/is/etc.
//
// Disambiguation by the same `op`-discriminant check used in `has`. SubPlans
// are either functions (`StepFn`) or plan objects (`{ steps }`); predicates
// are objects with an `op` field.
export function not(plan: SubPlan): StepFn;
export function not(predicate: Predicate): Predicate;
export function not(arg: SubPlan | Predicate): StepFn | Predicate {
  if (isPredicate(arg)) {
    return { op: 'not', predicate: arg };
  }

  return appendStep({ kind: 'not', plan: buildPlan(arg) });
}

// Run plan; if empty, yield the original traverser unchanged.
export const optional = (plan: SubPlan): StepFn =>
  appendStep({ kind: 'optional', plan: buildPlan(plan) });
