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

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return JSON.stringify(value);
};
