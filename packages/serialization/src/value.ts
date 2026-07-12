/**
 * The core LPG property-value model: the vendor-neutral scalar set that the GQL
 * and Gremlin interfaces both share, plus lists of those scalars. Every codec
 * (PG-JSON, GraphSON, CSV, …) encodes and decodes exactly this model, so the
 * single source of truth for "what a property value may be" — and where richer
 * JS values lose information — lives here, not in each format.
 */
import { coerceTemporal, fromTaggedJson, type Temporal } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

export type PropertyValue = string | boolean | number | null | Temporal | readonly PropertyValue[];

/** A property bag on a vertex or edge in the LPG model. */
export type PropertyBag = Readonly<Record<string, PropertyValue>>;

/**
 * Coerce an arbitrary JS value into the LPG `PropertyValue` model. This is the
 * one place lossiness is defined:
 *   - `undefined`            → `null`
 *   - `NaN` / `±Infinity`    → `null` (not representable across formats)
 *   - `bigint`               → `number` (may lose precision above 2^53; core is float64)
 *   - arrays                 → each element normalized recursively
 *   - objects / Date / Map / Set / functions / symbols → throw (not LPG scalars)
 *
 * Codecs call this at the boundary so out-of-model values fail loudly rather
 * than silently producing a non-round-trippable document.
 */
/**
 * Maximum list-nesting depth. Bounds recursion so an adversarial deeply-nested
 * array cannot exhaust the stack; mirrors the Rust JSON decoders, which serde
 * caps at 128 levels during parsing.
 */
const MAX_NESTING = 128;

const normalizeAt = (value: unknown, depth: number): PropertyValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'undefined') {
    return null;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  // A lenke temporal instance passes through; a TC39 `Temporal.PlainDate`/
  // `PlainDateTime`/`Duration` is coerced via its ISO string (no hard dep on the
  // Temporal proposal — it's duck-typed).
  const temporal = coerceTemporal(value);

  if (temporal) {
    return temporal;
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_NESTING) {
      throw new LenkeError('Property value nesting exceeds the maximum depth', {
        code: ErrorCode.InvalidShape,
      });
    }

    return value.map((v) => normalizeAt(v, depth + 1));
  }

  // A tagged temporal object `{"@date":"…"}` (from a decoded JSON codec) revives
  // to its instance.
  const revived = fromTaggedJson(value);

  if (revived) {
    return revived;
  }

  // A native `Date` is a zoned instant; lenke's temporal types are zone-less, so
  // silently coercing would have to guess a timezone (a data-corruption footgun).
  // Require the user to name the interpretation.
  if (value instanceof Date) {
    throw new LenkeError(
      'A native `Date` is a zoned instant, but lenke temporal types are zone-less. ' +
        'Convert explicitly with `LocalDateTime.fromJSDate(date, { zone })` (or `LocalDate.fromJSDate`), ' +
        'or pass an ISO string / a TC39 `Temporal.PlainDateTime`.',
      { code: ErrorCode.InvalidValue },
    );
  }

  throw new LenkeError(
    `Property value is outside the LPG model: ${Object.prototype.toString.call(value)}`,
    { code: ErrorCode.InvalidValue },
  );
};

export const normalizeValue = (value: unknown): PropertyValue => normalizeAt(value, 0);

/** Normalize every value in a property bag. */
export const normalizeBag = (bag: Record<string, unknown>): Record<string, PropertyValue> => {
  const out: Record<string, PropertyValue> = {};

  for (const key of Object.keys(bag)) {
    out[key] = normalizeValue(bag[key]);
  }

  return out;
};
