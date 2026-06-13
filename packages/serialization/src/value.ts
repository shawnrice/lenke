/**
 * The core LPG property-value model: the vendor-neutral scalar set that the GQL
 * and Gremlin interfaces both share, plus lists of those scalars. Every codec
 * (PG-JSON, GraphSON, CSV, …) encodes and decodes exactly this model, so the
 * single source of truth for "what a property value may be" — and where richer
 * JS values lose information — lives here, not in each format.
 */
export type PropertyValue = string | boolean | number | null | readonly PropertyValue[];

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
export const normalizeValue = (value: unknown): PropertyValue => {
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
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  throw new TypeError(
    `Property value is outside the LPG model: ${Object.prototype.toString.call(value)}`,
  );
};

/** Normalize every value in a property bag. */
export const normalizeBag = (bag: Record<string, unknown>): Record<string, PropertyValue> => {
  const out: Record<string, PropertyValue> = {};
  for (const key of Object.keys(bag)) {
    out[key] = normalizeValue(bag[key]);
  }
  return out;
};
