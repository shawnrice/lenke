/**
 * Creates an iterable of numbers from start to end.
 *
 * @example
 * ```ts
 * const result = range();
 * // [0, 1, 2, ... Infinity]
 * ```
 *
 * @example
 * ```ts
 * const result = range(1, 10);
 * // [1, 2, 3, 4, 5, 6, 7, 8, 9]
 * ```
 * @example
 * ```ts
 * const result = range(10, 1);
 * // [10, 9, 8, 7, 6, 5, 4, 3, 2]
 * ```
 * @example
 * ```ts
 * const result = range(10);
 * // [10, 11, 12, ... Infinity]
 * ```
 * @param start - The inclusive start of the range.
 * @param end - The exclusive end of the range.
 * @param step - The size step
 * @returns An iterable of numbers from start to end.
 */
export function* range(start = 0, end = Infinity, step = 1): Iterable<number> {
  if (start === end) {
    return;
  }

  if (start > end) {
    for (let i = start; i > end; i -= step) {
      yield i;
    }
    return;
  }

  for (let i = start; i < end; i += step) {
    yield i;
  }
}
