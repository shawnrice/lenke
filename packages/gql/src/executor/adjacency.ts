/**
 * ADJACENCY: reaching a vertex's edges, by type and in bulk.
 *
 * A leaf with no imports at all (item 1666). These six are the lowest layer of the traversal side —
 * every hop, count and projection rung reaches an edge through one of them, and none of them knows
 * anything about expressions, rows or plans.
 *
 * ⚠️ `edgesOfTypes` vs `edgesOfManyTypes` IS A SELECTIVITY DECISION, NOT A DUPLICATE. A type-filtered
 * expand pays to scan a node's whole adjacency and filter, so the cost scales with degree AND with
 * how many types that degree spans. A selective type over a high-degree, many-type node is where
 * the partitioned path wins; a degree-4 single-type fixture is where it can only lose. Keeping both
 * beside each other is what stops one being "simplified" into the other.
 *
 * ⚠️ `NO_EDGES` IS A SHARED FROZEN EMPTY, read on the overwhelmingly common miss. Item 1658 measured
 * that removing a per-call allocation here is flat across the whole selectivity sweep — the win was
 * never in the allocation, it was in the SHAPE of what is returned — so this constant exists to
 * avoid the allocation, not because allocating measured slow.
 */

import type { Edge, Graph, Vertex } from '@lenke/core';

import type { LabelExpr } from '../ast.js';

/** Edge types a rel label admits: `null` = bail (and/not/wildcard); `undefined`
 * = "any type" (no `:T`); `string[]` = exactly those types. */
export const relTypeNames = (label: LabelExpr | undefined): string[] | null | undefined => {
  if (!label) {
    return undefined;
  }

  if (label.kind === 'label') {
    return [label.name];
  }

  if (label.kind === 'or') {
    const l = relTypeNames(label.left);
    const r = relTypeNames(label.right);

    return l && r ? [...l, ...r] : null;
  }

  // ⚠️ A REL WILDCARD IS "ANY TYPE", UNCONDITIONALLY — and that is the opposite of the NODE
  // wildcard, which item 1549 had to leave un-elided (item 1550).
  //
  // `core` refuses an edge with no labels outright: "Cannot add an edge with no labels: every edge
  // must carry ≥1". So `-[:%]->` ("carries at least one type") admits every edge that exists, and
  // the test is pure cost. A VERTEX may be unlabelled, which is why `(a:%)` is selective there and
  // eliding it invents rows — the same operator, two different answers, decided by a core
  // invariant rather than by analogy.
  //
  // Measured at 200,000 edges, both answering the identical 200,000:
  //
  //     MATCH (a)-[:%]->(x) RETURN count(*)    212.117 -> 0.001 ms
  //     MATCH (a)-[]->(x)   RETURN count(*)      0.003
  //
  // `and` and `not` still bail. Both are soundly expressible as a type list ONLY when no edge
  // carries two types — with `e1 = [E]` and `e2 = [E, F]`, `:!F` admits 1 edge where `[E]` admits
  // 2 — so they need `graph.multiTypeEdgeCount === 0`, which this function has no graph to read.
  // Priced at item 1550: `:!F` 202.345 ms against its `:E` twin's 0.001, a 202,000x on the SAME
  // 180,000 rows.
  if (label.kind === 'wildcard') {
    return undefined;
  }

  return null;
};
/**
 * Every edge of `types` (undefined = every type) from a `Map<type, Set<Edge>>`
 * index, each yielded ONCE.
 *
 * An edge carries a SET of types and the index buckets it under every one, so
 * concatenating buckets sees a two-type edge twice — as a doubled count, a
 * doubled neighbour, a doubled row. Native walks a single adjacency list and
 * asks "does this edge carry any of these types", which is what this mirrors.
 * Only one bucket can be in play → no dedupe, no allocation, which is the hot
 * single-type case.
 */
/** Shared empty iterable, so the fast paths below allocate nothing to say "no edges". */
export const NO_EDGES: readonly Edge[] = [];
/**
 * Edges of `types` out of one vertex's by-type bucket map.
 *
 * NOT a generator for the two single-bucket cases, and that is the point. A `Set<Edge>` is already
 * an `Iterable<Edge>`, so `yield* byType.get(t)` delegated to an iterator the function could
 * simply have RETURNED — paying a generator frame per edge for nothing. Audit item 324 priced the
 * frame at **8.4 ns an edge** in the way-count sweep's shape (200,000 frontier slots x ~5 edges x
 * 3 passes: 68.7ms against 43.4, **1.58x** on that loop), and the returning version measured at or
 * below the floor of iterating the Set with no call at all, so the call itself is free. Item 300
 * had priced "the `edgesOfTypes` generator frame" at 1.19x on the sweep without isolating it.
 *
 * The multi-bucket case keeps the generator: it has to dedupe across buckets, so it has real work
 * to interleave and nothing to return.
 *
 * Semantics are unchanged. `yield* set` delegates to the SAME live Set iterator this now returns,
 * so a caller that mutates mid-iteration sees exactly what it saw before; and the only laziness
 * lost is a `Map.get` that every caller was about to force anyway.
 */
export const edgesOfTypes = (
  byType: Map<string, Set<Edge>> | undefined,
  types: string[] | undefined,
): Iterable<Edge> => {
  if (!byType) {
    return NO_EDGES;
  }

  if (types !== undefined) {
    if (types.length === 1) {
      return byType.get(types[0]) ?? NO_EDGES;
    }
  } else if (byType.size === 1) {
    for (const set of byType.values()) {
      return set;
    }
  }

  return edgesOfManyTypes(byType, types);
};
/**
 * The deduping multi-bucket tail of {@link edgesOfTypes}, which genuinely wants to be lazy.
 *
 * NO `seen` SET, and that is the point (item 1377). An edge can only be yielded twice if it sits in
 * two of the buckets being walked, so for bucket `i` a duplicate is exactly an edge already present
 * in some bucket `j < i` — and those buckets already exist, so asking them directly replaces a Set
 * that grew to the full edge count. Bucket 0 yields with ZERO tests; bucket `i` pays at most `i`.
 *
 * EARLIER_BUCKETS. Item 1376 ablated the old `seen` Set at **60.7%** of a multi-type hop count
 * (15.015 ms to 5.902 with dedupe removed outright) while the `types.map` array it also replaced
 * measured at **nothing** (-1.8%, noise) — so the Set's has+add traffic was the whole cost and the
 * allocation was not. Bucket count is the distinct edge types on ONE vertex, and
 * {@link edgesOfTypes} has already taken every single-bucket case before this is reached, so `i` is
 * bounded by something tiny.
 *
 * ⚠️ THIS CLAIMED "ORDER IS UNCHANGED" AND HAS NOT BEEN TRUE SINCE ITEM 1384 (corrected at 1389).
 * The claim was that this yields bucket 0's edges then bucket 1's non-duplicates, so the sequence
 * follows the order the query NAMED its types — and that it mattered, because "unordered result
 * order is still BYTES for cross-engine identity". Item 1384 then added the size sort below, which
 * makes bucket 0 the LARGEST rather than the first named: `-[:E|F]->` and `-[:F|E]->` now walk the
 * same buckets in the same order as each other, and neither follows the spelling.
 *
 * That was the POINT of 1384 (it closed a 1.60x equivalent-spelling gap) and the fuzzers have been
 * green across it, so the sequence here is evidently NOT byte-compared — the repo's stance is that
 * an unordered result's row order is unspecified and compared as a multiset. Both halves are
 * recorded because the comment asserted the stronger property for five items while the code had
 * stopped providing it, and a reader relying on it would conclude a wrong thing in either direction.
 *
 * NOT ESTABLISHED: whether a multi-type hop PROJECTION is covered by the differential fuzzers at
 * all. Item 1371 found one such hole by mutation (the dense multi-hop route) and this is the same
 * question, unmeasured. The Gremlin twin `iterLabeled` does follow label-arg order, deliberately,
 * and item 1389 kept it that way rather than copying the sort here.
 */
export const edgesOfManyTypes = function* (
  byType: Map<string, Set<Edge>>,
  types: string[] | undefined,
): Iterable<Edge> {
  const buckets: Set<Edge>[] = [];

  if (types === undefined) {
    for (const set of byType.values()) {
      buckets.push(set);
    }
  } else {
    for (const t of types) {
      const set = byType.get(t);

      if (set !== undefined) {
        buckets.push(set);
      }
    }
  }

  // LARGEST_BUCKET_FIRST (item 1384). Bucket `i` pays `i` membership tests per edge, so the total is
  // minimised by descending size — and WITHOUT this the walk costs whatever order the query named
  // its types: `-[:E|F]->` measured 5.227 ms against `-[:F|E]->`'s 8.352, **1.60x**, both answering
  // 200000. That is the equivalent-spelling class CLAUDE.md hunts, and item 1382 fixed the same
  // defect on the Gremlin side at 3.53x.
  //
  // Sorting here is paid PER VERTEX, not once per query as in the Gremlin twin, over an array whose
  // length is the number of edge types incident to ONE vertex — so it is two or three elements and
  // V8 sorts that with insertion sort. A/B'd rather than assumed, because a per-vertex sort could
  // have cost more than the asymmetry it removes.
  buckets.sort((a, b) => b.size - a.size);

  for (let i = 0; i < buckets.length; i += 1) {
    for (const e of buckets[i]) {
      let earlier = false;

      for (let j = 0; j < i; j += 1) {
        if (buckets[j].has(e)) {
          earlier = true;

          break;
        }
      }

      if (!earlier) {
        yield e;
      }
    }
  }
};
/** One-hop neighbours of `v` along `out` (or in) edges of the given `types` (all
 * types when undefined). Shared by the EXISTS-reachable and RETURN-reachable
 * traversals so their neighbour expansion can't drift from each other or native.
 *
 * ⚠️ REJECTED, item 1570: do NOT replace this with a callback/visitor to avoid the array.
 *
 * The `Vertex[]` here is materialized per EXPANDED VERTEX and both callers immediately iterate it
 * and drop it, so removing the allocation looks free — and a profile of
 * `MATCH (a:P)-[:E]->+(b:P) RETURN count(DISTINCT b)` put this function at **32.5% self** (576 ms),
 * with only 2 mentions anywhere, which reads like an unpriced target.
 *
 * It was built: `eachOutNeighbor(graph, v, out, types, visit)` with a boolean STOP signal (needed
 * because the `EXISTS` walk returns the moment it finds a hit), both callers converted, the visitor
 * closures hoisted once rather than per expansion. **Flat.**
 *
 *     varlenplus   PRE 1591.0 1656.9 1725.0     POST 1483.3 1629.9 1628.0    1.02x, ranges overlap
 *     existssub    PRE   72.2   69.2   73.2     POST   72.5   71.9   70.6    flat (the early-exit arm)
 *
 * So the 32.5% is `edgesOfTypes`' iteration credited to its caller, not the allocation — the
 * attribution hazard `runtime-profile-analyze.mjs`' own header warns about (item 1104: "a small hot
 * callee gets credited with its caller's inlined loop … use this screen to NOMINATE, then ablate to
 * price"). One array per expanded vertex is not where the time goes. */
export const outNeighbors = (
  graph: Graph,
  v: Vertex,
  out: boolean,
  types: string[] | undefined,
): Vertex[] => {
  const byType = out ? v.adjFrom : v.adjTo;
  const acc: Vertex[] = [];

  for (const e of edgesOfTypes(byType, types)) {
    acc.push(out ? e.to : e.from);
  }

  return acc;
};
/** Count the `edges` that pass `keep`. */
export const countEdges = (edges: Iterable<Edge>, keep: (e: Edge) => boolean): number => {
  let n = 0;

  for (const e of edges) {
    if (keep(e)) {
      n += 1;
    }
  }

  return n;
};
