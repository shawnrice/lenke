// ISO scalar functions + three-valued (Kleene) logic + value helpers, extracted
// from the executor. Pure value operations (no back-dependency on compilation or
// matching), so this is a leaf module.
import {
  civilFromDays,
  DEFAULT_CONFIG,
  Duration,
  durationBetween,
  isRecord,
  isTemporal,
  LenkeRecord,
  LocalDate,
  LocalDateTime,
  LocalTime,
  Path,
  temporalArith,
  temporalCmpTotal,
  temporalParse,
  ZonedDateTime,
  ZonedTime,
} from '@lenke/core';
import { mathSign } from '@lenke/core';
import type { GraphLimits, Temporal } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import { AGGREGATES } from '../ast.js';
import type { ArithOp, CompareOp, Expr } from '../ast.js';
// Shared element guards + ordering comparator live in the executor trunk; used
// lazily inside scalar fns, so this back-edge is a safe function-level cycle.
import { compareSort, isEdge, isElement, isVertex } from '../executor.js';

// --- three-valued logic & scalar helpers -------------------------------------

// ISO three-valued (Kleene) logic: `null` is UNKNOWN. A row is kept only when a
// predicate evaluates to exactly `true` (see callers comparing `=== true`).
export type Truth = boolean | null;
export const isNullish = (v: unknown): boolean => v === null || v === undefined;
export const asTruth = (v: unknown): Truth => {
  if (isNullish(v)) {
    return null;
  }

  if (typeof v === 'boolean') {
    return v;
  }

  // A non-boolean in a truth context (WHERE / FILTER / CASE WHEN / AND / OR / NOT / XOR)
  // is a data exception — NOT coerced to a truth value (strict typing, matching the native
  // engine and SQL/ISO-GQL). The only path to a boolean is an explicit CAST AS BOOLEAN /
  // to_boolean. `Boolean(v)` used to JS-truthiness-coerce here (a number was "truthy").
  return dataException(
    'a boolean is required — a non-boolean value is not coerced to a truth value ' +
      '(use CAST(x AS BOOLEAN) or to_boolean(x))',
  );
};
export const not3 = (t: Truth): Truth => (t === null ? null : !t);
export const and3 = (a: Truth, b: Truth): Truth => {
  if (a === false || b === false) {
    return false;
  }

  return a === null || b === null ? null : true;
};
export const or3 = (a: Truth, b: Truth): Truth => {
  if (a === true || b === true) {
    return true;
  }

  return a === null || b === null ? null : false;
};
export const xor3 = (a: Truth, b: Truth): Truth => (a === null || b === null ? null : a !== b);
/** The binary three-valued connectives, keyed by AST node kind. */
export const BOOL3: Record<'and' | 'or' | 'xor', (a: Truth, b: Truth) => Truth> = {
  and: and3,
  or: or3,
  xor: xor3,
};

/** Raise a runtime value/type fault. Uses `E_INVALID_VALUE` — the single code the native
 *  engine surfaces for every runtime evaluation error at its FFI boundary — so a caught
 *  error carries the same `code` from the pure-TS and native engines (a drop-in must). */
export const dataException = (message: string): never => {
  throw new LenkeError(message, { code: ErrorCode.InvalidValue });
};

/** Lexicographic compare of two field-name strings (matches the native key sort). */
export const cmpKey = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};

/** Build a canonical record from field pairs (dup last-wins, keys sorted). The
 *  record value (`LenkeRecord`) lives in `@lenke/core`, shared with the
 *  serialization codecs and the Gremlin engine. */
export const makeRecord = (fields: readonly (readonly [string, unknown])[]): LenkeRecord =>
  LenkeRecord.from(fields);

/**
 * Read field `key` from a record/map, or `null` if absent (three-valued).
 *
 * REJECTED, item 898: the two probes here are NOT worth collapsing into one. A version that called
 * `get` first and used `has` only to disambiguate `undefined` — strictly fewer probes, and
 * answer-equivalent (its mutant survives, and so does reverting to this form) — measured **0.96x
 * and 1.00x** on the two nested-path arms that call this once per row, with the flat controls flat.
 * A `Map` probe on a small record is too cheap to matter, or the JIT already fuses the pair. The
 * nested-path cost (~3.4x a flat property read on the same scan) is somewhere else.
 *
 * `record-get-probes.test.ts` stays from that attempt: it pins the three-valued contract including
 * a key stored WITH the value `undefined`, which must read back as `undefined` and not as the
 * `null` an absent key gives. Nothing tested that before.
 */
export const recordGet = (rec: LenkeRecord, key: string): unknown =>
  rec.has(key) ? rec.get(key) : null;

export const typeName = (v: unknown): string => {
  if (Array.isArray(v)) {
    return 'a list';
  }

  if (v instanceof LenkeRecord) {
    return 'a map';
  }

  if (v !== null && typeof v === 'object') {
    return 'a graph element';
  }

  return typeof v;
};

// ISO arithmetic operands must be numbers (or NULL, which propagates). A
// non-numeric value is a data exception, not a silent `Number()` coercion to
// NaN — `'abc' + 1` and `true * 2` raise rather than producing garbage.
export const numOf = (v: unknown): number | null => {
  if (isNullish(v)) {
    return null;
  }

  if (typeof v === 'number') {
    // Collapse -0 to +0: the numeric model has NO negative zero (deliberate, unlike
    // IEEE — see native `num_of`). Grouping/sort/equality already collapse ±0; this is
    // the computation path, so no op observes a -0 (e.g. cot(-0) is +Inf, not -Inf).
    return v === 0 ? 0 : v;
  }

  return dataException(`arithmetic requires a number, got ${typeName(v)}`);
};

// `v IN list` is a three-valued OR of equalities `v = e` over the elements,
// whose identity (empty list) is FALSE. So `null IN []` is FALSE — there is
// nothing to be uncertain about — while `null IN [1]` and `3 IN [1, null]` are
// UNKNOWN. A TRUE equality short-circuits past any UNKNOWN.
// Structural value equality — lists compare by length then element-wise, matching
// the Rust engine's `value::equals`. (TS previously used reference identity, so
// `[1,2] = [1,2]` disagreed between the two engines.) A null list element compares
// equal here, same as Rust; strict ISO three-valued list equality would be
// UNKNOWN when an element is null — a documented, engine-symmetric deviation.
export const structuralEq = (a: unknown, b: unknown): boolean => {
  const aList = Array.isArray(a);
  const bList = Array.isArray(b);

  if (aList && bList) {
    return a.length === b.length && a.every((x, i) => structuralEq(x, b[i]));
  }

  if (aList || bList) {
    return false;
  }

  // Records are equal iff they have the same fields (keys canonical/sorted) with
  // recursively-equal values — ISO records support `=`/`<>`.
  const aRec = a instanceof LenkeRecord;
  const bRec = b instanceof LenkeRecord;

  if (aRec && bRec) {
    if (a.size !== b.size) {
      return false;
    }

    const ae = [...a];
    const be = [...b];

    return ae.every(([k, v], i) => k === be[i][0] && structuralEq(v, be[i][1]));
  }

  if (aRec || bRec) {
    return false;
  }

  // Two temporal instances are equal by value (same kind + same instant/
  // components), not by reference — `DATE '2020-01-01' = DATE '2020-01-01'`.
  if (isTemporal(a) && isTemporal(b)) {
    return temporalCmpTotal(a, b) === 0;
  }

  return a === b;
};

export const inList = (v: unknown, list: unknown): Truth => {
  if (!Array.isArray(list)) {
    return null;
  }

  let sawUnknown = false;

  for (const e of list) {
    if (isNullish(v) || isNullish(e)) {
      sawUnknown = true;
      continue;
    }

    if (structuralEq(e, v)) {
      return true;
    }
  }

  return sawUnknown ? null : false;
};

/** Binary operators resolved to a function once, at compile time. */
export const ARITH: Record<ArithOp, (a: number, b: number) => number> = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '*': (a, b) => a * b,
  '/': (a, b) => a / b,
  '%': (a, b) => a % b,
};

/**
 * One step of a left-associative arithmetic fold `lval <op> rval`. Preserves the
 * binary semantics: temporal arithmetic when either side is temporal, null when either
 * operand is null (propagated BEFORE the numeric type-check), a data exception for a
 * non-numeric operand otherwise, and a division/modulo-by-zero data exception.
 */
export const arithStep = (
  op: ArithOp,
  fn: (a: number, b: number) => number,
  lval: unknown,
  rval: unknown,
): unknown => {
  if (isTemporal(lval) || isTemporal(rval)) {
    return temporalArith(op, lval, rval);
  }

  // Null propagates BEFORE the numeric type-check, matching the engine: a null operand
  // makes the result null regardless of the other operand's type (the engine's math
  // carries a null/NaN and nulls it at egress). A non-numeric operand only faults when
  // NEITHER side is null — `'abc' + 1` raises, but `null - 'abc'` is null.
  if (isNullish(lval) || isNullish(rval)) {
    return null;
  }

  // Both operands are non-null here, so numOf returns a number or faults (never null).
  const lv = numOf(lval) as number;
  const rv = numOf(rval) as number;

  if ((op === '/' || op === '%') && rv === 0) {
    return dataException('division by zero');
  }

  return fn(lv, rv);
};

/** One step of a left-associative `||` fold: null propagates; two lists concat. */
export const concatStep = (lv: unknown, rv: unknown): unknown => {
  if (isNullish(lv) || isNullish(rv)) {
    return null;
  }

  if (Array.isArray(lv) && Array.isArray(rv)) {
    return [...lv, ...rv];
  }

  return str(lv) + str(rv);
};
/**
 * Compare two strings by Unicode CODE POINT, matching Rust `str::cmp` (UTF-8 byte
 * order == code-point order). JS `<`/`>` order by UTF-16 code UNIT, which disagrees
 * when an astral char (surrogate pair, ≥ U+10000) meets a BMP char in U+E000..U+FFFF:
 * the high surrogate (0xD800..0xDBFF) sorts BELOW U+E000 by code unit, but the astral
 * code point sorts ABOVE it. Iterating code points (via `codePointAt` + a 1-or-2 unit
 * step, allocation-free) makes both engines agree. Fast path: with no surrogate in
 * either string every char is BMP, so UTF-16 order already equals code-point order and
 * the native compare (much faster than a per-char loop) is exact.
 */
/*
 * REJECTED, with numbers — two cheaper GUARDS and one hoist (item 921). A CPU profile of a
 * sorted-page query put the regex below at 6.9% of the profile and this function at another 8.0%,
 * and the guard scans BOTH WHOLE STRINGS on EVERY comparison, re-establishing a per-string fact
 * O(log N) times during a sort. Three arms, measured in `packages/native/codepoint-guard-probe.mjs`
 * (floor = the bare native compare, which no guard can beat):
 *
 *     data        floor      ref     scan    ref/scan
 *     ascii         0.8      2.1      1.9       1.08x
 *     prefixed      1.2      2.7      9.5       0.28x
 *     astral        0.9      3.2      1.7       1.95x
 *
 *   - replacing the regex with a manual charCode loop (`scan`): REFUTED. 1.08x on ASCII is inside
 *     the ~10% noise band, and on keys with a long shared prefix it is 3.6x WORSE. V8's
 *     character-class match beats a hand-written loop, so THE REGEX IS THE RIGHT TOOL here.
 *   - deciding from the first differing code UNIT (`diff`): REFUTED ON CORRECTNESS, premise and
 *     all. Equal unit prefixes do NOT imply equal code-POINT prefixes, because segmentation
 *     depends on the FOLLOWING unit: the same high surrogate can begin a pair in one string and be
 *     LONE in the other, so `"\ud83d\ude00"` and `"\ud83d\ue000"` agree on unit 0 and disagree
 *     on what it means. Making it correct needs both strings proven free of lone surrogates, which
 *     is the whole-string scan it existed to avoid.
 *   - hoisting the guard OUT of the comparator so a sort tests each key once: SOUND but DECLINED.
 *     It can only remove the regex itself — 133.8 ms of a 1952 ms profile, so ~1.07x on that query
 *     shape at best — for an invasive change to a comparator that is generic over value types.
 *
 * If you come back to this, the hoist is the only live option and the ceiling above is what it has
 * to beat.
 */
export const compareCodePoints = (a: string, b: string): number => {
  if (!HAS_SURROGATE.test(a) && !HAS_SURROGATE.test(b)) {
    if (a < b) {
      return -1;
    }

    return a > b ? 1 : 0;
  }

  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;

    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }

    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }

  // Whichever string still has characters is the longer one, hence greater; a
  // prefix sorts before its extension.
  if (i < a.length) {
    return 1;
  }

  return j < b.length ? -1 : 0;
};
const HAS_SURROGATE = /[\uD800-\uDBFF]/;

const strOr =
  (op: (c: number) => boolean, raw: (a: number | string, b: number | string) => boolean) =>
  (a: number | string, b: number | string): boolean =>
    typeof a === 'string' && typeof b === 'string' ? op(compareCodePoints(a, b)) : raw(a, b);

export const COMPARE: Record<CompareOp, (a: number | string, b: number | string) => boolean> = {
  '=': (a, b) => a === b,
  '<>': (a, b) => a !== b,
  '<': strOr(
    (c) => c < 0,
    (a, b) => a < b,
  ),
  '>': strOr(
    (c) => c > 0,
    (a, b) => a > b,
  ),
  '<=': strOr(
    (c) => c <= 0,
    (a, b) => a <= b,
  ),
  '>=': strOr(
    (c) => c >= 0,
    (a, b) => a >= b,
  ),
};

export type FuncExpr = Extract<Expr, { kind: 'func' }>;

// Re-exported from the shared AST layer, which is where it has to live: the parser's static
// boolean-context check needs it too and must not import executor code. See `AGGREGATES` there.
export { AGGREGATES } from '../ast.js';

// Scalar-function arities, mirroring the native engine's parse-time arity table
// (`crates/lenke-engine/src/gql.rs`). Kept byte-exact so the two engines accept and
// reject the same calls: a call with the wrong argument count must fault on BOTH, not
// silently drop extra args (or read a missing one as null) on the TS side. The
// differential fuzzer generates wrong-arity calls to hold this in lockstep.
//
// Path accessors (`nodes`/`relationships`/`path_length`/`elements`) are intentionally
// ABSENT — native resolves those against a path variable BEFORE the arity table, so
// they are not arity-governed here either.
const SCALAR_ARITY_1 = new Set([
  'abs',
  'sign',
  'floor',
  'ceil',
  'ceiling',
  'sqrt',
  'exp',
  'ln',
  'log10',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'cot',
  'degrees',
  'radians',
  'upper',
  'lower',
  'trim',
  'size',
  'cardinality',
  'head',
  'last',
  '_year',
  '_month',
  '_day',
  '_hour',
  '_minute',
  '_second',
  '_is_nan',
  '_is_infinite',
  '_is_finite',
  'date',
  'local_time',
  'datetime',
  'local_datetime',
  'zoned_time',
  'zoned_datetime',
  'duration',
  'to_integer',
  'tointeger',
  'to_float',
  'tofloat',
  'to_string',
  'tostring',
  'to_boolean',
  'toboolean',
  'char_length',
  'character_length',
  'byte_length',
  'octet_length',
  'reverse',
  'tail',
  'keys',
  'labels',
  'type',
  'property_names',
  'element_id',
  'to_list',
  'tolist',
]);
const SCALAR_ARITY_2 = new Set([
  'append',
  'list_contains',
  'list_union',
  'difference',
  'intersection',
  'starts_with',
  'ends_with',
  'contains',
  'duration_between',
  'nullif',
  'log',
  'power',
  'mod',
  'left',
  'right',
  'split',
  'atan2',
]);

/**
 * Valid-arity check for a scalar function, mirroring native's parse-time table.
 * Returns `true`/`false` for a governed name, or `undefined` for a name this table
 * does not govern (an unknown function, an aggregate, or a path accessor) — the
 * caller leaves those to their own resolution path.
 */
export const scalarArityOk = (name: string, argc: number): boolean | undefined => {
  if (name === 'e' || name === 'pi') {
    return argc === 0;
  }

  if (SCALAR_ARITY_1.has(name)) {
    return argc === 1;
  }

  if (SCALAR_ARITY_2.has(name)) {
    return argc === 2;
  }

  if (name === 'round' || name === 'ltrim' || name === 'rtrim' || name === 'btrim') {
    return argc === 1 || argc === 2;
  }

  if (name === 'list_sort') {
    return argc >= 1 && argc <= 3;
  }

  if (name === 'range' || name === 'substring') {
    return argc === 2 || argc === 3;
  }

  if (name === 'replace') {
    return argc === 3;
  }

  if (name === 'coalesce') {
    return argc >= 1;
  }

  return undefined;
};

/**
 * The median of three values — `selectNth`'s pivot.
 *
 * A NAMED function rather than a nested ternary inline, for two reasons. It is what the linter
 * asks for, and it makes the pivot ARITHMETIC unit-testable on its own: the pivot CHOICE is
 * answer-equivalent (a first-element pivot is equally correct — item 1163, mutant M6), so no
 * differential test can pin it, and the standing remedy for that is to extract the arithmetic as
 * a pure function and test it directly.
 */
const medianOfThree = (x: number, y: number, z: number): number => {
  if (x < y) {
    if (y < z) {
      return y;
    }

    return x < z ? z : x;
  }

  if (x < z) {
    return x;
  }

  return y < z ? z : y;
};

/**
 * In-place Hoare quickselect: on return `a[k]` holds the k-th smallest of `a[0..n]`, with every
 * earlier element `<= a[k]` and every later one `>= a[k]`.
 *
 * WHY A SELECTION AND NOT A SORT, measured rather than assumed (item 1163). Three arms over
 * 200,000 values, median of 14 dropping three, three order-alternated rounds:
 *
 * ```text
 *   map + filter + sort((a, b) => a - b)   26.8 ms   what this replaced
 *   Float64Array + native .sort()           8.0       3.4x
 *   Float64Array + this quickselect         1.5      17.9x
 *   the gather alone                        0.1       the floor both sit on
 * ```
 *
 * The interesting result is the middle row: an INTERPRETED O(n) selection beats V8's NATIVE C++
 * O(n log n) typed-array sort by 5.3x at this size. That was not obvious going in — the constant
 * favours the native sort and only the exponent favours this — which is exactly why the arms were
 * measured before one was built.
 *
 * `%TypedArray%.prototype.sort` was also the WRONG answer for a second reason: it orders `-0`
 * before `+0` by specification, where `(a, b) => a - b` returns 0 and V8's stable sort keeps them
 * in input order. That difference cannot arise here, because {@link numArg} collapses `-0` to
 * `+0` before anything is compared — but it is the trap the native twin needed a guard for
 * (item 1162), and it is worth knowing which side of it this function sits on.
 *
 * MEDIAN-OF-THREE PIVOT, not first-element: a percentile over an already-ordered column is the
 * ordinary case, not the adversarial one, and a first-element pivot degrades to O(n^2) on exactly
 * that input.
 */
const selectNth = (a: Float64Array, n: number, k: number): number => {
  let lo = 0;
  let hi = n - 1;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const pivot = medianOfThree(a[lo], a[mid], a[hi]);
    let i = lo;
    let j = hi;

    while (i <= j) {
      while (a[i] < pivot) {
        i += 1;
      }

      while (a[j] > pivot) {
        j -= 1;
      }

      if (i <= j) {
        const t = a[i];

        a[i] = a[j];
        a[j] = t;
        i += 1;
        j -= 1;
      }
    }

    if (k <= j) {
      hi = j;
    } else if (k >= i) {
      lo = i;
    } else {
      return a[k];
    }
  }

  return a[k];
};

/**
 * ISO ordered-set percentile over a group's numeric values. `cont`
 * (`percentile_cont`) interpolates linearly between the two ranks bracketing
 * `frac·(n−1)`; otherwise (`percentile_disc`) it returns the value at the smallest
 * 0-based rank `k` with `(k+1)/n ≥ frac`. Non-numeric / non-finite values are
 * dropped; `frac` is pre-clamped to `[0, 1]`. Empty input → `null`.
 */
export const percentileOf = (
  values: readonly unknown[],
  frac: number,
  cont: boolean,
): number | null => {
  // ONE PASS into a Float64Array, replacing `map(numArg).filter(isFinite).sort((a, b) => a - b)`
  // — two intermediate arrays and a comparator-closure sort, 26.8 ms of a 31 ms query at 200,000
  // rows. See {@link selectNth} for why a selection and not a sort.
  const buf = new Float64Array(values.length);
  let n = 0;

  for (const v of values) {
    // `numArg` on EVERY element, in order, including ones about to be dropped — that is where
    // the old `map(numArg)` raised its data exception and a one-pass rewrite must keep it.
    const x = numArg(v);

    if (Number.isFinite(x)) {
      buf[n] = x;
      n += 1;
    }
  }

  if (n === 0) {
    return null;
  }

  if (cont) {
    const rn = frac * (n - 1);
    const lo = Math.floor(rn);
    const hi = Math.ceil(rn);
    const loVal = selectNth(buf, n, lo);

    if (lo === hi) {
      return loVal;
    }

    // The NEXT adjacent order statistic, with no second selection: `selectNth` leaves every
    // element after `lo` greater than or equal to `buf[lo]`, so the (lo+1)-th smallest is the
    // minimum of that tail. O(n), one scan — the same trick the native fast path uses.
    let hiVal = Infinity;

    for (let i = lo + 1; i < n; i += 1) {
      if (buf[i] < hiVal) {
        hiVal = buf[i];
      }
    }

    return loVal + (rn - lo) * (hiVal - loVal);
  }

  return selectNth(buf, n, Math.min(n - 1, Math.max(0, Math.ceil(frac * n) - 1)));
};

/**
 * Every aggregate call occurring anywhere in an expression, outermost first.
 *
 * ONE walk, because there are two questions to ask of it and a second copy of a twenty-case
 * structural descent is exactly the drift this file keeps paying for: {@link hasAggregate}
 * ("is there one?") and {@link everyAggregateIsCountStar} ("are they all `count(*)`?", which
 * decides whether the aggregating projection may stream — see `applyProjection`). An aggregate's
 * ARGUMENTS are still descended into, so a malformed nested aggregate is reported by both.
 */
export const collectAggregates = (expr: Expr): Extract<Expr, { kind: 'func' }>[] => {
  const out: Extract<Expr, { kind: 'func' }>[] = [];
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'func':
        if (AGGREGATES.has(e.name)) {
          out.push(e);
        }

        e.args.forEach(walk);
        break;
      case 'graphPred':
        e.args.forEach(walk);
        break;
      case 'neg':
      case 'not':
      case 'isNull':
      case 'isTruth':
      case 'isLabeled':
      case 'isTyped':
        walk(e.expr);
        break;
      case 'arith':
        walk(e.head);
        e.tail.forEach(([, t]) => walk(t));
        break;
      case 'concat':
      case 'and':
      case 'or':
      case 'xor':
        e.items.forEach(walk);
        break;
      case 'compare':
        walk(e.left);
        walk(e.right);
        break;
      case 'letIn':
        e.bindings.forEach((b) => walk(b.expr));
        walk(e.body);
        break;
      case 'in':
        walk(e.expr);
        walk(e.list);
        break;
      case 'index':
        walk(e.base);
        walk(e.index);
        break;
      case 'field':
        walk(e.base);
        break;
      case 'list':
        e.items.forEach(walk);
        break;
      case 'record':
        e.fields.forEach((f) => walk(f.value));
        break;
      case 'case':
        if (e.subject) {
          walk(e.subject);
        }

        e.whens.forEach((w) => {
          walk(w.when);
          walk(w.then);
        });

        if (e.elseExpr) {
          walk(e.elseExpr);
        }

        break;
      default:
        break;
    }
  };

  walk(expr);

  return out;
};

/** Does an expression contain an aggregate anywhere (→ implicit grouping)? */
export const hasAggregate = (expr: Expr): boolean => collectAggregates(expr).length > 0;

/**
 * Are ALL of an expression's aggregates `count(*)` — no argument, not `DISTINCT`?
 *
 * The question `applyProjection` asks before it streams. `count(*)` is the one aggregate that
 * reads nothing but the group's SIZE (`group.length`); every other one maps over the group's
 * bindings, so the bindings have to be there. TRUE of an expression with no aggregate at all,
 * which is the vacuous case the caller wants (a non-aggregate item reads the representative
 * binding and nothing else).
 */
export const everyAggregateIsCountStar = (expr: Expr): boolean =>
  collectAggregates(expr).every((a) => a.name === 'count' && a.star && !a.distinct);

// ISO `<numeric value function>` unary forms, keyed by function name. Each takes
// a single number; null in → null out is handled by the caller.
export const UNARY_NUM: Record<string, (n: number) => number> = {
  abs: Math.abs,
  ceil: Math.ceil,
  ceiling: Math.ceil,
  floor: Math.floor,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  cot: (n) => 1 / Math.tan(n),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  degrees: (n) => (n * 180) / Math.PI,
  radians: (n) => (n * Math.PI) / 180,
  sign: (n) => mathSign(n),
};

// ISO GQL 0-arg numeric constants.
export const NUM_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

// Non-finite CLASSIFIERS (leading-underscore extensions — NOT ISO): TOTAL boolean
// predicates. True iff the argument IS that IEEE-754 kind, false for everything else (a
// finite number, null, a string, any non-matching value). Never null, never throw — GQL
// has no NaN/Infinity literal or `IS NAN` predicate, so these are how you test for the
// special values (which otherwise render as null only at JSON egress). The caller runs
// these BEFORE null-propagation so `_is_nan(null)` is `false`, not `null`.
export const NONFINITE_CLASSIFIER: Record<string, (a: unknown) => boolean> = {
  _is_nan: (a) => Number.isNaN(a),
  _is_infinite: (a) => a === Infinity || a === -Infinity,
  _is_finite: (a) => Number.isFinite(a),
};

/**
 * Render one element of a list/path: a null element joins as the EMPTY string
 * (`String([1,null,3])` === `"1,,3"`), unlike a top-level null, which renders as
 * `"null"`. The native engine mirrors this JS rule deliberately.
 */
const joinElement = (x: unknown): string => (isNullish(x) ? '' : str(x));

/**
 * Stringify a value the way the native engine does (`js_str` in `gql/eval.rs`) —
 * the single coercion behind `to_string`, `CAST(… AS STRING)`, `||`, and every
 * string function's arguments.
 *
 * Plain `String(v)` agrees only on the primitives. A record is a `Map` subclass,
 * so it stringifies as `"[object Map]"`; a vertex/edge/path carries a debug
 * `toString` (`"Vertex (1) {}"`); and `Array.prototype.join` re-enters `String`
 * rather than this function, so a record nested in a list would slip through.
 * Each of those rendered differently from the native engine.
 */
export const str = (v: unknown): string => {
  // A record renders as its canonical JSON object — the same form it serializes
  // to in a result row (keys sorted by `LenkeRecord.from`).
  if (isRecord(v)) {
    return JSON.stringify(v);
  }

  // An element renders as its id, matching `element_id` (and native's `js_str`).
  if (isElement(v)) {
    return String((v as { id: unknown }).id);
  }

  if (Array.isArray(v)) {
    return v.map(joinElement).join(',');
  }

  // A path renders as its interleaved vertex/edge id sequence.
  if (v instanceof Path) {
    return [...v].map(joinElement).join(',');
  }

  return String(v);
};

// Round half away from zero — Rust's `f64::round` semantics. JS `Math.round`
// rounds half toward +∞ (`Math.round(-2.5) === -2`), so we apply the sign
// around `Math.abs` to match the native engine bit-for-bit.
export const roundHalfAway = (v: number): number => Math.sign(v) * Math.round(Math.abs(v));

// `sign` lives in `@lenke/core`: the Gremlin engine needs the same one, and the
// whole reason it is hand-written rather than `Math.sign` is cross-engine
// agreement.
export { mathSign };

/** ISO unary string value functions: one string in, a value out. */
export const UNARY_STR: Record<string, (s: string) => unknown> = {
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  char_length: (s) => s.length,
  character_length: (s) => s.length,
  // One-argument string functions that happen to live in `callStringPredicateFn`, which is why
  // item 761's `unaryStrCall` did not cover them (item 769). The general path answers through
  // its own `unaryStr` branch above the switch, so this is the same value either way.
  byte_length: (s) => byteLen(s),
  octet_length: (s) => byteLen(s),
};

// `trim`/`btrim` (both ends), `ltrim` (leading), `rtrim` (trailing). With a 2nd
// arg — a SET of characters to strip — they trim those code points (mirrors
// `exec::scalar::trim_fn`); without one they strip whitespace (the existing JS
// behavior, kept as-is for byte-identity on the whitespace path).
/**
 * Is `code` one of the UTF-16 code units in `chars`? (item 791)
 *
 * A linear scan with no allocation, which beats a `Set` here because a trim character set is one
 * to three characters in every real call and building the `Set` was itself one of the three
 * per-row allocations this replaces. Module scope rather than a closure inside `multiTrim`, for
 * the TS closure-size finding.
 */
const hasCode = (chars: string, code: number): boolean => {
  for (let k = 0; k < chars.length; k += 1) {
    if (chars.charCodeAt(k) === code) {
      return true;
    }
  }

  return false;
};

export const multiTrim = (
  s: string,
  chars: string,
  leading: boolean,
  trailing: boolean,
): string => {
  // AN ALL-BMP CHARACTER SET SCANS UTF-16 UNITS INSTEAD (item 791), which is the common case and
  // where the cost was: the code-point path below allocates THREE times a row — a `Set` over the
  // char set, an array of the whole subject string, and the `slice().join('')` that rebuilds it.
  // `btrim(a.s, ' ')` measured 265.6 ns a row against 35.6 for the one-argument form and 8.4 for
  // the same shape natively (item 790).
  //
  // WHY IT IS EQUIVALENT, which is the only reason it is allowed. Trimming only ever STOPS at the
  // first character that is not in the set, and every character it removes is a set member. When
  // the set holds no surrogate code unit:
  //
  //   - a surrogate half can never match, so the scan stops at a surrogate pair exactly where
  //     code-point iteration stops — it can never split one;
  //   - every removed character is BMP and so exactly ONE UTF-16 unit, which makes the unit
  //     offsets of the trimmed prefix and suffix equal their code-point offsets;
  //   - so `s.slice(lo, hi)` is the string `cps.slice(lo, hi).join('')` would build.
  //
  // A set containing a surrogate half, or an astral character, falls through to the code-point
  // path, which stays the definition. The membership test compares CODE UNITS rather than building
  // a `Set`, because a char set is one to three characters in every real call and `s[i]` would
  // allocate a one-character string per comparison.
  let setIsBmp = true;

  for (let k = 0; k < chars.length; k += 1) {
    const c = chars.charCodeAt(k);

    if (c >= 0xd800 && c <= 0xdfff) {
      setIsBmp = false;
      break;
    }
  }

  if (setIsBmp) {
    let from = 0;
    let to = s.length;

    while (leading && from < to && hasCode(chars, s.charCodeAt(from))) {
      from += 1;
    }

    while (trailing && to > from && hasCode(chars, s.charCodeAt(to - 1))) {
      to -= 1;
    }

    return s.slice(from, to);
  }

  // Code-point iteration (matches the Rust `chars()`), so the trim is
  // byte-identical across engines for the character-set case.
  const set = new Set(Array.from(chars));
  const cps = Array.from(s);
  let lo = 0;
  let hi = cps.length;

  while (leading && lo < hi && set.has(cps[lo])) {
    lo++;
  }

  while (trailing && hi > lo && set.has(cps[hi - 1])) {
    hi--;
  }

  return cps.slice(lo, hi).join('');
};

export const TRIM_FNS = new Set(['trim', 'btrim', 'ltrim', 'rtrim']);

/**
 * The ONE-ARGUMENT trim family as a plain `string -> string`, so `compileFunc` can route it
 * through [`unaryStrCall`] instead of the general dispatch (item 790).
 *
 * WHY IT IS SAFE AT THIS ARITY AND ONLY THIS ARITY. `STR_ARG_POSITIONS` gives these names
 * positions `[0, 1]`, which is why `SCALAR_ASSERTS_STR0_ONLY` does not admit them and the
 * specialization gate skips them. But `assertScalarArgTypes` skips an `undefined` argument, so at
 * ONE argument the whole positional check reduces to "position 0 is a string" — exactly what
 * `unaryStrCall` folds in, raising through `requiresStringMessage` as the assert does. The
 * two-argument forms keep `callTrim` and the general path, char set and all.
 *
 * The bodies are `callTrim`'s own `b === undefined` branch, unchanged: `ltrim` and `rtrim` use the
 * anchored regexes rather than `trimStart`/`trimEnd` because that is what the engine has always
 * done and the two differ on the exact set of characters each treats as whitespace.
 *
 * THE NATIVE REFUTATION DOES NOT TRANSFER, which is the reason this is worth doing after item 783
 * said not to. That item refuted adding the same family to the native `unary_str_fn` at 3% — but
 * the mechanism it refuted was INPUT BOXING, which LLVM already elided (item 784). TypeScript's
 * cost here is DISPATCH MACHINERY, which is a different quantity and a measured 22 ns a row: the
 * TS survey (`probe:scalar`) reads `char_length` at 19.9 ns a row against `size` at 42.0 for the
 * same work — a specialized name against an unspecialized one — where the native pair is 1.03x.
 */
export const TRIM_1: Record<string, (s: string) => string> = {
  trim: (s) => s.trim(),
  btrim: (s) => s.trim(),
  ltrim: (s) => s.replace(/^\s+/, ''),
  rtrim: (s) => s.replace(/\s+$/, ''),
};

export const callTrim = (name: string, a: unknown, b: unknown): unknown => {
  if (isNullish(a)) {
    return null;
  }

  const s = str(a);

  // No char-set ARGUMENT (`undefined` = the 1-arg form): whitespace default. A 2-arg form
  // with an explicit NULL char set (`ltrim`/`rtrim`/`btrim(s, null)`) propagates null,
  // matching the native engine and SQL (`trim` is 1-arg only, so it never reaches here
  // with `b === null`). Distinguishing the two is why this checks `undefined`/`null`
  // separately rather than `isNullish`.
  if (b === undefined) {
    if (name === 'ltrim') {
      return s.replace(/^\s+/, '');
    }

    return name === 'rtrim' ? s.replace(/\s+$/, '') : s.trim();
  }

  if (b === null) {
    return null;
  }

  return multiTrim(s, str(b), name !== 'rtrim', name !== 'ltrim');
};

/** ISO binary numeric value functions: LOG takes (base, value). */
export const BINARY_NUM: Record<string, (x: number, y: number) => number> = {
  // KNOWN LIMITATION (won't-fix): V8's `**`/`Math.pow` differs from Rust's
  // `powf` (glibc `pow`, the native engine) by ≤1 ULP on some inputs — e.g.
  // power(0.7,10) → …4ae here vs …4af native; power(2,-0.5) → …bcc vs …bcd. So
  // `power`/`pow`/`^` are NOT byte-identical cross-engine on those inputs; a true
  // fix needs a shared deterministic pow kernel. See this package's README.md.
  power: (x, y) => x ** y,
  mod: (x, y) => x % y,
  log: (base, value) => Math.log(value) / Math.log(base),
  // atan2(y, x): the ISO GQL binary arctangent (quadrant-correct). Mirrors the
  // native `y.atan2(x)`. atan2 is the one math fn whose result distinguishes the sign
  // of a zero operand (`atan2(-0, -1) = -PI` vs `+PI`); we treat -0 and +0 as one value,
  // so fold -0 to +0 on both inputs (`+ 0`), exactly as the native engine does.
  atan2: (y, x) => Math.atan2(y + 0, x + 0),
};

/** The loud data exception for `avg` over a temporal, or `sum` over a
 *  non-DURATION temporal — byte-identical message to native `FAULT_TEMPORAL_AGG`. */
export const unsupportedTemporalAgg = (): LenkeError =>
  new LenkeError(
    "unsupported temporal aggregate: sum() is defined only for DURATION (dates/times aren't " +
      'summable), and avg() over DURATION would need duration/count (often non-representable, ' +
      'e.g. avg(P1M,P2M)=P1.5M); use min()/max(), or sum() + host division',
    { code: ErrorCode.InvalidValue },
  );

/** `sum`/`avg` over a list/map is not numeric — throw loud rather than element-sum
 *  (which is the Gremlin `Scope.local` behavior, not a global aggregate). */
export const nonNumericAgg = (): LenkeError =>
  new LenkeError(
    'sum()/avg() require numeric values; a list/map is not summable — reduce it first ' +
      '(Gremlin sum(local), or GQL UNWIND + sum)',
    { code: ErrorCode.InvalidValue },
  );

/** `sum` over gathered temporal values: fold DURATIONs via the same `dur + dur`
 *  (`temporalArith('+')`, which throws on overflow); fault on any non-DURATION. */
export const temporalSum = (values: unknown[]): unknown => {
  let acc: unknown;

  for (const v of values) {
    if (!(v instanceof Duration)) {
      throw unsupportedTemporalAgg();
    }

    acc = acc === undefined ? v : temporalArith('+', acc, v);
  }

  return acc ?? null;
};

/**
 * `size`/`length`/`path_length`: a path's hop count (NOT `Path.length`, which is
 * the interleaved element count per the List contract), else a list/string length.
 */
export const lengthOf = (a: unknown): number | null => {
  if (isNullish(a)) {
    return null;
  }

  if (a instanceof Path) {
    return a.hops;
  }

  return Array.isArray(a) || typeof a === 'string' ? a.length : null;
};

/** Scalar (non-aggregate) functions: the ISO numeric/string value functions. */
// Coerce a numeric-function argument the way the Rust `num_of` does, NOT JS
// `Number()` — which additionally accepts hex/binary/octal strings ('0x10' → 16)
// and single-element arrays ([5] → 5). Numbers pass through; booleans → 0/1; a
// string parses under the strict decimal/scientific grammar (empty → 0); anything
// else → NaN. So abs('0x10') / abs([5]) are NaN in both engines.
export const numArg = (v: unknown): number => {
  if (typeof v === 'number') {
    // Collapse -0 to +0: no negative zero in the numeric model (see native `num_of`).
    // This is the numeric-function path (cot, atan2, …), the last place a -0 could be
    // observed after grouping/sort/equality already collapse ±0.
    return v === 0 ? 0 : v;
  }

  // Numbers are NOT coerced from booleans or strings — a non-number where a number is
  // required is a data exception, matching the native engine (which faults identically
  // for its numeric functions and aggregates). The only conversion path is an explicit
  // CAST / to_integer / to_float. A NULL never reaches here: every caller guards null
  // and short-circuits to NULL first, and the aggregates filter null out of the group.
  return dataException(`a number is required, ${typeName(v)} is not coerced`);
};

// Strict argument typing for the string / byte functions and the polymorphic
// string|list functions — mirrors the native engine's `call_scalar_checked`. A non-null
// argument of the wrong type is a data exception (never JS-coerced); a NULL argument
// still propagates to NULL. The mixed-arity fns (left/right/substring) type their first
// position as the string and the rest as numbers.
const STR_ARG_POSITIONS: Record<string, readonly number[]> = {
  upper: [0],
  lower: [0],
  char_length: [0],
  character_length: [0],
  byte_length: [0],
  octet_length: [0],
  trim: [0, 1],
  btrim: [0, 1],
  ltrim: [0, 1],
  rtrim: [0, 1],
  split: [0, 1],
  starts_with: [0, 1],
  ends_with: [0, 1],
  contains: [0, 1],
  regex_match: [0, 1],
  replace: [0, 1, 2],
  left: [0],
  right: [0],
  substring: [0],
};
const NUM_ARG_POSITIONS: Record<string, readonly number[]> = {
  left: [1],
  right: [1],
  substring: [1, 2],
};
const POLY_STR_LIST = new Set(['reverse', 'size', 'cardinality']);

/**
 * Raise a data exception if a string/byte/polymorphic function is given an argument of
 * the wrong type — the strict typing the native engine enforces in `call_scalar_checked`.
 * A NULL argument passes (it propagates to NULL downstream).
 */
/**
 * The data exception for a non-string argument where a string is required. ONE spelling,
 * because it is a cross-engine contract — native's `call_scalar_checked` raises the same text
 * and the differential harness compares it. Both the positional assert below and the
 * specialized `unaryStrCall` closure raise through here, so the two cannot drift.
 */
/**
 * `coalesce`: the first non-nullish argument, else null.
 *
 * A plain loop, not `args.find((x) => !isNullish(x))` (item 764). That arrow was a FRESH
 * CLOSURE on every row, and it made `coalesce` the most expensive general scalar call in the
 * library — 38.3 ns a row over a `count(a.age)` floor of 21.2 — while `_is_nan`, which
 * resolves past every table AND the whole switch in `callScalar`, cost 17.8. Dispatch DEPTH
 * is free here; a per-row allocation is not.
 *
 * It is a named function rather than an inlined loop because inlining it put `callScalar` at
 * complexity 36 against a limit of 35. Behaviour is identical to the `find`: that returned the
 * first non-nullish element, and its `?? null` only fired when there was none — which is what
 * falling out of this loop does.
 */
const firstNonNullish = (args: readonly unknown[]): unknown => {
  for (const x of args) {
    if (!isNullish(x)) {
      return x;
    }
  }

  return null;
};

const requiresStringMessage = (name: string): string =>
  `${name}() requires a string (a number is not coerced)`;

const assertScalarArgTypes = (name: string, args: readonly unknown[]): void => {
  const strPos = STR_ARG_POSITIONS[name];

  if (strPos) {
    for (const i of strPos) {
      const v = args[i];

      if (v !== undefined && !isNullish(v) && typeof v !== 'string') {
        dataException(requiresStringMessage(name));
      }
    }
  }

  const numPos = NUM_ARG_POSITIONS[name];

  if (numPos) {
    for (const i of numPos) {
      const v = args[i];

      if (v !== undefined && !isNullish(v) && typeof v !== 'number') {
        dataException(`${name}() requires a number (a string is not coerced)`);
      }
    }
  }

  if (POLY_STR_LIST.has(name)) {
    const [v] = args;
    // `cardinality` ALSO accepts a path (nodes + edges count) — `size` does not.
    const okPath = name === 'cardinality' && v instanceof Path;

    if (v !== undefined && !isNullish(v) && typeof v !== 'string' && !Array.isArray(v) && !okPath) {
      dataException(`${name}() requires a string or list`);
    }
  }
};

export const callScalar = (
  name: string,
  args: readonly unknown[],
  // Required, not defaulted: a default parameter counts against this function's
  // complexity budget, and every real call site has a graph in hand anyway.
  limits: GraphLimits,
): unknown => {
  assertScalarArgTypes(name, args);

  const [a, b] = args;

  const unaryNum = UNARY_NUM[name];

  if (unaryNum) {
    return isNullish(a) ? null : unaryNum(numArg(a));
  }

  const unaryStr = UNARY_STR[name];

  if (unaryStr) {
    return isNullish(a) ? null : unaryStr(str(a));
  }

  const binaryNum = BINARY_NUM[name];

  if (binaryNum) {
    // Validate BOTH non-null arguments before the null short-circuit: a named numeric
    // function faults on a non-numeric argument even beside a null (`atan2(null, duration)`
    // is a type error), matching the engine's gate. An arithmetic OPERATOR differs — it
    // propagates null before type-checking (see `arithStep`).
    const na = isNullish(a) ? null : numArg(a);
    const nb = isNullish(b) ? null : numArg(b);

    return na === null || nb === null ? null : binaryNum(na, nb);
  }

  if (name in NUM_CONSTANTS) {
    return NUM_CONSTANTS[name];
  }

  if (TRIM_FNS.has(name)) {
    return callTrim(name, a, b);
  }

  switch (name) {
    case 'round':
      return roundScalar(a, b);
    // `cardinality(p)` over a PATH is the ISO count of all elements (nodes + edges);
    // over a list/string it is the item count. (`length` is NOT an ISO GQL function —
    // the standard has PATH_LENGTH/CHAR_LENGTH/OCTET_LENGTH/CARDINALITY — so it is
    // rejected as unknown. `size` is list/string only; a path arg was rejected above.)
    case 'cardinality':
      return a instanceof Path ? a.vertices.length + a.edges.length : lengthOf(a);
    case 'size':
    case 'path_length':
      return lengthOf(a);
    case 'left':
      return leftScalar(a, b);
    case 'right':
      return rightScalar(a, b);
    case 'coalesce':
      return firstNonNullish(args);
    case 'nullif':
      // ISO `<case abbreviation>`: NULLIF(a, b) = NULL when a = b, else a. The
      // equality is the engine's VALUE equality (`structuralEq`, what `=` uses),
      // not JS `===` — two temporals/lists/records holding the same value are
      // distinct objects, so `===` said "not equal" where the native `value::equals`
      // said equal.
      return !isNullish(a) && !isNullish(b) && structuralEq(a, b) ? null : (a ?? null);
    case 'element_id':
      // ISO `<element_id function>`: the identifier of a node or edge.
      return a && typeof a === 'object' && 'id' in a ? a.id : null;
    default:
      // Graph/conversion/string/list functions live in a second dispatcher so
      // neither switch exceeds the complexity budget.
      return callExtendedScalar(name, args, limits);
  }
};

// --- ISO graph / conversion / string-list scalar functions -------------------
// Split out of `callScalar` (complexity budget). Semantics mirror the Rust
// engine (`gql/eval.rs`) byte-for-byte so both engines agree: labels/keys are
// sorted, slices are UTF-16-safe, `null` in → `null` out, and an unknown name is
// an `Unsupported` fault — never a silent `null`.

// Strict numeric-string parse matching Rust's `str::trim().parse::<f64>()`: the
// WHOLE trimmed string must be a finite decimal (optional sign, integer/fraction,
// exponent). `Number.parseFloat` is lenient — it would read `'12abc'` as `12`,
// diverging from the Rust engine — so we gate on the grammar first. Exotic forms
// (`inf`, `nan`, hex) are out of scope and yield null on both engines' common path.
export const FINITE_NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export const numericStringToFloat = (s: string): number | null => {
  const t = s.trim();

  if (!FINITE_NUMERIC.test(t)) {
    return null;
  }

  // A syntactically-valid literal can still overflow to Infinity ('1e1000').
  // Native filters those out (`.filter(|n| n.is_finite())`), so a non-finite
  // result is NOT a value here either — it reads as null, which matters for
  // `IS NOT NULL` even though JSON renders both as null.
  const v = Number.parseFloat(t);

  return Number.isFinite(v) ? v : null;
};

export const toIntScalar = (a: unknown): number | null => {
  if (isNullish(a)) {
    return null;
  }

  if (typeof a === 'number') {
    // A non-finite number (NaN/Inf) truncates to null, matching the engine's integer
    // branch (`if n.is_finite() { n.trunc() } else { Null }`). Without this, to_integer
    // returns a raw NaN that reads as null at RETURN egress but leaks as a value through
    // FOR..IN (`FOR v IN to_integer(NaN)` would yield a spurious [null] row). Note: to_float
    // deliberately KEEPS NaN in both engines, so the asymmetry here mirrors the engine.
    return Number.isFinite(a) ? Math.trunc(a) : null;
  }

  // A boolean converts to 1 / 0 — the ISO-GQL / Ultipa explicit conversion, matching the
  // native `to_number` and `CAST(x AS INTEGER)` (the implicit paths still never coerce it).
  if (typeof a === 'boolean') {
    return a ? 1 : 0;
  }

  // Only a number, boolean, or STRING converts — mirroring the native arms. Falling back
  // to `str(a)` would convert by stringifying, so a one-element list (`[0]` → "0")
  // or a vertex (whose `str` is its id) would come back as a number instead of the
  // null the native engine returns.
  if (typeof a !== 'string') {
    return null;
  }

  const p = numericStringToFloat(a);

  return p === null ? null : Math.trunc(p);
};

export const toFloatScalar = (a: unknown): number | null => {
  if (isNullish(a)) {
    return null;
  }

  if (typeof a === 'number') {
    return a;
  }

  // A boolean converts to 1 / 0 (explicit conversion, per the note in `toIntScalar`).
  if (typeof a === 'boolean') {
    return a ? 1 : 0;
  }

  // Number, boolean, or string only — see the note in `toIntScalar`.
  return typeof a === 'string' ? numericStringToFloat(a) : null;
};

// `round(num, [digits])` — digits default 0; half away from zero. A non-null `digits` is
// validated BEFORE the null short-circuit, so `round(null, 'abc')` faults like the engine
// (a named function validates its non-null args even beside a null).
export const roundScalar = (a: unknown, b: unknown): number | null => {
  if (!isNullish(b)) {
    numArg(b);
  }

  if (isNullish(a)) {
    return null;
  }

  const digits = isNullish(b) ? 0 : Math.trunc(numArg(b));
  const f = 10 ** digits;

  return roundHalfAway(numArg(a) * f) / f;
};

/**
 * `left(s, n)`, lifted out of `callScalar`'s switch so [`strNumCall`] can reach it (item 794).
 * The body is unchanged.
 */
export const leftScalar = (a: unknown, b: unknown): string | null =>
  isNullish(a) || isNullish(b) ? null : sanitizeSurrogates(str(a).slice(0, Math.max(0, numArg(b))));

/**
 * `right(s, n)`, lifted the same way (item 794) — body unchanged, including both comments, which
 * record two behaviours a rewrite would quietly lose.
 */
export const rightScalar = (a: unknown, b: unknown): string | null => {
  if (isNullish(a) || isNullish(b)) {
    return null;
  }

  const s = str(a);
  // Truncate toward zero to mirror native's `as usize` cast: a fractional
  // length takes whole characters, so `right('abcdef', 2.9)` is 'ef' (2), not
  // the 'def' that `slice(6 - 2.9)` = `slice(3.1)` would give. `left` already
  // truncates, because its fraction lands in `slice`'s END argument.
  const n = Math.trunc(numArg(b));

  // `n > 0`, not `!(n <= 0)`, so a NaN length (`right(s, 'nan')`) takes the
  // empty branch. Falling through with NaN would `slice(NaN)` — i.e.
  // `slice(0)`, the WHOLE string — whereas native's `NaN as usize` saturates
  // to 0 and yields ''. `left` is already empty for NaN.
  return n > 0 ? sanitizeSurrogates(s.slice(Math.max(0, s.length - n))) : '';
};

export const substringScalar = (a: unknown, b: unknown, len: unknown): string | null => {
  if (isNullish(a) || isNullish(b)) {
    return null;
  }

  const s = str(a);
  // ISO GQL: the start index is 1-based (SQL `SUBSTRING` convention), so
  // `substring('crystal hawk river', 1, 7)` → 'crystal'. Convert to a 0-based
  // UTF-16 offset; a start <= 0 shrinks the window from the front (SQL
  // semantics), which the native engine mirrors exactly.
  const zeroStart = numArg(b) - 1;
  const from = Math.max(0, zeroStart);

  return sanitizeSurrogates(
    isNullish(len) ? s.slice(from) : s.slice(from, Math.max(0, zeroStart + numArg(len))),
  );
};

// Decode a UTF-16 code-unit sequence to a string exactly as Rust's
// `String::from_utf16_lossy` does: a valid high+low surrogate pair combines to
// its scalar; any UNPAIRED surrogate becomes U+FFFD. `split('')` and `reverse`
// operate on UTF-16 code units (JS `.length` model, so `size` and these agree),
// and this shared lossy decode keeps them byte-identical with the native
// engine — whose UTF-8 strings cannot carry a lone surrogate. NOTE: this
// diverges from JS `String.split('')` / naive reversal, which PRESERVE lone
// surrogates; splitting or reversing across an astral character is inherently
// lossy here (documented non-conformance, mirroring the native engine).
export const fromUtf16UnitsLossy = (units: readonly number[]): string => {
  let out = '';

  for (let i = 0; i < units.length; i++) {
    const u = units[i];

    if (u >= 0xd800 && u <= 0xdbff) {
      const lo = i + 1 < units.length ? units[i + 1] : -1;

      if (lo >= 0xdc00 && lo <= 0xdfff) {
        out += String.fromCharCode(u, lo);
        i++;
      } else {
        out += '�';
      }
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      out += '�';
    } else {
      out += String.fromCharCode(u);
    }
  }

  return out;
};

// A UTF-16 slice (`substring`/`left`/`right`) can cut a surrogate pair, leaving a
// LONE surrogate. The native engine's UTF-8 strings can't carry one, so it
// renders U+FFFD; run every sliced result through the same lossy decode so the
// two engines stay byte-identical on astral-boundary slices.
/** Any UTF-16 code unit in the surrogate range — the only input `sanitizeSurrogates` changes. */
const SURROGATE_UNIT = /[\uD800-\uDFFF]/;

/**
 * A string with NO surrogate code unit is returned UNCHANGED (item 768). The general path
 * builds an ARRAY of code units per call — `Array.from({length: s.length}, …)`, one element
 * per character — and then rebuilds a string from it, which `substring`, `left` and `right`
 * were paying on every row. Measured over 200,000 distinct 12-character strings: **83.17 ns a
 * call against 8.15 with the guard, 10.2x**.
 *
 * The equivalence does not depend on what the slow path does with a surrogate, which is the
 * point: the guard only SKIPS it when there is none, and a string of non-surrogate units
 * decodes to exactly itself. Checked against the slow path on 200,000 strings, on an astral
 * character (a valid pair, preserved) and on a lone surrogate (which still takes the slow
 * path and still becomes U+FFFD).
 *
 * The regex is at MODULE scope. Built per call it would be a fresh object a row, which is the
 * cost item 764 found in `coalesce`.
 */
export const sanitizeSurrogates = (s: string): string =>
  SURROGATE_UNIT.test(s)
    ? fromUtf16UnitsLossy(Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)))
    : s;

export const splitScalar = (a: unknown, b: unknown): string[] | null => {
  if (isNullish(a) || isNullish(b)) {
    return null;
  }

  const s = str(a);
  const delim = str(b);

  // Empty delimiter → one element per UTF-16 code unit (JS `.length` model);
  // lone surrogates render as U+FFFD for byte-identity with the native engine.
  return delim === ''
    ? Array.from({ length: s.length }, (_, i) => fromUtf16UnitsLossy([s.charCodeAt(i)]))
    : s.split(delim);
};

/**
 * Replace every occurrence of `search` with `repl`, LITERALLY — no `$&`/`$1` expansion.
 *
 * This was `s.split(search).join(repl)`, which allocates an array of pieces per call. An
 * `indexOf` loop measured **60.56 ns a call against 118.64, 1.96x**, over 200,000 distinct
 * 12-character strings (item 768).
 *
 * `String.prototype.replaceAll` is NOT the fix even though it reads better and measured
 * 103.28 — it expands `$&`, `$1` and friends in the REPLACEMENT, where `split`/`join` and
 * native's `str::replace` do not, so it would be a silent cross-engine divergence on any
 * replacement containing a `$`.
 *
 * ONE MEASUREMENT TRAP, recorded because it reversed a verdict: benchmarked over a CONSTANT
 * string, `split`/`join` reads 54.44 and `replaceAll` 102.62, so `replaceAll` looks 1.9x
 * SLOWER. Over VARYING strings the order flips (118.64 against 103.28). The constant-string
 * loop lets the JIT cache the split, which is the "match the fixture to the claim" rule in a
 * form that is easy to miss: a per-row helper has to be measured over per-row DATA.
 */
const literalReplaceAll = (s: string, search: string, repl: string): string => {
  let at = s.indexOf(search);

  if (at === -1) {
    return s;
  }

  let out = '';
  let from = 0;

  while (at !== -1) {
    out += s.slice(from, at);
    out += repl;
    from = at + search.length;
    at = s.indexOf(search, from);
  }

  return out + s.slice(from);
};

export const replaceScalar = (a: unknown, b: unknown, repl: unknown): string | null => {
  if (isNullish(a) || isNullish(b)) {
    return null;
  }

  const search = str(b);

  if (search === '') {
    return str(a);
  }

  return literalReplaceAll(str(a), search, isNullish(repl) ? '' : str(repl));
};

// ISO GQL `to_boolean`: bool → itself; number → (x != 0), NaN → null; string →
// case-insensitive 'true'/'false' only, anything else → null (no 'yes'/'no'/'1'/'0'
// coercion). Mirrors the Rust `to_boolean_fn` arm.
export const toBooleanScalar = (a: unknown): boolean | null => {
  if (isNullish(a)) {
    return null;
  }

  if (typeof a === 'boolean') {
    return a;
  }

  if (typeof a === 'number') {
    // A NaN is a live value in GQL (only nulled at JSON egress), so converting it to a
    // boolean is an invalid conversion that faults HERE — not a null that trips a type
    // error at a later consumer. (`Infinity` is nonzero → true.)
    if (Number.isNaN(a)) {
      return dataException('cannot convert NaN to a boolean');
    }

    return a !== 0;
  }

  // Boolean, number, or string only — see the note in `toIntScalar`.
  if (typeof a !== 'string') {
    return null;
  }

  // Only the two boolean literals convert (case-insensitive, trimmed) — matching the
  // native engine. `'yes'`/`'no'`/`'1'`/`'0'` are NOT booleans; they yield null (an
  // invalid conversion), not a JS-style coercion. Use CAST for a checked conversion.
  const t = a.trim().toLowerCase();

  if (t === 'true') {
    return true;
  }

  return t === 'false' ? false : null;
};

// Parse a string to a number the way Rust's `str::parse::<f64>()` does — what the engine's
// CAST uses: finite decimals / exponents, plus the case-insensitive "inf"/"infinity"/"nan"
// spellings, with overflow → ±Infinity. `null` when the string is not a number at all (a
// data exception for CAST). DISTINCT from `numericStringToFloat` (the lenient function
// forms), which rejects the non-finite spellings.
const rustParseF64 = (s: string): number | null => {
  const t = s.trim().toLowerCase();
  const body = t.replace(/^[+-]/, '');

  if (body === 'inf' || body === 'infinity') {
    return t.startsWith('-') ? -Infinity : Infinity;
  }

  if (body === 'nan') {
    return Number.NaN;
  }

  return FINITE_NUMERIC.test(t) ? Number.parseFloat(t) : null;
};

// A number / boolean / numeric string coerced to a number for CAST — a boolean is 1/0, a
// string parses by Rust rules, anything else faults.
const numFromCastable = (v: unknown): number => {
  if (typeof v === 'number') {
    return v;
  }

  if (typeof v === 'boolean') {
    return v ? 1 : 0;
  }

  if (typeof v === 'string') {
    const parsed = rustParseF64(v);

    return parsed ?? dataException(`cannot cast string ${JSON.stringify(v)} to number`);
  }

  return dataException(`cannot cast ${typeName(v)} to number`);
};

// Strict CAST to a number (`value::cast`'s INTEGER / FLOAT arm). INTEGER additionally
// truncates and rejects a non-finite value.
const castToNumber = (v: unknown, integer: boolean): number => {
  const n = numFromCastable(v);

  if (!integer) {
    return n;
  }

  return Number.isFinite(n)
    ? Math.trunc(n)
    : dataException('cannot cast a non-finite number to integer');
};

// Strict CAST to boolean (`value::cast`'s BOOLEAN arm): the FULL SQL spelling set (wider
// than the `to_boolean` function's true/false), NaN faults, a nonzero finite number is
// true, everything else (unrecognized string, list, temporal, …) faults.
const castToBoolean = (v: unknown): boolean => {
  if (typeof v === 'boolean') {
    return v;
  }

  if (typeof v === 'number') {
    if (Number.isNaN(v)) {
      dataException('cannot cast NaN to boolean');
    }

    return v !== 0;
  }

  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();

    if (t === 't' || t === 'true' || t === 'y' || t === 'yes' || t === 'on' || t === '1') {
      return true;
    }

    if (t === 'f' || t === 'false' || t === 'n' || t === 'no' || t === 'off' || t === '0') {
      return false;
    }

    dataException(`cannot cast string ${JSON.stringify(v)} to boolean`);
  }

  return dataException(`cannot cast ${typeName(v)} to boolean`);
};

// The STRICT `CAST(x AS <scalar type>)` — mirrors the engine's `value::cast`. A NULL casts
// to NULL; otherwise a failed conversion is a data exception (unlike the lenient
// to_integer/to_float/to_boolean function forms, which return null). LIST never fails, so
// it reuses `toListScalar`.
/**
 * The target name a cast error uses, which is NOT the category spelling: `integer` and `float`
 * both report "number", matching `castToNumber`'s long-standing message and the native engine's
 * `CastTarget::Integer | CastTarget::Float => "number"` arm. The two engines must produce the
 * same bytes here, so the mapping lives in one named place rather than inline (item 353).
 */
const castTargetName = (category: string): string =>
  category === 'integer' || category === 'float' ? 'number' : category;

/**
 * Does `v` hold a graph element ANYWHERE, at any depth? The twin of the native engine's
 * `value::contains_element`, and the reason the two engines now agree on the NESTED cast
 * (audit item 354).
 *
 * This engine keeps real element identity at every depth, so the test is pure identity — no
 * rendered-element-map shape check, which is what native needs because its containers render
 * their items eagerly. The two still agree, because within GQL the only way a native container
 * holds an element-shaped map is that it IS a rendered element: a GQL `{…}` literal lowers to a
 * `Value::Record`, not the `Value::Map` the shape test keys on. Verified case by case against
 * both engines, lookalike maps included, rather than argued.
 *
 * `Path` and `LenkeRecord` are checked explicitly because neither is an `Array`: `Path` extends
 * the lazy `List`, and `LenkeRecord` extends `Map`. `str()` has the same two special cases, for
 * the same reason — and a record nested in a list slipping through `Array.prototype.join` is
 * exactly the bug its own comment records.
 */
const containsElement = (v: unknown): boolean => {
  if (isElement(v)) {
    return true;
  }

  if (Array.isArray(v)) {
    return v.some(containsElement);
  }

  // A path is a vertex/edge interleaving by construction, so `CAST(p AS STRING)` over a path
  // refuses as well — it was a divergence of its own (native rendered the whole path object's
  // text, this engine joined the ids).
  if (v instanceof Path) {
    return [...v].some(containsElement);
  }

  // A record's KEYS are strings; a Gremlin map's may be any value, so both sides recurse.
  if (v instanceof Map) {
    for (const [k, val] of v) {
      if (containsElement(k) || containsElement(val)) {
        return true;
      }
    }

    return false;
  }

  return false;
};

export const castValue = (v: unknown, category: string): unknown => {
  if (isNullish(v)) {
    return null;
  }

  // A graph element casts to NOTHING, and this check precedes the switch for the same reason the
  // NULL rule does: it is a property of the SOURCE, not of the target pair.
  //
  // `castToNumber` already refused one of these ("cannot cast a graph element to number"), but
  // `string` stringified the element to its EXTERNAL id while native answered its INTERNAL DENSE
  // id — so the two engines disagreed four ways and neither answer was a documented contract
  // (audit item 353). Refusing is the decided answer, and the conservative direction: ISO's free
  // artifacts show this is not a place implementations may choose (item 347), so one engine had
  // to change, and a refusal can be relaxed later to whatever the paywalled cast table says
  // without breaking anyone who relied on a behaviour the engines never agreed on.
  // `containsElement`, NOT a top-level `isVertex(v) || isEdge(v)` (item 354). The element also
  // casts to nothing when it is NESTED — `CAST([p, ''] AS STRING)`, `CAST(nodes(path) AS
  // STRING)` — which is the half item 353 left open. The message names the ELEMENT rather than
  // `typeName(v)` (which would say "a list"), because the element is the reason for the refusal
  // and both engines have to produce the same bytes.
  if (containsElement(v)) {
    dataException(`cannot cast a graph element to ${castTargetName(category)}`);
  }

  switch (category) {
    case 'integer':
      return castToNumber(v, true);
    case 'float':
      return castToNumber(v, false);
    case 'boolean':
      return castToBoolean(v);
    case 'list':
      return toListScalar(v);
    case 'string':
      // A finite number / bool / temporal / composite stringifies (via `str`, matching the
      // engine's `js_str`); a NON-finite number has no textual form and faults.
      if (typeof v === 'number' && !Number.isFinite(v)) {
        dataException('cannot cast a non-finite number to string');
      }

      return str(v);
    default:
      return dataException(`CAST to unsupported type '${category}'`);
  }
};

// ISO GQL `to_list`: a string → its UTF-16 code-unit characters (same unit
// model as `split('')`); a list → itself; a non-finite number (NaN/Inf) → null;
// any other value → a singleton list.
export const toListScalar = (a: unknown): unknown[] | null => {
  if (isNullish(a)) {
    return null;
  }

  // A non-finite number (NaN/±Inf) is not a convertible value → null, matching the
  // engine (which nulls non-finite numbers in to_list), NOT a `[null]` singleton.
  if (typeof a === 'number' && !Number.isFinite(a)) {
    return null;
  }

  if (Array.isArray(a)) {
    return a;
  }

  return typeof a === 'string' ? splitScalar(a, '') : [a];
};

export const UTF8 = new TextEncoder();

// UTF-8 byte length (ISO GQL `byte_length` / `octet_length`), matching Rust's
// `str::len()` (a UTF-8 byte count).
export const byteLen = (s: string): number => UTF8.encode(s).length;

// ISO GQL `range(start, end, [step])` → an inclusive list of integers. A zero
// step has no defined progression → null. Mirrors the Rust `Range` arm.
/**
 * `range()`, bounded by the graph's `limits.range` ceiling (see `GraphLimits`) —
 * the same bound the native engine applies, so both fault on exactly the same
 * inputs. A GQL list is a MATERIALIZED value in both engines (a JS array here,
 * `Vec<Val>` there), so it cannot be produced lazily without a lazy-list variant
 * threaded through both value models. Unbounded, `range(0, 1e21)` is not merely
 * slow: the counter stops advancing at 2^53 (`i += 1` is a no-op there), so the
 * loop never terminates while pushing, and the host dies on an OOM kill instead of
 * the query erroring.
 */
export const rangeScalar = (
  a: unknown,
  b: unknown,
  step: unknown,
  limit: number = DEFAULT_CONFIG.limits.range,
): number[] | null => {
  if (isNullish(a) || isNullish(b)) {
    return null;
  }

  const s = Math.trunc(numArg(a));
  const e = Math.trunc(numArg(b));
  const st = isNullish(step) ? 1 : Math.trunc(numArg(step));

  if (st === 0) {
    return null;
  }

  // The element count is computed UP FRONT: it bounds the allocation before a
  // single push, and it makes the loop COUNT-driven rather than comparison-driven,
  // so the 2^53 stall cannot spin forever (`range(9007199254740992,
  // 9007199254740994)` has a count of 3 but never terminates under `i <= e`).
  // The values still come from repeated addition, so the sequence is unchanged.
  const count = Math.floor((e - s) / st) + 1;

  // A backwards span (or a NaN bound) yields no elements.
  if (Number.isNaN(count) || count <= 0) {
    return [];
  }

  if (count > limit) {
    throw new LenkeError(
      `range() would materialize more than ${limit} elements; narrow the bounds or widen the step`,
      { code: ErrorCode.ResourceExhausted },
    );
  }

  const out: number[] = new Array<number>(count);
  let i = s;

  for (let k = 0; k < count; k++) {
    out[k] = i;
    i += st;
  }

  return out;
};

export const headScalar = (a: unknown): unknown => (Array.isArray(a) && a.length > 0 ? a[0] : null);

export const lastScalar = (a: unknown): unknown =>
  Array.isArray(a) && a.length > 0 ? a[a.length - 1] : null;

export const reverseScalar = (a: unknown): unknown => {
  if (isNullish(a)) {
    return null;
  }

  if (Array.isArray(a)) {
    return [...a].reverse();
  }

  if (typeof a !== 'string') {
    return null;
  }

  // Reverse by UTF-16 code unit (JS `.length` model), lossy-decoding the
  // reversed units the same way the native engine does (see fromUtf16UnitsLossy).
  const units: number[] = [];

  for (let i = 0; i < a.length; i++) {
    units.push(a.charCodeAt(i));
  }

  units.reverse();

  return fromUtf16UnitsLossy(units);
};

// A sentinel returned by a sub-dispatcher that doesn't handle `name`, so the
// callers can chain dispatchers (each kept under the complexity budget) and
// fall through to the unknown-function error.
export const UNHANDLED = Symbol('unhandled');

// Graph functions — label/key order sorted for cross-engine parity.
export const callGraphFn = (name: string, a: unknown): unknown => {
  switch (name) {
    // NOT VERIFIED CONFORMANT — see docs/conformance/gql-feature-checklist.md.
    // No free source consulted shows `labels` as an ISO function at all (the
    // standard appears to use the `IS LABELED` predicate), so this is a Cypher
    // inheritance rather than a conformance claim. It takes an ELEMENT because
    // the two vendors that ship it do: Spanner's
    // `LABELS(GRAPH_ELEMENT) -> ARRAY<STRING>` and Fabric's
    // `labels(node_or_edge)`. Both return a length-1 list for an edge since
    // neither has multi-label edges; this engine does, so it returns the set —
    // the natural generalization, and the only accessor for it.
    case 'labels':
      return isVertex(a) || isEdge(a) ? [...a.labels].sort() : null;
    // `type` stays SINGULAR: it is openCypher's `type(relationship) -> String`,
    // which cannot express a set. It reports an edge's first type, exactly as
    // Gremlin's `label()` reports a multi-label vertex's first label — both have
    // to return one. `labels(e)` is how you get all of them.
    case 'type':
      return isEdge(a) ? ([...a.labels][0] ?? '') : null;
    // `property_names` is the ISO GQL name; `keys` is the openCypher spelling.
    case 'property_names':
    case 'keys':
      return isElement(a) ? Object.keys(a.properties).sort() : null;
    // ISO GQL path functions. Vertices/edges stay live element handles (they
    // serialize richly, like `RETURN a`); `elements` is the path's own
    // interleaved iteration (vertex, edge, …, vertex).
    case 'nodes':
      return a instanceof Path ? [...a.vertices] : null;
    // `edges` is the ISO GQL name (Cypher's `relationships` is deliberately not
    // accepted — GQL's element vocabulary is node/edge).
    case 'edges':
      return a instanceof Path ? [...a.edges] : null;
    case 'elements':
      return a instanceof Path ? [...a] : null;
    default:
      return UNHANDLED;
  }
};

// Conversion functions (null in → null out).
export const callConversionFn = (name: string, a: unknown): unknown => {
  switch (name) {
    case 'tostring':
    case 'to_string':
      // A non-finite number (NaN/±Inf) has no text form → null, matching the engine's
      // `to_string_fn` (which stringifies only FINITE numbers), NOT JS `String(NaN)`
      // giving "NaN". Everything else defers to `str` (composites serialize as JSON).
      if (typeof a === 'number' && !Number.isFinite(a)) {
        return null;
      }

      return isNullish(a) ? null : str(a);
    case 'tointeger':
    case 'to_integer':
      return toIntScalar(a);
    case 'tofloat':
    case 'to_float':
      return toFloatScalar(a);
    case 'toboolean':
    case 'to_boolean':
      return toBooleanScalar(a);
    case 'tolist':
    case 'to_list':
      return toListScalar(a);
    default:
      return UNHANDLED;
  }
};

// String predicates (ISO BOOL-returning) + byte-length measurement.
export const callStringPredicateFn = (name: string, a: unknown, b: unknown): unknown => {
  switch (name) {
    case 'contains':
      return isNullish(a) || isNullish(b) ? null : str(a).includes(str(b));
    case 'starts_with':
      return isNullish(a) || isNullish(b) ? null : str(a).startsWith(str(b));
    case 'ends_with':
      return isNullish(a) || isNullish(b) ? null : str(a).endsWith(str(b));
    case 'byte_length':
    case 'octet_length':
      return isNullish(a) ? null : byteLen(str(a));
    default:
      return UNHANDLED;
  }
};

// String / list functions.
export const callStringListFn = (
  name: string,
  args: readonly unknown[],
  limits: GraphLimits,
): unknown => {
  const [a, b] = args;

  switch (name) {
    case 'substring':
      return substringScalar(a, b, args[2]);
    case 'split':
      return splitScalar(a, b);
    case 'replace':
      return replaceScalar(a, b, args[2]);
    case 'head':
      return headScalar(a);
    case 'last':
      return lastScalar(a);
    case 'reverse':
      return reverseScalar(a);
    case 'tail':
      return Array.isArray(a) ? a.slice(1) : null;
    case 'append':
      // The element may be null (a first-class value); only a null LIST → null.
      return Array.isArray(a) ? [...a, args[1] ?? null] : null;
    case 'range':
      return rangeScalar(a, b, args[2], limits.range);
    default:
      return UNHANDLED;
  }
};

// Push `v` into `out` unless a structurally-equal element is already present
// (first occurrence wins) — the dedup building block for the set-style list
// functions, mirroring the Rust `push_unique`.
export const pushUnique = (out: unknown[], v: unknown): void => {
  if (!out.some((x) => structuralEq(x, v))) {
    out.push(v);
  }
};

// ISO GQL `list_sort` <nullOrder> arg → the `nullsFirst` flag; `undefined`
// (default / unrecognized) falls back to the ORDER BY default in `compareSort`.
export const nullOrderArg = (v: unknown): boolean | undefined => {
  if (typeof v !== 'string') {
    return undefined;
  }

  const s = v.toLowerCase();

  if (s === 'first') {
    return true;
  }

  return s === 'last' ? false : undefined;
};

// Set-style list functions (ISO GQL). All dedup by structural equality with the
// first occurrence winning; list_sort reuses the ORDER BY total order so it is
// byte-identical with `ORDER BY`.
export const callListSetFn = (
  name: string,
  a: unknown,
  b: unknown,
  args: readonly unknown[],
): unknown => {
  switch (name) {
    case 'list_union': {
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return null;
      }

      const out: unknown[] = [];

      for (const v of [...a, ...b]) {
        pushUnique(out, v);
      }

      return out;
    }
    case 'intersection': {
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return null;
      }

      const out: unknown[] = [];

      for (const v of a) {
        if (b.some((w) => structuralEq(w, v))) {
          pushUnique(out, v);
        }
      }

      return out;
    }
    case 'difference': {
      if (!Array.isArray(a) || !Array.isArray(b)) {
        return null;
      }

      const out: unknown[] = [];

      for (const v of a) {
        if (!b.some((w) => structuralEq(w, v))) {
          pushUnique(out, v);
        }
      }

      return out;
    }
    case 'list_contains':
      // ISO returns the numeric 1 / 0 (not a boolean); the value may be null.
      if (!Array.isArray(a)) {
        return null;
      }

      return a.some((w) => structuralEq(w, b)) ? 1 : 0;
    case 'list_sort':
      if (!Array.isArray(a)) {
        return null;
      }

      return [...a].sort((x, y) =>
        compareSort(
          x,
          y,
          typeof b === 'string' && b.toLowerCase() === 'desc',
          nullOrderArg(args[2]),
        ),
      );
    default:
      return UNHANDLED;
  }
};

// Temporal constructors: `date(x)` / `local_datetime(x)` / `duration(x)`. Mirror
// the Rust `temporal_ctor` — parse a string, convert a temporal by kind (date↔
// datetime), else null (lenient, like the to_* conversions).
export const TEMPORAL_CTOR: Record<
  string,
  'date' | 'localtime' | 'datetime' | 'zoned_time' | 'zoned_datetime' | 'duration'
> = {
  date: 'date',
  local_time: 'localtime',
  local_datetime: 'datetime',
  datetime: 'datetime',
  zoned_time: 'zoned_time',
  zoned_datetime: 'zoned_datetime',
  duration: 'duration',
};

export const temporalCtor = (
  kind: 'date' | 'localtime' | 'datetime' | 'zoned_time' | 'zoned_datetime' | 'duration',
  v: unknown,
): unknown => {
  if (isNullish(v)) {
    return null;
  }

  if (typeof v === 'string') {
    // A bare date-only `YYYY-MM-DD` (no time part) coerces to midnight for a
    // datetime target — consistent with date() and the DATE `$__now` → midnight
    // precedent. Mirrors the Rust `temporal_ctor`.
    if (kind === 'datetime' && !/[T ]/.test(v)) {
      try {
        const d = temporalParse('date', v) as LocalDate;

        return new LocalDateTime(d.days * 86_400, 0);
      } catch {
        return null;
      }
    }

    try {
      return temporalParse(kind, v);
    } catch {
      return null;
    }
  }

  if (isTemporal(v)) {
    if (v.kind === kind) {
      return v;
    }

    if (kind === 'date' && v instanceof LocalDateTime) {
      return new LocalDate(Math.floor(v.secs / 86_400));
    }

    // local_time(datetime) → the time-of-day part.
    if (kind === 'localtime' && v instanceof LocalDateTime) {
      return new LocalTime(((v.secs % 86_400) + 86_400) % 86_400, v.nanos);
    }

    if (kind === 'datetime' && v instanceof LocalDate) {
      return new LocalDateTime(v.days * 86_400, 0);
    }
  }

  return null;
};

export const callTemporalFn = (name: string, args: readonly unknown[]): unknown => {
  const kind = TEMPORAL_CTOR[name];

  if (kind !== undefined) {
    return temporalCtor(kind, args[0]);
  }

  if (name === 'duration_between') {
    const [x, y] = args;

    return isTemporal(x) && isTemporal(y) ? durationBetween(x, y) : null;
  }

  return UNHANDLED;
};

// Temporal component extraction (the `_year`/`_month`/`_day`/`_hour`/`_minute`/
// `_second` lenke extension — see docs/design/gql-extensions.md). Euclidean
// floor/mod so pre-epoch instants (negative seconds) decompose byte-identically
// to the Rust `div_euclid`/`rem_euclid`.
export const SECS_PER_DAY = 86_400;
export const floorDiv = (n: number, d: number): number => Math.floor(n / d);
export const euclidMod = (n: number, d: number): number => ((n % d) + d) % d;

/** The integer component, or `null` if the temporal kind lacks it (e.g. `year`
 * of a LOCAL TIME, `hour` of a DATE) — the caller turns `null` into a throw. */
export const datePart = (name: string, t: Temporal): number | null => {
  if (name === 'year' || name === 'month' || name === 'day') {
    let epochDays: number;

    if (t instanceof LocalDate) {
      epochDays = t.days;
    } else if (t instanceof LocalDateTime) {
      epochDays = floorDiv(t.secs, SECS_PER_DAY);
    } else if (t instanceof ZonedDateTime) {
      epochDays = floorDiv(t.secs + t.offset * 60, SECS_PER_DAY);
    } else {
      return null;
    }

    const [y, m, d] = civilFromDays(epochDays);

    if (name === 'year') {
      return y;
    }

    return name === 'month' ? m : d;
  }

  let tod: number;

  if (t instanceof LocalTime) {
    tod = t.secs;
  } else if (t instanceof LocalDateTime) {
    tod = euclidMod(t.secs, SECS_PER_DAY);
  } else if (t instanceof ZonedTime || t instanceof ZonedDateTime) {
    tod = euclidMod(t.secs + t.offset * 60, SECS_PER_DAY);
  } else {
    return null;
  }

  if (name === 'hour') {
    return floorDiv(tod, 3600);
  }

  return name === 'minute' ? floorDiv(tod, 60) % 60 : tod % 60;
};

// Sigil-prefixed because date-part extraction is a lenke EXTENSION, not in the
// ISO GQL function catalogue (see docs/design/gql-extensions.md). The bare names
// (`year`/…) stay unknown functions, flagging non-portability at the call site.
export const DATE_PART_FNS = new Set(['_year', '_month', '_day', '_hour', '_minute', '_second']);

export const callDatePartFn = (name: string, a: unknown): unknown => {
  if (!DATE_PART_FNS.has(name)) {
    return UNHANDLED;
  }

  if (isNullish(a)) {
    return null; // null in → null out
  }

  const component = name.slice(1); // strip the extension sigil → year/month/…

  if (isTemporal(a)) {
    const n = datePart(component, a);

    if (n !== null) {
      return n;
    }
  }

  // A string is NOT coerced, and a temporal lacking the component faults loudly.
  throw new LenkeError(
    `${name}() requires a temporal value that carries that component ` +
      `(a date carries year/month/day; a time carries hour/minute/second) — ` +
      `a string is NOT coerced; wrap it with date()/local_datetime()/local_time() first`,
    { code: ErrorCode.InvalidValue },
  );
};

// The extended-scalar family dispatchers, in priority order. Each returns UNHANDLED
// for a name that isn't one of its own, so `callExtendedScalar` returns the first
// non-UNHANDLED result. Built once at module scope. Order matters only for
// callDatePartFn, whose throw is keyed to its own `_year`/… names.
const EXTENDED_DISPATCHERS: readonly ((
  name: string,
  a: unknown,
  b: unknown,
  args: readonly unknown[],
  limits: GraphLimits,
) => unknown)[] = [
  (name, a) => callGraphFn(name, a),
  (name, a) => callConversionFn(name, a),
  (name, a) => callDatePartFn(name, a),
  (name, _a, _b, args) => callTemporalFn(name, args),
  (name, a, b) => callStringPredicateFn(name, a, b),
  (name, _a, _b, args, limits) => callStringListFn(name, args, limits),
  (name, a, b, args) => callListSetFn(name, a, b, args),
];

export const callExtendedScalar = (
  name: string,
  args: readonly unknown[],
  limits: GraphLimits = DEFAULT_CONFIG.limits,
): unknown => {
  const [a, b] = args;

  // Non-finite classifiers (total booleans, never null) — see NONFINITE_CLASSIFIER. They
  // reach here via callScalar's default arm, ahead of any null-propagation, so
  // `_is_nan(null)` is `false`, not `null`. (Homed in this second dispatcher to keep
  // callScalar under its complexity budget.)
  const classifier = NONFINITE_CLASSIFIER[name];

  if (classifier) {
    return classifier(a);
  }

  // The STRICT scalar `CAST(a AS <b>)` (`b` is the target category literal) — faults on a
  // failed conversion, unlike the lenient to_integer/… forms the parser used to desugar to.
  if (name === 'cast') {
    return castValue(a, b as string);
  }

  // Short-circuit on the first handler. (The previous array-literal form invoked
  // ALL seven before the `!== UNHANDLED` check, so the early-return was dead and
  // every fall-through call paid for all seven switch dispatches.)
  for (const dispatch of EXTENDED_DISPATCHERS) {
    const result = dispatch(name, a, b, args, limits);

    if (result !== UNHANDLED) {
      return result;
    }
  }

  throw new LenkeError(`call to an unknown or unimplemented function: ${name}()`, {
    code: ErrorCode.UnknownFunction,
  });
};

/**
 * The names whose arguments `assertScalarArgTypes` validates by POSITION before the
 * dispatch runs. A specialized call path (see `unaryNumCall`/`binaryNumCall`) skips that
 * pass, so it must refuse any name in here — this is the gate that keeps the skip honest
 * rather than a silent loss of a type error. Built from the same three tables the assert
 * reads, so adding a position there cannot leave this stale.
 */
export const SCALAR_NEEDS_ARG_ASSERT: ReadonlySet<string> = new Set([
  ...Object.keys(STR_ARG_POSITIONS),
  ...Object.keys(NUM_ARG_POSITIONS),
  ...POLY_STR_LIST,
]);

/**
 * A one-argument numeric function with its argument step, resolved ONCE per `Expr::Call`
 * instead of once per row (item 760). Identical to `callScalar`'s `unaryNum` branch, minus
 * the per-row argument ARRAY, the three dictionary misses in `assertScalarArgTypes` and the
 * walk down the dispatch chain. `numArg` is what raises on a non-number, so the strict
 * typing is unchanged.
 *
 * MODULE SCOPE, not inlined at the call site: a closure built inside a large function body
 * gave unrelated queries a new slow mode once already (the TS closure-size finding), so the
 * factory lives here and the compiler only calls it.
 */
export const unaryNumCall =
  <E>(f: (x: number) => number, a: (env: E) => unknown) =>
  (env: E): unknown => {
    const v = a(env);

    return isNullish(v) ? null : f(numArg(v));
  };

/**
 * `round(x)` and `round(x, digits)`, resolved once per `Expr::Call` (item 788) — the TS twin of
 * item 785, which put `round/2` in the native two-argument numeric table for 3.45x.
 *
 * WHY IT CANNOT JOIN `BINARY_NUM`. That table's closure applies `(x, y) => number` only after
 * `binaryNumCall` has turned EITHER null argument into a null result. `round` does not work that
 * way: a null digit count means ZERO digits, so `round(5, null)` is `5` where `BINARY_NUM` would
 * answer null. And it cannot join `UNARY_NUM` either, because its second argument is optional —
 * which is why `round` is the one numeric name in neither table and was paying the general
 * dispatch at BOTH arities (40.6 ns a row at two arguments, 35.4 at one, against a specialized
 * band of 18-27 and a 15.6 floor).
 *
 * The body is `roundScalar`'s, in its order, and the ORDER is the contract: the digit count is
 * validated BEFORE the first argument's null is checked, so `round(null, 'x')` raises rather than
 * answering null. `10 ** NaN` is NaN and NaN/NaN is NaN, which is how this engine reaches the
 * non-finite-digit-count rule by arithmetic where native needs an explicit guard (the native
 * `round` entry's own comment records that asymmetry).
 */
export const roundCall =
  <E>(a: (env: E) => unknown, b: ((env: E) => unknown) | undefined) =>
  (env: E): unknown => {
    const x = a(env);
    const y = b === undefined ? null : b(env);

    // BEFORE the null check on `x` — see above.
    if (!isNullish(y)) {
      numArg(y);
    }

    if (isNullish(x)) {
      return null;
    }

    const digits = isNullish(y) ? 0 : Math.trunc(numArg(y));
    const f = 10 ** digits;

    return roundHalfAway(numArg(x) * f) / f;
  };

/**
 * `nullif(a, b)`, resolved once per `Expr::Call` (item 788) — the TS twin of item 787, which gave
 * the native engine a typed arm for 3.26x. Measured 39.4 ns a row on the general dispatch here.
 *
 * It cannot join `BINARY_NUM` for a different reason than `round`: it is POLYMORPHIC (strings,
 * lists, records and temporals all work) and it RETURNS a null, so neither the numeric argument
 * step nor the `number` return type fits.
 *
 * `structuralEq` is the equality, NOT JS `===` — the engine's VALUE equality, what `=` uses. Two
 * temporals or lists holding the same value are distinct objects, so `===` answered "not equal"
 * where native's `value::equals` answered equal. And the surviving row carries `a` RAW (`a ??
 * null`), which is the same rule item 787 had to protect natively: there the hazard was a folded
 * `-0.0`, and here it is simply that nothing may be substituted for `a`.
 */
export const nullifCall =
  <E>(a: (env: E) => unknown, b: (env: E) => unknown) =>
  (env: E): unknown => {
    const x = a(env);
    const y = b(env);

    return !isNullish(x) && !isNullish(y) && structuralEq(x, y) ? null : (x ?? null);
  };

/**
 * The two-argument twin of [`unaryNumCall`] — `power`, `log`, `mod`, `atan2`.
 *
 * BOTH arguments are validated before the null short-circuit, exactly as `callScalar`'s
 * `binaryNum` branch does: a named numeric function faults on a non-numeric argument even
 * beside a null (`atan2(null, duration)` is a type error), where an arithmetic OPERATOR
 * would propagate the null first.
 */
export const binaryNumCall =
  <E>(f: (x: number, y: number) => number, a: (env: E) => unknown, b: (env: E) => unknown) =>
  (env: E): unknown => {
    const x = a(env);
    const y = b(env);
    const nx = isNullish(x) ? null : numArg(x);
    const ny = isNullish(y) ? null : numArg(y);

    return nx === null || ny === null ? null : f(nx, ny);
  };

/**
 * The names whose ONLY positional argument check is "position 0 must be a string" — no
 * numeric position, not polymorphic over a list. A specialized path can fold that one check
 * into its own closure and skip `assertScalarArgTypes` entirely; `left`/`right`/`substring`
 * are excluded because they also check a numeric position, and `reverse`/`size`/
 * `cardinality` because their check accepts a list and raises a different message.
 *
 * DERIVED from the same tables the assert reads, like [`SCALAR_NEEDS_ARG_ASSERT`], so a new
 * position cannot leave it stale.
 */
export const SCALAR_ASSERTS_STR0_ONLY: ReadonlySet<string> = new Set(
  Object.keys(STR_ARG_POSITIONS).filter((n) => {
    const positions = STR_ARG_POSITIONS[n];

    return (
      positions.length === 1 &&
      positions[0] === 0 &&
      NUM_ARG_POSITIONS[n] === undefined &&
      !POLY_STR_LIST.has(n)
    );
  }),
);

/**
 * A one-argument STRING function with its argument step, resolved once per `Expr::Call`
 * (item 761) — the string twin of [`unaryNumCall`], and the reason it needs its own factory
 * rather than reusing that one: this family IS argument-checked by position, so the check
 * moves INTO the closure instead of being skipped.
 *
 * The message comes from `requiresStringMessage`, the ONE place it is spelled, so this path
 * and `assertScalarArgTypes` cannot drift — it is a cross-engine contract, matching native's
 * `call_scalar_checked`. (A first version duplicated the text here, and this comment claimed
 * a test pinned the two copies together. No such test existed; now there is one, and there is
 * also only one copy.)
 *
 * `str()` is not called: the type has just been proven to be `string`, and `str`'s fallback
 * for one is `String(v)`, which is identity on a primitive. The null check runs FIRST, which
 * is the same order the general path reaches — `assertScalarArgTypes` passes a nullish
 * argument through untouched and `callScalar` then short-circuits it to null.
 */
/**
 * The POLYMORPHIC string-or-list family — `size`, `cardinality`, `reverse` — with its body, so
 * `compileFunc` can resolve the dispatch once per `Expr::Call` (item 792).
 *
 * These three are the reason `SCALAR_NEEDS_ARG_ASSERT` exists in the first place: their positional
 * check is neither "a string at 0" nor "a number at 1" but "a string OR a list", with
 * `cardinality` also accepting a PATH. So neither the numeric gate nor `SCALAR_ASSERTS_STR0_ONLY`
 * can admit them, and all three sat on the general dispatch — where the TS survey
 * (`probe:scalar`) priced `size` at 42.0 ns a row against `char_length` at 19.9 for the SAME work,
 * the pair that isolates this engine's ~22 ns of dispatch machinery (item 790).
 *
 * Declared after `reverseScalar` because a `const` is not hoisted.
 */
export const POLY_STR_LIST_FN: Record<string, (a: unknown) => unknown> = {
  size: lengthOf,
  // `cardinality` ALSO accepts a path (nodes + edges count) — `size` does not. The arm is
  // `callScalar`'s own, unchanged.
  cardinality: (a) => (a instanceof Path ? a.vertices.length + a.edges.length : lengthOf(a)),
  reverse: reverseScalar,
};

/**
 * A one-argument POLYMORPHIC string-or-list call, with `assertScalarArgTypes`'s own check folded
 * in (item 792) — the third factory of this shape, after [`unaryStrCall`] (item 761) and the
 * two-argument [`binaryStrCall`] (item 769).
 *
 * The check is COPIED rather than referenced, in the same order and with the same message, because
 * it is a cross-engine contract: native's `call_scalar_checked` raises the same text and the
 * differential harness compares it. The `okPath` exception is `cardinality`'s alone.
 */
/**
 * The "a STRING at position 0, then NUMBERS" family — `left`, `right`, `substring` — with its
 * bodies, so `compileFunc` can resolve the dispatch once per `Expr::Call` (item 794).
 *
 * The last family on the general dispatch after items 788, 790, 791 and 792. `substring` takes an
 * optional third argument, so the table's functions are uniformly `(a, b, c)` and the factory
 * passes `undefined` for an absent one — which is exactly what `callScalar` passes today
 * (`args[2]`), so the bodies see no change.
 *
 * Declared after `substringScalar`, `leftScalar` and `rightScalar` because a `const` is not
 * hoisted.
 */
export const STR_NUM_FN: Record<string, (a: unknown, b: unknown, c: unknown) => unknown> = {
  left: (a, b) => leftScalar(a, b),
  right: (a, b) => rightScalar(a, b),
  substring: (a, b, c) => substringScalar(a, b, c),
};

/**
 * A call with a STRING at position 0 and NUMBERS after it, with `assertScalarArgTypes`'s two
 * positional checks folded in (item 794) — the fourth factory of this shape, after
 * [`unaryStrCall`] (761), [`binaryStrCall`] (769) and [`polyStrListCall`] (792).
 *
 * THE ORDER IS THE CONTRACT, not a detail — item 769's words for the same requirement. The assert
 * walks `STR_ARG_POSITIONS` before `NUM_ARG_POSITIONS`, so a call whose string argument AND numeric
 * argument are both wrong raises the STRING message; checking the number first would change the
 * error text, and that text is compared cross-engine.
 *
 * An `undefined` argument is skipped exactly as the assert skips it (`args[2]` of a two-argument
 * `substring`). A NULL is not: it passes the check and propagates through the body.
 */
export const strNumCall =
  <E>(
    name: string,
    f: (a: unknown, b: unknown, c: unknown) => unknown,
    a: (env: E) => unknown,
    b: (env: E) => unknown,
    c: ((env: E) => unknown) | undefined,
  ) =>
  (env: E): unknown => {
    const x = a(env);
    const y = b(env);
    const z = c === undefined ? undefined : c(env);

    if (!isNullish(x) && typeof x !== 'string') {
      dataException(requiresStringMessage(name));
    }

    if (!isNullish(y) && typeof y !== 'number') {
      dataException(`${name}() requires a number (a string is not coerced)`);
    }

    if (z !== undefined && !isNullish(z) && typeof z !== 'number') {
      dataException(`${name}() requires a number (a string is not coerced)`);
    }

    return f(x, y, z);
  };

export const polyStrListCall =
  <E>(name: string, f: (a: unknown) => unknown, a: (env: E) => unknown) =>
  (env: E): unknown => {
    const v = a(env);
    // `cardinality` ALSO accepts a path — see `assertScalarArgTypes`, whose arm this mirrors.
    const okPath = name === 'cardinality' && v instanceof Path;

    if (!isNullish(v) && typeof v !== 'string' && !Array.isArray(v) && !okPath) {
      dataException(`${name}() requires a string or list`);
    }

    return f(v);
  };

export const unaryStrCall =
  <E>(name: string, f: (s: string) => unknown, a: (env: E) => unknown) =>
  (env: E): unknown => {
    const v = a(env);

    if (isNullish(v)) {
      return null;
    }

    if (typeof v !== 'string') {
      dataException(requiresStringMessage(name));
    }

    return f(v as string);
  };

/**
 * The general scalar call, with ONE argument buffer reused across rows instead of a fresh
 * array per row (item 763). The native engine does the same thing in its `Expr::Call` arm and
 * says why: `n` allocations for a function that may do nothing with them.
 *
 * SAFE ONLY BECAUSE NOTHING RETAINS THE ARRAY, which was audited rather than assumed: every
 * use of `args` below `callScalar` indexes it (`args[0]`, `args[1]`, `args[2]`), destructures
 * it, or forwards it to `callTemporalFn` / `callStringListFn` / `callListSetFn`, which do the
 * same. `coalesce`'s `args.find` returns an ELEMENT. Nothing returns the array, stores it, or
 * closes over it. If a new arm ever does, this buffer becomes a use-after-free in slow motion:
 * the value handed back would be rewritten on the next row, and no test would see it, because
 * a single-row result looks right.
 *
 * Re-entrancy cannot alias it either: the buffer belongs to ONE compiled `Expr::Call`, and for
 * a nested call (`abs(power(x, 2))`) the inner node is a different node with its own buffer. A
 * node cannot appear inside its own argument subtree, so the same buffer is never being filled
 * twice at once.
 */
export const bufferedScalarCall = <E extends { graph: { limits: GraphLimits } }>(
  name: string,
  steps: readonly ((env: E) => unknown)[],
): ((env: E) => unknown) => {
  const n = steps.length;
  const buf: unknown[] = new Array(n);

  return (env: E): unknown => {
    for (let i = 0; i < n; i++) {
      buf[i] = steps[i](env);
    }

    return callScalar(name, buf, env.graph.limits);
  };
};

/**
 * Two-argument STRING functions, as plain `(s, sub) => unknown` — item 769 for the three
 * predicates, widened at item 773 to admit `split`, which has the same two asserted positions
 * and the same specialized closure but returns a LIST rather than a bool.
 *
 * `split`'s own body stays in `splitScalar`: the EMPTY-delimiter case yields one element per
 * UTF-16 unit through `fromUtf16UnitsLossy`, which is a cross-engine contract, so it is called
 * rather than re-spelled. The nullish and type checks `splitScalar` repeats are unreachable
 * from here — the closure has already proven both arguments are strings — and harmless.
 *
 * Measured at item 773, one shape per process: `count(split(a.s, '0'))` cost 127.74 ns a row
 * against a 15.44 floor, with the `s.split('0')` body itself 56 ns in a tight loop over the
 * same 200,000 strings. So ~50 ns was machinery, which is what this removes.
 */
export const BINARY_STR_FN: Record<string, (s: string, sub: string) => unknown> = {
  contains: (s, sub) => s.includes(sub),
  starts_with: (s, sub) => s.startsWith(sub),
  ends_with: (s, sub) => s.endsWith(sub),
  split: (s, sub) => splitScalar(s, sub),
};

/**
 * A two-argument string function with both argument steps, resolved once per `Expr::Call`
 * (item 769, widened at 773) — the two-argument twin of [`unaryStrCall`], and the TS
 * counterpart of item 766's native `eval_binary_str_pred`. `regex_match` is excluded: it
 * compiles or caches a regex rather than scanning, so it has a different cost profile.
 *
 * THE ORDER OF THE CHECKS IS THE WHOLE CONTRACT. `assertScalarArgTypes` validates BOTH
 * positions before `callStringPredicateFn` short-circuits on a nullish argument, so
 * `starts_with(null, 5)` THROWS — it does not return null. Checking nullishness first (which
 * reads more naturally and is one branch cheaper) would silently turn that data exception into
 * a null, and `starts_with(null, 'a')` must still BE null. Both spellings are pinned by a test.
 */
export const binaryStrCall =
  <E>(
    name: string,
    f: (s: string, sub: string) => unknown,
    a: (env: E) => unknown,
    b: (env: E) => unknown,
  ) =>
  (env: E): unknown => {
    const x = a(env);
    const y = b(env);

    if (!isNullish(x) && typeof x !== 'string') {
      dataException(requiresStringMessage(name));
    }

    if (!isNullish(y) && typeof y !== 'string') {
      dataException(requiresStringMessage(name));
    }

    if (isNullish(x) || isNullish(y)) {
      return null;
    }

    return f(x as string, y as string);
  };
