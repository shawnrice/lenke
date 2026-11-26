// Shared scaffolding for the executor. Per-category step-impl files import
// from here for the runtime types (`Traverser`, `RunContext`), traverser
// primitives, type guards, modulator evaluation, and the small set of
// generators (`mapTraverser`/`filterStream`/etc.) that show up in many
// places.
//
// What's NOT here: per-step implementations (those live in their category
// file), and the dispatcher (`applyStep` + `applyPlanToStream`, in
// `./dispatch.ts`). Those depend on each other recursively, so they stay
// adjacent.

import {
  isEdgeShaped,
  isTemporal,
  isVertexShaped,
  LocalDate,
  temporalKeyAdd,
  temporalKeyFields,
} from '@lenke/core';
import type { TemporalKeyNode } from '@lenke/core';
import type { Edge, Graph, Vertex } from '@lenke/core';

import type { By, Plan } from '../ast.js';
// Cycle: `runtime.ts` ↔ `dispatch.ts`. ESM handles this safely because
// neither module dereferences the other at init time — `applyPlanToStream`
// is only called from inside `evalBy`, by which time both modules' exports
// are bound. Same shape as `applyStep`/`applyPlanToStream` mutual-recursion.
import { applyPlanToStream } from './dispatch.js';

// ---------- Traverser ----------

/**
 * Runtime traverser. Carries the current value and the path of values seen
 * to reach it. Path is immutable — branching produces fresh paths via
 * structural sharing.
 */
export type Traverser<T> = {
  readonly value: T;
  readonly path: readonly unknown[];
  /** Number of repeat-body iterations entered so far. 0 outside any repeat. */
  readonly loopCount: number;
  /**
   * Labeled positions tagged via `as(label)`, recalled by `select(label)`.
   * A label can accumulate multiple values inside iterative steps (e.g.
   * `repeat(out().as('a'))`); `select(Pop.first|last|all, 'a')` picks how
   * to read. The default `select('a')` returns the last tagged value.
   */
  readonly tags: ReadonlyMap<string, readonly unknown[]>;
  /**
   * The per-traverser sack (TinkerPop `sack()`). LAZY: `undefined` until a
   * `sack(op)` write sets it; a read before that returns the `withSack` default
   * (on {@link RunContext}) without storing. With no `withSack`, no sack ever
   * exists on any traverser.
   */
  readonly sack?: unknown;
};

export const emptyTags: ReadonlyMap<string, readonly unknown[]> = new Map();

export const isEmptyPlan = (plan: Plan): boolean => plan.steps.length === 0;

/**
 * Shared empty-path sentinel for traversers in a run that never reads the path.
 * `extend` checks identity against it to propagate "not tracking" down a chain
 * for free — see {@link planReadsPath}. Frozen so an accidental mutation throws
 * rather than corrupting every traverser that shares it.
 */
const NO_PATH: readonly unknown[] = Object.freeze([]);

/**
 * Does any step anywhere in the plan tree read the traverser path? Recurses
 * only through plan-bearing fields (never `inject` values, predicate operands,
 * or closures), so it can't loop on or be fooled by user data. When this is
 * false the run skips path bookkeeping entirely; when in doubt it returns true,
 * so the optimization only ever removes provably-unobservable work.
 */
/**
 * NOW AN O(1) FIELD READ (item 1504). The walk moved to plan CONSTRUCTION — see
 * {@link Plan.readsPath} in `ast.ts` for why that, and not a cache on this path.
 *
 * Kept as a function rather than inlining `plan.readsPath` at its call sites: it is the name the
 * concept has in the executor and in the comments that reference it, and a function keeps the
 * option of answering differently for a plan that arrived from somewhere other than the combinators.
 */
export const planReadsPath = (plan: Plan): boolean => plan.readsPath;

/** A `{ key, value }` property element (from `.properties(k)`). */
export type PropertyElement = { key: string; value: unknown };

/**
 * A property element stays exactly `{ key, value }`; its owning vertex/edge is
 * tracked HERE (a side WeakMap keyed by the element's identity), not as a field
 * on the object — so `.drop()` can delete the property while nothing leaks into
 * projections, serialization, or structural equality. The WeakMap lets the
 * element and its owning-link be GC'd together once the traversal drops them.
 */
const propertyOwners = new WeakMap<object, Vertex | Edge>();

/** Mint a property element and remember its owner (called by `.properties`). */
export const ownedProperty = (
  owner: Vertex | Edge,
  key: string,
  value: unknown,
): PropertyElement => {
  const el: PropertyElement = { key, value };
  propertyOwners.set(el, owner);

  return el;
};

/** The owning vertex/edge of a property element, or `undefined` if `x` isn't one. */
export const propertyOwner = (x: unknown): Vertex | Edge | undefined =>
  typeof x === 'object' && x !== null ? propertyOwners.get(x) : undefined;

export const startTraverser = <T>(value: T, tracksPath = true): Traverser<T> => ({
  value,
  path: tracksPath ? [value] : NO_PATH,
  loopCount: 0,
  tags: emptyTags,
  // SET EXPLICITLY SO ALL THREE CONSTRUCTORS AGREE ON THE SHAPE (item 1746). Item 1745 gave
  // `extend` a plain `sack` field (5 fields) and left this one at 4, so source traversers and
  // extended ones had DIFFERENT hidden classes — a polymorphism that item introduced without
  // noticing, because its own numbers improved anyway. Unifying is 1.20x on `coalesce` with
  // disjoint ranges (3173/3134 -> 2638/2629/2606): that shape runs five `extend`s per vertex, so
  // every one of them was crossing a shape boundary.
  sack: undefined,
});

export const extend = <T>(prev: Traverser<unknown>, value: T): Traverser<T> => ({
  value,
  // Propagate the not-tracking sentinel by identity; otherwise grow the path.
  path: prev.path === NO_PATH ? NO_PATH : [...prev.path, value],
  loopCount: prev.loopCount,
  tags: prev.tags,
  // Propagate the sack (split-on-branch = clone).
  //
  // WRITTEN AS A PLAIN FIELD, NOT A CONDITIONAL SPREAD, and the previous form's comment claimed
  // the no-sack path cost nothing (item 1745 measured that claim and it was false). The spread
  //     ...(prev.sack === undefined ? {} : { sack: prev.sack })
  // allocated an empty object on EVERY no-sack extend and, worse, a spread inside an object literal
  // denies V8 a fixed hidden class for the whole literal — and `extend` runs once per traverser per
  // step, so that reaches the entire Gremlin engine. 300 reps, three alternated rounds, ms:
  //
  //     folded      283.3 285.1 276.5  ->  255.8 248.8 247.0   1.14x, ranges DISJOINT
  //     coalesced  3244.8 3244.9 3224.5 -> 2996.5 3186.0 2938.2 1.08x, ranges DISJOINT
  //     hopcount3   477.9 481.6 478.4  ->  473.5 473.7 468.6    1.7%, ranges DISJOINT
  //
  // EXACTLY EQUIVALENT: the only consumer is `sack.ts`'s `t.sack === undefined ? cfg.value : t.sack`,
  // which tests the VALUE; nothing in the repo asks `'sack' in t` or enumerates a traverser's keys,
  // so an explicit `undefined` is indistinguishable from an absent key here.
  sack: prev.sack,
});

/**
 * AN EXPLICIT LITERAL, NOT `{ ...t, loopCount: … }`, for the same reason as `extend` and
 * `startTraverser` above: a spread denies V8 a fixed hidden class for the literal, and all three
 * constructors must agree or the steps downstream see polymorphic traversers. `repeat()` is the
 * only caller (item 1746 checked), and it measured flat there — the win is in the SHAPE agreement,
 * which `coalesce` shows at 1.20x, not in this function's own cost.
 */
export const incLoops = <T>(t: Traverser<T>): Traverser<T> => ({
  value: t.value,
  path: t.path,
  loopCount: t.loopCount + 1,
  tags: t.tags,
  sack: t.sack,
});

// ---------- Type guards ----------

// The structural guards live in `@lenke/core`: both engines ask this question of
// the values in their streams, and it has to have ONE answer.
export const isVertex = (x: unknown): x is Vertex => isVertexShaped(x);

export const isEdge = (x: unknown): x is Edge => isEdgeShaped(x);

export const firstLabel = (s: ReadonlySet<string>): string | undefined => {
  for (const l of s) {
    return l;
  }

  return undefined;
};

/**
 * An element's label, preferring the core's cached `soleLabel` over iterating the set (item 2085).
 *
 * ITEM 2080 FUSED `V().label()` AND LEFT THIS TERM: a `Set` has no indexed access, so taking "the
 * first label" allocated an iterator per element — measured there at ~14 ns a row, the whole residue
 * of that fusion. `soleLabel` is a field read on the label box, maintained at the three sites that
 * write it.
 *
 * `soleLabel === undefined` MEANS ZERO **OR MANY**, so the fallback to `firstLabel` is required
 * and must keep INSERTION order — `dispatch.ts`'s `case 'label'` yields `firstLabel(...) ?? null`,
 * and a multi-label vertex created as `['T', 'U']` must still yield `T`.
 */
export const labelOf = (el: {
  labels: ReadonlySet<string>;
  soleLabel?: string;
}): string | undefined => el.soleLabel ?? firstLabel(el.labels);

// ---------- Run context ----------

/**
 * Per-run context — currently just the side-effects bag for
 * `aggregate(key)` / `cap(key)`. Passed by reference so all steps in a
 * single `run()` share the same bag.
 */
export type RunContext = {
  readonly sideEffects: Map<string, unknown[]>;
  /**
   * Subgraph side-effects keyed by name: `subgraph(key)` accumulates matching
   * edges (and their endpoints) into a fresh `Graph` here, which `cap(key)`
   * returns. Kept separate from {@link sideEffects} because the value is a graph,
   * not an appended list.
   */
  readonly subgraphs: Map<string, Graph>;
  /**
   * Whether this run tracks traverser paths. Computed once from the plan via
   * {@link planReadsPath}; defaults to `true` so any context built without it
   * (e.g. sub-plan evaluation) is always correct, just unoptimized.
   */
  readonly tracksPath: boolean;
  /**
   * The `withSack(init)` default, boxed so `undefined` means "no sack
   * configured" — then `sack()` faults and no per-traverser sack is created.
   * Mutable: set once by the leading `withSack` step. This is the laziness gate.
   */
  sackInit?: { readonly value: unknown };
  /**
   * Can an element's canonical rendering be MEMOIZED for the duration of this run? True only when
   * the plan contains no mutation step anywhere, so nothing can change an element while it is being
   * keyed (item 1922).
   *
   * DEFAULTS TO `false`, the conservative value, for {@link RunContext.tracksPath}'s reason: a
   * context built without it (sub-plan evaluation, a hand-made call) is then always correct, just
   * unoptimized. The dangerous default is the other one.
   *
   * WHY IT IS NEEDED AT ALL, measured rather than assumed. `treeStep` keys every path position by
   * `JSON.stringify(node.toJSON())` — the byte-identity contract with the Rust engine — which is
   * **744 ms of a 1013 ms shape** at 200,000 vertices (`tree().by(k)`, which skips that key, is
   * 269.67). A per-element memo collapses 1,200,000 serializations into ~200,000 distinct ones. But
   * the stream is pulled LAZILY, so a mutation step upstream runs interleaved with the tree
   * insertion: `treekey-mutation-probe-1922.mjs` showed `V().out(E).property(z,2).tree()` keying
   * **1 of its 2 top-level entries WITH the new property and the other without** — an element keyed
   * on both sides of its own mutation. A memo there is a wrong answer, and `Graph` has no
   * synchronous counter to invalidate on ([[graph-counters-are-async]]).
   */
  readonly keysStable?: boolean;
};

export const newContext = (tracksPath = true, keysStable = false): RunContext => ({
  sideEffects: new Map(),
  subgraphs: new Map(),
  tracksPath,
  keysStable,
});

/**
 * Project a runtime `Traverser` plus the run's side-effects into the
 * read-only view that user closures see. Built lazily per-call (rather than
 * stored on every traverser) because side-effects are per-run, not per-
 * traverser; threading the same Map reference avoids per-traverser overhead.
 */
export const closureView = (
  t: Traverser<unknown>,
  ctx: RunContext,
): {
  value: unknown;
  path: readonly unknown[];
  loopCount: number;
  tags: ReadonlyMap<string, readonly unknown[]>;
  sideEffects: ReadonlyMap<string, readonly unknown[]>;
} => ({
  value: t.value,
  path: t.path,
  loopCount: t.loopCount,
  tags: t.tags,
  sideEffects: ctx.sideEffects,
});

// ---------- Stream-of-traversers helpers (used by many steps) ----------

export const unwrap = function* (stream: Iterable<Traverser<unknown>>): Iterable<unknown> {
  for (const t of stream) {
    yield t.value;
  }
};

/**
 * `Iterable<unknown>`, NOT `Iterable<Traverser>` — the body only asks whether the iterable yields
 * anything, and item 1627 needed it for an iterable of VALUES. Widening the parameter to what the
 * body actually requires costs nothing and every existing caller still fits; narrowing it to
 * traversers was an accident of where it was first used.
 */
export const hasAny = (stream: Iterable<unknown>): boolean => {
  for (const _ of stream) {
    return true;
  }

  return false;
};

export const mapTraverser = function* (
  stream: Iterable<Traverser<unknown>>,
  fn: (v: unknown, t: Traverser<unknown>) => unknown,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    yield extend(t, fn(t.value, t));
  }
};

export const filterStream = function* (
  stream: Iterable<Traverser<unknown>>,
  predicate: (v: unknown) => boolean,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (predicate(t.value)) {
      yield t;
    }
  }
};

export const filterTraverser = function* (
  stream: Iterable<Traverser<unknown>>,
  predicate: (t: Traverser<unknown>) => boolean,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (predicate(t)) {
      yield t;
    }
  }
};

// ---------- Local-scope iteration (Scope.local consumers) ----------

/**
 * True for non-string objects that expose `Symbol.iterator`. Used by every
 * `Scope.local` consumer (slice family + aggregation family) to decide
 * whether to operate on a traverser's value as a sequence or pass it through
 * unchanged. Strings are deliberately excluded — TinkerPop's `Scope.local`
 * doesn't treat a string as a sequence of characters.
 */
export const isSliceable = (v: unknown): v is Iterable<unknown> => {
  if (v === null || v === undefined || typeof v === 'string') {
    return false;
  }

  return typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
};

// ---------- Tag recall (select / where-compare / addE) ----------

export type Pop = 'first' | 'last' | 'all';

export const recallTag = (
  tags: ReadonlyMap<string, readonly unknown[]>,
  label: string,
  pop: Pop,
): { ok: true; value: unknown } | { ok: false } => {
  const list = tags.get(label);

  if (!list || list.length === 0) {
    return { ok: false };
  }

  if (pop === 'first') {
    return { ok: true, value: list[0] };
  }

  if (pop === 'last') {
    return { ok: true, value: list[list.length - 1] };
  }

  return { ok: true, value: [...list] };
};

// ---------- Tuple key (dedupe / group across multiple labels) ----------

// Build a stable string key from a tuple of values. Vertices/edges are keyed
// by `id` (graph-unique); other values fall through to JSON. NUL separates
// fields so distinct tuples can't collide via concatenation.
/** One tuple part's key. `@` namespaces an element id so a vertex `5` cannot collide with the number. */
const partKey = (p: unknown): string => {
  if (isVertex(p) || isEdge(p)) {
    return `@${p.id}`;
  }

  return JSON.stringify(p) ?? 'undefined';
};

/**
 * FAST PATH FOR ONE PART, which is FOUR of the five call sites (`dedupe`, two in `iteration.ts`,
 * and `match`'s candidate dedupe). The general form pays `.map()` — a real array per call, since
 * escape analysis does not see through array builtins the way it does an object literal — and then
 * a `.join()` that, for a single part, copies the string it was already handed.
 *
 * Item 1478 profiled Gremlin's `match()` at `applyPattern` **18.4% self**, where the candidate
 * dedupe runs `tupleKey([o.value])` once per candidate per traverser: 5 candidates x 100,000 rows a
 * rep on the measured fixture.
 */
export const tupleKey = (parts: readonly unknown[]): string =>
  parts.length === 1 ? partKey(parts[0]) : parts.map(partKey).join('\x00');

// ---------- by() modulator evaluation ----------

// `by` legacy fallback: if a step has no `bys`, reconstruct one from a legacy
// property-name field (e.g. `order.key`, `group.keyBy`).
export const keyToBy = (key: string | undefined): By =>
  key === undefined ? { kind: 'identity' } : { kind: 'key', key };

// Normalize legacy `key` field into a one-element `bys` array if `bys` is unset.
export const normalizeBys = (
  bys: readonly By[] | undefined,
  legacyKey: string | undefined,
): readonly By[] => {
  if (bys && bys.length > 0) {
    return bys;
  }

  if (legacyKey !== undefined) {
    return [{ kind: 'key', key: legacyKey }];
  }

  return [{ kind: 'identity' }];
};

// `T.id` / `T.label` / `T.key` / `T.value` projection.
export const projectToken = (token: 'id' | 'label' | 'key' | 'value', value: unknown): unknown => {
  if (token === 'id') {
    return isVertex(value) || isEdge(value) ? value.id : undefined;
  }

  if (token === 'label') {
    return isVertex(value) || isEdge(value) ? (firstLabel(value.labels) ?? null) : undefined;
  }

  // `T.key` / `T.value` apply to property objects of shape `{ key, value }`
  // (as produced by `properties()`). For anything else, undefined.
  if (typeof value === 'object' && value !== null && 'key' in value && 'value' in value) {
    return value[token];
  }

  return undefined;
};

/**
 * Sentinel returned by {@link evalBy} when a `by()` projection yields NO VALUE — an
 * ABSENT property (the element / map / row has no such key) or a sub-traversal that
 * emitted nothing. TinkerPop treats this as a FILTER for the keying steps
 * (order/group/groupCount/dedup/select) and as an OMITTED key for `project()`. It is
 * DISTINCT from a stored `null` (a present value, which is kept). Consumers that do
 * not filter coerce it back with {@link byOr} so their behavior is unchanged.
 */
export const NO_VALUE: unique symbol = Symbol('lenke.gremlin.noValue');

/** Coerce a possibly-`NO_VALUE` `evalBy` result to `fallback` (default `undefined`) —
 * for the consumers that keep the traverser rather than filtering on an absent `by()`. */
export const byOr = (v: unknown, fallback?: unknown): unknown => (v === NO_VALUE ? fallback : v);

// Evaluate a `By` modulator against a single value. The traversal form runs
// the sub-plan with `value` as the starting traverser and projects to its
// first emitted result. A projection that yields nothing — an absent property or an
// empty sub-traversal — returns {@link NO_VALUE} (a stored `null` is a value, kept).
export const evalBy = (by: By, value: unknown, graph: Graph, ctx: RunContext): unknown => {
  switch (by.kind) {
    case 'identity':
      return value;
    case 'key':
      // `hasOwn`, not `k in props`: an absent key is NO_VALUE (so keying steps filter
      // it, matching TinkerPop), and an inherited name (`toString`) never leaks a
      // prototype function — parity with the HashMap-backed native engine.
      if (isVertex(value) || isEdge(value)) {
        // Read the bag ONCE. `properties` is not a field — it is a getter doing a
        // string-keyed `Map.get` into the graph's whole property store, which costs
        // ~225ns at 200,000 vertices with the store cold. Reading it twice doubled
        // the dominant cost of every keyed grouping/ordering step.
        const bag = value.properties;

        return Object.hasOwn(bag, by.key) ? bag[by.key] : NO_VALUE;
      }

      // `by('k')` over a Map (`group`/`groupCount`) or a `project()` row object
      // projects the value at that key — e.g. `project('name','age').order().by('age')`.
      // Without this the whole container reached the comparator ("cannot order …").
      if (value instanceof Map) {
        return value.has(by.key) ? value.get(by.key) : NO_VALUE;
      }

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;

        return Object.hasOwn(obj, by.key) ? obj[by.key] : NO_VALUE;
      }

      return value;
    case 'traversal': {
      const out = applyPlanToStream(by.plan, [startTraverser(value)], graph, ctx);

      for (const t of out) {
        return t.value;
      }

      return NO_VALUE;
    }
    case 'token':
      return projectToken(by.token, value);
    case 'column':
      // `Column.keys` / `Column.values` over a Map yields the list of its keys /
      // values (TinkerPop `select(Column)`); `order(local)` special-cases it to sort
      // a Map's entries and never routes through here. Non-map → identity.
      if (value instanceof Map) {
        return by.column === 'keys' ? [...value.keys()] : [...value.values()];
      }

      return value;
  }
};

/**
 * THE VALUE-KEYED HALF OF `dedupe`'s FILTER — ONE DEFINITION, TWO CALLERS (item 1869).
 *
 * IT LIVES IN `runtime.ts` AND NOT IN A MODULE OF ITS OWN, because `tupleKey` and `NO_VALUE` are
 * defined HERE and `runtime.ts` imports `dispatch.js` for `applyPlanToStream` — so a separate file
 * importing both closed a dependency cycle that `oxlint` rejected. An added export is not a new
 * node in the import graph; a new file was.
 *
 * IT IS ONE DEFINITION RATHER THAN A SECOND COPY, AND THAT IS THE WHOLE POINT. `dispatch.ts` built this
 * predicate inline, and item 1869 needed the same classes for a FUSED `V().values(k).dedupe()` walk
 * that skips the traverser stream. Re-deriving them there would have meant duplicating FIVE key
 * spaces — a plain `Set`, a structural-string `Set` with a `WeakSet` short-circuit, a `LocalDate`
 * `Set` on `days`, and a nested container for the other temporal kinds — each of which carries a
 * measured decision from items 850, 857, 1015 and 1017. That is item 1832's drift hazard in its
 * worst form: two copies of "which values are the same value", with byte-identity against the Rust
 * engine riding on them agreeing forever.
 *
 * THE MULTI-LABEL FORM IS **NOT** HERE, deliberately. `dedupe('a', 'b')` keys on the tuple of
 * TAGGED values, so it reads `t.tags` and needs the traverser rather than a value. It stays in
 * `dispatch.ts`, and the fused rung refuses a labelled `dedupe` outright — the same refusal
 * `distinctHopCount` and `dedupedHopChainCount` make, for the same reason.
 *
 * EVERY COMMENT BELOW CAME WITH THE CODE AND IS NOT NEW REASONING. The measurements, the
 * `LocalDate`-out-of-the-composite-path decision and the `NaN`/`Infinity` collapse item 850 pinned
 * are all load-bearing; a reader deciding whether to touch a key space needs them here, next to the
 * space, rather than in the file this moved out of.
 */
/**
 * A fresh dedupe predicate: `true` the first time a value is seen, `false` afterwards.
 *
 * Stateful by construction — one call per `dedupe` step occurrence, never shared — because the
 * containers ARE the dedupe. A caller that reused one across two steps would merge their classes.
 */
export const valueDedupeFilter = (): ((v: unknown) => boolean) => {
  // Primitives and stable graph-element references dedupe directly in this Set — value/identity
  // equality, no allocation (the hot path). Composite values (lists / plain-object maps) are
  // distinct references even when structurally equal, so they upgrade to a structural string key in
  // a second, lazily-created Set. A recurring *reference* short-circuits via the WeakSet, so each
  // composite is keyed at most once: slow the first time, an O(1) pointer hit on every repeat.
  const seen = new Set<unknown>();
  let seenComposite: Set<string> | null = null;
  let seenRefs: WeakSet<object> | null = null;
  // A `LocalDate` keys on its epoch-day count, in its own `Set` (item 857). See the branch below
  // for why it is lifted out of the composite path and why the container is separate.
  let seenDates: Set<number> | null = null;
  // The OTHER temporal kinds (item 1017). `LocalDate` keeps its own flat `Set` above — the Rust
  // twin measured folding a date into the wider container at 2.0x on the date column alone (item
  // 1015) — and everything else lands in this nested one, keyed by the fields `temporalKeyFields`
  // names, which lead with a KIND RANK so one container holds every kind without two of them ever
  // sharing a key.
  let seenTemporals: TemporalKeyNode | null = null;

  return (v) => {
    // TinkerPop: a dedup-by that yields no value (absent property) FILTERS the traverser —
    // `dedup().by('age')` drops elements without `age` rather than collapsing them into one null
    // bucket.
    if (v === NO_VALUE) {
      return false;
    }

    /**
     * Plain lists/maps AND value-typed instances (temporals) need structural keying — a temporal is
     * a distinct object per vertex, so reference identity would never dedup equal dates (native
     * keys by value; `group`/`groupCount` already do too via `tupleKey`, which stringifies a
     * temporal's tagged form). Elements (stable refs), JS `Map`s, and other class instances keep
     * cheap reference identity.
     *
     * A `LocalDate` IS raw-keyable, on `days` — lifted out of the composite path below (item 857).
     * The composite path costs a date THREE things per row: a `WeakSet` insert, a `tupleKey` string
     * build, and a string-`Set` probe. The `WeakSet` is there to short-circuit a repeated
     * REFERENCE, and every vertex carries its own `LocalDate` object, so for this type it never
     * hits — 200,000 distinct objects inserted for nothing.
     *
     * Measured at 200,000 vertices over 1,000 distinct values, against the GQL spelling of the
     * same question in the same engine:
     *
     * ```text
     *   values('hired').dedup()   105.35 ms   vs  RETURN DISTINCT p.hired   4.49   23.5x
     *   values('score').dedup()    14.99       vs  RETURN DISTINCT p.score   4.17    3.6x
     *   values('name').dedup()     18.59       vs  RETURN DISTINCT p.name    5.48    3.4x
     * ```
     *
     * THE NUM AND STR ROWS TAKE THE CHEAP `seen` PATH ALREADY, so their 3.4-3.6x is the
     * TRAVERSAL STREAM'S own cost and not a keying defect — that reading is what nominated item
     * 1869's fused walk, which removes the stream and leaves this predicate untouched.
     *
     * `days` is in bijection with the rendering `tupleKey` would produce (items 843/847/848), so
     * the dedup classes are unchanged. A SEPARATE container because a raw `5` and `LocalDate(5)`
     * would otherwise collide in `seen` — the same reason item 850 gave for the TS GQL executor's
     * third container.
     *
     * FINITE only: `tupleKey` renders a non-finite field the way `JSON.stringify` does, so
     * `LocalDate(NaN)` and `LocalDate(Infinity)` are ONE key there and two under a raw `days`. Item
     * 850 pinned that collapse rather than "improving" it inside a speedup, and this keeps the same
     * decision.
     */
    // THIS BRANCH IS A PERFORMANCE DECISION AND ITS MUTANT MUST SURVIVE (item 1869's run
    // confirms it does). Deleting it sends dates down the composite path, which keys them
    // STRUCTURALLY and therefore dedupes them into the same classes — the same answer, item 857's
    // measured 2.0x slower. An answer test cannot see it, so the guard is the benchmark's, not the
    // suite's; recorded here rather than left as an unexplained survivor (item 475).
    if (v instanceof LocalDate && Number.isFinite(v.days)) {
      seenDates ??= new Set();

      if (seenDates.has(v.days)) {
        return false;
      }

      seenDates.add(v.days);

      return true;
    }

    // Item 1017: every other raw-keyable temporal kind, by the fields `@lenke/core` names rather
    // than by a `tupleKey` string plus a `WeakSet` insert that can never hit (each vertex carries
    // its own temporal object — item 857's finding for dates, which is true of every kind).
    // Measured on the TS Gremlin dedup at 200,000 rows / 1,000 distinct values: `datetime` 64.0 ms,
    // `localtime` 55.8, `zoned` 74.7 against a raw-keyed `date`'s 12.3 and a plain number's 12.9.
    //
    // The separation between kinds comes from `temporalKeyFields`' leading kind rank, not from a
    // container per kind — see its doc for the collision that makes it necessary.
    if (isTemporal(v) && !(v instanceof LocalDate)) {
      const fields = temporalKeyFields(v);

      if (fields !== undefined) {
        seenTemporals ??= new Map();

        return temporalKeyAdd(seenTemporals, fields);
      }
    }

    const proto =
      v !== null && typeof v === 'object' ? (Object.getPrototypeOf(v) as unknown) : false;
    const isComposite =
      Array.isArray(v) || proto === Object.prototype || proto === null || isTemporal(v);

    if (isComposite) {
      const ref = v as object;

      seenRefs ??= new WeakSet();

      if (seenRefs.has(ref)) {
        return false; // same reference already processed → duplicate, no re-key
      }

      seenRefs.add(ref);

      const k = tupleKey([v]);

      seenComposite ??= new Set();

      if (seenComposite.has(k)) {
        return false;
      }

      seenComposite.add(k);

      return true;
    }

    if (seen.has(v)) {
      return false;
    }

    seen.add(v);

    return true;
  };
};
