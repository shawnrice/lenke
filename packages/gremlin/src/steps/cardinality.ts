import { ErrorCode, LenkeError } from '@lenke/errors';

import { appendStep, scopeTokenOf, type StepFn } from './framework.js';

// range(start, end) with end < start (end >= 0) is an invalid window. TinkerPop throws
// IllegalArgumentException at BUILD time (before any element flows, so even an unreached
// choose/coalesce arm faults) and the native engine rejects it at parse — validate here at
// construction to match, rather than only at runtime dispatch (which an unreached arm skips).
const checkRangeWindow = (start: number, end: number): void => {
  if (end >= 0 && end < start) {
    throw new LenkeError(
      `range(${start}, ${end}) is not a valid window — the high bound must be ` +
        `greater than or equal to the low bound`,
      { code: ErrorCode.InvalidValue },
    );
  }
};

// Each takes an optional first `Scope` argument. With `Scope.local`, the
// operation slices each traverser's iterable value (typical use: after
// `fold()` or on list-shaped projections); with `Scope.global` (default,
// equivalent to omitting the scope) it slices the stream of traversers.
//
// The Symbol → string-token translation happens in `scopeTokenOf` so the
// AST stays JSON-serializable.

export function take(n: number): StepFn;
export function take(scope: symbol, n: number): StepFn;
export function take(a: number | symbol, b?: number): StepFn {
  if (typeof a === 'symbol') {
    return appendStep({ kind: 'take', n: b!, scope: scopeTokenOf(a) });
  }

  return appendStep({ kind: 'take', n: a });
}

export function skip(n: number): StepFn;
export function skip(scope: symbol, n: number): StepFn;
export function skip(a: number | symbol, b?: number): StepFn {
  if (typeof a === 'symbol') {
    return appendStep({ kind: 'skip', n: b!, scope: scopeTokenOf(a) });
  }

  return appendStep({ kind: 'skip', n: a });
}

// `limit(n)` is identical to `take(n)` (TinkerPop alias).
export function limit(n: number): StepFn;
export function limit(scope: symbol, n: number): StepFn;
export function limit(a: number | symbol, b?: number): StepFn {
  if (typeof a === 'symbol') {
    return appendStep({ kind: 'take', n: b!, scope: scopeTokenOf(a) });
  }

  return appendStep({ kind: 'take', n: a });
}

export function range(start: number, end: number): StepFn;
export function range(scope: symbol, start: number, end: number): StepFn;
export function range(a: number | symbol, b: number, c?: number): StepFn {
  if (typeof a === 'symbol') {
    checkRangeWindow(b, c!);

    return appendStep({ kind: 'range', start: b, end: c!, scope: scopeTokenOf(a) });
  }

  checkRangeWindow(a, b);

  return appendStep({ kind: 'range', start: a, end: b });
}

/*
 * `tail(Scope.local)` WITH NO `n` IS A REAL TINKERPOP SIGNATURE AND DEFAULTS TO 1 (item 2480).
 * It was missing from the overloads here, and the implementation's `b!` made an untyped call
 * produce `n: undefined` — which `tailLocal` turns into `arr.slice(arr.length - undefined)` =
 * `arr.slice(NaN)` = the WHOLE list, silently returning everything instead of the last element.
 *
 * Ground truth, TinkerPop 3.7.3 on the modern graph (`[29, 27, 32, 35]`):
 *
 *     tail(local)    -> [35]        <- defaults to 1
 *     tail(local, 1) -> [35]
 *     tail(local, 2) -> [[32, 35]]
 *
 * And this engine's OWN Rust parser already defaults it to 1 (`gremlin.rs`, the `"tail"` arm:
 * `if is_local { if comma { usize_arg } else { 1 } }`), so the omission was also a cross-engine
 * divergence with Rust on the correct side.
 *
 * `limit`/`take`/`skip`/`range` above do NOT get the same treatment, and that is deliberate:
 * TinkerPop has no single-argument `limit(Scope)` — the console answers `No signature of method
 * ... limit() is applicable for argument types: (Scope)` — so requiring `n` there is correct.
 *
 * STILL DEVIATING, RECORDED NOT FIXED: at n = 1 TinkerPop UNWRAPS the single element (`[35]`)
 * where this engine yields a one-element list (`[[35]]`), and the same holds for
 * `range(local, 0, 1)` (`[29]`). That is one semantic choice across every local-scope slicing
 * step, not a defaulting bug, so it is an owner decision rather than part of this fix.
 */
export function tail(n?: number): StepFn;
export function tail(scope: symbol, n?: number): StepFn;
export function tail(a: number | symbol = 1, b?: number): StepFn {
  if (typeof a === 'symbol') {
    return appendStep({ kind: 'tail', n: b ?? 1, scope: scopeTokenOf(a) });
  }

  return appendStep({ kind: 'tail', n: a });
}

// Random subset of N traversers (materializes the stream).
export const sample = (n: number): StepFn => appendStep({ kind: 'sample', n });
