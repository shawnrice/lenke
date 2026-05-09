import { appendStep, type FilterClosure, type StepFn } from './framework.js';

// Side-effect: stash each traverser into a named bag for later `cap()`.
export const aggregate = (key: string): StepFn => appendStep({ kind: 'aggregate', key });

// `store(key)` is the lazy-eval sibling of `aggregate(key)`. Same observable
// behavior in v2 (no bulk traversers, no barrier), but kept distinct so a
// future optimizer can introduce a barrier on `aggregate` without touching
// `store`.
export const store = (key: string): StepFn => appendStep({ kind: 'store', key });

// Read back the named bag from `aggregate` / `store`. Replaces the stream.
export const cap = (key: string): StepFn => appendStep({ kind: 'cap', key });

// Force materialization of the upstream stream before continuing. Useful when
// a downstream step needs side-effects (e.g. `aggregate`) populated upstream.
export const barrier = (): StepFn => appendStep({ kind: 'barrier' });

// Side-effect subgraph builder. STUBBED — executor throws.
export const subgraph = (key: string): StepFn => appendStep({ kind: 'subgraph', key });

/**
 * Filter closure: keep traversers whose value is *present* in the named
 * side-effect bag (populated by `aggregate(key)` / `store(key)` upstream).
 *
 * Sugar over the closure-with-sideEffects pattern. Use as
 * `filter(withinBag('seen'))`. Mirrors the spec form `where(within('seen'))`.
 */
export const withinBag = (key: string): FilterClosure =>
  (v, t) => (t.sideEffects.get(key) ?? []).includes(v);

/**
 * Filter closure: keep traversers whose value is *absent* from the named
 * side-effect bag. Inverse of `withinBag`. Common in "exclude already-seen"
 * patterns: `aggregate('seen')` upstream, then `filter(withoutBag('seen'))`
 * downstream. Mirrors the spec form `where(without('seen'))`.
 */
export const withoutBag = (key: string): FilterClosure =>
  (v, t) => !(t.sideEffects.get(key) ?? []).includes(v);
