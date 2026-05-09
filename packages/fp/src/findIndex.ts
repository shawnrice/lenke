import { type Boundary, boundary } from './boundary.js';
import type { Predicate, UnaryFn } from './types.js';

const internalFindIndex = <T>(predicate: Predicate<T>, iterable: Iterable<T>): number => {
  let index = 0;
  for (const item of iterable) {
    if (predicate(item)) {
      return index;
    }
    index++;
  }
  return -1;
};

export function findIndex<T>(predicate: Predicate<T>): Boundary<UnaryFn<Iterable<T>, number>>;
export function findIndex<T>(predicate: Predicate<T>, iterable: Iterable<T>): number;
export function findIndex<T>(predicate: Predicate<T>, iterable?: Iterable<T>) {
  return iterable
    ? internalFindIndex(predicate, iterable)
    : boundary((x0: Iterable<T>) => internalFindIndex(predicate, x0));
}
