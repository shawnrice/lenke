import { appendStep, type ID, type StepFn } from './_internals.js';

// Sources start a traversal. `V`/`E` read from the graph; `inject` injects
// arbitrary values as a fresh stream.

export const V = (...ids: ID[]): StepFn =>
  appendStep({ kind: 'V', ids: ids.length ? ids : undefined });

export const E = (...ids: ID[]): StepFn =>
  appendStep({ kind: 'E', ids: ids.length ? ids : undefined });

export const inject = (...values: unknown[]): StepFn =>
  appendStep({ kind: 'inject', values });
