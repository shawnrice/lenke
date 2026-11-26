import type { Element, Graph, Vertex } from '@lenke/core';

import { adjacentEdges, otherEndpoint, soleTypeBucket } from './movement.js';

/** One vertex step, reduced to what a fused route needs to walk it. */
export type Hop = { kind: 'out' | 'in' | 'both'; labels: readonly string[] };

/**
 * ONE VERTEX'S HOP, projected — the per-vertex arm shared by the reconverging-branch routes.
 *
 * **IT IS A LEAF MODULE SO THE SEMANTICS CANNOT DRIFT BETWEEN ROUTES.** `coalesce-hop-values.ts`
 * (item 1998) and `choose-hop-values.ts` (item 1999) both need "take this one vertex's hop and emit
 * the projected far ends", and both need it as the COLD arm beside a CSR hot arm. Two copies of this
 * would be two places for the `drops` guard, the `both` direction and the bucket/adjacency choice to
 * diverge — and `hop-values-dedupe.ts`'s own header records that items 1561/1562 each found a silent
 * ANSWER change from exactly that kind of second keyer.
 *
 * THE BUCKET/ADJACENCY CHOICE IS PER CALL, NOT PER ROUTE (item 1628). `soleTypeBucket` is a cached
 * `Map.get` priced at **16.1 ns** (items 162/321) and refuses `both`, a multi-type hop and an untyped
 * one; those keep `adjacentEdges`, which delegates through `iterByLabel`/`iterLabeled` and allocates
 * a `{edge, node}` per edge. A `choose` or `coalesce` whose two arms are different shapes needs the
 * choice made for each arm separately, which is why it lives here rather than at the walk.
 *
 * THE BRANCH IS HOISTED OUT OF THE LOOP, not decided per edge — `direct` is loop-invariant.
 */
export const hopArm = function* (
  graph: Graph,
  v: Vertex,
  hop: Hop,
  pick: (e: Element) => unknown,
  drops: boolean,
): Iterable<unknown> {
  const direct = soleTypeBucket(v, hop.kind, hop.labels);

  if (direct === undefined) {
    for (const e of adjacentEdges(hop.kind, graph, v, hop.labels)) {
      const own = pick(otherEndpoint(hop.kind, e, v));

      if (!drops || own !== undefined) {
        yield own;
      }
    }

    return;
  }

  const { set, forward } = direct;

  for (const e of set) {
    const own = pick(forward ? e.to : e.from);

    if (!drops || own !== undefined) {
      yield own;
    }
  }
};

/** `true` when this hop can be served by a single-direction, single-type CSR. */
export const csrEligible = (hop: Hop): boolean => hop.kind !== 'both' && hop.labels.length === 1;
