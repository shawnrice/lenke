// Seed a `V()` source from a property index instead of scanning every vertex.
//
// When a traversal opens `V()` (no explicit ids) followed by a run of filter
// steps that only narrow the start set — `has` / `hasLabel` / `hasLabelAnd` /
// `hasId` / `hasKey` / `hasNot`, which commute freely — and one of them is an
// indexable property predicate on a graph-indexed key, we seed directly from
// that key's index bucket(s) rather than sweeping all of `V()`. The most
// selective seedable predicate (smallest candidate set) wins; every leading
// filter is re-applied as a residual, so the result still matches the scan.
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
//
// A `hasLabelAnd` seed always keeps its step (the bucket doesn't encode the
// label half). Non-seedable predicates (neq, outside, without, the string/
// regex ops, not) stay as ordinary residual filters.

import type { Graph, RangeBound, Vertex } from '@pl-graph/core';

import type { Plan, Predicate, Step } from '../ast.js';
import { startTraverser, type Traverser } from './runtime.js';

/** Filter steps that only narrow the `V()` set, so reordering them is safe. */
const COMMUTING_FILTERS = new Set<Step['kind']>([
  'has',
  'hasLabel',
  'hasLabelAnd',
  'hasId',
  'hasKey',
  'hasNot',
]);

const EMPTY: ReadonlySet<Vertex> = new Set<Vertex>();

/** A scalar the property index can seek on (mirrors PropertyIndex's IndexableValue). */
const isScalar = (v: unknown): boolean =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && !Number.isNaN(v));

type Seed = { set: ReadonlySet<Vertex>; removable: boolean };

/** Union the equality buckets for each value of a `within` list. */
const unionBuckets = (graph: Graph, key: string, values: readonly unknown[]): Set<Vertex> => {
  const out = new Set<Vertex>();
  for (const value of values) {
    for (const vertex of graph.vertexPropertyIndex.equals(key, value) ?? EMPTY) {
      out.add(vertex);
    }
  }
  return out;
};

/** Map a `RangeBound`-shaped predicate to its (type-strict) seed set. */
const rangeSeed = (graph: Graph, key: string, bound: RangeBound): Seed => ({
  set: graph.vertexPropertyIndex.range(key, bound) ?? EMPTY,
  removable: false,
});

/**
 * The index seed for `pred` on `key`, or `null` when the predicate isn't
 * seedable. `removable` is whether dropping the owning step leaves an
 * equivalent plan — only an exact (eq/within) match on a plain `has`.
 */
const seedForPred = (
  graph: Graph,
  key: string,
  pred: Predicate,
  plainHas: boolean,
): Seed | null => {
  switch (pred.op) {
    case 'eq':
      return isScalar(pred.value)
        ? { set: graph.vertexPropertyIndex.equals(key, pred.value) ?? EMPTY, removable: plainHas }
        : null;
    case 'within':
      return pred.values.every(isScalar)
        ? { set: unionBuckets(graph, key, pred.values), removable: plainHas }
        : null;
    case 'gt':
      return isScalar(pred.value) ? rangeSeed(graph, key, { gt: pred.value }) : null;
    case 'gte':
      return isScalar(pred.value) ? rangeSeed(graph, key, { gte: pred.value }) : null;
    case 'lt':
      return isScalar(pred.value) ? rangeSeed(graph, key, { lt: pred.value }) : null;
    case 'lte':
      return isScalar(pred.value) ? rangeSeed(graph, key, { lte: pred.value }) : null;
    case 'between':
      return rangeSeed(graph, key, { gte: pred.min, lt: pred.max });
    case 'inside':
      return rangeSeed(graph, key, { gt: pred.min, lt: pred.max });
    default:
      return null;
  }
};

/** The seed a single leading filter step offers, if any. */
const seedForStep = (step: Step, graph: Graph): Seed | null => {
  if (step.kind !== 'has' && step.kind !== 'hasLabelAnd') {
    return null;
  }
  if (!graph.vertexPropertyIndex.isIndexed(step.key)) {
    return null;
  }
  const seed = seedForPred(graph, step.key, step.pred, step.kind === 'has');
  // A `hasLabelAnd` carries a label constraint the bucket doesn't capture, so
  // its step can never be dropped.
  return seed && step.kind === 'hasLabelAnd' ? { ...seed, removable: false } : seed;
};

export type SeededPlan = {
  stream: Iterable<Traverser<Vertex>>;
  /** The residual steps to apply (source — and maybe one `has` — removed). */
  steps: readonly Step[];
};

/**
 * If `plan` can be seeded from a vertex property index, return the seed stream
 * plus the residual steps; otherwise `null` to fall back to a normal scan.
 */
export const seedVerticesFromIndex = (
  plan: Plan,
  graph: Graph,
  tracksPath: boolean,
): SeededPlan | null => {
  const [source, ...rest] = plan.steps;
  if (!source || source.kind !== 'V' || source.ids) {
    return null;
  }

  // Across the leading run of commuting filters, pick the most selective seed
  // (smallest candidate set wins).
  let bestAt = -1;
  let best: Seed | null = null;
  for (let i = 0; i < rest.length; i++) {
    const step = rest[i]!;
    if (!COMMUTING_FILTERS.has(step.kind)) {
      break;
    }
    const seed = seedForStep(step, graph);
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
    for (const vertex of set) {
      yield startTraverser(vertex, tracksPath);
    }
  })();

  const steps = best.removable ? rest.filter((_, i) => i !== bestAt) : rest;
  return { stream, steps };
};
