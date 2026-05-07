import { type Boundary, boundary } from './boundary.js';
import type { Predicate, UnaryFn } from './types.js';

const internalEvery = <T>(predicate: Predicate<T>, iterable: Iterable<T>): boolean => {
  for (const iteration of iterable) {
    if (!predicate(iteration)) {
      return false;
    }
  }

  return true;
};

export function every<T>(predicate: Predicate<T>): Boundary<UnaryFn<Iterable<T>, boolean>>;
export function every<T>(predicate: Predicate<T>, iterable: Iterable<T>): boolean;
export function every<T>(predicate: Predicate<T>, iterable?: Iterable<T>) {
  return iterable
    ? internalEvery(predicate, iterable)
    : boundary((x0: Iterable<T>) => internalEvery(predicate, x0));
}
