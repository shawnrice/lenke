import type { UnaryFn } from './types.js';

export function* uniq<T>(iterable: Iterable<T>): Iterable<T> {
  const seen = new Set<T>();

  for (const item of iterable) {
    if (!seen.has(item)) {
      seen.add(item);

      yield item;
    }
  }
}

export function* uniqBy<T, K>(keySelector: UnaryFn<T, K>, iterable: Iterable<T>): Iterable<T> {
  const seen = new Set<K>();

  for (const item of iterable) {
    const key = keySelector(item);

    if (!seen.has(key)) {
      seen.add(key);

      yield item;
    }
  }
}
