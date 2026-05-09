import { type Boundary, boundary } from './boundary.js';
import type { SortFn } from './types.js';

const internalSort = <T>(sorter: SortFn<T>, iterable: Iterable<T>): T[] =>
  [...iterable].sort(sorter);

export function sort<T>(sorter: SortFn<T>): Boundary<(iterable: Iterable<T>) => T[]>;
export function sort<T>(sorter: SortFn<T>, iterable: Iterable<T>): T[];
export function sort<T>(sorter: SortFn<T>, iterable?: Iterable<T>) {
  return iterable
    ? internalSort(sorter, iterable)
    : boundary((x0: Iterable<T>) => internalSort(sorter, x0));
}
