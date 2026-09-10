type TypedArray = ArrayBufferView & ArrayLike<number>;

const isTypedArray = (x: unknown): x is TypedArray =>
  // `ArrayBuffer.isView` is true for typed arrays AND DataView; DataView has no
  // `BYTES_PER_ELEMENT`, so the second check keeps only the ArrayLike<number> typed arrays.
  // (Returns a real boolean, not the `BYTES_PER_ELEMENT` number the old predicate leaked.)
  ArrayBuffer.isView(x) &&
  typeof (x as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 'number';

const isString = (x: unknown): x is string => {
  return typeof x === 'string' || x instanceof String;
};

export const isIndexed = <T>(x: unknown): x is Iterable<T> & { [key: number]: T; length: number } =>
  Array.isArray(x) || isTypedArray(x) || isString(x);

export const isIterable = <T>(x: unknown): x is Iterable<T> =>
  x != null && typeof (x as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';

export const wrapIndexedIterable = <T>(
  x: Iterable<T> & { [key: number]: T; length: number },
): Iterable<T> => ({
  [Symbol.iterator](): Iterator<T> {
    const { length } = x;
    let count = -1;

    return {
      next(): IteratorResult<T> {
        return ++count < length ? { value: x[count], done: false } : { value: void 0, done: true };
      },
    };
  },
});

export const maybeOptimizeIterable = <T>(x0: Iterable<T>): Iterable<T> =>
  isIndexed<T>(x0) ? wrapIndexedIterable(x0) : x0;
