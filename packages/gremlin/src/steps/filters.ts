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
} from './_internals.js';

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
export function has(key: string, valueOrPred: unknown): StepFn;
export function has(label: string, key: string, valueOrPred: unknown): StepFn;
export function has(a: string, b: unknown, c?: unknown): StepFn {
  if (c === undefined) {
    const pred = isPredicate(b) ? b : { op: 'eq' as const, value: b };
    return appendStep({ kind: 'has', key: a, pred });
  }
  const pred = isPredicate(c) ? c : { op: 'eq' as const, value: c };
  return appendStep({ kind: 'hasLabelAnd', label: a, key: b as string, pred });
}

export const hasLabel = (...labels: string[]): StepFn =>
  appendStep({ kind: 'hasLabel', labels });

export const hasId = (...ids: ID[]): StepFn => appendStep({ kind: 'hasId', ids });

export const hasKey = (...keys: string[]): StepFn => appendStep({ kind: 'hasKey', keys });

// Inverse of `has`: filter elements that DON'T have any of the given keys.
export const hasNot = (...keys: string[]): StepFn => appendStep({ kind: 'hasNot', keys });

// Filter property objects (`{key, value}`) by value field.
export const hasValue = (...values: unknown[]): StepFn =>
  appendStep({ kind: 'hasValue', values });

// Three-arg `has(label, key, pred)`: filter by label AND property predicate.
// Exposed separately for callers that prefer the explicit name; `has(label,
// key, value-or-pred)` does the same via overload.
export const hasLabelAnd = (label: string, key: string, pred: Predicate): StepFn =>
  appendStep({ kind: 'hasLabelAnd', label, key, pred });

// Path-shape filters.
export const simplePath = (): StepFn => appendStep({ kind: 'simplePath' });
export const cyclicPath = (): StepFn => appendStep({ kind: 'cyclicPath' });

// `dedupe(...labels)` accepts the legacy label-list form (an `as`/`select`
// modifier; not yet implemented). The projection modulator uses `.by(...)`.
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
export function where(plan: SubPlan): StepFn;
export function where(
  startKey: string,
  pred: Predicate,
): ByableStep<Extract<Step, { kind: 'where'; startKey: string }>>;
export function where(
  arg: SubPlan | string,
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
  return appendStep({ kind: 'where', plan: buildPlan(arg as SubPlan) });
}

// `filter(plan)` keeps traversers whose plan yields ≥1; `filter(fn)` keeps
// traversers where `fn(value, traverser)` returns truthy. Sub-plans accept
// either a branded `StepFn` (e.g. `pipe(...)`) or a `Plan` (e.g.
// `traversal(...)`); a raw closure routes to the closure form.
export const filter = (
  arg: SubPlan | FilterClosure,
): StepFn =>
  isSubPlan(arg)
    ? appendStep({ kind: 'filter', plan: buildPlan(arg) })
    : appendStep({ kind: 'filterFn', fn: arg as FilterClosure });
