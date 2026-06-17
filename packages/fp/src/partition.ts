import { type Boundary, boundary } from './boundary.js';
import type { Predicate, UnaryFn } from './types.js';

const internalPartition = <T>(predicate: Predicate<T>, iterable: Iterable<T>): [T[], T[]] => {
  const pass: T[] = [];
  const fail: T[] = [];

  for (const item of iterable) {
    (predicate(item) ? pass : fail).push(item);
  }

  return [pass, fail];
};

export function partition<T>(predicate: Predicate<T>): Boundary<UnaryFn<Iterable<T>, [T[], T[]]>>;
export function partition<T>(predicate: Predicate<T>, iterable: Iterable<T>): [T[], T[]];
export function partition<T>(predicate: Predicate<T>, iterable?: Iterable<T>) {
  return iterable
    ? internalPartition(predicate, iterable)
    : boundary((x0: Iterable<T>) => internalPartition(predicate, x0));
}
