import { boundary } from './boundary.js';

type IterableWithLength<T> = Iterable<T> & { length: number };
type IterableWithSize<T> = Iterable<T> & { size: number };

/**
 * Counts an iterable. Materializes the input — pair with `take` (or wrap with
 * `bounded`) if the source may be infinite.
 */
export const count = boundary(<T>(iterable: Iterable<T>): number => {
  if (
    'length' in iterable &&
    typeof (iterable as Iterable<T> & { length: unknown }).length === 'number'
  ) {
    return (iterable as IterableWithLength<T>).length;
  }

  if (
    'size' in iterable &&
    typeof (iterable as Iterable<T> & { size: unknown }).size === 'number'
  ) {
    return (iterable as IterableWithSize<T>).size;
  }

  let i = 0;

  for (const _ of iterable) {
    i++;
  }

  return i;
});
