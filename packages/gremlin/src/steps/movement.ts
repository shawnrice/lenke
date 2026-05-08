import { appendStep, type StepFn } from './_internals.js';

// Vertex → vertex: follow edges by direction.
export const out = (...labels: string[]): StepFn => appendStep({ kind: 'out', labels });
export const in_ = (...labels: string[]): StepFn => appendStep({ kind: 'in', labels });
export const both = (...labels: string[]): StepFn => appendStep({ kind: 'both', labels });

// Vertex → edge: yield the incident edges by direction.
export const outE = (...labels: string[]): StepFn => appendStep({ kind: 'outE', labels });
export const inE = (...labels: string[]): StepFn => appendStep({ kind: 'inE', labels });
export const bothE = (...labels: string[]): StepFn => appendStep({ kind: 'bothE', labels });

// Edge → vertex: yield the incident vertex by side.
export const outV = (): StepFn => appendStep({ kind: 'outV' });
export const inV = (): StepFn => appendStep({ kind: 'inV' });
export const bothV = (): StepFn => appendStep({ kind: 'bothV' });

// Edge → vertex: yield the *other* endpoint relative to the source vertex.
export const otherV = (): StepFn => appendStep({ kind: 'otherV' });
