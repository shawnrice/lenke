import type { BinaryFn } from './types.js';

const defaultComparator = <T>(a: T, b: T): boolean => a === b;

const MAX_ITERATIONS = 1_000_000;

/**
 * Compares two iterables element-wise. Guards against an accidental infinite iterator by
 * capping at {@link MAX_ITERATIONS} elements — but rather than silently returning `false`
 * (which would report two EQUAL sequences as unequal), it THROWS past the cap, so the caller
 * learns its input exceeded the supported length instead of getting a wrong answer.
 */
export function equals<T>(
  x: Iterable<T>,
  y: Iterable<T>,
  comparator?: BinaryFn<T, T, boolean>,
): boolean {
  const compare = comparator ?? defaultComparator;

  const y0 = y[Symbol.iterator]();

  let count = 0;

  for (const x1 of x) {
    const y1 = y0.next();

    if (y1.done) {
      return false;
    }

    if (!compare(x1, y1.value)) {
      return false;
    }

    if (++count > MAX_ITERATIONS) {
      // Past the guard cap: throw rather than silently returning `false` for what may be
      // two equal sequences (an accidental infinite iterator surfaces as a clear error).
      throw new RangeError(`equals: iterables exceed the ${MAX_ITERATIONS}-element comparison cap`);
    }
  }

  return y0.next().done ?? false;
}
