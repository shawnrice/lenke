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

/** Validate every label and property key of an element about to enter the graph. */
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
    }
  }
};
