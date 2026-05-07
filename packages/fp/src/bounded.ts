import { type Boundary, boundary } from './boundary.js';
import { take } from './take.js';

/**
 * Wraps a boundary function so it only consumes the first `max` elements of
 * its input. Use to guard terminals (`count`, `sort`, `every`, etc.) against
 * infinite iterables.
 *
 * Only accepts functions marked with `boundary(...)` — this keeps the safety
 * convention enforced at the type level.
 *
 * @example
 * ```ts
 * const safeCount = bounded(count);
 * safeCount(naturals());           // returns 1_000_000, doesn't hang
 *
 * bounded(count, 100)(someStream); // tighter cap at the call site
 * ```
 */
export const bounded = <T, R>(
  fn: Boundary<(iterable: Iterable<T>) => R>,
  max = 1_000_000,
): Boundary<(iterable: Iterable<T>) => R> =>
  boundary((iterable: Iterable<T>) => fn(take(max, iterable)));
