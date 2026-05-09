import { type Boundary, boundary } from './boundary.js';
import type { Predicate, UnaryFn } from './types.js';

const internalSome = <T>(predicate: Predicate<T>, iterable: Iterable<T>): boolean => {
  for (const iteration of iterable) {
    if (predicate(iteration)) {
      return true;
    }
  }
  return false;
};

export function some<T>(predicate: Predicate<T>): Boundary<UnaryFn<Iterable<T>, boolean>>;
export function some<T>(predicate: Predicate<T>, iterable: Iterable<T>): boolean;
export function some<T>(predicate: Predicate<T>, iterable?: Iterable<T>) {
  return iterable
    ? internalSome(predicate, iterable)
    : boundary((x0: Iterable<T>) => internalSome(predicate, x0));
}
