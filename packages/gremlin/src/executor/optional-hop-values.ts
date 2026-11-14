import type { Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import type { HopValues } from './hop-values.js';
import { adjacentEdges, otherEndpoint, soleTypeBucket } from './movement.js';
import { optionalSingleHop } from './optional-hop.js';

/**
 * `V().optional(out(T)).values(k)` — the left-join idiom projected to bare values (item 1884).
 *
 * ⚠️ THE STEP IS ALREADY FUSED; THE PLAN IS NOT. `optional-hop.ts` (items 1480/1483/1628) removed
 * `optionalStep`'s per-traverser sub-plan — a one-element input array, a 103-arm dispatch, a
 * generator per step and a full materialization just to test non-emptiness — and took the adjacency
 * bucket directly for a directed single type. What remains is that the whole plan still runs in the
 * TRAVERSER pipeline: a traverser is allocated per row, handed to `projectValues`, and unwrapped.
 * Its fused twin `V().out(T).values(k)` allocates none of that.
 *
 * ⚠️ PRICED BEFORE IT WAS BUILT, one shape per process, both orders
 * (`optional-hop-floor-1884.mjs`, 20,000 vertices / 100,000 edges, median of 9). On this fixture
 * every vertex has an out-edge, so `optional` never takes its empty branch and the two shapes do
 * the SAME walk over the SAME rows:
 *
 * ```text
 *   V().optional(out(E)).values(n)   10.24 / 8.99 ms   80,000 rows   128 / 112 ns a row
 *   V().out(E).values(n)              3.13 / 2.55                      39 /  32
 *   V().optional(out(E)).id()         7.24 / 7.17                      91 /  90
 * ```
 *
 * **3.3-3.5x**, and the profile says where it goes (150 reps, query 80% of the process):
 * `optionalHopStep` 25.1%, `projectValues` 12.8%, `toArray` 11.3%, `unwrap` 7.6%,
 * `isVertexShaped` 6.5%, `get properties` 4.5%, `extend` 1.4% — the traverser machinery and the
 * generator boundaries, not the walk.
 *
 * ⚠️ THE EMPTY BRANCH IS THE WHOLE POINT OF `optional` AND IT IS MIRRORED EXACTLY, including the
 * subtle part: `optionalHopStep` sets `any` per EDGE, before the projection. So a vertex that HAS
 * edges whose far vertices all lack `k` emits **nothing** — not itself. Deciding emptiness from
 * whether any VALUE survived would be a different (and wrong) answer, and the fixture in the test
 * file has a vertex built to tell the two apart.
 *
 * ⚠️ A NEW MODULE, NOT A GUARD RELAXED IN `hop-values.ts` — items 1441/1466 measured an edit to that
 * file at up to 16% on UNRELATED rows, arbitrarily signed, and item 1466 declined a 3.3x win on
 * that basis. `optional-hop.ts`'s own header opens with the same reasoning. The gate is reused from
 * there (`optionalSingleHop`) rather than restated, so the two cannot drift about which sub-plan
 * shapes are a single hop.
 *
 * ⚠️ AND THE WALK CALLS THE SAME HELPERS THE STEP CALLS (`soleTypeBucket`, `adjacentEdges`,
 * `otherEndpoint`), not a second derivation of them. Gremlin stream order is a TinkerPop contract
 * and the differential fuzzer compares Gremlin results ORDERED, so a reordering here is a
 * cross-engine failure rather than an unspecified-order liberty.
 */
export const optionalHopValues = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  const [source, wrapper] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the same bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (wrapper.kind !== 'optional') {
    return undefined;
  }

  const hop = optionalSingleHop(wrapper.plan);

  if (hop === undefined) {
    return undefined;
  }

  const [, , proj] = steps;
  // ONE key, for `hopValuesShortcut`'s reason: `values()` with no key emits every property value
  // and `values(a, b)` fans out per key.
  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  const picked = pickFor(proj, valueKey);

  if (picked === undefined) {
    return undefined;
  }

  return {
    rest: steps.slice(proj === undefined ? 2 : 3),
    values: walk(graph, { hop, ...picked }),
  };
};

type Element = { readonly id: string; readonly properties: Record<string, unknown> };
type Picked = { pick: (e: Element) => unknown; drops: boolean };

/**
 * What the plan asks for about each emitted element. `undefined` declines the plan.
 *
 * `values(k)` DROPS an element lacking `k`, which is `projectValues`' own rule (`k in props`); a
 * bare `optional` yields the element and `id()` a string, so neither can produce `undefined` of its
 * own and the sentinel cannot swallow a real value. A property stored as `null` is PRESENT and is
 * emitted — `null !== undefined` — which is the engine's null-as-a-value policy.
 */
const pickFor = (proj: Step | undefined, valueKey: string | undefined): Picked | undefined => {
  if (valueKey !== undefined) {
    return { pick: (e) => e.properties[valueKey], drops: true };
  }

  if (proj === undefined) {
    return { pick: (e) => e, drops: false };
  }

  return proj.kind === 'id' ? { pick: (e) => e.id, drops: false } : undefined;
};

type WalkSpec = {
  readonly hop: { kind: 'out' | 'in' | 'both'; labels: readonly string[] };
  readonly pick: (e: Element) => unknown;
  readonly drops: boolean;
};

/**
 * ⚠️ ONE LOOP, PARAMETERIZED, AT MODULE SCOPE. `ts-closure-size-is-load-bearing`: a walk defined
 * INSIDE the returned closure gave unrelated queries a new slow mode at 4x, so the body lives here
 * and takes its spec as an argument.
 *
 * ⚠️ THE TWO ARMS ARE `optionalHopStep`'s TWO ARMS, for item 1628's reason: `soleTypeBucket` refuses
 * `both`, a multi-type hop and an untyped one, and those keep `adjacentEdges` exactly as the step
 * calls it. Three duplicated lines against a generator chain that is most of the shape.
 */
const walk = (graph: Graph, spec: WalkSpec): Iterable<unknown> => ({
  *[Symbol.iterator]() {
    const { hop, pick, drops } = spec;
    const { kind, labels } = hop;

    for (const v of graph.vertices) {
      const direct = soleTypeBucket(v, kind, labels);
      // ⚠️ `any` IS SET PER EDGE, BEFORE THE PROJECTION — `optionalHopStep`'s own order. A vertex
      // with edges whose far ends all lack the key emits NOTHING, not itself.
      let any = false;

      if (direct !== undefined) {
        const { set, forward } = direct;

        for (const e of set) {
          any = true;

          const value = pick(forward ? e.to : e.from);

          if (!drops || value !== undefined) {
            yield value;
          }
        }
      } else {
        for (const e of adjacentEdges(kind, graph, v, labels)) {
          any = true;

          const value = pick(otherEndpoint(kind, e, v));

          if (!drops || value !== undefined) {
            yield value;
          }
        }
      }

      if (!any) {
        const value = pick(v);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
});
