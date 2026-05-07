import type { Predicate } from './ast.js';

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
export const regex = (value: string): Predicate => ({ op: 'regex', value });

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
    case 'gt':
      return (value as number | string) > pred.value;
    case 'gte':
      return (value as number | string) >= pred.value;
    case 'lt':
      return (value as number | string) < pred.value;
    case 'lte':
      return (value as number | string) <= pred.value;
    case 'between':
      return (value as number | string) >= pred.min && (value as number | string) < pred.max;
    case 'inside':
      return (value as number | string) > pred.min && (value as number | string) < pred.max;
    case 'outside':
      return (value as number | string) < pred.min || (value as number | string) > pred.max;
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
      return typeof value === 'string' && new RegExp(pred.value).test(value);
  }
};
