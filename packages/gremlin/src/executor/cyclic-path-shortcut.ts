import type { Graph, Vertex } from '@lenke/core';

import type { Plan } from '../ast.js';

/**
 * `V().out(T).cyclicPath()` — and it is the SELF-LOOP EDGES, which is the whole insight (item 1986).
 *
 * A one-hop traversal's path is `[start, far]`, so it revisits a vertex exactly when `far === start`
 * — exactly when the edge is a self-loop. **So this needs no path tracking at all**, which is
 * what makes it worth a rung: `cyclicPath` is in `PATH_DEPENDENT_KINDS`, so `tracksPath` is true for
 * the whole run and `effectivePlan` is skipped WHOLESALE, leaving the general path-bookkeeping route
 * to walk a million edges and keep a path per traverser to return (in the screen's fixture) six rows.
 *
 * **AND IT IS A REFUSAL RE-OPENED, NOT AN OVERSIGHT.** Item 1923 declined `cyclicPath` with a
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
 * **THE EDGE-SET ARM IS NOW TAKEN — 4.6x, at item 2407.** ~~THE EDGE-SET ARM IS 4.6x FASTER
 * AGAIN AND IS CORRECTNESS-BLOCKED — not an owner decision, which is how item 1986 first recorded it
 * and item 1987 corrected.~~ Items 1986/1987 refused it because the Gremlin differential fuzzer
 * decided `unordered` as `multiType || RECONVERGING_BRANCH`, so a SINGLE-TYPE `out('E')` satisfied
 * none of them and was compared **STRICTLY ORDERED** against native — making TS stream order a
 * cross-engine contract. **The OWNER RULING of 2026-11-22 (item 2400) dissolved exactly that**: walk
 * order is implementation-dependent and need not match across engines, so the fuzzer's predicate now
 * admits any adjacency step (`ADJACENCY_STEP`) and this shape is compared as a MULTISET. The refusal
 * was never about this engine computing a wrong answer; it was about a comparison mode that no longer
 * applies.
 *
 * **AND THE EDGE-SET DRIVE IS SIMPLER, NOT JUST FASTER.** A self-loop is a self-loop from either
 * end, so `out` and `in` return the SAME rows (items 1986's own fixture recorded that:
 * `V().in_(E).cyclicPath()` matched `out`). Driving the type's edge set makes the direction flag
 * irrelevant, so the walk drops the per-vertex bucket indirection AND the `outward` branch.
 *
 * Item 1955 is the same lever one shape over, for `V().outE('E')` — see item 2407 for its number,
 * which had gone STALE in the other direction: items 1956/1957 took that row from 111.1 to 62.0 ms,
 * so its "2.28x beyond a start-driven ceiling" is now 1.96x and the engine BEATS the start-driven
 * hand walk (0.89x).
 *
 * ONE ROW PER *EDGE*, NOT PER VERTEX. Two PARALLEL self-loops at one vertex are two distinct
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
  const key = proj === undefined ? undefined : proj.keys[0];
  const rows: unknown[] = [];

  /*
   * EDGE-INSERTION ORDER, NOT VERTEX ORDER — and that is what item 2400's ruling freed. The
   * general route emits vertex order then edge order; this emits the type's edge set in insertion
   * order, which is the SAME MULTISET and a different sequence. A consumer who needs an order adds
   * an explicit `order()`.
   *
   * The bucket holds only LIVE edges — `removeEdge` de-indexes it, which
   * `edge-endpoint-ids.test.ts`'s "removal de-indexes and drops the emptied label entry" pins. A
   * stale bucket would make this emit rows the per-vertex walk cannot, which is a WRONG ANSWER
   * rather than a reorder, so that maintenance is load-bearing here.
   *
   * The direction flag is deliberately NOT read: a self-loop is reachable from either end, so
   * `out(T)` and `in(T)` select the identical edges. Only `hop.labels.length === 1` and a directed
   * hop are admitted above, so `both`'s double-emission never reaches this walk.
   */
  const bucket = graph.edgesByLabel.get(type);

  if (bucket === undefined) {
    return rows;
  }

  for (const edge of bucket) {
    // Identity, not id: an id comparison would also match a vertex and an edge that share one
    // ([[cross-engine-divergences-open]]).
    const from: Vertex = edge.from;

    if (from === edge.to) {
      rows.push(key === undefined ? from : from.properties[key]);
    }
  }

  return rows;
};
