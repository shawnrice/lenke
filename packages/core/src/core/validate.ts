import { ErrorCode, LenkeError } from '@lenke/errors';

/**
 * A well-formed **label** (node label / edge type): non-empty and free of the
 * `::` sequence. GraphSON joins a node's labels with `::`, so a `::` inside one
 * label is ambiguous there (and bare GQL can't name it); an empty label
 * collapses to "no labels" in GraphSON/CSV. Enforced at the graph's mutation
 * boundary so a name that won't round-trip can't enter the model. Mirrors the
 * Rust core's `validate_label`.
 */
export const validateLabel = (label: string): void => {
  if (label === '') {
    throw new LenkeError('a label / edge type must be non-empty', { code: ErrorCode.InvalidValue });
  }

  if (label.includes('::')) {
    throw new LenkeError(
      `a label / edge type cannot contain '::' (the GraphSON multi-label separator): ${JSON.stringify(label)}`,
      { code: ErrorCode.InvalidValue },
    );
  }
};

/**
 * A well-formed **property key**: non-empty (an empty key has no CSV column
 * header / pg-text `key:value` form). Mirrors the Rust core's `validate_prop_key`.
 */
export const validatePropertyKey = (key: string): void => {
  if (key === '') {
    throw new LenkeError('a property key must be non-empty', { code: ErrorCode.InvalidValue });
  }
};

/**
 * A well-formed **property value**. The LPG numeric type is float64 (the Rust
 * core has no bigint; every codec + the FFI param boundary would coerce a bigint
 * to a number, losing precision above 2^53). So a JS `bigint` is rejected at the
 * mutation boundary rather than silently downgraded — pass `Number(x)` for a
 * safe-range value, or a string. Recurses into list elements so a bigint can't
 * hide inside an array. (`NaN`/`Infinity`/`undefined` are *coerced* to null by
 * the codec layer, not rejected here — those are JS non-values with no exact
 * representation; a bigint is a deliberate, present value whose exactness matters.)
 *
 * The param + FFI boundaries already reject bigint with the same code; this
 * closes the pure-JS in-process store, the one path that stored it raw. No Rust
 * mirror is needed — `bigint` is a JS-only type that cannot reach the core.
 */
export const validatePropertyValue = (value: unknown): void => {
  if (typeof value === 'bigint') {
    throw new LenkeError(
      `a bigint property value is not supported: the numeric model is float64 — ` +
        `pass Number(${value}n) for a safe-range value, or a string`,
      { code: ErrorCode.InvalidValue },
    );
  }

  if (Array.isArray(value)) {
    for (const element of value) {
      validatePropertyValue(element);
    }
  }
};

/** Validate every label, property key, and property value about to enter the graph. */
export const validateElementNames = (
  labels: Iterable<string>,
  properties: Readonly<Record<string, unknown>> | undefined,
): void => {
  for (const label of labels) {
    validateLabel(label);
  }

  if (properties) {
    for (const key of Object.keys(properties)) {
      validatePropertyKey(key);
      validatePropertyValue(properties[key]);
    }
  }
};
