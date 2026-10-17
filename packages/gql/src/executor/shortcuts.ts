// Count / reachability fast-paths for GQL. Detected on the raw AST at compile
// time, these compute a `count(*)` directly from the type-bucket sizes / a degree
// product, or answer an unbounded var-length + DISTINCT query with a plain BFS,
// instead of enumerating every match. They mirror the native engine
// (`try_count_edges` / `try_count_two_hop` / `try_reachable_distinct`) and are
// provably identical for the homomorphic shapes they accept.
import type { Edge, Graph, Vertex } from '@lenke/core';

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
  SortItem,
} from '../ast.js';
// The shortcuts read shared primitives + compiled types out of the executor
// trunk, and the trunk imports the two detectors back — a safe function-level
// cycle (resolved lazily at call time), matching the other executor submodules.
import type {
  AggFold,
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
  foldFor,
  freePredicateVars,
  gatePredicate,
  columnName,
  compareSort,
  compileExpr,
  compilePredicate,
  aggregateOverValues,
  satisfies,
  countEdges,
  outNeighbors,
  propOf,
  relHasPredicate,
  relTypeNames,
  resolveCount,
  valueKey,
} from '../executor.js';
import { candidateCount, candidateVertexSource, expand, matchesLabel } from '../graph-queries.js';
import type { Adjacency } from '../graph-queries.js';
import { indexCandidates, matchNode, seedVertices, seekIsWorthIt } from './matching.js';
import type { SeedCandidate } from './matching.js';
import { AGGREGATES, asTruth, isNullish } from './scalars.js';

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
/**
 * Is `expr` carried by EVERY vertex, so testing it per element is pure cost?
 *
 * Exported since item 167: the fused hop projection needs the same question to decide whether
 * it may drive the FAR side (a start label it cannot apply by iteration is only ignorable when
 * no vertex fails it).
 */
export const vacuousLabel = (graph: Graph, expr: LabelExpr | undefined): boolean =>
  expr?.kind === 'label' && (graph.verticesByLabel.get(expr.name)?.size ?? 0) === graph.vertexCount;

export const plainNode = (n: NodePattern): boolean =>
  (n.properties?.length ?? 0) === 0 && n.where === undefined;
export const plainRel = (r: RelPattern): boolean =>
  (r.properties?.length ?? 0) === 0 && r.where === undefined && r.quantifier === undefined;

type CountFn = (graph: Graph, params: Params) => Row;

/**
 * `MATCH (:A)-[:T]-(b:B) RETURN count(*)` — an UNDIRECTED hop count.
 *
 * Every edge is met from BOTH ends, so it contributes a row per endpoint that fits the pattern;
 * a SELF-LOOP contributes one, because `expand` yields it once (it is indexed under both
 * adjacency maps and the in-pass skips it).
 *
 * Two routes, chosen per call:
 *
 *   - VACUOUS endpoints: `2 * |E_t| - loops(t)` per type, straight from the bucket size and
 *     `selfLoopsByLabel`. O(1), which is what the directed spelling has always had — the
 *     undirected one cost 1352 ms against its 0.0 at 200,000 nodes / 1,000,000 edges.
 *   - otherwise: one pass over the type's edges, testing each end against the two labels. O(E),
 *     still far below the general path's binding-and-row per edge.
 *
 * The per-type loop tally is what lets the O(1) route run on an ordinary graph: item 478 gated
 * an undirected fast path on `selfLoopCount === 0` and the probe's own fixture (50 loops)
 * disarmed it.
 */
const undirectedHopCount = (
  graph: Graph,
  types: readonly string[] | undefined,
  aLabel: LabelExpr | undefined,
  bLabel: LabelExpr | undefined,
): number => {
  const a = vacuousLabel(graph, aLabel) ? undefined : aLabel;
  const b = vacuousLabel(graph, bLabel) ? undefined : bLabel;
  // Summing per-type buckets is sound only when no edge sits in two of them — the same
  // condition the directed arm uses, and one type can never collide with itself.
  const perType = types !== undefined && (types.length === 1 || graph.multiTypeEdgeCount === 0);

  if (a === undefined && b === undefined && perType) {
    return types.reduce(
      (n, t) =>
        n + 2 * (graph.edgesByLabel.get(t)?.size ?? 0) - (graph.selfLoopsByLabel.get(t) ?? 0),
      0,
    );
  }

  // One pass over the candidate edges. `edgesByLabel` is per type, so a multi-type edge is
  // deduped through a `Set` exactly as the directed tally does it.
  const seen = perType || types === undefined ? undefined : new Set<Edge>();
  const buckets =
    types === undefined
      ? [...graph.edgesByLabel.values()]
      : types.map((t) => graph.edgesByLabel.get(t)).filter((x): x is Set<Edge> => x !== undefined);
  let n = 0;

  for (const bucket of buckets) {
    for (const edge of bucket) {
      if (seen !== undefined) {
        if (seen.has(edge)) {
          continue;
        }

        seen.add(edge);
      }

      const { from, to } = edge;

      if (matchesLabel(from, a) && matchesLabel(to, b)) {
        n += 1;
      }

      // The reverse orientation, which a self-loop does NOT get: `expand` emits it once.
      if (from !== to && matchesLabel(to, a) && matchesLabel(from, b)) {
        n += 1;
      }
    }
  }

  return n;
};

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

      // This declined only a seek WIDER than the whole bucket (fraction 1.0), which left the
      // 12.5%-100% band seeking where the scan wins — up to 5.02x at 60% (item 409). The
      // shared `seekIsWorthIt` is now the one rule, so this site and the general path cannot
      // disagree about the same node.
      // Through the shared helper, not the constant applied to `bucket`: the helper also
      // carries the small-graph FLOOR, and a second copy of that would be a second thing to
      // drift (item 407's lesson, which is why the helper exists).
      if (best !== undefined && seekIsWorthIt(graph, cstart.label, best.count)) {
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
    // The node's OWN variable is passed, which is sound exactly here: the loop above has just
    // proved the inline `WHERE` reads nothing but it. A clause `WHERE` cannot make that claim and
    // so never takes this route.
    pred: compilePredicate(n.properties, n.where, n.variable),
    ...(n.variable !== undefined ? { bindVar: n.variable } : {}),
  };
};

/**
 * Split a clause `WHERE` into its conjuncts and bucket each by the ONE node variable it reads.
 * `null` if a conjunct reads none or several — a correlation across two positions is not a
 * per-vertex gate, and the whole pattern must then decline rather than drop a predicate.
 *
 * This is the pushdown the planner does not do for this shape, and the reason it is needed is
 * measured rather than assumed: an inline `{k: 1}` reaches [`inlineOf`] through the PATTERN NODE,
 * so item 303's gates served that spelling only, and the identical clause `WHERE` cost 4708.2ms
 * against the inline 33.9 — 139x, item 125's bug class at the far end of the family. Native had
 * the same gap for the same reason and item 304 closed it the same way.
 */
const chainGatesOf = (
  where: Expr,
  start: NodePattern,
  segments: readonly Segment[],
): Map<string, Expr[]> | null => {
  const names = new Set<string>();

  for (const v of [start.variable, ...segments.map((seg) => seg.node.variable)]) {
    if (v !== undefined) {
      names.add(v);
    }
  }

  const out = new Map<string, Expr[]>();
  const pending: Expr[] = [where];

  while (pending.length > 0) {
    const e = pending.pop() as Expr;

    if (e.kind === 'and') {
      pending.push(...e.items);
      continue;
    }

    const free = freePredicateVars(e);

    if (free.size !== 1) {
      return null;
    }

    const [name] = free;

    if (!names.has(name)) {
      return null;
    }

    const bucket = out.get(name);

    if (bucket === undefined) {
      out.set(name, [e]);
    } else {
      bucket.push(e);
    }
  }

  return out;
};

/**
 * One position's gate from BOTH spellings at once: its inline constraint and whichever clause
 * conjuncts name it. `undefined` ungated, `null` to decline.
 *
 * The conjuncts are ANDed as AST before compiling, so the position still carries exactly ONE
 * compiled predicate and the sweep's hot loop is unchanged — an array of predicates per position
 * would put a loop inside the per-vertex branch, which is the cost this file has measured five
 * times ([[ts-closure-size-is-load-bearing]]).
 */
const gateWith = (
  n: NodePattern,
  extra: readonly Expr[] | undefined,
): InlinePred | null | undefined => {
  if (extra === undefined || extra.length === 0) {
    return inlineOf(n);
  }

  // A clause conjunct is evaluated with the node bound to its own variable, exactly as an inline
  // `WHERE` is, so it needs one — and the caller has already proved each conjunct reads only it.
  if (n.variable === undefined) {
    return null;
  }

  for (const c of n.properties ?? []) {
    if (freePredicateVars(c.value).size > 0) {
      return null;
    }
  }

  const parts: Expr[] = n.where !== undefined ? [n.where, ...extra] : [...extra];

  for (const part of parts) {
    for (const name of freePredicateVars(part)) {
      if (name !== n.variable) {
        return null;
      }
    }
  }

  const where: Expr = parts.length === 1 ? parts[0] : { kind: 'and', items: parts };

  return { pred: compilePredicate(n.properties, where, n.variable), bindVar: n.variable };
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
  /** The COMPILED start node, carrying the seed hints that let the start walk seek. */
  cstart?: CNode;
  /** Its FAR mirror, for the far-side walk. */
  cfar?: CNode;
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
/**
 * One vertex's degree summed across the hop's edge types, given its row of the edge index.
 *
 * Module scope and shared by both hop-count walks. The per-edge call cost this file records
 * elsewhere does not apply: since item 164 this runs once per SURVIVING vertex (plus once per
 * faulting one), not once per candidate.
 */
const degreeOfTypes = (
  byType: Map<string, Set<Edge>> | undefined,
  types: string[] | undefined,
): number => {
  if (byType === undefined) {
    return 0;
  }

  let deg = 0;

  if (types === undefined) {
    // Every type. Sound only because the caller reaches this with no type list
    // only when `multiTypeEdgeCount === 0`, so no edge sits in two of the
    // buckets being summed.
    for (const set of byType.values()) {
      deg += set.size;
    }

    return deg;
  }

  for (const t of types) {
    deg += byType.get(t)?.size ?? 0;
  }

  return deg;
};

/**
 * The start side's seed set for a per-vertex hop walk, or `undefined` to walk the label bucket.
 *
 * EXPORTED only so the choice can be tested directly. Seeking is answer-preserving — that is the
 * point of it — so no result-based test can tell a seek from a walk, and a mutant that simply
 * never seeks survives every one of them. Items 167, 168, 172 and 173 hit the same wall; 172 and
 * 173 escaped it by testing an exported decision, which is what this is.
 *
 * Mirrors `buildNodeCount`'s chooser exactly, including declining a seek WIDER than the bucket
 * (an indexed key can be common outside this label). Both are correct; only the cost differs.
 */
export const hopSeek = (
  graph: Graph,
  cstart: CNode | undefined,
  pa: LabelExpr | undefined,
  env: EvalEnv,
): ReadonlySet<Vertex> | undefined => {
  if (cstart === undefined) {
    return undefined;
  }

  let best: SeedCandidate | undefined;

  for (const candidate of indexCandidates(graph, cstart, env)) {
    if (best === undefined || candidate.count < best.count) {
      best = candidate;
    }
  }

  // Same rule as every other seed site (item 409): `< candidateCount` admitted anything
  // narrower than the whole bucket, where the break-even is ~1/8 of it.
  return best !== undefined && seekIsWorthIt(graph, pa, best.count) ? best.build() : undefined;
};

const startOnlyHopCount = (scan: HopScan, startVar: string | undefined): number => {
  const { graph, params, pred, pa, out, types, inNear, cstart } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  // The vertex's own adjacency box, not a hash of its id into the graph's map — `Vertex.adjFrom`
  // caches it on first read (audit items 162, 321). This drive is the NEAR side, so `out` selects
  // the out-adjacency; the far-side twin below selects the opposite one.
  const boxOf = (v: Vertex): Map<string, Set<Edge>> | undefined => (out ? v.adjFrom : v.adjTo);
  let n = 0;

  // Driven from the VERTEX side, not the edge index. Both changes this buys are measured in
  // audit item 164:
  //
  //   ORDER — the edge index is keyed by id, so iterating it touches 200,000 vertices and their
  //   property bags in hash order. The same walk in creation order cost 29ns/vertex against
  //   135ns, because every entry was a `getVertexById` plus two pointer chases into cold memory.
  //   That locality, not the expression layer, was 135 of the 177ns item 163 had attributed to
  //   the compiled accessor.
  //
  //   SHORT-CIRCUIT — the degree is now summed only for vertices the predicate KEEPS, so a
  //   selective predicate never touches the edge index for the ones it rejects.
  //
  // Iterating vertices also removes the old `v == null` guard: the edge index can hold an id
  // whose vertex is gone, and that entry contributed 0 either way.
  //
  // AN INDEX SEEK FIRST, when the graph offers one narrower than the label bucket. Item 149
  // found and fixed exactly this for the NODE tally, and recorded the signature it leaves in
  // `bun run bench:usage`: a row whose indexed and unindexed columns are the same number.
  // The one-hop walk was never given the same treatment, so an anchored hop count scanned the
  // whole label while the general path seeded. Four spellings of one question, 20,000 users,
  // `name` indexed (audit item 176):
  //
  //   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(*)       420.6us  <- this walk
  //   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN x.name          15.5us
  //   (u:User)-[:FOLLOWS]->(x) WHERE u.name = $n RETURN count(x.name)   17.8us
  //   (a:User) WHERE a.name = $n MATCH (a)-[:FOLLOWS]->(x) count(*)     21.5us
  //
  // Sound for the reason it is sound in `buildNodeCount`: a hint lifted from an AND-chain is a
  // NECESSARY condition, so the seeded set is a SUPERSET of the matches, and the label check,
  // the inline constraint and the predicate below all re-validate every candidate — the same
  // three tests the bucket walk applies, in the same order.
  for (const v of hopSeek(graph, cstart, pa, env) ?? candidateVertexSource(graph, pa)) {
    if (!matchesLabel(v, pa)) {
      continue;
    }

    try {
      if (inNear !== undefined && !inlineHolds(inNear, v, binding, params, graph)) {
        continue;
      }

      if (startVar !== undefined) {
        binding.set(startVar, v);
      }

      if (asTruth(pred.fn(env)) !== true) {
        continue;
      }
    } catch (e) {
      // Evaluating before the degree lookup would otherwise surface a fault on a vertex the
      // old walk never reached (its `deg === 0` continue came first) — the raise-parity class
      // of items 139, 142, 144 and 145. So on a fault, look the degree up and re-throw ONLY
      // if the general path would have evaluated this vertex. The happy path pays nothing:
      // the guarded loop measured 52.26ms against 51.81ms unguarded.
      if (degreeOfTypes(boxOf(v), types) > 0) {
        throw e;
      }

      continue;
    }

    n += degreeOfTypes(boxOf(v), types);
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
  const { graph, pred, pa, pb, types, inNear, inFar } = scan;

  return (
    // A clause predicate on the start, an INLINE constraint on it, a non-vacuous start
    // LABEL, or any combination — every one of them is decided per VERTEX.
    //
    // `pa !== undefined` is item 286, and it is what lets the UNFILTERED branch ask this
    // rule at all. Without it that branch had only two rungs: the O(1) bucket size when
    // BOTH ends are unconstrained, and a per-edge label walk otherwise. So a start label
    // `vacuousLabel` could not elide fell off a cliff — at 200,000 vertices and 600,000
    // `E` edges:
    //
    //   MATCH (a)-[:E]->(b)   RETURN count(*)    0.001 ms   <- bucket size
    //   MATCH (a:P)-[:E]->(b) RETURN count(*)   43.800 ms   <- every edge, both endpoints
    //   MATCH (a:S)-[:E]->(b) RETURN count(*)   28.341 ms   <- FOUR vertices, ZERO edges
    //
    // The `:S` row is the one that settles it: four vertices with no edges at all, and the
    // query scanned 600,000 edges to find none, because the walk that answers it in four
    // degree reads was reachable only with a predicate attached. The label IS a per-vertex
    // constraint; nothing about this walk needed a predicate to exist.
    (pred.startVar !== undefined || inNear !== undefined || pa !== undefined) &&
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

/** The FAR mirror of {@link startWalkFits}, on mirrored conditions — the far LABEL included. */
const farWalkFits = (scan: HopScan): boolean => {
  const { graph, pred, pa, pb, types, inNear, inFar } = scan;

  return (
    (pred.farVar !== undefined || inFar !== undefined || pb !== undefined) &&
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
 * (Audit item 163 found that `age > 500` matches NOTHING in that fixture and re-measured both
 * rows across selectivities. THIS row survives unchanged — native is flat at ~1.5ms whether 0 or
 * 988,885 edges match, because it scans the `age` column once either way, so the ratio below is
 * real. Its start-filtered twin did not survive; see the note in `bench.ts`.)
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
  const { graph, params, pred, pb, out, types, inFar, cfar } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  // The far endpoint of an `out` hop is the edge's TARGET, so its edges are the ones the
  // reverse index holds — the mirror of the twin's choice.
  // The FAR-side drive, so the box is the opposite of the near one above — reading it off the
  // wrong side is a wrong answer, not a slow one.
  const boxOf = (v: Vertex): Map<string, Set<Edge>> | undefined => (out ? v.adjTo : v.adjFrom);
  let n = 0;

  // The vertex-side drive, for the reasons spelled out on the twin above: creation order for
  // locality, and the degree summed only for vertices the predicate keeps.
  //
  // `pb`, not `pa`: this walk visits the FAR endpoints, so the label it can apply is the far
  // one. The start label has to be vacuous for the caller to route here.
  //
  // And the same seek the twin got in item 176, for the same reason: this walk scanned the far
  // label bucket while the general path seeded from an index, so a FAR-anchored hop count was
  // the only spelling of its question that ignored the index (audit item 178):
  //
  //   (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN count(*)       421.1us  <- this walk
  //   (u)-[:FOLLOWS]->(x:User {name: $n}) RETURN count(*)              347.9us  <- this walk
  //   (u)-[:FOLLOWS]->(x:User) WHERE x.name = $n RETURN count(u.name)   41.7us
  //
  // `hopSeek` is shared with the twin rather than mirrored, so the two sides cannot drift on
  // what counts as seekable or on the width guard.
  for (const v of hopSeek(graph, cfar, pb, env) ?? candidateVertexSource(graph, pb)) {
    if (!matchesLabel(v, pb)) {
      continue;
    }

    try {
      if (inFar !== undefined && !inlineHolds(inFar, v, binding, params, graph)) {
        continue;
      }

      if (farVar !== undefined) {
        binding.set(farVar, v);
      }

      if (asTruth(pred.fn(env)) !== true) {
        continue;
      }
    } catch (e) {
      // See the twin: re-throw only where the old walk would have evaluated this vertex.
      if (degreeOfTypes(boxOf(v), types) > 0) {
        throw e;
      }

      continue;
    }

    n += degreeOfTypes(boxOf(v), types);
  }

  return n;
};

/**
 * Every edge incident to `vertices` on the side `index` holds, restricted to `types`.
 *
 * ONE generator layer, not two: delegating to `edgesOfVertex` per vertex cost a nested frame per
 * vertex and that is the whole margin on a wide seek — this file has measured a generator layer
 * before (the 8ns-against-40ns reading behind `harness-must-resemble-caller`).
 */
const edgesOfVertices = function* (
  vertices: Iterable<Vertex>,
  index: Map<string, Map<string, Set<Edge>>>,
  types: string[] | undefined,
): Iterable<Edge> {
  for (const v of vertices) {
    const byType = index.get(v.id);

    if (byType === undefined) {
      continue;
    }

    if (types === undefined) {
      for (const set of byType.values()) {
        yield* set;
      }

      continue;
    }

    for (const t of types) {
      const set = byType.get(t);

      if (set !== undefined) {
        yield* set;
      }
    }
  }
};

/**
 * The edges the tally has to visit: every edge of the type, or — when either endpoint offers an
 * index seek — only those incident to the seeded end.
 *
 * This is the shape items 176 and 178 could not reach. Both per-vertex walks decline a pattern
 * with BOTH ends constrained by construction: `startWalkFits` needs `inFar === undefined` and
 * `farWalkFits` needs `inNear === undefined`, because a walk summing bucket SIZES cannot apply a
 * constraint on an end it never visits. So the query fell to this tally, which scanned the whole
 * edge bucket and seeked nothing. Measured on 20,000 users, 40,000 edges, `name` indexed (audit
 * item 179):
 *
 *   (u:User {name: $n})-[:FOLLOWS]->(x:User {name: $m}) RETURN count(*)             1187.3us
 *   (u:User)-[:FOLLOWS]->(x:User) WHERE u.name = $n AND x.name = $m  count(*)       2300.4us
 *   the same question as count(x.name), which the general path seeds                  41.4us
 *
 * Unlike item 177's decline, there is no cost model to get wrong here: both arms run the SAME
 * per-edge body, and the seeded source visits a strict SUBSET of the edges the full scan does —
 * every edge it skips is one whose seeded-end vertex fails a constraint the body re-checks. So
 * `hopSeek`'s own guard (narrowest candidate, declining a seek wider than that end's bucket) is
 * the whole decision, shared with both walks so the three routes cannot disagree.
 *
 * Both ends are asked and the NARROWER set wins. A candidate's `build()` returns the index's own
 * stored set rather than a copy, so asking twice is O(1) and comparing sizes costs nothing.
 *
 * `hopSeek`'s own guard — narrower than that end's bucket — is necessary but not sufficient HERE,
 * and this is the one place the three routes differ. The two per-vertex walks read bucket SIZES,
 * so a seek that narrows the vertex set always wins; this source must WALK each seeded vertex's
 * edges, paying an adjacency lookup per vertex to save the edges of the vertices it skips. At
 * degree 2 that trade turns over well before the bucket is exhausted. Both arms forced, 20,000
 * users and 40,000 edges:
 *
 *   seeded-end matches   seeded   full tally
 *                    2     53.2       1328.8   seed, 25x
 *                   10     52.8       1171.2   seed, 22x
 *                  100     94.3       1207.6   seed, 13x
 *                 1000    428.8       1229.8   seed, 2.9x
 *                10000   2030.0       1422.3   TALLY, 1.43x
 *
 * So the crossover is near 7,000 of 20,000, and `hopSeek`'s guard alone sends the last row the
 * wrong way — measured at 1946-2076us against the 1383 it replaced. A margin of 8 puts the
 * threshold at 2,500 here, inside the region where seeding still wins about 1.8x by
 * interpolation and clear of the one where it loses. (Item 177 landed on the same divisor for a
 * different cost model; the number coinciding is not a shared rule, so it is measured and named
 * separately.)
 */
const TALLY_SEEK_MARGIN = 8;

const tallyEdges = (scan: HopScan, env: EvalEnv): Iterable<Edge> => {
  const { graph, pa, pb, out, types, cstart, cfar } = scan;

  // A per-vertex bucket can hold one edge under several labels, so this source is sound only
  // where `degreeOfTypes` is: one concrete type, or no multi-type edge in the graph.
  if (types?.length === 1 || graph.multiTypeEdgeCount === 0) {
    const worthIt = (
      set: ReadonlySet<Vertex> | undefined,
      label: LabelExpr | undefined,
    ): ReadonlySet<Vertex> | undefined =>
      set !== undefined && set.size * TALLY_SEEK_MARGIN < candidateCount(graph, label)
        ? set
        : undefined;
    const fromStart = worthIt(hopSeek(graph, cstart, pa, env), pa);
    const fromFar = worthIt(hopSeek(graph, cfar, pb, env), pb);
    const startNarrower =
      fromStart !== undefined && (fromFar === undefined || fromStart.size <= fromFar.size);

    if (startNarrower) {
      return edgesOfVertices(fromStart, out ? graph.edgesFromByLabel : graph.edgesToByLabel, types);
    }

    if (fromFar !== undefined) {
      return edgesOfVertices(fromFar, out ? graph.edgesToByLabel : graph.edgesFromByLabel, types);
    }
  }

  return edgesOfTypes(graph.edgesByLabel, types);
};

const tallyHopCount = (scan: HopScan): number => {
  const { graph, params, pred, pa, pb, out, inNear, inFar } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  let n = 0;

  for (const edge of tallyEdges(scan, env)) {
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

/**
 * A one-hop count whose ONLY constraint is a label on one end: the DEGREE SUM over that end's
 * label bucket, or `null` when neither walk fits and the caller must keep its per-edge walk.
 *
 * The unfiltered branch of {@link buildOneHopCount} had two rungs — the O(1) bucket size when
 * BOTH ends are unconstrained, and a per-edge walk testing both endpoints' labels otherwise —
 * so a start label `vacuousLabel` could not elide fell off a cliff. At 200,000 vertices and
 * 600,000 `E` edges, min of 9 over three alternated rounds:
 *
 *   MATCH (a)-[:E]->(b)   RETURN count(*)     0.001 ms   <- bucket size, unchanged
 *   MATCH (a:P)-[:E]->(b) RETURN count(*)    44.734 ms -> 18.048 ms   2.48x
 *   MATCH (a)-[:E]->(b:P) RETURN count(*)   156.784 ms -> 35.777 ms   4.38x
 *   MATCH (a:P)<-[:E]-(b) RETURN count(*)   160.251 ms -> 35.880 ms   4.47x
 *   MATCH (a:Q)-[:E]->(b) RETURN count(*)    36.981 ms ->  7.530 ms   4.91x
 *   MATCH (a:S)-[:E]->(b) RETURN count(*)    30.736 ms ->  0.004 ms   7684x
 *
 * The `:S` row is the one that settles that this was a missing rung and not a tuning question:
 * FOUR vertices with ZERO edges, and the query scanned 600,000 edges to find none. A label is
 * a per-vertex constraint; nothing about the degree-sum walk ever needed a predicate.
 *
 * Both walks are REUSED rather than reimplemented, with the inline branch's bare-predicate
 * device: they take their constraint from `pa`/`pb` and apply `pred.fn` on top, so an
 * always-TRUE predicate reduces each to "iterate the label bucket, sum the degree". The
 * alternative — a third loop — is what this file has already paid for once: the far endpoint
 * sat on the per-edge tally for eight items because its fit rule was a separate copy.
 *
 * MODULE SCOPE, AND THAT IS MEASURED, NOT STYLISTIC. Written inline in the closure
 * `buildOneHopCount` returns, this cost the two spellings that ALREADY took the walk a
 * consistent 0.95-0.96x — `clause WHERE start` and `inline start`, slower in all three rounds,
 * on a path whose only textual change was one extra disjunct evaluated once per query. Hoisted,
 * they return to 1.00-1.01x. That is `ts-closure-size-is-load-bearing` for the FOURTH time in
 * this file (items 119, 141, 159), and the first time it was predicted by the note at the call
 * site rather than discovered.
 */
const labelOnlyHopCount = (
  graph: Graph,
  params: Params,
  out: boolean,
  types: string[] | undefined,
  /** The endpoint labels and their compiled nodes, bundled: eight parameters exceeded the
   *  arity limit, the same reason `buildOneHopCount` bundles its `ends`. */
  ends: { a?: LabelExpr; b?: LabelExpr; cstart?: CNode; cfar?: CNode },
): number | null => {
  const scan: HopScan = {
    graph,
    params,
    pred: { fn: alwaysTrue },
    pa: ends.a,
    pb: ends.b,
    out,
    types,
    inNear: undefined,
    inFar: undefined,
    cstart: ends.cstart,
    cfar: ends.cfar,
  };

  if (startWalkFits(scan)) {
    return startOnlyHopCount(scan, undefined);
  }

  if (farWalkFits(scan)) {
    return farOnlyHopCount(scan, undefined);
  }

  return null;
};

/** The bare predicate, allocated ONCE rather than per query. */
const alwaysTrue = (): true => true;

const buildOneHopCount = <T>(
  seg: Segment,
  start: NodePattern,
  rowOf: (n: number) => T,
  pred?: HopPred,
  /** The endpoint extras, bundled: three separate parameters exceeded the arity limit. */
  ends?: { inNear?: InlinePred; inFar?: InlinePred; cstart?: CNode; cfar?: CNode },
): CountOf<T> | null => {
  const { inNear, inFar, cstart, cfar } = ends ?? {};
  const { rel, node } = seg;

  // `plainNode(node)` is deliberately NOT required: an inline endpoint constraint
  // is carried in `inFar` instead of declining the shortcut (item 124). The caller
  // only supplies it after checking the constraint is CLOSED, and the rel must
  // still be plain — a rel predicate would need its own treatment.
  // `both` is admitted only UNFILTERED and with no inline endpoint constraint — those arms all
  // walk with a captured `out: boolean`. The undirected arm below answers every label case
  // itself, because a `CountOf` closure has no way to decline once it is built (item 482).
  if (!plainRel(rel)) {
    return null;
  }

  if (
    rel.direction === 'both' &&
    (pred !== undefined || inNear !== undefined || inFar !== undefined)
  ) {
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

  if (rel.direction === 'both') {
    return (graph) => rowOf(undirectedHopCount(graph, types, aLabel, bLabel));
  }

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
      const scan: HopScan = {
        graph,
        params,
        pred,
        pa,
        pb,
        out,
        types,
        inNear,
        inFar,
        cstart,
        cfar,
      };

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
      // `alwaysTrue`, not a fresh `() => true`: this branch and the unfiltered one below both
      // hand a bare predicate to the SAME two walks, and `pred.fn(env)` inside them is a hot
      // call. Two source locations mean two callee shapes at that call site, and item 286
      // measured what the third one cost — a uniform 1.10x on the two spellings that already
      // took the walk, which hoisting the new code to module scope did NOT fix and sharing the
      // identity did. One object, allocated once, also drops an allocation per query here.
      const bare: HopPred = { fn: alwaysTrue };
      // `cstart` here too, or the INLINE spelling of an anchored count scans the label while
      // the clause-`WHERE` spelling seeks — one question costing two different amounts, which
      // is the gap items 124-125 were about and the one this file keeps re-learning. Caught by
      // the index-hit test, not by any timing: both spellings answer correctly either way.
      const scan: HopScan = {
        graph,
        params,
        pred: bare,
        pa,
        pb,
        out,
        types,
        inNear,
        inFar,
        cstart,
        cfar,
      };

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

    // THE SAME TWO RUNGS the other two branches have, which this one never had (item 286).
    // Delegated to a MODULE-SCOPE function, not written inline — see `labelOnlyHopCount`.
    const byDegree = labelOnlyHopCount(graph, params, out, types, { a, b, cstart, cfar });

    if (byDegree !== null) {
      return rowOf(byDegree);
    }

    // TWO callbacks, chosen once per execution rather than a branch inside one — the shape this
    // file has measured before (item 159: folding the choice into a single loop cost 1.6x).
    //
    // Built by MODULE-SCOPE factories, not written inline here. Written inline they grew this
    // returned closure, and `analytic: fan-out spread 1-3 hops` — a query that cannot reach this
    // code at all, its quantified rel making `plainRel` false — acquired a second mode at ~30k
    // ops/sec against a tight 39.4-42.7k over nine observations. Hoisting them removed it. That
    // is `ts-closure-size-is-load-bearing` for the third time in this file (items 119, 141).
    return rowOf(
      countEdges(
        edgesOfTypes(graph.edgesByLabel, types),
        selectiveFirst(graph, a, b) ? nearThenFar(out, a, b) : farThenNear(out, a, b),
      ),
    );
  };
};

/**
 * The unfiltered label walk's two endpoint tests, in each order. Module scope so the closure
 * `buildOneHopCount` returns stays small — see the note at the call site.
 */
const nearThenFar =
  (out: boolean, a: LabelExpr | undefined, b: LabelExpr | undefined) =>
  (edge: Edge): boolean =>
    matchesLabel(out ? edge.from : edge.to, a) && matchesLabel(out ? edge.to : edge.from, b);

/** The mirror of {@link nearThenFar}, for when the FAR label is the selective one. */
const farThenNear =
  (out: boolean, a: LabelExpr | undefined, b: LabelExpr | undefined) =>
  (edge: Edge): boolean =>
    matchesLabel(out ? edge.to : edge.from, b) && matchesLabel(out ? edge.from : edge.to, a);

/**
 * Should the unfiltered label walk test the START endpoint's label before the far one?
 *
 * Both checks must pass, so their order changes no row — only how many edges survive the first
 * one. The callback's `&&` short-circuits, and the second check DEREFERENCES the other endpoint
 * to read its labels, so putting the selective label first skips a cold vertex touch per
 * rejected edge. Measured on 200,000 `P` against 2,000 `Q`, every `P` pointing at a `P` and
 * 2,000 at a `Q` (audit item 181), three observations each:
 *
 *   (a:P)-[:E]->(b:Q)   start is the BIG label    13.28 / 13.38 / 14.00ms
 *   (b:Q)<-[:E]-(a:P)   start is the SMALL label  11.09 / 11.34 / 12.18ms
 *   (a:Q)-[:E]->(b:P)   start is the SMALL label  10.84 / 11.05 / 11.36ms
 *   (b:P)<-[:E]-(a:Q)   start is the BIG label    13.74 / 14.05 / 14.25ms
 *
 * The MIRROR pair is what identifies the mechanism: it is not the arrow's direction but which
 * label lands in the first check, so "always test the far end" would merely move the cost.
 * `bun run spelling` reported the first pair at 1.51x and item 180 recorded it unfixed.
 *
 * Exported only so the choice can be asserted directly: no result-based test can tell the two
 * orders apart — the wall items 167/168/172/173 hit, and the escape 172/173 found.
 *
 * A label that constrains nothing (absent, or one `vacuousLabel` has already folded to
 * `undefined`) goes LAST: it rejects nobody, so leading with it wastes the short circuit.
 */
export const selectiveFirst = (
  graph: Graph,
  a: LabelExpr | undefined,
  b: LabelExpr | undefined,
): boolean => {
  if (a === undefined) {
    return false;
  }

  if (b === undefined) {
    return true;
  }

  return candidateCount(graph, a) <= candidateCount(graph, b);
};

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
 * `side` for an UNDIRECTED hop: how many rows a middle vertex contributes on one side of an
 * undirected two-hop product.
 *
 * `out + in`, minus the self-loops at `bId`, because a loop sits in BOTH adjacency maps and
 * `expand` yields it once (item 482's arithmetic, per vertex instead of per graph). The
 * subtraction is skipped entirely unless the graph holds a loop of one of these types, so an
 * ordinary graph pays one `Map.get` for the whole query and nothing per vertex.
 *
 * Both engines answer 6 for `MATCH (:P)-[:T]-(x)-[:T]-(y)` over the path `a-b-c`, which is
 * `1 + 2^2 + 1` — WALK semantics, where a two-hop may return along the edge it arrived on. That
 * is what makes this a degree PRODUCT at all, and it was checked against both engines before
 * the formula was written (item 483).
 */
const undirectedSide = (
  graph: Graph,
  bId: string,
  types: string[] | undefined,
  far: LabelExpr | undefined,
  loopsPossible: boolean,
): number => {
  const n = side(graph, bId, true, types, far) + side(graph, bId, false, types, far);

  if (!loopsPossible) {
    return n;
  }

  // Only reached on a graph that HAS a loop of a wanted type. A loop is in the out-bucket, so
  // one pass over it finds every loop at this vertex.
  const byType = graph.edgesFromByLabel.get(bId);
  let loops = 0;

  for (const edge of edgesOfTypes(byType, types)) {
    if (edge.from === edge.to && matchesLabel(edge.to, far)) {
      loops += 1;
    }
  }

  return n - loops;
};

/** Does the graph hold a self-loop of any of `types` (any type when `undefined`)? */
const loopsOfTypes = (graph: Graph, types: string[] | undefined): boolean => {
  if (graph.selfLoopCount === 0) {
    return false;
  }

  return types === undefined ? true : types.some((t) => (graph.selfLoopsByLabel.get(t) ?? 0) > 0);
};

/**
 * How many edges `edgesOfTypes` would yield, without yielding them.
 *
 * Mirrors that function's cases exactly, which is the whole requirement: a single named type, or
 * a single bucket when every type is wanted, is one `size` read. Several buckets are NOT a sum —
 * one edge can carry several labels and so sit in more than one of them, which is why
 * `edgesOfTypes` keeps a `seen` set. That case has no size to read, so it still counts, but it
 * counts without resolving an endpoint.
 */
const bucketSize = (
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

const KEEP_ANY = (): boolean => true;

/**
 * A label that constrains nothing — ABSENT, or carried by every vertex in the graph — collapsed to
 * `undefined`, so the paths below can take their no-label route.
 *
 * Decided per EXECUTION and not at compile time, because vacuity is a property of the GRAPH. This
 * is the third place the same reasoning pays: item 215 made the far-endpoint resolve conditional
 * on it, item 217 removed a far-label test that a false `needsFar` had already made constant, and
 * here it turns the two-hop degree product's per-edge scan back into a `size` read.
 */
const effectiveLabel = (graph: Graph, label: LabelExpr | undefined): LabelExpr | undefined =>
  label !== undefined && vacuousLabel(graph, label) ? undefined : label;

/**
 * The same two-hop pattern read from the far end.
 *
 * `MATCH (a)-[r1]->(b)-[r2]->(c)` and `MATCH (c)<-[r2]-(b)<-[r1]-(a)` match the same set of
 * (edge, edge) pairs, so a COUNT over one is the count over the other. That makes the end-filtered
 * question the start-filtered question written backwards — and the start-filtered one already has
 * a walk (item 206) that gates an end vertex before expanding it.
 *
 * Measured before building anything, which is how this turned out to need no new walk at all
 * (audit item 220). 200,000 vertices at degree 5, the SAME question and the SAME answer:
 *
 *     (a)-[:T]->(b)-[:T]->(c) WHERE c.age > 60    2363.5ms
 *     (c)<-[:T]-(b)<-[:T]-(a) WHERE c.age > 60     118.1ms      20.0x
 *     … WHERE c.age = 61                          2011.8ms
 *     reversed, selective                            9.5ms     211.8x
 *
 * A direction reads as "start -[e]-> node", so flipping it is what turns `b -> c` into `c <- b`.
 */
const FLIPPED: Record<RelPattern['direction'], RelPattern['direction']> = {
  out: 'in',
  in: 'out',
  both: 'both',
};

const reversedTwoHop = (
  start: NodePattern,
  s1: Segment,
  s2: Segment,
): { start: NodePattern; s1: Segment; s2: Segment } => ({
  // Fresh minimal segments rather than spreads of the originals: the builders read only `rel` and
  // `node`, and a `Segment` also carries `hopFrom` / `hopTo` / `unitRest`, which describe the
  // FORWARD reading and would be wrong here if anything ever started consulting them.
  start: s2.node,
  s1: { rel: { ...s2.rel, direction: FLIPPED[s2.rel.direction] }, node: s1.node },
  s2: { rel: { ...s1.rel, direction: FLIPPED[s1.rel.direction] }, node: start },
});

/** Everything `walkTwoHopFiltered` needs, decided once at compile time. */
type TwoHopPlan = {
  aLabel: LabelExpr | undefined;
  midLabel: LabelExpr | undefined;
  cLabel: LabelExpr | undefined;
  firstOut: boolean;
  fromCOut: boolean;
  t1: string[] | undefined;
  t2: string[] | undefined;
  inStart: InlinePred | undefined;
  pred: HopPred | undefined;
  cstart: CNode | undefined;
};

/**
 * The start-driven two-hop tally, AT MODULE SCOPE rather than inside the closure the builder
 * returns.
 *
 * That placement is not style. Written inline in the returned closure, this walk gave TWO
 * unrelated var-length queries a new slow mode — `analytic: fan-out spread 1-3 hops` and
 * `analytic: cycle detection 2-4 hops`, neither of which this path can even claim (a quantified
 * segment is refused upstream). Eight readings a side:
 *
 *     fan-out, before   563-625 ops/s      after, inline closure   334-593
 *     cycle,   before   485-569            after, inline closure   279-548
 *
 * The top of each after-range matches the before, so it is a new MODE and not a shift — the
 * signature `ts-closure-size-is-load-bearing` records, now for the fourth time. Hoisting the body
 * out and leaving the closure to dispatch one call is the fix that file prescribes.
 */
const walkTwoHopFiltered = (graph: Graph, params: Params, plan: TwoHopPlan): number => {
  const { aLabel, midLabel, cLabel, firstOut, fromCOut, t1, t2, inStart, pred, cstart } = plan;
  // Once per execution, not per vertex and not per edge — see `effectiveLabel`.
  const midEff = effectiveLabel(graph, midLabel);
  const cEff = effectiveLabel(graph, cLabel);
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  const seeded = hopSeek(graph, cstart, aLabel, env);
  const startVar = pred?.startVar;
  let count = 0;

  for (const a of seeded ?? candidateVertexSource(graph, aLabel)) {
    if (seeded !== undefined && !matchesLabel(a, aLabel)) {
      continue;
    }

    if (inStart !== undefined && !inlineHolds(inStart, a, binding, params, graph)) {
      continue;
    }

    if (pred !== undefined) {
      if (startVar !== undefined) {
        binding.set(startVar, a);
      }

      if (asTruth(pred.fn(env)) !== true) {
        continue;
      }
    }

    // Only survivors expand. `outNeighbors` is not used here because the MIDDLE label has to be
    // checked before the second leg is counted, so a rejected middle costs one label test rather
    // than an array entry.
    const byType = (firstOut ? graph.edgesFromByLabel : graph.edgesToByLabel).get(a.id);

    for (const e of edgesOfTypes(byType, t1)) {
      // The middle VERTEX is wanted for one thing only — its label — while the second leg counts
      // from its ID, which the edge already holds. So when no label constrains the middle, read
      // `toId` / `fromId` and skip resolving a whole vertex: `e.to` is a string-keyed `Map.get`
      // into `verticesById` (~190ns, item 194), paid once per FIRST-LEG EDGE. Item 140 made the
      // ingest path use these ids for exactly this reason.
      if (midEff === undefined) {
        count += side(graph, firstOut ? e.toId : e.fromId, fromCOut, t2, cEff);

        continue;
      }

      const b = firstOut ? e.to : e.from;

      if (!matchesLabel(b, midEff)) {
        continue;
      }

      count += side(graph, b.id, fromCOut, t2, cEff);
    }
  }

  return count;
};

/**
 * The START-FILTERED 2-hop count: `(a)-[:T1]->(b)-[:T2]->(c)` where a predicate reads only `a`.
 *
 * `buildTwoHopCount` below iterates the MIDDLE and multiplies the two sides, which is the right
 * shape for an unfiltered count and the wrong one here: once a predicate selects which `a`s
 * count, the start side's factor is no longer a plain degree. So this drives from the START, like
 * the one-hop walk — gate a vertex, and only then expand it.
 *
 * That difference is the whole win. `patternCountOf` declined any predicate on a two-segment
 * pattern ("the two-hop degree product has no route that applies a predicate"), so a filtered
 * 2-hop count fell to the general pipeline, which binds a row per match. The one-hop shape got
 * its per-vertex route in item 129 and the two-hop shape never did. Measured on 20,000 users at
 * three `FOLLOWS` each (audit item 206):
 *
 *     1-hop count, filtered start      25.7ns a scanned vertex   <- has the walk
 *     2-hop count, filtered start      97.7ns                    <- the general path
 *
 * Every condition `buildTwoHopCount` imposes is imposed here too, for the same reasons: anonymous
 * directed rels (a rel variable or `both` needs the general matcher), plain MIDDLE and END nodes
 * (an inline constraint there has no route), and distinct node variables (a shared one is a
 * self-join neither counting shape can express). Only the START is allowed to carry a filter.
 *
 * The seed, the label re-check and their order are the one-hop walk's, not a re-derivation:
 * `hopSeek` narrows to an index candidate set when the graph offers one smaller than the label
 * bucket — `count-shortcuts-must-seek` records that omitting it leaves a walk scanning a whole
 * label while the general path seeds, and that its signature is a row whose indexed and unindexed
 * columns read the same. A seeded set is a SUPERSET, so the label is re-checked, guarded on
 * `seeded` so the bucket walk pays nothing for a test it satisfies by construction.
 */
const buildFilteredTwoHopCount = <T>(
  s1: Segment,
  s2: Segment,
  start: NodePattern,
  rowOf: (n: number) => T,
  w: { inStart: InlinePred | undefined; pred: HopPred | undefined; cstart: CNode | undefined },
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
    return null; // a shared node variable is a self-join this cannot express
  }

  const t1 = relTypeNames(s1.rel.label);
  const t2 = relTypeNames(s2.rel.label);

  if (t1 === null || t2 === null) {
    return null;
  }

  const plan: TwoHopPlan = {
    aLabel: start.label,
    midLabel: s1.node.label,
    cLabel: s2.node.label,
    firstOut: s1.rel.direction === 'out',
    fromCOut: s2.rel.direction === 'out',
    t1,
    t2,
    inStart: w.inStart,
    pred: w.pred,
    cstart: w.cstart,
  };

  return (graph, params) => rowOf(walkTwoHopFiltered(graph, params, plan));
};

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

/** 2-hop `(a)-[:T1]->(b)-[:T2]->(c)` count via the degree product
 * `Σ_b (edges reaching a valid a) × (edges reaching a valid c)`. `null` unless
 * both rels are anonymous + directed and the node variables are distinct. */
/**
 * `MATCH (a)-[:T]->(b)-[:T]->(c)-[:T]->(d) RETURN count(*)` — the THREE-segment degree product.
 *
 * The two-segment product iterates the middle VERTEX and multiplies the two degrees either side of
 * it. One position along, the interior is an EDGE rather than a vertex, and the count is
 *
 *     Σ over middle edges (b → c) of indeg(b) · outdeg(c)
 *
 * which checks against the engine's own answer before a line of this was written: 1,000,000 edges
 * at in-degree 5 and out-degree 5 gives 25,000,000, exactly what the row pipeline returned in
 * 13.2 SECONDS — the slowest shape in the corpus, at 529ns a counted path against the two-segment
 * tally's 21 (audit item 221).
 *
 * Driven from the `b` VERTEX rather than from a global edge list, because no such list exists: the
 * adjacency index is per vertex. `indeg(b)` is then hoisted out of the inner loop, so it is one
 * lookup per vertex plus one per middle edge, not two per edge.
 *
 * Only the UNFILTERED shape routes here. A predicate at any of the four positions still declines,
 * as it did before — the start-driven walk would have to grow a leg, which is a separate question
 * with its own measurement.
 */
const buildThreeHopCount = <T>(
  s1: Segment,
  s2: Segment,
  s3: Segment,
  start: NodePattern,
  rowOf: (n: number) => T,
  // The two INTERIOR positions' constraints, however spelled. REQUIRED for the same reason
  // `buildTwoHopCount`'s is: the single caller derives them from `s1.node` and `s2.node`, so the
  // relaxed `plainNode` guards below cannot be reached by a path that forgot to carry one.
  //
  // `b` is the vertex this walk iterates, so its gate runs once per VERTEX. `c` is the far end of
  // each middle edge, so its gate runs once per MIDDLE EDGE. Both are positions the walk already
  // visits, which is why they are carryable at all — item 219's point one segment along. The `a`
  // and `d` ends are reached only as DEGREES and still decline.
  interior: { b: readonly InlinePred[]; c: readonly InlinePred[] },
): CountOf<T> | null => {
  const rels = [s1.rel, s2.rel, s3.rel];

  if (
    // `both` IS admitted (item 484): the two outer legs become UNDIRECTED degrees and the
    // MIDDLE leg walks the out-bucket then the in-bucket, skipping the self-loop the out-pass
    // already took — `expand`'s own order and its dedupe.
    // A rel VARIABLE is admitted (item 487): this is a degree PRODUCT with a middle-edge walk
    // and it binds NO edge, so a name can only matter through a read — and the shapes that
    // reach here cannot contain one. `patternCountOf` routes a clause `WHERE` or a start
    // constraint to the FILTERED builder, which still refuses a rel variable, and the
    // projection of a count shortcut is `count(*)`. Refusing it cost 1276 ms against 11 for the
    // same query without the names, at 20,000 nodes.
    rels.some((r) => !plainRel(r)) ||
    // `s1.node` (b) and `s2.node` (c) may now carry a constraint, because `interior` gates each
    // one exactly once per visit. `s3.node` — the END — still may not: the product reaches it only
    // as a degree, so a constraint there has no once-per-element place to go.
    !plainNode(s3.node)
  ) {
    return null;
  }

  // REL variables are in this list too, now that they are admitted. A REPEATED one — `-[r:T]->
  // (b)-[r:T]->(c)` — means the SAME edge at both positions, which is a self-join no product
  // can express: admitting it answered 1 where the general path answers 0 (item 487), found by
  // a probe written because the hazard was suspected and not by any test.
  const vars = [
    start.variable,
    s1.node.variable,
    s2.node.variable,
    s3.node.variable,
    s1.rel.variable,
    s2.rel.variable,
    s3.rel.variable,
  ].filter((v): v is string => v !== undefined);

  if (new Set(vars).size !== vars.length) {
    return null; // a shared node or edge variable is a self-join the product cannot express
  }

  const types = [
    relTypeNames(s1.rel.label),
    relTypeNames(s2.rel.label),
    relTypeNames(s3.rel.label),
  ];

  if (types.some((t) => t === null)) {
    return null;
  }

  const [t1, t2, t3] = types as (string[] | undefined)[];
  const aLabel = start.label;
  const bLabel = s1.node.label;
  const cLabel = s2.node.label;
  const dLabel = s3.node.label;
  // `a` is reached from b's reverse side; `d` from c's forward side; the middle leg runs b -> c.
  const toAOut = s1.rel.direction === 'in';
  const fromDOut = s3.rel.direction === 'out';
  const midOut = s2.rel.direction === 'out';
  const aBoth = s1.rel.direction === 'both';
  const midBoth = s2.rel.direction === 'both';
  const dBoth = s3.rel.direction === 'both';

  const gateOfPreds = (preds: readonly InlinePred[]): InlineGate | undefined =>
    preds.reduceRight<InlineGate | undefined>(
      (rest, ip) => (v, binding, params, graph) =>
        inlineHolds(ip, v, binding, params, graph) &&
        (rest === undefined || rest(v, binding, params, graph)),
      undefined,
    );
  const bGate = gateOfPreds(interior.b);
  const cGate = gateOfPreds(interior.c);

  return (graph, params) => {
    const aEff = effectiveLabel(graph, aLabel);
    const cEff = effectiveLabel(graph, cLabel);
    const dEff = effectiveLabel(graph, dLabel);
    const midIndex = midOut ? graph.edgesFromByLabel : graph.edgesToByLabel;
    // The undirected middle leg's two passes, EMPTY for a directed one — which keeps the
    // directed inner loop exactly as it was. Wrapping both cases in one `midLegs` array cost
    // the directed three-hop 1.06x (311.0 min against 329.8, three alternated rounds), and
    // that row is the widest cross-engine gap in the bench (item 310). Item 159's rule, paid
    // again: a branch or a loop level added around a hot inner loop is not free.
    const bothLegs: readonly (readonly [Map<string, Map<string, Set<Edge>>>, boolean])[] = midBoth
      ? [
          [graph.edgesFromByLabel, true],
          [graph.edgesToByLabel, false],
        ]
      : [];
    const aLoops = aBoth && loopsOfTypes(graph, t1);
    const dLoops = dBoth && loopsOfTypes(graph, t3);
    // The `d` side resolved ONCE per call rather than per edge: the directed and undirected
    // forms differ only in which helper they call, and choosing between them inside the inner
    // loop is both a branch item 159 warns about and two more points of complexity than this
    // function has to spare.
    const dSide = dBoth
      ? (g: Graph, id: string): number => undirectedSide(g, id, t3, dEff, dLoops)
      : (g: Graph, id: string): number => side(g, id, fromDOut, t3, dEff);
    // The `c` VERTEX has to be resolved when anything reads it — its label or its gate. With
    // neither, the edge's stored ID is all the `d` side needs (items 140, 218).
    const needsC = cEff !== undefined || cGate !== undefined;
    const binding = new Map<string, unknown>();
    let count = 0;

    for (const b of candidateVertexSource(graph, bLabel)) {
      if (!matchesLabel(b, bLabel)) {
        continue;
      }

      // Once per VERTEX, before either degree is read — the whole reason a `b` constraint belongs
      // on this shape.
      if (bGate !== undefined && !bGate(b, binding, params, graph)) {
        continue;
      }

      // Hoisted: the `a` side depends only on `b`, so it is one lookup per VERTEX rather than one
      // per middle edge. Zero here prunes the whole inner loop.
      const waysToA = aBoth
        ? undirectedSide(graph, b.id, t1, aEff, aLoops)
        : side(graph, b.id, toAOut, t1, aEff);

      if (waysToA === 0) {
        continue;
      }

      // REJECTED, with its numbers (item 310): memoizing the d-side degree per `c` in a
      // `Map<string, number>`, so that the ~5 middle edges reaching one `c` pay one hash instead
      // of `side`'s two plus a size read. First isolated reading was 1.07x, which looked like a
      // small real win on the widest cross-engine row in the bench.
      //
      // Three alternated rounds, one case per process, min of 9, settled it: the target read
      // **1.063x with DISJOINT ranges** (394.7-416.3 against 371.4-378.7) and
      // `count 3-hop + interior filter` — which takes the `needsC` branch below and so CANNOT
      // reach the memo — read **1.052x, also disjoint** (131.9-132.3 against 125.4-126.3). The
      // control moved as far as the target, so the memo is worth 1.01x at most. Disjoint ranges
      // are not proof when the change's own unreachable control moves with it.
      //
      // The diagnosis the experiment bought: this row is ts 401.6ms against native's 4.8, an 84x
      // gap and the widest in `bun run bench`, and it is NOT one hash per edge. The cost is spread
      // across the `edgesOfTypes` generator frame (item 300 priced that at 1.19x on the sweep),
      // the `Edge` property reads, and two hash lookups — so no single micro moves it. It is the
      // CSR item 300 recorded as needing a dense adjacency the TS graph does not expose.
      if (!midBoth) {
        for (const e of edgesOfTypes(midIndex.get(b.id), t2)) {
          if (!needsC) {
            count += waysToA * dSide(graph, midOut ? e.toId : e.fromId);

            continue;
          }

          const c = midOut ? e.to : e.from;

          if (cEff !== undefined && !matchesLabel(c, cEff)) {
            continue;
          }

          if (cGate !== undefined && !cGate(c, binding, params, graph)) {
            continue;
          }

          count += waysToA * dSide(graph, c.id);
        }

        continue;
      }

      for (const [index, forward] of bothLegs) {
        for (const e of edgesOfTypes(index.get(b.id), t2)) {
          // The in-pass must skip the self-loop the out-pass already took: a loop sits in both
          // maps and `expand` yields it once.
          if (!forward && e.fromId === e.toId) {
            continue;
          }

          if (!needsC) {
            count += waysToA * dSide(graph, forward ? e.toId : e.fromId);

            continue;
          }

          const c = forward ? e.to : e.from;

          if (cEff !== undefined && !matchesLabel(c, cEff)) {
            continue;
          }

          // Once per MIDDLE EDGE. A `c` reached by several middle edges is gated once per edge
          // rather than once per vertex, which is the honest cost of this position: the walk
          // meets `c` as an edge endpoint, not as something it enumerates.
          if (cGate !== undefined && !cGate(c, binding, params, graph)) {
            continue;
          }

          count += waysToA * dSide(graph, c.id);
        }
      }
    }

    return rowOf(count);
  };
};

const buildTwoHopCount = <T>(
  s1: Segment,
  s2: Segment,
  start: NodePattern,
  rowOf: (n: number) => T,
  // REQUIRED, not optional, and that is the safety property: the only caller computes it from
  // `s1.node` itself, so the relaxed `plainNode(s1.node)` guard below cannot be reached by a path
  // that forgot to carry the middle's constraint. An optional parameter here would make
  // "forgot to pass it" a silently wrong answer rather than a type error.
  midPreds: readonly InlinePred[],
): CountOf<T> | null => {
  if (
    !plainRel(s1.rel) ||
    !plainRel(s2.rel) ||
    // Rel VARIABLES are admitted here (item 487) and still refused by the FILTERED builder
    // above: this one binds no edge and only runs for a shape with no `WHERE` and no start
    // constraint, so a name nobody can read changes nothing. 2165 ms against 75 without them.
    // `both` IS admitted here (item 483): the product's two factors become UNDIRECTED degrees,
    // which is sound because a two-hop may return along the edge it arrived on — both engines
    // answer 6 for `(:P)-[:T]-(x)-[:T]-(y)` over the path `a-b-c`, which is 1 + 2^2 + 1.
    //
    // The FILTERED builder above still refuses it: that one WALKS with a captured direction,
    // and a guard edited by pattern alone landed there first (item 483's own near-miss).
    // `s1.node` — the MIDDLE — may now carry a constraint, because this walk visits middles and
    // `midPreds` gates each one exactly once. `s2.node`, the END, still may not: the product
    // reaches it only as a degree, so a constraint there has no once-per-element place to go.
    !plainNode(s2.node)
  ) {
    return null;
  }

  // REL variables included, for the reason the three-hop twin records: a repeated `r` is the
  // SAME edge at both positions, and this product treats the two legs as independent.
  const vars = [
    start.variable,
    s1.node.variable,
    s2.node.variable,
    s1.rel.variable,
    s2.rel.variable,
  ].filter((v): v is string => v !== undefined);

  if (new Set(vars).size !== vars.length) {
    return null; // a shared node or edge variable is a self-join the product can't express
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
  const aBoth = s1.rel.direction === 'both';
  const cBoth = s2.rel.direction === 'both';
  // Composed once, the same `reduceRight` the node tally uses, so the clause and inline spellings
  // of a middle constraint go through `inlineHolds` -> `satisfies` — the general path's own
  // implementation — rather than re-deriving inline-pattern semantics here.
  const gate = midPreds.reduceRight<InlineGate | undefined>(
    (rest, ip) => (v, binding, params, graph) =>
      inlineHolds(ip, v, binding, params, graph) &&
      (rest === undefined || rest(v, binding, params, graph)),
    undefined,
  );

  return (graph, params) => {
    const mids =
      midLabel?.kind === 'label'
        ? (graph.verticesByLabel.get(midLabel.name) ?? new Set<Vertex>())
        : graph.verticesById.values();
    // Once per execution. A VACUOUS end label costs `side` an endpoint resolve per edge to apply
    // a test that cannot fail, which is the difference between this being a degree PRODUCT and
    // being a per-edge scan wearing one's clothes — see `effectiveLabel`.
    const aEff = effectiveLabel(graph, aLabel);
    const cEff = effectiveLabel(graph, cLabel);
    // Once per execution, not per vertex: does this graph hold a loop of a wanted type at all?
    const aLoops = aBoth && loopsOfTypes(graph, t1);
    const cLoops = cBoth && loopsOfTypes(graph, t2);
    // One binding map reused across middles, the idiom `buildNodeCount` already uses:
    // `inlineHolds` overwrites the node's own variable per element.
    const binding = new Map<string, unknown>();
    let count = 0;

    for (const b of mids) {
      if (!matchesLabel(b, midLabel)) {
        continue;
      }

      // Gated ONCE per middle, before either degree is read — the whole reason a middle
      // constraint belongs on this shape rather than on the start-driven walk.
      if (gate !== undefined && !gate(b, binding, params, graph)) {
        continue;
      }

      const ways = aBoth
        ? undirectedSide(graph, b.id, t1, aEff, aLoops)
        : side(graph, b.id, toAOut, t1, aEff);

      if (ways === 0) {
        continue;
      }

      count +=
        ways *
        (cBoth
          ? undirectedSide(graph, b.id, t2, cEff, cLoops)
          : side(graph, b.id, fromCOut, t2, cEff));
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
  cfar?: CNode,
  // The compiled END node of a two-segment pattern, so the end-driven reading can seek an index.
  cend?: CNode,
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

  if (segments.length <= 2) {
    // The NODE-ONLY shape joined this in item 135: `buildNodeCount` can now tally a
    // constrained bucket, which both answers `MATCH (a:P {k: 1}) RETURN count(*)`
    // (previously 10.5ms against native's 0.04ms) and lets `productCountOf` use a
    // constrained pattern as a factor.
    //
    // The TWO-HOP shape joined in item 206. The note here used to read "the two-hop degree
    // product has no route that applies a predicate", and that was true of the degree product —
    // it iterates the MIDDLE and multiplies the two sides, so a predicate selecting which starts
    // count has nowhere to go. It was not true of the engine: the one-hop shape has had a
    // per-VERTEX route since item 129, which gates a start and only then expands it, and the
    // two-hop shape simply never got the same treatment. `buildFilteredTwoHopCount` is that
    // route; the product still answers the UNFILTERED case, which it does better.
    inStart = inlineOf(start);
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

      // `start.variable` is passed as the predicate's OWN variable, which lets `directEqProps`
      // read the element directly instead of through the binding. Sound because the loop above has
      // just proved exactly the precondition that argument documents: every free variable of
      // `where` IS `start.variable`, so the predicate is element-local. Without it the clause
      // spelling paid 29.0 ns a vertex against the inline spelling's 17.2 for the same answer, and
      // 47.4 against 21.1 for an AND of two equalities (audit item 230).
      preds.push({
        pred: compilePredicate(undefined, where, start.variable),
        bindVar: start.variable,
      });
    }

    return buildNodeCount(start, rowOf, preds, cstart);
  }

  // AN END CONSTRAINT ON A SHORT CHAIN GOES TO THE SWEEP (item 306), before the degree products
  // get a say, because it is the one position they cannot carry.
  if (segments.length === 3) {
    const swept = endGatedChainCount(start, segments, where, rowOf);

    if (swept !== null) {
      return swept;
    }
  }

  // A clause `WHERE` is answerable ONLY by the 1-hop tally below, and only when it reads
  // nothing but the pattern's own variables — an outer variable cannot exist here (this shape
  // is exactly two clauses) but an aggregate or a subquery could, and `freePredicateVars`
  // reports those as free names it does not recognize.
  let pred: HopPred | undefined;
  // A MIDDLE-only clause predicate. It joins the three INLINE middle spellings in
  // `twoSegmentCount`, because they are one question and so take one route — `WHERE b.k > 1`,
  // `(b WHERE b.k > 1)` and `(b {k: 2})` were 2331.7, 1183.1 and 482.3ms before item 219, which
  // is the equivalent-spelling gap this engine is named for, sitting in the open.
  let midPred: InlinePred | undefined;
  // An END-only clause predicate, shaped for the REVERSED reading where the end node is the start.
  let endPred: HopPred | undefined;
  // A THREE-segment clause predicate over one INTERIOR node, and which of the two it reads.
  // `null` means the predicate names something this shape cannot gate, which declines.
  let interiorPred: { pred: InlinePred; onB: boolean } | null | undefined;

  // The interior gate an INLINE constraint gives (item 456). Every condition lives in the helper
  // so the call site is ONE branch: inline, this put `patternCountOf` at 38 against a limit of
  // 35, and at 36 even with the body extracted.
  interiorPred = inlineInteriorGate(segments, interiorPred);

  if (interiorPred === null) {
    return null;
  }

  if (where !== undefined) {
    // THREE segments admit a clause predicate over exactly ONE INTERIOR node, which is the pair
    // of positions the degree product's walk visits. Anything else — the two ends, several
    // variables, four or more segments — still declines.
    if (segments.length === 3) {
      interiorPred = interiorPredOf(where, segments[0], segments[1]);

      if (interiorPred === null) {
        return null;
      }
    }

    // FOUR OR MORE segments used to decline here, which is what made the clause spelling of a
    // long-chain gate cost 139x its inline twin (item 305). They now fall through to the sweep
    // below, which SPLITS the predicate across the positions it names. The node shape returned
    // above, having folded its clause `WHERE` into the tally; nothing else between here and
    // there reads `where`.

    // On a TWO-segment pattern a predicate reading exactly ONE of the start or the middle is
    // admissible, and they route to different shapes.
    //
    // The note here used to admit only the start, "because the walk gates a start vertex and then
    // expands it — a predicate reading the middle or the end would have to be applied per
    // expanded edge". That is true of the start-driven walk and FALSE of the degree product,
    // which iterates MIDDLES: a middle-reading predicate is the cheapest one in the family, gated
    // exactly once per middle, where a start-reading one costs the product its start factor. So
    // the middle was the easy case being refused for the hard case's reason (audit item 219).
    //
    // The END is still refused: `Σ_b indeg(b) · |out-edges of b whose target passes p|` is a
    // correct formula, but its second factor is a per-EDGE predicate evaluation, which is a
    // different cost class from a once-per-middle gate. Recorded as open rather than guessed at.
    if (segments.length === 2) {
      const startName = start.variable;
      const midName = segments[0].node.variable;
      const free = freePredicateVars(where);
      const readsOnly = (name: string | undefined): boolean =>
        name !== undefined && [...free].every((n) => n === name);

      // A predicate reading NOTHING (`WHERE 1 = 1`) kept the start route before this item, even
      // with no start variable to bind, and still does — the alternative is declining a shape
      // that used to be tallied, which is a regression dressed as a simplification.
      const endName = segments[1].node.variable;

      if (free.size === 0 || readsOnly(startName)) {
        pred = {
          fn: compileExpr(where),
          startVar: startName,
          farVar: undefined,
          relVar: undefined,
        };
      } else if (readsOnly(midName)) {
        // `midName` doubles as the predicate's OWN variable: `readsOnly(midName)` has just proved
        // the predicate is element-local, which is what lets `directEqProps` read the element
        // directly rather than through the binding (item 230).
        midPred = { pred: compilePredicate(undefined, where, midName), bindVar: midName };
      } else if (readsOnly(endName)) {
        // The END is admissible too, as the START of the REVERSED pattern — see `reversedTwoHop`.
        // The predicate is shaped for the reversed reading, where the end node IS the start.
        endPred = {
          fn: compileExpr(where),
          startVar: endName,
          farVar: undefined,
          relVar: undefined,
        };
      } else {
        return null;
      }
    }
  }

  // The one-segment slot analysis, which must NOT run for two segments: it reads `segments[0]`'s
  // node and rel as the predicate's far and rel ends and would overwrite the start-only `pred`
  // built above with slots the two-hop walk does not bind.
  if (where !== undefined && segments.length === 1) {
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

    return buildOneHopCount(seg, start, rowOf, pred, { inNear: inStart, inFar, cstart, cfar });
  }

  if (segments.length === 2) {
    return twoSegmentCount(start, segments[0], segments[1], rowOf, {
      inStart,
      pred,
      midPred,
      endPred,
      cstart,
      cend,
    });
  }

  // THREE segments, and only the unfiltered shape. A clause `WHERE` has already declined above
  // (the gate admits one and two segments), so what is left to refuse here is an INLINE constraint
  // at any of the four positions — the product reaches two of them only as degrees, and the other
  // two have no gate yet.
  if (segments.length === 3) {
    // See `threeSegmentRoute` — extracted because this function tripped both the complexity and
    // max-statements caps, as it did at item 427.
    return threeSegmentRoute(start, segments, rowOf, interiorPred);
  }

  // FOUR OR MORE segments, as a SWEEP. Item 290 added a four-segment degree product and left
  // open whether it had FIXED the family's cliff or MOVED it; measured at item 298, it moved it
  // to five. 200 nodes of degree 5, min of 3, ns PER PATH — the rate, because a degree product's
  // rate falls as the path count grows
  // while the general matcher's is flat:
  //
  //   2 hops      5,000 paths     0.08 ms     16.3 ns/path
  //   3 hops     25,000 paths     0.22 ms      8.7 ns/path
  //   4 hops    125,000 paths     1.24 ms      9.9 ns/path   <- the arms, rate flat
  //   5 hops    625,000 paths   266.03 ms    425.6 ns/path   <- x43, and FLAT after
  //   6 hops  3,125,000 paths  1353.82 ms    433.2 ns/path
  //
  // A fifth hand-written arm would move the cliff to six, so this one is the general case
  // instead — and it is NOT another nested-loop product. See `longChainCount`.
  //
  // It starts at FOUR, not five, and which side of that line each depth falls on was MEASURED
  // rather than reasoned about (item 301). 200,000 vertices at degree 3, three alternated rounds,
  // disjoint ranges:
  //
  //   3 hops   product 250.1ms   sweep 374.9ms   <- the PRODUCT wins, 1.50x
  //   4 hops   product 980.2ms   sweep 512.4ms   <- the SWEEP wins, 1.91x
  //
  // A SPLIT verdict, which is why it was recorded as open-with-a-hint rather than obvious. The
  // reason is the shape of each product: `threeSegmentCount` pays per MIDDLE EDGE and multiplies
  // two degree sides, which is O(E) with no frontier and no hashing — cheaper than three sweep
  // passes. The four-segment one paid per INTERIOR PAIR, i.e. O(E x degree), which loses to four
  // O(E) passes. So the crossover sits exactly where a product stops being linear in the edges.
  //
  // `fourSegmentCount` was DELETED rather than left unreachable. Its gates were identical to the
  // sweep's — `plainRel`, no relationship variable, no `both`, `plainNode` at all five positions,
  // no shared node variable, resolvable types — so the sweep subsumes it exactly, and item 290's
  // 27 tests in `four-hop-count.test.ts` now exercise the sweep. That makes them an INDEPENDENT
  // oracle for it, written against a different implementation before this one existed.
  if (segments.length >= 4) {
    // A clause `WHERE` is split across positions (item 305). `null` means one of its conjuncts is
    // not a per-vertex test on a position — a correlation, a constant, or a name this pattern does
    // not bind — and the whole family declines, as it did for every clause `WHERE` before.
    const clauseGates = where === undefined ? undefined : chainGatesOf(where, start, segments);

    if (clauseGates === null) {
      return null;
    }

    return longChainCount(start, segments, rowOf, clauseGates);
  }

  return null;
};

/**
 * A THREE-segment chain whose END is constrained, answered by the way-count sweep instead of a
 * degree product (item 306). `null` leaves the shape to the arms below.
 *
 * It is the one position a product cannot carry: a product answers its last hop as a weighted sum
 * of DEGREES, and a degree cannot say which of a vertex's edges land somewhere that passes (items
 * 219, 290). So before this the shape declined every count arm and ENUMERATED, which is the cliff
 * items 303 and 305 MOVED rather than closed. Measured at 20,000 vertices of degree 3:
 *
 * | segments | ungated | gate on the END | interior |
 * | -------- | ------: | --------------: | -------: |
 * |        2 |  2.9 ms |          7.5 ms |   1.2 ms |
 * |        3 | 19.5 ms |    **668.3 ms** |  14.6 ms |
 * |        4 | 46.9 ms |   72.1 (sweep)  |  82.3 ms |
 *
 * On `bun run bench`'s 200,000 vertices at five edges each the three-hop end-filtered count went
 * **8391.7 -> 753.7ms** here and 274.9 -> 14.3 in native, with the ungated `count 3-hop` control
 * flat on both.
 *
 * THREE SEGMENTS ONLY, and the two-segment case is a RETRACTION with its numbers: routing it here
 * as well read **28.5ms against the 7.5 the existing arm already managed, 0.26x**, so the tuned
 * two-hop route beats this sweep at its own filtered shape and keeps it. Native went the OTHER way
 * at two hops (1.12 -> 0.70ms, 1.55x faster) — the same structural change, opposite verdicts,
 * because the two engines' two-hop arms are not the same arm. Measuring each depth in each engine
 * is the only reason this is known; a floor would have shipped the TS regression.
 *
 * An interior gate at two or three segments already has a route (items 219, 206) and keeps it, and
 * the products are better at everything unfiltered, which item 301 measured (the sweep loses 1.50x
 * to the three-segment product).
 *
 * RE-MEASURED AT TEN TIMES THE SIZE (item 310) and the verdict HOLDS, which is why it is not worth
 * re-attempting: item 301's reading was taken at 20,000 vertices, and the repo's own rule says
 * cache-resident and not are different questions with the transition between 200k and 1M. So
 * routing EVERY three-segment chain here was tried at 200,000 vertices / 1,000,000 edges, one case
 * per process, min of 9:
 *
 * | row                           | product | the sweep |             |
 * | ----------------------------- | ------: | --------: | ----------- |
 * | count 3-hop (ungated)         | 401.6ms |   534.7ms | 1.33x WORSE |
 * | count 3-hop + interior filter | 130.7ms |   433.1ms | 3.31x WORSE |
 *
 * The product pays per MIDDLE EDGE and multiplies two degrees — ONE pass over the edges — where
 * the sweep makes three. An interior gate widens the gap rather than closing it, because the gate
 * shrinks exactly what the product iterates.
 */
const endGatedChainCount = <T>(
  start: NodePattern,
  segments: readonly Segment[],
  where: Expr | undefined,
  rowOf: (n: number) => T,
): CountOf<T> | null => {
  const endNode = segments[segments.length - 1].node;
  const clauses = where === undefined ? undefined : chainGatesOf(where, start, segments);

  if (clauses === null) {
    return null;
  }

  const gated = (n: NodePattern): boolean => {
    const v = n.variable;

    return inlineOf(n) !== undefined || (v !== undefined && clauses?.has(v) === true);
  };

  // The END or the START, never an interior only. An interior gate makes the degree product
  // FASTER than its own unfiltered self (8.1ms against 16.3 at three segments, because the
  // product iterates the middle and the gate shrinks what it iterates), so there is nothing to
  // win there and item 219 already owns it.
  if (!gated(endNode) && !gated(start)) {
    return null;
  }

  // `null` from the sweep is it declining on its own terms (a shared node variable, a bound edge,
  // an undirected hop, an OPEN constraint), and the products below still get their chance.
  return longChainCount(start, segments, rowOf, clauses ?? undefined);
};

/**
 * Which route answers an unfiltered THREE-segment chain count: the degree PRODUCT
 * ({@link threeSegmentCount}) or the way-count SWEEP ({@link longChainCount})?
 *
 * Item 306 already sends an end-GATED short chain to the sweep "because it is the one position
 * they cannot carry", and `longChainCount`'s own doc says the same of LABELS: "the sweep VISITS
 * each one, so there is a once-per-element place to test it, which is what the end positions of
 * the degree products lack." A label was nonetheless left on the product, so at 200,000 vertices
 * of degree 3 with `:P` on a tenth (audit item 430):
 *
 * ```text
 *                                              product      routed
 *   MATCH (d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:P)   1112 ms      94.2 ms   11.8x
 *   MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d)    349         95.3       3.67x
 *   no label on either end                       176        176        kept
 * ```
 *
 * Both spellings now land on ~95 ms, which is the point: one question, one cost.
 *
 * The sweep is NOT unconditionally better at this depth — item 301 measured the product winning
 * the UNFILTERED shape, 250.1 against 374.9 ms — so the choice is made PER CALL and a tie keeps
 * the product. `candidateCount` returns the whole graph for a label it cannot seed from, so
 * "nothing narrows" and "a label we cannot use" collapse to the same answer, which is the one
 * item 301 measured.
 *
 * EXTRACTED because the caller tripped both the complexity (41/35) and max-statements (81/80)
 * caps, the same objection item 377 and item 427 both answered the same way.
 */
const threeSegmentRoute = <T>(
  start: NodePattern,
  segments: readonly Segment[],
  rowOf: (n: number) => T,
  interiorPred: { pred: InlinePred; onB: boolean } | null | undefined,
): CountOf<T> | null => {
  const product = threeSegmentCount(
    start,
    segments[0],
    segments[1],
    segments[2],
    rowOf,
    interiorPred,
  );
  const endLabel = segments[2].node.label;
  const startLabel = start.label;
  const labelled =
    endLabel?.kind === 'label' || (endLabel === undefined && startLabel?.kind === 'label');

  if (product === null || interiorPred !== undefined || !labelled) {
    return product;
  }

  const swept = longChainCount(start, segments, rowOf);

  if (swept === null) {
    return product;
  }

  return (graph, params) => {
    // NO TEST CAN POLICE THIS CHOICE, and mutation says so rather than my reading it:
    // always-sweep, always-product and an INVERTED comparison all leave every test green,
    // because both sides are correct implementations of the same count. What the tests DO catch
    // is the predicate plumbing — dropping the `interiorPred` guard above loses a clause `WHERE`
    // on the way to the sweep and fails. So the comparison is justified by the measurements in
    // this function's doc and by nothing else; the same division of labour item 429 recorded.
    const narrow = Math.min(candidateCount(graph, startLabel), candidateCount(graph, endLabel));

    return narrow < graph.vertexCount ? swept(graph, params) : product(graph, params);
  };
};

/**
 * An unfiltered count over FIVE OR MORE segments, as a forward sweep of per-position WAY COUNTS.
 *
 * `ways[v]` is how many ways position `k` can be `v`; one pass per segment advances it. Total
 * cost is O(hops x edges) and total memory is bounded by the VERTEX count, where enumerating the
 * paths is O(degree^hops) in both. That is the whole point: a nested-loop product like
 * {@link threeSegmentCount} buys one hop per loop, so it cannot reach an arbitrary depth, and its
 * four-segment sibling was DELETED at item 301 once the sweep was measured 1.91x faster at that
 * depth. A sweep has no such bound.
 *
 * The LAST segment is a weighted sum of DEGREES rather than a sixth pass, so it owes none of the
 * three per-edge costs item 218 removed from {@link side} — with no far label there is no
 * endpoint to resolve and the answer is a bucket SIZE.
 *
 * The ONE and TWO segment walks are untouched and stay that way: they are tuned and heavily
 * guarded (items 140, 206, 218-222) and they carry predicates and inline gates the sweep has no
 * route for. THREE stays on its product because the sweep lost there, measured — 250.1 against
 * 374.9ms, 1.50x the wrong way. Those were one question with two different answers, which is the
 * argument for measuring each depth rather than taking the asymptotics on trust (item 301).
 *
 * A clause `WHERE` is SPLIT across the positions it names (item 305) and an inline constraint is
 * carried at every position (item 303), so the two spellings of one gate take one route — they
 * were 4708.2ms and 33.9ms for the identical question before. Labels are carried at every
 * position too: the sweep VISITS each one, so there is a once-per-element place to test it, which
 * is what the end positions of the degree products lack.
 */
const longChainCount = <T>(
  start: NodePattern,
  segments: readonly Segment[],
  rowOf: (n: number) => T,
  /** Clause-`WHERE` conjuncts bucketed by the node variable each one reads (item 305). */
  clauseGates?: ReadonlyMap<string, Expr[]>,
): CountOf<T> | null => {
  if (
    segments.some(
      (s) => !plainRel(s.rel) || s.rel.variable !== undefined || s.rel.direction === 'both',
    )
  ) {
    return null;
  }

  const vars = [start.variable, ...segments.map((s) => s.node.variable)].filter(
    (v): v is string => v !== undefined,
  );

  if (new Set(vars).size !== vars.length) {
    return null; // a shared node variable is a self-join the sweep cannot express
  }

  const types = segments.map((s) => relTypeNames(s.rel.label));

  if (types.some((t) => t === null)) {
    return null;
  }

  // An INLINE constraint at ANY position, which the arm used to refuse outright via `plainNode`
  // (item 303). The argument is item 219's, one family along: a position the sweep VISITS has a
  // once-per-element place to put a gate, and the sweep visits every position. `null` from
  // `inlineOf` is an OPEN constraint — one whose value reads a variable — which still declines.
  const gateFor = (n: NodePattern): InlinePred | null | undefined =>
    gateWith(n, n.variable === undefined ? undefined : clauseGates?.get(n.variable));
  const startGate = gateFor(start);

  if (startGate === null) {
    return null;
  }

  const gates: (InlinePred | undefined)[] = [];

  for (const seg of segments) {
    const g = gateFor(seg.node);

    if (g === null) {
      return null;
    }

    gates.push(g);
  }

  const resolved = types as (string[] | undefined)[];
  const nodes = [start, ...segments.map((s) => s.node)];
  const allGates = [startGate, ...gates];
  const outs = segments.map((s) => s.rel.direction === 'out');
  const hops = segments.length;

  // READ THE CHAIN BACKWARDS when its LAST position is gated and its first is not (item 308).
  //
  // A gate on the last position costs twice: it needs a PASS of its own (item 303), and every
  // pass before it runs over the full frontier because nothing has narrowed the seed. A gate on
  // the FIRST position costs neither — it narrows the seed, and the degree tail answers the end.
  // Same chain, same gate, different position, at 20,000 vertices of degree 3:
  //
  // | gate at | ts      | native  |
  // | ------- | ------: | ------: |
  // | 0       | 19.2 ms | 0.29 ms |
  // | the end | 41.7 ms | 0.80 ms |
  //
  // A fixed-length chain read backwards is the SAME multiset of walks, so the count is identical;
  // this is `reversedTwoHop`'s argument at any depth, and the label seek survives it because
  // `candidateVertexSource` takes whichever end becomes the start.
  //
  // Not reversed when BOTH ends are gated (the extra pass is unavoidable either way) and not when
  // only the start is (it is already the cheap shape).
  const gateFlip = allGates[hops] !== undefined && allGates[0] === undefined;
  // AND READ IT BACKWARDS FOR A LABEL TOO (item 429). The gate rule above is blind to a LABEL on
  // the last position, so `MATCH (x)<-[:E]-(d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a:P)` seeded from `x` —
  // every vertex — where the same question spelled forwards seeds the `:P` bucket. The TS
  // spelling probe measured 478.8 ms forward against 710.9 reversed at four hops (1.49x) and
  // 674.4 against 856.7 at five (1.27x), under its own 2x flag threshold, for one question
  // written two ways.
  //
  // Which end is cheaper is a graph question, not a syntax one, so it is decided PER CALL — the
  // same shape `hopDrivesFar` uses for the one-hop projection, and the same comparison:
  // `candidateCount` returns the whole graph for a label it cannot seed from, so a STRICT
  // comparison also establishes that the end label is seekable. A tie keeps the forward reading,
  // because the two orders intern vertices differently and churning that for no gain is churn.
  //
  // Only consulted when NEITHER end is gated. The gated cases are item 308's and already decided:
  // a gate at the end alone flips, both ends gated does not (the extra pass is unavoidable), and
  // a gate at the start alone is already the cheap shape.
  //
  // NO TEST CAN POLICE THIS DECISION, and mutation says so: making the comparison non-strict
  // (so a tie flips) leaves every test green, because reading the chain backwards is
  // answer-preserving by construction. The tests police the CONSTRUCTION of the reversal — leg
  // order, each leg's direction, which position each label and gate lands on — and the 4.26x is
  // the only evidence the decision fires at all. Both halves are needed; neither substitutes.
  const labelMayFlip =
    allGates[0] === undefined && allGates[hops] === undefined && nodes[hops].label !== undefined;
  const buildFor = (flip: boolean) => {
    const legs: Leg[] = [];

    for (let j = 0; j < hops; j++) {
      // Reversed, leg `j` walks original hop `hops - 1 - j` the other way and lands on the
      // position that hop STARTED at.
      const i = flip ? hops - 1 - j : j;

      legs.push({
        out: flip ? !outs[i] : outs[i],
        types: resolved[i],
        label: nodes[flip ? i : i + 1].label,
        gate: allGates[flip ? i : i + 1],
      });
    }

    const seedAt = flip ? hops : 0;

    return { legs, startLabel: nodes[seedAt].label, startGate: allGates[seedAt] } as const;
  };
  // BOTH readings are built once, at compile time, and the per-call choice picks between two
  // ready objects. Building legs inside the closure would put allocation on every call, and the
  // sweep body is the hot loop this file has measured four times.
  const forward = buildFor(gateFlip);
  const reversed = labelMayFlip ? buildFor(true) : undefined;
  const startCount = nodes[0].label;
  const endCount = nodes[hops].label;

  // Delegated to a MODULE-SCOPE function, not written inline: this body is the hot loop, and
  // `ts-closure-size-is-load-bearing` is the one cost this file has measured four separate times.
  return (graph, params) => {
    const pick =
      reversed !== undefined && candidateCount(graph, endCount) < candidateCount(graph, startCount)
        ? reversed
        : forward;

    return rowOf(sweepChain({ graph, params, ...pick }));
  };
};

/** One position of a chain: which way its incoming hop runs, its edge types, its node label. */
type Leg = {
  out: boolean;
  types: string[] | undefined;
  label: LabelExpr | undefined;
  /** The landed node's INLINE constraint, applied once per distinct vertex reached here. */
  gate: InlinePred | undefined;
};

/** Everything one sweep needs, resolved once per query. An object so the call stays under the
 * parameter limit and so adding a position-level feature does not change every call site. */
type Sweep = {
  graph: Graph;
  params: Params;
  legs: readonly Leg[];
  startLabel: LabelExpr | undefined;
  startGate: InlinePred | undefined;
};

/**
 * The way-count sweep itself, over a LAZY DENSE INDEX: each vertex is interned to a slot the
 * first time it is REACHED, and the counts live in `Float64Array`s indexed by slot.
 *
 * The first version held the counts in a `Map<string, number>` and cost **2.30x this one** —
 * 850.2 against 370.2ms for five hops at 200,000 vertices / 600,000 edges, min of 5. Item 300
 * priced the mechanisms separately, and two of the three obvious explanations were WRONG:
 *
 * | variant                                      |    ms | vs the Map |
 * | -------------------------------------------- | ----: | ---------: |
 * | `Map<string, number>`, `edgesOfTypes`        | 850.2 |      1.00x |
 * | the generator removed, Map kept              | 712.7 |      1.19x |
 * | BOXED counters — one hash an edge, not two   | 627.7 |      1.35x |
 * | a lazy dense index with helper CALLS          | 663.3 |      1.28x |
 * | **a lazy dense index, every helper INLINED** | 370.2 |  **2.30x** |
 * | an EAGER index over all V, scanning 0..n     | 209.9 |      4.05x |
 * | a CSR of dense slots, no hash an edge        | 116.5 |      7.30x |
 *
 * So it is neither the generator frame (1.19x) nor `get`-plus-`set` (1.35x). The 2.30x is the
 * TIGHT TYPED-ARRAY LOOP, and routing the same algorithm through `intern`/`bump`/`widen` helpers
 * threw almost all of it away (1.28x) — which is why the interning below is written out longhand
 * rather than factored.
 *
 * The EAGER variant's extra 1.76x is declined on purpose, not missed. It scans `0..V` and skips
 * zeros instead of tracking a frontier, which is faster while the frontier is SATURATED and
 * costs O(V) memory and O(V) hashes whatever the frontier's real size — so a selective start over
 * a large graph would pay for the whole graph. Keeping memory proportional to the REACHED set is
 * the premise of this arm (items 296-298), and taking both would mean two sweeps, i.e. two
 * definitions of one thing. The CSR floor needs a dense adjacency the TS graph does not expose.
 */
const sweepChain = ({ graph, params, legs, startLabel, startGate }: Sweep): number => {
  const slotOf = new Map<string, number>();
  // Reused across every gate evaluation: `inlineHolds` binds the node's own variable into it, and
  // an inline constraint is proved element-local by `inlineOf` before it is carried, so nothing
  // else can observe what a previous position left behind.
  const binding = new Map<string, unknown>();
  const idOf: string[] = [];
  // The adjacency lookup CACHED PER SLOT, available only when every leg runs the same way — then
  // there is one index for the whole chain, so a slot's `byType` is the same on every pass.
  //
  // This is worth 1.73x and the measurement that found it is worth keeping. Item 300's micro
  // predicted 2.30x for the dense rewrite and the in-situ A/B delivered 1.27x; the micro had
  // cached this lookup, which it could only do because every one of ITS legs was `-[:E]->`.
  // Re-running the micro WITHOUT the cache gave 1.22x — agreeing with the in-situ number and
  // proving the 2.30x had never been available. So the cache is the gap, and a uniform direction
  // is the condition under which it is sound. `types` need not match: `edgesOfTypes` still
  // applies each leg's own types to the cached bucket map, and each leg keeps its own label.
  const uniform = legs.every((l) => l.out === legs[0].out);
  const cache: (Map<string, Set<Edge>> | undefined)[] | undefined = uniform ? [] : undefined;
  const oneIndex = legs[0].out ? graph.edgesFromByLabel : graph.edgesToByLabel;
  const cached = uniform ? oneIndex : undefined;
  let cap = 256;
  let ways = new Float64Array(cap);
  let frontier: number[] = [];

  for (const v of candidateVertexSource(graph, startLabel)) {
    if (!matchesLabel(v, startLabel) || !inlineHolds(startGate, v, binding, params, graph)) {
      continue;
    }

    const slot = idOf.length;

    slotOf.set(v.id, slot);
    idOf.push(v.id);
    cache?.push(cached?.get(v.id));

    if (slot >= cap) {
      cap *= 2;

      const grown = new Float64Array(cap);

      grown.set(ways);
      ways = grown;
    }

    ways[slot] = 1;
    frontier.push(slot);
  }

  // REJECTED, with its numbers: MEMOIZING a failed gate for the rest of the pass, by stamping a
  // negative sentinel into `next[to]` and skipping any later edge that finds one. It was written
  // first and then taken out, for three reasons in order of weight:
  //
  //  1. It is NOT a correctness mechanism, and mutation proved that rather than argued it — the
  //     mutants that removed the stamp and the one that removed the test BOTH survived the whole
  //     suite. Without the memo a rejected vertex is re-tested per incoming edge and still never
  //     enters the frontier, so the answer is identical.
  //  2. Its sign is NOT CONSISTENT. On a 4,000-vertex degree-24 fixture built to favour it (high
  //     in-degree, a selective gate where the pressure is highest) it was **0.87x — SLOWER** at
  //     the gated last position (16.19 against 18.66ms, disjoint ranges) while 1.27x FASTER at an
  //     interior (13.32 against 10.47ms, also disjoint). A cheap inline property compare is not
  //     obviously dearer than the extra branch the memo costs every edge.
  //  3. It put a NEGATIVE number inside a weight array and relied on "nothing reads it, because
  //     the slot is not in the frontier" — a live invariant to maintain for no proven gain.
  //
  // The asymptotic argument for it (per-vertex instead of per-edge gate evaluation) is real and
  // still did not show up as a win. Re-open only with a shape where it does, and a gate expensive
  // enough for the memo to pay for its own branch.

  // The LAST position normally needs no pass — a weighted sum of DEGREES answers it. With a GATE
  // it does need one, because a degree cannot say which of a vertex's edges land somewhere that
  // passes. So a gated last position simply gets the extra pass and the answer is the sum of the
  // way counts, which keeps the gate at once-per-vertex instead of once-per-edge. That is the
  // whole reason this arm can carry an END constraint where the degree products cannot.
  const lastGated = legs[legs.length - 1].gate !== undefined;
  const passes = lastGated ? legs.length : legs.length - 1;

  for (let i = 0; i < passes; i++) {
    const leg = legs[i];
    const far = effectiveLabel(graph, leg.label);
    const index = leg.out ? graph.edgesFromByLabel : graph.edgesToByLabel;
    const nextFrontier: number[] = [];
    // A SECOND array rather than updating in place: a slot can be both read and written in one
    // pass, through a self-loop or any cycle shorter than the chain.
    let next = new Float64Array(cap);

    // REJECTED, with its numbers, so it is not re-attempted: an INDEXED loop here instead of
    // `for...of` looked worth ~5% (715.5 against 752.7ms at five hops, three alternated rounds,
    // ranges disjoint) and did NOT reproduce — putting the indexed spelling back read 760.1, no
    // better than the `for...of` it was supposed to beat. The third round had moved every row on
    // that side (255 -> 290, 961 -> 1197), which is the tell. DISJOINT RANGES OVER THREE ROUNDS
    // ARE NOT PROOF WHEN THE WHOLE SIDE MOVES; the control has to hold still too, and here it did
    // on the first reading and not on the second.
    for (const slot of frontier) {
      // Nonzero by construction — a slot joins a frontier only on its 0 -> w transition.
      const w = ways[slot];

      for (const e of edgesOfTypes(
        cache === undefined ? index.get(idOf[slot]) : cache[slot],
        leg.types,
      )) {
        if (far !== undefined && !matchesLabel(leg.out ? e.to : e.from, far)) {
          continue;
        }

        const farId = leg.out ? e.toId : e.fromId;
        let to = slotOf.get(farId) ?? -1;

        if (to < 0) {
          to = idOf.length;
          slotOf.set(farId, to);
          idOf.push(farId);
          cache?.push(cached?.get(farId));

          if (to >= cap) {
            cap *= 2;

            const grownWays = new Float64Array(cap);
            const grownNext = new Float64Array(cap);

            grownWays.set(ways);
            grownNext.set(next);
            ways = grownWays;
            next = grownNext;
          }
        }

        if (next[to] === 0) {
          // The gate is applied on the 0 -> w TRANSITION, so the vertex is resolved only here and
          // an ungated pass never pays item 194's ~190ns endpoint lookup. A vertex that fails is
          // simply never pushed, and because `next[to]` stays 0 it is re-tested if another edge
          // reaches it — which is the behaviour, not an oversight. See below.
          if (
            leg.gate !== undefined &&
            !inlineHolds(leg.gate, leg.out ? e.to : e.from, binding, params, graph)
          ) {
            continue;
          }

          nextFrontier.push(to);
        }

        next[to] += w;
      }
    }

    // Nothing reaches this position, so nothing reaches any later one either.
    if (nextFrontier.length === 0) {
      return 0;
    }

    ways = next;
    frontier = nextFrontier;
  }

  let count = 0;

  if (lastGated) {
    // The extra pass already landed on the last position and applied its gate, so every surviving
    // way count IS a path.
    for (const slot of frontier) {
      count += ways[slot];
    }

    return count;
  }

  const last = legs[legs.length - 1];
  const lastFar = effectiveLabel(graph, last.label);

  for (const slot of frontier) {
    count += ways[slot] * side(graph, idOf[slot], last.out, last.types, lastFar);
  }

  return count;
};

/**
 * A three-segment clause predicate over exactly ONE INTERIOR node — the pair of positions the
 * degree product's walk visits. `null` declines the shape.
 *
 * A CONSTANT predicate (`WHERE 1 = 1`) is not admitted: it would have to pick a position
 * arbitrarily. The two-segment gate keeps one because a route already existed there to preserve;
 * a three-segment shape had none, so there is nothing to keep.
 */
/**
 * THE INTERIOR GATE AN INLINE CONSTRAINT GIVES (audit item 456).
 *
 * `interiorPredOf` reads a CLAUSE `WHERE` only, so `(b {k: 2})` and `(b WHERE b.k = 2)` left
 * `interiorPred` undefined and fell past the gated degree product onto a slower route while
 * `WHERE b.k = 2` took it. Measured on the spelling probe's three-hop chain, isolated one group
 * per process: clause 12.85-15.44 ms against both inline spellings at 240.80-246.19. **18x
 * between three ways of writing one question**, which is the class `CLAUDE.md` names and which
 * that probe had been reporting unattributed all session.
 *
 * The gate is identical once built — `inlineOf` already produces the `InlinePred` the product
 * applies — so this is the same route for the same question, not a second implementation.
 *
 * **POSITION B ONLY, and that is measured rather than tidy.** Item 222's reasoning is that the
 * product's walk ITERATES `b`, so a gate there costs once per VERTEX, while it meets `c` as each
 * middle edge's far end, once per MIDDLE EDGE. Routing an inline gate on `c` through the product
 * too made that shape 1.25x SLOWER — 369 ms on the sweep it had been taking against 460 on the
 * gated product — so the first version of this traded an 18x win for a regression on its
 * neighbour, and only the THIRD-position group in the same probe showed it. `c` keeps the sweep,
 * which carries an inline constraint at every position by construction.
 *
 * `null` declines the whole shortcut; `undefined` means no inline gate to take.
 *
 * The two refusals here are DEFENCE IN DEPTH, not teeth, and mutation says so: admitting an open
 * constraint and admitting a second interior gate both leave every test green. Each is
 * answer-preserving for its own reason — `{k: a.k}` answers the same either way, and the product
 * declines a shape whose second interior gate it cannot express, so the route falls through.
 * They stay because they make the intent explicit rather than relying on a downstream decline,
 * and item 447's lesson is to NAME a guard as defence in depth rather than imply teeth it lacks.
 * What IS load-bearing is `onB`: flipping it fails seven tests.
 */
const inlineInteriorGate = (
  segments: readonly Segment[],
  current: { pred: InlinePred; onB: boolean } | null | undefined,
): { pred: InlinePred; onB: boolean } | null | undefined => {
  // A clause `WHERE` has already supplied one, or this is not the three-segment shape: pass the
  // caller's value straight back, so the call site needs no condition of its own.
  if (current !== undefined || segments.length !== 3) {
    return current;
  }

  const inB = inlineOf(segments[0].node);

  if (inB === null) {
    return null;
  }

  if (inB !== undefined && inlineOf(segments[1].node) === undefined) {
    return { pred: inB, onB: true };
  }

  return undefined;
};

const interiorPredOf = (
  where: Expr,
  s1: Segment,
  s2: Segment,
): { pred: InlinePred; onB: boolean } | null => {
  const free = freePredicateVars(where);
  const bName = s1.node.variable;
  const cName = s2.node.variable;
  const readsOnly = (name: string | undefined): boolean =>
    name !== undefined && [...free].every((n) => n === name);
  const onB = readsOnly(bName);

  if (free.size === 0 || !(onB || readsOnly(cName))) {
    return null;
  }

  const bindVar = onB ? bName : cName;

  if (bindVar === undefined) {
    return null;
  }

  // `bindVar` is load-bearing: the predicate reads `b.k`, so `inlineHolds` has to bind the element
  // under that name before evaluating it. Dropping it evaluates against an empty binding.
  return { pred: { pred: compilePredicate(undefined, where, bindVar), bindVar }, onB };
};

/**
 * The three-segment count. Its own function because `patternCountOf` is at the complexity gate,
 * and because the ROUTING is the point: the two INTERIOR positions are carried and the two ENDS
 * are not.
 *
 * The product reaches `a` and `d` only as DEGREES, so a constraint there has no once-per-element
 * place to go. It ITERATES `b` and meets `c` as each middle edge's far end, so both are gated
 * where they are visited — item 219's reasoning one segment along.
 */
const threeSegmentCount = <T>(
  start: NodePattern,
  s1: Segment,
  s2: Segment,
  s3: Segment,
  rowOf: (n: number) => T,
  interiorPred: { pred: InlinePred; onB: boolean } | null | undefined,
): CountOf<T> | null => {
  // `inlineOf(start)` directly, NOT `patternCountOf`'s `inStart`: that is computed only for one and
  // two segments, so it is `undefined` here whether or not the start carries a constraint, and
  // reading it would let `MATCH (a {k: 1})-[:T]->…` through un-applied.
  const inB = inlineOf(s1.node);
  const inC = inlineOf(s2.node);

  if (
    inlineOf(start) !== undefined ||
    // Mutually redundant with `buildThreeHopCount`'s own `plainNode(s3.node)`: single mutation
    // cannot expose either, because whichever one goes the other still declines the pattern.
    // Removing BOTH is caught, which is what establishes the pair protects anything at all.
    inlineOf(s3.node) !== undefined ||
    // `null` is a constraint `inlineOf` refuses (a correlated property value), which declines.
    inB === null ||
    inC === null
  ) {
    return null;
  }

  const bPreds = inB === undefined ? [] : [inB];
  const cPreds = inC === undefined ? [] : [inC];

  // The CLAUSE spelling joins the inline ones here, so `WHERE b.k > 1`, `(b WHERE b.k > 1)` and
  // `(b {k: 2})` are one question on one route. They were 9360.5, 3945.9 and 560.7ms before this
  // item — a 2.4x and a 13.3x equivalent-spelling gap, sitting in the open.
  if (interiorPred !== null && interiorPred !== undefined) {
    (interiorPred.onB ? bPreds : cPreds).push(interiorPred.pred);
  }

  return buildThreeHopCount(s1, s2, s3, start, rowOf, { b: bPreds, c: cPreds });
};

/**
 * Which of the three two-hop count shapes answers this pattern. Its own function because
 * `patternCountOf` is at the complexity gate, and because the ROUTING is the interesting part:
 * all three shapes count the same thing and differ only in which end they drive from.
 *
 *   - no constraint, or a MIDDLE one → the degree product, which already iterates middles and so
 *     gates each exactly once (item 219);
 *   - a START constraint → the start-driven walk, because the product's start factor is a plain
 *     degree that a predicate would have to break apart (item 206);
 *   - an END constraint → the same start-driven walk over the REVERSED pattern, since counting
 *     `a->b->c` is counting `c<-b<-a` (item 220).
 */
const twoSegmentCount = <T>(
  start: NodePattern,
  s1: Segment,
  s2: Segment,
  rowOf: (n: number) => T,
  w: {
    inStart: InlinePred | undefined;
    pred: HopPred | undefined;
    midPred: InlinePred | undefined;
    endPred: HopPred | undefined;
    cstart: CNode | undefined;
    cend: CNode | undefined;
  },
): CountOf<T> | null => {
  const { inStart, pred, endPred, cstart, cend } = w;
  // The three INLINE middle spellings — `(b {k: 2})`, `(b {k: $p})`, `(b WHERE b.k > 1)` — reach
  // the same list as the clause `WHERE`. `null` is a constraint `inlineOf` refuses (a correlated
  // property value), which declines the whole shortcut as before.
  const inMid = inlineOf(s1.node);
  const inEnd = inlineOf(s2.node);

  if (inMid === null || inEnd === null) {
    return null;
  }

  const midPreds: InlinePred[] = [];

  if (inMid !== undefined) {
    midPreds.push(inMid);
  }

  if (w.midPred !== undefined) {
    midPreds.push(w.midPred);
  }

  const endConstrained = endPred !== undefined || inEnd !== undefined;

  // END-CONSTRAINED, and nothing else is: read the pattern backwards and hand it to the
  // start-driven walk, which is the same question (`reversedTwoHop`).
  //
  // `cend` is the end node's COMPILED form, so the reversed walk can SEEK an index on the end
  // property instead of scanning its label bucket. Item 178 is the precedent and the warning:
  // wiring only one end left "the far-anchored spelling of one question scanning the far label
  // bucket while its start-anchored twin seeked".
  if (endConstrained && inStart === undefined && pred === undefined && midPreds.length === 0) {
    const rev = reversedTwoHop(start, s1, s2);

    return buildFilteredTwoHopCount(rev.s1, rev.s2, rev.start, rowOf, {
      inStart: inEnd,
      pred: endPred,
      cstart: cend,
    });
  }

  // An end constraint ALONGSIDE a start or middle one has no route: the walk gates one end, and
  // the other would have to be applied per expanded edge. This decline is LOAD-BEARING, not
  // tidiness — without it an inline start plus a clause end predicate falls through to the
  // start-driven builder, which applies the start constraint and SILENTLY DROPS the end
  // predicate. A mutant proved it: removing this `return` passed every other test in the file
  // until the combination was written down.
  if (endConstrained) {
    return null;
  }

  // Unfiltered stays on the degree product: it iterates the MIDDLE once and multiplies two
  // degrees, so it never touches a start vertex at all. A MIDDLE constraint keeps the product for
  // the same reason — that is the end it already walks. A START constraint is what forces the
  // walk.
  return inStart === undefined && pred === undefined
    ? buildTwoHopCount(s1, s2, start, rowOf, midPreds)
    : buildFilteredTwoHopCount(s1, s2, start, rowOf, { inStart, pred, cstart });
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
 *   TS / 681ms native, and its answer is not |A| x |B|). A correlating conjunct still
 *   declines the whole product — but a conjunct reading only ONE pattern no longer
 *   does: `attributeConjuncts` hands it to that pattern's own count, so
 *   `MATCH (s:Tiny) MATCH (u:User) WHERE u.k > 5 RETURN count(*)` is again
 *   |Tiny| x |User where k > 5| rather than an enumerated product. That shape
 *   measured **174.9ms against 0.002ms** for the unfiltered spelling of the same
 *   question (item 274), and the left-side spelling 91.3ms — this engine pushed
 *   NEITHER side, where the Rust optimizer pushes both (items 273, and its left-side
 *   arm before that).
 * - **Every pattern must have its own shortcut.** `patternCountOf` returning `null`
 *   for any one of them declines the whole product rather than enumerating part of
 *   it.
 */
const productCountOf = <T>(
  matches: readonly Extract<Clause, { kind: 'match' }>[],
  rowOf: (n: number) => T,
): CountOf<T> | null => {
  // Collected across EVERY match clause before anything is attributed, because a clause
  // `WHERE` can read a pattern bound by an EARLIER clause: in
  // `MATCH (s:Tiny) MATCH (u:User) WHERE s.k > 1` the predicate hangs off the SECOND
  // match and reads the FIRST one's variable. Attributing within one clause finds no
  // owner there and declines — which is why the left-side spelling stayed slow on the
  // first attempt, measured at 91.3ms against the right-side spelling's new 4.4ms.
  //
  // Pushing such a conjunct onto the pattern it reads is exact for the same reason it is
  // in the Rust optimizer: the patterns are independent (disjointness is proved below),
  // so the product's rows are |A| x |B| and filtering A first admits exactly the rows
  // filtering the product would.
  const patterns: PathPattern[] = [];
  const vars: string[][] = [];
  const bound = new Set<string>();

  for (const match of matches) {
    for (const pattern of match.patterns) {
      const names = patternVarsOf(pattern);

      // A shared name is a JOIN, not a product — and it must be caught before any
      // attribution, since a name bound twice has no single owning pattern.
      for (const name of names) {
        if (bound.has(name)) {
          return null;
        }

        bound.add(name);
      }

      patterns.push(pattern);
      vars.push(names);
    }
  }

  const preds: (Expr | undefined)[] = patterns.map(() => undefined);

  for (const match of matches) {
    const attributed = attributeConjuncts(match.where, vars);

    if (attributed === null) {
      return null;
    }

    for (const [i, pred] of attributed.entries()) {
      if (pred === undefined) {
        continue;
      }

      const prev = preds[i];

      preds[i] = prev === undefined ? pred : { kind: 'and', items: [prev, pred] };
    }
  }

  const counts: CountOf<number>[] = [];

  for (const [i, pattern] of patterns.entries()) {
    const one = patternCountOf(pattern, preds[i], identityCount);

    if (one === null) {
      return null;
    }

    counts.push(one);
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

/**
 * Split a clause `WHERE` so each top-level conjunct lands on the ONE pattern it reads,
 * returning a predicate per pattern (`undefined` where none applies), or `null` to refuse
 * the whole product.
 *
 * AND is symmetric for a keep-TRUE filter, so re-grouping conjuncts across patterns is
 * exact — the same argument the Rust optimizer's `split_pushable` rests on. What is NOT
 * exact is attributing a conjunct that reads two patterns, which is a correlation and the
 * reason a `WHERE` used to decline outright.
 *
 * ### A SUBQUERY NEEDS NO SPECIAL CASE, which was MEASURED rather than assumed
 *
 * This was first written with a `hasSubqueryExpr` refusal, on the belief that
 * `freePredicateVars` reports nothing for `EXISTS { … }` so a conjunct reading another
 * pattern from inside one would look variable-free and be attributed to the wrong pattern.
 * **That belief was wrong, and so is the claim near the `nodeVar` check further down that
 * it reports the variables bound INSIDE a subquery.** Asked directly:
 *
 * ```text
 * u.k > 5                                        -> {u}
 * u.k = s.k                                      -> {s, u}
 * EXISTS { MATCH (v:User) WHERE v.k = s.k }      -> {s}      (not {}, and not {v})
 * COUNT { MATCH (v:User) WHERE v.k = s.k } > 0   -> {s}
 * NOT EXISTS { MATCH (v:User) WHERE v.k = s.k }  -> {s}
 * u.k > 5 OR EXISTS { … v.k = s.k }              -> {s, u}
 * EXISTS { MATCH (v:User) }                      -> {}
 * ```
 *
 * It reports exactly the OUTER variables a subquery reads and leaks no inner binding. So
 * attribution handles subqueries correctly with no help: a subquery reading one pattern is
 * attributed to it, and one reading two (the last-but-one row) declines like any other
 * correlation. The refusal was removed — it was not merely redundant, it declined shapes
 * that are sound to push.
 *
 * A conjunct with no free variables at all is left to the `owners.length !== 1` check,
 * which an empty free set fails by construction.
 */
const attributeConjuncts = (
  where: Expr | undefined,
  patternVars: readonly (readonly string[])[],
): (Expr | undefined)[] | null => {
  const out: (Expr | undefined)[] = patternVars.map(() => undefined);

  if (where === undefined) {
    return out;
  }

  const conjuncts: Expr[] = [];
  const flatten = (e: Expr): void => {
    if (e.kind === 'and') {
      for (const item of e.items) {
        flatten(item);
      }

      return;
    }

    conjuncts.push(e);
  };

  flatten(where);

  for (const conjunct of conjuncts) {
    const free = freePredicateVars(conjunct);

    // Exactly one pattern may be touched, and it must account for EVERY free variable —
    // so a conjunct also reading a name bound earlier (a `WITH` binding, say) refuses
    // rather than being attributed on the strength of a partial overlap.
    const owners = patternVars.flatMap((names, i) => (names.some((n) => free.has(n)) ? [i] : []));

    if (owners.length !== 1) {
      return null;
    }

    const [owner] = owners;
    const owned = patternVars[owner];

    if (![...free].every((n) => owned.includes(n))) {
      return null;
    }

    const prev = out[owner];

    out[owner] = prev === undefined ? conjunct : { kind: 'and', items: [prev, conjunct] };
  }

  return out;
};

/** `rowOf` for the product path, which wants the number itself. */
const identityCount = (n: number): number => n;

/** One side of a keyed count: the hop into the shared variable, from its point of view. */
type KeyedSide = {
  /** Edge types to accept, or `undefined` for any. */
  types: string[] | undefined;
  /** Walk the shared vertex's OUT edges (`(x)<-[:T]-(q)`) or its IN edges (`(x)-[:T]->(q)`). */
  out: boolean;
  /** The far end's label, which each counted neighbour must carry. */
  label: LabelExpr | undefined;
  /** The far end's inline constraint, or `undefined` when it is plain. */
  inFar: InlinePred | undefined;
};

/**
 * `MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q) RETURN count(*)` — two single hops that SHARE
 * their endpoint, counted without enumerating the pairs.
 *
 * This is the branch `productCountOf` refuses by design ("a shared variable is a JOIN, not a
 * product"). A join is not a product of the two counts, but it IS a sum of products, one per
 * value of the shared variable:
 *
 *     count = SUM over q of  c1(q) x c2(q)
 *
 * where `cN(q)` counts the edges of side N landing on `q` whose far end satisfies that side's
 * own constraints. Unconstrained, that is SUM of indeg(q)^2 — and the pairs include the
 * diagonal (`a` and `b` are distinct variables with no inequality between them), which the
 * square gets right for free.
 *
 * **O(V + E) instead of O(pairs), so the win grows with degree**: on 60 hubs of in-degree
 * 1..60 the pairs are 73,810 against 1,830 edges, and NEITHER engine had a closed form —
 * native enumerates too, just faster (ts 30.245ms, native 0.945ms). Measured 32-53x against
 * native, and unbounded against itself as degree rises (audit item 156).
 *
 * ### The oracle, and why the fixture matters
 *
 * `productCountOf`'s rule applies here too: the answer must match what both engines already
 * return, not an argument from what the shape ought to mean. **A ring fixture cannot check
 * this** — every in-degree is 1, so SUM d^2, SUM d and the edge count coincide and a wrong
 * formula agrees with a right one. The degrees in the tests are uneven for that reason, and
 * parallel edges are covered because a hop counts EDGES, not distinct neighbours.
 *
 * ### Refusals
 *
 * Everything outside the shape declines to the general path: anything but exactly two
 * single-segment patterns, a clause `WHERE` (it can correlate the sides — the same refusal
 * `productCountOf` makes), more or fewer than one shared variable, a shared variable that is
 * not both patterns' ENDPOINT, an edge variable or edge predicate (a shared edge variable would
 * be a second correlation, and an edge predicate would have to be applied per edge), an
 * undirected hop, a quantifier, a path variable, and a non-default selector.
 */
const keyedCountOf = <T>(
  matches: readonly Extract<Clause, { kind: 'match' }>[],
  rowOf: (n: number) => T,
): CountOf<T> | null => {
  const patterns: PathPattern[] = [];

  for (const match of matches) {
    if (match.where !== undefined) {
      return null; // a clause WHERE can correlate the two sides
    }

    patterns.push(...match.patterns);
  }

  if (patterns.length !== 2) {
    return null;
  }

  // The shared variable must be the ONLY overlap, and must be each pattern's endpoint.
  const [p0, p1] = patterns;
  const vars0 = new Set(patternVarsOf(p0));
  const shared = patternVarsOf(p1).filter((n) => vars0.has(n));

  if (shared.length !== 1) {
    return null;
  }

  const [key] = shared;
  const sides: KeyedSide[] = [];
  // Both patterns constrain the shared vertex, and BOTH constraints have to hold.
  const keyPreds: InlinePred[] = [];
  let keyLabel: LabelExpr | undefined;

  for (const pattern of patterns) {
    if (pattern.segments.length !== 1 || pattern.pathVar !== undefined) {
      return null;
    }

    if (pattern.selector !== undefined && pattern.selector !== 'walk') {
      return null;
    }

    const [{ rel, node }] = pattern.segments;

    if (
      rel.quantifier !== undefined ||
      rel.variable !== undefined ||
      rel.direction === 'both' ||
      relHasPredicate(rel)
    ) {
      return null;
    }

    const types = relTypeNames(rel.label);

    if (types === null) {
      return null;
    }

    // The ENDPOINT must be the shared variable, and the far end must not be.
    if (node.variable !== key || pattern.start.variable === key) {
      return null;
    }

    const inFar = inlineOf(pattern.start);
    const inKey = inlineOf(node);

    if (inFar === null || inKey === null) {
      return null;
    }

    if (inKey !== undefined) {
      keyPreds.push(inKey);
    }

    // Either pattern may name the shared vertex's label; a second, DIFFERENT one would have to
    // be intersected, so take the first and let `matchesLabel` apply it on top of the bucket.
    if (node.label !== undefined) {
      keyLabel ??= node.label;
    }

    sides.push({
      types: types ?? undefined,
      // `(x)-[:T]->(q)` is written out from `x`, so from `q` it is an IN edge.
      out: rel.direction !== 'out',
      label: pattern.start.label,
      inFar,
    });
  }

  const [s0, s1] = sides;
  const keyName = keyLabel?.kind === 'label' ? keyLabel.name : undefined;
  const keyLabels = patterns
    .map((p) => p.segments[0].node.label)
    .filter((l): l is LabelExpr => l !== undefined);

  return (graph, params) => {
    const binding = new Map<string, unknown>();
    const candidates: Iterable<Vertex> =
      keyName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(keyName) ?? []);
    // Count one side's edges landing on `q`, applying that side's far-end constraints. Edges,
    // not distinct neighbours: two parallel `a->q` edges are two matches of the pattern.
    const sideCount = (q: Vertex, sd: KeyedSide): number => {
      const byType = (sd.out ? graph.edgesFromByLabel : graph.edgesToByLabel).get(q.id);
      let n = 0;

      for (const e of edgesOfTypes(byType, sd.types)) {
        const far = sd.out ? e.to : e.from;

        if (matchesLabel(far, sd.label) && inlineHolds(sd.inFar, far, binding, params, graph)) {
          n += 1;
        }
      }

      return n;
    };
    let total = 0;

    for (const q of candidates) {
      // Every label either pattern wrote for the shared vertex, plus both inline constraints.
      let ok = true;

      for (const l of keyLabels) {
        if (!matchesLabel(q, l)) {
          ok = false;
          break;
        }
      }

      if (ok) {
        for (const kp of keyPreds) {
          if (!inlineHolds(kp, q, binding, params, graph)) {
            ok = false;
            break;
          }
        }
      }

      if (!ok) {
        continue;
      }

      const c0 = sideCount(q, s0);

      // A zero on one side makes the product zero, so the other side is not walked at all —
      // which is the common case for a vertex with edges of only one type.
      if (c0 !== 0) {
        total += c0 * sideCount(q, s1);
      }
    }

    return rowOf(total);
  };
};

/**
 * If a linear query is exactly `MATCH <1- or 2-segment path> RETURN count(*)`,
 * return a closure computing the count directly (O(1)/O(E)) instead of
 * enumerating every match; `null` if the shape doesn't qualify. The conditions
 * match the native engine: 1-hop directed, no props/WHERE; 2-hop additionally
 * needs anonymous rels and pairwise-distinct node variables (so the homomorphic
 * degree product is exact).
 */
/**
 * `MATCH (a:L) OPTIONAL MATCH (a)-[:T]->(x) RETURN count(*)` — a degree sum with a FLOOR.
 *
 * A left-outer hop yields one row per anchor either way: its matches, or one null-filled row.
 * So the count is `Σ max(degree, 1)`, which is the anchor bucket walked once — no row per path.
 * Every other rung refuses `optional` outright, so this shape fell to the general pipeline:
 * 710-858ms at 200,000 vertices / 1,000,000 edges against the native engine's 0.6 after item
 * 509 gave it the same arithmetic (audit item 510).
 *
 * The admission is narrow and each refusal is a position the floor cannot be computed through:
 *
 *   - the ANCHOR must be a lone node with no inline properties or `WHERE` (its bucket is what
 *     this walks; a constrained anchor is `buildNodeCount`'s tally and a different shape);
 *   - the optional pattern must start AT that variable, with one plain directed segment and no
 *     rel variable — `both` would need the undirected walk's self-loop care (items 478, 482),
 *     and is refused rather than guessed at;
 *   - the landing node may carry a LABEL (`side` already filters by it) but not properties or
 *     an inline `WHERE`, which decide BOTH which neighbours count and whether the anchor
 *     null-fills;
 *   - a clause `WHERE` on either side declines.
 */
/**
 * The output column of a projection that is exactly one bare `count(*)`, or `null`.
 *
 * The same shape `detectCountShortcut` requires, extracted so a second rung can ask for it
 * without a second copy of the `groupBy` / `having` / `ORDER BY` refusals — each of which is a
 * silent wrong answer rather than a slow path when a shortcut skips it (see that function's
 * note). `SKIP`/`LIMIT` are deliberately NOT refused; they page one row.
 */
const countStarColumn = (proj: Projection): string | null => {
  if (
    proj.star ||
    proj.distinct ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    (proj.orderBy?.length ?? 0) > 0 ||
    proj.items.length !== 1
  ) {
    return null;
  }

  const [item] = proj.items;
  const e = item.expr;

  if (e.kind !== 'func' || e.name !== 'count' || !e.star || e.distinct) {
    return null;
  }

  return item.alias ?? columnName(e);
};

export const detectOptionalHopCount = (
  clauses: readonly Clause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 3) {
    return null;
  }

  const [m, om, ret] = clauses;

  if (
    m.kind !== 'match' ||
    m.optional ||
    m.where !== undefined ||
    m.patterns.length !== 1 ||
    om.kind !== 'match' ||
    !om.optional ||
    om.where !== undefined ||
    om.patterns.length !== 1 ||
    ret.kind !== 'return'
  ) {
    return null;
  }

  const [anchor] = m.patterns;
  const v = anchor.start.variable;

  if (
    anchor.segments.length !== 0 ||
    anchor.pathVar !== undefined ||
    v === undefined ||
    !plainNode(anchor.start) ||
    (anchor.start.properties !== undefined && anchor.start.properties.length > 0)
  ) {
    return null;
  }

  const { label } = anchor.start;

  if (label !== undefined && label.kind !== 'label') {
    return null; // a compound label expression is not a bucket
  }

  const [hop] = om.patterns;

  if (hop.pathVar !== undefined || hop.segments.length !== 1 || hop.start.variable !== v) {
    return null;
  }

  const [seg] = hop.segments;
  const { rel, node } = seg;

  if (
    !plainRel(rel) ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    !plainNode(node) ||
    (node.properties !== undefined && node.properties.length > 0)
  ) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  const column = countStarColumn(ret.projection);

  if (column === null) {
    return null;
  }

  const proj = ret.projection;
  const out = rel.direction === 'out';
  const far = node.label;
  const name = label?.name;
  const one = (graph: Graph): Row => {
    const vertices: Iterable<Vertex> =
      name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []);
    let total = 0;

    for (const vertex of vertices) {
      // The FLOOR is the whole difference from the plain hop count: an anchor with no
      // matching neighbour still contributes its one null-filled row.
      const d = sideOfVertex(vertex, out, types, far);

      total += d === 0 ? 1 : d;
    }

    return { [column]: total };
  };

  if (proj.skip === undefined && proj.limit === undefined) {
    return (graph) => [one(graph)];
  }

  return (graph, params) => pageOneRow(() => one(graph), graph, params, proj.skip, proj.limit);
};

export const detectCountShortcut = (
  clauses: readonly Clause[],
  compiled?: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
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
  // SKIP/LIMIT are NOT refused. An un-grouped `count(*)` with one item is exactly ONE row, so
  // a page over it is arithmetic on a one-element list — and refusing it made `LIMIT 1`, which
  // cannot change the answer, cost 380x the same query without it (0.021ms vs 7.979ms over
  // 20,000 nodes, against native's 0.003ms either way). Two spellings of one question, one of
  // them hundreds of times slower: the bug class this repo is named after. See `pageOneRow`.
  if (
    proj.star ||
    proj.distinct ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    (proj.orderBy?.length ?? 0) > 0 ||
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
  const one = ((): CountFn | null => {
    if (matches.length === 1 && m.patterns.length === 1) {
      // The COMPILED start node carries the seed hints lifted from the `WHERE`, which is what
      // lets the node tally seek an index instead of scanning the label bucket. Optional so a
      // caller without the compiled clauses still gets the (bucket-scanning) shortcut.
      const cm = compiled?.[0];
      const cstart = cm?.kind === 'match' ? cm.patterns[0]?.start : undefined;
      // Its FAR mirror, so the far-side walk can seek too (item 178). Item 176 wired only the
      // start, which left the far-anchored spelling of one question scanning the far label
      // bucket while its start-anchored twin seeked.
      const cfar = cm?.kind === 'match' ? cm.patterns[0]?.segments[0]?.node : undefined;
      // And the END of a two-segment pattern, which the reversed reading seeds from (item 220).
      // `cfar` is `segments[0].node` — the MIDDLE when there are two segments, not the end.
      const cend = cm?.kind === 'match' ? cm.patterns[0]?.segments[1]?.node : undefined;

      return patternCountOf(m.patterns[0], m.where, rowOf, cstart, cfar, cend);
    }

    // A product first — it is the cheaper answer and covers disjoint patterns. When it
    // declines for a SHARED variable, the keyed sum-of-products may still apply.
    return productCountOf(matches, rowOf) ?? keyedCountOf(matches, rowOf);
  })();

  if (one === null) {
    return null;
  }

  // Unpaged is the overwhelmingly common spelling, so it returns the row with no window
  // arithmetic and no array slice at all.
  if (proj.skip === undefined && proj.limit === undefined) {
    return (graph, params) => [one(graph, params)];
  }

  return (graph, params) => pageOneRow(one, graph, params, proj.skip, proj.limit);
};

/**
 * Apply a `SKIP`/`LIMIT` window to a shortcut that produces exactly ONE row.
 *
 * The window is resolved per execution because either bound may be a `$param`. Three cases,
 * and all three match what the general path does with a one-row projection:
 *
 *   - `LIMIT 0` — no rows, and the count is never computed. The general path returns `[]`
 *     from `applyProjection` before projecting anything, for the reason recorded there: a
 *     zero limit must not be the one limit that evaluates rows it discards.
 *   - `SKIP n`, `n >= 1` — the single row is skipped, so no rows.
 *   - otherwise the row survives, because a `LIMIT` of 1 or more over one row keeps it.
 *
 * A negative or non-integer bound is not reachable here: `noteCountParam` validates both
 * up front, the same as for every other paged shape.
 */
const pageOneRow = (
  one: CountFn,
  graph: Graph,
  params: Params,
  skip: CountValue | undefined,
  limit: CountValue | undefined,
): Row[] => {
  const limitN = resolveCount(limit, params);

  if (limitN === 0) {
    return [];
  }

  if ((resolveCount(skip, params) ?? 0) > 0) {
    return [];
  }

  return [one(graph, params)];
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
/**
 * Apply a `SKIP`/`LIMIT` window to a grouped shortcut's rows, which are in first-seen group
 * order — the same order the general path emits, so the same window selects the same groups.
 *
 * Unpaged returns the array untouched rather than slicing a copy of it, since that is the
 * common spelling. Bounds resolve per execution because either may be a `$param`.
 */
export const pageGroups = (
  rows: Row[],
  params: Params,
  skip: CountValue | undefined,
  limit: CountValue | undefined,
): Row[] => {
  if (skip === undefined && limit === undefined) {
    return rows;
  }

  const skipN = resolveCount(skip, params) ?? 0;
  const limitN = resolveCount(limit, params);

  return rows.slice(skipN, limitN === undefined ? undefined : skipN + limitN);
};

/**
 * Is this `HAVING` one the tally can apply to its OWN rows?
 *
 * `HAVING` filters whole groups AFTER aggregation, and the tally's output is already one row per
 * group — so the filter is a post-filter on those, where the general path builds every binding
 * first. The tally alone is 3.95ms on 200,000 nodes and every `HAVING` spelling of it was
 * 53.7-56.4ms, about 14x (audit item 199).
 *
 * The ONE condition: every aggregate in the predicate must be `count(*)`. That is what the tally
 * has — a count and a representative row — and a `sum(n.k)` or `avg(n.k)` would need the group's
 * members, which this path never materializes. A non-aggregate reference is fine whatever it
 * reads: it is evaluated against the representative, exactly as the general path evaluates it
 * against `group[0]`.
 */
const countOnlyAggregates = (e: Expr | undefined): boolean => {
  if (e === undefined) {
    return true;
  }

  if (e.kind === 'func' && AGGREGATES.has(e.name)) {
    return isStarCount(e);
  }

  // Structural walk over every child, so a new `Expr` arm cannot slip an aggregate past this —
  // the same reason `hasSubquery` in the executor is written as a generic walk.
  return Object.values(e).every((child) => {
    if (Array.isArray(child)) {
      return child.every(
        (c) => typeof c !== 'object' || c === null || countOnlyAggregates(c as Expr),
      );
    }

    return typeof child !== 'object' || child === null || countOnlyAggregates(child as Expr);
  });
};

/**
 * Drop the groups a `HAVING` does not keep, before any sort or window — the order the general
 * path applies them in.
 *
 * `count(*)` compiles to `group.length` and nothing else, which is why a `new Array(n)` stands in
 * for the group: it is O(1) (a holey array has a length and no storage) and it is the minimal
 * object with the one property that is read. THAT COUPLING IS REAL and is the reason
 * `countOnlyAggregates` above refuses every other aggregate — one that iterated the group would
 * see holes. The behaviour is pinned end-to-end by tests rather than by reading the fold.
 *
 * ISO's rule: keep a group only when the predicate is exactly TRUE. NULL and false both drop,
 * which `asTruth(...) === true` gives.
 */
const keepGroups = (
  slots: readonly GroupSlot[],
  having: CompiledExpr | undefined,
  repVar: string,
  params: Params,
  graph: Graph,
): readonly GroupSlot[] => {
  if (having === undefined) {
    return slots;
  }

  const binding = new Map<string, unknown>();

  return slots.filter((slot) => {
    binding.set(repVar, slot.rep);

    return asTruth(having({ binding, params, graph, group: new Array(slot.n) })) === true;
  });
};

/** One `ORDER BY` key resolved to an output COLUMN of the tally's two-column row. */
type ColSort = { col: string; descending: boolean; nullsFirst: boolean | undefined };

/**
 * One group's key value, running count, and the vertex that OPENED it.
 *
 * The representative is what `HAVING` needs: ISO evaluates it against a row of the group, and the
 * general path uses `group[0]` — the FIRST binding, which is the one that opened the group, and
 * the tally visits vertices in the general path's order. So the two pick the same row, which is
 * what lets a `HAVING` reading a non-key property agree (audit item 199).
 */
type GroupSlot = { key: unknown; n: number; rep: Vertex };

/**
 * A SET of values under `valueKey`'s equivalence, keyed on the raw value wherever that is exact.
 *
 * The same trade `groupIndex` makes below, for the callers that only need "have I seen this?" —
 * `add` answers true when the value is NEW, so a first-wins dedup needs nothing else. See
 * `groupIndex` for why a raw-keyed `Map`/`Set` is exactly `valueKey`'s equivalence on primitives
 * (SameValueZero gives the `-0`/`0` and `NaN` rules it documents) and why non-primitives need a
 * SECOND container rather than a shared one (audit item 193).
 */
export const valueSet = (): { add: (v: unknown) => boolean } => {
  const prim = new Set<unknown>();
  let structural: Set<string> | undefined;

  return {
    add: (v: unknown): boolean => {
      // `null` is a primitive but `typeof null` is 'object', so it is tested first.
      if (v === null || typeof v !== 'object') {
        if (prim.has(v)) {
          return false;
        }

        prim.add(v);

        return true;
      }

      structural ??= new Set();

      const k = valueKey(v);

      if (structural.has(k)) {
        return false;
      }

      structural.add(k);

      return true;
    },
  };
};

/**
 * The tally's group index, keyed on the RAW value wherever that is exact.
 *
 * A tally built its index as `Map<string, slot>` with `valueKey(raw)` as the key, so a bucket of
 * 200,000 vertices with 90 distinct values built 200,000 STRINGS to find 90 slots. That string is
 * the cost of the whole tally, not the property read:
 *
 *     iterate the bucket only                      1.6ns a vertex
 *     + read the property                         10.3ns
 *     + tally, STRING key                         50.7ns     <- and the real query is 45.6ns
 *     + tally, RAW key                            12.5ns     4.1x
 *
 * A raw-keyed `Map` is EXACTLY `valueKey`'s equivalence for primitives, which is checked rather
 * than assumed — `Map` uses SameValueZero, so `-0` and `0` are ONE key and `NaN` equals itself,
 * which are precisely the two rules `valueKey` documents; and types stay distinct, so `1`, `'1'`
 * and `true` are three keys there as they are three prefixes here.
 *
 * Non-primitives are NOT raw-keyable — two equal lists, records, temporals or elements are
 * different objects — so they keep `valueKey` in a SECOND map. Two maps rather than one mixed
 * one because the schemes would otherwise COLLIDE: a raw string `'n1'` and `valueKey(1)` are the
 * same string. First-seen group order, which is the pinned contract, comes from the shared
 * `slots` array and not from either map's insertion order (audit item 192).
 */
const groupIndex = (): {
  bump: (raw: unknown, by: number, rep: Vertex) => void;
  slots: readonly GroupSlot[];
} => {
  const prim = new Map<unknown, GroupSlot>();
  const slots: GroupSlot[] = [];
  let structural: Map<string, GroupSlot> | undefined;

  const open = (raw: unknown, by: number, rep: Vertex): GroupSlot => {
    const slot = { key: raw, n: by, rep };
    slots.push(slot);

    return slot;
  };

  return {
    bump: (raw: unknown, by: number, rep: Vertex): void => {
      // `null` is a primitive but `typeof null` is 'object', so it is tested first.
      if (raw === null || typeof raw !== 'object') {
        const hit = prim.get(raw);

        if (hit === undefined) {
          prim.set(raw, open(raw, by, rep));
        } else {
          hit.n += by;
        }

        return;
      }

      structural ??= new Map();

      const gk = valueKey(raw);
      const hit = structural.get(gk);

      if (hit === undefined) {
        structural.set(gk, open(raw, by, rep));
      } else {
        hit.n += by;
      }
    },
    slots,
  };
};

/**
 * Sort the tally's own rows. Its output is ONE ROW PER GROUP — the answer — so this sorts at
 * most as many rows as it returns, where the general path sorted one row per input ELEMENT.
 * Uses `compareSort`, the engine's own comparator, so DESC and the NULLS placement match it
 * rather than being re-derived.
 */
const sortGroupRows = (rows: Row[], sort: readonly ColSort[]): Row[] => {
  if (sort.length === 0) {
    return rows;
  }

  return rows.sort((a, b) => {
    for (const s of sort) {
      const c = compareSort(a[s.col], b[s.col], s.descending, s.nullsFirst);

      if (c !== 0) {
        return c;
      }
    }

    return 0;
  });
};

/**
 * Every `ORDER BY` key resolved to one of the tally's two output columns, or `null` to decline.
 *
 * The tally declined every `ORDER BY`, and its own note said why: the sort reorders the groups
 * BEFORE the window and the tally does not sort. Sorting its output first is exactly that order,
 * and the sort is over the groups rather than over the input:
 *
 *     LET a = n.age RETURN a, count(*) AS c GROUP BY a                   8.35ms
 *     LET a = n.age RETURN a, count(*) AS c GROUP BY a ORDER BY a       69.89ms
 *     LET a = n.age RETURN a, count(*) AS c GROUP BY a ORDER BY c DESC  75.67ms
 *
 * 8.4x, and the last of those is the top-categories-by-count shape (audit item 190).
 *
 * EVERY key must be an output column, which is what makes several keys safe here where item 189
 * had to refuse them: an output column's value is already computed by the tally, so nothing is
 * left unevaluated and no raise can be swallowed. A key that is any other expression declines.
 *
 * Accepted spellings per key: the count column by name, the key column by name (which covers
 * `ORDER BY a` naming the `LET`, since the `LET` name IS the column), or the key EXPRESSION
 * itself (`ORDER BY n.k` beside `RETURN n.k AS a`).
 */
const colSortsOf = (
  keys: readonly SortItem[],
  keyCol: string,
  countCol: string,
  keyExpr: Expr,
): ColSort[] | null => {
  // Two items sharing one output name would collapse into a single row key, so which column a
  // name refers to is ambiguous. It cannot be resolved, so it is refused.
  if (keyCol === countCol) {
    return null;
  }

  const out: ColSort[] = [];

  for (const k of keys) {
    const byName =
      k.expr.kind === 'var' && (k.expr.name === keyCol || k.expr.name === countCol)
        ? k.expr.name
        : undefined;
    const col = byName ?? (sameGroupingExpr(k.expr, keyExpr) ? keyCol : undefined);

    if (col === undefined) {
      return null;
    }

    out.push({ col, descending: k.descending, nullsFirst: k.nullsFirst });
  }

  return out;
};

/**
 * Does this page keep NO rows whatever the data? Then the tally must not run at all.
 *
 * `LIMIT 0` emits nothing, and the general path returns `[]` from `applyProjection` BEFORE
 * projecting anything — so a shortcut that tallied first and sliced to empty afterwards would
 * evaluate expressions on rows the general path never touches. That matters because the
 * three-clause grouped form carries a `LET` whose expression CAN fault: with
 * `LET s = 1 / (n.k - 7) … LIMIT 0` the general path returns no rows, and a tally that ran
 * first would raise. Same rule as items 139 and 142 — a fast path may not evaluate an
 * expression on an element the general path never reaches.
 */
export const pageIsEmpty = (params: Params, limit: CountValue | undefined): boolean =>
  resolveCount(limit, params) === 0;

/**
 * A grouping element is a bound name or the `n.key` property spelling — ISO's `groupingElement`
 * is a `bindingVariableReference`, and the property form is what this engine accepts on top of
 * it (see `CProjection.groupKeyNames`). Equality over those two shapes is all this needs, and
 * anything else answers `false` and declines.
 *
 * Lives here rather than in `hop-projection`, which already imports from this module — the other
 * direction would be a cycle.
 */
export const sameGroupingExpr = (a: Expr, b: Expr): boolean =>
  (a.kind === 'var' && b.kind === 'var' && a.name === b.name) ||
  (a.kind === 'prop' && b.kind === 'prop' && a.variable === b.variable && a.key === b.key);

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
): { countAt: number; sort: readonly ColSort[]; having: CompiledExpr | undefined } | null => {
  // SKIP/LIMIT are NOT refused. A grouped count's rows come out in FIRST-SEEN group order,
  // which is the pinned contract both engines keep (a `Map`'s insertion order here, the
  // general path's own `Map<string, Binding[]>` there) — so a window over them is a slice of
  // this list and equals the general path's window over its list.
  //
  // `ORDER BY` used to decline here, because it reorders the groups BEFORE the window and the
  // tally did not sort. It sorts now (`colSortsOf` + `sortGroupRows`, item 190), which is that
  // same order, applied to one row per GROUP instead of one per input element.
  if (proj.star || proj.distinct || proj.items.length !== 2) {
    return null;
  }

  // `HAVING` used to decline here. It is applied to the tally's OWN rows now (item 199), which is
  // where it belongs — one row per group already exists — provided every aggregate in it is
  // `count(*)`, which is all the tally has.
  if (!countOnlyAggregates(proj.having)) {
    return null;
  }

  const countAt = proj.items.findIndex((i) => isStarCount(i.expr));

  if (countAt === -1) {
    return null;
  }

  const keyItem = proj.items[1 - countAt];

  // `GROUP BY` used to be accepted ONLY in the `LET` form, naming the bound variable. That left
  // ISO's SELECT spelling — which writes the PROPERTY, `GROUP BY n.age`, and has no `LET` to name
  // — declining the tally entirely:
  //
  //     MATCH (n:P) LET a = n.age RETURN a, count(*) AS c GROUP BY a            3.96ms
  //     SELECT n.age AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.age       52.36ms
  //
  // One question, 13x apart, and `HAVING` had nothing to do with it — the SELECT form never
  // reached the tally with or without one. The property spelling is accepted now, by the same
  // `sameGroupingExpr` rule item 188 applied to the DISTINCT path one file over: the grouping
  // element must BE the key item's expression (audit item 199).
  if (proj.groupBy !== undefined) {
    const keys = proj.groupBy;

    if (keys.length !== 1) {
      return null;
    }

    const [k] = keys;
    const namesTheLet = letName !== undefined && k.kind === 'var' && k.name === letName;

    if (!namesTheLet && !sameGroupingExpr(k, keyItem.expr)) {
      return null;
    }
  }

  const sort =
    (proj.orderBy?.length ?? 0) === 0
      ? []
      : colSortsOf(
          proj.orderBy ?? [],
          keyItem.alias ?? columnName(keyItem.expr),
          proj.items[countAt].alias ?? columnName(proj.items[countAt].expr),
          keyItem.expr,
        );

  if (sort === null) {
    return null;
  }

  // Compiled HERE: this detector only ever sees the AST, so there is no compiled `having` to
  // borrow from the projection the general path builds.
  return {
    countAt,
    sort,
    having: proj.having === undefined ? undefined : compileExpr(proj.having),
  };
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
/**
 * Expression kinds whose value depends on the ROW and nothing else — no pattern to match, no
 * subquery to run, no group to fold.
 *
 * An ALLOWLIST rather than a denylist, deliberately: a new `Expr` arm added later declines this
 * fast path instead of silently taking it and answering from a shape it was never checked
 * against. `countOnlyAggregates` above is written as a structural walk for the same reason, and
 * this is the stricter version of that argument — a wrong answer here would be a wrong ROW, not
 * a wrong count.
 *
 * `exists` and `scalar` are the subquery arms and are the reason the walk cannot simply trust
 * `freePredicateVars`: it returns the EMPTY set for a subquery — it does not descend into one at
 * all, which item 213 established while tracking an `ORDER BY` bug caused by exactly that. So a
 * free-variable check sees NOTHING inside an `EXISTS { … }` and cannot be what refuses it; the
 * allowlist is.
 */
const ROW_LOCAL_KINDS: ReadonlySet<string> = new Set([
  'and',
  'arith',
  'case',
  'compare',
  'concat',
  'field',
  'func',
  'in',
  'index',
  'label',
  'list',
  'lit',
  'neg',
  'not',
  'or',
  'param',
  'prop',
  'property_exists',
  'record',
  'var',
  'xor',
]);

export const rowLocal = (e: Expr | undefined): boolean => {
  if (e === undefined) {
    return true;
  }

  if (!ROW_LOCAL_KINDS.has(e.kind)) {
    return false;
  }

  // An aggregate needs the group this path never builds.
  if (e.kind === 'func' && AGGREGATES.has(e.name)) {
    return false;
  }

  return Object.values(e).every(rowLocalChild);
};

/**
 * One child of an `Expr`, which may be a nested ARRAY or a plain structural object rather than an
 * `Expr` itself.
 *
 * The nesting is load-bearing and the first version got it wrong: an `arith` node is
 * `{ head, tail: [['/', <Expr>]] }` — an array of ARRAYS — and a walk that only descended one
 * array level called this on `['/', <Expr>]`, whose `kind` is `undefined`, so it rejected the
 * node. The effect was silent and ONE-SIDED: every arithmetic expression declined item 204's node
 * projection, and the test that was supposed to cover it ("a computed item, not just a bare
 * property") compared the fast path against the general path and passed because BOTH were the
 * general path. Found while investigating why a start-filtered hop with an arithmetic predicate
 * never reached the walk (audit item 207).
 *
 * Descending into a non-`Expr` object is safe because every `Expr` carries a `kind`, so the
 * allowlist still sees every expression on the way down — only the wrappers are passed through.
 */
const rowLocalChild = (child: unknown): boolean => {
  if (Array.isArray(child)) {
    return child.every(rowLocalChild);
  }

  if (typeof child !== 'object' || child === null) {
    return true;
  }

  const rec = child as Record<string, unknown>;

  return typeof rec.kind === 'string'
    ? rowLocal(child as Expr)
    : Object.values(rec).every(rowLocalChild);
};

/**
 * Expression kinds that OPEN A NESTED SCOPE: a subquery. Admissible in a projected ITEM and never
 * in the predicate.
 *
 * The three are `exists` (`EXISTS { … }`), `countSubquery` (`COUNT { … }`) and `valueSubquery`.
 * `scalar` is NOT one — it is `{ kind: 'scalar', category }` — and the first version of this set
 * said `['exists', 'scalar']`, which both admitted a non-subquery and missed the two that matter.
 * The cause was a grep: `kind: '[a-z_]+'` over the AST silently skips every camelCase arm, so
 * `countSubquery` and `valueSubquery` were never in the list I worked from. The measurement is
 * what caught it — `EXISTS{}` went 91.4ns to 34.2 while `COUNT{}` did not move at all.
 *
 * The asymmetry is the point. The predicate is evaluated by the per-vertex gate, and item 175
 * gave the seed gate a CHEAP-CONJUNCT-FIRST order precisely so
 * `WHERE u.k = 'nope' AND <faulting subquery>` never reaches the subquery — a gate that evaluates
 * the whole predicate at once loses that, which is why `rowLocal` refuses these outright.
 *
 * An ITEM is different: it is evaluated once per row that SURVIVES the filter, on either path, so
 * a subquery there costs the same in both. And it is where the cost actually was —
 * `MATCH (u:User) WHERE u.name = $n RETURN COUNT { (u)-[:FOLLOWS]->{1,3}(x) }` was 94.3ns a
 * scanned vertex against the fast path's 38.2, and a ONE-HOP `COUNT{}` item measured 90.7ns, so
 * the subquery itself is ~4ns of it and the rest is the general-path scan (audit item 208).
 */
const SUBQUERY_KINDS: ReadonlySet<string> = new Set(['exists', 'countSubquery', 'valueSubquery']);

/**
 * One projected ITEM: row-local, but allowed to contain a subquery.
 *
 * The walk STOPS at a subquery rather than descending into it, which is what makes this sound:
 * the interior is a nested scope that the general path compiles and runs identically, and its
 * variables are bound by its own patterns. Outside subqueries the `rowLocal` allowlist still
 * applies in full, so a new `Expr` arm declines rather than slipping through.
 *
 * An aggregate is still refused — it needs the group this path never builds — and the check is
 * only applied OUTSIDE subqueries, because `count(*)` inside a `COUNT { … }` belongs to that
 * subquery, not to this projection.
 */
const itemLocal = (e: Expr | undefined): boolean => {
  if (e === undefined) {
    return true;
  }

  if (SUBQUERY_KINDS.has(e.kind)) {
    return true;
  }

  if (!ROW_LOCAL_KINDS.has(e.kind)) {
    return false;
  }

  if (e.kind === 'func' && AGGREGATES.has(e.name)) {
    return false;
  }

  return Object.values(e).every(itemLocalChild);
};

const itemLocalChild = (child: unknown): boolean => {
  if (Array.isArray(child)) {
    return child.every(itemLocalChild);
  }

  if (typeof child !== 'object' || child === null) {
    return true;
  }

  const rec = child as Record<string, unknown>;

  return typeof rec.kind === 'string'
    ? itemLocal(child as Expr)
    : Object.values(rec).every(itemLocalChild);
};

/** Does this expression contain a subquery anywhere? */
const hasSubqueryExpr = (e: unknown): boolean => {
  if (Array.isArray(e)) {
    return e.some(hasSubqueryExpr);
  }

  if (typeof e !== 'object' || e === null) {
    return false;
  }

  const rec = e as Record<string, unknown>;

  if (typeof rec.kind === 'string' && SUBQUERY_KINDS.has(rec.kind)) {
    return true;
  }

  return Object.values(rec).some(hasSubqueryExpr);
};

/**
 * The node scan's clause `WHERE`, compiled into one `InlinePred` — or `'decline'` when this path
 * cannot carry it.
 *
 * Extracted because adding the subquery branch took `detectNodeProjection` to a complexity of 37
 * against a limit of 35 (audit item 209). It is the natural seam: everything here is about the
 * ONE predicate, and nothing in it touches the projection or the scan.
 */
const nodeWhereOf = (where: Expr, nodeVar: string): InlinePred | 'decline' => {
  // A SUBQUERY is admissible in this predicate, unlike `detectHopProjection`'s, and the reason
  // is the segment count. Here the pattern has ZERO segments, so every candidate vertex yields
  // exactly ONE row — "once per vertex" and "once per complete match" are the same thing, and
  // evaluating the predicate per vertex is exactly what the general path does per row. A HOP
  // has neither property (one start can yield many rows or none), which is why item 207 keeps
  // `rowLocal` there and refuses subqueries outright.
  //
  // The gate is `gatePredicate` — the general path's OWN prefilter, not a re-derivation — so
  // the conjunct ORDER and the stop-at-first-non-TRUE semantics are identical by construction.
  // That ordering is item 175's: a `EXISTS {…}` / `COUNT {…}` conjunct is not reached for a
  // vertex a cheap conjunct already rejected. It is also the observable behaviour already,
  // which was checked rather than assumed — `WHERE k = $miss AND EXISTS { … /0 … }` answers
  // `[]` on the general path both indexed and unindexed, so deferring the subquery does not
  // introduce a raise the general path lacks.
  //
  // Measured (20,000 users, the `analytic: cycle detection` shape), holding the scan fixed and
  // varying the subquery's cost — the technique item 208 used:
  //
  //     no subquery at all                53ns a vertex
  //     a TRIVIAL subquery in the WHERE   86ns
  //     the 2-4 hop cycle subquery        98ns
  //
  // 33ns for merely HAVING a subquery against 12ns for the subquery's own extra work, so the
  // cost was the general-path scan rather than the subquery (audit item 209).
  if (!itemLocal(where)) {
    return 'decline';
  }

  // Skipped for a subquery-bearing predicate for the reason given above the items' copy of this
  // check: `freePredicateVars` reports the variables bound INSIDE a subquery, so it would
  // refuse every one of them, and `nodeVar` is the only name anything here can be bound to.
  if (!hasSubqueryExpr(where)) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== nodeVar) {
        return 'decline';
      }
    }
  }

  // `props` used to be EMPTY on both branches, and item 210's version of this comment said so
  // correctly: `compilePredicate(properties, where)` compiled the `properties` it was GIVEN and
  // left the `where` an expression, lifting nothing out of it. That stopped being true in item
  // 224, which added `eqProps` — the conjuncts of a `WHERE` that are `<ownVar>.<key> = <non-null
  // literal>`, compiled to read the ELEMENT directly rather than through the binding — and item
  // 230, which extended it from one comparison to an all-`=` AND-chain.
  //
  // `nodeVar` is passed as that own variable, and the free-variable loop directly above is the
  // proof the argument requires: every free name of `where` IS `nodeVar`, so the predicate is
  // element-local. Without it the clause spelling of a filtered projection cost 9.64 ms against
  // the inline spelling's 6.78 on 200,000 vertices — 1.42x for one question, and the last group
  // the spelling probe still flagged (audit item 231).
  //
  // The two branches still differ by `gatePredicate` against `compileExpr`, and that
  // discrimination is load-bearing for a measured reason: the mutant routing EVERY predicate
  // through `gatePredicate` costs 18% on the indexed point lookup (95.4k -> 80.8k ops/s) from the
  // indirection alone. A subquery-bearing predicate has nothing else available anyway —
  // `compilePredicate` does not know about subqueries, and a correlated sub-pattern is not a
  // property equality — so `ownVar` would buy it nothing even if it were passed.
  return {
    pred: hasSubqueryExpr(where)
      ? { props: [], where: gatePredicate(where) }
      : compilePredicate(undefined, where, nodeVar),
    bindVar: nodeVar,
  };
};

/**
 * `MATCH (n:L) WHERE <row-local pred> RETURN <row-local items>` — a label scan, a filter, and a
 * projection, with no hop, no aggregate and no window.
 *
 * This is the simplest query there is and it was the one shape in the file with no fast path.
 * `detectCountShortcut` answered the `count(*)` form, `detectHopProjection` needs a hop
 * (`segments.length !== 1` declines a bare node), `detectDistinctProjection` needs a `DISTINCT` —
 * so a plain point lookup fell through to the general pipeline, which materializes a binding per
 * SCANNED row. Measured on 20,000 vertices, one property equality, projecting one property:
 *
 *     a hand-written label-bucket loop            6.8ns a vertex
 *     count(*) over the same scan (its shortcut)  30.6ns
 *     the projection form                         83.3ns     <- 12.2x the floor
 *
 * `bench:usage` shows the consequence: every UNINDEXED read there is 60-82x behind native while
 * the indexed ones are a healthy 3x, because an index turns the scan into a seek and hides this
 * (audit item 204).
 *
 * The gate is built exactly as the grouped tally's is — the inline `{k: v}` constraint and the
 * clause `WHERE` are two spellings of one filter, both funnelled through `inlineHolds` ->
 * `satisfies`, which is the general path's own implementation rather than a re-derivation. The
 * composition via `reduceRight` is load-bearing for the same measured reason recorded there: an
 * `for (const ip of preds)` allocated an iterator per vertex over an empty array and cost an
 * unfiltered scan 34%.
 */
export const detectNodeProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [cm] = compiled;

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1 || ret.kind !== 'return') {
    return null;
  }

  if (cm.kind !== 'match') {
    return null;
  }

  const proj = ret.projection;

  // `star` needs the binding's whole shape; the rest each need a stage this path does not have.
  //
  // Two of these are belt-and-braces, and mutation says so rather than my reading it:
  //
  //   - `proj.star` is EQUIVALENT to the `items.length === 0` test below, because a `RETURN *`
  //     carries no items. Removing it changes no answer.
  //   - `proj.distinct` is reached only for a MULTI-item `DISTINCT`: `detectDistinctProjection`
  //     runs earlier in the ladder and claims the one-item case. The multi-item case is real
  //     though — nothing here dedupes — so it has a test with two vertices agreeing on BOTH
  //     projected values, which is what a one-column fixture cannot see.
  if (
    proj.star ||
    proj.distinct ||
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
    (proj.orderBy?.length ?? 0) > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    proj.items.length === 0
  ) {
    return null;
  }

  const [pattern] = m.patterns;

  // A path variable has to build a `Path` per row; a segment makes this a hop.
  if (pattern.pathVar !== undefined || pattern.segments.length !== 0) {
    return null;
  }

  const { start } = pattern;
  const nodeVar = start.variable;

  if (nodeVar === undefined) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const preds: InlinePred[] = [];
  const inStart = inlineOf(start);

  if (inStart === null) {
    return null;
  }

  if (inStart !== undefined) {
    preds.push(inStart);
  }

  const { where } = m;

  // The free-variable checks on the `WHERE` and on each item are DEFENSIVE, not load-bearing,
  // and mutation confirms it: with exactly two clauses, one pattern and no segments, `nodeVar`
  // is the ONLY name anything can be bound to — there is no earlier clause to bind another and
  // no far end to introduce one, so a reference to any other name does not resolve at all.
  // Removing either check changes no answer. They stay because that argument depends on the
  // clause-count and segment-count guards above keeping their exact shape, and because
  // (An earlier version of this note claimed `freePredicateVars` descends into a subquery and so
  // would catch one here. It does NOT — it returns the empty set for `exists` / `countSubquery` /
  // `valueSubquery`, per item 213 — so the ALLOWLIST is the only thing refusing a subquery, and
  // these checks are purely about outer names.) The same reasoning, and the same
  // wording, as `detectHopProjection`'s rel-variable and path-variable checks.
  if (where !== undefined) {
    const carried = nodeWhereOf(where, nodeVar);

    if (carried === 'decline') {
      return null;
    }

    preds.push(carried);
  }

  const gate = preds.reduceRight<InlineGate | undefined>(
    (rest, ip) => (v, binding, params, graph) =>
      inlineHolds(ip, v, binding, params, graph) &&
      (rest === undefined || rest(v, binding, params, graph)),
    undefined,
  );

  const cols: string[] = [];
  const fns: CompiledExpr[] = [];

  for (const item of proj.items) {
    if (!itemLocal(item.expr)) {
      return null;
    }

    // The free-variable check is skipped for an item carrying a SUBQUERY. The reason first given
    // here was that `freePredicateVars` reports the variables bound INSIDE one; it does NOT — it
    // returns the empty set for a subquery, which item 213 established while tracking an
    // `ORDER BY` bug caused by exactly that. So for a BARE subquery the skip is a no-op, and it
    // matters only for a MIXED item such as `COUNT { … } + n.k`, where the arithmetic's own names
    // are reported and the subquery's are not.
    //
    // Nothing is lost. With exactly two clauses, one pattern and no segments, `nodeVar` is the
    // only name anything can be bound to, so both paths evaluate the SAME compiled expression
    // against a binding holding exactly that one name: a reference to any other name resolves
    // identically, or raises identically, on either. That is the same argument the check itself
    // rests on (see above), and mutation confirms removing it changes no answer.
    if (!hasSubqueryExpr(item.expr)) {
      for (const nameRead of freePredicateVars(item.expr)) {
        if (nameRead !== nodeVar) {
          return null;
        }
      }
    }

    cols.push(item.alias ?? columnName(item.expr));
    fns.push(compileExpr(item.expr));
  }

  const labelName = label?.name;
  const width = cols.length;

  const cstart = cm.patterns[0].start;

  return (graph, params) => {
    const out: Row[] = [];
    // One binding map, reused across the scan. The general path allocates one per SCANNED row,
    // which is the difference this path exists to remove: `inlineHolds` and the projection both
    // overwrite the node's own variable per vertex, and `preds` and the items are CLOSED over
    // that one name, so nothing can read a stale entry.
    const binding = new Map<string, unknown>();
    // SEED FROM THE INDEX when one is cheaper than the label bucket, via the SAME `hopSeek` the
    // count shortcuts use. Written as a raw bucket walk first, this path made the INDEXED point
    // lookup 50x SLOWER (80.9k -> 1.6k ops/s in `bench:usage`) while making the unindexed one
    // 2x faster — it claimed the query ahead of the general path's index seek and then scanned.
    // `count-shortcuts-must-seek` names that exact failure and its signature, which the bench
    // showed verbatim: the indexed and unindexed columns became equal (1.2k against 1.6k).
    // `hopSeek` returns a candidate set only when it is strictly smaller than the bucket, so an
    // unindexed graph still walks and pays nothing for the attempt.
    const seeded = hopSeek(graph, cstart, label, { binding, params, graph });
    const vertices: Iterable<Vertex> =
      seeded ??
      (labelName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(labelName) ?? []));

    for (const v of vertices) {
      // The label is re-checked because a SEEDED set is a SUPERSET: an index hint is a
      // NECESSARY condition, not a sufficient one, so it can hand back a same-named vertex of
      // the wrong label. The bucket walk gets this for free by construction and the seek does
      // not — the same three tests in the same order as the hop seek's own loop. Two tests
      // caught the omission as a WRONG ANSWER, not as a slow one. Guarded on `seeded` so the
      // bucket walk — every unindexed graph — pays nothing for a test it satisfies by
      // construction; the same idiom this file already uses at the far-side walk.
      if (seeded !== undefined && !matchesLabel(v, label)) {
        continue;
      }

      if (gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      // Only SURVIVORS reach here, so the row object and the item evaluations are paid per
      // result rather than per scanned vertex.
      binding.set(nodeVar, v);

      const row: Row = {};

      for (let i = 0; i < width; i++) {
        row[cols[i]] = fns[i]({ binding, params, graph });
      }

      out.push(row);
    }

    return out;
  };
};

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

  const { items, skip, limit } = shape.ret.projection;
  const { countAt, sort, having } = picked;
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

    preds.push({
      pred: compilePredicate(undefined, where, start.variable),
      bindVar: start.variable,
    });
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
  // The variable a `HAVING` reads its representative through — the node this tally groups.
  const repVar = start.variable;

  return (graph, params) => {
    if (pageIsEmpty(params, limit)) {
      return [];
    }

    const vertices: Iterable<Vertex> =
      labelName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(labelName) ?? []);
    const groups = groupIndex();
    // One binding map, reused: `inlineHolds` overwrites the node's own variable per vertex
    // and nothing else reads it, which is what `preds` being CLOSED buys.
    const binding = new Map<string, unknown>();

    for (const v of vertices) {
      if (gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      groups.bump(propOf(v, key), 1, v);
    }

    return pageGroups(
      sortGroupRows(
        keepGroups(groups.slots, having, repVar, params, graph).map((slot) =>
          countFirst
            ? { [countCol]: slot.n, [keyCol]: slot.key }
            : { [keyCol]: slot.key, [countCol]: slot.n },
        ),
        sort,
      ),
      params,
      skip,
      limit,
    );
  };
};

export type ReachFn = (graph: Graph, params: Params) => Row[];

/**
 * May a hop fast path that binds only NODES accept this relationship variable?
 *
 * Yes when nothing reads it and it collides with neither end's name. The walks behind the
 * grouped tally and the grouped aggregate never bind an edge, so a name with no read cannot
 * change an answer — refusing it cost 2.3x on both (328 against 761, 392 against 805 at 200,000
 * nodes / 1,000,000 edges, item 488).
 *
 * The COLLISION case is the one that bites: `MATCH (x:P)-[x:T]->(b)` names the rel and the start
 * the same, which matches nothing and answers `[]`. A fast path that simply ignored the rel
 * name would return rows instead. Item 487 shipped exactly that shape of bug one tick earlier
 * — there a repeated rel name across two segments — so here it is a precondition rather than a
 * discovery.
 *
 * `freePredicateVars` rather than a string scan: every position checked below is an `Expr` the
 * shape already restricts (a key, a `count(*)`, a row-local aggregate argument, a clause
 * `WHERE`), and none of them can contain a subquery, which is the one construct
 * `freePredicateVars` under-reports (item 444).
 *
 * WHICH OF THESE CHECKS EARNS ITS KEEP. Only the COLLISION one: mutation says the three READ
 * checks are redundant, because every position is already refused elsewhere — the key must be
 * a property of an END (`keySource`), an aggregate argument must read the KEYED end
 * (`refsOnlyVar`), a clause `WHERE` may read only the keyed end, and an `ORDER BY` on anything
 * but a projected column declines before it gets here. All three mutants survive, including
 * against a test that sorts by `r.w`.
 *
 * They stay anyway, and the reason is specific rather than habitual: each of those covering
 * rules is one relaxation away from letting an expression that reads the edge reach a walk
 * with no edge bound, and the failure mode is a silent wrong answer rather than a slow query.
 * Recorded here so the next reader does not have to re-derive the mutation run (items 469 and
 * 486 made the same call; item 475 removed a guard whose redundancy was provable by reading,
 * which this one's is not).
 */
const relVarInert = (
  relVar: string | undefined,
  ends: readonly (string | undefined)[],
  projection: Projection,
  where: Expr | undefined,
): boolean => {
  if (relVar === undefined) {
    return true;
  }

  if (ends.includes(relVar)) {
    return false;
  }

  const reads = (e: Expr | undefined): boolean =>
    e !== undefined && freePredicateVars(e).has(relVar);

  return (
    !projection.items.some((i) => reads(i.expr)) &&
    !(projection.orderBy ?? []).some((o) => reads(o.expr)) &&
    !(projection.groupBy ?? []).some(reads) &&
    !reads(projection.having) &&
    !reads(where)
  );
};

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

  const { items, skip, limit } = shape.ret.projection;
  const { countAt, sort, having } = picked;
  const [pattern] = shape.match.patterns;

  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const { start } = pattern;
  const [seg] = pattern.segments;
  const { rel, node: far } = seg;

  if (
    !plainRel(rel) ||
    rel.direction === 'both' ||
    !relVarInert(
      rel.variable,
      [start.variable, far.variable],
      shape.ret.projection,
      shape.match.where,
    )
  ) {
    return null;
  }

  // An ANONYMOUS end is fine: nothing can reference it, so the name was only ever used to bind
  // a predicate. Requiring BOTH ends to be named made two spellings of ONE question cost 2.2x
  // apart — `MATCH (:Person)-[:KNOWS]->(b) RETURN b.age, count(*)` at 735 ms against the named
  // `(a:Person)` at 335 over 1,000,000 edges (item 475) — which is the bug class this repo is
  // named after.
  //
  // There is no replacement guard here, and that is deliberate: the KEYED end is named BY THE
  // KEY EXPRESSION, so `keySource.variable !== far.variable` below already refuses a pattern
  // whose keyed end has no name. A guard added here as well SURVIVED its mutant — redundant
  // with the one twenty lines down — so it was removed rather than left as a line no test can
  // fail on.
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

  // `keySource.variable` is a real name (a `prop` always has one), so comparing it against an
  // anonymous end's `undefined` is a mismatch rather than an accidental hit.
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

    preds.push({
      pred: compilePredicate(undefined, where, keyed.variable),
      bindVar: keyed.variable,
    });
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
  // The variable a `HAVING` reads its representative through: the KEYED end, which is the one
  // this tally groups by and the one whose vertex each slot holds.
  const repVar = keySource.variable;
  const out = rel.direction === 'out';
  const farLabel = far.label;
  const adjacency: Adjacency = {
    direction: rel.direction,
    ...(rel.label ? { label: rel.label } : {}),
  };

  return (graph, params) => {
    if (pageIsEmpty(params, limit)) {
      return [];
    }

    const groups = groupIndex();
    const binding = new Map<string, unknown>();
    const { bump: add } = groups;

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
    for (const v of candidateVertexSource(graph, startLabel)) {
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

        add(propOf(v, key), deg, v);

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

        add(propOf(keyedNode, key), 1, keyedNode);
      }
    }

    return pageGroups(
      sortGroupRows(
        keepGroups(groups.slots, having, repVar, params, graph).map((slot) =>
          countFirst
            ? { [countCol]: slot.n, [keyCol]: slot.key }
            : { [keyCol]: slot.key, [countCol]: slot.n },
        ),
        sort,
      ),
      params,
      skip,
      limit,
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

/**
 * `MATCH (n:L) RETURN max(n.k)` — the SCAN twin of `detectHopAggregate` (audit item 418), and
 * the same construction: one foldable aggregate over exactly the rows `detectNodeProjection`
 * already scans, folded as they are produced instead of grouped.
 *
 * The gap it closes, 200,000 vertices, min of 3 (audit item 420):
 *
 *     MATCH (a:P) RETURN max(a.k)    ~39ms   196ns/row, the general grouping path
 *     MATCH (a:P) RETURN a.k         ~8.4ms   42ns/row, the SAME rows, scanned
 *
 * `detectNodeProjection` compiles its own items, so the synthetic projection handed to it is
 * just the AST: the aggregate's argument as a single item. That means the argument expression is
 * compiled TWICE for an admitted query — once by `compileProjection` for `foldedAggs`, which this
 * path then ignores, and once by the scan. They compile the same AST node, so they cannot differ;
 * it is one wasted `compileExpr` per compile, not per row. (`detectHopAggregate` reuses
 * `foldedAggs[0].argFn` because the hop path takes a compiled twin; this one does not take one.)
 *
 * Admission is `detectHopAggregate`'s, for the reasons recorded there: ONE projection item which
 * must BE the aggregate by node identity, ONE foldable aggregate, and no GROUP BY, HAVING,
 * DISTINCT, ORDER BY or paging. `foldFor` is what keeps `sum`/`avg` out, and item 419 is why that
 * matters: they are order-DEPENDENT, and a fast path that may reorder rows changes their value.
 * A scan does not reorder — but the guard is inherited rather than re-argued, because the next
 * aggregate added to `foldFor` would otherwise arrive here unexamined.
 */
/**
 * A single COLLECTING aggregate (`sum`/`avg`) over an UNFILTERED scan (audit item 468).
 *
 * These have no entry in `foldFor` and cannot get one: `sum` chooses its operation by looking at
 * the WHOLE collection — a temporal anywhere means `temporalSum`, an array anywhere throws — so
 * it is inherently two-pass (item 467). What they do not need is the BINDINGS, which is where
 * the cost is: without a fold the general path keeps a group of them and maps each through the
 * argument, at ~125 ns a row (items 377, 465).
 *
 * **UNFILTERED ONLY, and that boundary is item 466's.** A float `sum` depends on summation
 * ORDER, so the streamed values must arrive in the same order the general path would fold them.
 * For an unfiltered scan that holds BY CONSTRUCTION: the shortcut walks
 * `verticesByLabel.get(name)` (or `verticesById.values()`) and `candidateVertexSource` returns
 * the very same container. Add a `WHERE` and the general path may seed from an index via
 * `seedVertices`, visiting in index order instead — a RUN-time decision on which indexes exist,
 * which is item 419's "observed, not promised" and item 411's trap. Hence: no clause `WHERE`, no
 * inline constraint, no label expression beyond a plain label.
 *
 * DISTINCT is excluded because the general path dedups by `valueKey` before aggregating, and
 * `star` because `sum(*)` is not a thing. Both are what `foldFor` refuses for the same reasons.
 *
 * **The unfiltered guard has NO TEST, and that is recorded rather than papered over.** Mutants
 * dropping the clause-`WHERE` check, the inline-constraint check and the segments check all
 * SURVIVE the suite. The DISTINCT and nullish guards do not — those were given teeth by a
 * duplicate value and an absent property respectively. The difference is that an order
 * divergence needs floats whose sum is order-dependent AND a general path that actually visits
 * in a different order, and I could not construct the second: a hash seek over a value every
 * row shares is wider than the bucket, so `seekIsWorthIt` declines it and scans; make it
 * selective and the index's per-value bucket holds those rows in insertion order anyway.
 *
 * So the boundary is justified by item 466's reasoning — `seedVertices` CAN visit in index
 * order, and whether it does is a run-time decision — and not by a demonstration. It stays
 * because conservative is the safe direction when the hazard is a silent last-bits difference,
 * and because item 419 is the entry about what happens when that judgement goes the other way.
 */
const unfilteredScan = (m: Clause): boolean => {
  if (m.kind !== 'match') {
    return false;
  }

  // No filter of any kind: a clause `WHERE`, an inline constraint, or an inline node `WHERE`
  // each give the general path something to seed from.
  if (m.where !== undefined || m.patterns.length !== 1) {
    return false;
  }

  const [pattern] = m.patterns;

  return pattern.segments.length === 0 && plainNode(pattern.start);
};

const unfilteredScanAgg = (
  m: Clause,
  ret: Clause,
): { name: string; frac: number }[] | undefined => {
  if (!unfilteredScan(m) || ret.kind !== 'return') {
    return undefined;
  }

  const { items } = ret.projection;

  if (items.length !== 1) {
    return undefined;
  }

  const [only] = items;
  const e = only.expr;

  if (e.kind !== 'func' || e.star || e.distinct || e.args.length !== 1) {
    return undefined;
  }

  if (e.name !== 'sum' && e.name !== 'avg') {
    return undefined;
  }

  // `frac` is only read by the percentile aggregates, which this never admits; 0 is the same
  // initial value `compileAggregate` gives it.
  return [{ name: e.name, frac: 0 }];
};

export const detectNodeAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;
  // `sum`/`avg` have no entry in `foldFor`, so `foldedAggs` is undefined for them and this
  // used to bail here — which cost 4.6x, because the general path then materializes a GROUP OF
  // BINDINGS and maps each through the argument (item 465: `sum(n.age)` 43.7-48.0 ms against
  // `count(n.age)` 9.4-10.2 at 200,000 nodes).
  //
  // They cannot be folds — `sum` chooses its operation by looking at the WHOLE collection, so a
  // temporal anywhere means `temporalSum` and an array anywhere throws (item 467). But they do
  // not need the BINDINGS, only the VALUES, so this streams the values and hands them to
  // `aggregateOverValues` — the same function `compileAggregate` calls, which is what makes the
  // two identical by construction rather than by replication.
  const folded = proj.foldedAggs;
  // A COLLECTING aggregate (`sum`/`avg`) on an UNFILTERED scan, which `foldedAggs` cannot carry
  // because they are not folds. `undefined` when the shape does not qualify, in which case the
  // fold path below is the only one.
  const collect = folded === undefined ? unfilteredScanAgg(m, ret) : undefined;

  if (
    (folded?.length !== 1 && collect === undefined) ||
    proj.star ||
    proj.distinct ||
    proj.items.length !== 1 ||
    proj.having !== undefined ||
    proj.orderBy.length > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return null;
  }

  // An explicit `GROUP BY` is refused twice, and the mutation run is what established which of
  // the two does the work. `compileProjection` sets `groupKeys` to the compiled GROUP BY
  // EXPRESSIONS when there are any, falling back to the non-aggregate items only when there are
  // not — so `groupKeys.length !== 0` already catches every written GROUP BY, and dropping the
  // AST check leaves `RETURN max(a.k) AS m GROUP BY a.k` correctly declined. It stays because the
  // synthetic projection below sets `groupBy: undefined`, which hides a GROUP BY from
  // `detectNodeProjection`'s own check, so this function is the last place that can see one; if
  // `groupKeys` ever stopped being populated from the GROUP BY, nothing downstream would notice.
  // (A first version of this comment claimed the AST check was the ONLY one looking. The mutant
  // that dropped it survived, which is how the claim was found to be wrong — a surviving mutant
  // can refute a comment as well as a test.)
  if (ret.projection.groupBy !== undefined || proj.groupKeys.length !== 0) {
    return null;
  }

  const [item] = ret.projection.items;
  const agg = folded?.[0];

  // By IDENTITY: `collectAggregates` finds the aggregate nested in `abs(min(n.k) - 10)` just the
  // same, and that shape needs the folded value substituted back into a group view. The
  // collecting path checks the same thing inside `unfilteredScanAgg`, which matched the item
  // itself rather than searching inside it.
  if (agg !== undefined && item.expr !== agg.expr) {
    return null;
  }

  const aggNode = item.expr;

  if (aggNode.kind !== 'func' || aggNode.args.length !== 1) {
    return null;
  }

  const [argExpr] = aggNode.args;
  const outName = proj.items[0].name;
  // A name no GQL identifier can collide with: the synthetic column is read back by key below.
  const VALUE_COL = ' nodeagg';
  const synthRet: Clause = {
    ...ret,
    projection: {
      ...ret.projection,
      items: [{ expr: argExpr, alias: VALUE_COL }],
      distinct: false,
      groupBy: undefined,
      having: undefined,
      orderBy: undefined,
      skip: undefined,
      limit: undefined,
    },
  };

  const rowsFn = detectNodeProjection([m, synthRet], compiled);

  if (rowsFn === null) {
    return null;
  }

  // THE COLLECTING PATH (item 468): stream the argument VALUES — one per row, no `Binding`
  // `Map` — and hand them to the same `aggregateOverValues` the general path runs. The nullish
  // filter mirrors the general path's `nonNull`, which is the same rule the fold path applies
  // per step.
  if (collect !== undefined) {
    const [{ name: aggName, frac }] = collect;

    return (graph, params) => {
      const values: unknown[] = [];

      for (const row of rowsFn(graph, params)) {
        const v = row[VALUE_COL];

        if (!isNullish(v)) {
          values.push(v);
        }
      }

      return [{ [outName]: aggregateOverValues(aggName, values, frac) }];
    };
  }

  const { fold } = agg!;

  return (graph, params) => {
    const rows = rowsFn(graph, params);
    let acc = fold.init();

    for (const row of rows) {
      const v = row[VALUE_COL];

      // The array path folds over the non-null values and the streaming step skips nullish the
      // same way; this is the fourth place that rule lives, so it reads the same as the others.
      if (!isNullish(v)) {
        acc = fold.step(acc, v);
      }
    }

    // `fold.finish` over an untouched accumulator is what gives an EMPTY scan its one row holding
    // null, which is what an ungrouped aggregate owes ISO — and it is the same `finish` the
    // general path calls, so the two cannot drift.
    return [{ [outName]: fold.finish(acc) }];
  };
};

/**
 * One projected aggregate's accumulator in the MULTI-aggregate scan path (item 469).
 *
 * `rows` is `count(*)`, which needs no value at all — it counts rows, nullish included, which
 * is why it is a separate arm rather than a fold over a projected column.
 */
type MultiAcc =
  | { readonly kind: 'rows'; readonly out: string }
  | { readonly kind: 'fold'; readonly out: string; readonly fold: AggFold; readonly col: string }
  | { readonly kind: 'collect'; readonly out: string; readonly name: string; readonly col: string };

/**
 * `MATCH (n:L) [WHERE …] RETURN agg1(…) AS a, agg2(…) AS b, …` — TWO OR MORE aggregates over
 * one scan, each accumulated as the rows are produced.
 *
 * WHY THIS EXISTS. `detectNodeAggregate` takes `proj.items.length !== 1` as a hard refusal, so a
 * projection asking for two aggregates — the ordinary analytic shape — fell off the ladder
 * whole and materialized a `Binding` per row. Measured at 200,000 nodes (item 469):
 * `count(n.age)` alone is 9.4 ms and `sum(n.age)` 12.8, but `count(n.age), count(*)` is 46.4,
 * `min(n.age), max(n.age)` 41.2 and `sum(n.age), avg(n.age)` 64.0 — roughly 4.9x the single-item
 * path for each, and NOT a property of `sum`: the all-foldable pairs pay it too. The general
 * path already streams multiple folds (`stepFolded`), so the cost is the matcher and the
 * per-row binding, not the accumulation.
 *
 * The admission rules are the single-item path's, applied per item rather than once:
 *
 *   - every item must BE an aggregate — a non-aggregate item is a GROUP KEY, and the
 *     `groupKeys` check above refuses those;
 *   - `count`/`min`/`max` accumulate through `foldFor`, the same source the general path's
 *     `stepFolded` reads, so the two cannot drift;
 *   - `sum`/`avg` cannot be folds (item 467) and collect their values for the shared
 *     `aggregateOverValues`, which — exactly as in item 468 — is admitted only on an
 *     UNFILTERED scan, because a filtered one may seed from an index and fold floats in a
 *     different order (items 419, 466);
 *   - `count(*)` counts rows and needs no projected column;
 *   - `DISTINCT` is refused per item, because the general path dedupes by value first.
 */
export const detectMultiNodeAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;

  // `items.length < 2` leaves the one-item shapes to `detectNodeAggregate`, which runs first and
  // has its own tests: the two rungs are disjoint by arity, so this one cannot regress those.
  if (
    proj.star ||
    proj.distinct ||
    proj.items.length < 2 ||
    proj.having !== undefined ||
    proj.orderBy.length > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined ||
    ret.projection.groupBy !== undefined ||
    proj.groupKeys.length !== 0
  ) {
    return null;
  }

  const unfiltered = unfilteredScan(m);
  const accs: MultiAcc[] = [];
  const synthItems: { expr: Expr; alias: string }[] = [];

  for (const [i, item] of ret.projection.items.entries()) {
    const e = item.expr;
    const out = proj.items[i].name;

    if (e.kind !== 'func' || e.distinct) {
      return null;
    }

    if (e.star) {
      if (e.name !== 'count' || e.args.length !== 0) {
        return null;
      }

      accs.push({ kind: 'rows', out });
      continue;
    }

    if (e.args.length !== 1) {
      return null;
    }

    const [arg] = e.args;
    // A name no GQL identifier can collide with, one per item.
    const col = ` nodeagg${i}`;
    const fold = foldFor(e.name, false, false);

    if (fold !== undefined) {
      accs.push({ kind: 'fold', out, fold, col });
    } else if ((e.name === 'sum' || e.name === 'avg') && unfiltered) {
      accs.push({ kind: 'collect', out, name: e.name, col });
    } else {
      return null;
    }

    synthItems.push({ expr: arg, alias: col });
  }

  // All-`count(*)` projects nothing, and `detectNodeProjection` needs an item.
  if (synthItems.length === 0) {
    return null;
  }

  const synthRet: Clause = {
    ...ret,
    projection: {
      ...ret.projection,
      items: synthItems,
      distinct: false,
      groupBy: undefined,
      having: undefined,
      orderBy: undefined,
      skip: undefined,
      limit: undefined,
    },
  };
  const rowsFn = detectNodeProjection([m, synthRet], compiled);

  if (rowsFn === null) {
    return null;
  }

  return (graph, params) => {
    const state = accs.map((a) => (a.kind === 'fold' ? a.fold.init() : ([] as unknown[])));
    let n = 0;

    for (const row of rowsFn(graph, params)) {
      n += 1;

      // An INDEX loop, not `accs.entries()`: the iterator allocates a `[i, a]` tuple per
      // accumulator per row, and at 200,000 rows that alone cost `count(n.age), count(*)`
      // 17.8 ms against 9.4 for the single-item path over the same column (item 469).
      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (a.kind === 'rows') {
          continue;
        }

        const v = row[a.col];

        // The nullish skip is the same rule the fold path and the general path's `stepFolded`
        // apply — the fourth and fifth places it lives read alike on purpose.
        if (isNullish(v)) {
          continue;
        }

        if (a.kind === 'fold') {
          state[i] = a.fold.step(state[i], v);
        } else {
          (state[i] as unknown[]).push(v);
        }
      }
    }

    const out: Row = {};

    for (let i = 0; i < accs.length; i += 1) {
      const a = accs[i];

      if (a.kind === 'rows') {
        out[a.out] = n;
      } else if (a.kind === 'fold') {
        out[a.out] = a.fold.finish(state[i]);
      } else {
        // `frac` is read only by the percentiles, which this never admits.
        out[a.out] = aggregateOverValues(a.name, state[i] as unknown[], 0);
      }
    }

    return [out];
  };
};

/** One projected aggregate's per-group accumulator in the grouped scan path (item 474). */
type GroupAcc =
  | { readonly kind: 'rows'; readonly out: string }
  | {
      readonly kind: 'fold';
      readonly out: string;
      readonly fold: AggFold;
      readonly argFn: CompiledExpr;
      readonly argExpr: Expr;
    };

/**
 * Split a grouped projection's items into the ONE key (a property of the matched node) and an
 * accumulator per aggregate, or `null` when any item is neither. Extracted from
 * `detectGroupedNodeAggregate` because the classification is a loop of its own and the
 * complexity cap was right to say so.
 */
const groupedAccs = (
  items: readonly { expr: Expr }[],
  compiledItems: readonly CReturnItem[],
  // `null` accepts a key on EITHER end — the hop path checks which end itself, because the two
  // ends are resolved from the pattern rather than given.
  nodeVar: string | null,
): { accs: GroupAcc[]; keyExpr: Extract<Expr, { kind: 'prop' }>; keyCol: string } | null => {
  let keyExpr: Extract<Expr, { kind: 'prop' }> | undefined;
  let keyCol = '';
  const accs: GroupAcc[] = [];

  for (const [i, item] of items.entries()) {
    const e = item.expr;
    const out = compiledItems[i].name;

    if (e.kind !== 'func' || !AGGREGATES.has(e.name)) {
      if (keyExpr !== undefined || e.kind !== 'prop') {
        return null;
      }

      if (nodeVar !== null && e.variable !== nodeVar) {
        return null;
      }

      keyExpr = e;
      keyCol = out;
      accs.push({ kind: 'rows', out: '' }); // placeholder: the key column is written by index
      continue;
    }

    if (e.distinct) {
      return null;
    }

    if (e.star) {
      if (e.name !== 'count' || e.args.length !== 0) {
        return null;
      }

      accs.push({ kind: 'rows', out });
      continue;
    }

    const fold = e.args.length === 1 ? foldFor(e.name, false, false) : undefined;
    const [argExpr] = e.args;

    if (fold === undefined || !rowLocal(argExpr)) {
      return null;
    }

    accs.push({ kind: 'fold', out, fold, argFn: compileExpr(argExpr), argExpr });
  }

  return keyExpr === undefined ? null : { accs, keyExpr, keyCol };
};

/**
 * `MATCH (n:L) [WHERE <row-local>] RETURN n.k AS key, <aggregates…>` — a GROUPED aggregate over
 * a scan, where the aggregates are not all `count(*)`.
 *
 * WHY THIS EXISTS. `detectGroupedNodeCount` is a TALLY: it takes exactly two items, one of them
 * `count(*)`, and bumps an integer. Anything else — one `max`, or a `count(*)` with a second
 * aggregate beside it — falls to the general path, a `Binding` per row. Measured at 200,000
 * nodes (item 474): `n.age AS k, count(*)` 2.9 ms (the tally), `n.age AS k, max(n.age)` **53.2**,
 * `n.age AS k, count(*), max(n.age)` **85.8**. 18x and 30x for the same grouping over the same
 * scan. Native answers all three in 1.0-1.4 ms, so this is TS-only.
 *
 * The admission set is `foldFor`'s plus `count(*)`. `sum`/`avg` are NOT admitted: a grouped sum
 * over floats depends on the order values reach their group, and a FILTERED scan may seed from
 * an index (items 419, 466, 468). The unfiltered case would be safe by the item-466 argument,
 * but a grouped path that takes `sum` only when unfiltered is a guard with no test — item 468
 * recorded how that goes — so it waits for a shape that can be demonstrated.
 */
export const detectGroupedNodeAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1) {
    return null;
  }

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;

  // Paging and ordering are the tally's business (items 190, 199); this rung answers the plain
  // shape and leaves the rest to the general path rather than re-deriving a window.
  if (
    proj.star ||
    proj.distinct ||
    proj.items.length < 2 ||
    proj.having !== undefined ||
    proj.orderBy.length > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return null;
  }

  const [pattern] = m.patterns;
  const { start, segments } = pattern;
  const nodeVar = start.variable;

  if (segments.length !== 0 || nodeVar === undefined || pattern.pathVar !== undefined) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  // Exactly ONE non-aggregate item, and it must be a property of the matched node — the same
  // restriction the tally works under, and what makes the group key one `propOf` a vertex.
  const picked = groupedAccs(ret.projection.items, proj.items, nodeVar);

  if (picked === null) {
    return null;
  }

  const { accs, keyExpr, keyCol } = picked;

  // An explicit `GROUP BY` must name the key this path groups by; `groupKeys` is the compiled
  // form and `sameGroupingExpr` is the rule item 199 applied to the tally.
  const written = ret.projection.groupBy;

  if (written?.length === 1 ? !sameGroupingExpr(written[0], keyExpr) : written !== undefined) {
    return null;
  }

  const { key } = keyExpr;
  const keyAt = ret.projection.items.findIndex((i) => i.expr === keyExpr);
  // The start node's INLINE constraint and the clause `WHERE` are the two spellings of one
  // filter, and both go through the general path's own `inlineHolds` / `compilePredicate`.
  const preds: InlinePred[] = [];
  const inStart = inlineOf(start);

  if (inStart === null) {
    return null;
  }

  if (inStart !== undefined) {
    preds.push(inStart);
  }

  const { where } = m;

  if (where !== undefined) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== nodeVar) {
        return null;
      }
    }

    preds.push({ pred: compilePredicate(undefined, where, nodeVar), bindVar: nodeVar });
  }

  // Composed rather than looped, for the reason item 141 measured on the tally: a `for…of` over
  // an EMPTY predicate array cost the unfiltered shape 34%.
  const gate = preds.reduceRight<InlineGate | undefined>(
    (rest, ip) => (v, binding, params, graph) =>
      inlineHolds(ip, v, binding, params, graph) &&
      (rest === undefined || rest(v, binding, params, graph)),
    undefined,
  );
  const labelName = label?.name;

  return (graph, params) => {
    const vertices: Iterable<Vertex> =
      labelName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(labelName) ?? []);
    // First-seen group order, which is the contract both engines keep.
    const slots: { readonly key: unknown; n: number; readonly state: unknown[] }[] = [];
    const bySeen = new Map<unknown, (typeof slots)[number]>();
    // ONE binding map for the whole scan, overwritten per vertex — the general path's cost is
    // a fresh `Map` per row, which is what this rung exists to avoid.
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };

    for (const v of vertices) {
      if (gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      const raw = propOf(v, key);
      // `valueKey` for a structural value, the value itself for a primitive: the same split
      // `groupIndex` makes, and it keeps a `Map` lookup off the string path for the common case.
      const id = raw === null || typeof raw !== 'object' ? raw : valueKey(raw);
      let slot = bySeen.get(id);

      if (slot === undefined) {
        slot = { key: raw, n: 0, state: accs.map((a) => (a.kind === 'fold' ? a.fold.init() : 0)) };
        bySeen.set(id, slot);
        slots.push(slot);
      }

      slot.n += 1;
      binding.set(nodeVar, v);

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (a.kind !== 'fold') {
          continue;
        }

        const value = a.argFn(env);

        // The same nullish rule as every other fold in this file and in `stepFolded`.
        if (!isNullish(value)) {
          slot.state[i] = a.fold.step(slot.state[i], value);
        }
      }
    }

    return slots.map((slot) => {
      const row: Row = {};

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (i === keyAt) {
          row[keyCol] = slot.key;
        } else if (a.kind === 'rows') {
          row[a.out] = slot.n;
        } else {
          row[a.out] = a.fold.finish(slot.state[i]);
        }
      }

      return row;
    });
  };
};

/**
 * The `(start)-[:T]->(far)` of a single plain, directed, untyped-variable hop, or `null`.
 * Extracted from `detectGroupedHopAggregate` because the complexity cap was right: the shape
 * checks and the projection checks are two jobs.
 *
 * `direction === 'both'` IS admitted (item 477). The tally refuses it because a bucket SUM
 * double-counts an edge whose ends both match; this rung never sums buckets — it walks
 * `expand` per start vertex, which is what the general path walks, so an edge between two
 * matching ends is met once from each end exactly as the general path meets it. Item 476 found
 * the guard's mutant surviving with correct answers and left it priced; measured, the
 * undirected grouped hop was **1849 ms** against the directed shape's 399.
 */
const plainOneHop = (
  pattern: PathPattern,
): { start: NodePattern; rel: RelPattern; far: NodePattern } | null => {
  if (pattern.pathVar !== undefined || pattern.segments.length !== 1) {
    return null;
  }

  const [seg] = pattern.segments;
  const { rel, node: far } = seg;

  if (!plainRel(rel)) {
    return null;
  }

  return relTypeNames(rel.label) === null ? null : { start: pattern.start, rel, far };
};

/**
 * `MATCH (a:L)-[:T]->(b) RETURN <keyed.k> AS key, <aggregates…>` — a GROUPED aggregate over a
 * hop that the `count(*)` tally cannot take.
 *
 * WHY THIS EXISTS. `detectGroupedHopCount` bumps an integer, so one `max` in the projection
 * sends the whole query to the general path — a `Binding` per EDGE. Measured at 200,000 nodes
 * over 1,000,000 edges (item 476): `b.age AS k, count(*)` 335 ms (the tally),
 * `b.age AS k, max(b.age)` **759**, `b.age AS k, count(*), max(b.age)` **895**.
 *
 * It walks exactly where the tally's PER-EDGE arm walks — `candidateVertexSource` then
 * `expand`, the general path's own adjacency iterator — so first-seen group order is the same
 * traversal, which is the property the tally's header insists on and the one a reordering walk
 * would break. The tally's degree shortcut is NOT reused: a degree is a count, and these
 * aggregates need the edge's own endpoint.
 *
 * `sum`/`avg` are refused, as on every other walk-based rung (items 419, 472): the admission
 * set is `foldFor`'s.
 *
 * The shape resolution below repeats the tally's rather than sharing it. That is a deliberate
 * trade — `groupedProjection` is shared with the NODE tally, and widening it would change two
 * hot detectors at once — but it means a guard fixed here must be fixed there too.
 */
export const detectGroupedHopAggregate = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;
  const [, cret] = compiled;

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1) {
    return null;
  }

  if (ret.kind !== 'return' || cret.kind !== 'return') {
    return null;
  }

  const proj = cret.projection;

  if (
    proj.star ||
    proj.distinct ||
    proj.items.length < 2 ||
    proj.having !== undefined ||
    proj.orderBy.length > 0 ||
    proj.skip !== undefined ||
    proj.limit !== undefined
  ) {
    return null;
  }

  const hop = plainOneHop(m.patterns[0]);

  if (hop === null) {
    return null;
  }

  const { start, rel, far } = hop;

  // A rel VARIABLE is inert here for the reason `relVarInert` records — this walk binds only
  // nodes — but a name COLLIDING with an end, or read by any position, still declines.
  if (!relVarInert(rel.variable, [start.variable, far.variable], ret.projection, m.where)) {
    return null;
  }

  // One non-aggregate item, a property of one END; the rest aggregates over the KEYED end.
  const picked = groupedAccs(ret.projection.items, proj.items, null);

  if (picked === null) {
    return null;
  }

  const { accs, keyExpr, keyCol } = picked;
  const onStart = keyExpr.variable === start.variable;

  if (!onStart && keyExpr.variable !== far.variable) {
    return null;
  }

  const keyed = onStart ? start : far;
  const other = onStart ? far : start;

  // The non-keyed end must be plain, exactly as in the tally: this walk applies nothing to it
  // beyond a far label.
  if (!plainNode(other)) {
    return null;
  }

  // Every aggregate argument must read the KEYED end only — it is the one node this walk binds.
  // `refsOnlyVar` is shallow by design, so a compound argument declines rather than being
  // analysed: this rung admits `max(b.k)`, not `max(b.k + c.k)`.
  for (const a of accs) {
    if (a.kind === 'fold' && !refsOnlyVar(a.argExpr, keyExpr.variable)) {
      return null;
    }
  }

  const inKeyed = inlineOf(keyed);

  if (inKeyed === null) {
    return null;
  }

  const preds: InlinePred[] = [];

  if (inKeyed !== undefined) {
    preds.push(inKeyed);
  }

  const { where } = m;

  if (where !== undefined) {
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== keyed.variable) {
        return null;
      }
    }

    preds.push({
      pred: compilePredicate(undefined, where, keyed.variable),
      bindVar: keyed.variable,
    });
  }

  const gate = preds.reduceRight<InlineGate | undefined>(
    (rest, ip) => (v, binding, params, graph) =>
      inlineHolds(ip, v, binding, params, graph) &&
      (rest === undefined || rest(v, binding, params, graph)),
    undefined,
  );
  const startLabel = start.label;

  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const { key } = keyExpr;
  const keyVar = keyExpr.variable;
  const keyAt = ret.projection.items.findIndex((i) => i.expr === keyExpr);
  const farLabel = far.label;
  const adjacency: Adjacency = {
    direction: rel.direction,
    ...(rel.label ? { label: rel.label } : {}),
  };

  return (graph, params) => {
    const slots: { readonly key: unknown; n: number; readonly state: unknown[] }[] = [];
    const bySeen = new Map<unknown, (typeof slots)[number]>();
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const farPb = vacuousLabel(graph, farLabel) ? undefined : farLabel;

    for (const v of candidateVertexSource(graph, startLabel)) {
      for (const step of expand(graph, v, adjacency)) {
        const { node } = step;

        if (farPb !== undefined && !matchesLabel(node, farPb)) {
          continue;
        }

        const keyedNode = onStart ? v : node;

        if (gate !== undefined && !gate(keyedNode, binding, params, graph)) {
          continue;
        }

        const raw = propOf(keyedNode, key);
        const id = raw === null || typeof raw !== 'object' ? raw : valueKey(raw);
        let slot = bySeen.get(id);

        if (slot === undefined) {
          slot = {
            key: raw,
            n: 0,
            state: accs.map((a) => (a.kind === 'fold' ? a.fold.init() : 0)),
          };
          bySeen.set(id, slot);
          slots.push(slot);
        }

        slot.n += 1;
        binding.set(keyVar, keyedNode);

        for (let i = 0; i < accs.length; i += 1) {
          const a = accs[i];

          if (a.kind !== 'fold') {
            continue;
          }

          const value = a.argFn(env);

          if (!isNullish(value)) {
            slot.state[i] = a.fold.step(slot.state[i], value);
          }
        }
      }
    }

    return slots.map((slot) => {
      const row: Row = {};

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (i === keyAt) {
          row[keyCol] = slot.key;
        } else if (a.kind === 'rows') {
          row[a.out] = slot.n;
        } else {
          row[a.out] = a.fold.finish(slot.state[i]);
        }
      }

      return row;
    });
  };
};
