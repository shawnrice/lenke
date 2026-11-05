// `optional(out(T))` — the left-join idiom — fused into ONE loop.
//
// WHY A NEW MODULE. Every edit to `hop-values.ts` / `hop-projection.ts` has moved unrelated rows by
// up to ~16% in an arbitrary direction (items 1413/1415/1440/1442/1462). Item 1482 established that
// the toll is on editing THOSE FILES, so a new module avoids it and only one `dispatch.ts` call site
// changes. Nothing here imports from either file.
//
// WHAT IT IS FOR. `optionalStep` runs its sub-plan per incoming traverser:
//
//   for (const t of stream) {
//     const out = [...applyPlanToStream(plan, [t], graph, ctx)];
//     if (out.length > 0) { yield* out; } else { yield t; }
//   }
//
// — so for every row it builds a one-element input array, walks the sub-plan's step array through a
// 103-arm dispatch, creates a generator per step, and materializes the whole output into an array
// just to ask whether it is non-empty. Item 1480 measured `V().optional(out('E')).values('k')` at
// **11-19x** the unwrapped hop, and item 1483 isolated the cause: `optional(identity())` costs the
// same as no wrapper at all (2.28 ms against 2.81), so the wrapper is nearly free and ALL of the gap
// is that wrapping. Item 1479 proved the same thing for `local` and took 20.7x from it.
//
// The sub-plan here is a single vertex step, whose entire body is `for each adjacent edge, yield the
// far endpoint` — so inlining it removes the array, the dispatch and the generator, and keeps one
// loop over the stream.
//
// ⚠️ ONLY A SINGLE `out`/`in`/`both` STEP. Anything else falls through to `optionalStep` untouched: a
// multi-step sub-plan, a filter, a barrier, a nested branch. The gate is a shape test, not a
// capability claim.
//
// ⚠️ IT IS LAZY WHERE `optionalStep` IS EAGER, and that is safe HERE and nowhere else. The eager
// `[...]` means the whole sub-plan runs before any row is yielded, so making it lazy reorders side
// effects relative to downstream consumption — which is why item 1480 declined the same change for
// the general case, and why `sideeffect-in-branch.test.ts` exists. A vertex step has no side effects,
// so for this shape the two orders are indistinguishable.
import type { Graph } from '@lenke/core';

import type { Plan } from '../ast.js';
import { adjacentEdges, otherEndpoint } from './movement.js';
import { extend, isVertex, type Traverser } from './runtime.js';

/** The single vertex step this fusion handles, or `undefined` for every other sub-plan shape. */
export const optionalSingleHop = (
  plan: Plan,
): { kind: 'out' | 'in' | 'both'; labels: readonly string[] } | undefined => {
  if (plan.steps.length !== 1) {
    return undefined;
  }

  const [only] = plan.steps;

  if (only.kind !== 'out' && only.kind !== 'in' && only.kind !== 'both') {
    return undefined;
  }

  // the narrowing above already types `only` as the vertex-step union
  const { kind, labels } = only;

  return { kind, labels };
};

/**
 * `optional(<one vertex step>)`: emit the far endpoints when there are any, otherwise the traverser
 * itself.
 *
 * ⚠️ A NON-VERTEX TRAVERSER PASSES THROUGH, which is what the general path already does rather than
 * a liberty taken here: `traverseToVertex` yields NOTHING for a non-vertex (it is lenient, unlike the
 * edge→vertex steps), so `optionalStep`'s empty branch emits the traverser. Mirrored exactly.
 *
 * ⚠️ ORDER IS `adjacentEdges`' OWN, unchanged — the same helper the general step calls, not a second
 * derivation of it. Gremlin results are compared ORDERED against the Rust engine by the differential
 * fuzzer, so a reordering here would be a cross-engine failure rather than an unspecified-order
 * liberty.
 */
export const optionalHopStep = function* (
  stream: Iterable<Traverser<unknown>>,
  hop: { kind: 'out' | 'in' | 'both'; labels: readonly string[] },
  graph: Graph,
): Iterable<Traverser<unknown>> {
  const { kind, labels } = hop;

  for (const t of stream) {
    if (!isVertex(t.value)) {
      yield t;
      continue;
    }

    const v = t.value;
    let any = false;

    for (const e of adjacentEdges(kind, graph, v, labels)) {
      any = true;

      yield extend(t, otherEndpoint(kind, e, v));
    }

    if (!any) {
      yield t;
    }
  }
};
