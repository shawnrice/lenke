import type { NumberPredicate } from './types';

export const lt =
  <D extends number>(x: D): NumberPredicate<D> =>
  y =>
    y < x;
