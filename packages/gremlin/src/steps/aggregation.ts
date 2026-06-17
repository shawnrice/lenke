import {
  appendStep,
  type ByableStep,
  makeByable,
  scopeTokenOf,
  type Step,
  type StepFn,
} from './framework.js';

// Numeric/comparable aggregates (return a one-element stream).
//
// Each accepts an optional first `Scope` argument. With `Scope.local`, the
// aggregate is computed over each traverser's iterable VALUE rather than
// across the stream — typical use: `g.V().valueMap('age').fold().count(Scope.local)`.
// With `Scope.global` (default), the aggregate runs across the stream.
export function count(scope?: symbol): StepFn {
  return appendStep({ kind: 'count', scope: scope ? scopeTokenOf(scope) : undefined });
}

export function sum(scope?: symbol): StepFn {
  return appendStep({ kind: 'sum', scope: scope ? scopeTokenOf(scope) : undefined });
}

export function min(scope?: symbol): StepFn {
  return appendStep({ kind: 'min', scope: scope ? scopeTokenOf(scope) : undefined });
}

export function max(scope?: symbol): StepFn {
  return appendStep({ kind: 'max', scope: scope ? scopeTokenOf(scope) : undefined });
}

export function mean(scope?: symbol): StepFn {
  return appendStep({ kind: 'mean', scope: scope ? scopeTokenOf(scope) : undefined });
}

// Sort. With no args, natural order on the values themselves; with a `key`,
// sort by that property (vertex/edge); pass `desc: true` to flip. The
// modulator form `order().by(...)` overrides the legacy config-object args.
export const order = (
  config: { key?: string; desc?: boolean } = {},
): ByableStep<Extract<Step, { kind: 'order' }>> =>
  makeByable<Extract<Step, { kind: 'order' }>>((bys) => ({
    kind: 'order',
    ...config,
    bys,
  }));

// `group()` collects the whole stream into a single `Map<key, value[]>`.
// The legacy config-object form (`group({ keyBy, valueBy })`) is still
// accepted; the modulator form is `group().by(keyBy).by(valueBy)`.
export const group = (
  config: { keyBy?: string; valueBy?: string } = {},
): ByableStep<Extract<Step, { kind: 'group' }>> =>
  makeByable<Extract<Step, { kind: 'group' }>>((bys) => ({
    kind: 'group',
    ...config,
    bys,
  }));

// `groupCount()` is `group` with values replaced by counts. Legacy
// config-object form `{ by }` still works; modulator form is
// `groupCount().by(...)`.
export const groupCount = (
  config: { by?: string } = {},
): ByableStep<Extract<Step, { kind: 'groupCount' }>> =>
  makeByable<Extract<Step, { kind: 'groupCount' }>>((bys) => ({
    kind: 'groupCount',
    ...config,
    bys,
  }));

// Eager terminal alias for `fold()`.
export const toList = (): StepFn => appendStep({ kind: 'toList' });
