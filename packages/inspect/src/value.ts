// Property/cell value → string, in the two flavors the inspectors need.
//
// `plain` is for table cells (a bare string stays bare). `literal` is for
// element property bags, where a string is quoted so `{ name: "marko" }` reads
// unambiguously and `null` (a first-class stored value in lenke) is visible.

const scalar = (value: unknown): string | null => {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return '';
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  return null; // string / object — caller decides how to render
};

export const plain = (value: unknown): string => {
  const s = scalar(value);

  if (s !== null) {
    return s;
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
};

export const literal = (value: unknown): string => {
  const s = scalar(value);

  if (s !== null) {
    return s;
  }

  return JSON.stringify(value); // quotes strings and serializes lists/objects
};
