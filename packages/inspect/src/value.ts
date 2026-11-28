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

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  /*
   * `JSON.stringify` IS NOT TOTAL, and this function's `: string` was a lie because of it
   * (item 2525). Three ways it fails on values the public `Row = Record<string, unknown>`
   * signature accepts:
   *
   *   - THROWS on a `bigint` ("cannot serialize BigInt");
   *   - THROWS on a cyclic structure ("cannot serialize cyclic structures");
   *   - returns `undefined`, NOT a string, for a function or a symbol — after which the caller
   *     crashed in `widths` with "undefined is not an object (evaluating 'cells[i].length')",
   *     a message pointing nowhere near the offending value.
   *
   * An earlier comment argued the bigint case away by REACHABILITY — "the value model is
   * float64-only (bigint is rejected at every write), so a cell value is never a bigint". True of
   * the WRITE path, and irrelevant here: `formatRows` accepts whatever a caller holds, graph or
   * not. (`numeric-model-f64` governs what may be STORED; rendering a bigint a caller passed in
   * endorses nothing.)
   *
   * A formatter is called to DISPLAY things, frequently while diagnosing something else, so
   * throwing replaces the information the caller came for. `String(value)` is total over all three
   * cases — `10n` -> "10", a cycle -> "[object Object]", `Symbol('s')` -> "Symbol(s)" — and `clip`
   * truncates anything long.
   */
  if (typeof value === 'bigint') {
    return `${value}`;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[function${value.name ? ` ${value.name}` : ''}]`;
  }

  try {
    /*
     * The `??` is UNREACHABLE as written, and deliberately kept (item 2525). `JSON.stringify`
     * returns `undefined` for exactly three inputs — `undefined`, a function, a symbol — and all
     * three are handled by branches above, so nothing reaching here can produce it. Verified by
     * mutation: removing this coalesce leaves all 25 tests passing, which makes it an EQUIVALENT
     * mutant rather than a coverage gap, so no test is added for it (item 2513's precedent: when a
     * neighbouring condition already covers a guard, state the invariant instead of inventing a
     * test that cannot fail).
     *
     * It stays because the invariant is one branch away from being broken: anything that adds a
     * type above, or narrows one, re-reaches this line, and a `: string` function returning
     * `undefined` crashes the caller in `widths` rather than here.
     */
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    /* A cyclic structure. `String(value)` would give `[object Object]`, which tells the reader
     * nothing; naming the reason is the point of a formatter. */
    return '[unserializable]';
  }
};
