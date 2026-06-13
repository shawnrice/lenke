/**
 * Secondary indexes over element (vertex/edge) property *values*.
 *
 * The graph already keeps an inverted index by label (`verticesByLabel`); this
 * is the analogous structure for properties, so a `has(key, value)` / `WHERE
 * a.key = v` seed is an O(1) bucket hit instead of a full scan over every
 * element.
 *
 * Indexes are opt-in per key (`createIndex('age')`): an ephemeral in-memory
 * graph — especially in a browser tab — shouldn't pay heap for keys nobody
 * filters on. Each indexed key supports both equality and range queries from a
 * single structure:
 *
 *   - `buckets`: encoded value -> the set of elements carrying it (equality).
 *   - `order`:   the *distinct* values, kept sorted (range).
 *
 * `order` holds distinct values, so adding/removing an element at an
 * already-present value is O(1) into a `Set`; only the first appearance or last
 * removal of a value splices `order`. For the keys people actually range-query
 * (ages, scores, enums) the distinct-value domain is small and stabilizes
 * quickly, so splices are rare after warmup. If a key ever proves both
 * high-cardinality and high-churn, `order` can be swapped for a B+-tree/skip
 * list behind this same interface without touching callers.
 */

/** The scalar value kinds we index. Objects/arrays fall back to a full scan. */
export type IndexableValue = string | number | boolean | null;

/** A half-open / closed range request. Any subset of bounds may be supplied. */
export type RangeBound = {
  gt?: IndexableValue;
  gte?: IndexableValue;
  lt?: IndexableValue;
  lte?: IndexableValue;
};

type KeyIndex<E> = {
  /** encoded value -> elements carrying it */
  buckets: Map<string, Set<E>>;
  /** distinct values, sorted by `compare` */
  order: IndexableValue[];
};

const isIndexable = (v: unknown): v is IndexableValue =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && !Number.isNaN(v));

/**
 * A type-tagged canonical key for the equality buckets so `1` (number), `'1'`
 * (string), and `true` (boolean) never collide. `-0` and `0` already stringify
 * identically, matching `-0 === 0`.
 */
const encode = (v: IndexableValue): string => {
  if (v === null) {
    return 'z:';
  }
  switch (typeof v) {
    case 'number':
      return `n:${v}`;
    case 'boolean':
      return `b:${v ? 1 : 0}`;
    default:
      return `s:${v}`;
  }
};

/** Rank groups values by type so `compare` is a total order across types. */
const rank = (v: IndexableValue): number => {
  if (v === null) {
    return 0;
  }
  switch (typeof v) {
    case 'boolean':
      return 1;
    case 'number':
      return 2;
    default:
      return 3;
  }
};

/**
 * A total order over indexable values: by type rank first (so a numeric range
 * bound can't stray into strings), then by natural order within a type. Strings
 * order by UTF-16 code unit (JS `<`), which differs from the Rust backend's
 * byte order — fine for a TS-first in-memory engine, noted for cross-checks.
 */
const compare = (a: IndexableValue, b: IndexableValue): number => {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) {
    return ra - rb;
  }
  switch (typeof a) {
    case 'number':
      return (a as number) - (b as number);
    case 'boolean':
      return (a ? 1 : 0) - (b ? 1 : 0);
    case 'string': {
      const s = b as string;
      if (a < s) {
        return -1;
      }
      return a > s ? 1 : 0;
    }
    default:
      return 0; // both null
  }
};

/** First index `i` with `order[i] >= target`. */
const lowerBound = (order: IndexableValue[], target: IndexableValue): number => {
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(order[mid]!, target) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

/** First index `i` with `order[i] > target`. */
const upperBound = (order: IndexableValue[], target: IndexableValue): number => {
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compare(order[mid]!, target) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
};

export class PropertyIndex<E> {
  private readonly indexes = new Map<string, KeyIndex<E>>();

  /** Declare `key` as indexed. Idempotent; does not backfill (caller seeds). */
  createIndex(key: string): void {
    if (!this.indexes.has(key)) {
      this.indexes.set(key, { buckets: new Map(), order: [] });
    }
  }

  dropIndex(key: string): void {
    this.indexes.delete(key);
  }

  isIndexed(key: string): boolean {
    return this.indexes.has(key);
  }

  indexedKeys(): string[] {
    return Array.from(this.indexes.keys());
  }

  /** Empty all buckets but keep the set of declared keys (for `truncate`). */
  clear(): void {
    for (const idx of this.indexes.values()) {
      idx.buckets.clear();
      idx.order.length = 0;
    }
  }

  // --- maintenance -------------------------------------------------------

  private addEntry(idx: KeyIndex<E>, value: unknown, element: E): void {
    if (!isIndexable(value)) {
      return;
    }
    const enc = encode(value);
    let set = idx.buckets.get(enc);
    if (!set) {
      set = new Set();
      idx.buckets.set(enc, set);
      // A value seen for the first time joins the sorted distinct-value list.
      idx.order.splice(lowerBound(idx.order, value), 0, value);
    }
    set.add(element);
  }

  private removeEntry(idx: KeyIndex<E>, value: unknown, element: E): void {
    if (!isIndexable(value)) {
      return;
    }
    const enc = encode(value);
    const set = idx.buckets.get(enc);
    if (!set) {
      return;
    }
    set.delete(element);
    if (set.size === 0) {
      idx.buckets.delete(enc);
      const at = lowerBound(idx.order, value);
      if (at < idx.order.length && compare(idx.order[at]!, value) === 0) {
        idx.order.splice(at, 1);
      }
    }
  }

  /** Index `element` across every declared key present in `props`. */
  add(element: E, props: Record<string, unknown>): void {
    for (const [key, idx] of this.indexes) {
      this.addEntry(idx, props[key], element);
    }
  }

  /** De-index `element` across every declared key present in `props`. */
  remove(element: E, props: Record<string, unknown>): void {
    for (const [key, idx] of this.indexes) {
      this.removeEntry(idx, props[key], element);
    }
  }

  /** Index a single `(element, key, value)` — used to backfill a new index. */
  addForKey(element: E, key: string, value: unknown): void {
    const idx = this.indexes.get(key);
    if (idx) {
      this.addEntry(idx, value, element);
    }
  }

  /** Move `element` from `oldValue`'s bucket to `newValue`'s for `key`. */
  update(element: E, key: string, oldValue: unknown, newValue: unknown): void {
    const idx = this.indexes.get(key);
    if (!idx) {
      return;
    }
    this.removeEntry(idx, oldValue, element);
    this.addEntry(idx, newValue, element);
  }

  // --- queries -----------------------------------------------------------

  /**
   * The live element set for `key = value`, or `undefined` if `key` isn't
   * indexed or nothing matches. Returned set is the index's own — callers that
   * mutate it must copy first.
   */
  equals(key: string, value: unknown): Set<E> | undefined {
    const idx = this.indexes.get(key);
    if (!idx || !isIndexable(value)) {
      return undefined;
    }
    return idx.buckets.get(encode(value));
  }

  /**
   * Elements whose `key` falls within `bound`. The range is clamped to the type
   * of the supplied bound(s), so `{ gt: 30 }` returns numeric matches only and
   * never bleeds into strings. Returns `undefined` if `key` isn't indexed.
   */
  range(key: string, bound: RangeBound): Set<E> | undefined {
    const idx = this.indexes.get(key);
    if (!idx) {
      return undefined;
    }
    const { order } = idx;
    const ref = bound.gt ?? bound.gte ?? bound.lt ?? bound.lte ?? null;
    const refRank = rank(ref);

    let lo = 0;
    let hi = order.length;
    if (bound.gte !== undefined) {
      lo = Math.max(lo, lowerBound(order, bound.gte));
    }
    if (bound.gt !== undefined) {
      lo = Math.max(lo, upperBound(order, bound.gt));
    }
    if (bound.lte !== undefined) {
      hi = Math.min(hi, upperBound(order, bound.lte));
    }
    if (bound.lt !== undefined) {
      hi = Math.min(hi, lowerBound(order, bound.lt));
    }

    const out = new Set<E>();
    for (let i = lo; i < hi; i++) {
      const value = order[i]!;
      // An open bound leaves `hi`/`lo` at the array edge; the rank guard keeps
      // the result inside the bound's type block.
      if (rank(value) !== refRank) {
        continue;
      }
      for (const element of idx.buckets.get(encode(value))!) {
        out.add(element);
      }
    }
    return out;
  }

  /**
   * A structural copy: fresh `Map`/`Set` containers (so snapshots don't alias
   * the source's buckets) over the *same* element references and declared keys.
   */
  clone(): PropertyIndex<E> {
    const copy = new PropertyIndex<E>();
    for (const [key, idx] of this.indexes) {
      const buckets = new Map<string, Set<E>>();
      for (const [enc, set] of idx.buckets) {
        buckets.set(enc, new Set(set));
      }
      copy.indexes.set(key, { buckets, order: idx.order.slice() });
    }
    return copy;
  }
}
