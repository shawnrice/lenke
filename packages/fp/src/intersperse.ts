import type { UnaryFn } from './types.js';

/**
 * Inserts a separator between each item in the iterable.
 *
 * @example
 * ```ts
 * const result = intersperse(0, [1, 2, 3]);
 * // [1, 0, 2, 0, 3]
 * ```
 */
const internalIntersperse = function* <T>(separator: T, iterable: Iterable<T>): Iterable<T> {
  let first = true;

  for (const item of iterable) {
    if (!first) {
      yield separator;
    }

    first = false;

    yield item;
  }
};
export function intersperse<T>(separator: T): UnaryFn<Iterable<T>, Iterable<T>>;
export function intersperse<T>(separator: T, iterable: Iterable<T>): Iterable<T>;
export function intersperse<T>(
  separator: T,
  iterable?: Iterable<T>,
): UnaryFn<Iterable<T>, Iterable<T>> | Iterable<T> {
  return iterable
    ? internalIntersperse(separator, iterable)
    : (x0: Iterable<T>) => internalIntersperse(separator, x0);
}
