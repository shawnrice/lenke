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
import type { Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { seedForStep } from './index-seed.js';

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

  const candidate = seedForStep(shape.has, graph.vertexPropertyIndex);

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

  const candidate = seedForStep(shape.has, graph.vertexPropertyIndex);

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
