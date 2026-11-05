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
