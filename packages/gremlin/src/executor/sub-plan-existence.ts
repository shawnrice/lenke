// `where(out(T))` / `filter(…)` / `not(…)` / `and(…)` / `or(…)` whose sub-plan is ONE adjacency
// step — fused from a per-traverser sub-pipeline into one `Map` lookup.
//
// WHY A NEW MODULE. Item 1482 established that the toll is on editing `hop-values.ts` /
// `hop-projection.ts` — every edit to those has moved unrelated rows by up to ~16% in an arbitrary
// direction (items 1413/1415/1440/1442/1462). `optional-hop.ts` is the precedent: the same fusion
// for `optional`, in its own module, with one `dispatch.ts` call site. Nothing here imports from
// either hop file.
//
// WHAT IT IS FOR. `whereSubPlanStep` runs its sub-plan per incoming traverser:
//
//   for (const t of stream) {
//     if (hasAny(applyPlanToStream(plan, [t], graph, ctx))) { yield t; }
//   }
//
// — so for every vertex it builds a one-element array, walks the sub-plan's steps through a 103-arm
// dispatch and creates a generator per step, all to answer a yes/no. At 200,000 vertices /
// 1,000,000 edges, `V().where(out(E)).values(n)` measured **87.35 ms for the same 200,000 rows that
// `V().values(n)` answers in 4.17** — and the filter ALONE (the `count()` twin, one row) was 80.81,
// i.e. **404 ns per vertex to answer "do you have an out-edge"** against the plain hop's 52 ns to
// visit an edge AND emit a property off it. The profile at REPS=100 put 42.2% in `generatorResume`
// and 18.7% in `iterLabeled` — the delegation chain `outEdgesOf` -> `iterByLabel` -> `iterLabeled`,
// a generator frame per level, per vertex.
//
// 🔑 WHY THE GATE CAN BE BROADER THAN `soleTypeBucket`'S, which is the whole reason this is a
// separate helper rather than a call to it. That one refuses `both`, a multi-type hop and an untyped
// one, because for an ANSWER it must not double-count a `T|S` edge, must drop a self-loop's
// duplicate under `both`, and must read the correct END off the edge. **None of those is observable
// in a yes/no.** Existence needs only "is any adjacency bucket non-empty", so `both`, multi-type and
// untyped hops are all admitted here while staying refused there.
//
// ⚠️ IT READS THE SAME MAP `adjacentEdges` DOES, not a second structure. `Vertex.adjFrom` is a lazy
// memo of `graph.edgesFromByLabel.get(id)` — a live reference to the graph's own bucket map,
// dropped on topology change (`adjacency-box.test.ts`) — which is exactly what `outEdgesOf` looks
// up. So this is the same source read without the generators, not a new thing to keep in sync.
//
// ⚠️ THE TEST IS `size > 0` AND NOT PRESENCE, AND NO TEST CAN CURRENTLY TELL THE DIFFERENCE — stated
// plainly because the first draft of this comment claimed otherwise. It cited
// `topology-version.test.ts`'s `a.adjFrom?.get('F')?.size ?? 0`, which is equally consistent with an
// ABSENT bucket; `emptybucket-probe-1915.mjs` then asked the structure directly and found core
// DELETES a bucket as it empties, by all four routes that can drop a vertex's last edge of a label
// (`removeEdge`, `removeLabelFromEdge`, removing the last of several same-label edges, and removing
// the far vertex). So a present-but-empty bucket does not arise today and `!== undefined` would be
// answer-equivalent.
//
// It stays `size > 0` anyway, for one reason and not the other: NOT because it is measurably
// cheaper (it is one `Set.size` load either way), but because the alternative silently depends on a
// CORE invariant this module does not own. That invariant is now pinned where it lives —
// `adjacency-box.test.ts`'s "an emptied bucket is deleted, not left empty" — so a core change that
// broke it fails there instead of turning into a wrong answer here.
//
// ⚠️ THE SAME INVARIANT MAKES THE UNTYPED LOOP REDUNDANT TOO, which the mutation run found rather
// than this comment predicting it: with no empty buckets, "SOME bucket is non-empty", "the FIRST
// bucket is non-empty" and `byLabel.size > 0` are one predicate. The loop is kept on the same
// grounds. The honest cost of both choices is that TWO mutants here cannot be caught by any test
// reachable through the public API — a vertex with an empty bucket cannot be constructed — so both
// are declared in item 1915's `EXPECTED_SURVIVORS` with this as their reason, rather than quietly
// absent from the battery.
//
// ⚠️ A NON-VERTEX TRAVERSER IS FILTERED OUT, which mirrors the general path rather than being a
// liberty: `traverseToVertex` / `traverseToEdge` both `continue` on a non-vertex, so the sub-plan
// emits nothing and `hasAny` is false.
//
// ⚠️ EDGE-EMITTING STEPS COLLAPSE ONTO THE VERTEX-EMITTING ONES. `outE(T)` and `out(T)` walk the
// identical adjacency and differ only in WHAT they yield — and a yes/no cannot see that — so `outE`
// maps to `out`, `inE` to `in`, `bothE` to `both`.
import { isVertexShaped } from '@lenke/core';
import type { Edge, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import type { Traverser } from './runtime.js';

/**
 * ⚠️ A LEAF MODULE, which is why this is not `isVertex` imported from `runtime.ts`. That file
 * imports `applyPlanToStream` from `dispatch.ts`, and `dispatch.ts` imports THIS one, so a VALUE
 * import from `runtime` is a cycle and `import/no-cycle` is an error. Same shape as
 * `far-mask-drain.ts`, which declares its `Gate` locally for exactly this reason. `Traverser`
 * stays as an `import type`, which is erased and so is not a cycle — and this is the identical
 * one-line predicate `runtime.ts` exports (`isVertexShaped` from core), not a second derivation
 * of it.
 */
const isVertex = (x: unknown): x is Vertex => isVertexShaped(x);

/** The adjacency a recognized sub-plan asks about: a direction and the edge types, `[]` for any. */
export type HopExistence = {
  readonly kind: 'out' | 'in' | 'both';
  readonly labels: readonly string[];
};

/**
 * The single adjacency step this fusion answers, or `undefined` for every other sub-plan shape.
 *
 * ⚠️ THE GATE IS A SHAPE TEST, NOT A CAPABILITY CLAIM. A multi-step sub-plan, a filter, a barrier, a
 * nested branch, a property step — all fall through to the general path untouched. Widening it is a
 * correctness question each time, because anything that can DROP a traverser breaks the equivalence
 * this rests on: `traverseToVertex` yields for EVERY adjacent edge unconditionally, which is why
 * "the sub-plan emits something" and "an adjacency bucket is non-empty" are the same question.
 */
export const singleHopExistence = (plan: Plan): HopExistence | undefined => {
  if (plan.steps.length !== 1) {
    return undefined;
  }

  const [only]: readonly Step[] = plan.steps;

  switch (only.kind) {
    case 'out':
    case 'in':
    case 'both': {
      return { kind: only.kind, labels: only.labels };
    }

    case 'outE': {
      return { kind: 'out', labels: only.labels };
    }

    case 'inE': {
      return { kind: 'in', labels: only.labels };
    }

    case 'bothE': {
      return { kind: 'both', labels: only.labels };
    }

    default: {
      return undefined;
    }
  }
};

/**
 * Is any of `labels` a non-empty bucket in this adjacency box? `[]` asks about every bucket.
 *
 * Hoisted to module scope deliberately: [[ts-closure-size-is-load-bearing]] records a walk written
 * INLINE in a returned closure giving UNRELATED queries a new slow mode (4x).
 */
const anyNonEmpty = (
  byLabel: ReadonlyMap<string, ReadonlySet<Edge>> | undefined,
  labels: readonly string[],
): boolean => {
  if (byLabel === undefined) {
    return false;
  }

  if (labels.length === 0) {
    for (const set of byLabel.values()) {
      if (set.size > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * ⚠️ REJECTED, WITH ITS NUMBERS: replacing this `for…of` with an indexed loop measured NEUTRAL —
   * `where` 20.84-21.29 against 20.85-21.80, `where…count()` 11.78-12.16 against 11.88, `not`
   * 10.52-11.14 against 11.25, all inside the noise at 200,000 vertices. V8 handles a `for…of` over
   * a short readonly array in this position without allocating per call. Tried because the same
   * guess had just been made about the combining loop, where it was ALSO wrong (see
   * `combinedWalk`). Do not re-attempt.
   */
  for (const label of labels) {
    const set = byLabel.get(label);

    if (set !== undefined && set.size > 0) {
      return true;
    }
  }

  return false;
};

/** Does this vertex have any adjacency matching `hop`? The whole of what the sub-plan asked. */
export const hasAdjacency = (v: Vertex, hop: HopExistence): boolean => {
  const { kind, labels } = hop;

  return (
    (kind !== 'in' && anyNonEmpty(v.adjFrom, labels)) ||
    (kind !== 'out' && anyNonEmpty(v.adjTo, labels))
  );
};

/**
 * Every plan's adjacency, or `undefined` if ANY of them is a shape this cannot answer.
 *
 * ⚠️ ALL-OR-NOTHING ON PURPOSE: a mixed `and(out(T), <something else>)` falls through whole rather
 * than half-fusing, so there is one path to reason about instead of two interleaved ones.
 *
 * ⚠️ AN EMPTY PLAN LIST FALLS THROUGH, which is load-bearing rather than a don't-care: `and()` keeps
 * EVERY traverser (`[].every` is true) and `or()` keeps NONE (`[].some` is false), and returning an
 * empty array here would send both to the same loop below.
 */
export const allHopExistence = (plans: readonly Plan[]): readonly HopExistence[] | undefined => {
  if (plans.length === 0) {
    return undefined;
  }

  const hops: HopExistence[] = [];

  for (const plan of plans) {
    const hop = singleHopExistence(plan);

    if (hop === undefined) {
      return undefined;
    }

    hops.push(hop);
  }

  return hops;
};

/**
 * `and(<adjacency steps>)` / `or(<adjacency steps>)` over recognized plans.
 *
 * `every` is `true` for `and` and `false` for `or`. A non-vertex matches no plan at all, so it is
 * dropped by both — which is what the general path does, `hasAny` being false for each.
 */
export const hopExistenceCombinedStep = (
  stream: Iterable<Traverser<unknown>>,
  hops: readonly HopExistence[],
  every: boolean,
): Iterable<Traverser<unknown>> =>
  // `and(p)` and `or(p)` over ONE plan both mean exactly `p`, so they take the single-hop step
  // rather than a one-iteration loop. See the measurement in `combinedWalk`'s note.
  hops.length === 1 ? hopExistenceStep(stream, hops[0], true) : combinedWalk(stream, hops, every);

const combinedWalk = function* (
  stream: Iterable<Traverser<unknown>>,
  hops: readonly HopExistence[],
  every: boolean,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    if (!isVertex(t.value)) {
      continue;
    }

    const v = t.value;
    let hit = every;

    /**
     * ⚠️ THE INDEXED LOOP IS NOT WHAT MADE THIS FAST, and the first version of this comment said it
     * was. The first cut sent EVERY arity through here and measured `and(out(E))` at 36.70 ms
     * against the identical `where(out(E))`'s 20.87 — a 1.75x gap between two spellings of one
     * question. The guess was that `for…of` over `hops` allocated an iterator per vertex; swapping
     * it for this indexed loop moved 36.70 to 36.35, i.e. nothing. What fixed it was routing arity
     * 1 to `hopExistenceStep` above, so the cost is this LOOPING GENERATOR BODY with a mutable
     * `hit` against a straight-line `const hit = …`. The indexed form measured neutral here and in
     * `anyNonEmpty`, so this is back to `for…of`: no reason to keep a form the linter objects to
     * for a win that is not there.
     */
    for (const hop of hops) {
      if (hasAdjacency(v, hop) !== every) {
        hit = !every;
        break;
      }
    }

    if (hit) {
      yield t;
    }
  }
};

/**
 * `where(<one adjacency step>)` / `filter(…)`, and its negation for `not(…)`.
 *
 * `want` is `true` to keep matches (`where`/`filter`/`and`/`or`) and `false` to keep non-matches
 * (`not`). A non-vertex is never a match, so under `not` it PASSES — which is what the general path
 * does, since the sub-plan emits nothing for it.
 */
export const hopExistenceStep = function* (
  stream: Iterable<Traverser<unknown>>,
  hop: HopExistence,
  want: boolean,
): Iterable<Traverser<unknown>> {
  for (const t of stream) {
    const hit = isVertex(t.value) && hasAdjacency(t.value, hop);

    if (hit === want) {
      yield t;
    }
  }
};
