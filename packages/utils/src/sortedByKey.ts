/**
 * A shallow copy of `obj` with its own enumerable keys in sorted (ascending
 * code-unit) order. Used to canonicalize a property bag for serialization so
 * output is deterministic and byte-identical across engines regardless of the
 * order keys happened to be inserted. Values are copied by reference.
 */
export const sortedByKey = <V>(obj: Record<string, V>): Record<string, V> => {
  const out: Record<string, V> = {};

  for (const key of Object.keys(obj).sort()) {
    out[key] = obj[key]!;
  }

  return out;
};
