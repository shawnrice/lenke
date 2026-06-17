import { type Boundary, boundary } from './boundary.js';
import type { UnaryFn } from './types.js';

const keyByInternal = <T, K>(keySelector: UnaryFn<T, K>, iterable: Iterable<T>): Map<K, T> => {
  const map = new Map<K, T>();

  for (const item of iterable) {
    map.set(keySelector(item), item);
  }

  return map;
};

export function keyBy<T, K>(keySelector: UnaryFn<T, K>): Boundary<UnaryFn<Iterable<T>, Map<K, T>>>;
export function keyBy<T, K>(keySelector: UnaryFn<T, K>, iterable: Iterable<T>): Map<K, T>;
export function keyBy<T, K>(keySelector: UnaryFn<T, K>, iterable?: Iterable<T>) {
  return iterable
    ? keyByInternal(keySelector, iterable)
    : boundary((x0: Iterable<T>) => keyByInternal(keySelector, x0));
}
