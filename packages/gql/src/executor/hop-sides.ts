/**
 * HOP GEOMETRY: which end of an edge a traversal came from, and which end it is going to.
 *
 * ⚠️ THIS IS THE MODULE THAT BREAKS `core <-> shortcuts` (item 1666). `core.ts` needed exactly seven
 * values from `shortcuts.ts` — `plainNode`, `plainRel`, `side`, `sideOfVertex`, `sideOfVertexGated`,
 * `threeHopSide`, `twoHopSide` — while `shortcuts.ts` needed twenty back, and that pair was the
 * largest import cycle in the package. The thin side was core's, so these came down rather than the
 * twenty going up. 166 lines decided a cycle that five previous leaf extractions could not touch,
 * because none of them was on the edge that actually closed it.
 *
 * `bucketSize` and `KEEP_ANY` came along because the seven need them and nothing else here does.
 *
 * ⚠️ `sideOfVertexGated` IS NOT A REDUNDANT `sideOfVertex`. The gated form refuses when the vertex
 * could match either end — a self-loop, or an undirected pattern where both endpoints satisfy the
 * label — and returning a side there would pick an arbitrary one and silently halve the answer. The
 * ungated form is for the positions where the caller has already established which end it holds.
 * Two names, two preconditions; collapsing them is a wrong answer, not a simplification.
 */

import type { Edge, Graph, Vertex } from '@lenke/core';

import type { LabelExpr, NodePattern, RelPattern } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import { countEdges, edgesOfTypes } from './adjacency.js';

export const plainNode = (n: NodePattern): boolean =>
  (n.properties?.length ?? 0) === 0 && n.where === undefined;
export const plainRel = (r: RelPattern): boolean =>
  (r.properties?.length ?? 0) === 0 && r.where === undefined && r.quantifier === undefined;
/** Edges out of / into `bId` (of `types`) whose far endpoint matches `far`. The
 * two-hop degree product's per-`b` side count; hoisted to module scope since it
 * closes over nothing but the shared bucket primitives. */
/*
 * REJECTED, with its numbers (item 355): taking a `Vertex` here instead of its id, so the first
 * lookup reads `v.adjFrom` — item 321's adjacency box — instead of hashing the id into a
 * 200,000-entry Map. **Six of this function's ten call sites already hold the Vertex and pass its
 * id**, which reads like free money. It is not, and the reason is that the box is a MEMO.
 *
 * 200,000 vertices / 1,000,000 edges, each variant in its OWN PROCESS on a FRESH graph (the box
 * memoizes, so any variant that touches it warms the box for every variant measured after it —
 * the first version of this probe had exactly that defect), min of 3 alternated rounds, ns per
 * iteration, with a null control that stayed flat at 3-11ns:
 *
 *     vertex in hand, today   (v.id -> 200k map)     first 203.4   warm 171.3
 *     vertex in hand, box     (v.adjFrom)            first 247.0   warm 127.1
 *
 * The box is **1.21x WORSE on first touch** — it pays the same hash AND the memo write — and
 * 1.35x better warm. **Five of those six sites visit each vertex exactly ONCE per query** (the
 * hoisted per-`b` degree reads), so they would take the cold cost and never reach the warm win:
 * on a freshly loaded graph that is a REGRESSION, not a win. Only the `c` position in the
 * three-segment product (`side(graph, c.id, …)` under `needsC`) is revisited — once per middle
 * edge, ~in-degree times per vertex — and there the blended cost is ~1.21x better. One site, not
 * six. **A memo helps a revisited element and taxes a visited-once one, so "the caller already
 * holds the object" is not by itself a reason to use it.**
 *
 * Also priced here, and NOT built: giving `Edge` a direct REFERENCE to its endpoint vertices, so
 * the two call sites that hold only an edge's stored id could read `e.toRef.adjFrom` with no hash
 * at all. That is the hottest read in the `count 3-hop` row (ts 330.3ms against ffi 4.9) and it is
 * the one variant that REMOVES the lookup rather than relocating it:
 *
 *     edge, today    (e.toId -> 200k map)            first 259.0   warm 248.9
 *     edge, ref      (stored ref -> box)             first 234.2   warm 187.9      1.32x warm
 *     edge, resolve  (e.to -> box)                   first 339.5   warm 301.5      WORSE
 *
 * ~1.18x on that row, and the `resolve` row independently re-refutes item 323 at a new size. It is
 * declined here rather than built because it needs a NEW INVARIANT — an endpoint reference must
 * never outlive the endpoint INSTANCE, where items 140/218 deliberately store the id and
 * `evict()`/rollback replay both swap instances for the same id — and ~1.18x on one row does not
 * buy that. The gap it leaves is still the CSR's (items 300, 348, 350, 352).
 *
 * UNTRIED, and the one shape with no cold penalty and no new invariant: PEEK the box and hash only
 * on a miss (`adjFromIfBoxed ?? …`), never writing it. Warm callers get 127.1, cold callers pay
 * today's cost plus a field read. It cannot be measured on this row — nothing warms the box on a
 * fresh graph — so it needs a MIXED read/write workload (`bench:usage`), which is where item 321's
 * boxes are already populated.
 */
/**
 * `side` for a caller that holds the VERTEX, reading its adjacency box (`Vertex.adjFrom` /
 * `adjTo`, items 162 and 321) instead of hashing the id into the graph's map.
 *
 * ITS OWN FUNCTION, deliberately — `side` itself stays on the id. Item 355 measured passing a
 * Vertex into `side`: the box is a MEMO, so first touch is 1.21x WORSE (same hash plus the memo
 * write) and warm is 1.35x better, and FIVE of that function's six vertex-holding call sites
 * visit each vertex exactly once per query, where the cold cost is all they would ever get.
 * Widening `side` would impose that on all six.
 *
 * This caller is the correlated `COUNT { (u)-[:T]->(x) }` subquery, which is the shape item 492
 * measured on the `EXISTS` side: 93 ms against native's 14.7 at 200,000 nodes. Item 493 then
 * measured cold and warm separately there — **warm 1.3x better, cold indistinguishable at query
 * scale** — so this is taken with that claim and no other.
 */
export const sideOfVertex = (
  v: Vertex,
  out: boolean,
  types: string[] | undefined,
  far: LabelExpr | undefined,
): number => {
  const byType = out ? v.adjFrom : v.adjTo;

  if (far === undefined) {
    return bucketSize(byType, types);
  }

  return countEdges(edgesOfTypes(byType, types), (edge) =>
    matchesLabel(out ? edge.to : edge.from, far),
  );
};
/**
 * `sideOfVertex` with a per-NEIGHBOUR gate as well as a label: the one-hop degree restricted to
 * the endpoints a predicate keeps.
 *
 * Module scope and not an inline closure, deliberately: a walk written inside a returned closure
 * gives UNRELATED queries a new slow mode (item 268's finding, 4x). The caller's `keep` is built
 * once per outer row; this loop is compiled once.
 *
 * The label is tested BEFORE the gate, so a labelled landing pays the predicate only on the
 * neighbours that survive the label — the cheaper test first, and the order is unobservable
 * because the gate keeps only a clean TRUE either way (item 259).
 */
export const sideOfVertexGated = (
  v: Vertex,
  out: boolean,
  types: string[] | undefined,
  far: LabelExpr | undefined,
  keep: (node: Vertex) => boolean,
): number =>
  countEdges(edgesOfTypes(out ? v.adjFrom : v.adjTo, types), (edge) => {
    const node = out ? edge.to : edge.from;

    return (far === undefined || matchesLabel(node, far)) && keep(node);
  });
export const side = (
  graph: Graph,
  bId: string,
  out: boolean,
  types: string[] | undefined,
  far: LabelExpr | undefined,
): number => {
  const byType = (out ? graph.edgesFromByLabel : graph.edgesToByLabel).get(bId);

  // With no far label to test, nothing here wants the far ENDPOINT — so the answer is a bucket
  // SIZE, and none of the three per-edge costs is owed: the `edgesOfTypes` generator frame, the
  // `edge.to` / `edge.from` resolve (a string-keyed `Map.get`, ~190ns — item 194), and the label
  // call itself. This is most of the two-hop count family: `side` ran the full per-edge loop even
  // for an UNLABELLED endpoint, where `matchesLabel(x, undefined)` is true for every edge it
  // resolved (audit item 218).
  if (far === undefined) {
    return bucketSize(byType, types);
  }

  return countEdges(edgesOfTypes(byType, types), (edge) =>
    matchesLabel(out ? edge.to : edge.from, far),
  );
};
/**
 * How many edges `edgesOfTypes` would yield, without yielding them.
 *
 * ⚠️ IT PROFILES AT 72-77% OF A MULTI-HOP COUNT AND THAT IS MISATTRIBUTION. Item 1416 found it for
 * `chain3` (72.6%, "all 200,000 calls take the O(1) branch, proven by counting them") and item 1637
 * reproduced it for a THREE-HOP COUNT (76.7% of `count3`): instrumenting this function counted
 * **119,992 calls for 20,000 vertices and 99,992 edges — exactly |V| + |E|, one per vertex plus one
 * per edge, and ALL of them on the single-named-type O(1) branch.** At the profiled fixture that
 * works out to ~185 ns for a `Map.get(…)?.size`, which is not credible; the time is the CALLER's
 * per-edge loop credited to a small hot callee. So there is no repeated-lookup lever here — a
 * per-vertex degree memo would save nothing, because no vertex's degree is read twice.
 *
 * Mirrors that function's cases exactly, which is the whole requirement: a single named type, or
 * a single bucket when every type is wanted, is one `size` read. Several buckets are NOT a sum —
 * one edge can carry several labels and so sit in more than one of them, which is why
 * `edgesOfTypes` keeps a `seen` set. That case has no size to read, so it still counts, but it
 * counts without resolving an endpoint.
 */
export const bucketSize = (
  byType: Map<string, Set<Edge>> | undefined,
  types: string[] | undefined,
): number => {
  if (byType === undefined) {
    return 0;
  }

  if (types !== undefined) {
    if (types.length === 1) {
      return byType.get(types[0])?.size ?? 0;
    }
  } else if (byType.size === 1) {
    for (const set of byType.values()) {
      return set.size;
    }
  }

  return countEdges(edgesOfTypes(byType, types), KEEP_ANY);
};
export const KEEP_ANY = (): boolean => true;
/** Everything the two-hop degree count needs beyond the anchor vertex. */
export type TwoHopSide = {
  firstOut: boolean;
  t1: string[] | undefined;
  midLabel: LabelExpr | undefined;
  secondOut: boolean;
  t2: string[] | undefined;
  farLabel: LabelExpr | undefined;
};
/**
 * The number of two-hop paths out of ONE vertex — `side`'s two-segment counterpart.
 *
 * Exactly `buildFilteredTwoHopCount`'s inner loop, lifted so a correlated
 * `COUNT { (u)-[:T1]->(x)-[:T2]->(y) }` can use it without the executor trunk needing the
 * adjacency primitives (audit item 212). The MIDDLE label is checked before the second leg is
 * counted, so a rejected middle costs one label test rather than a `side` call.
 */
export const twoHopSide = (graph: Graph, id: string, w: TwoHopSide): number => {
  const byType = (w.firstOut ? graph.edgesFromByLabel : graph.edgesToByLabel).get(id);
  let n = 0;

  // With no middle LABEL there is nothing to resolve the middle vertex FOR, and the loop was
  // resolving it (`e.to`, a string-keyed `Map.get`) only to hand `mid.id` straight back to
  // another `Map.get` — two lookups an edge where one does. This branch reads the endpoint id
  // the EDGE already stores and never materializes the vertex (item 140's point, one segment on).
  if (w.midLabel === undefined) {
    for (const e of edgesOfTypes(byType, w.t1)) {
      n += side(graph, w.firstOut ? e.toId : e.fromId, w.secondOut, w.t2, w.farLabel);
    }

    return n;
  }

  // A middle LABEL has to resolve the vertex anyway, so the lookup that branch could drop is the
  // second one — `sideOfVertex(mid, …)`, the vertex's own box. Tried and MEASURED FLAT: 369.9 /
  // 384.4 / 367.7 ms against 384.1 / 364.2 / 372.0, overlapping ranges on a labelled middle at
  // 200,000 vertices. The middle position IS revisited (once per edge into it), so item 355's
  // visited-once objection does not apply here — the box read simply is not cheaper than the map
  // read at this size. Left on the id, which is the smaller diff.
  for (const e of edgesOfTypes(byType, w.t1)) {
    const mid = w.firstOut ? e.to : e.from;

    if (matchesLabel(mid, w.midLabel)) {
      n += side(graph, mid.id, w.secondOut, w.t2, w.farLabel);
    }
  }

  return n;
};
/** Everything the THREE-hop degree count needs beyond the anchor vertex. */
export type ThreeHopSide = {
  firstOut: boolean;
  t1: string[] | undefined;
  mid1Label: LabelExpr | undefined;
  /** The remaining two hops, answered by `twoHopSide` from each first-hop landing. */
  rest: TwoHopSide;
};
/**
 * The number of three-hop paths out of ONE vertex — `twoHopSide` one segment further.
 *
 * `degreeCountSubquery` capped the degree path at TWO segments, so
 * `COUNT { (u)-[:T]->(x)-[:T]->(y)-[:T]->(z) }` fell to the general matcher: 6097ms at 200,000
 * vertices of degree 5 against the native engine's 40.4 (audit item 497), because the matcher
 * materializes all ~25,000,000 bindings to count them.
 *
 * Composed rather than written out: each first-hop landing is handed to `twoHopSide`, which is
 * item 212's reader and already carries the middle-label and far-label handling. So the recursion
 * is one level deep and the per-edge costs below the first hop are the ones already measured.
 * Item 495's point applies to this hop too — with no label on the first landing there is nothing
 * to resolve the vertex FOR, so that branch reads the id the EDGE stores.
 */
export const threeHopSide = (graph: Graph, id: string, w: ThreeHopSide): number => {
  const byType = (w.firstOut ? graph.edgesFromByLabel : graph.edgesToByLabel).get(id);
  let n = 0;

  if (w.mid1Label === undefined) {
    for (const e of edgesOfTypes(byType, w.t1)) {
      n += twoHopSide(graph, w.firstOut ? e.toId : e.fromId, w.rest);
    }

    return n;
  }

  for (const e of edgesOfTypes(byType, w.t1)) {
    const mid = w.firstOut ? e.to : e.from;

    if (matchesLabel(mid, w.mid1Label)) {
      n += twoHopSide(graph, mid.id, w.rest);
    }
  }

  return n;
};
