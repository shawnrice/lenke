// Count / reachability fast-paths for GQL. Detected on the raw AST at compile
// time, these compute a `count(*)` directly from the type-bucket sizes / a degree
// product, or answer an unbounded var-length + DISTINCT query with a plain BFS,
// instead of enumerating every match. They mirror the native engine
// (`try_count_edges` / `try_count_two_hop` / `try_reachable_distinct`) and are
// provably identical for the homomorphic shapes they accept.
import type { Graph, Vertex } from '@lenke/core';

import type {
  Clause,
  CountValue,
  Expr,
  LabelExpr,
  NodePattern,
  PathPattern,
  Projection,
  RelPattern,
  Segment,
} from '../ast.js';
// The shortcuts read shared primitives + compiled types out of the executor
// trunk, and the trunk imports the two detectors back — a safe function-level
// cycle (resolved lazily at call time), matching the other executor submodules.
import type {
  CClause,
  CNode,
  CompiledExpr,
  CPredicate,
  CReturnItem,
  EvalEnv,
  Params,
  Row,
} from '../executor.js';
import {
  edgesOfTypes,
  freePredicateVars,
  columnName,
  compileExpr,
  compilePredicate,
  satisfies,
  countEdges,
  outNeighbors,
  propOf,
  relHasPredicate,
  relTypeNames,
  resolveCount,
  valueKey,
} from '../executor.js';
import { candidateVertices, expand, matchesLabel } from '../graph-queries.js';
import type { Adjacency } from '../graph-queries.js';
import { indexCandidates, matchNode, seedVertices } from './matching.js';
import type { SeedCandidate } from './matching.js';
import { asTruth, isNullish } from './scalars.js';

/**
 * Is `expr` satisfied by EVERY vertex in `graph`, so that testing it per element is pure
 * cost? Only the plain single-label form is answered; `and`/`or`/`not`/`%` fall through.
 *
 * WHY THIS EXISTS. The per-element label test is the whole cost of a labelled 1-hop count,
 * and it is a cache-locality cost, not an interpretation one — each `edge.from.labels.has(L)`
 * chases a pointer to a random `Vertex` and its `Set` across a large heap. Over the 1,000,000
 * edges of the cross-engine bench: the walk WITHOUT the label test is 1.1ms, and WITH it
 * 89.3ms (the generator the walk used to run through accounts for only ~7ms of that).
 *
 * AND IT IS THE REPO'S OWN INVARIANT, not a special case. When every vertex is a `Person`,
 * `MATCH (a:Person)-[:KNOWS]->(x)` and `MATCH (a)-[:KNOWS]->(x)` are EQUIVALENT SPELLINGS of
 * one question — and they cost 586ms against ~0ms, because only the unlabelled spelling
 * reached the O(1) bucket-size path. The native engine already elides this, which is why it
 * answers the same query in ~0.5ms.
 *
 * SOUNDNESS is the `===`: a bucket holding exactly as many vertices as the graph has must
 * hold all of them, so `labels.has(name)` is universally true and dropping it cannot change a
 * row. A stale over-count makes the comparison FAIL and simply leaves the optimization off,
 * which is the safe direction. An empty graph compares `0 === 0` and is trivially vacuous —
 * it has no edges to count either.
 */
const vacuousLabel = (graph: Graph, expr: LabelExpr | undefined): boolean =>
  expr?.kind === 'label' && (graph.verticesByLabel.get(expr.name)?.size ?? 0) === graph.vertexCount;

export const plainNode = (n: NodePattern): boolean =>
  (n.properties?.length ?? 0) === 0 && n.where === undefined;
export const plainRel = (r: RelPattern): boolean =>
  (r.properties?.length ?? 0) === 0 && r.where === undefined && r.quantifier === undefined;

type CountFn = (graph: Graph, params: Params) => Row;

/**
 * A count builder is generic in what it WRAPS its number into, so the same builder
 * serves two callers: the single-pattern shortcut wraps the number into the result
 * `Row`, and the product shortcut (`detectProductCount`) takes the number itself to
 * multiply. Making the three builders generic rather than number-returning keeps
 * every `return rowOf(...)` in their bodies untouched — the alternative was editing
 * a dozen return sites in code whose arithmetic is the part that must not move.
 */
type CountOf<T> = (graph: Graph, params: Params) => T;

/**
 * `MATCH (n[:L]) RETURN count(*)` — the node count, straight off the label bucket.
 *
 * This shape had NO shortcut: `detectCountShortcut` handled one and two segments and fell
 * through to `null` for zero, so a bare labelled node count enumerated every vertex and built
 * a row per match. On the cross-engine bench (200,000 `Person` nodes) that is ts 91.1ms
 * against native's ~0.0ms, a 16125x gap — the single widest in the table after the 1-hop count
 * was fixed.
 *
 * `verticesByLabel` is ALREADY load-bearing for correctness, which is what makes reading its
 * size sound rather than optimistic: `candidateVertices` enumerates that same bucket for a
 * plain label, so a bucket missing a vertex would already make `MATCH (n:Person)` miss rows.
 * The one asymmetry is that enumeration re-checks each candidate through `matchNode` and so
 * tolerates a stale EXTRA, where a size read would not — `a removed vertex and a removed label
 * both leave the count exact` pins that the index has no such extras.
 *
 * Only the plain single-label form and the unlabelled form are answered. `and` (`(n:A:B)`),
 * `or`, `not` and `%` have no single bucket, so they fall through to enumeration.
 */
const buildNodeCount = <T>(
  start: NodePattern,
  rowOf: (n: number) => T,
  preds: readonly InlinePred[] = [],
  cstart?: CNode,
): CountOf<T> | null => {
  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const name = label?.name;

  // UNCONSTRAINED: the bucket's size IS the answer, so this stays O(1).
  if (preds.length === 0) {
    if (name === undefined) {
      return (graph) => rowOf(graph.vertexCount);
    }

    return (graph) => rowOf(graph.verticesByLabel.get(name)?.size ?? 0);
  }

  // CONSTRAINED: tally the bucket. O(bucket) rather than O(1), but it is the same
  // walk the general path makes with none of the row building — and it is what lets
  // `productCountOf` take a constrained pattern as a factor at all.
  //
  // The predicate is applied through `inlineHolds` -> `satisfies`, the general
  // path's own implementation, so the two spellings of a constrained node count
  // agree by construction rather than by re-deriving inline-pattern semantics here.
  return (graph, params) => {
    // One binding map, reused: `inlineHolds` overwrites the node's own variable per
    // vertex and nothing else reads it, which is what `preds` being CLOSED buys.
    const binding = new Map<string, unknown>();
    const bucket =
      name === undefined ? graph.verticesById.size : (graph.verticesByLabel.get(name)?.size ?? 0);
    // AN INDEX SEEK, when the graph offers one and it is SMALLER than the label bucket.
    //
    // Without this the tally always scanned the bucket, so a filtered count ignored a
    // property index the general path seeds from. Measured on 20,000 users with `score`
    // indexed and 200 matches: this tally 0.91ms indexed against 0.93 unindexed — the index
    // doing NOTHING — where the same query forced onto the general path went 5.66 -> 0.42ms.
    // So the tally was 2.2x SLOWER than the path it replaced whenever an index existed, and
    // `bun run bench:usage` had been showing it all along as a row whose indexed and
    // unindexed columns were identical (audit item 149).
    //
    // `indexCandidates` is the general path's own enumerator, so the two agree on what is
    // seekable, and its counts are O(1) estimates so choosing costs nothing. The seek is
    // sound here for the reason it is sound there: a hint lifted from an AND-chain is a
    // NECESSARY condition, so the set is a SUPERSET of the matches and `preds` re-validates
    // every candidate below.
    //
    // `seedVertices` is not used despite doing the same choosing, because it hides WHETHER
    // it seeded — and the label check below is needed only when it did. Applying that check
    // unconditionally would tax the unindexed path, which is the common one.
    let seeded: ReadonlySet<Vertex> | undefined;

    // REJECTED lever — guarding this with a "does the graph have ANY index?" check, so an
    // unindexed graph skips the enumeration entirely. It needed a new `PropertyIndex`
    // accessor (`isIndexed` needs a key and `indexedKeys()` allocates) and bought NOTHING:
    // the unindexed floor was 0.868/0.872/0.943ms without it and 0.930/0.928/0.934 with it.
    // So the ~26% this path gives up is closure layout, not the enumeration — this file has
    // measured that before (items 119 and 141) — and the public API was not worth adding for
    // a reason that turned out to be wrong.
    if (cstart !== undefined) {
      let best: SeedCandidate | undefined;

      for (const candidate of indexCandidates(graph, cstart, { binding, params, graph })) {
        if (best === undefined || candidate.count < best.count) {
          best = candidate;
        }
      }

      // The general path always prefers a seek when one is offered; this additionally
      // declines a seek WIDER than the bucket, which can happen when the indexed key is
      // common outside this label. Both are correct — only the cost differs.
      if (best !== undefined && best.count < bucket) {
        seeded = best.build();
      }
    }

    const vertices: Iterable<Vertex> =
      seeded ??
      (name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []));
    let n = 0;

    for (const v of vertices) {
      // A seek returns vertices by VALUE, not by label, so the label has to be applied here.
      // The bucket path inherits it from the seed and must not pay for it again.
      if (seeded !== undefined && !matchesLabel(v, label)) {
        continue;
      }

      let ok = true;

      for (const ip of preds) {
        if (!inlineHolds(ip, v, binding, params, graph)) {
          ok = false;
          break;
        }
      }

      if (ok) {
        n += 1;
      }
    }

    return rowOf(n);
  };
};

/** 1-hop `(a)-[:T]->(b)` count: bucket sizes (unlabeled) or a filtered bucket
 * scan. `null` if the segment can't be bucket-counted (both/And/Not/wildcard). */
/**
 * An endpoint's INLINE constraint, carried into the tally.
 *
 * `MATCH (a:P)-[:E]->(b {k: 2}) RETURN count(*)` is the same question as the
 * clause-`WHERE` spelling and cost 4x more, because `plainNode` rejected the node
 * and the whole shortcut declined (audit item 124). The predicate is the COMPILED
 * one and it is applied through `satisfies` — the general path's own
 * implementation of inline-pattern semantics (`structuralEq`, and a NULL on an
 * absent key dropping the row) — so the two spellings agree by construction
 * rather than because the equivalence was re-derived here.
 *
 * `bindVar` is the node's own variable, bound before `satisfies` runs so an inline
 * `(b WHERE b.k = 2)` can see itself.
 */
type InlinePred = { pred: CPredicate; bindVar?: string };

/** A composed per-element filter: every carried `InlinePred` must hold. */
type InlineGate = (
  element: Vertex,
  binding: Map<string, unknown>,
  params: Params,
  graph: Graph,
) => boolean;

/**
 * The node's inline constraint as an `InlinePred`, or `null` if it must not be
 * carried.
 *
 * Only CLOSED constraints are accepted — every inline property VALUE must have no
 * free variables, and an inline `WHERE` may read nothing but the node's own
 * variable. `(b {k: 2})` and `(b {k: $p})` qualify; `(b {k: a.k})` does not,
 * because the tally would have to bind `a` per edge and that is the correlation
 * problem of items 121-123, not this one. `undefined` means the node is plain and
 * there is nothing to carry.
 */
const inlineOf = (n: NodePattern): InlinePred | null | undefined => {
  if (plainNode(n)) {
    return undefined;
  }

  for (const c of n.properties ?? []) {
    if (freePredicateVars(c.value).size > 0) {
      return null;
    }
  }

  if (n.where !== undefined) {
    // An inline `WHERE` is evaluated with the node bound to its own variable, so
    // it needs one, and it may read nothing else.
    if (n.variable === undefined) {
      return null;
    }

    for (const name of freePredicateVars(n.where)) {
      if (name !== n.variable) {
        return null;
      }
    }
  }

  return {
    pred: compilePredicate(n.properties, n.where),
    ...(n.variable !== undefined ? { bindVar: n.variable } : {}),
  };
};

/** A clause `WHERE` the 1-hop count can evaluate per edge, with the vars it reads. */
type HopPred = {
  fn: CompiledExpr;
  startVar?: string;
  farVar?: string;
  relVar?: string;
};

/** Everything a filtered 1-hop walk needs, resolved for one call: the graph and
 * params, the predicate, the endpoint labels AFTER the vacuous-label elision, the
 * direction, and the edge types (`undefined` = every type). Built once per query,
 * never per edge; the walks destructure it into locals up front. */
type HopScan = {
  graph: Graph;
  params: Params;
  pred: HopPred;
  pa: LabelExpr | undefined;
  pb: LabelExpr | undefined;
  out: boolean;
  types: string[] | undefined;
  /** Inline endpoint constraints, applied via `satisfies`. See `InlinePred`. */
  inNear?: InlinePred;
  inFar?: InlinePred;
};

/** Apply an endpoint's inline constraint, binding the node's own variable first. */
const inlineHolds = (
  ip: InlinePred | undefined,
  element: Vertex,
  binding: Map<string, unknown>,
  params: Params,
  graph: Graph,
): boolean => {
  if (ip === undefined) {
    return true;
  }

  if (ip.bindVar !== undefined) {
    binding.set(ip.bindVar, element);
  }

  return satisfies(element, ip.pred, binding, params, graph);
};

/**
 * A start-only filtered 1-hop count: evaluate the predicate once per VERTEX and
 * add that vertex's degree, instead of once per edge.
 *
 * `(a)-[:T]->(x) WHERE <reads only a>` does not need an edge to decide anything
 * — it needs a vertex and then that vertex's degree. Walking the adjacency index
 * rather than the edge bucket makes this O(V) predicate evaluations instead of
 * O(E), so the win scales with the edge:node ratio rather than being a constant
 * factor (CLAUDE.md's "match the fixture to the claim").
 *
 * THE DIVERGENCE THIS IS GUARDED AGAINST. The index's keys are exactly the
 * vertices carrying at least one edge, and `deg === 0` is checked before the
 * predicate. Both are load-bearing, not incidental: `asTruth` THROWS on a
 * non-boolean, so evaluating the predicate for a vertex the per-edge walk would
 * never have visited would RAISE where the general path returns 0 — a
 * byte-identity break, not just a different number.
 */
// REJECTED levers — reordering or reseeding this walk. Both are recorded with their numbers
// because the first one LOOKS like the biggest win available anywhere in the TS engine, and
// re-deriving that it is forbidden is the expensive path (audit item 139).
//
// This walk is the per-vertex route for `(a:L)-[:T]->(x) WHERE <pred on a>`, the widest
// TS/native ratio in the cross-engine bench (459x). Decomposed on 200,000 vertices /
// 1,000,000 edges, with a predicate matching NOTHING:
//
//     bare node scan, same predicate     248ns a vertex   (the property-bag read, structural)
//     this walk                          560ns a vertex
//     this walk, ALL survivors           602ns a vertex
//
// So ~248ns is the structural property read and ~312ns is adjacency plumbing — and since
// making every vertex a survivor adds only 42ns, the degree accumulation is not the cost.
//
// 1. TEST THE PREDICATE FIRST, seeding from the label bucket so a non-survivor costs one
//    property read and no adjacency work. 111.94 -> 35.54ms, a 3.1x win — and ILLEGAL. A
//    vertex with no matching edge contributes no rows, so the general path never evaluates
//    the predicate on it; evaluating it anyway RAISES where the general path returns a count,
//    and WHICH queries raise is part of the cross-engine invariant. Caught immediately by the
//    two tests item 129 left for exactly this (`a start-only predicate never evaluates a
//    vertex with no matching edge`, `a vertex whose only edges are of another type never
//    reaches the predicate`), which failed with a data exception.
//
// 2. KEEP THE ORDER but seed from the label bucket anyway — `Vertex` objects, so no
//    `getVertexById` and no `Map`-entry destructuring. Legal (all 36 tests pass) and 1.18x on
//    the 0-survivor row, 1.30x when all survive. REJECTED on the adversarial fixture: the
//    adjacency index holds only vertices WITH edges, so where most labelled vertices have
//    none, a label-bucket seed iterates far more entries. At 200,000 `Person` with only
//    10,000 carrying a KNOWS edge it is **3.5x SLOWER** (5.38 vs 1.54ms) — a bigger loss than
//    the dense gain. A size-guarded version (seed from whichever collection is smaller) would
//    be strictly better-or-equal, but it buys ~1.2x on a row whose remaining cost is the
//    structural property read, at the price of a second duplicated walk and a cost heuristic;
//    not taken, and recorded here so it can be picked up deliberately rather than rediscovered.
//
// The conclusion for this row: the plumbing cannot be reordered away without breaking raise
// parity, so what is left is the property-bag read — structural, like the filtered scan of
// item 132.
const startOnlyHopCount = (scan: HopScan, startVar: string | undefined): number => {
  const { graph, params, pred, pa, out, types, inNear } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  const index = out ? graph.edgesFromByLabel : graph.edgesToByLabel;
  let n = 0;

  for (const [vid, byType] of index) {
    let deg = 0;

    if (types === undefined) {
      // Every type. Sound only because the caller reaches this with no type list
      // only when `multiTypeEdgeCount === 0`, so no edge sits in two of the
      // buckets being summed.
      for (const set of byType.values()) {
        deg += set.size;
      }
    } else {
      for (const t of types) {
        deg += byType.get(t)?.size ?? 0;
      }
    }

    if (deg === 0) {
      continue;
    }

    const v = graph.getVertexById(vid);

    if (v == null || !matchesLabel(v, pa)) {
      continue;
    }

    if (inNear !== undefined && !inlineHolds(inNear, v, binding, params, graph)) {
      continue;
    }

    if (startVar !== undefined) {
      binding.set(startVar, v);
    }

    if (asTruth(pred.fn(env)) === true) {
      n += deg;
    }
  }

  return n;
};

/**
 * The general filtered 1-hop tally: walk the edge bucket and count, rather than
 * build a binding and a row per edge and count those. The row pipeline costs
 * ~487ns a row before it does any work (item 98), and a filtered count throws
 * every row away.
 *
 * ONE binding `Map`, mutated per edge — building a fresh one per edge is most of
 * what this exists to avoid. The predicate is applied exactly as the general path
 * applies a match-level `WHERE` (`asTruth(…) === true`, so NULL and false both
 * drop, ISO's three-valued filter), because it IS the same compiled expression.
 *
 * Kept at module scope, like `startOnlyHopCount`, so the closure
 * `buildOneHopCount` returns stays dispatch-only. That is measured, not
 * stylistic: with both walks inline, the closure grew enough that the far-endpoint
 * shape it did not otherwise touch read 1.15x slower in three interleaved rounds.
 */
/**
 * Can the START-side per-vertex walk answer this scan? One rule, asked by BOTH callers —
 * the clause-`WHERE` branch and the inline-only branch — because they had near-duplicate
 * condition sets and drift between two copies of one rule is precisely how the far
 * endpoint ended up on the per-edge tally while the start endpoint had a walk.
 *
 * With the inline-only branch's bare predicate (`startVar`/`farVar`/`relVar` all unset)
 * this reduces to exactly that branch's old condition, since it is reached only when one
 * of the two inline constraints is present.
 *
 * Module scope, not inline in the returned closure: the closure is the hot one, and this
 * file has measured a 1.17x cost on an unrelated shape from growing it (audit item 119).
 * These are asked ONCE per query — unlike the `!== undefined` tests inside the tally,
 * which are inline precisely because they run per EDGE.
 */
const startWalkFits = (scan: HopScan): boolean => {
  const { graph, pred, pb, types, inNear, inFar } = scan;

  return (
    // A clause predicate on the start, an INLINE constraint on it, or both — any of them
    // is decided per VERTEX.
    (pred.startVar !== undefined || inNear !== undefined) &&
    pred.farVar === undefined &&
    pred.relVar === undefined &&
    // The walk never visits the far endpoint, so it cannot apply the far label or a far
    // constraint; and summing out-degree counts edges to ANY target.
    pb === undefined &&
    inFar === undefined &&
    // Summing per-type bucket sizes is sound only when no edge sits in two of them.
    (types?.length === 1 || graph.multiTypeEdgeCount === 0)
  );
};

/** The FAR mirror of {@link startWalkFits}, on mirrored conditions. */
const farWalkFits = (scan: HopScan): boolean => {
  const { graph, pred, pa, types, inNear, inFar } = scan;

  return (
    (pred.farVar !== undefined || inFar !== undefined) &&
    pred.startVar === undefined &&
    pred.relVar === undefined &&
    // An IN-degree counts edges from ANY source, so the start side must be unconstrained
    // where the twin requires the far side to be.
    pa === undefined &&
    inNear === undefined &&
    (types?.length === 1 || graph.multiTypeEdgeCount === 0)
  );
};

/**
 * The FAR mirror of {@link startOnlyHopCount}: when the predicate reads only the hop's
 * far endpoint, it is decided once per FAR VERTEX rather than once per edge, and each
 * survivor contributes its whole matching IN-degree.
 *
 * `Σ over edges [pred(far)]` and `Σ over far vertices satisfying pred (in-degree)` count
 * the same edges, so this is the same question asked from the other end — O(V + survivor
 * degree) instead of O(E), and it reads the far property ONCE per vertex instead of once
 * per in-edge.
 *
 * This was the single widest gap in the cross-engine bench: `traverse 1-hop + filter`
 * (`MATCH (a:Person)-[:KNOWS]->(x) WHERE x.age > 500 RETURN count(*)`) cost ts 571.7ms
 * against native's 1.5ms, a 378x ratio, while the START-filtered spelling of the same
 * shape cost 106.4ms — because item 129 gave THAT side this walk and left this one on the
 * per-edge tally.
 *
 * Deliberately a separate module-scope function rather than a parameter on
 * `startOnlyHopCount`: that walk is hot and proven, and this file has already measured a
 * 1.17x cost on an UNRELATED shape from growing one hot closure (see the rejected lever
 * in `Vertex.labels` and audit item 119). The twin is left byte-identical and acts as a
 * control for this change.
 *
 * The caller guarantees what this cannot see: the START side is unconstrained (`pa`
 * vacuous and no `inNear`), because an in-degree counts edges from ANY source; and no
 * edge sits in two of the summed type buckets.
 */
const farOnlyHopCount = (scan: HopScan, farVar: string | undefined): number => {
  const { graph, params, pred, pb, out, types, inFar } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  // The far endpoint of an `out` hop is the edge's TARGET, so its edges are the ones the
  // reverse index holds — the mirror of the twin's choice.
  const index = out ? graph.edgesToByLabel : graph.edgesFromByLabel;
  let n = 0;

  for (const [vid, byType] of index) {
    let deg = 0;

    if (types === undefined) {
      // Every type. Sound only because the caller reaches this with no type list
      // only when `multiTypeEdgeCount === 0`, so no edge sits in two of the
      // buckets being summed.
      for (const set of byType.values()) {
        deg += set.size;
      }
    } else {
      for (const t of types) {
        deg += byType.get(t)?.size ?? 0;
      }
    }

    if (deg === 0) {
      continue;
    }

    const v = graph.getVertexById(vid);

    // `pb`, not `pa`: this walk visits the FAR endpoints, so the label it can apply is
    // the far one. The start label has to be vacuous for the caller to route here.
    if (v == null || !matchesLabel(v, pb)) {
      continue;
    }

    if (inFar !== undefined && !inlineHolds(inFar, v, binding, params, graph)) {
      continue;
    }

    if (farVar !== undefined) {
      binding.set(farVar, v);
    }

    if (asTruth(pred.fn(env)) === true) {
      n += deg;
    }
  }

  return n;
};

const tallyHopCount = (scan: HopScan): number => {
  const { graph, params, pred, pa, pb, out, types, inNear, inFar } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  let n = 0;

  for (const edge of edgesOfTypes(graph.edgesByLabel, types)) {
    const near = out ? edge.from : edge.to;
    const far = out ? edge.to : edge.from;

    if (!matchesLabel(near, pa) || !matchesLabel(far, pb)) {
      continue;
    }

    // The `!== undefined` tests are inline on purpose: a call per edge to a helper
    // that immediately returns true cost the un-constrained tally ~10% (120,000
    // calls over this fixture) and is what the control rows caught.
    if (inNear !== undefined && !inlineHolds(inNear, near, binding, params, graph)) {
      continue;
    }

    if (inFar !== undefined && !inlineHolds(inFar, far, binding, params, graph)) {
      continue;
    }

    if (pred.startVar !== undefined) {
      binding.set(pred.startVar, near);
    }

    if (pred.farVar !== undefined) {
      binding.set(pred.farVar, far);
    }

    if (pred.relVar !== undefined) {
      binding.set(pred.relVar, edge);
    }

    if (asTruth(pred.fn(env)) === true) {
      n += 1;
    }
  }

  return n;
};

const buildOneHopCount = <T>(
  seg: Segment,
  start: NodePattern,
  rowOf: (n: number) => T,
  pred?: HopPred,
  inNear?: InlinePred,
  inFar?: InlinePred,
): CountOf<T> | null => {
  const { rel, node } = seg;

  // `plainNode(node)` is deliberately NOT required: an inline endpoint constraint
  // is carried in `inFar` instead of declining the shortcut (item 124). The caller
  // only supplies it after checking the constraint is CLOSED, and the rel must
  // still be plain — a rel predicate would need its own treatment.
  if (!plainRel(rel) || rel.direction === 'both') {
    return null;
  }

  // An inline constraint that reached here but was not compiled into `inFar` would
  // be silently IGNORED, which is a wrong answer rather than a slow one. This is
  // the invariant the caller is trusted to uphold, asserted where it is cheap.
  if (!plainNode(node) && inFar === undefined) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  const aLabel = start.label;
  const bLabel = node.label;
  const out = rel.direction === 'out';

  return (graph, params) => {
    // A clause `WHERE` on the endpoints: walk the edge bucket and tally, rather than build a
    // binding and a row per edge and count those. The row pipeline costs ~487ns a row before it
    // does any work (see the audit's item 98), and a filtered count throws every row away.
    //
    // ONE binding `Map`, mutated per edge. Building a fresh one per edge is most of what this
    // path exists to avoid. The predicate is applied exactly as the general path applies a
    // match-level `WHERE` — `asTruth(...) === true`, so NULL and false both drop (ISO's
    // three-valued filter) — because it IS the same compiled expression.
    if (pred) {
      // `types` is `undefined` for an untyped relationship (`-[]->`), meaning EVERY
      // type — which is exactly what `edgesOfTypes` already takes `undefined` to
      // mean. This used to `return rowOf(0)` to satisfy the narrowing, so
      // `MATCH (a:Person)-[]->(b) WHERE <anything> RETURN count(*)` answered 0
      // whatever the graph held, while the unfiltered spelling of the same query
      // answered correctly. A wrong answer, shipped and then caught by the
      // start-only differential; see item 114.
      //
      // The same elision the unfiltered path gets (see `vacuousLabel`): a label every vertex
      // carries costs 88ns an edge to re-confirm, and the general path never pays it at all
      // because it SEEDS from the label bucket.
      const pa = vacuousLabel(graph, aLabel) ? undefined : aLabel;
      const pb = vacuousLabel(graph, bLabel) ? undefined : bLabel;
      const { startVar } = pred;
      const scan: HopScan = { graph, params, pred, pa, pb, out, types, inNear, inFar };

      // Item 125 carried only `inFar` because it measured routing a start constraint to
      // the TALLY (a full edge scan) and rightly rejected that; the per-vertex path is the
      // route that suits it (item 129), and its far mirror is item 137.
      if (startWalkFits(scan)) {
        return rowOf(startOnlyHopCount(scan, startVar));
      }

      if (farWalkFits(scan)) {
        return rowOf(farOnlyHopCount(scan, pred.farVar));
      }

      return rowOf(tallyHopCount(scan));
    }

    // An inline endpoint constraint with NO clause `WHERE` still has to be applied,
    // and neither the O(1) bucket-size path nor the label-only walk below can see
    // it — so route those to the tally, which does. Letting the bucket path answer
    // `(b {k: 2})` would return every edge's count.
    if (inNear !== undefined || inFar !== undefined) {
      const pa = vacuousLabel(graph, aLabel) ? undefined : aLabel;
      const pb = vacuousLabel(graph, bLabel) ? undefined : bLabel;
      const bare: HopPred = { fn: () => true };
      const scan: HopScan = { graph, params, pred: bare, pa, pb, out, types, inNear, inFar };

      // The SAME two rules as the clause-`WHERE` branch. A start-only constraint is
      // decided per VERTEX — degree then costs nothing, because the walk reads bucket
      // SIZES rather than edges. Measured at 20,000 vertices (item 129): the equivalent
      // clause-`WHERE` spelling, which already took this route, is 2.62ms at degree 9
      // where the declining inline spelling is 10.82 and the tally would be worse still.
      //
      // The far mirror matters for the same reason in reverse: without it the inline
      // spelling `(b {k: 2})` would keep the per-edge tally while the clause spelling
      // `WHERE b.k = 2` took the walk — one question costing two different amounts, which
      // is the gap items 124-125 were about.
      if (startWalkFits(scan)) {
        return rowOf(startOnlyHopCount(scan, undefined));
      }

      if (farWalkFits(scan)) {
        return rowOf(farOnlyHopCount(scan, undefined));
      }

      return rowOf(tallyHopCount(scan));
    }

    // A label every vertex carries constrains nothing, so drop it and let the O(1) path
    // below take the query. See `vacuousLabel`.
    const a = vacuousLabel(graph, aLabel) ? undefined : aLabel;
    const b = vacuousLabel(graph, bLabel) ? undefined : bLabel;

    // Unlabeled endpoints → the bucket sizes. O(1) per type.
    //
    // Summing across types is only sound when no edge is in two of the buckets,
    // which `multiTypeEdgeCount` rules out for the whole graph; one type can
    // never collide with itself. Otherwise fall through to the deduping walk —
    // a two-type edge is still ONE edge.
    if (
      a === undefined &&
      b === undefined &&
      types &&
      (types.length === 1 || graph.multiTypeEdgeCount === 0)
    ) {
      return rowOf(types.reduce((n, t) => n + (graph.edgesByLabel.get(t)?.size ?? 0), 0));
    }

    return rowOf(
      countEdges(
        edgesOfTypes(graph.edgesByLabel, types),
        (edge) =>
          matchesLabel(out ? edge.from : edge.to, a) && matchesLabel(out ? edge.to : edge.from, b),
      ),
    );
  };
};

/** Edges out of / into `bId` (of `types`) whose far endpoint matches `far`. The
 * two-hop degree product's per-`b` side count; hoisted to module scope since it
 * closes over nothing but the shared bucket primitives. */
const side = (
  graph: Graph,
  bId: string,
  out: boolean,
  types: string[] | undefined,
  far: LabelExpr | undefined,
): number => {
  const byType = (out ? graph.edgesFromByLabel : graph.edgesToByLabel).get(bId);

  return countEdges(edgesOfTypes(byType, types), (edge) =>
    matchesLabel(out ? edge.to : edge.from, far),
  );
};

/** 2-hop `(a)-[:T1]->(b)-[:T2]->(c)` count via the degree product
 * `Σ_b (edges reaching a valid a) × (edges reaching a valid c)`. `null` unless
 * both rels are anonymous + directed and the node variables are distinct. */
const buildTwoHopCount = <T>(
  s1: Segment,
  s2: Segment,
  start: NodePattern,
  rowOf: (n: number) => T,
): CountOf<T> | null => {
  if (
    !plainRel(s1.rel) ||
    !plainRel(s2.rel) ||
    s1.rel.variable !== undefined ||
    s2.rel.variable !== undefined ||
    s1.rel.direction === 'both' ||
    s2.rel.direction === 'both' ||
    !plainNode(s1.node) ||
    !plainNode(s2.node)
  ) {
    return null;
  }

  const vars = [start.variable, s1.node.variable, s2.node.variable].filter(
    (v): v is string => v !== undefined,
  );

  if (new Set(vars).size !== vars.length) {
    return null; // a shared node variable is a self-join the product can't express
  }

  const t1 = relTypeNames(s1.rel.label);
  const t2 = relTypeNames(s2.rel.label);

  if (t1 === null || t2 === null) {
    return null;
  }

  const aLabel = start.label;
  const midLabel = s1.node.label;
  const cLabel = s2.node.label;
  // seg1 reaches `a` from b's reverse side; seg2 reaches `c` from b's forward side.
  const toAOut = s1.rel.direction === 'in';
  const fromCOut = s2.rel.direction === 'out';

  return (graph) => {
    const mids =
      midLabel?.kind === 'label'
        ? (graph.verticesByLabel.get(midLabel.name) ?? new Set<Vertex>())
        : graph.verticesById.values();
    let count = 0;

    for (const b of mids) {
      if (!matchesLabel(b, midLabel)) {
        continue;
      }

      const ways = side(graph, b.id, toAOut, t1, aLabel);

      if (ways === 0) {
        continue;
      }

      count += ways * side(graph, b.id, fromCOut, t2, cLabel);
    }

    return rowOf(count);
  };
};

/**
 * The count for ONE pattern, shared by the single-pattern shortcut and by
 * `detectProductCount`. Generic in `rowOf` so the first wraps into a `Row` and the
 * second takes the raw number to multiply.
 *
 * `where` is the clause `WHERE`, which only the 1-hop tally can answer; the product
 * caller passes `undefined` because it refuses a clause `WHERE` outright.
 */
const patternCountOf = <T>(
  pattern: PathPattern,
  where: Expr | undefined,
  rowOf: (n: number) => T,
  cstart?: CNode,
): CountOf<T> | null => {
  const { start, segments } = pattern;

  // The START node's inline constraint is carried for the ONE-HOP shape, where it
  // routes to the per-VERTEX walk (item 129). The node-count and two-hop shapes
  // keep declining as before: relaxing those would mean teaching the bucket-size
  // path and the degree product to apply a predicate, and a shortcut that
  // half-applies one is a wrong answer.
  //
  // Item 125 carried only `inFar`, on the measured grounds that routing a start
  // constraint to the TALLY was slower than declining (5.2 -> 6.2ms). That stands
  // for the tally; the per-vertex path is the right route and beats both.
  let inStart: InlinePred | null | undefined;

  if (segments.length <= 1) {
    // The NODE-ONLY shape joined this in item 135: `buildNodeCount` can now tally a
    // constrained bucket, which both answers `MATCH (a:P {k: 1}) RETURN count(*)`
    // (previously 10.5ms against native's 0.04ms) and lets `productCountOf` use a
    // constrained pattern as a factor.
    inStart = inlineOf(start);
  } else if (!plainNode(start)) {
    // The two-hop degree product has no route that applies a predicate.
    return null;
  }

  if (inStart === null) {
    return null;
  }

  if (segments.length === 0) {
    // A clause `WHERE` over the single node is the SAME question as the inline
    // spelling, and tallying one while declining the other would create exactly the
    // equivalent-spelling gap the probe exists to catch. It is carried as a second
    // closed predicate rather than by splicing an `AND` into the AST.
    const preds: InlinePred[] = [];

    if (inStart !== undefined) {
      preds.push(inStart);
    }

    if (where !== undefined) {
      if (start.variable === undefined) {
        return null;
      }

      for (const nameRead of freePredicateVars(where)) {
        if (nameRead !== start.variable) {
          return null;
        }
      }

      preds.push({ pred: compilePredicate(undefined, where), bindVar: start.variable });
    }

    return buildNodeCount(start, rowOf, preds, cstart);
  }

  // A clause `WHERE` is answerable ONLY by the 1-hop tally below, and only when it reads
  // nothing but the pattern's own variables — an outer variable cannot exist here (this shape
  // is exactly two clauses) but an aggregate or a subquery could, and `freePredicateVars`
  // reports those as free names it does not recognize.
  let pred: HopPred | undefined;

  if (where !== undefined) {
    // The node shape returned above, having folded its clause `WHERE` into the
    // tally; of what is left only the 1-hop tally can answer one.
    if (segments.length !== 1) {
      return null;
    }

    const [seg] = segments;
    const vars = new Map<string, 'start' | 'far' | 'rel'>();

    if (start.variable !== undefined) {
      vars.set(start.variable, 'start');
    }

    if (seg.node.variable !== undefined) {
      vars.set(seg.node.variable, 'far');
    }

    if (seg.rel.variable !== undefined) {
      vars.set(seg.rel.variable, 'rel');
    }

    const free = freePredicateVars(where);

    for (const name of free) {
      if (!vars.has(name)) {
        return null;
      }
    }

    // A slot is recorded only when the predicate actually READS it. These used to
    // come straight from the pattern, so `MATCH (a:Person)-[r:KNOWS]->(x) WHERE
    // a.age > 50` claimed all three — the tally then bound `x` and `r` a million
    // times for a predicate that never looks at them, and no caller could tell a
    // start-only predicate from one that needs an edge. `buildOneHopCount`'s
    // per-vertex path depends on being able to tell.
    //
    // Sound because `freePredicateVars` does not under-report, which the
    // exhaustiveness guard in it now enforces at compile time.
    const reads = (v: string | undefined): string | undefined =>
      v !== undefined && free.has(v) ? v : undefined;

    pred = {
      fn: compileExpr(where),
      startVar: reads(start.variable),
      farVar: reads(seg.node.variable),
      relVar: reads(seg.rel.variable),
    };
  }

  if (segments.length === 1) {
    const [seg] = segments;

    const inFar = inlineOf(seg.node);

    if (inFar === null) {
      return null;
    }

    return buildOneHopCount(seg, start, rowOf, pred, inStart, inFar);
  }

  if (segments.length === 2) {
    const [s1, s2] = segments;

    return buildTwoHopCount(s1, s2, start, rowOf);
  }

  return null;
};

/**
 * Every name a pattern BINDS. Used only to prove two patterns are independent, so it
 * over-collects deliberately: a name this misses would be a wrong answer, while a
 * name it reports that the pattern does not really bind only makes `productCountOf`
 * decline. `hopFrom`/`hopTo` and the multi-element repetition hops belong to
 * var-length units that `patternCountOf` already refuses, and are collected anyway.
 */
const patternVarsOf = (pattern: PathPattern): string[] => {
  const out: string[] = [];
  const add = (v: string | undefined): void => {
    if (v !== undefined) {
      out.push(v);
    }
  };

  const walk = (seg: Segment): void => {
    add(seg.rel.variable);
    add(seg.node.variable);
    add(seg.hopFrom?.variable);
    add(seg.hopTo?.variable);

    // `unitRest` and `nested` are themselves segments (a multi-element or nested
    // repetition unit), so the inner variables need the same walk.
    for (const inner of seg.unitRest ?? []) {
      walk(inner);
    }

    if (seg.nested !== undefined) {
      walk(seg.nested);
    }
  };

  add(pattern.pathVar);
  add(pattern.start.variable);
  pattern.segments.forEach(walk);

  return out;
};

/**
 * `MATCH (a:P {k: 1}), (b:P {k: 2}) RETURN count(*)` — the product of the patterns'
 * own counts, because independent patterns form a cartesian product and
 * `count(*)` of a product is the product of the counts.
 *
 * This was the single widest row in the TS spelling probe (45-54ms where every
 * other group was under 12ms) and it is the shape `detectCountShortcut` rejected
 * outright, via `patterns.length !== 1`. It is also QUADRATIC: on a 20,000-vertex
 * fixture with |k=1| = 5,000 and |k=2| = 2,143 the answer is 10,715,000 rows, which
 * TS enumerated in 2,808ms and NATIVE enumerated in 77ms — a missing path in both
 * engines, not a TS-only gap. At the cross-engine bench's 200,000 vertices the same
 * query is over a BILLION rows.
 *
 * **Both spellings are handled together, deliberately.** `(a), (b)` in one `MATCH`
 * and `MATCH (a) MATCH (b)` ask the identical question, measured at 2,808ms and
 * 2,473ms; teaching one and not the other would manufacture exactly the
 * equivalent-spelling asymmetry this repo treats as a bug class.
 *
 * ### Why the product is sound here, checked rather than assumed
 *
 * The risk was a cross-pattern uniqueness rule: if a multi-pattern `MATCH` required
 * DIFFERENT EDGES across its patterns, two edge patterns would be |E|^2 - |E| and a
 * product would silently overcount. Measured on a 6-vertex / 4-edge fixture, with
 * both engines agreeing on every case:
 *
 *     MATCH (a:P), (b:P)                      36 = 6^2   (so no vertex uniqueness)
 *     MATCH (a:P), (b:P), (c:P)              216 = 6^3
 *     MATCH (a:P) MATCH (b:P)                 36 = 6^2
 *     MATCH ()-[:E]->(), ()-[:E]->()          16 = 4^2   (so no edge uniqueness)
 *     MATCH ()-[r:E]->(), ()-[s:E]->()        16 = 4^2   (named edges too)
 *     MATCH ()-[:E]->(), (b:P)                24 = 4*6
 *
 * So the product matches what both engines already return, which is the oracle that
 * matters — not an argument from what the shape ought to mean.
 *
 * ### Three refusals
 *
 * - **A shared variable is a JOIN, not a product.** `MATCH (a:P), (a:Q)` and
 *   `MATCH (a:P) MATCH (a:P)` constrain one binding, so their count is not a
 *   product. Disjointness is checked over `patternVarsOf`, which over-collects.
 * - **A clause `WHERE` can CORRELATE the patterns.**
 *   `MATCH (a:P {k: 1}), (b:P) WHERE b.k = a.k` is not a product (measured: 39,640ms
 *   TS / 681ms native, and its answer is not |A| x |B|). A `WHERE` reading only one
 *   pattern would still be a product, but that needs the predicate attributed to a
 *   pattern, so every `WHERE` declines for now.
 * - **Every pattern must have its own shortcut.** `patternCountOf` returning `null`
 *   for any one of them declines the whole product rather than enumerating part of
 *   it.
 */
const productCountOf = <T>(
  matches: readonly Extract<Clause, { kind: 'match' }>[],
  rowOf: (n: number) => T,
): CountOf<T> | null => {
  const counts: CountOf<number>[] = [];
  const bound = new Set<string>();

  for (const match of matches) {
    if (match.where !== undefined) {
      return null;
    }

    for (const pattern of match.patterns) {
      for (const name of patternVarsOf(pattern)) {
        if (bound.has(name)) {
          return null;
        }

        bound.add(name);
      }

      const one = patternCountOf(pattern, undefined, identityCount);

      if (one === null) {
        return null;
      }

      counts.push(one);
    }
  }

  if (counts.length < 2) {
    return null;
  }

  return (graph, params) => {
    let n = 1;

    for (const count of counts) {
      // A zero factor makes the product zero, and the remaining factors cannot
      // change that — so an empty label bucket costs one lookup, not all of them.
      n *= count(graph, params);

      if (n === 0) {
        return rowOf(0);
      }
    }

    return rowOf(n);
  };
};

/** `rowOf` for the product path, which wants the number itself. */
const identityCount = (n: number): number => n;

/**
 * If a linear query is exactly `MATCH <1- or 2-segment path> RETURN count(*)`,
 * return a closure computing the count directly (O(1)/O(E)) instead of
 * enumerating every match; `null` if the shape doesn't qualify. The conditions
 * match the native engine: 1-hop directed, no props/WHERE; 2-hop additionally
 * needs anonymous rels and pairwise-distinct node variables (so the homomorphic
 * degree product is exact).
 */
export const detectCountShortcut = (
  clauses: readonly Clause[],
  compiled?: readonly CClause[],
): CountFn | null => {
  if (clauses.length < 2) {
    return null;
  }

  // The last clause is the `RETURN`; everything before it must be a `MATCH`. This
  // used to demand EXACTLY two clauses, which is why the two-clause spelling of a
  // cartesian count (`MATCH (a:P {k: 1}) MATCH (b:P {k: 2})`) declined — see
  // `productCountOf`. A `LET` anywhere still declines here, as it must: the
  // shortcut answers the whole query, and a `LET` can rebind what `RETURN` reads.
  const ret = clauses[clauses.length - 1];

  if (ret.kind !== 'return') {
    return null;
  }

  const matches: Extract<Clause, { kind: 'match' }>[] = [];

  for (let i = 0; i < clauses.length - 1; i++) {
    const c = clauses[i];

    if (c.kind !== 'match' || c.optional) {
      return null;
    }

    matches.push(c);
  }

  const [m] = matches;

  const proj = ret.projection;

  // `groupBy` and `having` were MISSING here, and both are silent wrong answers rather than
  // slow paths — a shortcut answers one global count, so a grouped count collapses to a single
  // row and a `HAVING` that should drop the row never runs. Measured against native, which is
  // right in every case:
  //
  //   MATCH (a:Person)-[:KNOWS]->(b) RETURN count(*) AS c GROUP BY a
  //     ts [{"c":4}]   native [[1],[1],[1],[1]]
  //   SELECT count(*) AS c FROM MATCH (a:Person)-[:KNOWS]->(b) HAVING count(*) > 100
  //     ts [{"c":4}]   native []
  //
  // The 1-hop and 2-hop shortcuts have shipped with this. The `gql-conformance` HAVING case
  // did not catch it because it asks a BARE NODE pattern, which had no shortcut until
  // `buildNodeCount` and so went through general execution — adding that shortcut is what
  // turned the latent gap into a failing test. A `LET` before the `RETURN` also hid it, by
  // making `clauses.length !== 2` reject the shortcut outright.
  if (
    proj.star ||
    proj.distinct ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    (proj.orderBy?.length ?? 0) > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    proj.items.length !== 1
  ) {
    return null;
  }

  const [item] = proj.items;
  const e = item.expr;

  if (e.kind !== 'func' || e.name !== 'count' || !e.star || e.distinct) {
    return null;
  }

  const column = item.alias ?? columnName(e);
  const rowOf = (count: number): Row => ({ [column]: count });

  // ONE pattern in ONE `MATCH` keeps the original path, which is the only one that
  // can answer a clause `WHERE` (through the 1-hop tally).
  if (matches.length === 1 && m.patterns.length === 1) {
    // The COMPILED start node carries the seed hints lifted from the `WHERE`, which is what
    // lets the node tally seek an index instead of scanning the label bucket. Optional so a
    // caller without the compiled clauses still gets the (bucket-scanning) shortcut.
    const cm = compiled?.[0];
    const cstart = cm?.kind === 'match' ? cm.patterns[0]?.start : undefined;

    return patternCountOf(m.patterns[0], m.where, rowOf, cstart);
  }

  return productCountOf(matches, rowOf);
};

/**
 * `MATCH (n[:L]) RETURN n.<key> AS k, count(*) AS c` — a grouped count, tallied straight off
 * the label bucket. Returns MANY rows, so it is its own hook rather than a `CountFn`.
 *
 * The widest remaining row in the cross-engine bench after the plain counts were fixed: ts
 * 144.9ms against native's 1.1ms. Native has `try_group_count`/`try_node_grouped_count`; TS
 * had nothing, so a grouped count went through the general pipeline — and that pipeline costs
 * ~487ns a row before it does any work (`MATCH (n:Person) RETURN 1` over 200,000 nodes is
 * 97ms, and a CPU profile puts 37% of it in `generatorResume`). Tallying avoids all of it: no
 * bindings, no rows, no generator layers.
 *
 * EVERY SEMANTIC HERE IS THE GENERAL PATH'S, not a re-derivation:
 *   - the property read is `propOf`, the same function the compiled `prop` expression calls,
 *     so a MISSING property and a STORED NULL both read as `null` and land in ONE group;
 *   - the group key is `valueKey`, so `-0`/`0` share a group and `NaN` groups with itself;
 *   - groups come out in FIRST-SEEN order, which a `Map`'s insertion order gives and which
 *     the general path gets from its own `Map<string, Binding[]>`;
 *   - the key column shows the FIRST row's raw value, as the general path projects it from the
 *     group's representative binding;
 *   - the two columns are emitted in the projection's item order, so
 *     `RETURN count(*) AS c, n.k AS a` keeps `c` first.
 */
/** Is `e` exactly `count(*)` — no argument, no DISTINCT? */
const isStarCount = (e: Expr): boolean =>
  e.kind === 'func' && e.name === 'count' && e.star && !e.distinct;

/** The `MATCH`, optional single `LET`, and `RETURN` of a 2- or 3-clause linear query. */
type GroupedShape = {
  match: Extract<Clause, { kind: 'match' }>;
  ret: Extract<Clause, { kind: 'return' }>;
  /** The lone `LET` item, or `undefined` for the two-clause form. */
  let?: { var: string; expr: Expr };
};

const groupedClauses = (clauses: readonly Clause[]): GroupedShape | null => {
  if (clauses.length !== 2 && clauses.length !== 3) {
    return null;
  }

  const [m, mid, last] = clauses;
  const ret = clauses.length === 2 ? mid : last;

  // A clause `WHERE` used to be refused here. It is now carried into the tally (item 141),
  // because `MATCH (n:L) WHERE <pred on n> RETURN n.k, count(*) GROUP BY n.k` — count by
  // category over the rows matching a filter — is everyday work, and declining it cost
  // 695ns a vertex against the tally's 124.
  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1) {
    return null;
  }

  if (ret.kind !== 'return') {
    return null;
  }

  if (clauses.length === 2) {
    return { match: m, ret };
  }

  if (mid.kind !== 'let' || mid.items.length !== 1) {
    return null;
  }

  return { match: m, ret, let: mid.items[0] };
};

/** The projection shapes this can answer: two items, one of them `count(*)`, nothing else on. */
const groupedProjection = (
  proj: Projection,
  letName: string | undefined,
): { countAt: number } | null => {
  if (
    proj.star ||
    proj.distinct ||
    proj.having !== undefined ||
    (proj.orderBy?.length ?? 0) > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    proj.items.length !== 2
  ) {
    return null;
  }

  // `GROUP BY` is allowed ONLY in the `LET` form, naming the `LET` variable and nothing else.
  if (proj.groupBy !== undefined) {
    const keys = proj.groupBy;

    if (letName === undefined || keys.length !== 1) {
      return null;
    }

    const [k] = keys;

    if (k.kind !== 'var' || k.name !== letName) {
      return null;
    }
  }

  const countAt = proj.items.findIndex((i) => isStarCount(i.expr));

  return countAt === -1 ? null : { countAt };
};

/**
 * `MATCH (n[:L]) RETURN n.<key> AS k, count(*) AS c` — a grouped count, tallied straight off
 * the label bucket. Returns MANY rows, so it is its own hook rather than a `CountFn`.
 *
 * BOTH SPELLINGS, because they are one question and so must cost the same:
 *
 * ```text
 * MATCH (n:P) RETURN n.k AS a, count(*) AS c                     -- implicit grouping
 * MATCH (n:P) LET a = n.k RETURN a, count(*) AS c GROUP BY a     -- the ISO spelling
 * ```
 *
 * Only the second can carry an explicit `GROUP BY`, since `GROUP BY` takes a BOUND NAME and
 * not a `RETURN` alias — so a `LET` is the only way to name the key, and it is the form the
 * cross-engine bench asks. Handling only the two-clause one left that bench row flat at ~168ms
 * and would have made this look worthless.
 *
 * It was the widest remaining row after the plain counts were fixed: ts 144.9ms against
 * native's 1.1ms. Native has `try_group_count`/`try_node_grouped_count`; TS had nothing, so a
 * grouped count went through the general pipeline — which costs ~487ns a row before doing any
 * work (`MATCH (n:Person) RETURN 1` over 200,000 nodes is 97ms, 37% of it in `generatorResume`
 * by CPU profile). Tallying avoids all of it: no bindings, no rows, no generator layers.
 *
 * EVERY SEMANTIC HERE IS THE GENERAL PATH'S, not a re-derivation:
 *   - the property read is `propOf`, the same function the compiled `prop` expression calls,
 *     so a MISSING property and a STORED NULL both read as `null` and land in ONE group;
 *   - the group key is `valueKey`, so `-0`/`0` share a group and `NaN` groups with itself;
 *   - groups come out in FIRST-SEEN order, which a `Map`'s insertion order gives and which the
 *     general path gets from its own `Map<string, Binding[]>`;
 *   - the key column shows the FIRST row's raw value, as the general path projects it from the
 *     group's representative binding;
 *   - the columns are emitted in the projection's item order, so
 *     `RETURN count(*) AS c, n.k AS a` keeps `c` first.
 */
export const detectGroupedNodeCount = (clauses: readonly Clause[]): ReachFn | null => {
  const shape = groupedClauses(clauses);

  if (!shape) {
    return null;
  }

  const letName = shape.let?.var;
  const picked = groupedProjection(shape.ret.projection, letName);

  if (!picked) {
    return null;
  }

  const { items } = shape.ret.projection;
  const { countAt } = picked;
  const [{ start, segments }] = shape.match.patterns;

  if (segments.length !== 0 || start.variable === undefined) {
    return null;
  }

  // The start node's INLINE constraint and the clause `WHERE` are the two spellings of one
  // filter, so both are carried and both go through `inlineHolds` -> `satisfies` — the
  // general path's own implementation — rather than being re-derived here. Exactly the
  // arrangement `buildNodeCount` got in item 135; the grouped tally was left behind.
  const preds: InlinePred[] = [];
  const inStart = inlineOf(start);

  if (inStart === null) {
    return null;
  }

  if (inStart !== undefined) {
    preds.push(inStart);
  }

  const { where } = shape.match;

  if (where !== undefined) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== start.variable) {
        return null;
      }
    }

    preds.push({ pred: compilePredicate(undefined, where), bindVar: start.variable });
  }

  // Fold the (at most two) predicates into ONE gate at compile time, or `undefined` when
  // there is nothing to apply.
  //
  // This is not style. The tally's loop runs once per vertex whether or not a predicate
  // exists, and written as `for (const ip of preds)` it allocated an iterator per vertex
  // over an EMPTY array — which cost the UNFILTERED grouped count, a shape this change was
  // not meant to touch, a consistent 34% (19.72 -> 26.4ms). Its control row caught that. An
  // indexed loop fixed it but `prefer-for-of` then objects, and the rule is right in general
  // and wrong here; composing instead removes the loop altogether, so there is no iterator
  // for the common case and no suppression comment to out-live its reason.
  const gate = preds.reduceRight<InlineGate | undefined>(
    (rest, ip) => (v, binding, params, graph) =>
      inlineHolds(ip, v, binding, params, graph) &&
      (rest === undefined || rest(v, binding, params, graph)),
    undefined,
  );

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const keyItem = items[1 - countAt];
  const keyExpr = keyItem.expr;
  // Two-clause: the item IS the property. Three-clause: the item is the `LET` name and the
  // property lives in the `LET`. Either way the grouped value must be one property of the
  // matched node; anything else falls through to the general path.
  let keySource: Expr | undefined = keyExpr;

  if (shape.let !== undefined) {
    keySource = keyExpr.kind === 'var' && keyExpr.name === letName ? shape.let.expr : undefined;
  }

  if (keySource?.kind !== 'prop' || keySource.variable !== start.variable) {
    return null;
  }

  const { key } = keySource;
  const countCol = items[countAt].alias ?? columnName(items[countAt].expr);
  const keyCol = keyItem.alias ?? columnName(keyExpr);
  const countFirst = countAt === 0;
  const labelName = label?.name;

  return (graph, params) => {
    const vertices: Iterable<Vertex> =
      labelName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(labelName) ?? []);
    const groups = new Map<string, { key: unknown; n: number }>();
    // One binding map, reused: `inlineHolds` overwrites the node's own variable per vertex
    // and nothing else reads it, which is what `preds` being CLOSED buys.
    const binding = new Map<string, unknown>();

    for (const v of vertices) {
      if (gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      const raw = propOf(v, key);
      const gk = valueKey(raw);
      const slot = groups.get(gk);

      if (slot) {
        slot.n += 1;
      } else {
        groups.set(gk, { key: raw, n: 1 });
      }
    }

    return [...groups.values()].map((slot) =>
      countFirst
        ? { [countCol]: slot.n, [keyCol]: slot.key }
        : { [keyCol]: slot.key, [countCol]: slot.n },
    );
  };
};

export type ReachFn = (graph: Graph, params: Params) => Row[];

/**
 * `MATCH (a:L)-[:T]->(b) RETURN <b.k or a.k>, count(*)` — a GROUPED count over a hop, the
 * empty cell in the count matrix.
 *
 * | shape  | plain        | filtered     | grouped          |
 * | ------ | ------------ | ------------ | ---------------- |
 * | node   | O(1) bucket  | item 135     | items 99 + 141   |
 * | 1-hop  | bucket sums  | items 129/137| **this**         |
 *
 * `detectGroupedNodeCount` requires `segments.length === 0`, so every grouped count over a hop
 * fell to the general path: one binding and one row per EDGE, then grouping. Measured on
 * 200,000 vertices / 1,000,000 edges, where the same hop counted globally is 0.1ms:
 *
 *     MATCH (a:Person)-[:KNOWS]->(b) RETURN b.age, count(*)   1065ms   (1065ns an edge)
 *     MATCH (a:Person)-[:KNOWS]->(b) RETURN a.age, count(*)    951ms
 *
 * ### Two walks, because the key's END decides the shape
 *
 * - **Key on the FAR end**: one pass over the type's edge bucket, reading the far property per
 *   edge. O(E), like `tallyHopCount`.
 * - **Key on the START**: one pass over the start vertices, reading the property ONCE and
 *   adding that vertex's whole matching degree to its group. O(V), like `startOnlyHopCount` —
 *   so it reads 200,000 properties where the general path read 1,000,000.
 *
 * ### The filter comes with it, in the same change
 *
 * Items 135, 137 and 141 each had to go back and add the filter to a tally that refused one,
 * at 2.5-6.4x a time. A filter is carried here if it reads ONLY the keyed end — the vertex is
 * already in hand there, so it costs one gate call. A filter on the OTHER end declines.
 *
 * ### The start-key walk checks DEGREE before the filter, deliberately
 *
 * A start vertex with no matching edge contributes no rows, so the general path never
 * evaluates the predicate on it. Evaluating it anyway RAISES where the general path returns
 * groups, and which queries raise is part of the cross-engine invariant — the 3.1x that item
 * 139 had to reject. Hence degree first, gate second.
 */
export const detectGroupedHopCount = (clauses: readonly Clause[]): ReachFn | null => {
  const shape = groupedClauses(clauses);

  if (!shape) {
    return null;
  }

  const letName = shape.let?.var;
  const picked = groupedProjection(shape.ret.projection, letName);

  if (!picked) {
    return null;
  }

  const { items } = shape.ret.projection;
  const { countAt } = picked;
  const [pattern] = shape.match.patterns;

  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const { start } = pattern;
  const [seg] = pattern.segments;
  const { rel, node: far } = seg;

  if (!plainRel(rel) || rel.direction === 'both' || rel.variable !== undefined) {
    return null;
  }

  if (start.variable === undefined || far.variable === undefined) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  // Resolve the group key to a property of one END of the hop.
  const keyItem = items[1 - countAt];
  const keyExpr = keyItem.expr;
  let keySource: Expr | undefined = keyExpr;

  if (shape.let !== undefined) {
    keySource = keyExpr.kind === 'var' && keyExpr.name === letName ? shape.let.expr : undefined;
  }

  if (keySource?.kind !== 'prop') {
    return null;
  }

  const onStart = keySource.variable === start.variable;

  if (!onStart && keySource.variable !== far.variable) {
    return null;
  }

  const keyed = onStart ? start : far;
  const other = onStart ? far : start;

  // The NON-keyed end must be plain: the walks apply nothing to it beyond its label, and the
  // start-key walk cannot apply even that (it adds a whole degree, not per-edge matches).
  if (!plainNode(other) || (onStart && other.label !== undefined)) {
    return null;
  }

  // The keyed end's inline constraint and the clause `WHERE` are the two spellings of one
  // filter; both go through `inlineHolds` -> `satisfies`, as in item 141.
  const inKeyed = inlineOf(keyed);

  if (inKeyed === null) {
    return null;
  }

  const preds: InlinePred[] = [];

  if (inKeyed !== undefined) {
    preds.push(inKeyed);
  }

  const { where } = shape.match;

  if (where !== undefined) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== keyed.variable) {
        return null;
      }
    }

    preds.push({ pred: compilePredicate(undefined, where), bindVar: keyed.variable });
  }

  const gate = preds.reduceRight<InlineGate | undefined>(
    (rest, ip) => (v, binding, params, graph) =>
      inlineHolds(ip, v, binding, params, graph) &&
      (rest === undefined || rest(v, binding, params, graph)),
    undefined,
  );

  // The start-key walk seeds from the label bucket, which `candidateVertices` fills exactly
  // only for a SIMPLE label (see item 138).
  const startLabel = start.label;

  if (onStart && startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const { key } = keySource;
  const countCol = items[countAt].alias ?? columnName(items[countAt].expr);
  const keyCol = keyItem.alias ?? columnName(keyExpr);
  const countFirst = countAt === 0;
  const out = rel.direction === 'out';
  const farLabel = far.label;
  const adjacency: Adjacency = {
    direction: rel.direction,
    ...(rel.label ? { label: rel.label } : {}),
  };

  return (graph, params) => {
    const groups = new Map<string, { key: unknown; n: number }>();
    const binding = new Map<string, unknown>();
    const add = (raw: unknown, by: number): void => {
      const gk = valueKey(raw);
      const slot = groups.get(gk);

      if (slot) {
        slot.n += by;
      } else {
        groups.set(gk, { key: raw, n: by });
      }
    };

    // Summing per-type bucket sizes is sound only when no edge sits in two of them, and that
    // is a RUNTIME property of the graph — so the O(V) degree walk is chosen per call, with
    // the O(E) walk below as the always-correct alternative rather than a decline. (A
    // `ReachFn` returns rows; it has no way to decline once built.)
    // Summing per-type bucket sizes is sound only when no edge sits in two of them, and that
    // is a RUNTIME property of the graph — so the degree walk is chosen per call, with the
    // per-edge walk as the always-correct alternative rather than a decline. (A `ReachFn`
    // returns rows; it has no way to decline once built.)
    const bucketSumSound = types?.length === 1 || graph.multiTypeEdgeCount === 0;
    const index = out ? graph.edgesFromByLabel : graph.edgesToByLabel;
    const farPb = vacuousLabel(graph, farLabel) ? undefined : farLabel;

    // BOTH walks visit start vertices via `candidateVertices` and then that vertex's own
    // bucket — the order the general path uses. Group order is FIRST-SEEN and observable, so
    // it is not enough to count the right edges; they have to be met in the same order. See
    // the rejected far-end degree walk recorded on this function.
    for (const v of candidateVertices(graph, startLabel)) {
      const byType = index.get(v.id);

      if (byType === undefined) {
        continue;
      }

      if (onStart && bucketSumSound && farPb === undefined) {
        let deg = 0;

        if (types === undefined) {
          for (const set of byType.values()) {
            deg += set.size;
          }
        } else {
          for (const t of types) {
            deg += byType.get(t)?.size ?? 0;
          }
        }

        // DEGREE FIRST: a vertex with no matching edge must never reach the filter. See the
        // raise-parity note above.
        if (deg === 0) {
          continue;
        }

        if (gate !== undefined && !gate(v, binding, params, graph)) {
          continue;
        }

        add(propOf(v, key), deg);

        continue;
      }

      // Per EDGE: either the key is on the far end (so each edge's own endpoint must be
      // read), or a bucket sum would double-count a multi-type edge, or a far label has to
      // be applied per edge.
      //
      // `expand` is the GENERAL PATH's own adjacency iterator, used rather than a hand-rolled
      // bucket loop for two reasons it already gets right: it takes a single concrete type
      // straight from its bucket, and for anything else it dedupes a multi-label edge across
      // the per-type buckets with a `Set`. Hand-rolling the bucket loop counted a `T|S` edge
      // TWICE under `-[:T|S]->` — caught by the multi-label test, which the general path
      // answered correctly.
      for (const step of expand(graph, v, adjacency)) {
        const { node } = step;

        if (farPb !== undefined && !matchesLabel(node, farPb)) {
          continue;
        }

        const keyedNode = onStart ? v : node;

        if (gate !== undefined && !gate(keyedNode, binding, params, graph)) {
          continue;
        }

        add(propOf(keyedNode, key), 1);
      }
    }

    return [...groups.values()].map((slot) =>
      countFirst
        ? { [countCol]: slot.n, [keyCol]: slot.key }
        : { [keyCol]: slot.key, [countCol]: slot.n },
    );
  };
};

/** Whether `e` reads only variable `v` (a bare `v`, `v.key`, or a constant). */
const refsOnlyVar = (e: Expr, v: string): boolean => {
  switch (e.kind) {
    case 'var':
      return e.name === v;
    case 'property_exists':
    case 'prop':
      return e.variable === v;
    case 'lit':
    case 'param':
      return true;
    default:
      return false;
  }
};

/**
 * Reachability shortcut for **unbounded var-length with DISTINCT**:
 * `MATCH (a{..})-[:T]->+(b) RETURN DISTINCT <b…>` (and `->*`, `count(DISTINCT b)`).
 * Trail enumeration is exponential on a connected graph and hits `TRAIL_BUDGET`
 * (a fault), but a DISTINCT result only wants the reachable *set* — multiplicity
 * collapses — which a plain O(V+E) BFS answers. `->+` = reachable via ≥1 hop; `->*`
 * also includes the seed(s). Mirrors the native engine's `try_reachable_distinct`
 * so both engines behave identically. Seeds via the compiled start node.
 */
type ReachSpec = {
  cstart: CNode;
  items: readonly CReturnItem[];
  bVar: string;
  bLabel: LabelExpr | undefined;
  out: boolean;
  types: string[] | undefined;
  minZero: boolean;
  isCount: boolean;
  /** For `count(DISTINCT <expr>)` with a non-bare arg (e.g. `b.k`): the compiled
   *  arg to evaluate + dedup per reached vertex. Undefined = bare `count(DISTINCT
   *  b)`, whose distinct count is just the reached-set size. */
  countArg?: CompiledExpr;
  skip: CountValue;
  limit?: CountValue;
};

/** BFS the reachable set, then project the endpoint + DISTINCT (or count it). */
const runReach = (spec: ReachSpec, graph: Graph, params: Params): Row[] => {
  const { cstart, items, bVar, bLabel, out, types, minZero, isCount } = spec;
  // A `$param` bound resolves here (validated up-front); a literal passes through.
  const skipN = resolveCount(spec.skip, params) ?? 0;
  const limit = resolveCount(spec.limit, params);
  // Seeds matching the start's label + inline props/WHERE. `seedVertices` only
  // narrows by label/index, so a no-index inline predicate (`{k:0}`) still needs a
  // per-seed check — otherwise we'd seed from the whole label and overcount the
  // reachable set. Mirrors the native `reach_seed_vertices`.
  const seeds = [...seedVertices(graph, cstart, new Map(), params)].filter(
    (v) => matchNode(new Map(), cstart, v, params, graph) !== null,
  );
  const nbrs = (v: Vertex): Vertex[] => outNeighbors(graph, v, out, types);

  // Forward reachability (≥1 hop) as a DFS closure — each vertex expands once.
  const seen = new Set<string>();
  const reached: Vertex[] = [];
  const stack: Vertex[] = [];
  const push = (w: Vertex): void => {
    if (!seen.has(w.id)) {
      seen.add(w.id);
      reached.push(w);
      stack.push(w);
    }
  };

  for (const s of seeds) {
    for (const w of nbrs(s)) {
      push(w);
    }
  }

  while (stack.length > 0) {
    for (const w of nbrs(stack.pop()!)) {
      push(w);
    }
  }

  // `->*` also admits the zero-length path — the seeds themselves.
  if (minZero) {
    for (const s of seeds) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        reached.push(s);
      }
    }
  }

  const kept = reached.filter((v) => matchesLabel(v, bLabel));

  if (isCount) {
    // Bare `count(DISTINCT b)`: distinct endpoints = the reached set.
    if (spec.countArg === undefined) {
      return [{ [items[0].name]: kept.length }];
    }

    // `count(DISTINCT <expr>)` (e.g. `b.k`): evaluate per reached vertex, skip
    // nulls, dedup values — mirrors the native `try_reachable_distinct` count mode.
    const seenVals = new Set<string>();
    let n = 0;

    for (const v of kept) {
      const cell = spec.countArg({ binding: new Map([[bVar, v]]), params, graph });

      if (isNullish(cell)) {
        continue;
      }

      const k = valueKey(cell);

      if (!seenVals.has(k)) {
        seenVals.add(k);
        n += 1;
      }
    }

    return [{ [items[0].name]: n }];
  }

  // DISTINCT rows: project the endpoint per reached vertex, dedup the tuples.
  const seenRows = new Set<string>();
  const rows: Row[] = [];

  for (const v of kept) {
    const env: EvalEnv = { binding: new Map([[bVar, v]]), params, graph };
    const cells = items.map((it) => it.fn(env));
    // Separator-joined (like `rowKeyOf`): without it, two string columns collide
    // (`'as'+'b'` == `'a'+'sb'`) and a genuinely-distinct row is dropped.
    const key = cells.map(valueKey).join('\x01');

    if (!seenRows.has(key)) {
      seenRows.add(key);
      rows.push(Object.fromEntries(items.map((it, i) => [it.name, cells[i]])));
    }
  }

  if (skipN === 0 && limit === undefined) {
    return rows;
  }

  return rows.slice(skipN, limit === undefined ? undefined : skipN + limit);
};

/**
 * If the projection is exactly `count(DISTINCT <expr over only b>)`, return the
 * arg AST — `'bare'` when it is exactly `b` (so distinct endpoints = the reached
 * set), else the sub-expression (e.g. `b.k`) to evaluate + dedup per reached
 * vertex. `null` when it is not a count-distinct over the endpoint. Uses the same
 * `refsOnlyVar` gate as the native `refs_only_endpoint`, so both engines take the
 * shortcut on the same query (previously TS only accepted a bare `b`, so
 * `count(DISTINCT b.k)` fell through to trail enumeration and faulted where native
 * answered via BFS).
 */
const reachCount = (proj: Projection, bVar: string): { countArg?: CompiledExpr } | null => {
  const first = proj.items[0]?.expr;

  if (
    proj.items.length !== 1 ||
    first?.kind !== 'func' ||
    first.name !== 'count' ||
    !first.distinct ||
    first.star ||
    first.args.length !== 1 ||
    !refsOnlyVar(first.args[0], bVar)
  ) {
    return null;
  }

  const [arg] = first.args;

  // Bare `count(DISTINCT b)` → no arg (distinct endpoints = reached set); an
  // expression (`b.k`) → compile it to evaluate + dedup per reached vertex.
  return arg.kind === 'var' && arg.name === bVar ? {} : { countArg: compileExpr(arg) };
};

/** A pattern that only the general scalar matcher handles — a path selector
 * (`ANY`/`ALL SHORTEST`), a non-default mode (`SIMPLE`/`ACYCLIC`/`WALK`), or a
 * per-hop edge predicate on a quantified segment. The count/vectorized shortcuts
 * enumerate or count trails without the predicate, which is wrong for any. */
const needsGeneralMatcher = (p: PathPattern): boolean =>
  (p.selector ?? 'walk') !== 'walk' ||
  (p.mode ?? 'trail') !== 'trail' ||
  p.segments.some((s) => s.rel.quantifier !== undefined && relHasPredicate(s.rel));

export const detectReachableShortcut = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ReachFn | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [cm, cret] = compiled;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.where !== undefined ||
    m.patterns.length !== 1 ||
    ret.kind !== 'return' ||
    cm.kind !== 'match' ||
    cret.kind !== 'return'
  ) {
    return null;
  }

  if (m.patterns[0].segments.length !== 1) {
    return null;
  }

  // A path selector (`ANY`/`ALL SHORTEST`) or non-default mode (`SIMPLE`/
  // `ACYCLIC`/`WALK`) is handled only by the general matcher — this shortcut
  // counts trails (edge-uniqueness), wrong for either.
  if (needsGeneralMatcher(m.patterns[0])) {
    return null;
  }

  const [{ rel, node }] = m.patterns[0].segments;
  const { quantifier: q } = rel;
  const bVar = node.variable;
  const types = relTypeNames(rel.label);

  // Unbounded (`->+` / `->*`) directed segment, no edge var / props / WHERE, a bare
  // labelled endpoint bound to a variable, a buildable rel type, no ORDER BY.
  if (
    q?.max !== null ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    (rel.properties?.length ?? 0) > 0 ||
    rel.where !== undefined ||
    bVar === undefined ||
    (node.properties?.length ?? 0) > 0 ||
    node.where !== undefined ||
    types === null ||
    (ret.projection.orderBy?.length ?? 0) > 0
  ) {
    return null;
  }

  const { projection } = ret;
  const count = reachCount(projection, bVar);
  const isRows = projection.distinct && projection.items.every((it) => refsOnlyVar(it.expr, bVar));

  if (count === null && !isRows) {
    return null;
  }

  const spec: ReachSpec = {
    cstart: cm.patterns[0].start,
    items: cret.projection.items,
    bVar,
    bLabel: node.label,
    out: rel.direction === 'out',
    types: types ?? undefined,
    minZero: q.min === 0,
    isCount: count !== null,
    countArg: count?.countArg,
    skip: projection.skip ?? 0,
    limit: projection.limit,
  };

  return (graph, params) => runReach(spec, graph, params);
};
