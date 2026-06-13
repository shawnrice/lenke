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
 *   - `order`:   the *distinct* values, kept sorted (range scans).
 *
 * `order` holds only distinct values, so adding/removing an element at an
 * already-present value is O(1) into a `Set`; only a value's first appearance or
 * last removal touches `order`. That touch is O(log d) — `order` is a skip list
 * (see {@link OrderedSet}), not a sorted array, so a high-cardinality key (one
 * unique value per element) stays O(N log d) to bulk-load instead of the O(N²) a
 * splicing array would cost.
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
  /**
   * value -> elements carrying it. Keyed by the raw value: a JS `Map` already
   * type-separates `1` / `'1'` / `true` (SameValueZero), coalesces `-0`/`0`, and
   * we never insert `NaN` — so no string encoding is needed on the hot path.
   */
  buckets: Map<IndexableValue, Set<E>>;
  /**
   * Distinct values in sorted order for range scans — a skip list, built lazily
   * (`null` until the first range query) so a bulk load that never range-queries
   * this key pays nothing for it. Once built it's maintained incrementally.
   */
  order: OrderedSet<IndexableValue> | null;
};

const isIndexable = (v: unknown): v is IndexableValue =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && !Number.isNaN(v));

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

/**
 * An ordered set of distinct values backed by a skip list: O(log d) insert and
 * delete, with ascending iteration for range scans. This is what keeps writes
 * cheap on high-cardinality keys — a sorted array would splice O(d) per new
 * distinct value, turning a bulk load into O(N²); the skip list makes it
 * O(N log d). Iteration order follows the bottom level, so it's the sorted
 * order regardless of the random tower heights (deterministic results).
 */
const SKIP_MAX_LEVEL = 24;

type SkipNode<T> = { value: T; next: (SkipNode<T> | null)[] };

class OrderedSet<T> {
  private head: SkipNode<T> = {
    value: undefined as never,
    next: new Array(SKIP_MAX_LEVEL).fill(null),
  };
  private level = 1;
  private count = 0;

  constructor(private readonly cmp: (a: T, b: T) => number) {}

  /**
   * Build from values already in ascending order in O(d): each value is the new
   * maximum, so it appends to the rightmost tower at each of its levels with no
   * search. Used to materialize the ordered view from natively-sorted bucket
   * keys, far cheaper than d individual inserts.
   */
  static fromSorted<T>(sorted: readonly T[], cmp: (a: T, b: T) => number): OrderedSet<T> {
    const set = new OrderedSet<T>(cmp);
    const last: SkipNode<T>[] = new Array(SKIP_MAX_LEVEL).fill(set.head);
    for (const value of sorted) {
      const lvl = set.randomLevel();
      if (lvl > set.level) {
        set.level = lvl;
      }
      const node: SkipNode<T> = { value, next: new Array(lvl).fill(null) };
      for (let i = 0; i < lvl; i++) {
        last[i]!.next[i] = node;
        last[i] = node;
      }
      set.count++;
    }
    return set;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.head = { value: undefined as never, next: new Array(SKIP_MAX_LEVEL).fill(null) };
    this.level = 1;
    this.count = 0;
  }

  private randomLevel(): number {
    let lvl = 1;
    while (Math.random() < 0.5 && lvl < SKIP_MAX_LEVEL) {
      lvl++;
    }
    return lvl;
  }

  /** Insert `value` if absent (callers only add distinct values). */
  add(value: T): void {
    const update: SkipNode<T>[] = new Array(SKIP_MAX_LEVEL);
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x.next[i] && this.cmp(x.next[i]!.value, value) < 0) {
        x = x.next[i]!;
      }
      update[i] = x;
    }
    if (x.next[0] && this.cmp(x.next[0]!.value, value) === 0) {
      return; // already present
    }
    const lvl = this.randomLevel();
    if (lvl > this.level) {
      for (let i = this.level; i < lvl; i++) {
        update[i] = this.head;
      }
      this.level = lvl;
    }
    const node: SkipNode<T> = { value, next: new Array(lvl).fill(null) };
    for (let i = 0; i < lvl; i++) {
      node.next[i] = update[i]!.next[i] ?? null;
      update[i]!.next[i] = node;
    }
    this.count++;
  }

  delete(value: T): void {
    const update: SkipNode<T>[] = new Array(SKIP_MAX_LEVEL);
    let x = this.head;
    for (let i = this.level - 1; i >= 0; i--) {
      while (x.next[i] && this.cmp(x.next[i]!.value, value) < 0) {
        x = x.next[i]!;
      }
      update[i] = x;
    }
    const [target] = x.next;
    if (!target || this.cmp(target.value, value) !== 0) {
      return;
    }
    for (let i = 0; i < this.level; i++) {
      if (update[i]!.next[i] === target) {
        update[i]!.next[i] = target.next[i] ?? null;
      }
    }
    while (this.level > 1 && !this.head.next[this.level - 1]) {
      this.level--;
    }
    this.count--;
  }

  /** Ascending values, starting at the first one `>= from` (or from the start). */
  *iterateFrom(from: T | undefined, hasFrom: boolean): Iterable<T> {
    let x = this.head;
    if (hasFrom) {
      for (let i = this.level - 1; i >= 0; i--) {
        while (x.next[i] && this.cmp(x.next[i]!.value, from as T) < 0) {
          x = x.next[i]!;
        }
      }
    }
    let [node] = x.next;
    while (node) {
      yield node.value;
      [node] = node.next;
    }
  }
}

export class PropertyIndex<E> {
  private readonly indexes = new Map<string, KeyIndex<E>>();

  /** Declare `key` as indexed. Idempotent; does not backfill (caller seeds). */
  createIndex(key: string): void {
    if (!this.indexes.has(key)) {
      // `order` stays null until a range query needs it (see `orderOf`).
      this.indexes.set(key, { buckets: new Map(), order: null });
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
      idx.order = null;
    }
  }

  /**
   * The ordered view of `idx`'s distinct values, materialized on first use by
   * natively sorting the bucket keys (cheaper than incremental inserts) and
   * maintained incrementally thereafter.
   */
  private orderOf(idx: KeyIndex<E>): OrderedSet<IndexableValue> {
    if (!idx.order) {
      const sorted = Array.from(idx.buckets.keys()).sort(compare);
      idx.order = OrderedSet.fromSorted(sorted, compare);
    }
    return idx.order;
  }

  // --- maintenance -------------------------------------------------------

  private addEntry(idx: KeyIndex<E>, value: unknown, element: E): void {
    if (!isIndexable(value)) {
      return;
    }
    let set = idx.buckets.get(value);
    if (!set) {
      set = new Set();
      idx.buckets.set(value, set);
      // A new distinct value joins the ordered view only if it's already built;
      // otherwise it'll be picked up when the view is materialized lazily.
      idx.order?.add(value);
    }
    set.add(element);
  }

  private removeEntry(idx: KeyIndex<E>, value: unknown, element: E): void {
    if (!isIndexable(value)) {
      return;
    }
    const set = idx.buckets.get(value);
    if (!set) {
      return;
    }
    set.delete(element);
    if (set.size === 0) {
      idx.buckets.delete(value);
      idx.order?.delete(value);
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
    return idx.buckets.get(value);
  }

  /**
   * The number of elements carrying `key = value`, without touching the set —
   * an O(1) cardinality estimate for query planning. `undefined` if `key` isn't
   * indexed; `0` if indexed but nothing matches.
   */
  countEquals(key: string, value: unknown): number | undefined {
    const idx = this.indexes.get(key);
    if (!idx) {
      return undefined;
    }
    if (!isIndexable(value)) {
      return 0;
    }
    return idx.buckets.get(value)?.size ?? 0;
  }

  /**
   * The distinct values in `bound`, ascending. Walks the skip list from the
   * lower bound (O(log d) to position, then one step per distinct value in
   * range), clamped to the bound's type rank so `{ gt: 30 }` never bleeds into
   * strings. Shared by `range` and `countRange` so a count needn't build a set.
   */
  private *rangeValues(idx: KeyIndex<E>, bound: RangeBound): Iterable<IndexableValue> {
    const ref = bound.gt ?? bound.gte ?? bound.lt ?? bound.lte ?? null;
    const refRank = rank(ref);
    // Start at the lower bound when there is one, else from the smallest value.
    const from = bound.gte ?? bound.gt;
    for (const value of this.orderOf(idx).iterateFrom(from, from !== undefined)) {
      const r = rank(value);
      if (r < refRank) {
        continue; // a lower-ranked value precedes the bound's type block
      }
      if (r > refRank) {
        break; // past the bound's type block (values are ascending)
      }
      // Upper bound: ascending, so the first value past it ends the scan.
      if (bound.lt !== undefined && compare(value, bound.lt) >= 0) {
        break;
      }
      if (bound.lte !== undefined && compare(value, bound.lte) > 0) {
        break;
      }
      // Lower bound: skip values that don't yet satisfy it.
      if (bound.gt !== undefined && compare(value, bound.gt) <= 0) {
        continue;
      }
      if (bound.gte !== undefined && compare(value, bound.gte) < 0) {
        continue;
      }
      yield value;
    }
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
    const out = new Set<E>();
    for (const value of this.rangeValues(idx, bound)) {
      for (const element of idx.buckets.get(value)!) {
        out.add(element);
      }
    }
    return out;
  }

  /**
   * The cardinality of `range(key, bound)` without building it: sums the bucket
   * sizes over the matching distinct values. O(distinct values in range), so a
   * planner can compare candidates before materializing the winner.
   */
  countRange(key: string, bound: RangeBound): number | undefined {
    const idx = this.indexes.get(key);
    if (!idx) {
      return undefined;
    }
    let count = 0;
    for (const value of this.rangeValues(idx, bound)) {
      count += idx.buckets.get(value)!.size;
    }
    return count;
  }

  /**
   * A structural copy: fresh `Map`/`Set` containers (so snapshots don't alias
   * the source's buckets) over the *same* element references and declared keys.
   */
  clone(): PropertyIndex<E> {
    const copy = new PropertyIndex<E>();
    for (const [key, idx] of this.indexes) {
      const buckets = new Map<IndexableValue, Set<E>>();
      for (const [value, set] of idx.buckets) {
        buckets.set(value, new Set(set));
      }
      // Leave the ordered view unbuilt; the snapshot rebuilds it on demand from
      // its own buckets — cheaper than copying, and a snapshot may never range.
      copy.indexes.set(key, { buckets, order: null });
    }
    return copy;
  }
}
