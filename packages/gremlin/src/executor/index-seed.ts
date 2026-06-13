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

import type { Edge, Graph, PropertyIndex, RangeBound, Vertex } from '@pl-graph/core';

import type { Plan, Predicate, Step } from '../ast.js';
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

/** A scalar the property index can seek on (mirrors PropertyIndex's IndexableValue). */
const isScalar = (v: unknown): boolean =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && !Number.isNaN(v));

type Seed<E> = { set: ReadonlySet<E>; removable: boolean };

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

/** Map a `RangeBound`-shaped predicate to its (type-strict) seed set. */
const rangeSeed = <E>(index: PropertyIndex<E>, key: string, bound: RangeBound): Seed<E> => ({
  set: index.range(key, bound) ?? EMPTY,
  removable: false,
});

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
): Seed<E> | null => {
  switch (pred.op) {
    case 'eq':
      return isScalar(pred.value)
        ? { set: index.equals(key, pred.value) ?? EMPTY, removable: plainHas }
        : null;
    case 'within':
      return pred.values.every(isScalar)
        ? { set: unionBuckets(index, key, pred.values), removable: plainHas }
        : null;
    case 'gt':
      return isScalar(pred.value) ? rangeSeed(index, key, { gt: pred.value }) : null;
    case 'gte':
      return isScalar(pred.value) ? rangeSeed(index, key, { gte: pred.value }) : null;
    case 'lt':
      return isScalar(pred.value) ? rangeSeed(index, key, { lt: pred.value }) : null;
    case 'lte':
      return isScalar(pred.value) ? rangeSeed(index, key, { lte: pred.value }) : null;
    case 'between':
      return rangeSeed(index, key, { gte: pred.min, lt: pred.max });
    case 'inside':
      return rangeSeed(index, key, { gt: pred.min, lt: pred.max });
    case 'startsWith': {
      // A prefix search is the string slice [prefix, succ(prefix)) — a range
      // the sorted index can seek. Kept as a residual filter.
      if (typeof pred.value !== 'string') {
        return null;
      }
      const upper = prefixUpperBound(pred.value);
      return rangeSeed(
        index,
        key,
        upper === null ? { gte: pred.value } : { gte: pred.value, lt: upper },
      );
    }
    default:
      return null;
  }
};

/** The seed a single leading filter step offers, if any. */
const seedForStep = <E>(step: Step, index: PropertyIndex<E>): Seed<E> | null => {
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
const seedRest = <E>(
  rest: readonly Step[],
  index: PropertyIndex<E>,
  tracksPath: boolean,
): SeededPlan | null => {
  // Across the leading run of commuting filters, pick the most selective seed
  // (smallest candidate set wins).
  let bestAt = -1;
  let best: Seed<E> | null = null;
  for (let i = 0; i < rest.length; i++) {
    const step = rest[i]!;
    if (!COMMUTING_FILTERS.has(step.kind)) {
      break;
    }
    const seed = seedForStep(step, index);
    if (seed && seed.set.size < (best?.set.size ?? Infinity)) {
      best = seed;
      bestAt = i;
    }
  }

  if (!best) {
    return null;
  }

  const { set } = best;
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
    return seedRest<Vertex>(rest, graph.vertexPropertyIndex, tracksPath);
  }
  if (source.kind === 'E' && !source.ids) {
    return seedRest<Edge>(rest, graph.edgePropertyIndex, tracksPath);
  }
  return null;
};
