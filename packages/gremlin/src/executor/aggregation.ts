import { type Graph, isElement } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { By, Step } from '../ast.js';
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
import {
  allPlainStringKeys,
  allPlainStrings,
  reducedKeyComparator,
  reducedValueComparator,
} from './sort-key-specialize.js';

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

/**
 * `values(k)` FUSED WITH its terminal aggregate — one generator over the element stream instead of
 * two, and no intermediate traverser per element (item 1586).
 *
 * ### Why, with the ceiling measured first
 *
 * Item 1585 established that every Gremlin terminal costs what `values(k)` alone costs, and that
 * 75.8% of the profile is three generator frames. A ladder from a hand-written loop up to the real
 * traversal priced what a fusion could recover, over 50,000 vertices
 * (`gremlin-agg-ceiling-probe.mjs`):
 *
 * ```text
 *   rawloop    iterate, read props, reduce          ~1.0 ms   (bimodal 0.4-0.6 / 0.9-1.3)
 *   rawgetter  same, through the properties getter    0.96     the getter is FREE
 *   rawtyped   same, plus the isVertex/isEdge tests   0.98     the guards are FREE
 *   gentwo     the same work across TWO yields        ~1.5     the BOUNDARIES cost ~0.5
 *   gremlin    the real traversal                     ~2.18
 * ```
 *
 * So the guards and the property read are not the cost; the generator boundaries and the
 * per-element traverser are. That is what this removes, and the ladder is why it was worth doing
 * against `executor-edits-perturb`'s 16% — the alternative, a numeric fast path in
 * `aggregateComparable`, was priced at only ~1.18x and on `min`/`max` alone.
 *
 * ### What it must preserve, exactly
 *
 * Nothing here re-derives a semantic; each line mirrors the pair it replaces.
 *
 *   - `projectValues`: only a VERTEX or EDGE contributes, and only when the key is PRESENT. A
 *     missing key emits nothing, so it must not reach the reduce as a null.
 *   - `aggregateComparable`: the engine's TOTAL order via `compareTotal`, so strings, booleans and
 *     mixed streams work; nulls are skipped; NaN is greatest and equal to itself; an empty stream
 *     yields ONE null traverser rather than nothing.
 *   - `aggregateNumber`: `asNumber` THROWS on a non-number (TinkerPop raises rather than coercing),
 *     and `mean` divides by the count of non-null values.
 *
 * ⚠️ ONE KEY ONLY. `values(j, k)` emits one value PER KEY per element, so a single accumulator
 * would silently count differently — the same non-equivalence `fuseValuesIsCount` refuses.
 */
/**
 * Is this step pair `values(k)` + a global terminal aggregate — the shape {@link
 * fusedValuesAggregate} replaces? `undefined` means "not this shape", and the ordinary dispatch
 * runs unchanged.
 *
 * ⚠️ ONE KEY ONLY. `values(j, k)` emits one value PER KEY per element, so a single accumulator
 * would silently aggregate differently — the same non-equivalence `fuseValuesIsCount` refuses.
 */
export const fusableValuesAggregate = (
  step: Step,
  next: Step | undefined,
): { readonly key: string; readonly kind: 'min' | 'max' | 'sum' | 'mean' } | undefined => {
  if (step.kind !== 'values' || step.keys.length !== 1 || next === undefined) {
    return undefined;
  }

  const { kind } = next;

  if (kind !== 'min' && kind !== 'max' && kind !== 'sum' && kind !== 'mean') {
    return undefined;
  }

  // These carry a SCOPE in this surface; per-traverser (`local`) aggregation has its own helpers
  // below, and a non-global scope is a different question.
  if ('scope' in next && next.scope !== undefined && next.scope !== 'global') {
    return undefined;
  }

  return { key: step.keys[0], kind };
};

/** What `normalizeBys` supplies for a bare `order()`; shared so the fusion allocates none. */
const IDENTITY_BYS: readonly By[] = [{ kind: 'identity' }];

export const fusedValuesAggregate = function* (
  stream: Iterable<Traverser<unknown>>,
  key: string,
  kind: 'min' | 'max' | 'sum' | 'mean',
): Iterable<Traverser<unknown>> {
  const numeric = kind === 'sum' || kind === 'mean';
  let best: unknown;
  let sum = 0;
  let count = 0;
  let sawNonNull = false;

  for (const t of stream) {
    const el = t.value;

    // `isElement` rather than two `isVertex`/`isEdge` calls: the pair's guard accepts either, and
    // the ceiling ladder measured the guard as free, so this is for brevity and not for speed.
    if (!isElement(el)) {
      continue;
    }

    const props = el.properties;

    // ⚠️ THIS GUARD IS CURRENTLY REDUNDANT, AND IT STAYS. Mutation says so rather than reading:
    // removing it SURVIVED the whole suite, because a missing key reads as `undefined` and the very
    // next test (`v == null`) skips it. So for these four terminals "absent" and "present null" are
    // indistinguishable.
    //
    // It is kept because it is ONE RELAXATION away from a wrong answer, which is item 1483's
    // standard for a surviving guard: `values(k)` emits NOTHING for a missing key and a NULL for a
    // present null, and the moment a terminal that can tell those apart joins the fused set —
    // `count` and `fold` both can — this line is what makes it right. Recorded so the next reader
    // does not have to re-run the mutant to learn it is deliberate.
    if (!(key in props)) {
      continue;
    }

    const v = props[key];

    if (v == null) {
      continue;
    }

    if (numeric) {
      sawNonNull = true;
      sum += asNumber(v);
      count += 1;
      continue;
    }

    if (!sawNonNull) {
      best = v;
      sawNonNull = true;
      continue;
    }

    const c = compareTotal(v, best);

    if (kind === 'min' ? c < 0 : c > 0) {
      best = v;
    }
  }

  if (!sawNonNull) {
    yield startTraverser(null);

    return;
  }

  if (kind === 'sum') {
    yield startTraverser(sum);
  } else if (kind === 'mean') {
    yield startTraverser(sum / count);
  } else {
    yield startTraverser(best);
  }
};

/**
 * `values(k)` fused with a CAPPED `order()` — the top-k over a property stream, read straight off
 * the elements (item 1591).
 *
 * Item 1586 fused `values(k)` with the reducing terminals; `order()` was left out because its
 * terminal is not a reduce. But `fuseOrderTake` (item 1574) folds a following `take(n)` into the
 * order as a `cap`, so a capped order IS bounded and can be driven the same way.
 *
 * ⚠️ WHY, and it is the fast side that named the target (item 1590's method). GQL answers
 * `RETURN n.k ORDER BY k LIMIT 10` in 0.935 ms against Gremlin's 3.479 — the biggest ABSOLUTE
 * cross-surface gap left. Profiling the SLOW side then showed where its time goes, and it is not
 * the sort: `streamTopByBys` is 23.2% while the generator chain feeding it is **48.6%**
 * (`projectValues` 21.6%, `sourceFromIds` 12.8%, `extend` 4.8%, `get properties` 3.7%, `isElement`
 * 3.5%, `startTraverser` 2.7%). GQL's route reads properties in a scan with no traverser at all and
 * rejects most values in O(1) against its heap root (`boundedTopKeyed` / `beatsRoot`).
 *
 * So this removes one generator boundary and the per-element traverser, and reuses
 * `streamTopByBys` rather than re-deriving a heap — it is generic over its item type, so raw
 * VALUES go through it with an identity projection. Re-implementing the heap to shave the per-entry
 * key array would duplicate ~100 lines of tie-breaking and bounds logic, which is where a top-k
 * goes wrong silently.
 *
 * Semantics are the pair's, not a new set: `values(k)` contributes one value per element that HAS
 * the key (a missing key emits nothing, a present null emits a null), and the order is
 * `compareTotal`'s total order via the identity `by` that `normalizeBys` already supplies for a
 * bare `order()` — so nulls sort FIRST, as Gremlin's comparator documents.
 */
export const fusedValuesTopK = function* (
  stream: Iterable<Traverser<unknown>>,
  key: string,
  opts: { readonly desc: boolean; readonly cap: number },
  graph: Graph,
  ctx: RunContext,
): Iterable<Traverser<unknown>> {
  // A generator, NOT an array: the whole point of a capped order is that the stream is never
  // materialised, which item 1576 established for this shape.
  const values = function* (): Iterable<unknown> {
    for (const t of stream) {
      const el = t.value;

      // ⚠️ THIS GUARD IS UNREACHABLE TODAY, and it stays. Mutation says so rather than reading:
      // removing it SURVIVED, because `assertFrontierTypes` rejects `values()` on a non-element
      // frontier at PLAN time — `inject(5).values('k')` raises "values() reads from a graph
      // element, but the frontier is a projected…" before any of this runs. So the guard defends
      // against a shape a static check already prevents.
      //
      // It is kept because the static check is a SEPARATE mechanism that could narrow, and without
      // the guard this reads `.properties` off a number and throws from deep in a generator rather
      // than at the surface. `fusedValuesAggregate` above has the same guard for the same reason.
      // The parse-time-vs-runtime confusion is worth naming explicitly: a test of this guard would
      // pass because of the frontier check and not because of the guard, which is exactly how item
      // 1576 shipped a test that covered nothing.
      if (!isElement(el)) {
        continue;
      }

      const props = el.properties;

      if (key in props) {
        yield props[key];
      }
    }
  };

  for (const v of streamTopByBys(values(), (x) => x, IDENTITY_BYS, opts, graph, ctx)) {
    yield startTraverser(v, false);
  }
};

/**
 * Is this pair `values(k)` + a capped global `order()` — the shape {@link fusedValuesTopK}
 * replaces? `undefined` means "not this shape".
 *
 * ⚠️ A CAP IS REQUIRED. An uncapped `order()` sorts the whole stream, so there is nothing to bound
 * and the fusion would have to materialise — exactly what it is meant to avoid. The cap arrives
 * from `fuseOrderTake`, which runs earlier in `effectivePlan`, so this pass sees it already folded.
 */
export const fusableValuesTopK = (
  step: Step,
  next: Step | undefined,
): { readonly key: string; readonly desc: boolean; readonly cap: number } | undefined => {
  if (step.kind !== 'values' || step.keys.length !== 1 || next?.kind !== 'order') {
    return undefined;
  }

  // A `key` is the legacy single-key form, which projects a sort key off each item — a different
  // question. `local` sorts within each value rather than across the stream. And no cap means
  // nothing to bound.
  if (next.cap === undefined || next.scope === 'local' || next.key !== undefined) {
    return undefined;
  }

  // ⚠️ `bys` IS ADMITTED WHEN IT IS EXACTLY ONE IDENTITY BY, and finding that out is why this
  // reads the way it does. `order()` bare arrives with no `bys` at all, but the natural DESCENDING
  // spelling — `order().by(Order.desc)` — arrives as `bys: [{kind:'identity', direction:'desc'}]`.
  // The first version of this gate refused any `bys`, which made the `desc` parameter below DEAD
  // CODE: the descending form silently took the unfused path, and the tests covering it passed
  // through that path while appearing to exercise this one.
  //
  // An identity by with a direction still means "sort by the value itself", which is this shape. A
  // by of any other kind projects a different sort key and declines.
  const desc = identityOrderDesc(next);

  if (desc === undefined) {
    return undefined;
  }

  return { key: step.keys[0], desc, cap: next.cap };
};

/**
 * Does this `order` sort by the VALUE ITSELF, and in which direction? `undefined` means it does
 * not — a `by` of any other kind projects a different sort key, which is a different question.
 *
 * ⚠️ SHARED BY TWO GATES ON PURPOSE. Item 1591's first version of this logic refused any `bys` at
 * all, which made its own `desc` parameter DEAD CODE: `order().by(Order.desc)` arrives as
 * `bys: [{kind:'identity', direction:'desc'}]`, not as `desc: true`, so the descending spelling
 * silently took the unfused path while the tests covering it appeared to exercise the fused one.
 * One copy means item 1630's gate cannot repeat that independently.
 */
const identityOrderDesc = (next: Extract<Step, { kind: 'order' }>): boolean | undefined => {
  const { bys } = next;

  if (bys === undefined) {
    return next.desc ?? false;
  }

  if (bys.length !== 1 || bys[0].kind !== 'identity') {
    return undefined;
  }

  const dir = bys[0].direction;

  return dir === undefined ? (next.desc ?? false) : dir === 'desc';
};

/**
 * Is a FUSED hop walk's residual nothing but a global `order()` over the values it already
 * produced? `undefined` means "not this shape" (item 1630).
 *
 * ⚠️ WHY THIS EXISTS WHEN ITEM 1394 CLOSED THE ROW. That item priced the three candidates item 879
 * left open — `evalBy` plus `project` at 0.1% (refuted), the comparator at ~4.3%, `[...stream]` at
 * ~5% — and concluded nothing was open. The accounting was right and none of it is re-attempted
 * here. What changed is the MECHANISM: item 1586 built the values fusion and item 1591 extended it
 * to a CAPPED `order()`, leaving the uncapped one explicitly flat. `hopValuesShortcut` consumes
 * `[V, hop, values]` and hands back `rest = [order]`, so `run` wrapped a million raw values into
 * traversers one at a time, `orderStep` spread them back into an array, and `sortByBys` allocated a
 * `{item, key}` wrapper per element and ran three more passes over it — when the walk already
 * produces exactly the array the sort wants.
 *
 * Priced BEFORE building (`order-values-floor.ts`, 200,000 vertices / 1M edges, min of 7):
 *
 * ```text
 *    engine hop+values+ORDER        471.56 ms      <- the target
 *    HAND  walk + sort              146.27         <- the floor: 3.22x
 *    HAND  walk + WRAPPED sort      195.15         <- so the wrapper is 48.9 of the 325 ms gap
 *    engine hop+values (fused)       96.81         <- the same walk with rest EMPTY
 *    engine hop+values+order+LIMIT  272.00 for TEN ROWS  <- the capped spelling is in the same hole
 * ```
 *
 * ⚠️ THE WALK MUST BE IN VALUE MODE — and that gate is CONSERVATIVE, not load-bearing, which I
 * found out by writing a test that passed for the wrong reason. `hopValuesShortcut` also serves a
 * bare hop (`pick` = the far vertex) and `id()`, and `order()` over graph ELEMENTS throws by
 * contract. I expected `sortByBys`' element pass to be what raises, which would make this the one
 * correctness question in the change. It is not: `assertFrontierTypes` raises at PLAN-CHECK time,
 * before any route is chosen, so an element walk never reaches a sort by either path. `id()` mode
 * sorts strings, which a raw sort would also get right. So removing this check is ANSWER-EQUIVALENT
 * through the public API — and the mutant is still CAUGHT, by this gate's own unit test asserting it
 * declines an `id` last-consumed step. That is the remedy for the whole answer-equivalent route
 * class: test the gate as a pure function, because no differential test can fail on it.
 *
 * It stays, for the reason `fusedValuesTopK`'s unreachable guard above states: the static check is a
 * SEPARATE mechanism that could narrow, and the cost is one `kind` comparison per plan.
 *
 * Reading the last CONSUMED step rather than adding a field to the shortcut's return type keeps the
 * gate uniform across all three producers (`hopValuesShortcut`, `startFilteredHopValues`,
 * `hopChainValuesShortcut`) without widening three signatures.
 */
export const fusableProjectedOrder = (
  rest: readonly Step[],
  consumedLast: Step | undefined,
): { readonly desc: boolean } | undefined => {
  if (rest.length !== 1) {
    return undefined;
  }

  const [next] = rest;

  // `local` sorts within each value rather than across the stream, and a legacy `key` projects a
  // sort key off each item — both different shapes.
  if (next.kind !== 'order' || next.scope === 'local' || next.key !== undefined) {
    return undefined;
  }

  // ⚠️ A CAP DECLINES, AND THAT IS MEASURED RATHER THAN ASSUMED. `fuseOrderTake` folds a trailing
  // `take(n)` into the order as a `cap`, and `orderStep` already takes a streaming top-k for it.
  // The first version of this gate admitted the cap and drove `streamTopByBys` from here, which
  // measured **FLAT** — `hopordercap` 2988.4 / 3335.4 / 2942.1 ms PRE against 3035.2 / 2977.6 /
  // 2988.6 POST — because what this change removes is the MATERIALIZATION, and a capped order never
  // materialized. So the capped spelling keeps item 1591's path and this branch is gone rather than
  // kept as an unmeasured route.
  if (next.cap !== undefined) {
    return undefined;
  }

  // ⚠️ VALUE MODE ONLY. See the note above: the other two walk modes emit elements (or ids), and an
  // element stream must reach `sortByBys` so it can throw.
  if (consumedLast?.kind !== 'values' || consumedLast.keys.length !== 1) {
    return undefined;
  }

  const desc = identityOrderDesc(next);

  return desc === undefined ? undefined : { desc };
};

/**
 * Sort a fused walk's raw values, taking the walk's EAGER arm (item 1630).
 *
 * `order()` is a boundary step — nothing can be emitted before the whole stream is seen — so
 * draining eagerly is the same answer by a cheaper route rather than a change in behaviour, which
 * is item 1412's argument for `toArray`. Construction still does no work (`order-step-laziness`
 * pins that contract), because the iterator is a generator.
 *
 * A CAPPED order never reaches here — see the gate, where that declines on a measured flat result.
 */
export const fusedProjectedOrder = (
  values: Iterable<unknown> & { readonly drain?: () => unknown[] },
  opts: { readonly desc: boolean },
): Iterable<unknown> & { drain: () => unknown[] } => {
  const general = opts.desc
    ? (a: unknown, b: unknown): number => -compareTotal(a, b)
    : (a: unknown, b: unknown): number => compareTotal(a, b);

  const sorted = (): unknown[] => {
    const { drain } = values;
    const acc = typeof drain === 'function' ? drain() : [...values];

    // ⚠️ THE ELEMENT PASS IS KEPT, and mutation will report it unreachable. `sortByBys` raises
    // before sorting when any key is a graph element, and it does so even for a stream of ONE where
    // no comparison happens — so a comparator-side check would not be equivalent. In value mode a
    // property value cannot be a Vertex or Edge, which makes this the same deliberately-unreachable
    // guard `fusedValuesTopK` documents above: the static shape is a SEPARATE mechanism that could
    // narrow, and without this the fault would surface from inside a sort rather than at the step.
    for (const v of acc) {
      if (isElement(v)) {
        throw new LenkeError(
          `order() over graph elements is not supported — elements have no natural order; ` +
            `use order().by('<key>')`,
          { code: ErrorCode.Syntax },
        );
      }
    }

    // A COLUMN OF ONE TYPE WITH NO NULLS SORTS WITH THE DEAD BRANCHES GONE (item 1713), which is
    // what makes item 1712's correct code-point ordering affordable — that fix cost 1.55x-1.68x
    // here. The scan runs once; `compareTotal` still answers every column it declines.
    //
    // ⚠️ THIS IS THE SITE THE `values(k).order()` ROW ACTUALLY REACHES. The first attempt wired
    // only `sortByBys` and changed nothing at all: a counter on all six sort sites showed the row
    // entering HERE and the admit/decline counter never firing.
    acc.sort(allPlainStrings(acc) ? reducedValueComparator(opts.desc) : general);

    return acc;
  };

  return {
    *[Symbol.iterator]() {
      yield* sorted();
    },
    // `toArray` reads this (item 1412), which saves copying the sorted array a second time.
    drain: sorted,
  };
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
// ⚠️ `boundedTop` LIVED HERE — a heap keeping the `cap` best entries, items 1064/1574, with the
// stable tie-break on arrival index that made it equal to a full sort's prefix. Item 1790 DELETED
// it as UNREACHABLE, and the reason is that `sortByBys` is only ever called WITHOUT a cap: item
// 1576 moved every capped `order()` to `streamTopByBys`, which keeps its own heap and never
// materialises the stream, leaving the array-based selection below with no caller that could
// enable it. The gate was instrumented before the deletion: 145 arrivals across the gremlin
// suite, every one `cap=undefined`.
//
// It was SUPERSEDED, not lost. `streamTopByBys` is the same algorithm on a stream, keeps the same
// arrival-index tie-break, and item 1574's answer properties are pinned by
// `order-take-topk.test.ts`, which goes through it. Rebuilding a capped ARRAY sort means first
// finding a caller that wants one.

const sortByBys = <T>(
  items: readonly T[],
  project: (item: T) => unknown,
  bys: readonly By[],
  /**
   * `desc` is the step-level direction. There is no `cap`: a capped `order()` goes to
   * `streamTopByBys` instead and never reaches here (item 1790 deleted the dead branch).
   *
   * ⚠️ ONE OBJECT RATHER THAN A SECOND PARAMETER because a seventh positional argument trips
   * `max-params`, and the rule is right: `(items, project, bys, desc, graph, ctx)` is three
   * trailing values nobody can read at a call site.
   *
   * ⚠️ THE KEYS ARE EVALUATED FOR EVERY ITEM, with the element check running over all of them,
   * before anything is ordered. Not incidental: `sortByBys` evaluates every key before the element
   * check precisely so a throwing `by` wins over the element fault, and skipping rejected items
   * would silently drop both faults. `streamTopByBys` carries the same rule for the capped shape.
   */
  opts: { readonly desc: boolean },
  graph: Graph,
  ctx: RunContext,
): T[] => {
  const { desc } = opts;

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
  //   the comparator          ~4.3%  ON A NUMERIC KEY ONLY — see below; the STRING comparator was
  //                                  never profiled and is worth far more
  //   `[...stream]`           ~5.0%  startTraverser 1.4 + unwrap 1.9 + toArray 1.8
  //
  // A share overstates a realizable change by ~2.5x here, so the latter two are ~2% each — under
  // what this row resolves even at 106 ms a rep. And the row's dominant term is not the sort:
  // **36% of what `values(k).order()` adds over a bare hop is FAR-VERTEX LOCALITY** (115.9 ms at
  // fan-in 1 against 73.5 at fan-in 100, with the bare-hop control flat at 75.9/77.6), which item
  // 1392 closed as having no per-row lever. ~~Nothing is open on this row.~~
  //
  // ⚠️ THE ~4.3% ABOVE IS THE NUMERIC COMPARATOR, AND THE STRING ONE IS A DIFFERENT QUESTION
  // (item 1713). `hoporder` — the row every figure above was measured on — sorts `k`, a NUMBER,
  // where UTF-16 order already equals code-point order and `compareTotal` falls through its cheapest
  // path. A STRING key pays the whole dispatch chain plus `compareCodePoints` plus a surrogate regex
  // over both strings, and at 1,000,000 rows that is not 4.3% of anything: `values('s').order()`
  // measured 637.5-725.3 ms against 431.6 specialized (**1.48x-1.68x**), and `order().by('s')`
  // 1255.5-1434.3 against ~1050 (**1.18x-1.37x**). Neither row existed in this harness until 1713
  // added them, which is why a correct closure of the NUMERIC row read as a closure of the row.
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
    // A KEY COLUMN OF ONE TYPE WITH NO NULLS SORTS WITH THE DEAD BRANCHES GONE (item 1713). This is
    // what makes item 1712's correct code-point ordering affordable: that fix cost 1.55x-1.68x on a
    // 1,000,000-row string sort, and the scan replaces ~20M dispatch chains with ~1M tests.
    // `compareTotal` is still the comparator for every column the scan declines, and the reduction
    // is exact rather than a second ordering — see the module's note.
    const reduced1 = allPlainStringKeys(live1) ? reducedKeyComparator(descending) : undefined;
    const cmp1 =
      reduced1 ??
      (descending
        ? (a: { key: unknown }, b: { key: unknown }): number => -compareTotal(a.key, b.key)
        : (a: { key: unknown }, b: { key: unknown }): number => compareTotal(a.key, b.key));

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
