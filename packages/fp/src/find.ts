import { type Boundary, boundary } from './boundary.js';
import type { Predicate, UnaryFn } from './types.js';

const internalFind = <T>(predicate: Predicate<T>, iterable: Iterable<T>): T | undefined => {
  for (const item of iterable) {
    if (predicate(item)) {
      return item;
    }
  }

  return undefined;
};

export function find<T>(predicate: Predicate<T>): Boundary<UnaryFn<Iterable<T>, T | undefined>>;
export function find<T>(predicate: Predicate<T>, iterable: Iterable<T>): T | undefined;
export function find<T>(predicate: Predicate<T>, iterable?: Iterable<T>) {
  return iterable
    ? internalFind(predicate, iterable)
    : boundary((x0: Iterable<T>) => internalFind(predicate, x0));
}
