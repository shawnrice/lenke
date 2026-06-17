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
 *   - `buckets`: raw value -> the set of elements carrying it (equality).
 *   - `order`:   the *distinct* values, kept sorted (range scans).
 *
 * `order` holds only distinct values, so adding/removing an element at an
 * already-present value is O(1) into a `Set`; only a value's first appearance or
 * last removal touches `order` (a B+-tree — see {@link OrderedSet}), in O(log d).
 * And `order` is built lazily: until the first range query a key pays nothing
 * for it, after which it's bulk-built from the bucket keys via native sort and
 * maintained incrementally. So a high-cardinality key (one unique value per
 * element) bulk-loads in O(N) — or O(N + d log d) once range-queried — instead
 * of the O(N²) a splicing sorted array would cost.
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
   * Distinct values in sorted order for range scans — a B+-tree, built lazily
   * (`null` until the first range query) so a bulk load that never range-queries
   * this key pays nothing for it. Once built it's maintained incrementally.
   */
  order: OrderedSet<IndexableValue> | null;
  /**
   * The single type rank the built `order` assumes (for its monomorphic
   * comparator), or -1 when the full comparator is in use. Meaningful only while
   * `order` is non-null; a new value of a different rank invalidates `order`.
   */
  orderRank: number;
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
      return a - (b as number);
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

/** Monomorphic comparators for a column known to hold one numeric/string type. */
const numericCmp = (a: IndexableValue, b: IndexableValue): number => (a as number) - (b as number);
const stringCmp = (a: IndexableValue, b: IndexableValue): number => {
  const x = a as string;
  const y = b as string;
  if (x < y) {
    return -1;
  }
  return x > y ? 1 : 0;
};

/**
 * Choose the comparator for a key's ordered view from the values it holds. A
 * homogeneous numeric or string column gets a monomorphic comparator (no
 * per-call `rank` dispatch — the hot path of sorts and tree walks); anything
 * else (empty, boolean, null-only, or genuinely mixed) uses the full type-aware
 * `compare`. The returned `rank` is the shared type rank for a monomorphic
 * column, or -1 when the full comparator is in use (so the maintainer knows
 * when an incoming value breaks the column's type assumption).
 */
const pickComparator = (
  values: Iterable<IndexableValue>,
): { cmp: (a: IndexableValue, b: IndexableValue) => number; rank: number } => {
  let kind = -2; // -2 = unseen, -1 = mixed, else a single rank
  for (const v of values) {
    const r = rank(v);
    if (kind === -2) {
      kind = r;
    } else if (kind !== r) {
      kind = -1;
      break;
    }
  }
  if (kind === 2) {
    return { cmp: numericCmp, rank: 2 };
  }
  if (kind === 3) {
    return { cmp: stringCmp, rank: 3 };
  }
  return { cmp: compare, rank: -1 };
};

/**
 * An ordered set of distinct values backed by a B+-tree: O(log d) insert/delete
 * and O(log d + k) range scans, with values packed into contiguous leaf arrays
 * linked left-to-right. Versus a per-value node structure (e.g. a skip list)
 * this is far more cache-friendly and allocates ~d/ORDER leaves instead of d
 * nodes. `fromSorted` bulk-builds the whole tree bottom-up in O(d).
 *
 * Deletion is leaf-local — the value is dropped from its leaf, leaving empty
 * leaves rather than merging. That keeps deletes O(log d) and simple; the
 * structure is rebuilt from scratch on `clear()`/snapshot anyway, and the
 * workload is insert-heavy.
 */
const BTREE_ORDER = 64;

type Leaf<T> = { leaf: true; values: T[]; next: Leaf<T> | null };
type Internal<T> = { leaf: false; keys: T[]; children: BNode<T>[] };
type BNode<T> = Leaf<T> | Internal<T>;

const firstKey = <T>(node: BNode<T>): T => {
  let n = node;
  while (!n.leaf) {
    n = n.children[0]!;
  }
  return n.values[0];
};

class OrderedSet<T> {
  private root: BNode<T>;
  private firstLeaf: Leaf<T>;
  private count = 0;

  constructor(private readonly cmp: (a: T, b: T) => number) {
    const leaf: Leaf<T> = { leaf: true, values: [], next: null };
    this.root = leaf;
    this.firstLeaf = leaf;
  }

  /** Bulk-build from ascending values in O(d): pack leaves, then internal levels. */
  static fromSorted<T>(sorted: readonly T[], cmp: (a: T, b: T) => number): OrderedSet<T> {
    const set = new OrderedSet<T>(cmp);
    if (sorted.length === 0) {
      return set;
    }
    const leaves: Leaf<T>[] = [];
    for (let i = 0; i < sorted.length; i += BTREE_ORDER) {
      const leaf: Leaf<T> = { leaf: true, values: sorted.slice(i, i + BTREE_ORDER), next: null };
      if (leaves.length > 0) {
        leaves[leaves.length - 1].next = leaf;
      }
      leaves.push(leaf);
    }
    set.firstLeaf = leaves[0]!;
    set.count = sorted.length;
    let level: BNode<T>[] = leaves;
    while (level.length > 1) {
      const parents: Internal<T>[] = [];
      for (let i = 0; i < level.length; i += BTREE_ORDER) {
        const children = level.slice(i, i + BTREE_ORDER);
        const keys: T[] = [];
        for (let j = 1; j < children.length; j++) {
          keys.push(firstKey(children[j]));
        }
        parents.push({ leaf: false, keys, children });
      }
      level = parents;
    }
    set.root = level[0]!;
    return set;
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    const leaf: Leaf<T> = { leaf: true, values: [], next: null };
    this.root = leaf;
    this.firstLeaf = leaf;
    this.count = 0;
  }

  /** The child index to descend for `value`: first key strictly greater than it. */
  private childIndex(node: Internal<T>, value: T): number {
    let lo = 0;
    let hi = node.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cmp(value, node.keys[mid]) < 0) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  }

  /** First index in `values` whose entry is `>= value`. */
  private lowerIdx(values: readonly T[], value: T): number {
    let lo = 0;
    let hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cmp(values[mid], value) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  add(value: T): void {
    const path: { node: Internal<T>; idx: number }[] = [];
    let node: BNode<T> = this.root;
    while (!node.leaf) {
      const idx = this.childIndex(node, value);
      path.push({ node, idx });
      node = node.children[idx]!;
    }
    const pos = this.lowerIdx(node.values, value);
    if (pos < node.values.length && this.cmp(node.values[pos], value) === 0) {
      return; // already present
    }
    node.values.splice(pos, 0, value);
    this.count++;
    if (node.values.length <= BTREE_ORDER) {
      return;
    }
    // Split the overfull leaf and propagate splits up the recorded path.
    const mid = node.values.length >> 1;
    const right: Leaf<T> = { leaf: true, values: node.values.splice(mid), next: node.next };
    node.next = right;
    this.insertSplit(right.values[0], right, path);
  }

  private insertSplit(
    sepKey: T,
    rightChild: BNode<T>,
    path: { node: Internal<T>; idx: number }[],
  ): void {
    if (path.length === 0) {
      this.root = { leaf: false, keys: [sepKey], children: [this.root, rightChild] };
      return;
    }
    const { node: parent, idx } = path.pop()!;
    parent.keys.splice(idx, 0, sepKey);
    parent.children.splice(idx + 1, 0, rightChild);
    if (parent.children.length <= BTREE_ORDER) {
      return;
    }
    const mid = parent.keys.length >> 1;
    const upKey = parent.keys[mid];
    const rightKeys = parent.keys.splice(mid + 1);
    parent.keys.length = mid; // drop keys[mid] (it moves up, not copied)
    const rightChildren = parent.children.splice(mid + 1);
    this.insertSplit(upKey, { leaf: false, keys: rightKeys, children: rightChildren }, path);
  }

  delete(value: T): void {
    let node: BNode<T> = this.root;
    while (!node.leaf) {
      node = node.children[this.childIndex(node, value)]!;
    }
    const pos = this.lowerIdx(node.values, value);
    if (pos < node.values.length && this.cmp(node.values[pos], value) === 0) {
      node.values.splice(pos, 1);
      this.count--;
    }
  }

  /** Ascending values, starting at the first one `>= from` (or from the start). */
  *iterateFrom(from: T | undefined, hasFrom: boolean): Iterable<T> {
    let leaf = this.firstLeaf;
    let start = 0;
    if (hasFrom) {
      let node: BNode<T> = this.root;
      while (!node.leaf) {
        node = node.children[this.childIndex(node, from as T)]!;
      }
      leaf = node;
      start = this.lowerIdx(node.values, from as T);
    }
    for (let l: Leaf<T> | null = leaf; l; l = l.next) {
      const { values } = l;
      for (let i = l === leaf ? start : 0; i < values.length; i++) {
        yield values[i];
      }
    }
  }
}

export class PropertyIndex<E> {
  private readonly indexes = new Map<string, KeyIndex<E>>();

  /** Declare `key` as indexed. Idempotent; does not backfill (caller seeds). */
  createIndex(key: string): void {
    if (!this.indexes.has(key)) {
      // `order` stays null until a range query needs it (see `orderOf`).
      this.indexes.set(key, { buckets: new Map(), order: null, orderRank: -1 });
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
      const keys = Array.from(idx.buckets.keys());
      const { cmp, rank: r } = pickComparator(keys);
      keys.sort(cmp);
      idx.order = OrderedSet.fromSorted(keys, cmp);
      idx.orderRank = r;
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
      // A new distinct value joins the ordered view only if it's already built.
      // If it breaks the column's assumed type, drop the view so it rebuilds
      // lazily with the full comparator; otherwise insert incrementally.
      if (idx.order) {
        if (idx.orderRank >= 0 && rank(value) !== idx.orderRank) {
          idx.order = null;
        } else {
          idx.order.add(value);
        }
      }
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
   * The distinct values in `bound`, ascending. Walks the B+-tree from the
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
      copy.indexes.set(key, { buckets, order: null, orderRank: -1 });
    }
    return copy;
  }
}
