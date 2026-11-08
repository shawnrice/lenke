/**
 * VALUE IDENTITY AND THE TOTAL ORDER: what counts as an element, and how two values compare.
 *
 * ⚠️ A LEAF WITH NO IMPORTS AT ALL, which is why it exists as a module (item 1666). `scalars.ts`
 * needed exactly four symbols back from `core.ts` — `compareSort`, `isEdge`, `isElement`,
 * `isVertex` — and that single back-edge was the whole of the long-standing `core <-> scalars`
 * import cycle. Moving them down here removes it. It also removed a THREE-module cycle that
 * extracting `expr-analysis.ts` had just created (`expr-analysis -> scalars -> core ->
 * expr-analysis`), which `import/no-cycle` caught on the day the rule was added.
 *
 * ⚠️ `compareSort` IS NOT `compareValues`, AND CONFLATING THEM IS A BYTE-IDENTITY BUG. Predicates
 * keep NaN JS-unordered; sorting, `min` and `max` need a TOTAL order, so `compareSort` places NaN
 * last and treats `NaN === NaN`. Both engines must agree on the sort key or snapshots diverge, so
 * the two live side by side here with this note between them rather than in separate files where
 * one could be "fixed" to match the other.
 */

import {
  LenkeRecord,
  isEdgeShaped,
  isTemporal,
  isVertexShaped,
  temporalCmpTotal,
} from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';

/** A coarse type ordering so ORDER BY/min/max have a *total* order across types. */
export const typeRank = (v: unknown): number => {
  switch (typeof v) {
    case 'number':
      return 0;
    case 'string':
      return 1;
    case 'boolean':
      return 2;
    default:
      // Num < Str < Bool < Temporal < List < Record < Map < Null — the SAME cross-type
      // total order as the native engine's `Value::rank`, so `list_sort`/ORDER BY/min/max
      // over a mixed-compound column agree (e.g. a list sorts before a map).
      if (isTemporal(v)) {
        return 3;
      }

      if (Array.isArray(v)) {
        return 4;
      }

      return v instanceof LenkeRecord ? 5 : 6; // Record, then Map / plain object
  }
};
/**
 * Compare two values for ORDER BY; nulls sort last. Values of different types
 * are ordered by a fixed type rank first (number < string < boolean < other),
 * so a column mixing types has a deterministic total order rather than the
 * unstable result of raw JS `<` across types.
 */
export const compareValues = (a: unknown, b: unknown): number => {
  if (isNullish(a) && isNullish(b)) {
    return 0;
  }

  if (isNullish(a)) {
    return 1;
  }

  if (isNullish(b)) {
    return -1;
  }

  const ra = typeRank(a);
  const rb = typeRank(b);

  if (ra !== rb) {
    return ra < rb ? -1 : 1;
  }

  // Temporals (same rank) compare by the deterministic total order (date/datetime
  // chronological, duration lexicographic) — mirrors the Rust `cmp_total`.
  if (isTemporal(a) && isTemporal(b)) {
    return temporalCmpTotal(a, b);
  }

  // Lists compare element-wise (lexicographic, shorter-is-less on a prefix),
  // recursing through the same order — mirrors the Rust `cmp_total`. Without this
  // they'd fall to `x < y`, which coerces arrays to strings (`[10] < [9]`), so
  // `min`/`max` and `ORDER BY` over lists would diverge from the native engine.
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);

    for (let i = 0; i < n; i++) {
      const c = compareValues(a[i], b[i]);

      if (c !== 0) {
        return c;
      }
    }

    if (a.length < b.length) {
      return -1;
    }

    return a.length > b.length ? 1 : 0;
  }

  // Records: keys are canonical (sorted), so compare field-by-field (key then
  // value), shorter-is-less — a total order for ORDER BY/DISTINCT even though ISO
  // defines no relational `<`/`>` on records. Mirrors the Rust `cmp_total`.
  if (a instanceof LenkeRecord && b instanceof LenkeRecord) {
    const ae = [...a];
    const be = [...b];
    const n = Math.min(ae.length, be.length);

    for (let i = 0; i < n; i++) {
      const kc = cmpKey(ae[i][0], be[i][0]);

      if (kc !== 0) {
        return kc;
      }

      const vc = compareValues(ae[i][1], be[i][1]);

      if (vc !== 0) {
        return vc;
      }
    }

    if (ae.length < be.length) {
      return -1;
    }

    return ae.length > be.length ? 1 : 0;
  }

  // Rank 4 is the catch-all group (graph elements, plus any list/record pair the
  // branches above did not match — a list vs a record). The native `cmp_total`
  // returns Equal for all of those, leaving them in stable order. Falling through
  // to `<` would order them by their JS string coercions ("1,2" vs "[object Map]"),
  // an accidental order the native engine does not have.
  if (ra === 4) {
    return 0;
  }

  const x = a as number | string;
  const y = b as number | string;

  // Strings compare by Unicode code point (matching Rust str::cmp), not JS's
  // UTF-16 code-unit order — see compareCodePoints.
  if (typeof x === 'string' && typeof y === 'string') {
    return compareCodePoints(x, y);
  }

  // NaN is the GREATEST value and equals itself. Not an absolute-last like null:
  // it is an ordinary member of the total order sitting at the top, so DESC puts
  // it first and `max()` keeps it — Java's `Double.compareTo` and SQL's float
  // order. Mirrors the Rust `cmp_total`.
  //
  // Without this, both `x < y` and `x > y` are false and the fallthrough returns
  // 0, making the comparator NON-total. We own the comparator but not the sort
  // ALGORITHM (V8 `Array.sort` is not Rust's `slice::sort_by`), so that let the
  // algorithm leak: `RETURN sqrt(n.m) AS v ORDER BY v DESC` returned
  // `null, 3, 2, null` here against `NaN, 2, NaN, 3` in native, for the same
  // input. Every other type in this function already commits to a total order;
  // numbers were the one that fell through.
  //
  // Reachable through a projection (`sqrt(-1)`), not through storage: a stored
  // non-finite is coerced to null at the write.
  if (typeof x === 'number' && typeof y === 'number') {
    const xNaN = Number.isNaN(x);
    const yNaN = Number.isNaN(y);

    if (xNaN || yNaN) {
      if (xNaN && yNaN) {
        return 0;
      }

      return xNaN ? 1 : -1;
    }
  }

  if (x < y) {
    return -1;
  }

  return x > y ? 1 : 0;
};
/**
 * Compare two ORDER BY keys, honoring direction and ISO `NULLS FIRST/LAST`. Null
 * placement is absolute (first or last in the final order), independent of the
 * direction applied to non-null values. With no explicit null ordering, nulls
 * sort LAST (ISO GQL leaves the default unspecified, so we pin one for
 * cross-engine determinism — the Rust `compare_sort` matches).
 */
export const compareSort = (
  a: unknown,
  b: unknown,
  descending: boolean,
  nullsFirst: boolean | undefined,
): number => {
  const aNull = isNullish(a);
  const bNull = isNullish(b);

  if (aNull && bNull) {
    return 0;
  }

  if (aNull || bNull) {
    const first = nullsFirst ?? false;

    return aNull === first ? -1 : 1;
  }

  return compareValues(a, b) * (descending ? -1 : 1);
};
export const isEdge = (v: unknown): v is Edge => isEdgeShaped(v);
export const isElement = (v: unknown): v is Vertex | Edge =>
  typeof v === 'object' && v !== null && 'id' in v;
// The structural guards live in `@lenke/core`: both engines ask this question of
// the values in their streams, and it has to have ONE answer. This used to read
// "an element that is not an edge", which called `{id, from}` with no `to` a
// vertex where the Gremlin engine did not.
export const isVertex = (v: unknown): v is Vertex => isVertexShaped(v);

// Statement execution: writes, clause processing, set ops (see executor/clauses.ts).

/**
 * ⚠️ MOVED DOWN FROM `scalars.ts` (item 1666). `compareValues` needs all three, and while
 * they lived in `scalars.ts` this module imported that one while that one imported
 * `compareSort` back — a cycle `import/no-cycle` reported the moment the module was created.
 * They are value-comparison primitives, so this is where they belonged anyway: the cycle was
 * the symptom, not the reason.
 */
export const isNullish = (v: unknown): boolean => v === null || v === undefined;
/** Lexicographic compare of two field-name strings (matches the native key sort). */
export const cmpKey = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }

  return a > b ? 1 : 0;
};
const HAS_SURROGATE = /[\uD800-\uDBFF]/;
/**
 * Compare two strings by Unicode CODE POINT, matching Rust `str::cmp` (UTF-8 byte
 * order == code-point order). JS `<`/`>` order by UTF-16 code UNIT, which disagrees
 * when an astral char (surrogate pair, ≥ U+10000) meets a BMP char in U+E000..U+FFFF:
 * the high surrogate (0xD800..0xDBFF) sorts BELOW U+E000 by code unit, but the astral
 * code point sorts ABOVE it. Iterating code points (via `codePointAt` + a 1-or-2 unit
 * step, allocation-free) makes both engines agree. Fast path: with no surrogate in
 * either string every char is BMP, so UTF-16 order already equals code-point order and
 * the native compare (much faster than a per-char loop) is exact.
 */
/*
 * REJECTED, with numbers — two cheaper GUARDS and one hoist (item 921). A CPU profile of a
 * sorted-page query put the regex below at 6.9% of the profile and this function at another 8.0%,
 * and the guard scans BOTH WHOLE STRINGS on EVERY comparison, re-establishing a per-string fact
 * O(log N) times during a sort. Three arms, measured in `packages/native/codepoint-guard-probe.mjs`
 * (floor = the bare native compare, which no guard can beat):
 *
 *     data        floor      ref     scan    ref/scan
 *     ascii         0.8      2.1      1.9       1.08x
 *     prefixed      1.2      2.7      9.5       0.28x
 *     astral        0.9      3.2      1.7       1.95x
 *
 *   - replacing the regex with a manual charCode loop (`scan`): REFUTED. 1.08x on ASCII is inside
 *     the ~10% noise band, and on keys with a long shared prefix it is 3.6x WORSE. V8's
 *     character-class match beats a hand-written loop, so THE REGEX IS THE RIGHT TOOL here.
 *   - deciding from the first differing code UNIT (`diff`): REFUTED ON CORRECTNESS, premise and
 *     all. Equal unit prefixes do NOT imply equal code-POINT prefixes, because segmentation
 *     depends on the FOLLOWING unit: the same high surrogate can begin a pair in one string and be
 *     LONE in the other, so `"\ud83d\ude00"` and `"\ud83d\ue000"` agree on unit 0 and disagree
 *     on what it means. Making it correct needs both strings proven free of lone surrogates, which
 *     is the whole-string scan it existed to avoid.
 *   - hoisting the guard OUT of the comparator so a sort tests each key once: SOUND but DECLINED.
 *     It can only remove the regex itself — 133.8 ms of a 1952 ms profile, so ~1.07x on that query
 *     shape at best — for an invasive change to a comparator that is generic over value types.
 *
 * If you come back to this, the hoist is the only live option and the ceiling above is what it has
 * to beat.
 */
export const compareCodePoints = (a: string, b: string): number => {
  if (!HAS_SURROGATE.test(a) && !HAS_SURROGATE.test(b)) {
    if (a < b) {
      return -1;
    }

    return a > b ? 1 : 0;
  }

  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;

    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }

    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }

  // Whichever string still has characters is the longer one, hence greater; a
  // prefix sorts before its extension.
  if (i < a.length) {
    return 1;
  }

  return j < b.length ? -1 : 0;
};
