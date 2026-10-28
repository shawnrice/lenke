import type { Edge, Graph, Vertex } from '@lenke/core';

import type { Plan, Predicate, Step } from '../ast.js';
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

  // Filters on BOTH sides of ONE hop (item 932). Disjoint from its two siblings by construction —
  // `startFilteredHopCount` above requires the hop LAST and `filteredHopCount` below requires it
  // FIRST, while this one requires at least one step on each side — so the order among the three
  // cannot change which shapes they answer.
  const bothSides = bothFilteredHopCount(mid, graph);

  if (bothSides !== undefined) {
    return bothSides;
  }

  // A CHAIN of two or more hops (item 574). After the one-hop rung, so that one keeps every
  // shape it already answered.
  const chained = hopChainCount(mid, graph);

  if (chained !== undefined) {
    return chained;
  }

  // A hop followed by a CHAIN of one or more `has` filters (item 930). This was gated behind
  // `mid.length !== 2` — exactly one filter — and a second `has` fell off the end of every rung to
  // the general traversal at 11.15x. `filteredHopCount` returns `undefined` unless every step
  // after the hop is a `has`, so `dedupe` still reaches `distinctHopCount` below.
  if (mid.length < 2) {
    return undefined;
  }

  // THE EDGE-HOP SEED (item 1044), before its VERTEX-hop sibling. The order is not load-bearing —
  // `filteredHopCount` takes only `out`/`in` and this one only `outE`/`inE`, so the two are
  // disjoint by construction — but it reads in the same place the shapes are listed.
  const edgeSeeded = edgeHopSeededCount(mid[0], mid.slice(1), graph);

  if (edgeSeeded !== undefined) {
    return edgeSeeded;
  }

  // THE START-FILTERED form (item 1046): `[hasLabel, outE/inE, …has]`. `countShortcut` hands each
  // rung `mid[0]`, so a leading `hasLabel` made the rung above decline and the query fell through
  // at 5.206 ms against the bare hop's 0.018 — and this is the spelling the realistic question
  // takes (`hasLabel('Person').outE('APPLIED_TO').has('stage', …)`).
  //
  // Disjoint from `bothFilteredHopCount` and `startFilteredHopCount` by construction: both of
  // those require `out`/`in`, where this requires `outE`/`inE`.
  // `>= 2` is the real requirement — `mid[1]` must exist — and NOT `>= 3`: a tighter guard was
  // redundant, because `hasChain` refuses an EMPTY rest, so `[hasLabel, outE]` declines inside the
  // rung either way. The `widen-arity` mutant proved the redundancy by surviving, and item 1016's
  // rule is that a gate nothing can observe comes out rather than staying untested.
  if (mid.length >= 2 && mid[0].kind === 'hasLabel') {
    const startSeeded = edgeHopSeededCount(mid[1], mid.slice(2), graph, mid[0].labels);

    if (startSeeded !== undefined) {
      return startSeeded;
    }
  }

  const filtered = filteredHopCount(mid[0], mid.slice(1), graph);

  if (filtered !== undefined) {
    return filtered;
  }

  // `distinctHopCount` is the [hop, dedupe] pair and takes exactly two.
  if (mid.length !== 2) {
    return undefined;
  }

  return distinctHopCount(mid[0], mid[1], graph);
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
/**
 * The first three key/predicate pairs as flat locals, padded when there are fewer.
 *
 * Cold — once per query — and extracted at item 993 for the same reason as [`hasChain`]: the
 * width-3 arm pushed `filteredHopCount` past the complexity limit, and the padding ternaries are
 * the cheapest thing to move because nothing here runs per candidate. The padding value for an
 * absent predicate is `preds[0]`, never `undefined`, so the slot stays monomorphic for the arms
 * that read it without using it.
 */
const unrollSlots = (
  keys: readonly string[],
  preds: readonly Predicate[],
): [string, Predicate, string, Predicate, string, Predicate] => [
  keys[0],
  preds[0],
  keys.length > 1 ? keys[1] : '',
  keys.length > 1 ? preds[1] : preds[0],
  keys.length > 2 ? keys[2] : '',
  keys.length > 2 ? preds[2] : preds[0],
];

/**
 * `rest` as a non-empty chain of `has` steps, or `undefined` if anything else appears.
 *
 * Extracted from `filteredHopCount` at item 993, for the LINT gate rather than for speed: adding
 * the width-3 straight-line arm took that function to a cyclomatic complexity of 38 against a
 * limit of 35. It is the right thing to move because it is COLD — it runs once per query, where
 * the width arms it makes room for run once per candidate. Extracting one of THOSE instead would
 * have undone the change: item 934 measured entering a call at ~65 ns a row, which is the whole
 * of the step the unrolls exist to remove.
 */
const hasChain = (rest: readonly Step[]): Extract<Step, { kind: 'has' }>[] | undefined => {
  const filters: Extract<Step, { kind: 'has' }>[] = [];

  for (const step of rest) {
    if (step.kind !== 'has') {
      return undefined;
    }

    filters.push(step);
  }

  return filters.length === 0 ? undefined : filters;
};

/** An edge-index seed candidate: an estimate, a thunk, and whether its step may be dropped. */
export type EdgeCandidate = {
  count: number;
  build: () => ReadonlySet<Edge>;
  removable: boolean;
};

/**
 * Does `candidate` beat the incumbent — i.e. is it the more selective seed?
 *
 * EXPORTED AND EXTRACTED because the choice is ANSWER-EQUIVALENT: every candidate's bucket is a
 * SUPERSET of the answer and `edgeHopSeededCount` re-applies the hop labels and every residual
 * filter afterwards, so picking the wider one is slower and never wrong. A mutant flipping `<` to
 * `>` passed all 864 Gremlin tests. That is `perf-gate-needs-its-own-test`: extract the arithmetic
 * as a pure function and unit-test it, because no result can.
 *
 * (`seedRest` in `index-seed.ts` makes the same choice inline and is untested in the same way —
 * a separate cleanup, noted rather than bundled in here.)
 */
export const beats = (candidate: EdgeCandidate, best: EdgeCandidate | null): boolean =>
  best === null || candidate.count < best.count;

/**
 * `V().outE(T…).has(k, v)….count()` — an EDGE hop followed by `has` filters, SEEDED from the edge
 * property index (item 1044).
 *
 * Item 1043 priced the gap at 550-650x and located it exactly: `filteredHopCount` below takes only
 * `out`/`in` (VERTEX hops, where the filter applies to the far vertex), so an EDGE hop followed by
 * edge filters reached no rung at all and fell to the general traversal. Meanwhile
 * `E().hasLabel(T).has(k, v).count()` — the same question, the other spelling — is seeded by
 * `seedFromIndex` and answers in 0.017-0.019 ms against this shape's 13.8-16.1.
 *
 * ```text
 *   E().has(amount, 500).count()                0.028  0.025  0.025 ms
 *   E().hasLabel(PAID).has(amount).count()      0.019  0.017  0.017
 *   V().outE(PAID).has(amount).count()         16.145 13.787 14.471   <- this shape
 *   V().outE(PAID).has(other).count()          15.789 16.315 16.464   <- unindexed CONTROL
 * ```
 *
 * The subject landing ON the unindexed control is what says the index was UNREACHABLE here rather
 * than merely less effective.
 *
 * SEED OR DECLINE, deliberately. When no filter offers an indexed seek this returns `undefined`
 * and the existing path takes the query unchanged — so the rung cannot be slower than today for
 * any shape, and there is no second scanning implementation to keep in step with the first.
 *
 * WHY A COUNT IS SAFE WHERE THE GENERAL SEED IS NOT (item 1043). Seeding makes the enumeration
 * follow the edge index, i.e. `E()`'s order, and TinkerPop 3.7.3 returns `E()` and `V().outE()` in
 * DIFFERENT orders — `[e1,e2,e3,e4]` against `[e2,e4,e1,e3]` on a fixture built to tell them apart
 * — which lenke reproduces exactly. A `count()` cannot observe order, so it is the one terminal
 * that may take this route; an order-visible one must not.
 *
 * `bothE` IS EXCLUDED, for `vertexStepCount`'s reason, and TinkerPop was asked rather than assumed:
 * on 4 `T` edges including a self-loop, `V().outE(T).count()` and `V().inE(T).count()` are both 4
 * while `V().bothE(T).count()` is **8** — each edge enumerated from both endpoints. `outE`/`inE`
 * each visit an edge exactly ONCE (from its source, or from its target), and the self-loop too, so
 * for them the answer is the number of matching edges. The same console run confirmed
 * `V().outE(T).has(w,1)` = `V().inE(T).has(w,1)` = `E().hasLabel(T).has(w,1)` = 3.
 */
const edgeHopSeededCount = (
  hop: Step,
  rest: readonly Step[],
  graph: Graph,
  /** A leading `hasLabel`'s labels, constraining the vertex the hop DEPARTS FROM (item 1046).
   *
   *  `undefined` = the bare `V()` form of item 1044. Which endpoint it constrains is the hop's
   *  direction, and TinkerPop 3.7.3 was asked rather than assumed, on Person->Co, Co->Person,
   *  Person->Person and a Person SELF-LOOP: `V().hasLabel(Person).outE(T)` is 3 and
   *  `V().hasLabel(Co).outE(T)` is 1 against 4 edges, so `outE` partitions by the edge's SOURCE;
   *  `inE` gives 3 and 1 the other way round, so it partitions by the TARGET. The self-loop is
   *  counted once by each, and `hasLabel(Person, Co)` is the union at 4. */
  startLabels?: readonly string[],
): number | undefined => {
  // `bothE` IS `outE` PLUS `inE`, AND THE "2x" RULE WOULD HAVE BEEN WRONG (item 1089).
  //
  // The header excluded `bothE` because it "enumerates each edge twice", which is true of the BARE
  // form and not of the labelled one. TinkerPop 3.7.3, on P->Q, Q->P, P->P, a P self-loop, a Q
  // self-loop at `w=2` and a second P->Q:
  //
  //   E T w1 5    outE T w1 5    bothE T w1 10       <- bare: twice the matching edges
  //   P outE T w1 4   P inE T w1 3   P bothE T w1 7  <- labelled: 4 + 3, NOT 2 x 4
  //
  // THE FIRST FIXTURE I BUILT COULD NOT TELL THE TWO RULES APART: without that last P->Q edge,
  // P's total out-degree equalled its total in-degree, so `P bothE` was 6 and `2 x P outE` was
  // also 6. One edge breaks the symmetry and the "2x" rule is off by one — the coinciding-fixture
  // trap, caught here BEFORE the code was written rather than after.
  //
  // So the rule is the SUM, which covers both cases uniformly (bare 5 + 5 = 10, labelled 4 + 3 =
  // 7) and is the same composition item 1087 used for the vertex step. `startLabels` is passed
  // through unchanged: `outE` partitions by the edge's SOURCE and `inE` by its TARGET, which is
  // exactly what makes an edge with both ends in the label set count twice and an edge with one
  // end count once.
  if (hop.kind === 'bothE') {
    const outward = edgeHopSeededCount(
      { kind: 'outE', labels: hop.labels },
      rest,
      graph,
      startLabels,
    );

    if (outward === undefined) {
      return undefined;
    }

    const inward = edgeHopSeededCount(
      { kind: 'inE', labels: hop.labels },
      rest,
      graph,
      startLabels,
    );

    // Unreachable today for item 1087's reason — this function's declines read `rest`, the labels,
    // the graph and the index, never the direction — and kept for item 583's: a direction-dependent
    // decline added later would otherwise answer HALF the count instead of declining.
    return inward === undefined ? undefined : outward + inward;
  }

  if (hop.kind !== 'outE' && hop.kind !== 'inE') {
    return undefined;
  }

  const filters = hasChain(rest);

  if (filters === undefined) {
    return undefined;
  }

  // The most selective indexed filter wins, exactly as `seedRest` chooses among leading filters —
  // `seedForStep` estimates without building, so the losing candidates cost nothing.
  let best: EdgeCandidate | null = null;
  let bestAt = -1;

  for (let i = 0; i < filters.length; i++) {
    const candidate = seedForStep<Edge>(filters[i], graph.edgePropertyIndex);

    if (candidate && beats(candidate, best)) {
      best = candidate;
      bestAt = i;
    }
  }

  if (!best) {
    return undefined;
  }

  const { labels } = hop;
  const forward = hop.kind === 'outE';
  // Every filter stays as a residual EXCEPT a removable winner, whose bucket is exactly its match
  // set. Extracted into dense arrays for `filteredHopCount`'s reason (item 934): reading `f.key` /
  // `f.pred` off a wide `Step` union per row is a polymorphic load at a per-row site.
  const keys: string[] = [];
  const preds: Predicate[] = [];

  for (let i = 0; i < filters.length; i++) {
    if (i === bestAt && best.removable) {
      continue;
    }

    keys.push(filters[i].key);
    preds.push(filters[i].pred);
  }

  let n = 0;

  for (const edge of best.build()) {
    // The index bucket is keyed by the PROPERTY and knows nothing about the edge type, so the
    // hop's labels are re-applied. No label = every type. Each edge is tested ONCE and counted
    // once, so a multi-label edge matching two of the wanted labels is not double-counted — which
    // is why this needs no `multiTypeEdgeCount` guard, where SUMMING buckets (`adjacentCount`)
    // does.
    if (labels.length > 0) {
      let typed = false;

      for (const l of labels) {
        if (edge.labels.has(l)) {
          typed = true;
          break;
        }
      }

      if (!typed) {
        continue;
      }
    }

    // THE START VERTEX'S LABEL (item 1046), re-applied off the edge itself — `from` for an `outE`
    // and `to` for an `inE`, per the console readings in `startLabels`'s own doc. This is item
    // 1038's device: an edge-driven walk gets its endpoints from the edge, so a constraint on the
    // vertex the hop departs from costs one label test rather than a vertex-side drive.
    if (startLabels !== undefined) {
      const start = forward ? edge.from : edge.to;
      let labelled = false;

      for (const l of startLabels) {
        if (start.labels.has(l)) {
          labelled = true;
          break;
        }
      }

      if (!labelled) {
        continue;
      }
    }

    let hit = true;

    for (let i = 0; i < keys.length; i++) {
      if (!matches(preds[i], edge.properties[keys[i]])) {
        hit = false;
        break;
      }
    }

    if (hit) {
      n += 1;
    }
  }

  return n;
};

const filteredHopCount = (hop: Step, rest: readonly Step[], graph: Graph): number | undefined => {
  // `both` IS `out` PLUS `in`, EXACTLY, AND THE SELF-LOOP NEEDS NO CORRECTION (item 1087).
  //
  // This rung used to decline with "`both` double-counts a self-loop", and the double-count is
  // real — but in Gremlin it is the RIGHT ANSWER, so there is nothing to correct. TinkerPop 3.7.3
  // was asked rather than assumed, on three `T` edges including a self-loop on a `P` vertex:
  //
  //   out 3   in 3   both 6   bothE 6   both.has(k,gt(0)) 6   both.has(k,eq(1)) 3
  //   hasLabel(P).both 5      hasLabel(P).both.has(k,eq(1)) 3
  //
  // lenke answers all eight identically, and so does the forced-`identity()` decline. `both` walks
  // a vertex's out-edges and then its in-edges, so a loop is incident twice and YIELDED twice —
  // which the sum of the two arms reproduces for free.
  //
  // THE ISO-GQL TWIN IS DIFFERENT, and that is the whole reason this is the simpler side: `-[:T]-`
  // emits a loop ONCE, so item 1086's GQL arm has to subtract the passing loops. Two surface
  // languages, two semantics, one shared walk underneath — the difference belongs here, in the
  // per-language arithmetic, and not in the walk.
  if (hop.kind === 'both') {
    const outward = filteredHopCount({ kind: 'out', labels: hop.labels }, rest, graph);

    if (outward === undefined) {
      return undefined;
    }

    const inward = filteredHopCount({ kind: 'in', labels: hop.labels }, rest, graph);

    // ⚠️ `inward === undefined` IS UNREACHABLE TODAY, and a mutant replacing it with
    // `outward + (inward ?? 0)` SURVIVES (item 1087). Recorded rather than left unexplained, which
    // is this file's practice two rungs below as well.
    //
    // All three of this function's declines are DIRECTION-INDEPENDENT — the `hop.kind` test above,
    // `hasChain(rest)`, and `bucketsFor(hop.labels, graph)` — so they depend only on `rest`, the
    // labels and the graph, every one of which is identical in the two calls. If the outward call
    // returned a number, the inward one cannot refuse.
    //
    // IT STAYS, for item 583's distinction: a guard against a FUTURE relaxation is not a guard
    // against nothing. The day this function gains a decline that reads `forward` — a seed that
    // exists on one side only is the obvious candidate — dropping this check would answer HALF the
    // count rather than declining, and a half-count is a wrong answer that no existing test would
    // catch. Asymmetric by design: the outward check must return early (there is nothing to add
    // to), while this one is the symmetry that keeps the pair honest.
    return inward === undefined ? undefined : outward + inward;
  }

  if (hop.kind !== 'out' && hop.kind !== 'in') {
    return undefined;
  }

  // ONE OR MORE `has` steps, each a predicate on one key, and nothing else. `hasLabel` and the
  // other filters have their own semantics and are not this shape.
  //
  // THE CHAIN, not just a single filter, since item 930. `countShortcut` gated this rung behind
  // `mid.length !== 2`, so `out(E).has(k,p1)` reached it and `out(E).has(k,p1).has(k,p2)` fell off
  // the end to the general traversal — measured at 200,000 vertices / 600,000 edges, one shape per
  // process, median of 11:
  //
  //   V().hasLabel(P).out(E).has(k,>-1).count()                  25.6 ms
  //   V().hasLabel(P).out(E).has(k,>-1).has(k,>-2).count()      285.4       11.15x
  //   V().hasLabel(P).has(k,>-1).has(k,>-2).count()               6.0   (no hop: already folded)
  //   V().hasLabel(P).has(k,>-1).has(k,>-2).has(k,>-3).count()    6.7   (any length, likewise)
  //
  // `filterChainCount` had folded an arbitrary-length chain for the NO-HOP shape since it was
  // written, so the cliff was this rung's arity limit alone and not a semantic obstacle. It is the
  // same class as the spelling cliffs CLAUDE.md names: two conjuncts after a hop mean exactly what
  // one conjunction means, and cost 11x.
  const filters = hasChain(rest);

  if (filters === undefined) {
    return undefined;
  }

  const forward = hop.kind === 'out';
  // THE KEYS AND PREDICATES ARE EXTRACTED ONCE, not read off the `Step` objects per row. Item 934
  // measured this as the whole of the 1->2 arity step: a two-filter count read 54.81 ms against a
  // one-filter 28.49, while the marginal filter costs ~1.5 ns. Reading `f.pred` / `f.key` inside
  // the loop was 41.79 and hoisting the pair into locals was 30.25 — so the cost is the PROPERTY
  // LOAD off a `Step`, not the loop and not the call. `Step` is a wide discriminated union, so
  // those two loads are polymorphic at a site that runs per row; pulled into dense arrays of a
  // string and a `Predicate` they are monomorphic element loads instead, and that works at any
  // arity rather than needing an unroll per filter count.
  const keys = filters.map((f) => f.key);
  const preds = filters.map((f) => f.pred);
  const width = filters.length;
  // WIDTH 1 AND 2 ARE STRAIGHT-LINE, and item 934 measured why each piece is needed. At two
  // filters over 200,000 vertices: the original per-row `allMatch` CALL read 54.81 ms, an inline
  // indexed loop 41.79 (so the call was ~13 ms), the same loop over keys/preds extracted into
  // monomorphic arrays 43.82 (so the polymorphic `Step` property load was NOT the cost — that
  // hypothesis is refuted), and an unrolled straight-line pair over captured locals 30.25 — which
  // lands on the ONE-filter twin at 28.49. So the call and the loop cost ~65 ns a row EACH, and
  // only removing both recovers the step. Widths above 2 keep the loop: the third filter costs
  // ~1.5 ns a row, so there is nothing there to unroll for.
  const [k0, p0, k1, p1, k2, p2] = unrollSlots(keys, preds);

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
  // RAISE PARITY comes free here, unlike the GQL twin (item 164): the predicate is evaluated for
  // exactly the vertices carrying at least one edge of the queried type — which is exactly the set
  // of far endpoints the edge walk visits. No vertex gains or loses an evaluation, so no fault
  // appears or disappears.
  //
  // CORRECTED at item 930: this comment used to give the reason as "`matches` can throw (a
  // cross-type comparison, mirroring TinkerPop's `ClassCastException`)". It cannot — every
  // ordering predicate in `predicates.ts` filters an incomparable or missing value out via a `NaN`
  // from `predCmp`, and `count-shortcut.test.ts` records two tests written to assert a throw that
  // both failed for that reason. The evaluated-set argument above is the real content and stands
  // on its own; the throw it invoked does not exist.
  //
  // CONSEQUENCE for the chain loops below, which is why this is worth keeping here: because no
  // predicate can fault, the written-order SHORT-CIRCUIT in `i < len && hit` is not observable —
  // evaluating every filter would be answer- AND fault-equivalent. It is kept because it is
  // strictly less work and because it matches the step-by-step walk, so a predicate that CAN fault
  // would not silently diverge. Item 930 proved this rather than asserting it: a mutant removing
  // the short-circuit SURVIVED all 844 tests, exactly as predicted.
  if (hop.labels.length === 1 || graph.multiTypeEdgeCount === 0) {
    let n = 0;

    for (const v of graph.vertices) {
      // THE VERTEX'S OWN BOX, not a hash of its id into the graph's map (item 591). This rung read
      // `edgesToByLabel.get(v.id)` while `startFilteredHopCount` three functions below has read
      // the box since it was written — one rung in this file learned the lesson and its neighbour
      // did not. Measured at 200,000 vertices / 1,000,000 edges, with the predicate in place:
      //
      //   edgesToByLabel.get(v.id) + predicate   32.86 ms
      //   v.adjTo + predicate                    18.29       1.80x
      //
      // and without the predicate 41.54 against 30.50. A string-keyed `Map.get` is ~190ns (item
      // 194) against ~30ns for the object (item 321), and the getter caches per vertex.
      const byType = forward ? v.adjTo : v.adjFrom;

      if (byType === undefined) {
        continue;
      }

      const deg = degreeOfTypes(byType, hop.labels);

      // A vertex with no edge of this type is not a far endpoint of this hop, so it must not be
      // tested — that is what keeps the evaluated set identical.
      if (deg === 0) {
        continue;
      }

      // The chain test is INLINE, not a call. Item 934 measured the call as the whole of the
      // 1->2 arity step: entering `allMatch` cost ~123 ns a VERTEX while the marginal filter
      // costs ~1.5 ns, and hoisting the test out of the call put a two-filter count back onto
      // its one-filter twin. Same `i < len && ok` shape `filterChainCount` has always used.
      let hit: boolean;

      if (width === 1) {
        hit = matches(p0, v.properties[k0]);
      } else if (width === 2) {
        hit = matches(p0, v.properties[k0]) && matches(p1, v.properties[k1]);
      } else if (width === 3) {
        hit =
          matches(p0, v.properties[k0]) &&
          matches(p1, v.properties[k1]) &&
          matches(p2, v.properties[k2]);
      } else {
        hit = true;

        for (let i = 0; i < width && hit; i += 1) {
          hit = matches(preds[i], v.properties[keys[i]]);
        }
      }

      if (hit) {
        n += deg;
      }

      // REJECTED, with numbers (item 593). This row is 27.6x native after item 591, and the
      // obvious remaining lever is that the loop calls `degreeOfTypes` (which branches on
      // `labels.length` and then walks the array) plus two property reads off `filter`, once per
      // vertex, none of which varies per vertex. Hoisting `labels[0]` into a `only` constant,
      // inlining the single-type degree as `byType.get(only)?.size ?? 0`, and destructuring
      // `{ key, pred }` above the loop measured, over four alternated rounds with the order
      // reversed on alternate rounds, one case per process at 200,000 vertices / 1,000,000 edges:
      //
      //   out(K).has(age,gt(44)).count()     41.59 ms -> 41.17   1.01x
      //   in(K).has(age,gt(44)).count()      39.09    -> 37.76   1.04x
      //   out(K).has(age,gt(500)).count()    41.43    -> 40.89   1.01x
      //   out(K).has(city,'c7').count()      43.67    -> 41.48   1.05x
      //   five CONTROLS (hop count, dedupe, start-filtered, two-hop, values)  1.00-1.01x
      //
      // All inside this box's noise floor, so the call and the array walk are ~1-5% of the row,
      // not the headline. The estimate that sent me here was WRONG and worth recording: item
      // 591's probe measured an INLINED equivalent of this loop at 18.29ms against the row's
      // 42.2, and I read the 24ms difference as the cost of these calls. It is not in the loop
      // body at all — the probe simply is not this code. Second tick running that a micro-probe
      // mispriced a ratio; take ratios from an A/B of the real thing.
      //
      // What is left here is constant-factor: a JS property read and a predicate dispatch per
      // vertex against native's columnar read, which is item 566's layout ceiling rather than a
      // missing route. The ORDER is already optimal — without an index on the key every vertex
      // with a matching edge must be tested, and `seedForStep` already hands the indexed case to
      // the index path.
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

      let hit: boolean;

      if (width === 1) {
        hit = matches(p0, far.properties[k0]);
      } else if (width === 2) {
        hit = matches(p0, far.properties[k0]) && matches(p1, far.properties[k1]);
      } else if (width === 3) {
        hit =
          matches(p0, far.properties[k0]) &&
          matches(p1, far.properties[k1]) &&
          matches(p2, far.properties[k2]);
      } else {
        hit = true;

        for (let i = 0; i < width && hit; i += 1) {
          hit = matches(preds[i], far.properties[keys[i]]);
        }
      }

      if (hit) {
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
/**
 * A hop step. `both` IS ADMITTED since item 1091 — the self-loop reason the rungs above used to
 * give was refuted at item 1087 — but it is answered by {@link bothChainCount}, NOT by widening
 * the `out`/`in` arms below.
 *
 * THAT SPLIT IS MEASURED, not stylistic. The first cut generalized the shared arms with a
 * `hopBoxes(v, hop)` helper and a `hopDegree` call: the target went 6197 -> 82 ms, and the
 * `out.out` CONTROL — a shape the change cannot reach — went **46.76 -> 72.19 (1.54x SLOWER)**,
 * with `hasLabel(P).out.out` 47.29 -> 73.65. A one-element array per vertex and a call where a
 * box read used to be inlined was enough. Items 159 (1.6x) and 1033 (~2x on three unreachable
 * shapes) had both already measured this effect in this file.
 */
type HopStep = Extract<Step, { kind: 'out' | 'in' | 'both' }>;

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
):
  | { hops: HopStep[]; source: Iterable<Vertex>; rest: VertexFilter[]; unfiltered: boolean }
  | undefined => {
  // Split `mid` into a leading run of vertex filters and a trailing run of hops. The hops are
  // COLLECTED rather than sliced, because a `kind` test in this loop does not narrow a later
  // `mid.slice(...)` for the type checker.
  const hops: HopStep[] = [];
  let split = mid.length;

  for (let i = mid.length - 1; i >= 0; i -= 1) {
    const step = mid[i];

    if (step.kind !== 'out' && step.kind !== 'in' && step.kind !== 'both') {
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

  // `unfiltered` means the source set is EVERY vertex, which is what lets the two-hop arm skip
  // the edges entirely (item 590). A vacuous `hasLabel` has already been dropped upstream by
  // `dropVacuousLabels`, so "no filter steps" really does mean every vertex.
  return { hops, source, rest, unfiltered: filters.length === 0 };
};

/**
 * A hop chain containing at least one `both` (item 1091).
 *
 * WHY A SEPARATE FUNCTION. `both` could be folded into `hopChainCount`'s arms with a box-list
 * helper, and that was built and measured: the target improved 75x and the `out.out` control
 * REGRESSED 1.54x. So the two live apart and `out`/`in` keep the code they had.
 *
 * TINKERPOP 3.7.3 SETTLES THE ARITHMETIC, on `a->b`, `b->c` and a SELF-LOOP on `a`:
 *
 *   both 6   both.both 14   both.both.both 34   P both.both 12   both.out 8   out.both 6
 *
 * A `both` hop's degree is the sum over BOTH boxes, so a loop counts twice — which is exactly what
 * `both()` yields, and the degree inner product reproduces all six: `3*3 + 2*2 + 1*1 = 14`,
 * `3*2 + 2*1 + 1*0 = 8` for `both.out`, `1*3 + 1*2 + 1*1 = 6` for `out.both`. The two MIXED cases
 * differ (8 against 6), which is why both were checked — a symmetric implementation gets one wrong.
 *
 * THE PRIZE, at 200,000 vertices x degree 5, against the forced-`identity()` decline that IS the
 * route this replaces: `both.both` 6241 -> 82 ms, `both.both.both` 47,842 -> 748 ms.
 */
const bothChainCount = (
  hops: readonly HopStep[],
  source: Iterable<Vertex>,
  rest: readonly VertexFilter[],
  unfiltered: boolean,
  graph: Graph,
): number => {
  // TWO HOPS FROM EVERY VERTEX IS A DEGREE INNER PRODUCT, for `hopChainCount`'s own reason
  // (item 590): every traversal of the first hop arrives at some `w`, and the ways to arrive are
  // a degree of `w`. A `both` hop arrives and departs along the same pair of boxes, so its two
  // factors coincide — which is why `both.out` and `out.both` come out different.
  if (unfiltered && hops.length === 2) {
    const [h0, h1] = hops;
    let total = 0;

    for (const w of graph.verticesById.values()) {
      const arrive = chainDegree(w, h0, true);

      total += arrive === 0 ? 0 : arrive * chainDegree(w, h1, false);
    }

    return total;
  }

  // Otherwise carry a multiplicity per frontier vertex and push it along each traversal, then
  // finish with a degree sum. ONE implementation for every remaining depth: a `both` chain was
  // 6.2 s and 48 s before this, so there is nothing to gain from the extra two-hop arm
  // `hopChainCount` keeps, and a second copy of the walk is a second thing to get wrong.
  let cur = new Map<Vertex, number>();

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
      cur.set(v, 1);
    }
  }

  for (let h = 0; h < hops.length - 1; h += 1) {
    const hop = hops[h];
    const next = new Map<Vertex, number>();

    for (const [v, m] of cur) {
      // `undefined` for a direction this hop does not take, so `out` and `in` walk one box and
      // `both` walks two — and a self-loop, sitting in both, is pushed twice.
      const from = hop.kind === 'in' ? undefined : v.adjFrom;
      const to = hop.kind === 'out' ? undefined : v.adjTo;

      if (from !== undefined) {
        for (const set of hop.labels.length === 0 ? from.values() : bucketsOf(from, hop.labels)) {
          for (const e of set) {
            next.set(e.to, (next.get(e.to) ?? 0) + m);
          }
        }
      }

      if (to !== undefined) {
        for (const set of hop.labels.length === 0 ? to.values() : bucketsOf(to, hop.labels)) {
          for (const e of set) {
            next.set(e.from, (next.get(e.from) ?? 0) + m);
          }
        }
      }
    }

    cur = next;
  }

  const lastHop = hops[hops.length - 1];
  let total = 0;

  for (const [v, m] of cur) {
    total += m * chainDegree(v, lastHop, false);
  }

  return total;
};

/**
 * `v`'s degree along one hop of a `both`-bearing chain: the sum over both boxes for `both`, so a
 * self-loop counts twice, and one box for `out`/`in`.
 *
 * `reverse` asks instead how many traversals of `hop` LAND on `v` — its in-edges for an `out` hop
 * and its out-edges for an `in` hop. For `both` the two questions coincide.
 *
 * Only `bothChainCount` calls this; the `out`/`in` arms read their box inline exactly as before.
 */
const chainDegree = (v: Vertex, hop: HopStep, reverse: boolean): number => {
  if (hop.kind === 'both') {
    return (
      (v.adjFrom === undefined ? 0 : degreeOfTypes(v.adjFrom, hop.labels)) +
      (v.adjTo === undefined ? 0 : degreeOfTypes(v.adjTo, hop.labels))
    );
  }

  const box = (hop.kind === 'out') !== reverse ? v.adjFrom : v.adjTo;

  return box === undefined ? 0 : degreeOfTypes(box, hop.labels);
};

const hopChainCount = (mid: readonly Step[], graph: Graph): number | undefined => {
  const shape = hopChainShape(mid, graph);

  if (shape === undefined) {
    return undefined;
  }

  const { hops, source, rest, unfiltered } = shape;

  // A `both` ANYWHERE in the chain takes its own function, chosen ONCE here. The arms below are
  // then exactly the code they were, which is the whole point — see `HopStep` for the 1.54x the
  // alternative cost a control it could not reach.
  for (const hop of hops) {
    if (hop.kind === 'both') {
      return bothChainCount(hops, source, rest, unfiltered, graph);
    }
  }

  // TWO HOPS FROM EVERY VERTEX IS A DEGREE INNER PRODUCT, and needs no edge walk at all
  // (item 590). Summing over sources, every traversal of the first hop arrives at some `w`, and
  // the number of ways to arrive is a DEGREE of `w` — so
  //
  //   count = sum over w of arrivals(w) * departures(w)
  //
  // where each factor is the degree on whichever side its hop traverses: an `out` hop arrives
  // along `w`'s IN-edges and departs along its OUT-edges, and an `in` hop is the mirror. One pass
  // over vertices, two bucket reads each.
  //
  // Measured at 40,000 vertices / 200,000 edges, and the attribution is why this is an ALGEBRAIC
  // change rather than the layout one I expected to make:
  //
  //   walk both levels of adjacency, nothing else         9.14 ms
  //   + per-edge target bucket .get(label).size  [WAS]   61.80
  //   + per-edge Map.get on a memoized degree map        42.07   only 1.5x, so not the fix
  //   build a flattened CSR of neighbour indices         37.65   item 589's trick: no help here
  //   ... then the dense read through it                  0.11
  //   THE INNER PRODUCT, degree passes included           7.73   8.0x
  //
  // SELF-LOOPS and PARALLEL edges need no special case, which is what makes the identity exact: a
  // self-loop at `w` is one of `w`'s in-edges and one of its out-edges, and it contributes to
  // `arrivals` and `departures` exactly as enumeration walks it once in each role. Parallel edges
  // are separate members of both degrees.
  //
  // ONLY when the source set is every vertex. With a filtered source, `arrivals(w)` would have to
  // count in-edges FROM THE SURVIVORS, which is a per-edge question again — so the walk below
  // stays for that case, and `gremlin-hop-chain-count.test.ts` pins both routes against native.
  if (unfiltered && hops.length === 2) {
    const [h0, h1] = hops;
    let total = 0;

    for (const w of graph.verticesById.values()) {
      const inBox = h0.kind === 'out' ? w.adjTo : w.adjFrom;
      const arrive = inBox === undefined ? 0 : degreeOfTypes(inBox, h0.labels);

      if (arrive === 0) {
        continue; // nothing arrives here, so it contributes nothing however many edges leave
      }

      const outBox = h1.kind === 'out' ? w.adjFrom : w.adjTo;

      total += outBox === undefined ? 0 : arrive * degreeOfTypes(outBox, h1.labels);
    }

    return total;
  }

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

/**
 * The index of the ONE movement step in `mid`, or `undefined` if there is none or more than one.
 *
 * More than one hop is `hopChainCount`'s shape and must not be taken by a single-hop rung — a rung
 * that silently accepted the first of two hops would answer a different question.
 */
const soleHopAt = (mid: readonly Step[]): number | undefined => {
  let at: number | undefined;

  for (let i = 0; i < mid.length; i += 1) {
    const k = mid[i].kind;

    if (k === 'out' || k === 'in' || k === 'both') {
      if (at !== undefined) {
        return undefined;
      }

      at = i;
    }
  }

  return at;
};

/**
 * Every step as a vertex filter, or `undefined` if any step is something else.
 *
 * An indexable `has` is REFUSED rather than accepted, because the index-seed path is strictly
 * better than the scan a caller would do with it — the same decline `startFilteredHopCount` makes
 * inline, kept in one place now that two rungs need it.
 */
const collectVertexFilters = (steps: readonly Step[], graph: Graph): VertexFilter[] | undefined => {
  const out: VertexFilter[] = [];

  for (const step of steps) {
    if (step.kind !== 'hasLabel' && step.kind !== 'has') {
      return undefined;
    }

    if (step.kind === 'has' && seedForStep(step, graph.vertexPropertyIndex) !== null) {
      return undefined;
    }

    out.push(step);
  }

  return out;
};

/** Every step as a `has`, or `undefined` if any step is something else. */
const collectHasFilters = (
  steps: readonly Step[],
): Extract<Step, { kind: 'has' }>[] | undefined => {
  const out: Extract<Step, { kind: 'has' }>[] = [];

  for (const step of steps) {
    if (step.kind !== 'has') {
      return undefined;
    }

    out.push(step);
  }

  return out;
};

/**
 * How many edges in one adjacency bucket have a far end passing every far filter.
 *
 * AT MODULE SCOPE DELIBERATELY. The first version of this was a closure declared inside the
 * per-vertex loop of `bothFilteredHopCount`, which allocates one closure per VERTEX — 200,000 of
 * them on the fixture item 932 measured. The repo has this lesson already: a walk written inline in
 * a returned closure gave UNRELATED queries a new slow mode at 4x, and the fix was to hoist it to
 * module scope. The parameter list is the price of not allocating.
 */
const tallyFarEnds = (
  set: ReadonlySet<Edge>,
  forward: boolean,
  keys: readonly string[],
  preds: readonly Predicate[],
): number => {
  const width = keys.length;
  const [k0] = keys;
  const [p0] = preds;
  const k1 = width > 1 ? keys[1] : '';
  const p1 = width > 1 ? preds[1] : preds[0];
  const k2 = width > 2 ? keys[2] : '';
  const p2 = width > 2 ? preds[2] : preds[0];
  let n = 0;

  for (const edge of set) {
    const far = forward ? edge.to : edge.from;

    let hit: boolean;

    if (width === 1) {
      hit = matches(p0, far.properties[k0]);
    } else if (width === 2) {
      hit = matches(p0, far.properties[k0]) && matches(p1, far.properties[k1]);
    } else if (width === 3) {
      hit =
        matches(p0, far.properties[k0]) &&
        matches(p1, far.properties[k1]) &&
        matches(p2, far.properties[k2]);
    } else {
      hit = true;

      for (let i = 0; i < width && hit; i += 1) {
        hit = matches(preds[i], far.properties[keys[i]]);
      }
    }

    if (hit) {
      n += 1;
    }
  }

  return n;
};

/**
 * `V().hasLabel(L).has(x, p).out(T).has(k, q).count()` — filters on BOTH sides of the hop.
 *
 * ITEM 932 MEASURED THIS AS THE WORST CELL IN THE CROSS-SURFACE MATRIX, and item 930 had named it
 * and said why. The hop sits in the MIDDLE, where none of the existing rungs can reach it:
 * `filteredHopCount` needs the hop FIRST, `startFilteredHopCount` needs it LAST, and
 * `filterChainCount` rejects the `out` outright. So the whole shape fell to the general traversal.
 * Moving ONE of two filters across the hop — same answer, same number of predicate tests, only the
 * position different — cost 5.06x: `out(E).has(k).has(j)` 54.81 ms against
 * `has(k).out(E).has(j)` 277.41 at 200,000 vertices / 600,000 edges.
 *
 * WHY THIS ONE IS EDGE-DRIVEN WHERE `filteredHopCount` IS FAR-DRIVEN, which is the whole design
 * difference and not an oversight. `filteredHopCount` tests each far VERTEX once and adds its whole
 * degree, because with no start filter every edge of the type reaches it. Here a far vertex's
 * contribution depends on WHICH of its in-edges start at a surviving vertex, so a per-vertex test
 * multiplied by degree would count edges from rejected starts. The walk therefore visits each
 * qualifying EDGE once — strictly more predicate evaluations than the far-driven arm, and still far
 * less than materialising traversers through the general path.
 *
 * It also makes the evaluated set exactly the general walk's: start filters in written order with a
 * short-circuit, then the far filters only for edges leaving a surviving start — which is what
 * `rows.filter(start).flatMap(expand).filter(far)` evaluates. Nothing gains or loses an evaluation,
 * so no fault can appear or disappear (and per item 930, `matches` cannot fault anyway).
 */
const bothFilteredHopCount = (mid: readonly Step[], graph: Graph): number | undefined => {
  const at = soleHopAt(mid);

  // At least one step on each side, which is what makes this disjoint from both siblings.
  if (at === undefined || at === 0 || at === mid.length - 1) {
    return undefined;
  }

  const hop = mid[at];

  // `both` walks out-edges then in-edges, so a self-loop is incident twice — the same exclusion
  // `vertexStepCount` and the two sibling rungs make.
  if (hop.kind !== 'out' && hop.kind !== 'in') {
    return undefined;
  }

  // Several named types AND an edge carrying two of them would be visited once per type by the
  // per-bucket walk below, counting it twice. Same guard as `startFilteredHopCount`.
  if (hop.labels.length > 1 && graph.multiTypeEdgeCount !== 0) {
    return undefined;
  }

  const starts = collectVertexFilters(mid.slice(0, at), graph);
  const fars = collectHasFilters(mid.slice(at + 1));

  if (starts === undefined || fars === undefined) {
    return undefined;
  }

  const [first] = starts;
  // The source: the FIRST filter's bucket when that filter is a single-label `hasLabel`, because
  // the bucket is exactly its survivors and nothing before it could have faulted.
  const canSeed = first.kind === 'hasLabel' && first.labels.length === 1;
  const source: Iterable<Vertex> =
    first.kind === 'hasLabel' && first.labels.length === 1
      ? (graph.verticesByLabel.get(first.labels[0]) ?? EMPTY_VERTICES)
      : graph.verticesById.values();
  const rest = canSeed ? starts.slice(1) : starts;
  const forward = hop.kind === 'out';
  // Extracted ONCE, for item 934's reason: `f.key` / `f.pred` off a `Step` is a polymorphic load,
  // and this one feeds a loop that runs per EDGE rather than per vertex.
  const farKeys = fars.map((f) => f.key);
  const farPreds = fars.map((f) => f.pred);
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

    // The vertex's OWN adjacency box, not a hash of its id into the graph's map (items 162/321/591).
    // START-driven, so `out` reads the FROM side — the opposite of `filteredHopCount`, which drives
    // from the far end.
    const byType = forward ? v.adjFrom : v.adjTo;

    if (byType === undefined) {
      continue;
    }

    // An EMPTY type list is an untyped hop and so every type — reached only where no edge carries
    // two types, which is what makes walking the buckets separately safe. `degreeOfTypes` splits on
    // the same condition.
    if (hop.labels.length === 0) {
      for (const set of byType.values()) {
        n += tallyFarEnds(set, forward, farKeys, farPreds);
      }

      continue;
    }

    for (const t of hop.labels) {
      const set = byType.get(t);

      if (set !== undefined) {
        n += tallyFarEnds(set, forward, farKeys, farPreds);
      }
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

  // THE EDGE STEPS ARE THE SAME BUCKET (item 1088), and this rung had none of them — so
  // `V().outE(T).count()` enumerated 600,000 edges at 125.54 ms where `V().out(T).count()`, the
  // same number by the same arithmetic, was already O(1). `inE` 119.15 and `bothE` 224.95 likewise.
  //
  // `out` traverses one edge per emitted traverser and `outE` emits the edge itself, so both count
  // |E_T| — and TINKERPOP GROUND TRUTH FOR THIS IS ALREADY IN THIS FILE, recorded on
  // `edgeHopSeededCount`: "on 4 `T` edges including a self-loop, `V().outE(T).count()` and
  // `V().inE(T).count()` are both 4 while `V().bothE(T).count()` is 8". So `outE`/`inE` are
  // `adjacentCount` and `bothE` is twice it, exactly as for the vertex steps — the self-loop
  // included, since it is one edge from its source and one from its target.
  if (step.kind === 'outE' || step.kind === 'inE') {
    return adjacentCount(step.labels, graph);
  }

  if (step.kind === 'has') {
    return propertyCount(step, graph);
  }

  // `both` IS TWICE THE BUCKET (item 1087). This used to decline, saying "a self-loop is incident
  // twice and the total is not a bucket size". The first half is true and the second does not
  // follow: `out` visits every edge once from its source and `in` once from its target, the loop
  // included, so `both` is their sum — `2 * adjacentCount` — and TinkerPop 3.7.3 confirms it
  // (`both` 6 against `out` 3 and `in` 3 on three edges, one of them a loop).
  //
  // `adjacentCount`'s own soundness condition carries over unchanged, since this only doubles what
  // it returns: it declines a multi-label hop on a graph with a multi-type edge, because summing
  // per-label buckets would count such an edge once per label.
  if (step.kind === 'both' || step.kind === 'bothE') {
    const one = adjacentCount(step.labels, graph);

    return one === undefined ? undefined : 2 * one;
  }

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
