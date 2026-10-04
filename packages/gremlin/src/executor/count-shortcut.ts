import type { Edge, Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { matches } from '../predicates.js';

/**
 * `g.…count()` answered from the graph's counters instead of by enumerating.
 *
 * The GQL surface has had this family since audit items 95/99/112/114/125/129 —
 * `MATCH (n:Person) RETURN count(*)` is 0.0ms there. The Gremlin surface is a
 * separate TypeScript implementation and never got it, so the same question
 * spelled `g.V().hasLabel('Person').count()` enumerated 200,000 vertices and took
 * 57.5ms (audit item 130, which measured the surface for the first time).
 *
 * Deliberately NARROW. Every shape here is one the graph already keeps a counter
 * or a bucket for, so the shortcut is a read rather than a cheaper walk; anything
 * else returns `undefined` and runs normally. A shortcut that half-answers a shape
 * is a wrong answer, and these are the shapes whose answer is exactly a size.
 */
export const countShortcut = (plan: Plan, graph: Graph): number | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  const last = steps[steps.length - 1];

  // Only a GLOBAL count terminal. `count(local)` counts within each element of the
  // frontier, which is a different question entirely.
  if (last.kind !== 'count' || last.scope === 'local') {
    return undefined;
  }

  const [source, ...mid] = steps.slice(0, -1);

  // `V(id, …)` / `E(id, …)` enumerate a given set, not the whole graph.
  if ((source.kind !== 'V' && source.kind !== 'E') || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (mid.length === 0) {
    return source.kind === 'V' ? graph.vertexCount : graph.edgeCount;
  }

  if (source.kind !== 'V') {
    return undefined;
  }

  if (mid.length === 1) {
    return vertexStepCount(mid[0], graph);
  }

  return mid.length === 2 ? filteredHopCount(mid[0], mid[1], graph) : undefined;
};

/**
 * `V().out(T).has(k, pred).count()` — walk the edge bucket and tally, with no
 * traversers at all.
 *
 * This shape is **86.7% generator plumbing**: five nested layers resumed per edge
 * at ~60ns each, against a far-endpoint property read of only ~17ns (audit item
 * 132 — the far vertices are a small, repeatedly-touched set, so they stay
 * cache-warm, where the same read costs ~184ns on a cold single-pass SCAN). The
 * GQL surface answers its spelling of this question the same way
 * (`tallyHopCount`, items 112/125).
 *
 * `out(T)` emits one traverser per traversed EDGE, so iterating the type's bucket
 * visits exactly the same far endpoints in the same multiset — the count cannot
 * differ, only the cost.
 */
const filteredHopCount = (hop: Step, filter: Step, graph: Graph): number | undefined => {
  if (hop.kind !== 'out' && hop.kind !== 'in') {
    return undefined; // `both` double-counts a self-loop; see `vertexStepCount`
  }

  // A `has` with a predicate on ONE key, and nothing else. `hasLabel` and the
  // other filters have their own semantics and are not this shape.
  if (filter.kind !== 'has') {
    return undefined;
  }

  const buckets = bucketsFor(hop.labels, graph);

  if (buckets === undefined) {
    return undefined;
  }

  const forward = hop.kind === 'out';
  let n = 0;

  for (const bucket of buckets) {
    for (const edge of bucket) {
      const far = forward ? edge.to : edge.from;

      if (matches(filter.pred, far.properties[filter.key])) {
        n += 1;
      }
    }
  }

  return n;
};

/**
 * The edge buckets `out(labels)` / `in(labels)` traverse, or `undefined` when
 * iterating them would not visit each edge exactly once.
 *
 * Same soundness condition as `adjacentCount`: a two-type edge sits in two
 * buckets, so summing across types would visit it twice while the walk yields it
 * once.
 */
const bucketsFor = (
  labels: readonly string[],
  graph: Graph,
): readonly Iterable<Edge>[] | undefined => {
  if (labels.length === 0) {
    return [graph.edges];
  }

  if (labels.length > 1 && graph.multiTypeEdgeCount !== 0) {
    return undefined;
  }

  return labels.map((l) => graph.edgesByLabel.get(l) ?? new Set<Edge>());
};

/** The one intermediate step whose count is a bucket size. */
const vertexStepCount = (step: Step, graph: Graph): number | undefined => {
  if (step.kind === 'hasLabel') {
    return labelledCount(step.labels, graph);
  }

  if (step.kind === 'out' || step.kind === 'in') {
    return adjacentCount(step.labels, graph);
  }

  // `both` is NOT here on purpose: it walks a vertex's out-edges and then its
  // in-edges, so a self-loop is incident twice and the total is not a bucket size.
  // The general path already gets that right; a shortcut would have to re-derive it.
  return undefined;
};

/**
 * `out(T)` / `in(T)` emit one traverser per traversed EDGE, so counting them over
 * the whole vertex set counts the edges of those types — which is the bucket size.
 *
 * Summing across several types is only sound when no edge can sit in two of the
 * buckets, the same condition the GQL shortcut uses (`multiTypeEdgeCount === 0`);
 * otherwise a two-type edge would be counted twice while the walk yields it once.
 */
const adjacentCount = (labels: readonly string[], graph: Graph): number | undefined => {
  if (labels.length === 0) {
    return graph.edgeCount; // every edge, traversed once from its own endpoint
  }

  if (labels.length > 1 && graph.multiTypeEdgeCount !== 0) {
    return undefined;
  }

  let n = 0;

  for (const label of labels) {
    n += graph.edgesByLabel.get(label)?.size ?? 0;
  }

  return n;
};

/**
 * `hasLabel(a, b, …)` keeps a vertex carrying ANY of the labels, so the answer is
 * the union of the buckets — which is only a SUM when they cannot overlap. A
 * vertex may carry several labels, so the multi-label case needs the union and is
 * left to the general path rather than guessed at.
 */
const labelledCount = (labels: readonly string[], graph: Graph): number | undefined => {
  if (labels.length !== 1) {
    return undefined;
  }

  return graph.verticesByLabel.get(labels[0])?.size ?? 0;
};
