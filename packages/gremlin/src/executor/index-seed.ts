// Seed a `V()` / `E()` source from a property index instead of scanning every
// element.
//
// When a traversal opens `V()` or `E()` (no explicit ids) followed by a run of
// filter steps that only narrow the start set — `has` / `hasLabel` /
// `hasLabelAnd` / `hasId` / `hasKey` / `hasNot`, which commute freely — and one
// of them is an indexable property predicate on a graph-indexed key, we seed
// directly from that key's index bucket(s) rather than sweeping the whole
// source. The most selective seedable predicate (smallest candidate set) wins;
// every leading filter is re-applied as a residual, so the result still matches
// the scan.
//
// Seedable predicates, and whether the consumed `has` can be dropped:
//
//   eq / within  — bucket (or union of buckets) equals the predicate's match
//                  set exactly (both use `===`), so a plain `has` is dropped.
//   gt/gte/lt/lte/between/inside — seeded from the sorted range index. The
//                  index is *type-strict* (a numeric bound matches only numeric
//                  values, never JS-coercible strings like "40" > 30), which can
//                  differ from the unindexed scan for mixed-type data — a
//                  deliberate, documented consequence of declaring an index. The
//                  range `has` is kept as a residual rather than dropped.
//   startsWith   — a string prefix is the slice [prefix, succ(prefix)), seeded
//                  from the same sorted index and kept as a residual.
//
// A `hasLabelAnd` seed always keeps its step (the bucket doesn't encode the
// label half). Non-seedable predicates (neq, outside, without, the string/
// regex ops, not) stay as ordinary residual filters.

import type { Edge, Graph, IndexableValue, PropertyIndex, RangeBound, Vertex } from '@lenke/core';

import type { ID, Plan, Predicate, Step } from '../ast.js';
import { startTraverser, type Traverser } from './runtime.js';

/** Filter steps that only narrow the source set, so reordering them is safe. */
const COMMUTING_FILTERS = new Set<Step['kind']>([
  'has',
  'hasLabel',
  'hasLabelAnd',
  'hasId',
  'hasKey',
  'hasNot',
]);

const EMPTY: ReadonlySet<never> = new Set<never>();

/** A scalar the property index can seek on (mirrors PropertyIndex's IndexableValue).
 *  A type predicate so callers narrow: ordering predicates now admit temporals
 *  (`Orderable`), which the index cannot seek — those must decline the seed and
 *  fall back to a scan rather than being passed through as an index key. */
const isScalar = (v: unknown): v is IndexableValue =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && !Number.isNaN(v));

/**
 * A seedable predicate: its estimated cardinality (computed without touching
 * any set), a thunk that materializes the set only if this candidate is chosen,
 * and whether dropping its step leaves an equivalent plan.
 */
type Candidate<E> = { count: number; build: () => ReadonlySet<E>; removable: boolean };

/** Union the equality buckets for each value of a `within` list. */
const unionBuckets = <E>(
  index: PropertyIndex<E>,
  key: string,
  values: readonly unknown[],
): Set<E> => {
  const out = new Set<E>();

  for (const value of values) {
    for (const element of index.equals(key, value) ?? EMPTY) {
      out.add(element);
    }
  }

  return out;
};

/**
 * The exclusive upper bound of the strings sharing `prefix`: the prefix with
 * its last code unit incremented. `null` when there's no finite successor (an
 * empty prefix, or one ending in U+FFFF) — the caller then seeds with a lower
 * bound only.
 */
const prefixUpperBound = (prefix: string): string | null => {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const c = prefix.charCodeAt(i);

    if (c < 0xffff) {
      return prefix.slice(0, i) + String.fromCharCode(c + 1);
    }
  }

  return null;
};

/** A range candidate: cardinality from `countRange`, set built only on demand. */
const rangeCandidate = <E>(
  index: PropertyIndex<E>,
  key: string,
  bound: RangeBound,
): Candidate<E> | null => {
  const count = index.countRange(key, bound);

  return count === undefined
    ? null
    : { count, build: () => index.range(key, bound) ?? EMPTY, removable: false };
};

/**
 * The index seed for `pred` on `key`, or `null` when the predicate isn't
 * seedable. `removable` is whether dropping the owning step leaves an
 * equivalent plan — only an exact (eq/within) match on a plain `has`.
 */
const seedForPred = <E>(
  index: PropertyIndex<E>,
  key: string,
  pred: Predicate,
  plainHas: boolean,
): Candidate<E> | null => {
  switch (pred.op) {
    case 'eq': {
      if (!isScalar(pred.value)) {
        return null;
      }

      const { value } = pred;
      // ⚠️ REJECTED, WITH ITS NUMBERS (item 1594): holding the bucket here so the count and the
      // build share ONE lookup instead of two. `countEquals` fetches the bucket for its `.size`
      // and `build()` fetches the same bucket again — two `indexes.get(key)` plus two
      // `buckets.get(value)` per seek, and a string-keyed `Map.get` is ~190 ns in this repo
      // (item 194). A profile of the serving shape
      // `V().hasLabel(U).has(name, eq(v)).values(score)` put `countEquals` at **12.0% self**.
      //
      // It is FLAT. Five rounds each, 400,000 operations per round:
      //
      //     built fresh, varying key   PRE 2502-2700 ns   POST 2554-2802   overlapping
      //     built fresh, fixed key     PRE 2091-2304      POST 2088-2301   overlapping
      //
      // The change is semantically exact (`equals` returns the index's own live set, which is what
      // `countEquals` just looked up; and `bucket?.size ?? 0` equals `countEquals(...) ?? 0` for an
      // unindexed key, an indexed key with no match, and a non-indexable value alike), so this is
      // a cost result and not a correctness one. **A 12% SELF-TIME SHARE DID NOT CONVERT** —
      // item 1104's rule, that a share is a nomination and not a price, in a new place. At this
      // granularity V8 inlines these lookups and the sampled attribution is coarser than the
      // effect.

      return {
        count: index.countEquals(key, value) ?? 0,
        build: () => index.equals(key, value) ?? EMPTY,
        removable: plainHas,
      };
    }
    case 'within': {
      if (!pred.values.every(isScalar)) {
        return null;
      }

      const { values } = pred;
      let count = 0;

      for (const value of values) {
        count += index.countEquals(key, value) ?? 0;
      }

      return { count, build: () => unionBuckets(index, key, values), removable: plainHas };
    }
    case 'gt':
      return isScalar(pred.value) ? rangeCandidate(index, key, { gt: pred.value }) : null;
    case 'gte':
      return isScalar(pred.value) ? rangeCandidate(index, key, { gte: pred.value }) : null;
    case 'lt':
      return isScalar(pred.value) ? rangeCandidate(index, key, { lt: pred.value }) : null;
    case 'lte':
      return isScalar(pred.value) ? rangeCandidate(index, key, { lte: pred.value }) : null;
    case 'between':
      return isScalar(pred.min) && isScalar(pred.max)
        ? rangeCandidate(index, key, { gte: pred.min, lt: pred.max })
        : null;
    case 'inside':
      return isScalar(pred.min) && isScalar(pred.max)
        ? rangeCandidate(index, key, { gt: pred.min, lt: pred.max })
        : null;
    case 'startsWith': {
      // A prefix search is the string slice [prefix, succ(prefix)) — a range
      // the sorted index can seek. Kept as a residual filter.
      if (typeof pred.value !== 'string') {
        return null;
      }

      const upper = prefixUpperBound(pred.value);

      return rangeCandidate(
        index,
        key,
        upper === null ? { gte: pred.value } : { gte: pred.value, lt: upper },
      );
    }
    default:
      return null;
  }
};

/**
 * The seed a single leading filter step offers, if any.
 *
 * EXPORTED so a count shortcut can ask whether the index would seed this filter WITHOUT building
 * the seed: `countShortcut` runs before `seedFromIndex`, so a shortcut that scans would preempt a
 * seek and answer in O(V) where the general path answers in O(matches). ~~The `count` on the
 * returned candidate is an O(1) estimate and `build()` is not called, so asking costs nothing~~
 * (audit item 234; the failure it avoids is item 149's, where a fast path lost the index and the
 * tell was two identical `bench:usage` columns).
 *
 * ⚠️ **THE "O(1) ESTIMATE … ASKING COSTS NOTHING" CLAIM IS FALSE FOR A RANGE PREDICATE** (item
 * 1757). It holds for `eq`/`within`, whose `countEquals` is a bucket-size read — but a range
 * candidate's count comes from `countRange`, which is **O(distinct values in range)**. On a
 * high-cardinality column that is not an estimate, it is most of the query: measured at 20,000
 * vertices with `n` unique, `V().hasLabel('P').has('n', lt(10000)).count()` runs **127.2 µs with
 * NO index and 644.7 µs with one — 5.07x SLOWER** — while the same shape on the 97-value column
 * goes the right way (203.8 -> 124.7). GQL had the same defect and item 1756 fixed it by capping
 * the count at the gate's own threshold; the twin fix here is described in that item's entry and
 * is NOT yet built.
 */
export const seedForStep = <E>(step: Step, index: PropertyIndex<E>): Candidate<E> | null => {
  if (step.kind !== 'has' && step.kind !== 'hasLabelAnd') {
    return null;
  }

  if (!index.isIndexed(step.key)) {
    return null;
  }

  const seed = seedForPred(index, step.key, step.pred, step.kind === 'has');

  // A `hasLabelAnd` carries a label constraint the bucket doesn't capture, so
  // its step can never be dropped.
  return seed && step.kind === 'hasLabelAnd' ? { ...seed, removable: false } : seed;
};

export type SeededPlan = {
  stream: Iterable<Traverser<unknown>>;
  /** The residual steps to apply (source — and maybe one `has` — removed). */
  steps: readonly Step[];
};

/** Seed the residual `rest` steps from `index`, or `null` to fall back. */
/**
 * A single-label `hasLabel(L)` as a seed: the label's BUCKET is exactly the elements carrying it,
 * so the step is removable and the source becomes O(bucket) instead of O(V).
 *
 * WHY THIS IS HERE. `hasLabel` has always been a COMMUTING_FILTER — it could be reordered and
 * re-applied — but nothing made it a SOURCE, so `V().hasLabel(L)` scanned every vertex and
 * filtered. The traverser pipeline costs ~40-70 ns a vertex PER STEP (item 537's ladder), so a
 * label that excludes nothing was a tax on every terminal. Measured at 200,000 vertices all
 * carrying `Person`, one case per process (item 538):
 *
 * ```text
 *   V().has(age, gt(44)).values('age')                      17.58 ms
 *   V().hasLabel('Person').has(age, gt(44)).values('age')   29.69       +12.1
 *   V().has().groupCount(by: age)                            6.45
 *   V().hasLabel().has().groupCount(by: age)                13.94       + 7.5
 *   V().has().dedupe().count()                              14.15
 *   V().hasLabel().has().dedupe().count()                   28.01       +13.9
 * ```
 *
 * Item 537 fixed the `count()` terminal with a tally; this is the general form, and it reaches
 * every terminal because it removes the step rather than replacing the walk.
 *
 * MULTI-LABEL declines: `hasLabel(a, b)` keeps an element carrying EITHER, and an element may
 * carry both, so the union is not a bucket and not a sum.
 *
 * ⚠️ This used to add that "`labelledCount` in the count shortcut declines it for exactly the same
 * reason", and since item 1382 it does not — `labelledCount` counts the UNION instead. The decline
 * here is unaffected: seeding has to hand back an ENUMERATION of the elements, and a union count is
 * a number. Deduping an enumeration across buckets is a different and more expensive question than
 * counting one, which is why the two diverge.
 *
 * ORDER. Seeding changes the order elements are emitted in — the bucket's rather than the id
 * map's. That is not a contract: TinkerPop leaves `g.V()`'s order unspecified, this repo treats
 * an unordered result's order as WON'T-FIX, and the cross-engine Gremlin fuzzer compares such
 * results as MULTISETS (`deepSort`, skipped only when the plan has an explicit `order()`). The
 * property seeds beside this one have always reordered the source the same way.
 */
const labelSeed = <E>(
  step: Step,
  bucketOf: ((label: string) => ReadonlySet<E> | undefined) | undefined,
): Candidate<E> | null => {
  if (bucketOf === undefined || step.kind !== 'hasLabel' || step.labels.length !== 1) {
    return null;
  }

  const bucket = bucketOf(step.labels[0]);

  // A label nothing carries seeds the EMPTY set, which is the right answer and cheaper than a
  // scan that will reject every element.
  if (bucket === undefined) {
    return { count: 0, build: () => EMPTY, removable: true };
  }

  return { count: bucket.size, build: () => bucket, removable: true };
};

/**
 * `hasId(a, b, …)` seeded from the ID MAP instead of scanned (item 1306).
 *
 * This is the most selective seed there is — the candidate set is at most the number of ids
 * written — and it was missing, so the one spelling whose cost should be independent of graph size
 * grew with it. Measured on the Gremlin spelling probe at 200,000 vertices / 400,000 edges, three
 * isolated runs each, both spellings answering identically:
 *
 * ```text
 *   V('v137').count()              0.008 ms      vs  V().hasId('v137').count()      5.79 ms
 *   E('e137').count()              0.008 ms      vs  E().hasId('e137').count()     12.0 ms
 *   V('v137').values('age')                      vs  V().hasId('v137').values('age')
 * ```
 *
 * 757-930x on vertices, 1462-1796x on edges, 625-713x projected. `hasId` is the spelling a user
 * reaches for when the id arrives as a FILTER rather than as a seed — from a `where`, or after a
 * hop — so it is not an exotic form.
 *
 * ⚠️ THE SELECTION MUST MATCH `hasId`'s FILTER EXACTLY, and two details decide it.
 *
 * **Equality.** `dispatch.ts` filters with `step.ids.includes(v.id)`, which is SameValueZero;
 * `Map.get` is also SameValueZero, so a map lookup selects precisely the elements the filter keeps.
 *
 * **A NON-STRING id must NOT raise here.** Element ids in this engine are strings, and
 * `applySource`'s `asStringId` THROWS for `V(5)` — deliberately, matching TinkerPop's string id
 * manager. But `V().hasId(5)` does not throw: `includes` simply never matches, and the answer is
 * empty. So this seed goes through the raw id MAP with an explicit `typeof` guard, never through
 * `getVertexById`/`asStringId`, or it would convert an empty result into a fault. That asymmetry
 * is also why `V() + hasId(ids)` is NOT rewritten into the seeded source `V(ids)`, which would
 * have reached every rung at once: besides the raise, `sourceFromIds` does not DEDUPE, so
 * `V('a','a')` yields the element twice where `hasId('a','a')` yields it once. Two different
 * answers, and the faster-looking rewrite is the wrong one.
 *
 * Hence `removable: true` only because the `Set` below dedupes and the lookup is exact: the seeded
 * set IS the filter's output, so dropping the step cannot change the answer.
 *
 * `hasId()` with NO ids seeds the empty set, which is the right answer — `includes` is false for
 * every element — and cheaper than a scan that rejects all of them. `count` is `ids.length`, an
 * UPPER bound (ids may repeat or be absent), which is what a selectivity estimate wants.
 */
/**
 * The step-kind sequences whose observable does not depend on the order of what feeds them.
 *
 * ONE list serving TWO callers with DIFFERENT premises, which is worth stating because the
 * premises are not interchangeable:
 *
 * - `fuseUnionBoth` (item 1311) rewrites `union(out, in)` to `both`, which is MULTISET-equal but
 *   not sequence-equal — `both` finishes each vertex before moving on and the union does not. Only
 *   a tail that reads the multiset rather than the sequence may ride that.
 * - `idSeed`'s multi-id arm (item 1317) seeds from a SET of ids, which is SET-equal to the scan it
 *   replaces and merely reordered. That is a stronger relation than multiset-equal, so every tail
 *   admissible for the union is admissible here too.
 *
 * `count` reads the multiset. `dedupe` then `count` reads the SET, coarser still. Both were
 * verified for item 1311 on a fixture carrying PARALLEL edges, a MULTI-LABEL edge and a SELF-LOOP.
 *
 * `sum` and `mean` are deliberately ABSENT even though they look order-free: this repo records
 * them as order-sensitive in the last ulp (`foldFor`'s own note), so a reordering IS observable in
 * floating point. `min`/`max` would be safe but are not in either measured shape, so they are not
 * admitted on a guess.
 *
 * A SINGLE HOP before the count is admitted at item 1318, and the argument is one line: applying
 * a hop elementwise sums each element's own neighbours, so the result multiset is the sum over the
 * input multiset and does not depend on the input's ORDER. `count` then reads that multiset. This
 * holds for both callers' premises — multiset-equal is enough, which is why the union caller can
 * ride it too.
 *
 * Measured per hop rather than as a family, item 1318, 200,000 vertices, against the single-id
 * seed that already feeds a hop at 0.0108 ms:
 *
 *     hasId(3 ids).out(T).count()    6.64524 ms   616x
 *     hasId(3 ids).in(T).count()     4.11208      381x
 *     hasId(3 ids).both(T).count()   3.96934      368x
 *
 * `[hop, dedupe, count]` JOINED AT ITEM 1327, which is the evidence item 1318 asked for before
 * growing this list. It had been left out as "sound but unmeasured", and the decline cost 328x:
 *
 *     hasId(3 ids).out(T).count()            0.0210 ms   admitted at item 1318
 *     hasId(3 ids).out(T).dedupe().count()   6.8937      the decline, 328x
 *     hasId(3 ids).both(T).dedupe().count()  6.8622
 *     hasId(1 id).out(T).dedupe().count()    0.0260      a single id never needed the tail
 *
 * Sound, and the argument finishes where item 1314's rule points: the seeded and scanned frontiers
 * are the same SET, a hop sums each element's own neighbours irrespective of input order, `dedupe`
 * reduces that multiset to a SET, and `count` reads only its size. `dedupe` keeps the FIRST
 * occurrence, so the surviving elements' ORDER does differ between the two spellings — and a
 * `count` tail cannot observe that, which is exactly what "the tail may only observe what both
 * spellings agree on" requires.
 */
/**
 * The step kinds that cannot observe the ORDER of what feeds them, as an ALLOW-LIST.
 *
 * ITEM 1328 REPLACED AN ENUMERATED LIST WITH THIS RULE, because the list was turning
 * combinatorial: items 1318 and 1327 had grown it to eight entries and the measured family kept
 * extending — `[out, out, count]` at 224x and `[out, out, out, count]` at 352x were both still
 * declining, and `[out, out, dedupe, count]` with them.
 *
 * THE RULE: a tail is order-free when every step in it is listed here AND it ENDS in `count`.
 *
 * - a HOP (`out`/`in`/`both`) applied elementwise sums each element's own neighbours, so the
 *   result multiset is the sum over the input multiset and does not depend on its order
 *   (item 1318, measured per hop);
 * - `dedupe` reduces a multiset to a SET, coarser still (item 1327, 225x);
 * - `count` reads only a size.
 *
 * AN ALLOW-LIST AND NOT A DENY-LIST, and that is the whole safety argument: an unknown or newly
 * added step kind DECLINES by default. A deny-list would admit it silently, and the cost of being
 * wrong here is a reordering that no answer test can see. `take`/`range`/`order` read the
 * SEQUENCE; `values` emits per value rather than per element (item 1314); a path-dependent step
 * observes the walk itself. None are listed, so all of them decline — as do order-preserving
 * FILTERS such as `has`, which would be sound and have no measurement behind them yet.
 */
const ORDER_FREE_STEPS: ReadonlySet<Step['kind']> = new Set<Step['kind']>([
  'out',
  'in',
  'both',
  'dedupe',
]);

/**
 * Does the run of `steps` starting at `from` match an order-free tail?
 *
 * Takes an INDEX rather than a sliced array deliberately: `seedRest` asks this once per leading
 * filter of every traversal, so a `slice` would allocate on a path every query takes, and
 * comparing in place costs nothing.
 *
 * Structural, NOT a measured win. The first cut did slice, and a declined arm read 3.70 then 6.04
 * ms across runs — which looked like the allocation and was not: removing it left the same number.
 * Those were single runs either side of the noise floor, and the A/B's control band is what
 * settles whether anything moved. Kept because allocating per filter per query is worth avoiding
 * on its own terms, with no performance claim attached.
 */
export const tailIsOrderFreeFrom = (steps: readonly Step[], from: number): boolean => {
  // A tail must END in `count`: that is what makes the order unobservable rather than merely
  // reordered. An empty tail is not order-free — it returns the elements themselves.
  if (from >= steps.length || steps[steps.length - 1].kind !== 'count') {
    return false;
  }

  for (let k = from; k < steps.length - 1; k++) {
    if (!ORDER_FREE_STEPS.has(steps[k].kind)) {
      return false;
    }
  }

  return true;
};

/** The whole-array form, for `fuseUnionBoth`, which already holds a slice. */
export const tailIsOrderFree = (tail: readonly Step[]): boolean => tailIsOrderFreeFrom(tail, 0);

const idSeed = <E>(
  step: Step,
  byId: ((id: ID) => E | undefined) | undefined,
  tailOrderFree: boolean,
): Candidate<E> | null => {
  // EXACTLY ONE ID, and the restriction is about ORDER rather than about mechanism.
  //
  // `hasId` is a FILTER over the source, so it emits in the source's order. With several ids the
  // seed would emit in the order they were WRITTEN, and `hasId.test.ts`'s "we can filter by ids
  // out of order" asserts precisely the opposite: `hasId('6','2','1','4')` must come back
  // `['1','2','4','6']`. That test is named for the behaviour, so it is a pinned contract and not
  // an incidental assertion — the general "an unordered result's order is WON'T-FIX" policy does
  // not license an optimization to quietly overturn a case someone wrote down on purpose.
  //
  // With ONE id the question cannot arise: one element has one position, so the seeded output and
  // the scanned output are identical sequences, and this is the shape the whole measured win is in
  // (the spelling probe's lookups are single-id).
  //
  // THE MULTI-ID CASE IS THEREFORE A DELIBERATE DECLINE, not an oversight, and it is worth the
  // same 757-1796x if it is ever taken. Taking it needs a decision about that order — made against
  // TinkerPop ground truth (`podman run -i docker.io/tinkerpop/gremlin-console:3.7.3`), not as a
  // side effect of a perf change — and then that test updated in the same commit.
  // ITEM 1317 NARROWS THAT DECLINE RATHER THAN REVERSING IT. The blocker above is about ORDER, so
  // it does not apply where the order is not observable: under an order-free tail the seeded and
  // scanned paths yield the same SET and differ only in sequence, and the tail reads neither.
  // `hasId('6','2','1','4').count()` is 4 either way, so no TinkerPop ground-truth decision is
  // needed and `hasId.test.ts`'s "out of order" case keeps its contract untouched — it has no such
  // tail. The bare multi-id `hasId` remains declined, exactly as above.
  //
  // Measured at 200,000 vertices, against the single id this already seeded (0.01739 ms):
  //   hasId(3 ids).count()            6.28732 ms   362x
  //   hasId(3 ids).dedupe().count()   3.63495      209x
  if (byId === undefined || step.kind !== 'hasId') {
    return null;
  }

  if (step.ids.length !== 1 && !(tailOrderFree && step.ids.length > 1)) {
    return null;
  }

  // An id nothing carries contributes nothing, which is the right answer and cheaper than a scan
  // that will reject every element — the same shape as `labelSeed`'s missing-bucket case. The
  // `Set` also collapses a REPEATED id, so `hasId('a','a').count()` is 1 rather than 2, matching
  // the filter it replaces.
  const found = new Set<E>();

  for (const id of step.ids) {
    const element = byId(id);

    if (element !== undefined) {
      found.add(element);
    }
  }

  return found.size === 0
    ? { count: 0, build: () => EMPTY, removable: true }
    : { count: found.size, build: () => found, removable: true };
};

/** Native's `SEEK_MAX_FRACTION` and GQL's twin of it; see {@link seekIsWorthIt}. */
const SEEK_MAX_FRACTION = 1 / 8;

/** Native's floor, and GQL's: below this, keep the existing behaviour rather than churn plans. */
const SEEK_FLOOR_ELEMENTS = 4_096;

/**
 * Is materializing an index seek of `count` elements worth it against a `scan` of that many?
 *
 * **THE THIRD COPY OF ONE RULE, and Gremlin was the one missing it (item 1322).** Native has had
 * `SEEK_MAX_FRACTION` throughout; GQL's `seekIsWorthIt` was added at item 409 as "the missing
 * twin"; `seedRest` had NO selectivity gate at all and took any seek that was merely the most
 * selective candidate, however unselective that was in absolute terms.
 *
 * That is not a missed optimization but a PATHOLOGY: adding an index made a query slower. Measured
 * at 200,000 vertices, `V().hasLabel('P').has('age', gt(45)).count()` where the predicate keeps
 * ~49% of rows:
 *
 *     with an index on `age`     14.457 ms      the seek is taken and materialized
 *     with NO index               2.891 ms      the scan runs
 *     GQL, same question, index   3.853 ms      its gate declines the seek
 *
 * So the index cost 5x. Item 409's own seek/scan table predicted exactly this — `1% 0.06, 8% 0.23,
 * 30% 1.96, 60% 5.02` — and its note says "with no gate at all the seek was still chosen at 60%,
 * where it is 5.02x SLOWER".
 *
 * Sound by construction, the same way GQL's is: the seed only has to be a SUPERSET, because the
 * declined filters stay in the plan as residuals and re-validate every element. So this changes
 * which plan runs and never which rows come back.
 */
const seekIsWorthIt = (count: number, scan: number, total: number): boolean => {
  // GQL's twin opens with a `count > scan` refusal here (item 176's rule). IT IS DEAD CODE IN
  // THIS COPY, proved by mutation: deleting it changed no test, and the reason is structural
  // rather than a coverage gap.
  //
  //   - When `seedRest` has an EXACT alternative, `scan` is that candidate's count, and the guard
  //     fires only for `count > exact.count` — a case the later `exact.count < best.count`
  //     comparison already resolves in the bucket's favour.
  //   - When there is no exact alternative, `scan` is the whole source, and a seek cannot return
  //     more elements than exist, so the condition is unreachable.
  //
  // GQL needs it because `seedVertices` has no such second comparison: it takes `best` or scans.
  // Carried as a comment rather than as a branch, because a dead guard reads as a live one
  // (item 1313).

  // BELOW THE FLOOR the choice is unmeasurable, so keep the existing behaviour rather than churn
  // the plan. GQL records that omitting this flipped NINE of its tests, on fixtures of a handful
  // of elements where two matches are 20% of the bucket and the ratio means nothing.
  if (total < SEEK_FLOOR_ELEMENTS) {
    return true;
  }

  return count <= scan * SEEK_MAX_FRACTION;
};

/**
 * Would an index seek on `step` actually be TAKEN, rather than merely being possible?
 *
 * `count-shortcut.ts` declines its own fast path wherever a leading filter is seedable, on the
 * assumption that the seed is the better plan. Once {@link seekIsWorthIt} can refuse an
 * unselective seek that assumption breaks: the shortcut bows out, the seed declines too, and the
 * query lands on the GENERAL path — slower than the shortcut it just gave up. Measured at 200,000
 * vertices on `V().has('age', gt(45)).count()`, ~49% selective:
 *
 *     no index                      2.179 ms   the count shortcut runs
 *     indexed, seek ungated        14.457      the seek is materialized
 *     indexed, seek gated only      5.433      neither fast path runs
 *
 * So the gate has to be asked the same question in both places, and `seedForStep(...) !== null`
 * is the wrong question. An index on a key the query does NOT filter costs 1.03x, which is how
 * the cost was localized here rather than to heap or cache pressure.
 *
 * The scan is the whole source at these call sites: the shortcut's own fallback walks
 * `verticesById`, not a label bucket.
 */
export const seekWorthTaking = <E>(
  step: Step,
  index: PropertyIndex<E>,
  sourceSize: number,
): boolean => {
  const candidate = seedForStep(step, index);

  return candidate !== null && seekIsWorthIt(candidate.count, sourceSize, sourceSize);
};

const seedRest = <E>(
  rest: readonly Step[],
  index: PropertyIndex<E>,
  tracksPath: boolean,
  // How many elements the source would iterate if nothing seeds — the denominator the gate needs.
  sourceSize: number,
  bucketOf?: (label: string) => ReadonlySet<E> | undefined,
  byId?: (id: ID) => E | undefined,
): SeededPlan | null => {
  // Estimate each seedable leading filter's cardinality (no set built yet) and
  // pick the most selective. The other filters stay in the plan as residuals,
  // so they still narrow the seed before any downstream step runs — only the
  // winner is materialized.
  let bestAt = -1;
  let best: Candidate<E> | null = null;
  // Tracked SEPARATELY from `best` because the gate applies to an index SEEK and not to a label
  // bucket or an id lookup: those are EXACT and cost one map read, so they are worth taking at any
  // selectivity — and one of them is also the fallback an unworthy seek is judged against.
  let exactAt = -1;
  let exact: Candidate<E> | null = null;
  let seekAt = -1;
  let seek: Candidate<E> | null = null;

  for (let i = 0; i < rest.length; i++) {
    const step = rest[i];

    if (!COMMUTING_FILTERS.has(step.kind)) {
      break;
    }

    const fromIndex = seedForStep(step, index);

    if (fromIndex !== null && fromIndex.count < (seek?.count ?? Infinity)) {
      seek = fromIndex;
      seekAt = i;
      continue;
    }

    if (fromIndex !== null) {
      continue;
    }

    // The tail is judged from AFTER this step, which is what the seed would reorder. Residual
    // filters that remain ahead of the tail preserve order, so they cannot make an order-free
    // tail order-sensitive — but they are not in `ORDER_FREE_TAILS`, so such a plan simply
    // declines rather than relying on that reasoning.
    const candidate =
      labelSeed(step, bucketOf) ?? idSeed(step, byId, tailIsOrderFreeFrom(rest, i + 1));

    if (candidate && candidate.count < (exact?.count ?? Infinity)) {
      exact = candidate;
      exactAt = i;
    }
  }

  // The scan an unworthy seek falls back to: the cheapest EXACT seed if there is one, else the
  // whole source. Not `sourceSize` unconditionally, because a `hasLabel` beside the seek means
  // the fallback is that bucket rather than every element.
  const scan = exact?.count ?? sourceSize;

  if (seek !== null && seekIsWorthIt(seek.count, scan, sourceSize)) {
    best = seek;
    bestAt = seekAt;
  }

  if (exact !== null && exact.count < (best?.count ?? Infinity)) {
    best = exact;
    bestAt = exactAt;
  }

  if (!best) {
    return null;
  }

  const set = best.build();
  const stream = (function* () {
    for (const element of set) {
      yield startTraverser(element, tracksPath);
    }
  })();

  const steps = best.removable ? rest.filter((_, i) => i !== bestAt) : rest;

  return { stream, steps };
};

/**
 * If `plan` opens `V()` or `E()` and a leading filter is seedable from the
 * matching property index, return the seed stream plus the residual steps;
 * otherwise `null` to fall back to a normal scan.
 */
export const seedFromIndex = (plan: Plan, graph: Graph, tracksPath: boolean): SeededPlan | null => {
  const [source, ...rest] = plan.steps;

  if (!source) {
    return null;
  }

  if (source.kind === 'V' && !source.ids) {
    return seedRest<Vertex>(
      rest,
      graph.vertexPropertyIndex,
      tracksPath,
      graph.verticesById.size,
      (l) => graph.verticesByLabel.get(l),
      // The RAW map, not `getVertexById`: see `idSeed` on why a non-string id must come back
      // empty here rather than raising the way `V(5)` does.
      (id) => (typeof id === 'string' ? graph.verticesById.get(id) : undefined),
    );
  }

  if (source.kind === 'E' && !source.ids) {
    // The EDGE twin of the vertex seed above, and sound for the same reason: a type's bucket is
    // exactly the edges carrying it, so a single-label `hasLabel(T)` is removable. A two-type
    // edge sits in BOTH buckets and `hasLabel(T)` keeps it, so the bucket is still exact — the
    // multi-type hazard belongs to SUMMING buckets (`adjacentCount`), not to reading one.
    //
    // Item 538 shipped the vertex half and left this out; its own test asserted "an EDGE source
    // has no label bucket to seed from" as a limitation. Measured at 500,000 edges, half of them
    // `KNOWS`, one case per process (item 542):
    //
    //   E().has(w, gt(3)).count()                      35.66 ms
    //   E().hasLabel('KNOWS').has(w, gt(3)).count()    62.65
    //   E().values('w')                                47.43   (500,000 rows)
    //   E().hasLabel('KNOWS').values('w')              64.58   (250,000 rows — HALF the rows
    //                                                           and more time)
    return seedRest<Edge>(
      rest,
      graph.edgePropertyIndex,
      tracksPath,
      graph.edgesById.size,
      (l) => graph.edgesByLabel.get(l),
      (id) => (typeof id === 'string' ? graph.edgesById.get(id) : undefined),
    );
  }

  return null;
};
