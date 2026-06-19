import { ErrorCode, PlGraphError } from '@pl-graph/errors';

import type { Predicate } from './ast.js';

const typeName = (v: unknown): string => {
  if (v === null || v === undefined) {
    return 'null';
  }

  if (Array.isArray(v)) {
    return 'a list';
  }

  return typeof v === 'object' ? 'an element' : typeof v;
};

const cmpOrd = (x: number | string, y: number | string): number => {
  if (x < y) {
    return -1;
  }

  return x > y ? 1 : 0;
};

/**
 * Order two values the way TinkerPop's `Comparable` does: numbers with numbers,
 * strings with strings, booleans with booleans. Comparing genuinely
 * incomparable types — a number with a string, an element with a scalar —
 * throws (mirroring TinkerPop's `ClassCastException`) rather than coercing to a
 * misleading boolean. Returns a negative / zero / positive number.
 */
export const compareValues = (a: unknown, b: unknown): number => {
  if (typeof a === 'number' && typeof b === 'number') {
    return cmpOrd(a, b);
  }

  if (typeof a === 'string' && typeof b === 'string') {
    return cmpOrd(a, b);
  }

  if (typeof a === 'boolean' && typeof b === 'boolean') {
    if (a === b) {
      return 0;
    }

    return a ? 1 : -1;
  }

  throw new PlGraphError(`cannot order ${typeName(a)} with ${typeName(b)}`, {
    code: ErrorCode.InvalidValue,
  });
};

// Compile each regex pattern once (the predicate is re-applied per value). The
// pattern is validated at build time in `regex()`, so this never throws here.
// NB: JS `RegExp` is backtracking, so a pathological pattern over a long input
// can still be slow (ReDoS) — the same exposure as TinkerPop's Java `Pattern`.
// There's no native regex timeout in JS; the mitigation is to not run untrusted
// patterns, so we don't reject patterns TinkerPop would accept.
const regexCache = new Map<string, RegExp>();
const compiledRegex = (pattern: string): RegExp => {
  let re = regexCache.get(pattern);

  if (!re) {
    if (regexCache.size >= 1000) {
      regexCache.clear(); // bound memory; patterns are typically few
    }

    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }

  return re;
};

export const eq = (value: unknown): Predicate => ({ op: 'eq', value });
export const neq = (value: unknown): Predicate => ({ op: 'neq', value });
export const gt = (value: number | string): Predicate => ({ op: 'gt', value });
export const gte = (value: number | string): Predicate => ({ op: 'gte', value });
export const lt = (value: number | string): Predicate => ({ op: 'lt', value });
export const lte = (value: number | string): Predicate => ({ op: 'lte', value });
// Half-open [min, max). Matches Gremlin's `P.between` semantics.
export const between = (min: number | string, max: number | string): Predicate => ({
  op: 'between',
  min,
  max,
});

// Strict open (min, max). Matches Gremlin's `P.inside`.
export const inside = (min: number | string, max: number | string): Predicate => ({
  op: 'inside',
  min,
  max,
});

// Strict complement: value < min OR value > max. Matches `P.outside`.
export const outside = (min: number | string, max: number | string): Predicate => ({
  op: 'outside',
  min,
  max,
});
export const within = (...values: readonly unknown[]): Predicate => ({ op: 'within', values });
export const without = (...values: readonly unknown[]): Predicate => ({ op: 'without', values });
export const startsWith = (value: string): Predicate => ({ op: 'startsWith', value });
// TextP-style string predicates.
export const endingWith = (value: string): Predicate => ({ op: 'endingWith', value });
export const containing = (value: string): Predicate => ({ op: 'containing', value });
export const notContaining = (value: string): Predicate => ({ op: 'notContaining', value });
export const regex = (value: string): Predicate => {
  // Validate the pattern up front so an invalid regex is a clean build-time
  // error rather than an unwrapped `SyntaxError` thrown mid-stream per value.
  try {
    void new RegExp(value);
  } catch (cause) {
    throw new PlGraphError(`regex(): invalid pattern ${JSON.stringify(value)}`, {
      code: ErrorCode.Syntax,
      cause,
    });
  }

  return { op: 'regex', value };
};

/**
 * Evaluate a predicate against a value. Used by executors; not part of the
 * AST surface.
 */
export const matches = (pred: Predicate, value: unknown): boolean => {
  switch (pred.op) {
    case 'eq':
      return value === pred.value;
    case 'neq':
      return value !== pred.value;
    // Ordering predicates: a missing value is filtered out (false), not an
    // error; a present-but-incomparable value throws via `compareValues`.
    case 'gt':
      return value != null && compareValues(value, pred.value) > 0;
    case 'gte':
      return value != null && compareValues(value, pred.value) >= 0;
    case 'lt':
      return value != null && compareValues(value, pred.value) < 0;
    case 'lte':
      return value != null && compareValues(value, pred.value) <= 0;
    case 'between':
      return (
        value != null && compareValues(value, pred.min) >= 0 && compareValues(value, pred.max) < 0
      );
    case 'inside':
      return (
        value != null && compareValues(value, pred.min) > 0 && compareValues(value, pred.max) < 0
      );
    case 'outside':
      return (
        value != null && (compareValues(value, pred.min) < 0 || compareValues(value, pred.max) > 0)
      );
    case 'within':
      return pred.values.includes(value);
    case 'without':
      return !pred.values.includes(value);
    case 'startsWith':
      return typeof value === 'string' && value.startsWith(pred.value);
    case 'endingWith':
      return typeof value === 'string' && value.endsWith(pred.value);
    case 'containing':
      return typeof value === 'string' && value.includes(pred.value);
    case 'notContaining':
      return typeof value === 'string' && !value.includes(pred.value);
    case 'regex':
      return typeof value === 'string' && compiledRegex(pred.value).test(value);
    case 'not':
      return !matches(pred.predicate, value);
  }
};
