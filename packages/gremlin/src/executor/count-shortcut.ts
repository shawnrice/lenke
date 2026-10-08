import type { Edge, Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { matches } from '../predicates.js';
import { seedForStep } from './index-seed.js';

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

  if (mid.length !== 2) {
    return undefined;
  }

  return filteredHopCount(mid[0], mid[1], graph) ?? distinctHopCount(mid[0], mid[1], graph);
};

/**
 * `V().out(T).dedupe().count()` — the number of DISTINCT far endpoints, read off
 * the REVERSE adjacency index instead of walking every edge.
 *
 * The distinct targets of the type-`T` edges are exactly the vertices holding at
 * least one in-edge of type `T`, and `edgesToByLabel` is keyed by vertex. So this
 * is O(V) where the walk is O(E) — 200,000 keys instead of 1,000,000 edges on the
 * bench fixture — and it allocates no `Set` of its own, where `dedupe` builds one
 * holding every distinct vertex.
 *
 * MULTI-TYPE NEEDS NO EXTRA CONDITION HERE, unlike the edge counts above: this
 * counts VERTICES, and "has a non-empty bucket for any of these labels" is a
 * UNION per vertex. An edge carrying two of the named types makes its target
 * qualify once either way.
 *
 * A vertex whose last `T` edge was DELETED is still a key: `deIndexEdgeLabel`
 * removes that label's entry but leaves the per-vertex entry behind. So the test
 * is per-label, not a key count.
 *
 * The non-empty (`size > 0`) part of that test is DEFENSIVE, and mutation says so:
 * `deIndexEdgeLabel` removes a label's entry as soon as its set empties, and
 * `indexEdgeLabel` only ever creates a set it immediately fills, so an empty
 * bucket does not persist today. Replacing the check with `byLabel.has(label)`
 * changes no answer. It stays because that equivalence depends on two other
 * functions keeping their invariant.
 */
const distinctHopCount = (hop: Step, filter: Step, graph: Graph): number | undefined => {
  if (hop.kind !== 'out' && hop.kind !== 'in') {
    return undefined; // `both` reaches a vertex from either side; not one index
  }

  // Only the BARE `dedupe()`. Path-label scoping (`dedupe('a')`) and by-modulators
  // dedupe on something other than the element.
  if (
    filter.kind !== 'dedupe' ||
    (filter.labels?.length ?? 0) > 0 ||
    (filter.bys?.length ?? 0) > 0
  ) {
    return undefined;
  }

  // `out` lands on an edge's TARGET, so its distinct endpoints are the keys of the
  // TO index; `in` lands on the source, so the FROM index.
  const index = hop.kind === 'out' ? graph.edgesToByLabel : graph.edgesFromByLabel;
  const { labels } = hop;
  let n = 0;

  for (const byLabel of index.values()) {
    if (labels.length === 0 ? anyNonEmpty(byLabel) : hasAny(byLabel, labels)) {
      n += 1;
    }
  }

  return n;
};

const anyNonEmpty = (byLabel: ReadonlyMap<string, ReadonlySet<Edge>>): boolean => {
  for (const set of byLabel.values()) {
    if (set.size > 0) {
      return true;
    }
  }

  return false;
};

const hasAny = (
  byLabel: ReadonlyMap<string, ReadonlySet<Edge>>,
  labels: readonly string[],
): boolean => {
  for (const label of labels) {
    if ((byLabel.get(label)?.size ?? 0) > 0) {
      return true;
    }
  }

  return false;
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

  const forward = hop.kind === 'out';

  // Drive the FAR side where it is sound: one predicate test per far VERTEX, contributing that
  // vertex's whole degree, instead of one per EDGE with a vertex lookup to go with it.
  //
  // The comment above says the far-endpoint read costs ~17ns because those vertices "stay
  // cache-warm". That is true of the small unit fixture it was measured on and NOT of 200,000:
  // at bench scale the read is a random-order lookup and a cold pointer chase, and this row was
  // 130.1ms against native's 1.53ms. Measured over 1,000,000 edges (audit item 168):
  //
  //   selectivity          edge-driven   vertex-driven
  //   gt(44), ~50% pass        104.2ms         34.1ms   3.06x
  //   gt(85), 4.4% pass        101.7ms         29.8ms   3.41x
  //   gt(500), none pass       101.3ms         25.3ms   4.00x
  //
  // `out(T)` emits one traverser per traversed EDGE, so summing each far vertex's degree of
  // that type gives the identical total — the same argument the edge-driven walk relies on,
  // read from the other end. A COUNT is order-free, so nothing observable moves.
  //
  // RAISE PARITY comes free here, unlike the GQL twin (item 164): `matches` can throw (a
  // cross-type comparison, mirroring TinkerPop's `ClassCastException`), and the predicate is
  // evaluated for exactly the vertices carrying at least one edge of the queried type — which
  // is exactly the set of far endpoints the edge walk visits. No vertex gains or loses an
  // evaluation, so no fault appears or disappears.
  if (hop.labels.length === 1 || graph.multiTypeEdgeCount === 0) {
    const index = forward ? graph.edgesToByLabel : graph.edgesFromByLabel;
    let n = 0;

    for (const v of graph.vertices) {
      const byType = index.get(v.id);

      if (byType === undefined) {
        continue;
      }

      const deg = degreeOfTypes(byType, hop.labels);

      // A vertex with no edge of this type is not a far endpoint of this hop, so it must not be
      // tested — that is what keeps the evaluated set identical.
      if (deg === 0) {
        continue;
      }

      if (matches(filter.pred, v.properties[filter.key])) {
        n += deg;
      }
    }

    return n;
  }

  // Several named types AND an edge carrying two of them: summing per-vertex buckets would
  // count that edge twice, so this stays on the edge-driven walk, which visits each edge once.
  const buckets = bucketsFor(hop.labels, graph);

  if (buckets === undefined) {
    return undefined;
  }

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
 * One vertex's degree across the hop's edge types, given its row of the adjacency index. An
 * EMPTY type list means an untyped hop and so every type — reached only where no edge carries
 * two types, which is what makes summing the buckets safe.
 */
const degreeOfTypes = (
  byType: ReadonlyMap<string, ReadonlySet<Edge>>,
  types: readonly string[],
): number => {
  let deg = 0;

  if (types.length === 0) {
    for (const set of byType.values()) {
      deg += set.size;
    }

    return deg;
  }

  for (const t of types) {
    deg += byType.get(t)?.size ?? 0;
  }

  return deg;
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

  if (step.kind === 'has') {
    return propertyCount(step, graph);
  }

  // `both` is NOT here on purpose: it walks a vertex's out-edges and then its
  // in-edges, so a self-loop is incident twice and the total is not a bucket size.
  // The general path already gets that right; a shortcut would have to re-derive it.
  return undefined;
};

/**
 * `V().has(k, pred).count()` — tallied over the vertex set instead of run through the traverser
 * pipeline.
 *
 * The ONE shape in this file that is not a counter or a bucket read, and it earns that by being
 * measured against a hand-written floor rather than against the engine it replaces. On 200,000
 * vertices (audit item 234):
 *
 *     the traverser pipeline                    7.65ms   38.2ns a vertex
 *     a hand-written tally, same answer          2.30ms   11.5ns
 *     the scan alone, touching no property       0.91ms    4.6ns
 *
 * So 3.3x of that row is the pipeline, not the predicate — a traverser allocated per vertex to be
 * filtered and discarded. The same measurement RETRACTED this item's other two candidates:
 * `V().out().has().count()` is 50.62ms against a 44.24ms floor, so its 32.6x gap to the native
 * engine is a data-layout difference and not an overhead to recover.
 *
 * **It declines when the index could seed**, which is the load-bearing condition rather than a
 * nicety. `countShortcut` is consulted BEFORE `seedFromIndex`, so a tally that scanned anyway
 * would answer in O(V) where the general path's seed answers in O(matches) — a fast path LOSING an
 * index, which is item 149's failure (the tell there was two identical `bench:usage` columns). The
 * tally therefore fires exactly where the general path would have scanned, so it cannot be slower
 * than what it replaces.
 *
 * Raise parity is free, and for a stronger reason than usual: `matches` is applied to every vertex
 * in `verticesById` order, which is precisely what `V()` emits and what the `has` step filters. The
 * evaluated set and its order are identical, so no fault can appear or disappear. (`matches` is
 * total in any case — the ordering predicates return false for a missing or incomparable value
 * rather than throwing.)
 */
const propertyCount = (step: Extract<Step, { kind: 'has' }>, graph: Graph): number | undefined => {
  if (seedForStep(step, graph.vertexPropertyIndex) !== null) {
    return undefined;
  }

  let n = 0;

  // `verticesById.values()` rather than the `vertices` view, which allocates an object per access
  // to wrap this very iterator.
  for (const v of graph.verticesById.values()) {
    if (matches(step.pred, v.properties[step.key])) {
      n += 1;
    }
  }

  return n;
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
