import type { Predicate, UnaryFn } from './types.js';

const internalFilter = function* <T>(predicate: Predicate<T>, iterable: Iterable<T>): Iterable<T> {
  for (const iteration of iterable) {
    if (predicate(iteration)) {
      yield iteration;
    }
  }
};

export function filter<T>(predicate: Predicate<T>): UnaryFn<Iterable<T>>;
export function filter<T>(predicate: Predicate<T>, iterable: Iterable<T>): Iterable<T>;
export function filter<T>(
  predicate: Predicate<T>,
  iterable?: Iterable<T>,
): UnaryFn<Iterable<T>> | Iterable<T> {
  return iterable ? internalFilter(predicate, iterable) : (x0) => internalFilter(predicate, x0);
}

export const select = filter;
