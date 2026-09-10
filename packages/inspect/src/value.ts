// A cell value → its bare string form for a table (a string stays unquoted).
// `null` (a first-class stored value in lenke) renders as `null` so an empty
// cell — an absent property — stays visibly different.
export const plain = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  // No `bigint` case: the value model is float64-only (bigint is rejected at every write),
  // so a cell value is never a bigint.
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
};
