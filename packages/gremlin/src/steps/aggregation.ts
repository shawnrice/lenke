import {
  appendStep,
  type ByableStep,
  makeByable,
  type Step,
  type StepFn,
} from './_internals.js';

// Numeric/comparable aggregates (return a one-element stream)
export const count = (): StepFn => appendStep({ kind: 'count' });
export const sum = (): StepFn => appendStep({ kind: 'sum' });
export const min = (): StepFn => appendStep({ kind: 'min' });
export const max = (): StepFn => appendStep({ kind: 'max' });
export const mean = (): StepFn => appendStep({ kind: 'mean' });

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
