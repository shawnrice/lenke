// Seed a `V()` source from a property index instead of scanning every vertex.
//
// When a traversal opens `V()` (no explicit ids) followed by a run of filter
// steps that only narrow the start set — `has` / `hasLabel` / `hasLabelAnd` /
// `hasId` / `hasKey` / `hasNot`, which commute freely — and one of them is an
// equality `has(key, eq(value))` (or the property half of `has(label, key,
// eq(value))`) on a graph-indexed key, we seed directly from that key's index
// bucket rather than sweeping all of `V()`.
//
// The seed bucket is exactly the set of vertices carrying `key === value`, so
// it is a superset of the leading filters' conjunction; every leading filter is
// re-applied as a residual, which makes the result identical to the
// unoptimized scan. The one exception: a plain `has(key, eq)` whose bucket *is*
// its exact match set is dropped from the residuals as a small saving. A
// `hasLabelAnd` seed is kept, since the bucket doesn't encode its label half.
//
// Only `eq` is seeded: equality buckets match `===` exactly. Range / `within`
// seeding would have to reconcile the index's type-strict order with JS
// comparison coercion, so those stay as residual filters for now.

import type { Graph, Vertex } from '@pl-graph/core';

import type { Plan, Step } from '../ast.js';
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

type Candidate = { set: Set<Vertex> | undefined; size: number; removable: boolean };

/**
 * If `step` is an equality predicate on an indexed key, the bucket to seed
 * from. `removable` is true only when dropping `step` leaves an equivalent
 * plan — i.e. a plain `has` (its bucket is exact), but not `hasLabelAnd` (whose
 * label half the bucket doesn't capture).
 */
const candidateFor = (step: Step, graph: Graph): Candidate | null => {
  if (step.kind !== 'has' && step.kind !== 'hasLabelAnd') {
    return null;
  }
  if (step.pred.op !== 'eq' || !graph.vertexPropertyIndex.isIndexed(step.key)) {
    return null;
  }
  const set = graph.vertexPropertyIndex.equals(step.key, step.pred.value);
  return { set, size: set?.size ?? 0, removable: step.kind === 'has' };
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

  // Across the leading run of commuting filters, pick the most selective
  // equality seed (smallest bucket wins).
  let bestAt = -1;
  let best: Candidate | null = null;
  for (let i = 0; i < rest.length; i++) {
    const step = rest[i]!;
    if (!COMMUTING_FILTERS.has(step.kind)) {
      break;
    }
    const candidate = candidateFor(step, graph);
    if (candidate && candidate.size < (best?.size ?? Infinity)) {
      best = candidate;
      bestAt = i;
    }
  }

  if (!best) {
    return null;
  }

  // `best.set` may be undefined when nothing carries the value — an empty seed
  // that correctly short-circuits the whole traversal to no results.
  const seeds = best.set ?? new Set<Vertex>();
  const stream = (function* () {
    for (const vertex of seeds) {
      yield startTraverser(vertex, tracksPath);
    }
  })();

  const steps = best.removable ? rest.filter((_, i) => i !== bestAt) : rest;
  return { stream, steps };
};
