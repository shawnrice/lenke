import type { Graph, Vertex } from '@lenke/core';

import type { Plan } from '../ast.js';

/**
 * `V().out(T).cyclicPath()` — and it is the SELF-LOOP EDGES, which is the whole insight (item 1986).
 *
 * A one-hop traversal's path is `[start, far]`, so it revisits a vertex exactly when `far === start`
 * — exactly when the edge is a self-loop. ⚠️ **So this needs no path tracking at all**, which is
 * what makes it worth a rung: `cyclicPath` is in `PATH_DEPENDENT_KINDS`, so `tracksPath` is true for
 * the whole run and `effectivePlan` is skipped WHOLESALE, leaving the general path-bookkeeping route
 * to walk a million edges and keep a path per traverser to return (in the screen's fixture) six rows.
 *
 * 🔑 **AND IT IS A REFUSAL RE-OPENED, NOT AN OVERSIGHT.** Item 1923 declined `cyclicPath` with a
 * reason: it is `simplePath`'s complement, so a REWRITE needs `where(eq(tag))`, and item 1912's rung
 * declines `eq`. That still holds — and it is an argument about the rewrite route, not about the
 * shape. Item 1923's own entry recorded the mechanism its refusal had not considered ("a ONE-HOP
 * `cyclicPath` is exactly the SELF-LOOP edges, so it needs no path tracking and no `where(eq(t))` at
 * all"), and `index.ts`'s note never carried it. [[check-the-blocker-still-holds]].
 *
 * **MEASURED before building** (`cyclicpath-ceiling-1986.mjs`, 200,000 vertices / 1,000,002 edges):
 *
 * ```text
 *     engine (general)                 293.32 ms   6 rows
 *     this route's shape (per-vertex)   30.25      6 rows, SAME ORDER      9.7x
 *     the type's edge set, O(|E_T|)      6.68      6 rows, DIFFERENT order 43.9x
 * ```
 *
 * 🛑 **THE EDGE-SET ARM IS 4.6x FASTER AGAIN AND IS CORRECTNESS-BLOCKED — not an owner decision,
 * which is how item 1986 first recorded it and item 1987 corrected.** Iterating the type's edges
 * directly skips the per-vertex walk, but its order is edge-insertion order rather than vertex
 * order. That is NOT free here: the Gremlin differential fuzzer decides `unordered` as
 * `multiType || RECONVERGING_BRANCH` (plus a path-stream `order()`), and a SINGLE-TYPE `out('E')`
 * with no `coalesce`/`choose`/`optional` and no `order()` satisfies none of them — so this shape is
 * compared **STRICTLY ORDERED** against native and its TS stream order is a cross-engine contract
 * under byte-identity.
 *
 * ⚠️ Item 1955 found exactly this one shape over, for `V().outE('E')`, where the same edge-bucket
 * drive was 2.28x beyond a start-driven ceiling: "a single-type `outE('E')` is not in its unordered
 * set … **a checksum cannot see an order change**". [[order-is-unspecified]] is about rows nobody
 * contracted; it does not license reordering a shape the fuzzer pins. Priced, and refused.
 *
 * ⚠️ ONE ROW PER *EDGE*, NOT PER VERTEX. Two PARALLEL self-loops at one vertex are two distinct
 * edges and the engine returns two rows — verified against the engine on a three-vertex fixture
 * before this was written, and the ceiling probe adds a parallel pair for exactly that reason,
 * because a fixture with at most one self-loop per vertex cannot tell the two readings apart.
 */
export const cyclicPathShortcut = (plan: Plan, graph: Graph): unknown[] | undefined => {
  const { steps } = plan;

  if (steps.length !== 3 && steps.length !== 4) {
    return undefined;
  }

  const [source, hop, tail, proj] = steps;

  // The same bound `normalizeDepth1SimplePath` takes: a bare `V()`, since `V(ids)` narrows the
  // start and this walks the whole vertex set.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  // A DIRECTED, single-type hop. `both` is excluded because a `both` hop reaches a self-loop from
  // both of its boxes, so the multiplicity is not one row per edge and this route's count would be
  // wrong rather than slow.
  if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {
    return undefined;
  }

  if (tail.kind !== 'cyclicPath') {
    return undefined;
  }

  // Only a single-key `values` may trail — the same bound as the `simplePath` rewrite, and for the
  // same reason item 1912 gives: the screen's spellings carry a fifth step, so admitting the
  // projection is what makes the rung reach the measured shape rather than a bare one.
  if (proj !== undefined && (proj.kind !== 'values' || proj.keys.length !== 1)) {
    return undefined;
  }

  const [type] = hop.labels;
  const outward = hop.kind === 'out';
  const key = proj === undefined ? undefined : proj.keys[0];
  const rows: unknown[] = [];

  /*
   * ⚠️ VERTEX ORDER THEN EDGE ORDER, which is the order the general route produces and the reason
   * the ceiling probe compared ANSWERS rather than just times. `graph.vertices` is the same order
   * `V()` seeds, and each vertex's own bucket is walked in insertion order.
   */
  for (const v of graph.vertices) {
    const bucket = (outward ? v.adjFrom : v.adjTo)?.get(type);

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      // The far end, which for a self-loop IS `v` — compared by identity, not id, because an id
      // comparison would also match a vertex and an edge that share one ([[cross-engine-divergences-open]]).
      const far: Vertex = outward ? edge.to : edge.from;

      if (far === v) {
        rows.push(key === undefined ? v : v.properties[key]);
      }
    }
  }

  return rows;
};
