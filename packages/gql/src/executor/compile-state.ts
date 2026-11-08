/**
 * The compiler's query-scoped state, and the reason `executor.ts` was one 12,000-line file.
 *
 * ⚠️ THESE WERE AN IMPLICIT CHANNEL BETWEEN `compile` AND EVERYTHING IT CALLS (item 1664). `compile`
 * installed three collector `Set`s as module-level `let`s, ran the compiler, and then inspected what
 * the compiler had put in them — so `compileExpr` 10,000 lines away reported an unbound `$param` or
 * an unknown function by MUTATING A VARIABLE rather than by returning anything, and nothing in the
 * call signatures said so.
 *
 * That is precisely what made the file unsplittable: moving `compile` out took the only assignments
 * with it, TypeScript then inferred `never` for the declarations that stayed, and the errors
 * surfaced thousands of lines away as `Property 'add' does not exist on type 'never'` — pointing at
 * the reader rather than the cause.
 *
 * ⚠️ AND THE CHANNEL IS NOW NAMED RATHER THAN IMPLIED, which `import/no-mutable-exports` is right to
 * have insisted on. The first version of this module exported all five bindings as mutable `let`s
 * and the rule flagged every one; the rule's rationale — that a mutable export hides where data
 * actually flows — is exactly the defect documented above, so satisfying it improved the code
 * instead of working around it. `noteParam(name)` at a call site says what is happening where
 * `paramCollector?.add(name)` did not.
 *
 * ⚠️ `execEpoch` IS THE ONE EXCEPTION, AND IT IS MEASURED, NOT CONVENIENCE. Every other value here
 * is read ONCE per compile, so an accessor call costs nothing. `execEpoch` is read inside the
 * CLOSURE that `memoizeIfUncorrelated` returns — i.e. per row, on every memo check — so it stays an
 * ESM live binding, which a reader sees update and which collapses back to a direct variable
 * reference because this package ships as a single bundle. A getter there would put a call in a hot
 * loop to buy nothing. The rule is disabled for this file alone, in `oxlintrc.base.json`, with this
 * paragraph as the reason.
 */

/**
 * Bumped once per plan invocation. Memo caches key on it, so a value computed for one execution is
 * never reused by the next — see the `haystack` and uncorrelated-subquery memos in `core.ts`.
 *
 * ⚠️ Exported as a mutable binding deliberately; see the header. Read per ROW.
 */
export let execEpoch = 0;

/** Once per plan invocation. */
export const bumpExecEpoch = (): void => {
  execEpoch += 1;
};

/**
 * May an UNCORRELATED subquery's value be computed once and reused across rows? A WRITE anywhere in
 * the query can change that value between rows, so the whole query opts out rather than trying to
 * reason about clause order. Read once per compile, when the memo wrapper is built — never per row.
 */
let memoUncorrelated = false;

export const isMemoUncorrelated = (): boolean => memoUncorrelated;

/** Every `$name` the compiler saw, so `compile` can reject one the caller never bound. */
let paramCollector: Set<string> | null = null;

/** Function names that resolved to no scalar or aggregate, for eager rejection at compile time. */
let unknownFnCollector: Set<string> | null = null;

/** Params used in a COUNT position, which have their own validation. */
let countParamCollector: Set<string> | null = null;

export const noteParam = (name: string): void => {
  paramCollector?.add(name);
};

/**
 * Guarded separately from {@link noteUnknownFn} so a caller can skip the `isKnownScalarFn` lookup
 * when nothing is collecting — which is every call outside `compile`.
 */
export const collectingUnknownFns = (): boolean => unknownFnCollector !== null;

export const noteUnknownFn = (name: string): void => {
  unknownFnCollector?.add(name);
};

export const noteCountParamName = (name: string): void => {
  paramCollector?.add(name);
  countParamCollector?.add(name);
};

/**
 * Run `body` with the three collectors and the memo flag installed, restoring all four afterwards.
 *
 * ⚠️ SCOPED RATHER THAN SET/RESTORE BY HAND, so the invariant cannot be broken from outside. The
 * previous shape had `compile` save four values, assign four, and restore them in its own `finally`
 * — correct, but it put a four-way invariant in the caller where a nested or faulting compile could
 * leak one. Here there is nothing for a caller to get wrong.
 */
export const withCompileScope = <T>(
  param: Set<string>,
  unknownFn: Set<string>,
  countParam: Set<string>,
  memo: boolean,
  body: () => T,
): T => {
  const prevParam = paramCollector;
  const prevUnknown = unknownFnCollector;
  const prevCount = countParamCollector;
  const prevMemo = memoUncorrelated;

  paramCollector = param;
  unknownFnCollector = unknownFn;
  countParamCollector = countParam;
  memoUncorrelated = memo;

  try {
    return body();
  } finally {
    paramCollector = prevParam;
    unknownFnCollector = prevUnknown;
    countParamCollector = prevCount;
    memoUncorrelated = prevMemo;
  }
};
