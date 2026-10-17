import type { Edge, Graph, Vertex } from '@lenke/core';

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
/**
 * Rewrite an eligible `repeat(<one hop>).times(k)` into its `k` chained hops, so every rung in
 * this file sees the shape it already understands (item 574).
 *
 * `repeat(out('T')).times(2)` IS `out('T').out('T')` — TinkerPop's `repeat` applies no edge or
 * vertex uniqueness, so the path count is the k-fold product. Both engines agree on that: at
 * 40,000 vertices of out-degree 3, `times(1)` is 120,000, `times(2)` is 360,000 and `times(3)`
 * is 1,080,000, which are exactly 3, 9 and 27 per start.
 *
 * Done as a PRE-PASS rather than a rung of its own, because then the one-hop rung answers
 * `times(1)` and the chain rung answers `times(2)` and up, with no new arm to keep in step.
 * Purely additive: every rung here declines a `repeat` step today, so nothing it already answers
 * can change.
 *
 * REFUSED, each for its own reason:
 *
 * - **`emit` / `emitBefore`** — the traverser is emitted at intermediate depths too, so the count
 *   is a SUM over depths rather than the k-fold product. A different arithmetic, not a chain.
 * - **`until` / `untilBefore`** — a per-traverser stop condition, so the depth is not `k`.
 * - **no `times`** — an uncapped repeat is bounded by an iteration cap, not by a hop count.
 * - **a body that is not exactly ONE `out`/`in` step** — anything else (a filter inside the body,
 *   `both`, a nested traversal) changes what each repetition does.
 * - **`times` above 16.** The chain's cost is fine (`O(k · E)`), but the multiplicity is a
 *   product: at out-degree 3, `3^16` is 43 million and exact in a float64, while `3^40` is past
 *   2^53 and would stop being. The engine's numeric model is float64, so the cap keeps this rung
 *   inside exact-integer range instead of silently rounding where the general path does not.
 */
const expandRepeats = (mid: readonly Step[]): readonly Step[] | undefined => {
  let changed = false;
  const out: Step[] = [];

  for (const step of mid) {
    if (step.kind !== 'repeat') {
      out.push(step);
      continue;
    }

    const { body, times, emit, emitBefore, until } = step;

    if (
      times === undefined ||
      times < 1 ||
      times > 16 ||
      emit !== undefined ||
      emitBefore === true ||
      until !== undefined ||
      body.steps.length !== 1
    ) {
      return undefined;
    }

    const [inner] = body.steps;

    if (inner.kind !== 'out' && inner.kind !== 'in') {
      return undefined;
    }

    for (let i = 0; i < times; i += 1) {
      out.push(inner);
    }

    changed = true;
  }

  return changed ? out : undefined;
};

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

  // THE REPEAT PRE-PASS (item 574), before any rung looks at `mid`: an eligible
  // `repeat(<one hop>).times(k)` becomes its k chained hops, and the recursion then takes
  // whichever rung fits. One level only — the expansion contains no `repeat`.
  const expanded = expandRepeats(mid);

  if (expanded !== undefined) {
    return countShortcut({ ...plan, steps: [source, ...expanded, last] }, graph);
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

  // A CHAIN of vertex filters, which is the shape a redundant step produces. Tried before the
  // hop counts below and after the single-step arm, so neither changes.
  const chain = filterChainCount(mid, graph);

  if (chain !== undefined) {
    return chain;
  }

  // A START-FILTERED hop: the filters come BEFORE the hop, so the answer is the degree sum over
  // the starts that survive them.
  const started = startFilteredHopCount(mid, graph);

  if (started !== undefined) {
    return started;
  }

  // A CHAIN of two or more hops (item 574). After the one-hop rung, so that one keeps every
  // shape it already answered.
  const chained = hopChainCount(mid, graph);

  if (chained !== undefined) {
    return chained;
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

/**
 * `V().hasLabel(L).has(k, pred).count()` and any other chain of VERTEX FILTERS — tallied over the
 * best source instead of run through the traverser pipeline.
 *
 * WHY. `vertexStepCount` above answers `V()` plus ONE step; two steps fell to the pipeline, and a
 * step that filters NOTHING is enough to get there. Measured at 200,000 vertices all carrying
 * `Person`, one case per process (item 537):
 *
 * ```text
 *   V().has(age, gt(44)).count()                      2.37 ms   11.9 ns a vertex   the tally
 *   V().has().has().count()                           6.25      31.2               the pipeline
 *   V().has().has().has().count()                     8.01      40.1
 *   V().hasLabel('Person').has(age, gt(44)).count()  19.27      96.4
 *   V().hasLabel().hasLabel().has().count()          25.83     129.1
 * ```
 *
 * So the pipeline costs ~40-50 ns a vertex PER STEP — item 234 measured the same thing as "3.3x of
 * that row is the pipeline, not the predicate: a traverser allocated per vertex to be filtered and
 * discarded". A redundant `hasLabel` is a 4.4x tax for excluding nothing, and the GQL engine
 * charges nothing for the same redundancy (item 536 measured `MATCH (n:Person) WHERE …` at 4.40 ms
 * against 4.41 unlabelled), so this is the surface that was behind.
 *
 * THE SOURCE. A `hasLabel` naming exactly ONE label is read off that label's bucket, so the tally
 * is O(bucket) rather than O(V). A multi-label `hasLabel` is an OR over buckets a vertex may sit
 * in several of, so it stays a predicate — `labelledCount` declines it for the same reason.
 *
 * SOUNDNESS. Every admitted step is a TOTAL predicate: `matches` returns false for a missing or
 * incomparable value rather than throwing, and a label test cannot fault. So evaluating all of
 * them over every vertex of the source raises exactly what the pipeline raises (nothing), and the
 * conjunction's order is unobservable — the same argument `propertyCount` makes, and the reason
 * this can tally rather than having to mirror the pipeline's short-circuit.
 *
 * It DECLINES when any `has` could seed an index, which is `propertyCount`'s load-bearing
 * condition: `countShortcut` runs before `seedFromIndex`, so a tally that scanned anyway would
 * answer in O(V) where a seek answers in O(matches) — item 149's failure, a fast path losing an
 * index.
 *
 * TWO MUTANTS SURVIVE and both are answer-preserving, recorded rather than left unexplained:
 * re-testing the label that already seeded the bucket is redundant work for the same count, and
 * admitting a ONE-step chain would duplicate `vertexStepCount` rather than contradict it (the
 * tally and the bucket read agree for both single-step kinds). `mid.length < 2` stays so the
 * single-step arm keeps its own, cheaper answer.
 */
const filterChainCount = (mid: readonly Step[], graph: Graph): number | undefined => {
  if (mid.length < 2) {
    return undefined;
  }

  const labelTests: (readonly string[])[] = [];
  const propTests: Extract<Step, { kind: 'has' }>[] = [];

  for (const step of mid) {
    if (step.kind === 'hasLabel') {
      labelTests.push(step.labels);
      continue;
    }

    if (step.kind !== 'has' || seedForStep(step, graph.vertexPropertyIndex) !== null) {
      return undefined;
    }

    propTests.push(step);
  }

  // The first SINGLE-label test becomes the source; the rest stay predicates.
  const seedAt = labelTests.findIndex((ls) => ls.length === 1);
  const source: Iterable<Vertex> =
    seedAt === -1
      ? graph.verticesById.values()
      : (graph.verticesByLabel.get(labelTests[seedAt][0]) ?? EMPTY_VERTICES);
  let n = 0;

  for (const v of source) {
    let ok = true;

    for (let i = 0; i < labelTests.length && ok; i += 1) {
      ok = i === seedAt || labelTests[i].some((l) => v.labels.has(l));
    }

    for (let i = 0; i < propTests.length && ok; i += 1) {
      ok = matches(propTests[i].pred, v.properties[propTests[i].key]);
    }

    if (ok) {
      n += 1;
    }
  }

  return n;
};

const EMPTY_VERTICES: readonly Vertex[] = [];

/** The two vertex-filter steps these tallies admit: a label test and a property predicate. */
type VertexFilter = Extract<Step, { kind: 'hasLabel' }> | Extract<Step, { kind: 'has' }>;

/**
 * `V().hasLabel(L).out(T).count()` — a hop whose START is filtered, counted as the degree sum
 * over the surviving starts.
 *
 * THE WORST SPELLING CLIFF THIS SURFACE HAD. `vertexStepCount` answers `V().out(T).count()` from
 * the edge bucket — O(1) — and `filteredHopCount` answers a filter AFTER the hop. A filter BEFORE
 * one had no arm at all, so it ran the pipeline. Measured at 100,000 vertices / 500,000 edges,
 * one case per process (item 539):
 *
 * ```text
 *   V().out('KNOWS').count()                         0.00 ms   the edge bucket's size
 *   V().hasLabel('Person').out('KNOWS').count()     96.36      500,000 traversers
 * ```
 *
 * Every vertex carries `Person`, so the label excludes nothing and the two ask the same question.
 * An O(1) read against a 96 ms walk is the bug class this repo is named after, and the GQL surface
 * has had the start-filtered hop count since item 206.
 *
 * `out(T)` emits one traverser per traversed EDGE, so the total is Σ the T-degree of the surviving
 * starts — the same argument `adjacentCount` makes, restricted to a subset of the starts. A COUNT
 * is order-free, so nothing observable moves.
 *
 * MULTI-TYPE needs `adjacentCount`'s guard: summing `out(a, b)` across buckets would count an edge
 * carrying both types twice, while the walk yields it once.
 *
 * RAISE PARITY is the condition that shapes the source. `matches` can throw (a cross-type
 * comparison, mirroring TinkerPop's `ClassCastException`), and the pipeline evaluates each filter
 * only on the elements the EARLIER filters passed. So the filters are applied here in written
 * order with a short circuit, and the label bucket may only be the source when its `hasLabel` is
 * FIRST — where the bucket is exactly that step's survivors. A `has` ahead of a `hasLabel` must
 * therefore be evaluated over every vertex, which is what the pipeline does.
 *
 * It DECLINES on a seedable `has` for `propertyCount`'s reason: `countShortcut` runs before
 * `seedFromIndex`, so a tally that scanned anyway would lose an index (item 149).
 *
 * ONE MUTANT SURVIVES and is answer-preserving: not slicing the seeded `hasLabel` out of `rest`
 * re-tests the label the bucket already guarantees — redundant work for the same count. Recorded
 * rather than left unexplained. The other five are caught: `both` admitted, the direction
 * ignored, the filters disjoined, the index decline removed, and a MULTI-label allowed to seed a
 * single bucket (which drops every vertex carrying only the second label).
 */
/** A hop step, narrowed: `both` is excluded for the self-loop reason the rungs above give. */
type HopStep = Extract<Step, { kind: 'out' | 'in' }>;

/**
 * `V().<filters>.out(T).out(T)….count()` — a CHAIN of two or more hops, counted by propagating
 * FRONTIER MULTIPLICITIES instead of running one traverser per path (item 574).
 *
 * `startFilteredHopCount` above answers the one-hop case as a degree sum. Two hops had no rung at
 * all, and the shape is common: it is what `out().out().count()` and `repeat(out()).times(2)`
 * both are. Priced at 40,000 vertices / 120,000 edges, one case per process:
 *
 *   V().hasLabel(P).out(T).count()               ts   0.01ms   nv 0.11   the existing rung
 *   V().hasLabel(P).out(T).out(T).count()           139.85        0.41   341x, no rung
 *
 * THE ALGORITHM. A plain `out()` chain is a WALK — no edge or vertex uniqueness — so the number
 * of paths reaching a vertex is all that matters, not which paths they were. Carry a multiplicity
 * per frontier vertex and push it along each edge: O(k · E) edge visits for k hops, whatever the
 * path count. Item 574's `times(3)` case is 1,080,000 paths over 120,000 edges, so the saving
 * grows with depth.
 *
 * The LAST hop needs no map — a frontier vertex contributes `multiplicity × degree`, so it is a
 * degree sum exactly as the one-hop rung is. That keeps k = 2 to one propagation pass plus an
 * O(1) read per surviving vertex.
 *
 * SOUNDNESS, two conditions both borrowed from the rungs above:
 *
 * - **`out`/`in` only, never `both`.** `both` walks out-edges then in-edges, so a self-loop is
 *   incident twice and neither a bucket size nor a single pass over one box is the degree —
 *   the same exclusion `vertexStepCount` and `startFilteredHopCount` make.
 * - **A multi-label hop declines when the graph holds a multi-type edge** (`multiTypeEdgeCount`).
 *   Such an edge sits in two buckets, so iterating across types visits it twice where the walk
 *   yields it once. Item 573 shipped exactly that bug on the GQL side and the suite caught it.
 */
/**
 * The SHAPE half of {@link hopChainCount}: split `mid` into leading vertex filters and a
 * trailing run of hops, and refuse anything the arithmetic cannot carry.
 *
 * Its own function because `hopChainCount` sits on the complexity gate — inline, the two halves
 * read 43 against a maximum of 35. The same split `tallyGroupShapes` and `genQuantifiedGroup`
 * make, and the same reason.
 */
const hopChainShape = (
  mid: readonly Step[],
  graph: Graph,
): { hops: HopStep[]; source: Iterable<Vertex>; rest: VertexFilter[] } | undefined => {
  // Split `mid` into a leading run of vertex filters and a trailing run of hops. The hops are
  // COLLECTED rather than sliced, because a `kind` test in this loop does not narrow a later
  // `mid.slice(...)` for the type checker.
  const hops: HopStep[] = [];
  let split = mid.length;

  for (let i = mid.length - 1; i >= 0; i -= 1) {
    const step = mid[i];

    if (step.kind !== 'out' && step.kind !== 'in') {
      break;
    }

    hops.unshift(step);
    split = i;
  }

  const filters = mid.slice(0, split);

  // One hop is `startFilteredHopCount`'s shape, and it is tried first — this rung must not
  // change what that one answers.
  if (hops.length < 2) {
    return undefined;
  }

  // `!== 1`, NOT `> 1`. Exactly one wanted label is unconditionally safe: an edge sits in that
  // bucket once. ZERO labels (`out()`) iterates EVERY bucket, so a multi-type edge is visited
  // once per label it carries — the same hazard as several labels, and the guard above this one
  // read `> 1` until the sweep found 13 divergences, every one of them an `out()` at depth 2 or
  // more. `out(T,U)` was never among them, because that case the narrow guard did catch.
  //
  // Item 573 shipped this exact bug on the GQL side one tick ago. Twice in two ticks is not bad
  // luck: a per-label bucket sum is only a degree when the wanted set is a single bucket.
  for (const hop of hops) {
    if (hop.labels.length !== 1 && graph.multiTypeEdgeCount !== 0) {
      return undefined;
    }
  }

  const vfilters: VertexFilter[] = [];

  for (const step of filters) {
    if (step.kind !== 'hasLabel' && step.kind !== 'has') {
      return undefined;
    }

    // A seekable `has` is the index's job, not this rung's — the same refusal the one-hop
    // rung makes, so the two cannot disagree about which shapes they take.
    if (step.kind === 'has' && seedForStep(step, graph.vertexPropertyIndex) !== null) {
      return undefined;
    }

    vfilters.push(step);
  }

  const [first] = vfilters;
  const canSeed = first?.kind === 'hasLabel' && first.labels.length === 1;
  const source: Iterable<Vertex> =
    first?.kind === 'hasLabel' && first.labels.length === 1
      ? (graph.verticesByLabel.get(first.labels[0]) ?? EMPTY_VERTICES)
      : graph.verticesById.values();
  const rest = canSeed ? vfilters.slice(1) : vfilters;

  return { hops, source, rest };
};

const hopChainCount = (mid: readonly Step[], graph: Graph): number | undefined => {
  const shape = hopChainShape(mid, graph);

  if (shape === undefined) {
    return undefined;
  }

  const { hops, source, rest } = shape;

  // The surviving starts, as a lazy generator — each has multiplicity ONE, so the two-hop arm
  // below needs no map at all. Building one there was measured and is also DEAD WEIGHT: a
  // mutant dropping the `m *` factor from that arm SURVIVED, because `m` is provably 1 on the
  // initial frontier (`verticesByLabel` is a Set and `verticesById.values()` is unique). The
  // multiplicity map earns its place only from three hops on.
  const survivors = function* (): Generator<Vertex> {
    for (const v of source) {
      let ok = true;

      for (let i = 0; i < rest.length && ok; i += 1) {
        const step = rest[i];

        ok =
          step.kind === 'hasLabel'
            ? step.labels.some((l) => v.labels.has(l))
            : matches(step.pred, v.properties[step.key]);
      }

      if (ok) {
        yield v;
      }
    }
  };

  // TWO hops need no frontier map: each first-hop target contributes its own degree, so the
  // answer is a double loop with an O(1) read at the bottom. Worth its own arm — the map
  // version measured 33.56/33.00/31.70ms against 26.83/24.26/25.89 over three alternated
  // rounds, because 120,000 `Map.set`/`get` pairs on vertex objects cost more than the edge
  // walk itself.
  if (hops.length === 2) {
    const [h0, h1] = hops;
    const fwd0 = h0.kind === 'out';
    const fwd1 = h1.kind === 'out';
    let two = 0;

    for (const v of survivors()) {
      const box0 = fwd0 ? v.adjFrom : v.adjTo;

      if (box0 === undefined) {
        continue;
      }

      for (const set of h0.labels.length === 0 ? box0.values() : bucketsOf(box0, h0.labels)) {
        for (const e of set) {
          const w = fwd0 ? e.to : e.from;
          const box1 = fwd1 ? w.adjFrom : w.adjTo;

          if (box1 !== undefined) {
            two += degreeOfTypes(box1, h1.labels);
          }
        }
      }
    }

    return two;
  }

  // THREE hops or more: carry a multiplicity per frontier vertex and push it along each edge.
  let cur = new Map<Vertex, number>();

  for (const v of survivors()) {
    cur.set(v, 1);
  }

  for (let h = 0; h < hops.length - 1; h += 1) {
    const hop = hops[h];
    const forward = hop.kind === 'out';
    const next = new Map<Vertex, number>();

    for (const [v, m] of cur) {
      const byType = forward ? v.adjFrom : v.adjTo;

      if (byType === undefined) {
        continue;
      }

      for (const set of hop.labels.length === 0 ? byType.values() : bucketsOf(byType, hop.labels)) {
        for (const e of set) {
          const w = forward ? e.to : e.from;

          next.set(w, (next.get(w) ?? 0) + m);
        }
      }
    }

    cur = next;
  }

  // The last hop is a degree SUM, weighted by multiplicity.
  const lastHop = hops[hops.length - 1];
  const forward = lastHop.kind === 'out';
  let total = 0;

  for (const [v, m] of cur) {
    const byType = forward ? v.adjFrom : v.adjTo;

    if (byType !== undefined) {
      total += m * degreeOfTypes(byType, lastHop.labels);
    }
  }

  return total;
};

/** The wanted buckets of one adjacency box. Only reached when the multi-type guard above
 *  has cleared, so iterating several of them visits each edge once. */
const bucketsOf = (
  byType: ReadonlyMap<string, ReadonlySet<Edge>>,
  labels: readonly string[],
): ReadonlySet<Edge>[] => {
  const out: ReadonlySet<Edge>[] = [];

  for (const t of labels) {
    const set = byType.get(t);

    if (set !== undefined) {
      out.push(set);
    }
  }

  return out;
};

const startFilteredHopCount = (mid: readonly Step[], graph: Graph): number | undefined => {
  if (mid.length < 2) {
    return undefined;
  }

  const hop = mid[mid.length - 1];

  // `both` walks out-edges then in-edges, so a self-loop is incident twice and the total is not a
  // degree sum — the same exclusion `vertexStepCount` makes.
  if (hop.kind !== 'out' && hop.kind !== 'in') {
    return undefined;
  }

  if (hop.labels.length > 1 && graph.multiTypeEdgeCount !== 0) {
    return undefined;
  }

  const filters: VertexFilter[] = [];

  for (const step of mid.slice(0, -1)) {
    if (step.kind !== 'hasLabel' && step.kind !== 'has') {
      return undefined;
    }

    if (step.kind === 'has' && seedForStep(step, graph.vertexPropertyIndex) !== null) {
      return undefined;
    }

    filters.push(step);
  }

  const [first] = filters;

  // The source: the FIRST filter's bucket when that filter is a single-label `hasLabel`, because
  // the bucket is exactly its survivors and nothing before it could have faulted.
  const canSeed = first.kind === 'hasLabel' && first.labels.length === 1;
  // The condition is repeated rather than reusing `canSeed`, which narrows `first` inside the
  // branch and so needs no cast.
  const source: Iterable<Vertex> =
    first.kind === 'hasLabel' && first.labels.length === 1
      ? (graph.verticesByLabel.get(first.labels[0]) ?? EMPTY_VERTICES)
      : graph.verticesById.values();
  const rest = canSeed ? filters.slice(1) : filters;
  const forward = hop.kind === 'out';
  let n = 0;

  for (const v of source) {
    let ok = true;

    for (let i = 0; i < rest.length && ok; i += 1) {
      const step = rest[i];

      ok =
        step.kind === 'hasLabel'
          ? step.labels.some((l) => v.labels.has(l))
          : matches(step.pred, v.properties[step.key]);
    }

    if (!ok) {
      continue;
    }

    // The vertex's OWN adjacency box, not a hash of its id into the graph's map — the GQL twin
    // has read the box since items 162 and 321. Measured on the first version of this function,
    // 100,000 vertices / 500,000 edges, same answer either way:
    //
    //   graph.edgesFromByLabel.get(v.id)   22.13 ms   16.25 ms   12.51 ms
    //   v.adjFrom                          16.25       1.99      10.68
    //
    // for `hasLabel('Person')` (every vertex), `hasLabel('Few')` (a quarter) and
    // `has(age, gt(44))`. The box wins on all three, by 1.4x where it reads every vertex and 2.7x
    // on the quarter — a string-keyed `Map.get` is ~190 ns (item 194) and the getter caches the
    // lookup per vertex, so the saving grows with how often a vertex is revisited.
    const byType = forward ? v.adjFrom : v.adjTo;

    if (byType !== undefined) {
      n += degreeOfTypes(byType, hop.labels);
    }
  }

  return n;
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
