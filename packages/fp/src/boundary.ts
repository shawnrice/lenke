declare const BOUNDARY: unique symbol;

/**
 * Marks an iterable-consuming function as a "boundary" — i.e., one that fully
 * materializes its input and so will hang on an infinite iterable. The brand
 * is type-only; at runtime the value is unchanged.
 *
 * Wrap any terminal you author with `boundary(...)` so that `bounded` (and
 * future tooling) can recognize it.
 *
 * @example
 * ```ts
 * export const count = boundary(<T>(iterable: Iterable<T>): number => {
 *   // ...
 * });
 * ```
 */
export type Boundary<F extends (iterable: Iterable<any>) => any> = F & {
  readonly [BOUNDARY]: true;
};

export const boundary = <F extends (iterable: Iterable<any>) => any>(fn: F): Boundary<F> =>
  fn as Boundary<F>;
