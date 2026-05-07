import { type Boundary, boundary } from './boundary.js';
import type { UnaryFn } from './types.js';

const groupByInternal = <T, K>(keySelector: UnaryFn<T, K>, iterable: Iterable<T>): Map<K, T[]> => {
  const map = new Map<K, T[]>();
  for (const item of iterable) {
    const key = keySelector(item);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
};

export function groupBy<T, K>(
  keySelector: UnaryFn<T, K>,
): Boundary<UnaryFn<Iterable<T>, Map<K, T[]>>>;
export function groupBy<T, K>(keySelector: UnaryFn<T, K>, iterable: Iterable<T>): Map<K, T[]>;
export function groupBy<T, K>(keySelector: UnaryFn<T, K>, iterable?: Iterable<T>) {
  return iterable
    ? groupByInternal(keySelector, iterable)
    : boundary((x0: Iterable<T>) => groupByInternal(keySelector, x0));
}
