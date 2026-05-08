import { appendStep, type Predicate, type StepFn } from './_internals.js';

// Identity step — pass-through (useful as a placeholder in branch defaults).
export const identity = (): StepFn => appendStep({ kind: 'identity' });

// Evaluate an arithmetic expression. `_` references the current value.
export const math = (expr: string): StepFn => appendStep({ kind: 'math', expr });

/**
 * Stop the stream with an error. Useful for asserting traversal invariants.
 */
export const fail = (message?: string): StepFn => appendStep({ kind: 'fail', message });

/**
 * Filter every traverser out — the stream ends here.
 *
 * Narrow use: in TinkerPop, `none()` is primarily a signal to a remote server
 * that `iterate()` was called and the client doesn't want results. Direct
 * local use is rare; if you need it, the traversal can usually be rewritten
 * to simply not produce traversers in the first place. Provided here for
 * spec parity.
 *
 * @see https://tinkerpop.apache.org/docs/current/reference/#none-step
 */
// `none` has two modes:
//   none()          — legacy: drain and emit nothing (debug-noop).
//   none(predicate) — TinkerPop 3.8: keep the traverser iff its iterable
//                     value has no element satisfying the predicate.
//                     Typically chained after `fold()`.
export const none = (pred?: Predicate): StepFn => appendStep({ kind: 'none', pred });
