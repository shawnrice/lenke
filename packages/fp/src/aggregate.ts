import { type Boundary, boundary } from './boundary.js';
import type { UnaryFn } from './types.js';

export const sum = boundary((iterable: Iterable<number>): number => {
  let s = 0;

  for (const n of iterable) {
    s += n;
  }

  return s;
});

export const min = boundary((iterable: Iterable<number>): number | undefined => {
  let m: number | undefined;

  for (const n of iterable) {
    m = m === undefined || n < m ? n : m;
  }

  return m;
});

export const max = boundary((iterable: Iterable<number>): number | undefined => {
  let m: number | undefined;

  for (const n of iterable) {
    m = m === undefined || n > m ? n : m;
  }

  return m;
});

export const mean = boundary((iterable: Iterable<number>): number | undefined => {
  let s = 0;
  let c = 0;

  for (const n of iterable) {
    s += n;
    c++;
  }

  return c ? s / c : undefined;
});

const internalSumBy = <T>(selector: UnaryFn<T, number>, iterable: Iterable<T>): number => {
  let s = 0;

  for (const x of iterable) {
    s += selector(x);
  }

  return s;
};

const internalMinBy = <T>(selector: UnaryFn<T, number>, iterable: Iterable<T>): T | undefined => {
  let bestValue: number | undefined;
  let bestItem: T | undefined;

  for (const x of iterable) {
    const v = selector(x);

    if (bestValue === undefined || v < bestValue) {
      bestValue = v;
      bestItem = x;
    }
  }

  return bestItem;
};

const internalMaxBy = <T>(selector: UnaryFn<T, number>, iterable: Iterable<T>): T | undefined => {
  let bestValue: number | undefined;
  let bestItem: T | undefined;

  for (const x of iterable) {
    const v = selector(x);

    if (bestValue === undefined || v > bestValue) {
      bestValue = v;
      bestItem = x;
    }
  }

  return bestItem;
};

export function sumBy<T>(selector: UnaryFn<T, number>): Boundary<UnaryFn<Iterable<T>, number>>;
export function sumBy<T>(selector: UnaryFn<T, number>, iterable: Iterable<T>): number;
export function sumBy<T>(selector: UnaryFn<T, number>, iterable?: Iterable<T>) {
  return iterable
    ? internalSumBy(selector, iterable)
    : boundary((x0: Iterable<T>) => internalSumBy(selector, x0));
}

export function minBy<T>(
  selector: UnaryFn<T, number>,
): Boundary<UnaryFn<Iterable<T>, T | undefined>>;
export function minBy<T>(selector: UnaryFn<T, number>, iterable: Iterable<T>): T | undefined;
export function minBy<T>(selector: UnaryFn<T, number>, iterable?: Iterable<T>) {
  return iterable
    ? internalMinBy(selector, iterable)
    : boundary((x0: Iterable<T>) => internalMinBy(selector, x0));
}

export function maxBy<T>(
  selector: UnaryFn<T, number>,
): Boundary<UnaryFn<Iterable<T>, T | undefined>>;
export function maxBy<T>(selector: UnaryFn<T, number>, iterable: Iterable<T>): T | undefined;
export function maxBy<T>(selector: UnaryFn<T, number>, iterable?: Iterable<T>) {
  return iterable
    ? internalMaxBy(selector, iterable)
    : boundary((x0: Iterable<T>) => internalMaxBy(selector, x0));
}
