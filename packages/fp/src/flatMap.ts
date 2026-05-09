import type { UnaryFn } from './types.js';

const internalFlatMap = function* <T, R>(
  mapper: UnaryFn<T, Iterable<R>>,
  iterable: Iterable<T>,
): Iterable<R> {
  for (const item of iterable) {
    yield* mapper(item);
  }
};

export function flatMap<T, R>(
  mapper: UnaryFn<T, Iterable<R>>,
): UnaryFn<Iterable<T>, Iterable<R>>;
export function flatMap<T, R>(mapper: UnaryFn<T, Iterable<R>>, iterable: Iterable<T>): Iterable<R>;
export function flatMap<T, R>(mapper: UnaryFn<T, Iterable<R>>, iterable?: Iterable<T>) {
  return iterable
    ? internalFlatMap(mapper, iterable)
    : (x0: Iterable<T>) => internalFlatMap(mapper, x0);
}
