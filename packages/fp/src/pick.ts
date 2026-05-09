import type { UnaryFn } from './types.js';

const internalPick = <TKeys extends keyof TSource, TSource extends object>(
  keys: TKeys[],
  object: TSource,
): Pick<TSource, TKeys> => {
  const result = {} as Pick<TSource, TKeys>;
  for (const key of keys) {
    result[key] = object[key];
  }
  return result;
};

export function pick<TSource extends object, TKeys extends keyof TSource>(
  keys: TKeys[],
): UnaryFn<TSource, Pick<TSource, TKeys>>;
export function pick<TSource extends object, TKeys extends keyof TSource>(
  keys: TKeys[],
  object: TSource,
): Pick<TSource, TKeys>;
export function pick<TSource extends object, TKeys extends keyof TSource>(
  keys: TKeys[],
  object?: TSource,
) {
  return object
    ? internalPick(keys, object)
    : (x0: TSource) => internalPick<TKeys, TSource>(keys, x0);
}
