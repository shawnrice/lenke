/**
 * The compiler's five QUERY-SCOPED GLOBALS, and the reason `executor.ts` was one 12,000-line file.
 *
 * ⚠️ THESE ARE AN IMPLICIT CHANNEL BETWEEN `compile` AND EVERYTHING IT CALLS (item 1663). `compile`
 * installs the three collectors, runs the compiler, and then inspects what the compiler put in them
 * — so `compileExpr` 10,000 lines away reports an unbound `$param` or an unknown function by
 * mutating a variable rather than by returning anything. Nothing in the call signatures says so.
 *
 * That is precisely what made the file unsplittable: every attempt to move `compile` out produced
 * `Property 'add' does not exist on type 'never'` from the OTHER side of the file, because the only
 * assignments to these bindings had left with it and TypeScript then inferred `never` for the
 * declarations that stayed. The error points at the reader, not at the cause.
 *
 * ⚠️ THE READS STAY FREE, WHICH IS WHY THIS IS A MODULE AND NOT A CLASS OR A CONTEXT OBJECT. An
 * imported `let` is an ESM LIVE BINDING: a reader sees every update, and because this package ships
 * as one bundle the binding collapses back to a direct variable reference with no call and no
 * property load. `execEpoch` is read in a per-row memo guard, so that mattered — wrapping it in a
 * getter would have put a call in a hot loop to buy nothing.
 *
 * Only ASSIGNMENT cannot cross a module boundary (an imported binding is read-only to the
 * importer), so the writers below exist for the write side alone. Every one of them runs once per
 * `compile` or once per plan invocation, never per row.
 *
 * Readers import the bindings; writers import these functions. Nothing here imports anything.
 */

/**
 * Bumped once per plan invocation. Memo caches key on it, so a value computed for one execution is
 * never reused by the next — see the `haystack` and uncorrelated-subquery memos in `core.ts`.
 */
export let execEpoch = 0;

/**
 * May an UNCORRELATED subquery's value be computed once and reused across rows? A WRITE anywhere in
 * the query can change that value between rows, so the whole query opts out rather than trying to
 * reason about clause order.
 */
export let memoUncorrelated = false;

/** Every `$name` the compiler saw, so `compile` can reject one the caller never bound. */
export let paramCollector: Set<string> | null = null;

/** Every function name that resolved to no scalar or aggregate, for eager rejection at compile time. */
export let unknownFnCollector: Set<string> | null = null;

/** Params used in a COUNT position, which have their own validation. */
export let countParamCollector: Set<string> | null = null;

/** Once per plan invocation. */
export const bumpExecEpoch = (): void => {
  execEpoch += 1;
};

export const setMemoUncorrelated = (v: boolean): void => {
  memoUncorrelated = v;
};

/**
 * The three collectors are installed and restored TOGETHER — `compile` saves the previous trio,
 * swaps in its own, and restores them in a `finally` so a nested or faulting compile cannot leak
 * one. Setting them as a group keeps that invariant in one place instead of three.
 */
export const setCollectors = (
  param: Set<string> | null,
  unknownFn: Set<string> | null,
  countParam: Set<string> | null,
): void => {
  paramCollector = param;
  unknownFnCollector = unknownFn;
  countParamCollector = countParam;
};
