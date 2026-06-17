import { type Boundary, boundary } from './boundary.js';
import type { BinaryFn } from './types.js';

const internalReduce = <T, R>(reducer: BinaryFn<R, T, R>, initial: R, iterable: Iterable<T>): R => {
  let acc = initial;

  for (const item of iterable) {
    acc = reducer(acc, item);
  }

  return acc;
};

export function reduce<T, R>(
  reducer: BinaryFn<R, T, R>,
  initial: R,
): Boundary<(iterable: Iterable<T>) => R>;
export function reduce<T, R>(reducer: BinaryFn<R, T, R>, initial: R, iterable: Iterable<T>): R;
export function reduce<T, R>(reducer: BinaryFn<R, T, R>, initial: R, iterable?: Iterable<T>) {
  return iterable
    ? internalReduce(reducer, initial, iterable)
    : boundary((x0: Iterable<T>) => internalReduce(reducer, initial, x0));
}
