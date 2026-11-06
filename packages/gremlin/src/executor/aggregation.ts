import { type Graph, isElement } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { By } from '../ast.js';
import { compareTotal } from '../predicates.js';
import {
  evalBy,
  extend,
  isSliceable,
  NO_VALUE,
  type RunContext,
  startTraverser,
  type Traverser,
} from './runtime.js';

/** Coerce a numeric-aggregate element, throwing on a non-number (TinkerPop's
 * `sum`/`mean` require `Number`s and raise on anything else, rather than
 * silently coercing to `NaN`). `null` is filtered by the caller. */
const asNumber = (v: unknown): number => {
  if (typeof v === 'number') {
    return v;
  }

  throw new LenkeError(`numeric aggregation requires a number, got ${typeof v}`, {
    code: ErrorCode.InvalidValue,
  });
};

export const aggregateNumber = function* (
  stream: Iterable<Traverser<unknown>>,
  kind: 'sum' | 'mean',
): Iterable<Traverser<unknown>> {
  let sum = 0;
  let count = 0;
  let sawNonNull = false;

  for (const t of stream) {
    if (t.value == null) {
      continue;
    }

    sawNonNull = true;
    sum += asNumber(t.value);
    count++;
  }

  if (!sawNonNull) {
    yield startTraverser(null);

    return;
  }

  yield startTraverser(kind === 'sum' ? sum : sum / count);
};

// min()/max() reduce over the engine's TOTAL ORDER (the same one `order()` and the native
// engine use — see the numeric/NaN comparison policy), so they work on ANY value, not just
// numbers: strings compare lexicographically (`min` of names → the first alphabetically),
// NaN sorts greatest, and a mixed stream is decided by the deterministic type rank. This
// matches the native engine AND TinkerPop (which orders any Comparable); an earlier
// numeric-only guard faulted on `values('name').min()`, diverging from both.
export const aggregateComparable = function* (
  stream: Iterable<Traverser<unknown>>,
  kind: 'min' | 'max',
): Iterable<Traverser<unknown>> {
  let best: unknown;
  let sawNonNull = false;

  for (const t of stream) {
    if (t.value == null) {
      continue;
    }

    if (!sawNonNull) {
      best = t.value;
      sawNonNull = true;
    } else {
      const c = compareTotal(t.value, best);

      if (kind === 'min' ? c < 0 : c > 0) {
        best = t.value;
      }
    }
  }

  if (!sawNonNull) {
    yield startTraverser(null);

    return;
  }

  yield startTraverser(best);
};

export const countStep = function* (
  stream: Iterable<Traverser<unknown>>,
): Iterable<Traverser<unknown>> {
  let n = 0;

  for (const _ of stream) {
    n++;
  }

  yield startTraverser(n);
};

// ---------- Scope.local aggregations (per-traverser) ----------
//
// Each `*Local` helper computes the aggregate of a single traverser's
// iterable VALUE (post-`fold()` array, list-cardinality projection, etc.).
// For non-iterable values, the traverser is treated as a one-element
// sequence — `count` returns 1, `sum`/`min`/`max`/`mean` return the value
// itself when numeric. Empty iterables return `null` to mirror the
// global-scope behavior on empty streams.

const elementsOf = (v: unknown): unknown[] => (isSliceable(v) ? [...v] : [v]);

export const countLocal = (v: unknown): number => elementsOf(v).length;

export const sumLocal = (v: unknown): number | null => {
  const items = elementsOf(v).filter((x) => x != null);

  if (items.length === 0) {
    return null;
  }

  return items.reduce<number>((s, x) => s + asNumber(x), 0);
};

export const meanLocal = (v: unknown): number | null => {
  const items = elementsOf(v).filter((x) => x != null);

  if (items.length === 0) {
    return null;
  }

  return items.reduce<number>((s, x) => s + asNumber(x), 0) / items.length;
};

export const minLocal = (v: unknown): unknown => reduceComparable(elementsOf(v), 'min');

export const maxLocal = (v: unknown): unknown => reduceComparable(elementsOf(v), 'max');

const reduceComparable = (items: readonly unknown[], kind: 'min' | 'max'): unknown => {
  let best: unknown;
  let saw = false;

  for (const x of items) {
    if (x == null) {
      continue;
    }

    if (!saw) {
      best = x;
      saw = true;
      continue;
    }

    const c = compareTotal(x, best);

    if (kind === 'min' ? c < 0 : c > 0) {
      best = x;
    }
  }

  return saw ? best : null;
};

// Sort `items` IN PLACE by projecting each through the `bys` (first = primary
// key, rest = tie-breakers, in order). Per-by direction prefers the By's
// `direction`; falls back to the step-level `desc` (legacy `order({desc})` form).
/**
 * The `cap` BEST entries of `xs` by `cmp`, in sorted order — the same prefix a stable full sort
 * would produce (item 1574).
 *
 * ⚠️ TIES BREAK ON ARRIVAL INDEX, which is what makes this equal to `Array.prototype.sort`'s
 * stability rather than merely similar. Gremlin's sort is stable today and tie order is compared
 * against native, so a selection that picked an arbitrary member of a tie group straddling the
 * boundary would be an answer change.
 *
 * Indices, not wrappers: the heap holds positions into `xs`, so a 200,000-element stream allocates
 * one `number[]` of length `cap` rather than an object per candidate.
 *
 * This is the algorithm GQL's `boundedTopK` uses (item 1064), re-implemented rather than imported:
 * ordering is per-language by design, and the two engines' comparators differ.
 */
const boundedTop = <E>(xs: readonly E[], cap: number, cmp: (a: E, b: E) => number): E[] => {
  // ⚠️ A ZERO CAP RETURNS EARLY, and leaving this out is a CRASH rather than a wrong answer: the
  // heap stays empty, `worse(heap[0], i)` dereferences `undefined`, and `order().limit(0)` throws
  // a TypeError. GQL's `boundedTopK` has the same guard as its first line; I did not copy it, and
  // the cap-0 test is what found it.
  if (cap <= 0) {
    return [];
  }

  // `true` when `i` belongs ABOVE `j` in a max-heap whose root is the worst kept entry.
  const worse = (i: number, j: number): boolean => {
    const c = cmp(xs[i], xs[j]);

    return c !== 0 ? c > 0 : i > j;
  };
  const heap: number[] = [];
  const swap = (x: number, y: number): void => {
    const t = heap[x];

    heap[x] = heap[y];
    heap[y] = t;
  };
  const up = (from: number): void => {
    let i = from;

    while (i > 0) {
      const parent = (i - 1) >> 1;

      if (!worse(heap[i], heap[parent])) {
        break;
      }

      swap(i, parent);
      i = parent;
    }
  };
  const down = (): void => {
    let i = 0;

    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let big = i;

      if (l < heap.length && worse(heap[l], heap[big])) {
        big = l;
      }

      if (r < heap.length && worse(heap[r], heap[big])) {
        big = r;
      }

      if (big === i) {
        break;
      }

      swap(i, big);
      i = big;
    }
  };

  for (let i = 0; i < xs.length; i += 1) {
    if (heap.length < cap) {
      heap.push(i);
      up(heap.length - 1);
      continue;
    }

    if (worse(heap[0], i)) {
      heap[0] = i;
      down();
    }
  }

  heap.sort((a, b) => {
    const c = cmp(xs[a], xs[b]);

    return c !== 0 ? c : a - b;
  });

  return heap.map((i) => xs[i]);
};

const sortByBys = <T>(
  items: readonly T[],
  project: (item: T) => unknown,
  bys: readonly By[],
  /**
   * `desc` is the step-level direction; `cap` keeps only the best N via {@link boundedTop}
   * (item 1574), `undefined` sorting everything.
   *
   * ⚠️ ONE OBJECT RATHER THAN TWO PARAMETERS because a seventh positional argument trips
   * `max-params`, and the rule is right: `(items, project, bys, desc, graph, ctx, cap)` is four
   * trailing values nobody can read at a call site.
   *
   * ⚠️ AND THE KEYS ARE STILL EVALUATED FOR EVERY ITEM when `cap` is set, with the element check
   * still running over all of them, both ABOVE the selection. Not incidental: `sortByBys` evaluates
   * every key before the element check precisely so a throwing `by` wins over the element fault,
   * and a selection that skipped rejected items would silently drop both faults.
   */
  opts: { readonly desc: boolean; readonly cap?: number },
  graph: Graph,
  ctx: RunContext,
): T[] => {
  const { desc, cap } = opts;

  // ONE `by` — the common case — gets a SCALAR key and a comparator with no loop (item 879).
  //
  // The general path below allocates a wrapper object AND a `keys` array per item, then compares
  // through a loop that indexes both arrays and re-tests `dirs[i] === 'desc'` — a STRING compare
  // — on every comparison. At 1,000,000 values that is ~20M comparisons, and item 878 measured
  // what it costs: `values(age).order()` 474.30 ms against 174.30 without the `order()`, where
  // sorting a million numbers with a plain numeric comparator is 88.36 and the engine's own
  // NaN-total order is 87.05 — so the ordering CONTRACT is free and ~212 ms was the scaffolding.
  //
  // Deliberately NOT a hoist of the multi-key loop as well: `sortRowsByColumns` in the GQL
  // executor records that exact attempt measuring 1.00-1.02x and being reverted, at the cost of
  // three array allocations per call. One key is the case worth specializing; the rest keeps the
  // general shape.
  //
  // Equivalence, point by point with the general path below:
  //   - every key is evaluated BEFORE the element check, so an `evalBy` that throws still wins
  //     over the element fault exactly as it did when `items.map` ran first;
  //   - `desc` negates the SAME comparison (`-compareTotal(a, b)`) rather than swapping the
  //     arguments, so nothing rests on `compareTotal` being antisymmetric;
  //   - the sort is still `Array.prototype.sort` over one object per item, so it is still STABLE
  //     and ties keep arrival order — which is observable and compared against native.
  // REJECTED, item 890: do NOT rewrite this to sort an INDEX PERMUTATION over a flat key array.
  //
  // Item 879 priced the residual above the sort floor at ~131 ms and attributed it to the
  // scaffolding here — one `{item, key}` object per item, an element-check pass, a `filter` pass
  // allocating a second array, and a `map` pass allocating a third. It was built: keys in one flat
  // array, the sort permuting indexes into it, two passes instead of four, no wrapper objects.
  //
  // It recovers ~14 ms of the ~127, and the 1.04x it measures on the target is EXACTLY what a
  // control the change cannot reach (a bare hop, no sort) drifted in the same rounds. An explicit
  // arrival tiebreak and the stability-inherited form measured identically (1.04x both), so that
  // design question is moot as well.
  //
  // So 879's ATTRIBUTION is refuted, which is the useful part: the wrapper objects and the extra
  // passes are ~11% of the residual, and the other ~89% is elsewhere — `evalBy` plus `project`
  // being 2M closure/switch calls, `[...stream]` materializing 1M traversers, and `compareTotal`
  // over two `unknown` loads ~20M times are the ~~unpriced candidates. Do not re-attempt this
  // rewrite; price those first~~ candidates. See packages/native/order-cost-probe.ts.
  //
  // ⚠️ ALL THREE ARE NOW PRICED AND ALL THREE ARE CLOSED (item 1394), off a WINDOWED profile of
  // `hoporder` — the Gremlin bench had no windowing until item 1392, which is why they stayed
  // unpriced this long:
  //
  //   `evalBy` plus `project`   0.1%  REFUTED — listed first, and it is not a cost at all
  //   the comparator          ~4.3%  `compareTotal` is inlined into the `sortByBys` closure
  //   `[...stream]`           ~5.0%  startTraverser 1.4 + unwrap 1.9 + toArray 1.8
  //
  // A share overstates a realizable change by ~2.5x here, so the latter two are ~2% each — under
  // what this row resolves even at 106 ms a rep. And the row's dominant term is not the sort:
  // **36% of what `values(k).order()` adds over a bare hop is FAR-VERTEX LOCALITY** (115.9 ms at
  // fan-in 1 against 73.5 at fan-in 100, with the bare-hop control flat at 75.9/77.6), which item
  // 1392 closed as having no per-row lever. Nothing is open on this row.
  if (bys.length === 1) {
    const [by] = bys;
    const descending = (by.direction ?? (desc ? 'desc' : 'asc')) === 'desc';
    const keyed1 = items.map((item) => ({ item, key: evalBy(by, project(item), graph, ctx) }));

    for (const k of keyed1) {
      if (isElement(k.key)) {
        throw new LenkeError(
          `order() over graph elements is not supported — elements have no natural order; ` +
            `use order().by('<key>')`,
          { code: ErrorCode.Syntax },
        );
      }
    }

    const live1 = keyed1.filter((k) => k.key !== NO_VALUE);
    const cmp1 = descending
      ? (a: { key: unknown }, b: { key: unknown }): number => -compareTotal(a.key, b.key)
      : (a: { key: unknown }, b: { key: unknown }): number => compareTotal(a.key, b.key);

    if (cap !== undefined && cap < live1.length) {
      return boundedTop(live1, cap, cmp1).map((k) => k.item);
    }

    live1.sort(cmp1);

    return live1.map((k) => k.item);
  }

  const dirs = bys.map((by) => by.direction ?? (desc ? 'desc' : 'asc'));
  const keyed = items.map((item) => ({
    item,
    keys: bys.map((by) => evalBy(by, project(item), graph, ctx)),
  }));

  // A raw graph element has no natural order. The parse-time check in `checkStep`
  // rejects a pure-element `order()`, but an element still reaches here in a MIXED
  // stream (`both(...).inject(1).order()`) whose frontier is no longer "element", or
  // via `by(<element-valued traversal>)`. Fault at runtime to match the native engine.
  if (keyed.some((k) => k.keys.some(isElement))) {
    throw new LenkeError(
      `order() over graph elements is not supported — elements have no natural order; ` +
        `use order().by('<key>')`,
      { code: ErrorCode.Syntax },
    );
  }

  // TinkerPop: a `by()` that yields no value FILTERS the item out of the ordering
  // (e.g. `order().by('age')` drops elements lacking `age`), so a NO_VALUE key never
  // reaches the comparator. A stored `null` is a value and orders normally.
  const live = keyed.filter((k) => !k.keys.some((key) => key === NO_VALUE));

  const cmpN = (a: { keys: unknown[] }, b: { keys: unknown[] }): number => {
    for (let i = 0; i < bys.length; i++) {
      const c = compareTotal(a.keys[i], b.keys[i]) * (dirs[i] === 'desc' ? -1 : 1);

      if (c !== 0) {
        return c;
      }
    }

    return 0;
  };

  if (cap !== undefined && cap < live.length) {
    return boundedTop(live, cap, cmpN).map((k) => k.item);
  }

  live.sort(cmpN);

  return live.map((k) => k.item);
};

/**
 * The capped `order()` as ONE STREAMING PASS: a heap of at most `cap`, never an array of the whole
 * stream (item 1576).
 *
 * Item 1574 capped the sort but still did `[...stream]` first. Item 1575 priced what that costs, and
 * had to decompose it twice to get an honest number — the spread's time is upstream generator work
 * PLUS array growth, and streaming only removes the latter:
 *
 *     SPREAD  [...stream]       consume 102.4 ms   sort 51.2     (5 reps, 200,000 values)
 *     DRAIN   for-of, no array  consume  48.8      sort  0.0
 *     => accumulation ~= 53.6 ms of 153.6 total  ->  ~1.54x, NOT the 4.4x item 1574 implied
 *
 * ⚠️ ELEMENT FAULTS ARE DEFERRED TO THE END OF THE LOOP, and that is the whole correctness argument.
 * `sortByBys` evaluates every key before checking any of them for elements, so an `evalBy` that
 * throws wins over the element fault — item 890 recorded that phase order as guarded by construction
 * only, and item 1575 finally tested it (`by(pipe(fail(…)))` under a `choose`, so one item's key is
 * an ELEMENT and a later item's `by` THROWS). A per-item check here would surface the element error
 * where the engine surfaces the throw, which is a different exception from the same query and is
 * compared across engines. Setting a flag and throwing after the loop reproduces the old precedence
 * exactly.
 *
 * ⚠️ A `cap` OF 0 STILL DRAINS AND STILL FAULTS. `order().limit(0)` evaluates every key today, so an
 * early return would silently stop raising — the `cap > 0` guard sits on the heap ACCESS, not on the
 * loop.
 *
 * ⚠️ NO ONE-`by` SPECIALIZATION HERE, deliberately, unlike `sortByBys`. That fast path (item 879)
 * pays off over `n log n` comparisons; a bounded heap does ~`n` of them — one against the root per
 * item — so the multi-key loop is a constant on a term that is already linear.
 */
const streamTopByBys = <T>(
  stream: Iterable<T>,
  project: (item: T) => unknown,
  bys: readonly By[],
  opts: { readonly desc: boolean; readonly cap: number },
  graph: Graph,
  ctx: RunContext,
): T[] => {
  const { desc, cap } = opts;
  const dirs = bys.map((by) => by.direction ?? (desc ? 'desc' : 'asc'));

  type Entry = { item: T; keys: unknown[]; at: number };

  // Ties break on ARRIVAL, so this comparator is a total order and the final sort is deterministic.
  const cmp = (a: Entry, b: Entry): number => {
    for (let i = 0; i < bys.length; i += 1) {
      const c = compareTotal(a.keys[i], b.keys[i]) * (dirs[i] === 'desc' ? -1 : 1);

      if (c !== 0) {
        return c;
      }
    }

    return a.at - b.at;
  };
  // A max-heap under `cmp`: the root is the WORST entry kept, so it is the one a better candidate
  // displaces.
  const heap: Entry[] = [];
  const swap = (x: number, y: number): void => {
    const t = heap[x];

    heap[x] = heap[y];
    heap[y] = t;
  };
  const up = (from: number): void => {
    let i = from;

    while (i > 0) {
      const parent = (i - 1) >> 1;

      if (cmp(heap[i], heap[parent]) <= 0) {
        break;
      }

      swap(i, parent);
      i = parent;
    }
  };
  const down = (): void => {
    let i = 0;

    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let big = i;

      if (l < heap.length && cmp(heap[l], heap[big]) > 0) {
        big = l;
      }

      if (r < heap.length && cmp(heap[r], heap[big]) > 0) {
        big = r;
      }

      if (big === i) {
        break;
      }

      swap(i, big);
      i = big;
    }
  };
  let sawElement = false;
  let at = 0;

  for (const item of stream) {
    // Evaluated FIRST and unconditionally: a throwing `by` must win over the element fault.
    const keys = bys.map((by) => evalBy(by, project(item), graph, ctx));

    at += 1;

    if (keys.some(isElement)) {
      sawElement = true;
      continue;
    }

    // TinkerPop: a `by()` yielding no value filters the item out of the ordering entirely.
    if (keys.some((key) => key === NO_VALUE)) {
      continue;
    }

    const entry: Entry = { item, keys, at };

    if (heap.length < cap) {
      heap.push(entry);
      up(heap.length - 1);
      continue;
    }

    if (cap > 0 && cmp(heap[0], entry) > 0) {
      heap[0] = entry;
      down();
    }
  }

  if (sawElement) {
    throw new LenkeError(
      `order() over graph elements is not supported — elements have no natural order; ` +
        `use order().by('<key>')`,
      { code: ErrorCode.Syntax },
    );
  }

  heap.sort(cmp);

  return heap.map((e) => e.item);
};

// `order` (global scope) materializes the stream, sorts the traversers by their
// value, then re-yields. Boundary step.
// REJECTED, item 892: making this a lazy `Iterable` that hands back an ARRAY ITERATOR instead of
// a generator does NOT recover item 891's inert-step cost. Measured 1.05x on min and **1.01x on
// medians** with the `engineValues` control moving 1.04x — inside the noise, three alternated
// rounds. Reverted.
//
// The attribution was the error. Item 891 measured "an inert `order()` step" at 95.73 ms over 1M
// items (42% of what the step costs) by comparing a plan WITH an order step against a plan
// WITHOUT one — so that figure is the cost of the pipeline having one more STEP, including
// dispatch and the consumer's own iteration machinery, not the cost of this function's `yield*`.
// Removing this generator layer leaves the rest of it in place, which is why it measures nothing.
// Consistent with items 234/537: it is the per-step pipeline, and no single step can fix it.
//
// The laziness tests that came with the attempt were KEPT (`order-step-laziness.test.ts`): the
// contract they pin — constructing does no work — holds for the generator too, and only an eager
// `return sortByBys(...)` breaks it, which is the simplest thing a future change would reach for.
export const orderStep = function* (
  stream: Iterable<Traverser<unknown>>,
  bys: readonly By[],
  desc: boolean,
  graph: Graph,
  ctx: RunContext,
  /** The fused `take(n)` bound, if `fuseOrderTake` set one (item 1574). */
  cap?: number,
): Iterable<Traverser<unknown>> {
  yield* cap === undefined
    ? sortByBys([...stream], (t) => t.value, bys, { desc }, graph, ctx)
    : streamTopByBys(stream, (t) => t.value, bys, { desc, cap }, graph, ctx);
};

// `order(Scope.local)` sorts WITHIN each traverser's value instead of across the
// stream: a Map's entries — by their VALUE by default, or by their KEY when a
// `by(keys)` Column selector is given (the `groupCount().order(local)` top-N idiom;
// `by(values)` is the explicit default) — or a list's elements. A non-column
// by-modulator projects the sort key off each entry-value / element (identity → the
// value itself). A scalar value has nothing to sort → passes through unchanged.
export const orderLocalStep = function* (
  stream: Iterable<Traverser<unknown>>,
  bys: readonly By[],
  desc: boolean,
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  // A Map entry's sort key for one `by`: `by(keys)` → the entry key, `by(values)` →
  // the entry value, any other by → projected off the value (matches native).
  const entryKey = (by: By, entry: [unknown, unknown]): unknown => {
    if (by.kind === 'column') {
      return by.column === 'keys' ? entry[0] : entry[1];
    }

    return evalBy(by, entry[1], graph, ctx);
  };

  for (const t of stream) {
    const v = t.value;

    if (v instanceof Map) {
      const dirs = bys.map((by) => by.direction ?? (desc ? 'desc' : 'asc'));
      const keyed = [...v.entries()]
        .map((entry) => ({
          entry,
          keys: bys.map((by) => entryKey(by, entry)),
        }))
        // A by() yielding no value on an entry filters that entry out (as in global order()).
        .filter((k) => !k.keys.some((key) => key === NO_VALUE));

      keyed.sort((a, b) => {
        for (let i = 0; i < bys.length; i++) {
          const c = compareTotal(a.keys[i], b.keys[i]) * (dirs[i] === 'desc' ? -1 : 1);

          if (c !== 0) {
            return c;
          }
        }

        return 0;
      });

      yield extend(t, new Map(keyed.map((k) => k.entry)));
    } else if (isSliceable(v)) {
      yield extend(
        t,
        sortByBys([...v], (x) => x, bys, { desc }, graph, ctx),
      );
    } else {
      yield t;
    }
  }
};
