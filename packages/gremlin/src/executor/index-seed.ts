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

import type { Edge, Graph, PropertyIndex, RangeBound, Vertex } from '@lenke/core';

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
      return rangeCandidate(index, key, { gte: pred.min, lt: pred.max });
    case 'inside':
      return rangeCandidate(index, key, { gt: pred.min, lt: pred.max });
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

/** The seed a single leading filter step offers, if any. */
const seedForStep = <E>(step: Step, index: PropertyIndex<E>): Candidate<E> | null => {
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
  // Estimate each seedable leading filter's cardinality (no set built yet) and
  // pick the most selective. The other filters stay in the plan as residuals,
  // so they still narrow the seed before any downstream step runs — only the
  // winner is materialized.
  let bestAt = -1;
  let best: Candidate<E> | null = null;

  for (let i = 0; i < rest.length; i++) {
    const step = rest[i];

    if (!COMMUTING_FILTERS.has(step.kind)) {
      break;
    }

    const candidate = seedForStep(step, index);

    if (candidate && candidate.count < (best?.count ?? Infinity)) {
      best = candidate;
      bestAt = i;
    }
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
    return seedRest<Vertex>(rest, graph.vertexPropertyIndex, tracksPath);
  }

  if (source.kind === 'E' && !source.ids) {
    return seedRest<Edge>(rest, graph.edgePropertyIndex, tracksPath);
  }

  return null;
};
