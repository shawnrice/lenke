import {
  appendStep,
  type ByableStep,
  makeByable,
  type Step,
  type StepFn,
  toBy,
} from './framework.js';

// Project to property values for the named keys.
export const values = (...keys: string[]): StepFn => appendStep({ kind: 'values', keys });

// Project to a single map of `{ [key]: value }`. With no keys, all properties.
export const valueMap = (...keys: string[]): StepFn =>
  appendStep({ kind: 'valueMap', keys: keys.length ? keys : undefined });

// Project property objects (`{key, value}`) for the named keys.
export const properties = (...keys: string[]): StepFn =>
  appendStep({ kind: 'properties', keys });

// Project all (or selected) properties as a single map of arrays.
export const propertyMap = (...keys: string[]): StepFn =>
  appendStep({ kind: 'propertyMap', keys: keys.length ? keys : undefined });

// Project to id+label+(selected) properties. For edges, also includes IN/OUT
// submaps with the endpoint id+label.
export const elementMap = (...keys: string[]): StepFn =>
  appendStep({ kind: 'elementMap', keys: keys.length ? keys : undefined });

// Yield the value of the current property/edge. For `{key, value}` from
// `properties()`, unwraps to the value; otherwise identity.
export const value = (): StepFn => appendStep({ kind: 'value' });

// Project to the element id.
export const id = (): StepFn => appendStep({ kind: 'id' });

// Project to the element label (first label if multiple).
export const label = (): StepFn => appendStep({ kind: 'label' });

// `project(keys, bys?)` emits a `{ [key]: value }` per traverser. `bys[i]`
// is the modulator for `keys[i]` (or omitted to project the traverser value
// itself). The optional `bys` arg accepts strings/StepFns/undefined for
// backward compatibility; the chained `.by(...)` form appends one at a time.
export const project = (
  keys: readonly string[],
  bys?: readonly (string | StepFn | undefined)[],
): ByableStep<Extract<Step, { kind: 'project' }>> => {
  const initial = bys?.map((b) => toBy(b));
  return makeByable<Extract<Step, { kind: 'project' }>>(
    (later) => ({ kind: 'project', keys, bys: later }),
    initial,
  );
};
