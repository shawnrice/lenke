import { type Boundary, boundary } from './boundary.js';

type SortKey = number | string | bigint;

const compare = <K extends SortKey>(a: K, b: K): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

const internalSortBy = <T, K extends SortKey>(keyFn: (x: T) => K, iterable: Iterable<T>): T[] =>
  [...iterable].sort((a, b) => compare(keyFn(a), keyFn(b)));

export function sortBy<T, K extends SortKey>(
  keyFn: (x: T) => K,
): Boundary<(iterable: Iterable<T>) => T[]>;
export function sortBy<T, K extends SortKey>(keyFn: (x: T) => K, iterable: Iterable<T>): T[];
export function sortBy<T, K extends SortKey>(keyFn: (x: T) => K, iterable?: Iterable<T>) {
  return iterable
    ? internalSortBy(keyFn, iterable)
    : boundary((x0: Iterable<T>) => internalSortBy(keyFn, x0));
}
