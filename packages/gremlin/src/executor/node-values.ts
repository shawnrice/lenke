// `V().values(k)` and `V().hasLabel(L).values(k)` — one property read per vertex, answered by a
// scan that builds no traverser.
//
// WHY THIS IS A SEPARATE MODULE AND NOT A BRANCH IN `hop-values.ts`. Every edit to that file (and to
// `hop-projection.ts`) has measurably moved UNRELATED rows by up to ~16% in an arbitrary direction —
// items 1413, 1415, 1440, 1442, 1462 — which is why item 1466 declined a 3.3x walk outright. The
// perturbation is a consequence of editing the file, so a new file avoids it entirely. The only edit
// to a hot file here is one call site in `index.ts`, which items 1460 and 1479 both changed without
// the effect appearing.
//
// WHAT IT IS FOR. `hopValuesShortcut` eliminates the traverser pipeline for `V().out(T).values(k)`,
// but it requires a hop at `steps[1]`, so the NO-HOP forms never had a shortcut and ran the full
// pipeline. Item 1481's cross-surface probe measured `V().values('k')` against ISO-GQL's
// `MATCH (n:P) RETURN n.k` at **1.63x slower** over 200,000 vertices, and profiled the difference as
// traverser construction: `sourceFromIds` 17.3% + `extend` 9.1% + `startTraverser` 2.9% ~ 29% of the
// run, where GQL's node-projection walk builds none.
//
// ⚠️ THE VALUES MUST BE THE WHOLE ANSWER. This returns a plain iterable of values, so it is only
// offered when nothing follows the `values(k)`. A residual step would need a traverser to carry, and
// manufacturing one here would be slower than never having left the pipeline.
//
// ⚠️ `values(k)` DROPS A VERTEX LACKING `k`, it does not emit undefined — the same rule
// `hopValuesShortcut` states for its value mode, and `projectValues` implements with `k in props`.
// ⚠️ TWO DIFFERENT THINGS ARE CALLED "SEEDED" IN THIS ENGINE, and they are not the same rung.
// `seededNodeValuesShortcut` below is INDEX-seeded — `has(k, eq(v))` answered off a property index's
// bucket (item 1595). `idSeededValuesShortcut` is ID-seeded — `V(id, …)`, the element ids given in
// the query. They are disjoint by shape (one requires a `has`, the other requires ids on the source)
// and neither can take the other's plans. The same ambiguity exists in `count-shortcut.ts`, where
// `seededNodeCountShortcut` is index-seeded and `idSeededCount` is id-seeded (item 1649).
import type { Graph } from '@lenke/core';

import type { ID, Plan, Step } from '../ast.js';
import { seedForStep } from './index-seed.js';
import { asStringId } from './sources.js';

/** The same shape `hopValuesShortcut` returns, so `run` can treat both identically. */
export type NodeValues = Iterable<unknown> & { drain?: () => unknown[] };

/**
 * `V()` with no explicit ids, optionally one `hasLabel`, then `values(k)` for exactly ONE key, and
 * nothing after it.
 *
 * `values()` with no key emits every property value and `values(a, b)` fans out per key — both are
 * different shapes, and each would need its own walk rather than this one.
 */
const matchShape = (
  steps: readonly Step[],
): { label: Extract<Step, { kind: 'hasLabel' }> | undefined; key: string } | undefined => {
  const [source, second, third] = steps;

  if (source?.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (steps.length === 2 && second?.kind === 'values' && second.keys.length === 1) {
    return { label: undefined, key: second.keys[0] };
  }

  if (
    steps.length === 3 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'values' &&
    third.keys.length === 1
  ) {
    return { label: second, key: third.keys[0] };
  }

  return undefined;
};

export const nodeValuesShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const shape = matchShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  const { label, key } = shape;
  // ⚠️ `hasLabel`'s OWN RULE, restated from the dispatcher: ANY of the named labels matching is a
  // pass (`step.labels.some((l) => v.labels.has(l))`), not all of them. Iterating `graph.vertices`
  // makes the dispatcher's is-element guard vacuous — everything here is a vertex.
  const labels = label?.labels;

  // ⚠️ ONE loop body, used by BOTH the iterator and `drain`. Writing `drain` as a second derivation
  // is item 169's lesson, and Gremlin results are compared ORDERED by the differential fuzzer, so a
  // divergence between the two would be a cross-engine failure rather than an unspecified-order
  // liberty.
  const walk = function* (): Generator<unknown> {
    for (const v of graph.vertices) {
      if (labels !== undefined && !labels.some((l) => v.labels.has(l))) {
        continue;
      }

      const props = v.properties;

      if (key in props) {
        yield props[key];
      }
    }
  };

  return {
    [Symbol.iterator]: walk,
    drain: () => [...walk()],
  };
};

/**
 * ONE loop body for both the iterator and `drain`, AT MODULE SCOPE.
 *
 * ⚠️ MODULE SCOPE IS NOT STYLE, IT IS THE WHOLE WIN. Written as a closure inside the shortcut — so a
 * fresh generator function is defined on every call — this rung measured **1.2x SLOWER than the
 * traverser pipeline it replaces** (346 ns against 283), and the decomposition said why:
 * `drain()` cost **203 ns on a freshly constructed rung against 62.9 ns on a reused one**, all of it
 * the per-call closure. `ts-closure-size-is-load-bearing` records the same effect at 4x on an
 * unrelated shape. Hoisted, the parameters carry what the closure used to capture.
 *
 * It stays ONE body for both consumers for the reason the shortcut above states: Gremlin results are
 * compared ORDERED by the differential fuzzer, so two derivations that could drift would be a
 * cross-engine failure rather than an unspecified-order liberty (item 169).
 */
// EXPORTED FOR THE PROBE ONLY (item 1660's `rung-walkonly` arm, `gremlin-point-floor.ts`), which
// prices the shape match and the generator protocol separately. Nothing in the engine calls it from
// outside this module, and a probe that re-implemented the loop would be measuring its own copy.
export const seededIdWalk = function* (
  ids: readonly ID[],
  labels: readonly string[] | undefined,
  key: string,
  graph: Graph,
): Generator<unknown> {
  for (const id of ids) {
    const v = graph.getVertexById(asStringId(id));

    if (v === undefined || v === null) {
      continue;
    }

    if (labels !== undefined && !labels.some((l) => v.labels.has(l))) {
      continue;
    }

    const props = v.properties;

    if (key in props) {
      yield props[key];
    }
  }
};

/**
 * The same shape as {@link matchShape} but with the ids the source names — `V(id, …)` rather than
 * `V()`.
 */
const matchSeededShape = (
  steps: readonly Step[],
):
  | {
      ids: readonly ID[];
      label: Extract<Step, { kind: 'hasLabel' }> | undefined;
      key: string;
    }
  | undefined => {
  const [source, second, third] = steps;

  if (source?.kind !== 'V') {
    return undefined;
  }

  const { ids } = source;

  if (ids === undefined || ids.length === 0) {
    return undefined;
  }

  if (steps.length === 2 && second?.kind === 'values' && second.keys.length === 1) {
    return { ids, label: undefined, key: second.keys[0] };
  }

  if (
    steps.length === 3 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'values' &&
    third.keys.length === 1
  ) {
    return { ids, label: second, key: third.keys[0] };
  }

  return undefined;
};

/**
 * `V(id, …)[.hasLabel(L)].values(k)` — THE POINT LOOKUP, answered by resolving the ids with no
 * traverser (item 1650).
 *
 * ⚠️ WHY THIS SHAPE, AND WHY NOW. Item 1642 decomposed this query and named the fix: "a closed-form
 * route for seeded by id + one projection that never builds a traverser". Item 1649 built the
 * `count()` half; this is the projection half, and it was the LAST arm of the point lookup. Measured
 * against a hand floor (`getVertexById` + a property read) on `gremlin-point-floor.ts`:
 *
 * ```text
 *   floor  getVertexById + props.k    15.7 ns
 *   V(id).values(k)                  286.3 ns     18.2x
 * ```
 *
 * where per-element work is negligible and the whole cost is per-call pipeline setup for an answer
 * of ONE value.
 *
 * ⚠️ `asStringId` RAISES ON A NON-STRING ID, AND IT MUST RAISE FROM INSIDE THE GENERATOR. Ids are
 * strings here, so `V(5)` is a type error rather than a coercion — and the general path raises it
 * lazily too, because `sourceFromIds` is itself a generator. `V('a', 5).values(k)` therefore yields
 * `a`'s value and THEN raises, on both routes. A rung that resolved ids eagerly would move the
 * fault earlier, which is observable to a caller that reads one value and stops.
 *
 * ⚠️ THE MULTIPLICITY IS THE ID LIST'S: a duplicate id yields its value twice, a missing id nothing.
 * Same rule as `idSeededCount` (item 1649), and the opposite of `hasId`'s, which filters the element
 * set instead.
 */
export const idSeededValuesShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const shape = matchSeededShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  const { ids, label, key } = shape;
  const labels = label?.labels;

  // ⚠️⚠️ THE GENERATOR ITSELF, NOT A `{ [Symbol.iterator], drain }` WRAPPER — 1.66x, and it also
  // removes a divergence (item 1651). The wrapper was **53% of the query's self time**: an object
  // with a COMPUTED SYMBOL KEY plus two closures, allocated per call, for a `drain` that only
  // spread the same generator and so bought nothing. (`drain`'s point, item 1412, is an EAGER walk
  // that skips the generator; this rung has none to skip.)
  //
  // ⚠️ AND ONE-SHOT IS THE ENGINE'S ACTUAL CONTRACT, which the wrapper quietly broke. `run`'s result
  // is a generator chain for nearly every plan, so iterating it twice yields nothing the second
  // time — measured: `V().values(k).identity()` gives `[1,2]` then `[]`. The wrapper made
  // `V(id).values(k)` re-iterable, so whether re-iteration worked depended on WHICH RUNG FIRED,
  // which is route-dependent observable behaviour. `nodeValuesShortcut` beside this one still has
  // it; see item 1651's entry in `CLOSED.md`.
  //
  // ⚠️⚠️ AND THE ONE-ID CASE IS EAGER ANYWAY — 1.9x, item 1660 — WHICH REVERSES THE PARAGRAPH
  // ABOVE FOR EXACTLY ONE ID AND NOTHING ELSE. Read both: the generator is still the route for every
  // other shape, and the reason is a RESULT-SIZE argument rather than a protocol one.
  //
  // ITEM 1660 DECOMPOSED THE WHOLE 125 ns CALL and the iterator protocol was its single biggest
  // term — bigger than `run`'s entire prologue:
  //
  // ```text
  //   the work itself (getVertexById + a property read)   16 ns   13%   hand floor
  //   this rung's bookkeeping (asStringId, key in props)  19 ns   15%
  //   THE ITERATOR/GENERATOR PROTOCOL                     54 ns   43%
  //   matchSeededShape + its per-call result object        9 ns    7%
  //   run's prologue (newContext 7, effectivePlan 19, …)  30 ns   24%
  // ```
  //
  // ⚠️⚠️ THAT 54 ns IS A PER-CALL FIXED COST, AND THAT IS THE WHOLE LICENCE FOR THIS BRANCH. It
  // dominates only when the answer is TINY. On `V().values(k)` over 200,000 vertices it is 54 ns
  // against 17.5 ms — 0.0003%, invisible — so eagerness there would buy nothing and would cost the
  // laziness that keeps the scan bounded. **So this generalizes to BOUNDED-RESULT rungs only, and
  // "move the hot path to eager arrays" is the memory regression it looks like.** `ids.length === 1`
  // with one key is 0 or 1 values: there is no walk to make eager and no early exit to destroy, and
  // the rung fires only when it answers the WHOLE plan, so there is no downstream step either.
  //
  // Measured, 2M calls, arms alternated twice: **104-114 ms against 202-217**, with RSS 54.1/54.6 MB
  // against 54.7/54.1 and heapUsed 2.2 MB against 2.3. Memory is FLAT-to-lower, because a V8
  // generator object carries a suspended frame and a register file and is the LARGER object — which
  // is the same reason the CPU halves.
  //
  // ⚠️ `typeof ids[0] === 'string'` IS THE LAZINESS GUARD, not a type narrowing. `asStringId` raises
  // on a non-string id and must raise from INSIDE the walk (see the contract above), so a non-string
  // id falls through to the generator and keeps raising exactly when it did. Dropping this test
  // would make `run(traversal(V(5), values('k')), g)` throw at CALL time instead of on first
  // `next()`, which `id-seeded-values.test.ts` pins.
  //
  // ⚠️ AND THE RESULT IS RE-ITERABLE, which is a DELIBERATE choice and not an oversight. It puts
  // this rung with the three routes that already behave that way in the shipped engine —
  // `V().values(k)` (the wrapper item 1651 left on `nodeValuesShortcut`), `V(id).count()` and
  // `V().count()` (both return a bare `[n]`) — against the general path and the multi-id walk, which
  // are one-shot. Item 1651's one-shot test is written on `V('a', 'b')`, TWO ids, so it never covered
  // this shape; `eager-one-id.test.ts` covers it now and states which way it goes.
  if (ids.length === 1 && typeof ids[0] === 'string') {
    const v = graph.getVertexById(ids[0]);

    if (v === undefined || v === null) {
      return [];
    }

    if (labels !== undefined && !labels.some((l) => v.labels.has(l))) {
      return [];
    }

    const props = v.properties;

    return key in props ? [props[key]] : [];
  }

  return seededIdWalk(ids, labels, key, graph);
};

/**
 * `V()[.hasLabel(L)].has(k, eq(v)).values(j)` — the SEEDED POINT LOOKUP, answered off the index
 * bucket with no traverser (item 1595).
 *
 * ⚠️ WHY THIS SHAPE. `bench:usage`'s builder rows put the TS Gremlin serving call at 2619 ns against
 * ISO-GQL's 650 for the identical seeded lookup — 4.0x — and item 1593 showed only ~400 ns of that
 * is plan construction. So ~2150 ns is per-call machinery for a result of ONE element, where
 * per-element work is negligible and setup is the entire cost. Item 1594 then established that
 * trimming individual frames out of that machinery does NOT convert: `countEquals` at 12.0% self
 * time surrendered nothing. A whole-plan shortcut is the remaining form, which is what this is — the
 * same answer `nodeValuesShortcut` gives for the unfiltered scan.
 *
 * ⚠️ THE BUCKET IS THE ANSWER SET, and that is the engine's own existing claim rather than a new
 * one: `seedForStep` returns `removable: true` for an `eq` predicate on a PLAIN `has` over an
 * indexed key, and `removable` means "dropping the owning step leaves an equivalent plan" — i.e.
 * the bucket is exactly the matching elements. Reusing `seedForStep` is what keeps this from
 * re-deriving equality semantics: index equality and `has` equality agreeing is already load-bearing
 * for `seedFromIndex`, so nothing here can drift from it independently.
 *
 * `removable: false` DECLINES — a range seed (`gt`/`lt`/`between`) narrows but does not decide, and
 * a `hasLabelAnd` carries a label the bucket does not capture. Both would need the predicate applied
 * per element, which is the pipeline this exists to skip.
 *
 * No cost check against a scan, deliberately: every element in the bucket is an element the answer
 * must visit anyway, so the seek cannot lose. That is not true of a range seed, which is one more
 * reason those decline.
 */
const seededShape = (
  steps: readonly Step[],
):
  | {
      label: Extract<Step, { kind: 'hasLabel' }> | undefined;
      has: Extract<Step, { kind: 'has' }>;
      key: string;
    }
  | undefined => {
  const [source, second, third, fourth] = steps;

  if (source?.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (
    steps.length === 3 &&
    second?.kind === 'has' &&
    third?.kind === 'values' &&
    third.keys.length === 1
  ) {
    return { label: undefined, has: second, key: third.keys[0] };
  }

  if (
    steps.length === 4 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'has' &&
    fourth?.kind === 'values' &&
    fourth.keys.length === 1
  ) {
    return { label: second, has: third, key: fourth.keys[0] };
  }

  return undefined;
};

export const seededNodeValuesShortcut = (plan: Plan, graph: Graph): NodeValues | undefined => {
  const shape = seededShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  // `0` is the cap meaning "exact seeds only": this path requires `removable`, which a range
  // candidate never is, so counting one is pure waste (item 1759 measured it at 1.62x).
  const candidate = seedForStep(shape.has, graph.vertexPropertyIndex, 0);

  // `null` means the key is not indexed or the predicate is not seekable; `removable: false` means
  // the seed narrows without deciding. Either way this is not the shape.
  if (candidate === null || !candidate.removable) {
    return undefined;
  }

  const { label, key } = shape;
  const labels = label?.labels;
  const bucket = candidate.build();
  // ONE loop body for both the iterator and `drain`, as above — item 169's lesson, and Gremlin
  // results are compared ORDERED by the differential fuzzer, so two derivations could diverge.
  const walk = function* (): Generator<unknown> {
    for (const v of bucket) {
      if (labels !== undefined && !labels.some((l) => v.labels.has(l))) {
        continue;
      }

      const props = v.properties;

      if (key in props) {
        yield props[key];
      }
    }
  };

  return {
    [Symbol.iterator]: walk,
    drain: () => [...walk()],
  };
};

/**
 * `V()[.hasLabel(L)].has(k, eq(v)).count()` — the SEEDED COUNT, answered off the bucket's SIZE
 * (item 1596).
 *
 * ⚠️ WHY NOBODY ANSWERED THIS ALREADY, because it looks like `countShortcut`'s job.
 * `filterChainCount` declines a `has` the moment `seekWorthTaking` says a seek beats a scan —
 * deliberately, leaving the shape to the seeding path. But the seeding path then runs the TRAVERSER
 * PIPELINE over the seeded stream, so the shape falls between the two: recognised as seekable,
 * answered by neither in closed form.
 *
 * Measured over 20,000 indexed vertices, per operation, against ISO-GQL's
 * `MATCH (u:User) WHERE u.name = $v RETURN count(*)`:
 *
 * ```text
 *   count, unique key    gql 420 ns    gremlin 2486    5.92x   <- the worst ratio in the family
 *   values, unique key   gql 495       gremlin 1743    3.52x   (item 1595 took this one)
 * ```
 *
 * The seeded count was SLOWER than the seeded projection, which is the tell: a count should never
 * cost more than reading a property off the same elements.
 *
 * ⚠️ WITH NO LABEL IT IS O(1) — the bucket's `size`, no iteration at all. With a label it is one
 * pass over the bucket, which is still the minimum: a label is not in the index, so the elements
 * have to be looked at. Both rest on the same `removable` claim item 1595 documents — the bucket IS
 * the matching set for an `eq` on a plain `has` over an indexed key, which is `seedForStep`'s own
 * existing contract and not a new one.
 */
/**
 * A GLOBAL `count` terminal. `count(local)` counts within each element, which is a different
 * question — the same guard `countShortcut` states for its own terminal, and the distinction is
 * only visible once there are SEVERAL matches: on one match both scopes answer `[1]`, which is why
 * a mutant admitting `local` survived until the tests counted seven.
 *
 * At module scope because it captures nothing, so an inner definition would allocate per call —
 * and this file's whole reason for existing is per-call cost.
 */
const isGlobalCount = (step: Step | undefined): boolean =>
  step?.kind === 'count' && step.scope !== 'local';

const seededCountShape = (
  steps: readonly Step[],
): { labels: readonly string[] | undefined; has: Extract<Step, { kind: 'has' }> } | undefined => {
  const [source, second, third, fourth] = steps;

  if (source?.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (steps.length === 3 && second?.kind === 'has' && isGlobalCount(third)) {
    return { labels: undefined, has: second };
  }

  if (
    steps.length === 4 &&
    second?.kind === 'hasLabel' &&
    third?.kind === 'has' &&
    isGlobalCount(fourth)
  ) {
    return { labels: second.labels, has: third };
  }

  return undefined;
};

export const seededNodeCountShortcut = (plan: Plan, graph: Graph): number | undefined => {
  const shape = seededCountShape(plan.steps);

  if (shape === undefined) {
    return undefined;
  }

  // `0` is the cap meaning "exact seeds only": this path requires `removable`, which a range
  // candidate never is, so counting one is pure waste (item 1759 measured it at 1.62x).
  const candidate = seedForStep(shape.has, graph.vertexPropertyIndex, 0);

  // `removable: false` means the bucket only NARROWS — a range seed, or a `hasLabelAnd` whose label
  // the bucket does not capture — so its size is not the answer.
  if (candidate === null || !candidate.removable) {
    return undefined;
  }

  const bucket = candidate.build();
  const { labels } = shape;

  if (labels === undefined) {
    return bucket.size;
  }

  let n = 0;

  for (const v of bucket) {
    // `hasLabel`'s own rule: ANY of the named labels is a pass, not all of them.
    if (labels.some((l) => v.labels.has(l))) {
      n += 1;
    }
  }

  return n;
};
