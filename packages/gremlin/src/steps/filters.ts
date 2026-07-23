import { eq } from '../predicates.js';
import {
  appendStep,
  buildPlan,
  type ByableStep,
  type FilterClosure,
  type ID,
  isPredicate,
  isSubPlan,
  makeByable,
  type Predicate,
  type Step,
  type StepFn,
  type SubPlan,
} from './framework.js';

// `has` accepts four shapes (TinkerPop parity):
//   has(key, predicate)        — filter by predicate against property value
//   has(key, value)            — shorthand for has(key, eq(value))
//   has(label, key, predicate) — shorthand for hasLabel(label).has(key, pred)
//   has(label, key, value)     — shorthand for hasLabel(label).has(key, eq(value))
//
// Predicates are objects with an `op` discriminant; raw values are anything
// else. The runtime detection is preferred over compile-time overloads
// because TypeScript's `Predicate` union is structural and any plain object
// could in principle be a predicate; we'd rather have the dispatch live in
// one place than scattered through caller-side casts.
export function has(key: string, valueOrPred?: unknown): StepFn;
export function has(label: string, key: string, valueOrPred: unknown): StepFn;
export function has(a: string, b?: unknown, c?: unknown): StepFn {
  // Key-only `has(key)`: keep elements that have the property key (any value) —
  // equivalent to `hasKey(key)`.
  if (b === undefined && c === undefined) {
    return appendStep({ kind: 'hasKey', keys: [a] });
  }

  if (c === undefined) {
    // Route a bare value through `eq()` rather than building the predicate
    // inline, so a tagged temporal literal is lifted to an instance exactly as
    // it would be in `has(key, eq(v))`. Inline construction skipped that and
    // `has('vf', D('2020-01-01'))` silently matched nothing.
    const pred = isPredicate(b) ? b : eq(b);

    return appendStep({ kind: 'has', key: a, pred });
  }

  const pred = isPredicate(c) ? c : eq(c);

  return appendStep({ kind: 'hasLabelAnd', label: a, key: b as string, pred });
}

export const hasLabel = (...labels: string[]): StepFn => appendStep({ kind: 'hasLabel', labels });

export const hasId = (...ids: ID[]): StepFn => appendStep({ kind: 'hasId', ids });

export const hasKey = (...keys: string[]): StepFn => appendStep({ kind: 'hasKey', keys });

// Inverse of `has`: filter elements that DON'T have any of the given keys.
export const hasNot = (...keys: string[]): StepFn => appendStep({ kind: 'hasNot', keys });

// Filter property objects (`{key, value}`) by value field.
export const hasValue = (...values: unknown[]): StepFn => appendStep({ kind: 'hasValue', values });

// Three-arg `has(label, key, pred)`: filter by label AND property predicate.
// Exposed separately for callers that prefer the explicit name; `has(label,
// key, value-or-pred)` does the same via overload.
export const hasLabelAnd = (label: string, key: string, pred: Predicate): StepFn =>
  appendStep({ kind: 'hasLabelAnd', label, key, pred });

// Path-shape filters.
export const simplePath = (): StepFn => appendStep({ kind: 'simplePath' });
export const cyclicPath = (): StepFn => appendStep({ kind: 'cyclicPath' });

// `dedupe(...labels)` dedupes on the tuple of values tagged at those `as_`
// labels; the `.by(...)` projection modulator dedupes on a projected value.
export const dedupe = (...labels: string[]): ByableStep<Extract<Step, { kind: 'dedupe' }>> =>
  makeByable<Extract<Step, { kind: 'dedupe' }>>((bys) => ({
    kind: 'dedupe',
    labels: labels.length ? labels : undefined,
    bys,
  }));

// Filter the current value against a predicate.
export const is = (pred: Predicate): StepFn => appendStep({ kind: 'is', pred });

// `where` is polymorphic:
//   where(subPlan)              — keep traversers whose sub-plan emits.
//   where(startKey, predicate)  — keep traversers whose `startKey`-tagged value
//                                 matches `predicate` against the value tagged
//                                 at `predicate.value` (treated as an `as_`
//                                 label). Returns a `ByableStep` so callers
//                                 can append `.by(...)` modulators.
//
// The two forms share the `'where'` AST kind; the variants are distinguished
// by which fields are set (`plan` vs `startKey`/`pred`), so downstream
// pattern-matching narrows via TS's discriminated-union support without
// needing nullable fields.
export function where(planOrPred: SubPlan | Predicate): StepFn;
export function where(
  startKey: string,
  pred: Predicate,
): ByableStep<Extract<Step, { kind: 'where'; startKey: string }>>;
export function where(
  arg: SubPlan | string | Predicate,
  pred?: Predicate,
): StepFn | ByableStep<Extract<Step, { kind: 'where'; startKey: string }>> {
  if (typeof arg === 'string' && pred !== undefined) {
    return makeByable<Extract<Step, { kind: 'where'; startKey: string }>>((bys) => ({
      kind: 'where',
      startKey: arg,
      pred,
      bys,
    }));
  }

  // `where(neq('me'))`: predicate-only — compare the current value to a step label.
  if (isPredicate(arg)) {
    return appendStep({ kind: 'where', pred: arg });
  }

  return appendStep({ kind: 'where', plan: buildPlan(arg as SubPlan) });
}

// `filter(plan)` keeps traversers whose plan yields ≥1; `filter(fn)` keeps
// traversers where `fn(value, traverser)` returns truthy. Sub-plans accept
// either a branded `StepFn` (e.g. `pipe(...)`) or a `Plan` (e.g.
// `traversal(...)`); a raw closure routes to the closure form.
export const filter = (arg: SubPlan | FilterClosure): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'filter', plan: buildPlan(arg) })
    : appendStep({ kind: 'filterFn', fn: arg });
