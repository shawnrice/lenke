// THE GQL FAST PATHS — the TypeScript twin of the engine's `exec/fastpath.rs`. Every `detect*`
// here inspects the raw AST at COMPILE time and returns either a closure that answers the shape
// without enumerating matches, or `null` to decline. Each must be ANSWER-EQUIVALENT to the
// general matcher: a fast path is a performance decision, never a semantic one.
//
// The families, as the file is laid out:
//
//   counts          detectCountShortcut, detectForCount, detectOptionalHopCount,
//                   detectVarLengthCount — a `count(*)` from bucket sizes, a degree product, or
//                   the LEVEL RECURRENCE (walkLevelCount) for a deep hop
//   trail-3         reusedTrailsAt3 — the depth-3 TRAIL correction. The recurrence counts WALKS;
//                   a trail forbids edge reuse, which is not a function of the current level, so
//                   exactly depth 3 gets a closed-form correction and nothing deeper does
//   reachability    detectReachableShortcut, runReach — unbounded var-length + DISTINCT as a BFS
//                   over the reachable SET rather than an enumeration of trails
//   projections     detectNodeProjection, detectForProjection — a scan with ONE reused binding
//                   and a row object only for survivors; admits ORDER BY via ./ordered-rows.ts
//   aggregates      detectNodeAggregate (one), detectMultiNodeAggregate (two or more),
//                   detectGroupedNodeAggregate / detectGroupedHopAggregate (grouped)
//   grouped counts  detectGroupedNodeCount, detectGroupedHopCount — the `count(*)` tally
//   chain helpers   twoHopSide, threeHopSide, sweepChain, threeSegmentCount, productCountOf
//
// PRECEDENCE IS NOT HERE. These detectors are independent and all of them run; which one answers
// a shape is decided by `runLinear`'s lazy `if (linear.…)` chain in ./clauses.ts. That chain's
// comments say, per rung, whether its position is for correctness, for cost, or only for reading.
//
// NATIVE COUNTERPARTS. The live names are `try_fused_count` / `try_edge_filtered_count` (counts),
// `try_3hop_product_count` / `try_nhop_sweep_count` (chains), `try_degree_algebra` with
// `walk_levels_total` and `reused_trails_at_3` (the recurrence and its trail correction), and
// `varlen_distinct_endpoint_count` (reachability). This header used to name `try_count_edges`, xref:gone
// `try_count_two_hop` and `try_reachable_distinct`; all three are GONE from the crate, so the xref:gone
// three starting points a reader was given for finding the native twin were dead.
//
// A new predicate form needs its spellings added to `bun run spelling` (SPELL_N=200000
// SPELL_REPS=9 — single runs are bimodal). Two spellings that mean the same thing and cost
// differently is the bug class this whole file is most exposed to, and it returns correct
// answers, so no correctness test catches it.
import { LocalDate, LocalDateTime, LocalTime, ZonedDateTime, ZonedTime } from '@lenke/core';
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
  CProjection,
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
  compileExpr,
  compilePredicate,
  aggregateOverValues,
  foldedAggOnlyView,
  satisfies,
  sortsOnOutputOnly,
  countEdges,
  outNeighbors,
  percentileFraction,
  projectRow,
  propOf,
  relHasPredicate,
  relTypeNames,
  resolveCount,
  valueKey,
} from '../executor.js';
import { candidateCount, candidateVertexSource, expand, matchesLabel } from '../graph-queries.js';
import type { Adjacency } from '../graph-queries.js';
import { plainRowProjection } from './hop-projection.js';
import { indexCandidates, matchNode, seedVertices, seekIsWorthIt } from './matching.js';
import type { SeedCandidate } from './matching.js';
import type { ColSort, SortPlan } from './ordered-rows.js';
import { boundedTopKeyed, outputColumnSorts, sortRowsByColumns } from './ordered-rows.js';
import { AGGREGATES, asTruth, collectAggregates, isNullish } from './scalars.js';

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
  const perType = types !== undefined && bucketSumsAreSound(types, graph.multiTypeEdgeCount);

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

/**
 * An `InlinePred` carrying `bindVar` ONLY WHEN THE PREDICATE CAN READ THE BINDING (item 803).
 *
 * `inlineHolds` does `binding.set(bindVar, element)` once per ELEMENT, and in a filtered walk that
 * is one `Map` write per vertex. It is needed only where something in the predicate reads the
 * binding back, and there are exactly three places a value can come from:
 *
 *   - a general compiled `where` — reads the binding, through `env`. THIS is the case that needs it.
 *   - `eqProps` / `cmpProps` — CLOSED by construction in `directEqProps`, which admits only
 *     `<ownVar>.<key> <op> <closed value>`.
 *   - `props` — closed only when the CALLER has proved it, which is what `closedProps` asserts.
 *
 * So when an inline `WHERE n.k > 10` or a clause `WHERE n.s = 's3'` lifts ENTIRELY — the common
 * case, and the whole point of items 224/230/276 — nothing reads the binding and the write is
 * pure waste. Measured end-to-end, 200,000 vertices, one shape per process, three ORDER-ALTERNATED
 * rounds: a clause-filtered count 4.69/4.90/5.26 ms against 4.24/4.40/4.58 (1.11x, disjoint) and an
 * inline `{k: 2}` count 3.57/3.65/4.14 against 2.67/2.75/3.24 (1.34x, disjoint), with two controls
 * the change cannot reach — a NON-lifting `n.k * 1 > 10`, whose `where` survives so `bindVar` stays,
 * and a no-predicate projection — both flat. Item 802's ladder priced the `Map` write at ~4 of the
 * ~24 ns a vertex and so PREDICTED this magnitude, which is why 1.11x is a result and not noise.
 *
 * `closedProps` is a REQUIRED argument rather than inferred, because it cannot be inferred: a
 * compiled value is a closure and nothing can ask it what it reads. A caller passing `props` it has
 * not proved closed must pass `false`, or a correlated `(b {k: a.k})` would read a binding this
 * never wrote. Both props-carrying callers (`inlinePredOf`, `gateWith`) prove it with the same
 * `freePredicateVars(c.value).size > 0` loop; every other caller passes no properties at all.
 */
/**
 * The clause `WHERE` as a LIFTED element-local predicate for ONE endpoint, or `undefined` when it
 * is not one (items 995, 996).
 *
 * Element-local is the precondition `compilePredicate`'s `ownVar` parameter documents: the
 * predicate reads exactly one variable and it is this endpoint's. `freePredicateVars` is the proof,
 * the same one item 230's two-hop middle case uses.
 *
 * A free function for the LINT gate rather than for speed — inlined, its three conditions took
 * the one-hop builder to a complexity of 38 against a limit of 35, the same wall item 993 hit.
 * It is the right thing to move for the same reason: this decides a route ONCE PER QUERY, where
 * the walk it selects runs once per candidate.
 */
export const liftedOwnPred = (
  where: Expr,
  free: ReadonlySet<string>,
  ownName: string | undefined,
): CPredicate | undefined =>
  ownName !== undefined && free.size === 1 && free.has(ownName)
    ? compilePredicate(undefined, where, ownName)
    : undefined;

export const predFor = (
  pred: CPredicate,
  ownVar: string | undefined,
  closedProps: boolean,
): InlinePred =>
  ownVar !== undefined && (pred.where !== undefined || (!closedProps && pred.props.length > 0))
    ? { pred, bindVar: ownVar }
    : { pred };

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
/**
 * The part of an inline constraint that is the same for a NODE and a RELATIONSHIP: the
 * properties must be CLOSED, and an inline `WHERE` must read nothing but the element's own
 * variable. Extracted so `relInlineOf` is the same rule rather than a second copy of it —
 * item 633's first version drew its edge-side rule by hand and dropped a predicate.
 *
 * The two callers differ only in what counts as "plain", which is why that check stays with
 * them.
 */
type InlineShape = Pick<NodePattern, 'properties' | 'where' | 'variable'>;

const inlinePredOf = (n: InlineShape): InlinePred | null => {
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

  // The node's OWN variable is passed, which is sound exactly here: the loop above has just
  // proved the inline `WHERE` reads nothing but it. A clause `WHERE` cannot make that claim and
  // so never takes this route. `closedProps` is `true` for the same reason — the FIRST loop in
  // this function is the proof `predFor` asks for.
  return predFor(compilePredicate(n.properties, n.where, n.variable), n.variable, true);
};

const inlineOf = (n: NodePattern): InlinePred | null | undefined =>
  plainNode(n) ? undefined : inlinePredOf(n);

/**
 * The REL mirror of {@link inlineOf}: the inline constraint a one-hop tally can apply per edge
 * through `satisfies`, or `null` to decline.
 *
 * **This is the route item 633 could not take, and the reason its objection does not apply.**
 * That item admitted an inline rel `WHERE` by compiling it into the single `HopPred`, and had
 * to leave inline PROPERTIES out: `{w: v}` is IS-NULL semantics rather than `=` — with a null
 * value it matches a stored null AND AN ABSENT KEY where `r.w = null` matches none — and a
 * `$param`'s value is unknown at compile time, so a synthesized `compare` would reintroduce
 * item 210's "route two" divergence as a MISCOUNT.
 *
 * Nothing is synthesized here. The properties are handed to `compilePredicate` and evaluated by
 * `satisfies`, which is the general path's own matcher — the same call `matchRel` makes — so
 * the semantics are not re-derived and cannot drift from it. The gap this closes is 8.76x
 * (item 637).
 *
 * A quantifier declines: a tally counts single edges, and `{1,2}` is a walk.
 */
const relInlineOf = (r: RelPattern): InlinePred | null | undefined => {
  if (plainRel(r)) {
    return undefined;
  }

  if (r.quantifier !== undefined) {
    return null;
  }

  return inlinePredOf(r);
};

/**
 * Whether `r` carries an inline `WHERE` and NOTHING else a tally cannot absorb — no inline
 * properties, no quantifier — and that `WHERE` reads only the rel's own variable.
 *
 * The two guards mirror {@link inlineOf}'s for a node: an inline `WHERE` is evaluated with the
 * element bound to its own variable, so it needs one, and it may read nothing else. A rel
 * `WHERE` that reads another variable (`-[r:E WHERE r.w > a.k]->`) is a correlation, not a
 * per-edge gate, and declines.
 */
const relInlineWhereOnly = (r: RelPattern): boolean => {
  if ((r.properties?.length ?? 0) > 0 || r.quantifier !== undefined || r.where === undefined) {
    return false;
  }

  if (r.variable === undefined) {
    return false;
  }

  for (const name of freePredicateVars(r.where)) {
    if (name !== r.variable) {
      return false;
    }
  }

  return true;
};

/**
 * The `HopPred` a one-hop tally should run, folding in the rel's inline `WHERE` when there is
 * one — or `null` to decline the shortcut entirely (item 633).
 *
 * Extracted rather than inlined at the call site because inlining it put `patternCountOf` at a
 * complexity of 38 against the limit of 35, which is the same ceiling `inlineInteriorGate` was
 * extracted for.
 *
 * BOTH predicates present DECLINES. They would have to be conjoined, and a tally that applied
 * one and dropped the other is a wrong answer — measured 3 against the correct 2 when a first
 * draft let that through. Declining is also exactly the behaviour before this item: `plainRel`
 * was false, so `buildOneHopCount` returned null and the query took the general loop.
 */
const relHopPred = (
  rel: RelPattern,
  pred: HopPred | undefined,
): { pred: HopPred | undefined; carried: boolean; inRel?: InlinePred } | null => {
  const relWhere = relInlineWhereOnly(rel) ? rel.where : undefined;

  if (relWhere === undefined) {
    // No inline `WHERE` to fold, so the rel's inline PROPERTIES (if any) become the per-edge
    // `inRel` gate instead (item 637). `relInlineOf` yields `undefined` for a plain rel.
    const inRel = relInlineOf(rel);

    return inRel === null ? null : { pred, carried: false, inRel };
  }

  if (pred !== undefined) {
    return null;
  }

  // CARRIED, and therefore NO `inRel` — the two channels are mutually exclusive, which is
  // structural here rather than a condition at the call site. `relInlineWhereOnly` admits the
  // `WHERE` form only when the rel has no properties, so a carried rel has nothing left to
  // apply. Returning both would evaluate the SAME predicate twice per edge: answer-identical,
  // so all 2505 tests passed when a first version did exactly that, and a stable 1.12x on the
  // inline-`WHERE` spelling was the only symptom.
  return { pred: { fn: compileExpr(relWhere), relVar: rel.variable }, carried: true };
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

  // `closedProps` is `true` on the strength of the `freePredicateVars(c.value)` loop above —
  // `inlinePredOf`'s proof, made here because this path does not go through it.
  return predFor(compilePredicate(n.properties, where, n.variable), n.variable, true);
};

/** A clause `WHERE` the 1-hop count can evaluate per edge, with the vars it reads. */
type HopPred = {
  fn: CompiledExpr;
  startVar?: string;
  farVar?: string;
  relVar?: string;
  /**
   * The SAME predicate as a lifted [`CPredicate`], set only when it reads nothing but the far
   * node's own variable (item 995).
   *
   * Item 994 profiled the far walk and found **283 of its 307 ns a candidate inside one frame** —
   * `compileExpr`'s `compare` arm, `(env) => compareTruth(op, fn, l(env), r(env))` — while
   * `farOnlyHopCount` itself was 0.9% of samples. Gremlin's twin has no separate predicate frame
   * at all and does the walk AND the test in 149 ns, so the closure chain is the gap.
   *
   * The lift is not new machinery: the two-hop path has routed its MIDDLE node this way since
   * item 230, `satisfies` applies the lifted `eqProps`/`cmpProps` by reading the element
   * DIRECTLY rather than through the binding, and `farOnlyHopCount` already applies an
   * `InlinePred` the same way. This gives the one-hop clause `WHERE` the route its inline twin
   * and its two-hop sibling already had.
   */
  farLifted?: CPredicate;
  /**
   * The START mirror of {@link HopPred.farLifted} (item 996).
   *
   * Item 939 established by READING that the two hop walks are structurally identical and
   * measured them at the same cost per vertex (far 290/292/300 against start 305/291/304). Item
   * 995 lifted the FAR side only and so BROKE that symmetry: `post:1` fell to 42.3 ms while
   * `pre:1` stayed at 57.5. Two mirror spellings of one question costing 1.36x apart is the
   * defect class CLAUDE.md names, so the twin is not an optional follow-up.
   */
  startLifted?: CPredicate;
  /**
   * The REL mirror of {@link HopPred.farLifted} and {@link HopPred.startLifted} (item 1034).
   *
   * The edge is the THIRD position of the same shape and was the one left without a lift: items
   * 995/996 gave the two endpoints one, so `MATCH ()-[e:T]->() WHERE e.k = v RETURN count(*)`
   * stayed on the generic `binding.set(relVar, edge)` + `pred.fn(env)` per edge while its inline
   * twin `-[e:T {k: v}]->` was an `InlinePred` read straight off the edge. Item 1031 priced that
   * at 2.1-2.8x between the two spellings of one question, which is the defect class CLAUDE.md
   * names.
   *
   * Item 1033 built the obvious fix — this lift plus a BRANCH inside `tallyHopCount` — and the
   * controls refused it: three paths that cannot execute the new code got ~2x worse, because a
   * branch in that per-edge body reshapes the loop for every predicate kind flowing through it
   * (`ts-closure-size-is-load-bearing`). So the lift is consumed by a DEDICATED module-scope
   * walk, exactly as the other two positions are.
   */
  relLifted?: CPredicate;
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
  /** The REL's inline constraint, applied per EDGE through the same `satisfies` (item 637).
   *  Only the per-edge tally can honour it — the degree-sum walks never see an edge, so
   *  `startWalkFits`/`farWalkFits` refuse it rather than ignore it. */
  inRel?: InlinePred;
  /** The COMPILED start node, carrying the seed hints that let the start walk seek. */
  cstart?: CNode;
  /** Its FAR mirror, for the far-side walk. */
  cfar?: CNode;
};

/** Apply an endpoint's inline constraint, binding the node's own variable first. */
const inlineHolds = (
  ip: InlinePred | undefined,
  // `Edge` as well as `Vertex` since item 637: the same call applies a rel's inline
  // constraint per edge. `satisfies` is element-generic already — `matchRel` passes it an
  // edge — so only this signature was narrower than the thing it calls.
  element: Vertex | Edge,
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
 * Can per-type bucket SIZES be summed for `types`, or does one edge sit in two of the buckets?
 *
 * An edge carries a SET of types and every index buckets it under each one, so `|bucket(T)| +
 * |bucket(S)|` counts a `T,S` edge twice. One type can never collide with itself, and
 * `multiTypeEdgeCount === 0` says no edge in the graph carries two labels at all — so either is
 * enough. `types === undefined` means EVERY type, which only the second can license.
 *
 * ONE COPY OF THE RULE, and it was open-coded in SEVEN places before item 1078 — in a file whose
 * own warning is that "drift between two copies of one rule is precisely how the far endpoint
 * ended up on the per-edge tally". Each site reads the count off its own `graph`, so the rule
 * itself is pure and takes the count.
 *
 * EXPORTED FOR ITS OWN TEST, because no result-based test can reach it: every site that asks it
 * has an always-correct alternative route, so choosing wrongly is SLOW and not WRONG and a mutant
 * of the choice survives the differential suite (`never-sound` did, item 1078). That is the shape
 * `perf-gate-needs-its-own-test` describes — extract the decision as a pure function and assert
 * the decision.
 */
export const bucketSumsAreSound = (
  types: readonly string[] | undefined,
  multiTypeEdgeCount: number,
): boolean => types?.length === 1 || multiTypeEdgeCount === 0;

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

/**
 * THE BARE DEGREE SUM: `MATCH (a:L)-[:T]->(b) RETURN count(*)` with nothing else to apply.
 *
 * WHY A SEPARATE LOOP (item 1067). `startOnlyHopCount` already answers this shape by summing
 * bucket SIZES instead of visiting edges — item 286 built that, and without it the query fell to a
 * 600,000-edge tally. But the walk carries five things this shape does not need, and a LADDER over
 * its loop body says they are most of what it costs. 200,000 vertices each with three `E` edges,
 * `:P` on all of them but four edge-less `:S` vertices (so the label is NOT vacuous and the O(1)
 * bucket count is unavailable):
 *
 * ```text
 *   iterate the P bucket                                   0.32 ms
 *     + labels.has('P')                                    3.47
 *     + adjFrom.get('E').size                             20.32   ← the irreducible part
 *     + a types loop, as `degreeOfTypes`                  24.66
 *     + try/catch and a predicate call                    26.83
 *   THE ENGINE, same walk, same fixture                   59.60   ← 2.2x the same primitives
 * ```
 *
 * So the primitives cost 27 ms and the engine 60. The difference is per-vertex call overhead:
 * `matchesLabel`, `boxOf`, `degreeOfTypes`, `asTruth(pred.fn(env))` and a `try`/`catch`, none of
 * which this shape has anything to do.
 *
 * WHAT IT CAN DROP, and why each is sound:
 *
 *   - **The label re-check.** `candidateVertexSource` returns the label's own bucket for a plain
 *     `:L`, so every vertex in it carries the label by construction. The general walk re-checks
 *     because it may be iterating a SEEDED superset instead — this path requires that no seek
 *     applied, the same `seeded !== undefined` guard the hop walks use.
 *   - **The predicate call.** Reached only with `alwaysTrue`, which is the identity on this walk.
 *   - **The `try`/`catch`.** It exists for the raise-parity rule (items 139-145): a predicate that
 *     faults on a vertex the general path never reached must not raise. With no predicate there is
 *     nothing that can fault.
 *   - **`degreeOfTypes`'s loop**, for a single relationship type.
 *
 * `null` hands the query back to the general walk, which is the only other caller's behaviour too.
 */
const bareDegreeSum = (
  scan: HopScan,
  endVar: string | undefined,
  /** Which end drives. BOTH sides get it, so `(a:L)-[:T]->(b)` and `(a)-[:T]->(b:L)` cannot cost
   *  different amounts — the mirror-spelling rule this file re-learns in items 125/137/286. */
  side: 'start' | 'far',
): number | null => {
  const { graph, params, pred, pa, pb, out, types, inNear, inFar, inRel, cstart, cfar } = scan;
  const label = side === 'start' ? pa : pb;
  const inline = side === 'start' ? inNear : inFar;
  const lifted = side === 'start' ? pred.startLifted : pred.farLifted;
  const cnode = side === 'start' ? cstart : cfar;

  if (
    endVar !== undefined ||
    inline !== undefined ||
    inRel !== undefined ||
    pred.fn !== alwaysTrue ||
    lifted !== undefined ||
    label?.kind !== 'label' ||
    types?.length !== 1
  ) {
    return null;
  }

  // A SEEK would hand back a superset, which this loop cannot re-validate. Asked with the same
  // arguments the general walk uses, so the two agree on when a seek applies.
  if (
    hopSeek(graph, cnode, label, { binding: new Map<string, unknown>(), params, graph }) !==
    undefined
  ) {
    return null;
  }

  // The FAR endpoint of an `out` hop is the edge's TARGET, so its edges live in the reverse
  // index — reading the wrong side is a wrong answer, not a slow one, which is why this mirrors
  // `farOnlyHopCount`'s own `boxOf` rather than re-deriving it.
  const forward = side === 'start' ? out : !out;
  const [type] = types;
  let n = 0;

  for (const v of candidateVertexSource(graph, label)) {
    n += (forward ? v.adjFrom : v.adjTo)?.get(type)?.size ?? 0;
  }

  return n;
};

/**
 * `MATCH (a:L)-[:T]-(x) WHERE <a-only predicate> RETURN count(*)` — the UNDIRECTED twin of
 * {@link startOnlyHopCount}, as the sum of the passing vertices' degrees over BOTH adjacency boxes.
 *
 * WHY THIS EXISTS (item 1076). `buildOneHopCount` declined every CONSTRAINED undirected hop
 * outright, so the query fell to the general path and built a binding and a row per edge:
 * `MATCH (a:Person)-[:KNOWS]-(x) WHERE a.age > 60 RETURN count(*)` measured **242.78 ms against
 * native's 2.29 — 106x** at 200,000 vertices, where the DIRECTED spelling of the same question has
 * had a degree-sum walk since item 129. Item 1075 priced the arm at **19x on a loop-free graph and
 * 11x with the self-loop correction**, both answering what the general path answers.
 *
 * THE ARITHMETIC, and the one place it differs from the directed walk: an undirected hop meets each
 * edge from BOTH ends, so a vertex contributes `|adjFrom_T(v)| + |adjTo_T(v)|` — except for a
 * SELF-LOOP, which sits in both boxes while `expand` emits it once. `undirectedHopCount` makes the
 * same correction globally (`2 * |E_t| - loops(t)`); here it has to be per vertex, and it is paid
 * only on a graph that HAS a loop of the type — `loopsOfTypes` is that test, and a loop-free graph
 * never enters the second loop at all.
 *
 * ONE COPY OF THE PER-CANDIDATE RULE. The correction has to apply the same label check, inline
 * constraint and predicate the walk applies, and this file records what two copies of one rule
 * cost: "drift between two copies ... is precisely how the far endpoint ended up on the per-edge
 * tally while the start endpoint had a walk" (`startWalkFits`). So the degree sums come from
 * `startOnlyHopCount` itself, called once per direction — no new walk, no second rule — and the
 * correction reuses the same `scan` through it as well, by counting SELF-LOOP endpoints that pass.
 */
const undirectedStartOnlyCount = (scan: HopScan, startVar: string | undefined): number => {
  const { graph, params, pred, pa, types, inNear } = scan;
  // TWO CALLS, not a branch inside the walk: that loop is the hot one and item 159 measured 1.6x
  // on the hot shape from adding even a branch to it. The predicate is evaluated twice per
  // candidate as a result, which is the trade — and it is cheap against the row-per-edge path this
  // replaces. A predicate that FAULTS raises in the first call, so the raise is unchanged.
  const forward = startOnlyHopCount({ ...scan, out: true }, startVar);
  const backward = startOnlyHopCount({ ...scan, out: false }, startVar);

  // ONE EDGE CAN BE COUNTED TWICE BY THOSE SUMS, for two independent reasons, and this is the
  // whole of the arithmetic that is not the directed walk's:
  //
  //   - a SELF-LOOP sits in `adjFrom` and `adjTo` both, while `expand` emits it once; and
  //   - an edge carrying `m` of the requested types sits in `m` of the per-type buckets, while it
  //     is still ONE edge.
  //
  // So a passing endpoint `v` of an edge `e` is counted `m` times where it should be counted once
  // (a non-loop), or `2m` times where it should be counted once (a loop) — an overcount of
  // `m - 1` and `2m - 1`. With one requested type `m` is always 1 and the first collapses to
  // zero and the second to the familiar 1, which is exactly what item 1076 subtracted.
  // `multiTypeEdgeCount === 0` is the half of this condition item 1076 believed the closure could
  // not ask (item 1078): every edge then carries exactly one label, so `m` is 1 for every edge the
  // buckets yielded whatever `types` asked for. `bucketSumsAreSound` is the rule, shared with the
  // six other sites that had open-coded it.
  const sound = bucketSumsAreSound(types, graph.multiTypeEdgeCount);

  if (sound && !loopsOfTypes(graph, types)) {
    return forward + backward;
  }

  // ONLY a graph that can actually double-count reaches here. One pass over the type's edges,
  // which is still O(|E|) against the general path's binding-and-row per edge — and the predicate
  // is evaluated only on the edges that CAN be overcounted, which the `m === 1 && !loop` reject
  // below makes free for every ordinary edge.
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  const lifted = pred.startLifted;
  // The per-candidate rule, in ONE place for the same reason the degree sums come from
  // `startOnlyHopCount` itself: it has to be the same label check, inline constraint and
  // predicate the walk applied, or the correction drifts from what it is correcting.
  const passes = (v: Vertex): boolean => {
    if (!matchesLabel(v, pa)) {
      return false;
    }

    if (inNear !== undefined && !inlineHolds(inNear, v, binding, params, graph)) {
      return false;
    }

    if (lifted !== undefined) {
      if (lifted.where !== undefined && startVar !== undefined) {
        binding.set(startVar, v);
      }

      return satisfies(v, lifted, binding, params, graph);
    }

    if (startVar !== undefined) {
      binding.set(startVar, v);
    }

    return asTruth(pred.fn(env)) === true;
  };

  let over = 0;

  for (const edge of edgesOfTypes(graph.edgesByLabel, types)) {
    const loop = edge.from === edge.to;
    const m = sound ? 1 : requestedTypeCount(edge, types);

    if (m === 1 && !loop) {
      continue;
    }

    if (loop) {
      if (passes(edge.from)) {
        over += 2 * m - 1;
      }

      continue;
    }

    // BOTH endpoints are candidates for the start variable on an undirected hop, so both are
    // asked — and separately, because the predicate reads the one that is bound.
    if (passes(edge.from)) {
      over += m - 1;
    }

    if (passes(edge.to)) {
      over += m - 1;
    }
  }

  return forward + backward - over;
};

/**
 * How many of `types` one edge carries — `m` in {@link undirectedStartOnlyCount}'s arithmetic, and
 * the number of per-type buckets a degree sum therefore met it in.
 *
 * `undefined` types means EVERY type, which is what the adjacency buckets were summed over, so the
 * edge's own label count is the answer.
 */
const requestedTypeCount = (edge: Edge, types: string[] | undefined): number => {
  if (types === undefined) {
    return edge.labels.size;
  }

  let n = 0;

  for (const t of types) {
    if (edge.labels.has(t)) {
      n += 1;
    }
  }

  return n;
};

const startOnlyHopCount = (scan: HopScan, startVar: string | undefined): number => {
  // THE BARE DEGREE SUM FIRST (item 1067), and HERE rather than at the two dispatch sites, for
  // the reason this function's own header gives: the closure `buildOneHopCount` returns is the
  // hot one and item 119 measured 1.17x on an unrelated shape from growing it. So the dispatch
  // stays module-scope by construction rather than by luck.
  //
  // NO PERF CLAIM ATTACHED, and that is deliberate. The first cut asked this at the two dispatch
  // sites and the BOTH-ENDS control — a shape neither path can reach — read 98.85 ms before
  // against 106.5 after, which looked exactly like that closure effect. Moving it here did NOT
  // change the control (106.6), and a SECOND PRE round read 105.56: the 98.85 was the outlier and
  // there was never a regression. The move is kept because it is the right shape, not because it
  // fixed anything.
  const bare = bareDegreeSum(scan, startVar, 'start');

  if (bare !== null) {
    return bare;
  }

  const { graph, params, pred, pa, out, types, inNear, cstart } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  // The vertex's own adjacency box, not a hash of its id into the graph's map — `Vertex.adjFrom`
  // caches it on first read (audit items 162, 321). This drive is the NEAR side, so `out` selects
  // the out-adjacency; the far-side twin below selects the opposite one.
  const boxOf = (v: Vertex): Map<string, Set<Edge>> | undefined => (out ? v.adjFrom : v.adjTo);
  // Hoisted out of the loop: one polymorphic load per query rather than per candidate.
  const lifted = pred.startLifted;
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

      // THE LIFTED ROUTE, the mirror of the far walk's (item 996). `satisfies` reads the element
      // directly for every conjunct it lifted, so the binding is needed only for a RESIDUAL
      // `where` — and a predicate that lifts completely costs no Map write and no Map read per
      // candidate.
      if (lifted !== undefined) {
        if (lifted.where !== undefined && startVar !== undefined) {
          binding.set(startVar, v);
        }

        if (!satisfies(v, lifted, binding, params, graph)) {
          continue;
        }
      } else {
        if (startVar !== undefined) {
          binding.set(startVar, v);
        }

        if (asTruth(pred.fn(env)) !== true) {
          continue;
        }
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
  const { graph, pred, pa, pb, types, inNear, inFar, inRel } = scan;

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
    // A walk that sums bucket SIZES never visits an edge, so it cannot apply the rel's
    // inline constraint — ignoring it would be a wrong answer, not a slow one (item 637).
    inRel === undefined &&
    // The walk never visits the far endpoint, so it cannot apply the far label or a far
    // constraint; and summing out-degree counts edges to ANY target.
    pb === undefined &&
    inFar === undefined &&
    // Summing per-type bucket sizes is sound only when no edge sits in two of them.
    bucketSumsAreSound(types, graph.multiTypeEdgeCount)
  );
};

/** The FAR mirror of {@link startWalkFits}, on mirrored conditions — the far LABEL included. */
const farWalkFits = (scan: HopScan): boolean => {
  const { graph, pred, pa, pb, types, inNear, inFar, inRel } = scan;

  return (
    (pred.farVar !== undefined || inFar !== undefined || pb !== undefined) &&
    pred.startVar === undefined &&
    pred.relVar === undefined &&
    // The mirror of `startWalkFits`'s rule, and for the same reason (item 637).
    inRel === undefined &&
    // An IN-degree counts edges from ANY source, so the start side must be unconstrained
    // where the twin requires the far side to be.
    pa === undefined &&
    inNear === undefined &&
    bucketSumsAreSound(types, graph.multiTypeEdgeCount)
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
  // The mirror of the twin's first line — see there for why it is here and not at the call site.
  const bare = bareDegreeSum(scan, farVar, 'far');

  if (bare !== null) {
    return bare;
  }

  const { graph, params, pred, pb, out, types, inFar, cfar } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  // The far endpoint of an `out` hop is the edge's TARGET, so its edges are the ones the
  // reverse index holds — the mirror of the twin's choice.
  // The FAR-side drive, so the box is the opposite of the near one above — reading it off the
  // wrong side is a wrong answer, not a slow one.
  const boxOf = (v: Vertex): Map<string, Set<Edge>> | undefined => (out ? v.adjTo : v.adjFrom);
  // Hoisted out of the loop: one polymorphic load per query rather than per candidate.
  const lifted = pred.farLifted;
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

      // THE LIFTED ROUTE (item 995). `satisfies` reads the element directly for every conjunct
      // it lifted, so the binding is needed only for a RESIDUAL `where` — and when the predicate
      // lifts completely there is no Map write and no Map read per candidate at all, which is
      // what Gremlin's twin has always had.
      if (lifted !== undefined) {
        if (lifted.where !== undefined && farVar !== undefined) {
          binding.set(farVar, v);
        }

        if (!satisfies(v, lifted, binding, params, graph)) {
          continue;
        }
      } else {
        if (farVar !== undefined) {
          binding.set(farVar, v);
        }

        if (asTruth(pred.fn(env)) !== true) {
          continue;
        }
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

/** The edges of `seed` carrying one of `types` — the residual an EDGE-index seed must re-apply,
 *  because an index bucket is keyed by the property and knows nothing about the label.
 *
 *  A generator rather than a materialized set: the type filter is per edge either way, and the
 *  walks that consume this already take a lazy source on three of their four routes. */
const edgesOfTypesIn = function* (
  seed: ReadonlySet<Edge>,
  types: string[] | undefined,
): Iterable<Edge> {
  for (const e of seed) {
    if (types === undefined) {
      yield e;

      continue;
    }

    for (const t of types) {
      if (e.labels.has(t)) {
        yield e;

        break;
      }
    }
  }
};

/**
 * The EDGE index as a seed for a one-hop walk (item 1035), or `undefined` to keep the scan.
 *
 * `graph.edgePropertyIndex` has existed and been declarable with
 * `createIndex({ on: 'edge', … })` throughout, and `@lenke/gremlin`'s `executor/index-seed.ts`
 * seeds `E()` from it — while NOTHING in `@lenke/gql` referenced it. Item 1031 priced that: one
 * question, 100 of 100,000 edges, answered in 0.025 ms by `E().has('amount', 500)` and 1.0 ms by
 * either GQL spelling, because GQL enumerated the whole type bucket. A declared index served one
 * surface and was invisible to the other.
 *
 * EXPORTED so the choice can be tested directly, for `hopSeek`'s reason: seeding is
 * answer-preserving, so no result-based test can tell a seek from a scan and a mutant that
 * simply never seeds survives all of them.
 *
 * Both spellings of the predicate are read, because they are one question and this file's
 * recurring defect is serving only one of them: the clause `WHERE e.k = v` arrives as
 * `relLifted.eqProps` (item 1034) and the inline `-[e:T {k: v}]->` as `inRel.pred.props`.
 *
 * A NULL value is declined deliberately. `{k: null}` matches a stored null AND an absent key
 * (see `satisfies`), where the index bucket for null holds only the edges that store one — so
 * seeding it would drop rows. Declining a seed is always sound; admitting a narrow one is not.
 */
export const edgeSeek = (
  graph: Graph,
  /** The rel's INLINE constraint, whose `props`/`eqProps` are one of the two spellings. */
  inRel: InlinePred | undefined,
  /** The lifted clause `WHERE` on the rel, the other spelling (item 1034). */
  relLifted: CPredicate | undefined,
  types: string[] | undefined,
  env: EvalEnv,
): ReadonlySet<Edge> | undefined => {
  const idx = graph.edgePropertyIndex;
  let best: { count: number; build: () => ReadonlySet<Edge> } | undefined;

  const offer = (key: string, value: CompiledExpr): void => {
    if (!idx.isIndexed(key)) {
      return;
    }

    const v = value(env);

    if (v === null || typeof v === 'object' || (typeof v === 'number' && Number.isNaN(v))) {
      return;
    }

    const count = idx.countEquals(key, v) ?? 0;

    if (best === undefined || count < best.count) {
      best = { count, build: () => idx.equals(key, v) ?? new Set<Edge>() };
    }
  };

  for (const { key, value } of inRel?.pred.props ?? []) {
    offer(key, value);
  }

  for (const { key, value } of inRel?.pred.eqProps ?? []) {
    offer(key, value);
  }

  for (const { key, value } of relLifted?.eqProps ?? []) {
    offer(key, value);
  }

  // `props` AS WELL AS `eqProps`, since item 1038. The count path only ever hands a LIFTED clause
  // predicate here, whose equalities are in `eqProps` — but the projection path hands its rel's
  // INLINE constraint as a bare `CPredicate`, and an inline `{k: v}` lands in `props`. Reading one
  // list and not the other is how one spelling seeds while its twin scans, which is the defect
  // this function exists to close rather than to reproduce one layer up.
  for (const { key, value } of relLifted?.props ?? []) {
    offer(key, value);
  }

  if (best === undefined) {
    return undefined;
  }

  // The scan this replaces is the EDGE TYPE bucket, not a vertex label bucket, so
  // `seekIsWorthIt` is the wrong oracle — its `candidateCount` counts vertices. The rule is the
  // same shape with the right denominator, and `TALLY_SEEK_MARGIN` is reused rather than a fifth
  // constant invented: this is the same choice that function already guards, with the seed
  // measured in edges instead of in vertices whose whole degree then follows.
  let bucket = 0;

  if (types === undefined) {
    bucket = graph.edgesById.size;
  } else {
    for (const t of types) {
      bucket += graph.edgesByLabel.get(t)?.size ?? 0;
    }
  }

  return best.count * TALLY_SEEK_MARGIN < bucket ? best.build() : undefined;
};

const tallyEdges = (scan: HopScan, env: EvalEnv): Iterable<Edge> => {
  const { graph, pa, pb, out, types, cstart, cfar } = scan;

  // THE EDGE SEED FIRST (item 1035). Unlike the two vertex seeds below it yields exactly the
  // candidate EDGES rather than every edge incident to a narrowed vertex set, so where it
  // qualifies it is the narrower source by construction and there is nothing to compare: a
  // vertex seed of k vertices still carries their whole degree.
  const seeded = edgeSeek(graph, scan.inRel, scan.pred.relLifted, types, env);

  if (seeded !== undefined) {
    return edgesOfTypesIn(seeded, types);
  }

  // A per-vertex bucket can hold one edge under several labels, so this source is sound only
  // where `degreeOfTypes` is: one concrete type, or no multi-type edge in the graph.
  if (bucketSumsAreSound(types, graph.multiTypeEdgeCount)) {
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
  const { graph, params, pred, pa, pb, out, inNear, inFar, inRel } = scan;
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
    //
    // The REL's constraint is tested FIRST of the three, because it is the one that can be
    // decided without touching either endpoint — and in the shape this was built for
    // (`-[r:E {w: $w}]->`) it is the selective one. Ordering among equally-correct gates is a
    // performance choice, so it is recorded rather than left to look incidental.
    if (inRel !== undefined && !inlineHolds(inRel, edge, binding, params, graph)) {
      continue;
    }

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
 * Can an undirected hop's constraint be answered by a DEGREE SUM, or does it need the tally?
 *
 * The degree sum never visits the far end or the edge, so it cannot apply a far label, a far
 * inline constraint, a far-reading predicate or any rel constraint — ignoring one would be a wrong
 * answer rather than a slow one (item 637). Everything it CAN apply lives on the start vertex.
 *
 * EXPORTED FOR ITS OWN TEST, because no result-based test can reach it: both routes answer
 * correctly, so choosing the tally where the degree sum would do is SLOW and not WRONG, and
 * `startonly-never` SURVIVED item 1086's mutation round for exactly that reason. The mirror of
 * `bucketSumsAreSound` and the same prescription — `perf-gate-needs-its-own-test`.
 *
 * The WRONG direction is caught by the differential tests, and loudly: `startonly-always` failed
 * 24 of them.
 */
export const undirectedDegreeSumFits = (c: {
  inFar: InlinePred | undefined;
  inRel: InlinePred | undefined;
  farLabel: LabelExpr | undefined;
  farVar: string | undefined;
  relVar: string | undefined;
}): boolean =>
  c.inFar === undefined &&
  c.inRel === undefined &&
  c.farLabel === undefined &&
  c.farVar === undefined &&
  c.relVar === undefined;

/**
 * The UNDIRECTED tally: `(a)-[:T]-(x)` with a constraint a degree sum cannot apply — a far label,
 * a far-reading predicate, a rel constraint, or any combination (item 1086).
 *
 * WHY IT EXISTS. `buildOneHopCount` declined all of those outright, so the query fell to the
 * general path and built a binding and a row per edge. Item 1076's own probe measured the cost on
 * its three declining controls: a far-reading predicate **910.25 ms**, a rel predicate 922.25, a
 * far label 372.35 — against 25 ms for the start-constrained twin the degree sum now answers.
 *
 * THE MECHANISM IS THE ONE ALREADY THERE. `tallyHopCount` decides which endpoint is NEAR and
 * which is FAR from `scan.out`, and seeds from the matching index. So an undirected hop is that
 * walk run ONCE PER DIRECTION: for every edge, the orientation `from -> to` and the orientation
 * `to -> from` are each tested exactly as the directed walk tests them, which is what `expand`
 * emits for `-[:T]-`. No new per-edge rule, and nothing added to that walk's body — item 1033
 * measured a branch inside it costing three shapes it could not execute ~2x.
 *
 * THE SELF-LOOP CORRECTION, and it is the only arithmetic here. A loop has `near === far` in both
 * orientations, so both passes test the identical triple and both accept or both reject — it is
 * counted twice where `expand` emits it once. `loopsOfTypes` gates the third pass, so a loop-free
 * graph pays nothing for it.
 */
const undirectedTally = (scan: HopScan): number => {
  const forward = tallyHopCount({ ...scan, out: true });
  const backward = tallyHopCount({ ...scan, out: false });
  const { graph, types } = scan;

  return loopsOfTypes(graph, types) ? forward + backward - loopTally(scan) : forward + backward;
};

/**
 * How many SELF-LOOPS of the type pass {@link undirectedTally}'s gates — the double-count to
 * subtract.
 *
 * A SECOND COPY OF THE PER-EDGE RULE, which this file warns about ("drift between two copies of
 * one rule is precisely how the far endpoint ended up on the per-edge tally"), and the alternative
 * was worse: a `loopsOnly` flag inside `tallyHopCount` puts a branch in the per-edge body that item
 * 1033 measured at ~2x on three shapes that cannot reach it. So the duplication is deliberate and
 * the drift risk is carried by tests instead — `undirected-tally.test.ts` puts a PASSING self-loop
 * through every constraint kind separately, which is how item 1078's equivalent duplication is held.
 *
 * `near === far` for a loop, so the two endpoints are one vertex and the orientation is immaterial.
 */
const loopTally = (scan: HopScan): number => {
  const { graph, params, pred, pa, pb, types, inNear, inFar, inRel } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  let n = 0;

  for (const edge of edgesOfTypes(graph.edgesByLabel, types)) {
    const v = edge.from;

    if (edge.to !== v || !matchesLabel(v, pa) || !matchesLabel(v, pb)) {
      continue;
    }

    if (inRel !== undefined && !inlineHolds(inRel, edge, binding, params, graph)) {
      continue;
    }

    if (inNear !== undefined && !inlineHolds(inNear, v, binding, params, graph)) {
      continue;
    }

    if (inFar !== undefined && !inlineHolds(inFar, v, binding, params, graph)) {
      continue;
    }

    if (pred.startVar !== undefined) {
      binding.set(pred.startVar, v);
    }

    if (pred.farVar !== undefined) {
      binding.set(pred.farVar, v);
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
 * The REL mirror of {@link startOnlyHopCount} and {@link farOnlyHopCount}: when the clause
 * `WHERE` reads nothing but the hop's RELATIONSHIP variable, the predicate is applied to the
 * edge DIRECTLY through `satisfies`, with no per-edge `binding.set` and no general
 * `pred.fn(env)` frame.
 *
 * This is NOT a cheaper walk — unlike its two siblings it cannot trade O(E) for O(V), because a
 * predicate on the edge needs the edge. It is the same edge source (`tallyEdges`, so the same
 * seeding) with the same per-edge constant the INLINE spelling already pays. Item 1031 measured
 * the two spellings of one question 2.1-2.8x apart on the `count(*)` shape for exactly this
 * reason.
 *
 * A SEPARATE MODULE-SCOPE FUNCTION, AND THAT IS MEASURED. Item 1033 put the lift behind a branch
 * inside `tallyHopCount` instead. All 2,803 tests passed and the target improved 2.4x, but three
 * controls the new code CANNOT EXECUTE regressed ~2x with disjoint ranges — the inline spelling
 * 0.85 -> 2.0, an unindexed edge key 3.1 -> 5.6-7.1, a clause on a node key 0.022 -> 0.048 —
 * because the branch reshapes that per-edge body for every predicate kind that flows through it.
 * That is `ts-closure-size-is-load-bearing` for the fifth time in this file (items 119, 141,
 * 159, 1033), and it is why items 995/996 gave the other two positions dedicated walks. The
 * generic tally is left byte-for-byte unchanged and acts as the control for this change.
 *
 * The caller guarantees what this cannot see: `relLifted` is set only when
 * `freePredicateVars(where)` is exactly the rel's own variable, so `startVar` and `farVar` are
 * necessarily undefined and no endpoint needs binding.
 */
const relOnlyHopCount = (scan: HopScan, lifted: CPredicate): number => {
  const { graph, params, pa, pb, out, inNear, inFar, inRel } = scan;
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  // The residual `where` is the only thing that can still read the edge through the binding —
  // the lifted props are applied to the element directly. Hoisted: one test per query.
  const needsBind = lifted.where !== undefined;
  const { relVar } = scan.pred;
  let n = 0;

  for (const edge of tallyEdges(scan, env)) {
    const near = out ? edge.from : edge.to;
    const far = out ? edge.to : edge.from;

    if (!matchesLabel(near, pa) || !matchesLabel(far, pb)) {
      continue;
    }

    // The same three gates in the same order as the tally, for the reasons recorded there.
    if (inRel !== undefined && !inlineHolds(inRel, edge, binding, params, graph)) {
      continue;
    }

    if (inNear !== undefined && !inlineHolds(inNear, near, binding, params, graph)) {
      continue;
    }

    if (inFar !== undefined && !inlineHolds(inFar, far, binding, params, graph)) {
      continue;
    }

    if (needsBind && relVar !== undefined) {
      binding.set(relVar, edge);
    }

    if (satisfies(edge, lifted, binding, params, graph)) {
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
/**
 * `count(*)` over a bounded var-length OUT hop, by DEGREE ARITHMETIC in O(V + E) rather than by
 * enumerating the O(paths) walks (item 573).
 *
 * The native engine has answered this shape algebraically since item 64 (`try_degree_algebra`);
 * TS enumerated, and the gap is ALGORITHMIC rather than the data-layout ceiling item 566
 * measured. Priced at 40,000 vertices / 120,000 edges, one case per process:
 *
 *   MATCH (a:P)-[:T]->{1,2}(y) RETURN count(*)              ts 300.22ms   nv 0.61   491x
 *   MATCH (a:P)((x)-[e:T]->(y)){1,2} RETURN count(*)           252.74          0.65  391x
 *
 * 479,998 paths against a V+E of 160,000, so enumeration is doing ~3x the work a closed form
 * needs — before the per-element constant.
 *
 * THE ARITHMETIC, for `max <= 2` and `Dir::Out`, mirroring the native function so the two cannot
 * drift: a 1-hop path is one wanted out-edge of a source whose target passes; a 2-hop path
 * `s -> y -> z` is one such edge times `y`'s own PASSING out-degree. A TRAIL then excludes the
 * single path that reuses the same edge, `s -> s -> s` over a self-loop, which `deg(s)` counted;
 * a WALK permits it and makes no correction. `{0,n}` adds the zero-length path per source, whose
 * endpoint is the SOURCE itself and so is the one row an endpoint test applies to directly.
 *
 * WALK/TRAIL ONLY. The degree algebra counts node-repeating paths, which SIMPLE and ACYCLIC
 * forbid — those have to enumerate, and `pattern.mode` is checked for exactly that.
 *
 * `set.size` is what makes the degree precompute cheap: a vertex's wanted out-degree is a sum of
 * per-label set sizes, O(#types) rather than O(degree) — so the whole first pass is O(V) when no
 * endpoint test needs a per-neighbour look. An endpoint test forces the per-neighbour walk and
 * the pass becomes O(E), which is still the closed form's budget.
 */
/**
 * The second hop's route decision, with no graph in it (item 585).
 *
 * Returns the number of vertices the FORWARD route would have to compute a degree for — which is
 * also the budget the inverted route must come in under — or `null` when the forward route is
 * cheap enough that the O(V) predicate sweep inversion needs is not worth paying.
 *
 * Extracted and exported for its own unit test for a specific reason: the decision is a PERF
 * choice and both answers are correct, so every mutation of it SURVIVES the differential tests.
 * Item 585 ran three such mutants (always invert; drop the `max >= 2` guard; invert for a vacuous
 * test) and all three passed 11 pinned cases, as they had to. Arithmetic that no differential test
 * can reach either gets its own test or gets no teeth at all.
 */
export const invertedHopBudget = (
  vertexCount: number,
  edgeCount: number,
  srcCount: number,
): number | null => {
  if (vertexCount === 0) {
    return null;
  }

  const avgDeg = edgeCount / vertexCount;
  // Every source reaches about `avgDeg` vertices at hop 1, capped by the graph: that is how many
  // distinct vertices `degreeOf` would be called for.
  const reachedEst = Math.min(vertexCount, srcCount * avgDeg);

  // Each of those costs about `avgDeg` edge visits. Below one visit per vertex the forward route
  // is already cheaper than the sweep that would decide against it.
  return reachedEst * avgDeg > vertexCount ? reachedEst : null;
};

/**
 * Does a SAMPLE of the endpoint test rule inversion out (item 585)?
 *
 * The full sweep is O(V) predicate calls, and when the test passes nearly everything that sweep
 * is pure loss: it runs, finds `passing` above the budget, and declines. Measured at 200,000
 * vertices, a test passing every vertex cost 3-8% for exactly that. Sampling the first
 * `sampleSize` vertices caps the loss at `sampleSize` calls.
 *
 * `true` means "do not even sweep". The projected passing count is `passed / sampleSize * V`, and
 * inversion is ruled out when that projection REACHES the budget — the same comparison the exact
 * check will make, just made early on an estimate.
 *
 * The comparison is deliberately tie-inclusive, and the first version of this got the margin
 * BACKWARDS. I required the projection to exceed the budget by a factor of two, reasoning that a
 * prefix of an insertion-ordered map is not a random sample so a close call should resolve to the
 * sweep. But the budget is capped at the vertex count, so a test that passes everything projects
 * EXACTLY the budget and never two times it: the check could not fire for the one case it was
 * built for. Dead on arrival, caught by writing its test.
 *
 * Erring the other way is safe in a way erring toward the sweep is not. If the prefix is
 * unrepresentative — passing everything in the first 1024 and little after — this skips a win and
 * runs the FORWARD route, which is what the engine did before item 585 at all. The downside is a
 * missed optimization; there is no wrong answer and no regression against the old route. And a
 * sample that says "invert" still gets the exact `passing.length < budget` check afterwards, so
 * this can only ever skip work, never choose the inverted route on its own.
 */
export const sampleRulesOutInversion = (
  sampleSize: number,
  passedInSample: number,
  vertexCount: number,
  budget: number,
): boolean => {
  if (sampleSize === 0 || sampleSize >= vertexCount) {
    return false; // nothing sampled, or the sample WAS the sweep — let the exact check decide
  }

  return (passedInSample / sampleSize) * vertexCount >= budget;
};

type DegreeCountSpec = {
  types: string[] | undefined;
  min: number;
  max: number;
  isTrail: boolean;
  /** Walk the IN-adjacency instead of the out-adjacency — the mirror spelling (item 744). */
  inward: boolean;
  startName: string | undefined;
  passes: (v: Vertex) => boolean;
  /** True when `passes` cannot reject, so the degree is a set SIZE rather than a walk. */
  passesIsVacuous: boolean;
};

/** Bundled, not eight positional parameters: the arity limit, and the same reason
 *  `buildOneHopCount` bundles its `ends`. */
/**
 * `count(*)` over a bounded WALK of ANY depth, counted by LEVELS (item 588) — the TypeScript twin
 * of native's `walk_levels_total`.
 *
 *   u_0(v) = 1 if the endpoint test passes v, else 0
 *   u_j(v) = sum over wanted out-edges v -> y of u_{j-1}(y)
 *
 * so the answer is `sum over sources s, over j in min..=max, of u_j(s)`, one pass over the graph
 * per level instead of one per PATH. Specialize it to max = 2 by hand and it is
 * `varLengthDegreeCount`'s arithmetic term for term: `u_1(s)` is the passing out-degree its
 * `degreeOf` memoizes and `u_2(s)` the sum of neighbours' passing out-degrees.
 *
 * Item 587 shipped this in native, where the bench then priced the TS side of the SAME shape at
 * `ts 8362.9ms against ffi 5.6` — the largest TS/native gap in `bun run bench`, because TS had no
 * depth-3 rung at all and enumerated every path.
 *
 * THE LEVELS ARE DENSE ARRAYS OVER A FLATTENED ADJACENCY (item 589), not maps over vertices. Item
 * 588 shipped this as `Map<Vertex, number>` and left TS at 115x native, ASSERTING the map was the
 * cause. Measured rather than assumed, at 60,000 vertices / 180,000 edges:
 *
 *   cost is linear in depth          23.83 ms per level, intercept 3.12 ms
 *   walk the adjacency only           3.34 ms
 *   ... + one Map.get per edge       19.05        so the map is 15.71 of the 23.83
 *   ... + Map.get INDEX, dense read  19.52        going THROUGH a map to get an index is as slow
 *   one Map.set per vertex            2.30
 *   ------------------------------------------
 *   BUILD a CSR once (E map lookups) 18.28        one level's worth, paid once
 *   dense read from the built CSR     0.10 ms per level
 *   dense write per vertex            0.18
 *
 * So depth k goes from ~23.8k to ~18.3 + 0.3k. The map had to be removed from the per-level loop
 * ENTIRELY for that — resolving an index through a map per edge costs the same 19.5ms, which is why
 * the neighbour indices are precomputed instead of looked up.
 *
 * `Float64Array` holds exactly what the map held: a JS number IS an f64, and the sums run in the
 * same adjacency order, so this is a layout change and not a semantic one.
 *
 * WALK ONLY, exactly as in native. A trail forbids reusing an edge, which is not a function of the
 * current level: `u_j` would have to know which edges the walk already used, making it a map over
 * walks rather than over vertices.
 */
/**
 * The walks of length 3 from `v` that REUSE an edge — subtracted from `u_3(v)` to turn a walk count
 * into a trail count (item 601).
 *
 * MODULE SCOPE, not a closure inside `walkLevelCount`. Two reasons and they agree: the lint
 * complexity cap refused the enclosing function at 36, and [[ts-closure-size-is-load-bearing]]
 * records that a walk written INLINE in a returned closure gave UNRELATED queries a new slow mode
 * (4x). The arrays come in as parameters so nothing is captured.
 *
 * `off`/`nbr` are the flattened wanted-type adjacency, `pass` is `u_0` (the endpoint mask as 0/1),
 * `selfLoops[v]` the number of `v -> v` edges and `passDeg[v]` the PASSING out-degree.
 */
const reusedTrailsAt3 = (
  v: number,
  off: Int32Array,
  nbr: Int32Array,
  pass: Float64Array,
  selfLoops: Float64Array,
  passDeg: Float64Array,
): number => {
  const end = off[v + 1];
  // e0 == e1: a self-loop at `v`, then any passing edge out of `v`. The walk ends at that third
  // edge's target, which is why the factor is the passing out-degree and not the raw one.
  let bad = selfLoops[v] * passDeg[v];

  for (let k = off[v]; k < end; k += 1) {
    const b = nbr[k];

    if (pass[b] === 0) {
      continue; // both remaining cases end at `b`
    }

    // e1 == e2: a self-loop at the landing, taken twice.
    bad += selfLoops[b];

    // e0 == e2: an edge back from `b` to `v`, then THIS edge again. COUNTED, not a boolean — two
    // parallel `v -> b` edges make `e0, b -> v, e2` a valid trail when `e0 !== e2`, so there is
    // one bad walk per reverse edge and "does a reverse edge exist" is the wrong question. A
    // mutant written that way is caught only by a fixture with parallel edges.
    const bEnd = off[b + 1];

    for (let j = off[b]; j < bEnd; j += 1) {
      if (nbr[j] === v) {
        bad += 1;
      }
    }
  }

  // All three equal: a self-loop at `v` used three times, ending back at `v`. Each of the three
  // terms above removed it once, so it comes back twice.
  return bad - 2 * selfLoops[v] * pass[v];
};

/**
 * Everything depth 4 needs beyond the depth-3 tables — bundled for the reason this file already
 * bundles `DegreeCountSpec` and native bundles `Trail3Tables`: the arity limit, and the
 * alternative is positional soup (item 692).
 */
type Trail4Tables = {
  off: Int32Array;
  nbr: Int32Array;
  selfLoops: Float64Array;
  /** `walk_2(v)`, snapshotted before the level loop overwrote it. */
  walk2: Float64Array;
  /** `t3(v) = walk_3(v) − reusedTrailsAt3(v)`, the per-source depth-3 count. */
  t3: Float64Array;
  /** `m(u,v)` — the ordered-pair edge multiplicity, O(1) off an O(E) map. */
  mult: (u0: number, v0: number) => number;
};

/**
 * `u3(b, a)` — the 3-trails STARTING AT `b` that USE a given edge `a → b` (item 692).
 *
 * A trail uses each edge at most once, so that edge sits in exactly ONE of the three positions.
 * The cases are therefore DISJOINT and simply add, which is what replaces inclusion-exclusion over
 * depth 4's six equality events and its 63 intersections (item 600 declined to derive those; item
 * 687 sidestepped them). Validated 600/600 against brute force with 8/8 mutants caught (item 689).
 *
 * EDGE-IDENTITY-FREE, and that is load-bearing: this CSR carries neighbours only, so parallel edges
 * are indistinguishable slots and no `f ≠ e0` test could be written directly. Every such exclusion
 * reduces to a ±1 correction keyed on whether the edge LEAVES `b` — i.e. on `a === b`.
 *
 * Derived for a TRIVIAL endpoint mask, which is why the caller is gated on `passesIsVacuous`.
 */
const usedTrailsAt3 = (b: number, a: number, t: Trail4Tables): number => {
  const { off, nbr, selfLoops, walk2, mult } = t;
  const bEnd = off[b + 1];
  const od = bEnd - off[b];
  const loops = selfLoops[b];
  let total = 0;
  let acc = 0;

  if (a === b) {
    // The edge is a SELF-LOOP at `b`, so it leaves `b` and competes with f1 and f2.
    //   f0 = e0: e0, then a 2-trail from b avoiding e0
    //   f1 = e0: a self-loop f0 ≠ e0, then e0, then f2 ∉ {f0, e0}
    total += walk2[b] - loops * od + (loops - 1) * (od - 2);
    total += (loops - 1) * (od - 2);

    // f2 = e0: a 2-trail b→c→b, then e0. The one f0 that IS e0 is removed AFTER the sum rather
    // than skipped inside it — that is what keeps this free of edge identities.
    for (let j = off[b]; j < bEnd; j += 1) {
      const c = nbr[j];

      acc += c === b ? loops - 2 : mult(c, b);
    }

    return total + acc - (loops - 2);
  }

  // The edge does not leave `b`, so it can be neither f0 nor f2 and only the landing tests matter.
  total += mult(b, a) * (od - 1);

  for (let j = off[b]; j < bEnd; j += 1) {
    acc += mult(nbr[j], a);
  }

  return total + acc;
};

/** `T4(s)` — the 4-trails starting at `s`, as `Σ_{e0: s→b} [ t3(b) − u3(b, s) ]` (item 692). */
const trailsAt4From = (s: number, t: Trail4Tables): number => {
  const end = t.off[s + 1];
  let total = 0;

  for (let k = t.off[s]; k < end; k += 1) {
    const b = t.nbr[k];

    total += t.t3[b] - usedTrailsAt3(b, s, t);
  }

  return total;
};

/**
 * The ordered-pair edge multiplicity `m(u,v)`, as a lookup over an O(E) map.
 *
 * This is the "auxiliary O(E) structure" item 600b named and declined to assume. With it depth 4's
 * expensive term costs `Σ_b in(b)·out(b)` — the TWO-walk count — in lookups, where probing the
 * adjacency for the same number costs the THREE-walk count: item 689 measured 197x against
 * enumeration where item 686's adjacency-probing estimate predicted ~78x.
 *
 * A Map, against this function's own rule that "no level consults a Map at all" — that rule
 * protects depths 1-3, which never reach here. The alternative is a neighbour-SORTED CSR, which
 * item 688 priced as the wrong trade for TypeScript specifically, since this CSR is rebuilt per
 * QUERY while native's is a persistent overlay.
 */
const pairMultiplicities = (
  off: Int32Array,
  nbr: Int32Array,
  n: number,
): ((u0: number, v0: number) => number) => {
  const pairs = new Map<number, number>();

  for (let v = 0; v < n; v += 1) {
    const end = off[v + 1];

    for (let k = off[v]; k < end; k += 1) {
      const key = v * n + nbr[k];

      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }

  return (u0, v0) => pairs.get(u0 * n + v0) ?? 0;
};

/**
 * The per-LEVEL trail correction: what to SUBTRACT from the walk count at level `len`.
 *
 * PER LEVEL and not once per range, which is the distinction item 602 records — a correction
 * applied once for the whole range answers `{3,3}` correctly and `{1,3}` wrongly. Level 1 needs
 * none, since one edge cannot repeat.
 */
const trailCorrectionAt = (
  len: number,
  srcIdx: Int32Array,
  u: Float64Array,
  csr: { off: Int32Array; nbr: Int32Array },
  masks: { pass: Float64Array; selfLoops: Float64Array; passDeg: Float64Array },
  tables4: Trail4Tables | undefined,
): number => {
  const { pass, selfLoops, passDeg } = masks;
  let bad = 0;

  // LEVEL 2: the one path that reuses a self-loop, `s -> s -> s`, and only when the endpoint
  // passes — the correction the `max <= 2` closed form already applied.
  if (len === 2) {
    for (const si of srcIdx) {
      bad += selfLoops[si] * pass[si];
    }
  } else if (len === 3) {
    // NOT gated on `tables4`: depth 3 never builds it, and gating here would silently drop the
    // level-3 correction for `max === 3` — caught by the brute-force oracle on the first run.
    for (const si of srcIdx) {
      bad += reusedTrailsAt3(si, csr.off, csr.nbr, pass, selfLoops, passDeg);
    }
  } else if (len === 4 && tables4 !== undefined) {
    // LEVEL 4 (item 692): `walk4(s) − T4(s)`, by the identity validated at items 687 and 689.
    for (const si of srcIdx) {
      bad += u[si] - trailsAt4From(si, tables4);
    }
  }

  return bad;
};

/**
 * Depth 4's tables, built at the end of LEVEL 3 — where `u` still holds `walk_3` (item 692).
 *
 * `reusedTrailsAt3` runs once per VERTEX, not once per edge: the identity needs `t3` at every
 * landing, and a landing is reached by `in(b)` different edges. That makes this O(V + the 2-walk
 * count), the same order as the depth-3 route's own work rather than a new asymptote (item 688).
 */
const buildTrail4Tables = (
  walk3: Float64Array,
  csr: { off: Int32Array; nbr: Int32Array },
  masks: { pass: Float64Array; selfLoops: Float64Array; passDeg: Float64Array },
  walk2: Float64Array,
  mult: (u0: number, v0: number) => number,
): Trail4Tables => {
  const { off, nbr } = csr;
  const { pass, selfLoops, passDeg } = masks;
  const t3 = new Float64Array(walk3.length);

  for (let v = 0; v < walk3.length; v += 1) {
    t3[v] = walk3[v] - reusedTrailsAt3(v, off, nbr, pass, selfLoops, passDeg);
  }

  return { off, nbr, selfLoops, walk2, t3, mult };
};

/**
 * The depth-3/4 trail correction's masks, all three O(V + E) off the CSR.
 *
 * `pass` is `u_0` — the endpoint mask as 0/1, captured BEFORE the level loop overwrites `u`.
 * `selfLoops[v]` counts wanted `v -> v` edges, and `passDeg[v]` is the PASSING out-degree, which is
 * what the `e0 == e1` term needs: that walk ends at the third edge's target, so the factor is the
 * passing out-degree and not the raw one. All three are built with the same mask the level loop
 * uses, so a correction can never count an edge the walk would not have traversed.
 */
const buildTrailMasks = (
  u0: Float64Array,
  csr: { off: Int32Array; nbr: Int32Array },
): { pass: Float64Array; selfLoops: Float64Array; passDeg: Float64Array } => {
  const { off, nbr } = csr;
  const pass = Float64Array.from(u0);
  const selfLoops = new Float64Array(pass.length);
  const passDeg = new Float64Array(pass.length);

  for (let v = 0; v < pass.length; v += 1) {
    const end = off[v + 1];
    let sl = 0;
    let pd = 0;

    for (let k = off[v]; k < end; k += 1) {
      const y = nbr[k];

      if (y === v) {
        sl += 1;
      }

      pd += pass[y];
    }

    selfLoops[v] = sl;
    passDeg[v] = pd;
  }

  return { pass, selfLoops, passDeg };
};

const walkLevelCount = (graph: Graph, spec: DegreeCountSpec): number => {
  const { types, min, max, isTrail, inward, startName, passes } = spec;
  // THE ONLY THING DIRECTION CHANGES (item 744): which adjacency box the CSR is built from, and
  // which end of each edge is the neighbour. Everything downstream — the level recurrence, and the
  // depth-3/4 trail correction via `buildTrailMasks` and `buildTrail4Tables` — takes `{off, nbr}`
  // and never consults the graph again, so it inherits the direction for free.
  const edgesOf = (v: Vertex): Iterable<Edge> => {
    const box = inward ? v.adjTo : v.adjFrom;

    return box === undefined ? [] : edgesOfTypes(box, types);
  };
  // ONE PASS to number the vertices, then the adjacency FLATTENED into neighbour indices. After
  // this no level consults a Map at all, which is the whole point — see the attribution above.
  const order = [...graph.verticesById.values()];
  const idx = new Map<Vertex, number>();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  // PREALLOCATED to the graph's edge count and filled in ONE pass. Built as a `number[]` with
  // `push` and then `Int32Array.from`, the same CSR cost ~55ms instead of ~20 — boxing, array
  // growth, and then a full copy — which showed up as the whole route reading 58ms flat in depth
  // where the per-level work is 0.3ms. The wanted-type filter can only keep FEWER edges than the
  // graph has, so `edgeCount` is a safe bound and the slack is never touched.
  const nbr = new Int32Array(graph.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    for (const e of edgesOf(order[i])) {
      nbr[at] = idx.get(inward ? e.from : e.to) ?? 0;
      at += 1;
    }
  }

  off[order.length] = at;
  // f64 accumulators, which is what the Map held: a JS number IS an f64, so this stores the same
  // bits and sums in the same adjacency order. Not a semantic change, a layout one.
  let u = new Float64Array(order.length);
  let next = new Float64Array(order.length);

  for (let i = 0; i < order.length; i += 1) {
    u[i] = passes(order[i]) ? 1 : 0;
  }

  const src = startName === undefined ? order : [...(graph.verticesByLabel.get(startName) ?? [])];
  // The sources' indices, resolved ONCE. They are read at every level, and when the start label is
  // absent that is one map lookup per vertex per level — the same cost this route exists to remove.
  const srcIdx = new Int32Array(src.length);

  for (let i = 0; i < src.length; i += 1) {
    srcIdx[i] = idx.get(src[i]) ?? 0;
  }

  let total = 0;

  // THE TRAIL CORRECTION (item 601), for `max === 3` only. A trail forbids reusing an EDGE, which
  // the level recurrence cannot express — `u_j` would have to know which edges the walk already
  // used. But at depth 3 the walks to exclude are exactly those where two of `e0, e1, e2`
  // coincide, and each case collapses to a countable term:
  //
  //   e0 == e1  forces a == b == c, i.e. a SELF-LOOP at the source, then any third edge out of it
  //   e1 == e2  is its mirror: an edge out, then a self-loop at the landing taken twice
  //   e0 == e2  forces a == c and b == d — the 2-cycle `a -> b -> a` reusing the first edge
  //   all three equal is a self-loop used three times, subtracted by all three terms above, so it
  //   returns with coefficient 2
  //
  // Each endpoint test applies at the walk's LAST node, which is why the terms carry different
  // `pass` factors: `e0 == e1` ends at the third edge's target, `e1 == e2` and `e0 == e2` end at
  // the landing `b`, and the triple case ends back at the source.
  //
  // Verified against brute-force triple enumeration over 400 random graphs admitting SELF-LOOPS
  // and PARALLEL EDGES (item 600) — parallel edges are what break a naive version, because two
  // parallel `a -> b` edges make `e0, b -> a, e2` a VALID trail when `e0 !== e2`, and the
  // `e0 == e2` term must subtract only the one walk whose third edge is literally the first.
  //
  // `selfLoops` and the PASSING out-degree are O(V + E) off the CSR. The `e0 == e2` term is not:
  // it needs the multiplicity of an ordered pair and this adjacency is in edge-insertion order,
  // so it probes the landing's segment and costs the TWO-WALK count. That is still a factor of
  // the average degree below enumerating three-walks, which is the whole win (item 600b corrects
  // an earlier claim that it was O(V + E)).
  // DEPTH 2 joins the level recurrence at item 699. It used to take the `max <= 2` closed form,
  // which is the SAME arithmetic over the Map-based adjacency rather than the flat CSR — and
  // measured SLOWER than depth 3 while counting a third as many paths (15.4 ms against 9.2 at
  // 50,000 vertices / degree 3). Its correction is the one-self-loop term the old path already
  // applied, and it is already in `trailCorrectionAt`'s `len === 2` branch.
  //
  // Relaxing the dispatch bound WITHOUT this line answers the WALK count — 450,000 against the
  // trail's 449,998 — which is item 692's mistake exactly, caught here by printing the answers
  // beside the times (item 600's rule) rather than by any timing.
  const trail2 = isTrail && max === 2;
  const trail3 = isTrail && max === 3;
  // DEPTH 4 (item 692) reuses every depth-3 table and adds three things of its own. It is gated on
  // `passesIsVacuous` because the depth-4 terms were derived for a TRIVIAL endpoint mask (items
  // 687-689) and nothing validates them against a filtered one; the detector refuses otherwise.
  const trail4 = isTrail && max === 4;
  const trailCorr = trail2 || trail3 || trail4;
  const trailMasks = trailCorr ? buildTrailMasks(u, { off, nbr }) : undefined;

  // DEPTH 4's extra state, built only when `trail4` so no shallower depth pays for it. See
  // `pairMultiplicities` for why a Map is the right trade here and the wrong one for native.
  const mult = trail4 ? pairMultiplicities(off, nbr, order.length) : undefined;
  // `u` is swapped per level, so without this the depth-4 terms would read a vector that has
  // already been overwritten.
  let walk2Snap: Float64Array | undefined;
  let tables4: Trail4Tables | undefined;

  // The ZERO-LENGTH path, whose endpoint is the SOURCE — one row per source row. `src` may hold a
  // vertex more than once, so this counts rows rather than summing `u_0` over distinct vertices.
  if (min === 0) {
    for (const s of src) {
      if (passes(s)) {
        total += 1;
      }
    }
  }

  for (let len = 1; len <= max; len += 1) {
    for (let v = 0; v < order.length; v += 1) {
      const end = off[v + 1];
      let acc = 0;

      for (let k = off[v]; k < end; k += 1) {
        acc += u[nbr[k]];
      }

      next[v] = acc;
    }

    const swap = u;

    u = next;
    next = swap;

    // OUTSIDE the `len >= min` gate on purpose: the recurrence runs at every level whatever `min`
    // is, and `{4,4}` needs the level-2 and level-3 vectors even though neither is emitted.
    if (trail4) {
      if (len === 2) {
        walk2Snap = Float64Array.from(u);
      } else if (len === 3) {
        tables4 = buildTrail4Tables(u, { off, nbr }, trailMasks!, walk2Snap!, mult!);
      }
    }

    if (len >= min) {
      // AN INDEX LOOP, against `prefer-for-of`, and the exemption is measured rather than
      // asserted. `for (const i of srcIdx)` goes through the iterator protocol once per source
      // per LEVEL, and cost 0.97x at `{1,3}` and 0.92x at `{1,6}` over three alternated rounds,
      // one case per process — the penalty scaling with depth is the tell. I had written "within
      // noise of the indexed form" in this comment BEFORE measuring it, which was wrong.
      // oxlint-disable-next-line typescript/prefer-for-of -- 8% at depth 6; see the numbers above
      for (let i = 0; i < srcIdx.length; i += 1) {
        total += u[srcIdx[i]];
      }

      if (trailCorr) {
        total -= trailCorrectionAt(len, srcIdx, u, { off, nbr }, trailMasks!, tables4);
      }
    }
  }

  return total;
};

/**
 * Does this spec take the LEVEL RECURRENCE rather than the `max <= 2` closed form?
 *
 * A named predicate rather than an inline condition because it is the ROUTE CHOICE, and because
 * `varLengthDegreeCount` is at the lint complexity cap — an extra `||` in there is refused.
 *
 *   - a WALK at ANY depth: the recurrence is exact, nothing is forbidden (item 587/589).
 *   - a TRAIL at EXACTLY 3: the recurrence plus `reusedTrailsAt3`'s four-term correction
 *     (item 601). This is the DEFAULT spelling — `parsePathMode` returns `trail` with no keyword
 *     — so `-[:K]->{3}` lands here, and it is the shape that had no rung at all before.
 *   - a TRAIL at 4 or more: still refused. The correction grows a term per coinciding PAIR and
 *     the pairs start interacting; item 600 derived depth 3 and explicitly did not derive 4.
 *   - `max <= 2`: unchanged, runs the code it has always run.
 *
 * THE `spec.max === 3` CLAUSE IS A SECOND LINE OF DEFENCE, not the active guard, and a mutant
 * relaxing it to `spec.max >= 3` SURVIVES — including against the depth-4 test added for exactly
 * that. The reason is reachability: `detectVarLengthCount` already refuses `max > 3` for anything
 * but a walk, so a depth-4 trail never arrives here. The ACTIVE guard is that detector bound, and
 * mutating IT (to `max > 4`, or dropping the mode check) is CAUGHT.
 *
 * Kept anyway, for the same reason the `!spec.isTrail` clause was kept before this item: whoever
 * derives the depth-4 correction will relax the detector first, and this is then the one line
 * standing between a depth-4 trail and a depth-3 correction that does not apply to it. A guard
 * against a future relaxation is not the same as a guard against nothing — but it should not be
 * mistaken for the one under test, which is what cost this item a mutation round.
 */
const takesTheLevelRecurrence = (spec: DegreeCountSpec): boolean =>
  spec.max >= 2 && (!spec.isTrail || spec.max <= 4);

const varLengthDegreeCount = (graph: Graph, spec: DegreeCountSpec): number => {
  // DEPTH 3+ IS A DIFFERENT ALGORITHM, and it is dispatched here rather than in the detector so
  // that both of the detector's closures keep exactly the captures they had (item 583's split, and
  // [[ts-closure-size-is-load-bearing]] behind it). `max <= 2` runs the code it has always run.
  //
  // `!spec.isTrail` is UNREACHABLE TODAY and kept deliberately — a mutant removing it SURVIVES,
  // because `detectVarLengthCount` already refuses `max > 2` for anything but a walk, and the two
  // closures there are this function's only callers. Item 583 deleted a guard in exactly that
  // position as dead code; this one stays because the condition it duplicates is a RECORDED OPEN
  // TARGET. A trail past two hops needs its own inclusion-exclusion over edge-reuse shapes, and
  // whoever lands that will relax the detector's bound — at which point this is the one line
  // standing between a trail and the walk's arithmetic, which would answer 32 where the trail
  // answers 28. A guard against a future relaxation is not the same as a guard against nothing.
  //
  // THAT HAPPENED, AT ITEM 692, EXACTLY AS WRITTEN. The depth-4 closed form relaxed the detector's
  // bound to 4 and left this bound at 3, so a depth-4 trail fell through to the `max <= 2`
  // arithmetic and answered the WALK count — 3 where the trail answers 0 on a triangle. The
  // brute-force oracle (item 690) caught it on its first run. The bound is now `max <= 4`, and the
  // same note applies again to whoever lands depth 5.
  if (takesTheLevelRecurrence(spec)) {
    return walkLevelCount(graph, spec);
  }

  const { types, min, max, isTrail, startName, passes, passesIsVacuous } = spec;
  // `edgesOfTypes`, NOT a sum of per-label `set.size`. A MULTI-LABEL edge sits in several of
  // this box's buckets, so summing their sizes counts it once per label it carries — which is
  // what `multi-label-edges.test.ts` ("a reachability walk visits each edge once") caught,
  // answering 8 where the walk answers 3. That helper already dedupes through a `Set` and keeps
  // the O(1) routes for a single wanted type and a single-bucket graph, so the degree stays a
  // set SIZE in the common case and becomes a deduped walk only when it has to.
  //
  // My own `[:T|U]` sweep cases did NOT catch this: their T and U edges were disjoint, so right
  // and wrong agreed. Seventh coinciding fixture in this run of ticks, and the first the repo's
  // existing suite caught rather than a probe.
  const edgesOf = (v: Vertex): Iterable<Edge> => {
    const box = v.adjFrom;

    return box === undefined ? [] : edgesOfTypes(box, types);
  };
  // THE SECOND HOP, FORWARDS OR BACKWARDS (item 585).
  //
  // The quantity wanted is, per vertex, how many of its out-edges land somewhere that PASSES.
  // Walking out-edges pays one visit per edge IN THE GRAPH and is flat in how selective the
  // endpoint test is — item 584 measured that directly: rejecting every vertex (355.24ms) costs
  // nearly what accepting every vertex does (446.49), against 187.87 unfiltered.
  //
  // The same quantity accumulated BACKWARDS costs one visit per edge INTO A PASSING VERTEX. For
  // each passing `z`, every in-edge of `z` adds one to its source's count. That scales with
  // selectivity, which is the property the forward walk does not have.
  //
  // It is a CHOICE and not a replacement, because `degreeOf` is demand-driven: it computes a
  // degree only for vertices actually reached at hop 1, so a narrow start label can make the
  // forward route cost far less than O(E), while inversion is eager over every passing vertex.
  // The comparison is `reached x avg_deg` against `passing x avg_indeg` — and since in and out
  // degree average the same thing over a whole graph, that reduces to `passing` against
  // `reached`. Both thresholds below are cost ESTIMATES, not tuned knobs.
  const srcCount =
    startName === undefined ? graph.vertexCount : (graph.verticesByLabel.get(startName)?.size ?? 0);
  const reachedEst = invertedHopBudget(graph.vertexCount, graph.edgeCount, srcCount);
  let passdeg: Map<Vertex, number> | undefined;

  // The predicate sweep that gives `passing` is itself O(V) — 200,000 calls at the ~15ns item 584
  // priced is ~3ms against the ~240ms being decided about — but it is still wasted work when the
  // forward route was never going to touch many edges, hence the outer guard.
  if (!passesIsVacuous && max >= 2 && reachedEst !== null) {
    const passing: Vertex[] = [];
    // SAMPLE FIRST. `verticesById` is insertion-ordered, so this is a prefix and not a random
    // sample — which is why `sampleRulesOutInversion` wants a factor of two before it declines.
    const sampleSize = Math.min(1024, graph.vertexCount);
    let sampled = 0;
    let passedInSample = 0;
    let ruledOut = false;

    for (const v of graph.verticesById.values()) {
      if (sampled < sampleSize) {
        sampled += 1;

        if (passes(v)) {
          passedInSample += 1;
          passing.push(v);
        }

        if (
          sampled === sampleSize &&
          sampleRulesOutInversion(sampleSize, passedInSample, graph.vertexCount, reachedEst)
        ) {
          ruledOut = true;
          break;
        }

        continue;
      }

      if (passes(v)) {
        passing.push(v);

        // Stop as soon as inversion is known to LOSE. A test that passes everything cannot be
        // worth inverting, and without this bound the sweep is pure loss on exactly that shape:
        // the `TRUE for all` arm measured 361.48 against 371.54, ~3% for a decision that then
        // declined. The bound only bites when `reachedEst` is below the vertex count, i.e. when
        // the start label is narrow — which is also the case where the forward route was already
        // the right answer.
        if (passing.length >= reachedEst) {
          break;
        }
      }
    }

    if (!ruledOut && passing.length < reachedEst) {
      passdeg = new Map();

      for (const z of passing) {
        const box = z.adjTo;

        if (box === undefined) {
          continue;
        }

        // `edgesOfTypes` on the IN side for the same reason it is used on the out side: a
        // MULTI-LABEL edge sits in several buckets and must be counted once.
        for (const e of edgesOfTypes(box, types)) {
          passdeg.set(e.from, (passdeg.get(e.from) ?? 0) + 1);
        }
      }
    }
  }

  // The PASSING out-degree, memoized per vertex. Keyed on the vertex OBJECT: audit item 321
  // prices that at 30.5ns against 59.7 for the id string, and this is read once per edge.
  const deg = new Map<Vertex, number>();
  const degreeOf = (v: Vertex): number => {
    if (passdeg !== undefined) {
      // Already complete for every vertex with a passing out-neighbour; absent means zero.
      return passdeg.get(v) ?? 0;
    }

    const hit = deg.get(v);

    if (hit !== undefined) {
      return hit;
    }

    const it = edgesOf(v);
    let n: number;

    if (passesIsVacuous && it instanceof Set) {
      n = it.size; // the O(1) route: one wanted type, or a graph of one edge label
    } else {
      n = 0;

      for (const e of it) {
        if (passes(e.to)) {
          n += 1;
        }
      }
    }

    deg.set(v, n);

    return n;
  };
  const sources =
    startName === undefined
      ? graph.verticesById.values()
      : (graph.verticesByLabel.get(startName) ?? []);
  let total = 0;

  for (const s of sources) {
    // The zero-length path: its endpoint is the SOURCE.
    if (min === 0 && passes(s)) {
      total += 1;
    }

    if (max === 0) {
      continue;
    }

    for (const e of edgesOf(s)) {
      const y = e.to;

      if (min <= 1 && passes(y)) {
        total += 1; // the 1-hop path s -> y
      }

      if (max >= 2) {
        total += degreeOf(y);

        // A trail excludes the one path that reuses THIS edge, `s -> s -> s`, which
        // `degreeOf(s)` counted — and only when that endpoint passes.
        if (isTrail && y === s && passes(s)) {
          total -= 1;
        }
      }
    }
  }

  return total;
};

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
  ends?: {
    inNear?: InlinePred;
    inFar?: InlinePred;
    cstart?: CNode;
    cfar?: CNode;
    /** The caller has compiled the rel's inline `WHERE` INTO `pred` (item 633). An explicit
     *  flag rather than something inferred from `pred`: inferring it from `pred.relVar` let a
     *  CLAUSE predicate that happens to read the rel admit a rel whose inline `WHERE` was
     *  never carried, and the tally then counted 3 where the answer is 2 — the "silently
     *  IGNORED, a wrong answer rather than a slow one" trap this file warns about twice,
     *  caught by `inline-rel-count.test.ts`. */
    relCarried?: boolean;
    /** The rel's inline constraint, applied per EDGE via `satisfies` (item 637). Unlike
     *  `relCarried` this is NOT folded into `pred`: it is an independent gate, so a clause
     *  `WHERE` reading the rel and inline rel properties can both be present. */
    inRel?: InlinePred;
  },
): CountOf<T> | null => {
  const { inNear, inFar, cstart, cfar, relCarried, inRel } = ends ?? {};
  const { rel, node } = seg;

  // `plainNode(node)` is deliberately NOT required: an inline endpoint constraint
  // is carried in `inFar` instead of declining the shortcut (item 124). The caller
  // only supplies it after checking the constraint is CLOSED, and the rel must
  // still be plain — a rel predicate would need its own treatment.
  // `both` is admitted only UNFILTERED and with no inline endpoint constraint — those arms all
  // walk with a captured `out: boolean`. The undirected arm below answers every label case
  // itself, because a `CountOf` closure has no way to decline once it is built (item 482).
  // A rel carrying ONLY an inline `WHERE` is admitted when the caller has compiled it into
  // `pred` with `relVar` set — the same shape the clause spelling arrives as, so every arm and
  // every decline below works unchanged (the degree-sum arms guard on
  // `pred.relVar === undefined`). Item 633; item 632 measured the gap this closes.
  //
  // INLINE PROPERTIES still decline, and not for want of effort: `{k: v}` is IS-NULL
  // semantics rather than `=` — with a null value it matches a stored null where
  // `r.k = null` matches nothing — and a `$param`'s value is unknown at compile time. A
  // synthesized `compare` would reintroduce item 210's "route two" divergence as a WRONG
  // ANSWER, so `relInlineWhereOnly` admits the `WHERE` form only.
  // INLINE PROPERTIES now have a route too (item 637), and it is NOT the one refused above:
  // nothing is synthesized into a `compare`. `relInlineOf` hands them to `compilePredicate`
  // and `inRel` applies them through `satisfies` — the general path's own matcher — so the
  // IS-NULL semantics are the matcher's, not a re-derivation that could drift from it.
  if (!plainRel(rel) && relCarried !== true && inRel === undefined) {
    return null;
  }

  // A CONSTRAINED undirected hop used to decline here outright, which sent
  // `MATCH (a:L)-[:T]-(x) WHERE <a-only>` to the general path at 106x native (item 1075). A
  // START-ONLY constraint now has `undirectedStartOnlyCount`; everything else still declines,
  // because a degree sum cannot apply a FAR or REL constraint — it never visits the far end or
  // the edge — and ignoring one would be a wrong answer rather than a slow one (item 637).
  // ⚠️ THESE TWO DECLINES ARE GONE (item 1086). A far label, a far-reading predicate and a rel
  // constraint each made a constrained undirected hop fall to the general path — a binding and a
  // row per edge, measured by item 1076's own controls at 372.35 ms (far label), 910.25 (far
  // predicate) and 922.25 (rel predicate). `undirectedTally` answers all of them by running the
  // existing directed tally ONCE PER DIRECTION, which is what `-[:T]-` means, so the degree-sum
  // arm below keeps the start-only case and nothing declines for want of a route.

  // A MULTI-TYPE alternation and an untyped `-[]-` used to decline here, and item 1076 gave the
  // reason: `degreeOfTypes` sums the per-type bucket SIZES, so an edge carrying both `T` and `S`
  // is counted once per bucket and `(:P)-[:T|S]-(x) WHERE true` answered 6 against the unfiltered
  // route's 4. `startWalkFits` carries the same condition for the directed walk — "summing
  // per-type bucket sizes is sound only when no edge sits in two of them".
  //
  // That condition is `types?.length === 1 || multiTypeEdgeCount === 0`, and item 1076 took only
  // the FIRST half, on the grounds that the second is a runtime property this closure cannot ask.
  // IT CAN: the undirected branch below returns `(graph, params) => …` and the branch beside it
  // already reads `graph.multiTypeEdgeCount` inside that closure. So there is no decline here at
  // all now — `undirectedStartOnlyCount` asks the full condition per execution, and when it does
  // not hold it SUBTRACTS the overcount exactly rather than declining (item 1078). The untyped
  // spelling measured 257 ms as item 1076's own control.

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
    // UNCONSTRAINED keeps the O(1) arithmetic off the bucket sizes; a START-ONLY constraint takes
    // the degree-sum walk (item 1076). The two are one branch because they are the same question
    // with and without a filter, and the unconstrained row must not move.
    if (pred === undefined && inNear === undefined && inFar === undefined && inRel === undefined) {
      return (graph) => rowOf(undirectedHopCount(graph, types, aLabel, bLabel));
    }

    const bareBoth: HopPred = pred ?? { fn: alwaysTrue };
    // THE DEGREE SUM IS SOUND ONLY FOR A START-ONLY CONSTRAINT, and that is the whole of the
    // routing rule: it never visits the far end or the edge, so it cannot apply a far label, a
    // far-reading predicate or a rel constraint, and ignoring one would be a wrong answer rather
    // than a slow one (item 637). Everything else now takes `undirectedTally` (item 1086) instead
    // of declining — one pass per direction over the type's edges, which is what `-[:T]-` means.
    const startOnly = undirectedDegreeSumFits({
      inFar,
      inRel,
      farLabel: bLabel,
      farVar: bareBoth.farVar,
      relVar: bareBoth.relVar,
    });

    return (graph, params) => {
      // The far label is dropped when the degree sum claims the query (it never visits that end)
      // and when it constrains nothing — `vacuousLabel`, item 566. Hoisted rather than nested in
      // the object literal, which `no-nested-ternary` rejects and which read worse anyway.
      const farPb = startOnly || vacuousLabel(graph, bLabel) ? undefined : bLabel;
      const scan: HopScan = {
        graph,
        params,
        pred: bareBoth,
        pa: vacuousLabel(graph, aLabel) ? undefined : aLabel,
        pb: farPb,
        out: true,
        types,
        inNear,
        inFar: startOnly ? undefined : inFar,
        inRel: startOnly ? undefined : inRel,
        cstart,
        cfar: startOnly ? undefined : cfar,
      };

      return rowOf(
        startOnly ? undirectedStartOnlyCount(scan, bareBoth.startVar) : undirectedTally(scan),
      );
    };
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
        inRel,
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

      // THE REL LIFT (item 1034), third and last. No `relWalkFits` predicate: the lift itself IS
      // the fit rule — it is set only when the clause `WHERE` reads exactly the rel's own
      // variable, which is the whole precondition, where the two endpoint walks additionally
      // need the OTHER side unconstrained to sum degrees.
      if (pred.relLifted !== undefined) {
        return rowOf(relOnlyHopCount(scan, pred.relLifted));
      }

      return rowOf(tallyHopCount(scan));
    }

    // An inline endpoint constraint with NO clause `WHERE` still has to be applied,
    // and neither the O(1) bucket-size path nor the label-only walk below can see
    // it — so route those to the tally, which does. Letting the bucket path answer
    // `(b {k: 2})` would return every edge's count.
    if (inNear !== undefined || inFar !== undefined || inRel !== undefined) {
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
        inRel,
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
        // The bare degree sum cannot apply an INLINE constraint, which is why this branch is
        // reached at all, so it declines here — but it is asked rather than skipped, because
        // which of the two inline constraints is present is a per-query fact and `bareDegreeSum`
        // is the one place that rule lives (item 1067).
        return rowOf(bareDegreeSum(scan, undefined, 'start') ?? startOnlyHopCount(scan, undefined));
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
      bucketSumsAreSound(types, graph.multiTypeEdgeCount)
    ) {
      return rowOf(types.reduce((n, t) => n + (graph.edgesByLabel.get(t)?.size ?? 0), 0));
    }

    // AN UNTYPED REL IS EVERY TYPE, AND ITS TOTAL IS `edgeCount` — item 1160.
    //
    // The `types &&` above is a TRUTHINESS test, so `types === undefined` — the untyped
    // spelling — fell through it and took the degree walk below. `MATCH (a)-[]->(x) RETURN
    // count(*)` therefore cost 106-110 ms where its typed twin cost 0.0, measured at 200,000
    // nodes / 800,000 edges over two types (item 1159).
    //
    // THE GREMLIN SURFACE OF THIS SAME ENGINE ALREADY HAD IT: `adjacentCount` answers
    // `labels.length === 0` from `graph.edgeCount`, so `g.V().out().count()` read 0.0 ms on the
    // same graph while this read 109.7. One engine, one question, two surface languages —
    // the spelling cliff this file keeps re-learning, crossing a LANGUAGE boundary this time.
    //
    // NO `bucketSumsAreSound` CONDITION, and that is the point of using the total rather than a
    // sum: `edgeCount` counts each edge ONCE however many labels it carries, so the multi-label
    // hazard that gates the per-type sum above cannot arise here. (`bucketSumsAreSound`'s own
    // header says `types === undefined` means every type and only `multiTypeEdgeCount === 0`
    // could license SUMMING the buckets — this does not sum them.)
    //
    // Both endpoints must still be vacuous, which is what `a === undefined && b === undefined`
    // already established above: a real label on either end makes the answer a degree sum over
    // that bucket, not the whole graph.
    if (a === undefined && b === undefined && types === undefined) {
      return rowOf(graph.edgeCount);
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
  /** The first leg is `-[:T]-`, so BOTH boxes are walked and a self-loop is yielded ONCE
   *  (item 1093). ISO-GQL emits an undirected self-loop once where Gremlin's `both()` yields it
   *  twice, which is why this cannot be the `out + in` desugaring item 1092 used. */
  firstBoth: boolean;
  /** The second leg is `-[:T]-`; `undirectedSide` already carries the same loop rule. */
  secondBoth: boolean;
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
  const { firstBoth, secondBoth } = plan;
  // Once per execution, not per vertex and not per edge — see `effectiveLabel`.
  const midEff = effectiveLabel(graph, midLabel);
  const cEff = effectiveLabel(graph, cLabel);
  const binding = new Map<string, unknown>();
  const env: EvalEnv = { binding, params, graph };
  const seeded = hopSeek(graph, cstart, aLabel, env);
  const startVar = pred?.startVar;
  // Once per execution: does this graph hold a loop of a wanted type at all? The second leg's
  // correction is `undirectedSide`'s own; the first leg's is the `e.fromId === e.toId` skip below.
  const loop1 = firstBoth && loopsOfTypes(graph, t1);
  const loop2 = secondBoth && loopsOfTypes(graph, t2);
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
    if (firstBoth) {
      count += firstLegUndirected(graph, a, plan, { midEff, cEff, loop1, loop2 });

      continue;
    }

    const byType = (firstOut ? graph.edgesFromByLabel : graph.edgesToByLabel).get(a.id);

    for (const e of edgesOfTypes(byType, t1)) {
      // The middle VERTEX is wanted for one thing only — its label — while the second leg counts
      // from its ID, which the edge already holds. So when no label constrains the middle, read
      // `toId` / `fromId` and skip resolving a whole vertex: `e.to` is a string-keyed `Map.get`
      // into `verticesById` (~190ns, item 194), paid once per FIRST-LEG EDGE. Item 140 made the
      // ingest path use these ids for exactly this reason.
      if (midEff === undefined) {
        count += secondBoth
          ? undirectedSide(graph, firstOut ? e.toId : e.fromId, t2, cEff, loop2)
          : side(graph, firstOut ? e.toId : e.fromId, fromCOut, t2, cEff);

        continue;
      }

      const b = firstOut ? e.to : e.from;

      if (!matchesLabel(b, midEff)) {
        continue;
      }

      count += secondBoth
        ? undirectedSide(graph, b.id, t2, cEff, loop2)
        : side(graph, b.id, fromCOut, t2, cEff);
    }
  }

  return count;
};

/**
 * The FIRST leg undirected: the same walk, over both of `a`'s boxes (item 1093).
 *
 * A SEPARATE LOOP, not a branch inside the one above. Item 1091's first cut folded a direction
 * choice into a shared hop body and cost a control it could not reach **1.54x**; item 159 measured
 * 1.6x for the same shape and states the rule — "TWO loops, branched ONCE on which path this is,
 * rather than one loop with the branch inside". So the directed walk above is byte-identical to
 * what it was, and this is its undirected twin.
 *
 * THE SELF-LOOP IS WHY THIS IS NOT `out + in`. ISO-GQL's `-[:T]-` emits a loop ONCE; a loop sits
 * in `adjFrom` AND `adjTo`, so the in-box pass must skip it. (Gremlin's `both()` yields it twice,
 * which is why item 1092 could simply sum the two arms and this cannot — the same split items
 * 1086/1087 recorded between the two surface languages.) `loop1` gates the test, so a loop-free
 * graph pays one boolean.
 */
const firstLegUndirected = (
  graph: Graph,
  a: Vertex,
  plan: TwoHopPlan,
  mid: {
    midEff: LabelExpr | undefined;
    cEff: LabelExpr | undefined;
    loop1: boolean;
    loop2: boolean;
  },
): number => {
  const { t1, t2, fromCOut, secondBoth } = plan;
  const { midEff, cEff, loop1, loop2 } = mid;
  const second = (id: string): number =>
    secondBoth ? undirectedSide(graph, id, t2, cEff, loop2) : side(graph, id, fromCOut, t2, cEff);
  let n = 0;

  for (const e of edgesOfTypes(graph.edgesFromByLabel.get(a.id), t1)) {
    const b = midEff === undefined ? undefined : e.to;

    if (b === undefined || matchesLabel(b, midEff)) {
      n += second(e.toId);
    }
  }

  for (const e of edgesOfTypes(graph.edgesToByLabel.get(a.id), t1)) {
    // The loop was already met in the out-box pass, and `-[:T]-` emits it once. GATED on `loop1`
    // — a graph with no loop of a wanted type pays one boolean instead of a comparison per
    // in-box edge. `loop1` was computed and NOT USED in the first cut, which a mutant setting it
    // to `true` revealed by surviving: an unused gate cannot be got wrong.
    if (loop1 && e.fromId === e.toId) {
      continue;
    }

    const b = midEff === undefined ? undefined : e.from;

    if (b === undefined || matchesLabel(b, midEff)) {
      n += second(e.fromId);
    }
  }

  return n;
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
    // ⚠️ `both` USED TO DECLINE HERE (item 1093), on either leg, and the asymmetry it left is what
    // made this worth doing: `buildTwoHopCount` has carried `aBoth`/`cBoth` for the BARE and
    // middle-constrained chain all along, and the THREE-hop count carries `aBoth`/`midBoth`/
    // `dBoth` — so only a START-FILTERED undirected two-hop fell through. Measured at 100,000
    // vertices x degree 3: `(a:P)-[:T]-(b)-[:T]-(c) WHERE a.age > 60` **755.89 ms** against the
    // directed twin's 35.78 and the bare undirected's 35.00.
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
    firstBoth: s1.rel.direction === 'both',
    secondBoth: s2.rel.direction === 'both',
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
      preds.push(predFor(compilePredicate(undefined, where, start.variable), start.variable, true));
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
        midPred = predFor(compilePredicate(undefined, where, midName), midName, true);
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

    const farName = seg.node.variable;

    pred = {
      fn: compileExpr(where),
      startVar: reads(start.variable),
      farVar: reads(seg.node.variable),
      relVar: reads(seg.rel.variable),
      farLifted: liftedOwnPred(where, free, farName),
      startLifted: liftedOwnPred(where, free, start.variable),
      relLifted: liftedOwnPred(where, free, seg.rel.variable),
    };
  }

  if (segments.length === 1) {
    const [seg] = segments;

    const inFar = inlineOf(seg.node);

    if (inFar === null) {
      return null;
    }

    // AN INLINE REL `WHERE` BECOMES THE SAME `HopPred` ITS CLAUSE TWIN DOES (item 633). Only
    // when there is no clause `WHERE` already occupying `pred`: two predicates would have to
    // be conjoined, and a tally that applied one and dropped the other is a wrong answer. The
    // clause form keeps the route it has; this gives the inline form the same one.
    const carried = relHopPred(seg.rel, pred);

    if (carried === null) {
      return null;
    }

    return buildOneHopCount(seg, start, rowOf, carried.pred, {
      inNear: inStart,
      inFar,
      cstart,
      cfar,
      relCarried: carried.carried,
      inRel: carried.inRel,
    });
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
  // `both` USED TO DECLINE HERE (item 1097). Measured at 60,000 vertices x degree 3:
  // `(a:P)-[:T]-(b)-[:T]-(c)-[:T]-(d) WHERE a.age > 60` **2420.76 ms** against the directed twin's
  // 68.69 — 35x — while the BARE undirected chain is already answered by `buildThreeHopCount`'s
  // `aBoth`/`midBoth`/`dBoth`. So only the FILTERED chain fell through, the same boundary item
  // 1094 found one hop down.
  if (segments.some((s) => !plainRel(s.rel) || s.rel.variable !== undefined)) {
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
  const boths = segments.map((s) => s.rel.direction === 'both');
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
        // Reversing an undirected leg is the identity, so this needs no `flip` handling — which
        // is also why item 308's and item 429's backwards readings stay sound with `both` legs.
        both: boths[i],
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

/**
 * The directions one chain leg traverses — module scope so a leg allocates nothing to say which
 * passes it needs (item 1097). `edgesOfTypes`'s own header records what a per-edge allocation
 * costs in this family; a per-leg one would be smaller and is still avoidable for free.
 */
const BOTH_DIRECTIONS: readonly boolean[] = [true, false];
const OUT_ONLY: readonly boolean[] = [true];
const IN_ONLY: readonly boolean[] = [false];

/** One position of a chain: which way its incoming hop runs, its edge types, its node label. */
type Leg = {
  out: boolean;
  /** The incoming hop is `-[:T]-` (item 1097), so BOTH adjacency indexes are walked and a
   *  self-loop is counted ONCE — ISO-GQL emits an undirected loop once, where Gremlin's `both()`
   *  yields it twice (items 1086/1087/1092). `out` is then meaningless and is left as written. */
  both: boolean;
  types: string[] | undefined;
  label: LabelExpr | undefined;
  /** The landed node's INLINE constraint, applied once per distinct vertex reached here. */
  gate: InlinePred | undefined;
};

/**
 * Which directions one leg traverses: both for `-[:T]-`, one otherwise (item 1097).
 *
 * A function rather than a nested ternary at the call site, which `no-nested-ternary` rejects and
 * which read worse anyway. The three results are module-scope constants, so a leg allocates
 * nothing to say what it needs.
 */
const legDirections = (leg: Leg): readonly boolean[] => {
  if (leg.both) {
    return BOTH_DIRECTIONS;
  }

  return leg.out ? OUT_ONLY : IN_ONLY;
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
/**
 * ONE DIRECTION of one chain leg: the frontier walk, extracted (item 1097).
 *
 * It is a function because the per-direction loop pushed `sweepChain` past two lint gates at once
 * — complexity 42 against a maximum of 35, and a block depth of 6 against 5. `hopChainShape` is
 * the file's own precedent ("Its own function because `hopChainCount` sits on the complexity
 * gate"), and the call is per LEG-DIRECTION rather than per edge, so the hot body is untouched:
 * item 1091 measured what a per-vertex call costs a control it cannot reach (1.54x).
 *
 * The slot arrays are REASSIGNED when they grow, so they travel in a mutable `st` and the grown
 * ones are handed back. `next` and `nextFrontier` accumulate across both of a `both` leg's calls,
 * which is what makes two passes one pass of the chain.
 */
/** The mutable per-pass state the sweep hands to whichever walk answers a leg. */
type SweepState = {
  graph: Graph;
  params: Params;
  binding: Map<string, unknown>;
  slotOf: Map<string, number>;
  idOf: string[];
  cache: (Map<string, Set<Edge>> | undefined)[] | undefined;
  cached: Map<string, Map<string, Set<Edge>>> | undefined;
  ways: Float64Array;
  next: Float64Array;
  cap: number;
  frontier: readonly number[];
  nextFrontier: number[];
};

const sweepOneDirection = (
  st: SweepState,
  leg: Leg,
  far: LabelExpr | undefined,
  out: boolean,
): void => {
  const { graph, params, binding, slotOf, idOf, cache, cached, frontier, nextFrontier } = st;
  const index = out ? graph.edgesFromByLabel : graph.edgesToByLabel;
  // A self-loop sits in BOTH indexes and `-[:T]-` emits it ONCE, so the second pass skips it.
  // Gated on the graph actually holding one, so a loop-free graph pays one boolean per leg.
  const skipLoops = leg.both && !out && loopsOfTypes(graph, leg.types);

  for (const slot of frontier) {
    // Nonzero by construction — a slot joins a frontier only on its 0 -> w transition.
    const w = st.ways[slot];

    for (const e of edgesOfTypes(
      cache === undefined ? index.get(idOf[slot]) : cache[slot],
      leg.types,
    )) {
      if (skipLoops && e.fromId === e.toId) {
        continue;
      }

      if (far !== undefined && !matchesLabel(out ? e.to : e.from, far)) {
        continue;
      }

      const farId = out ? e.toId : e.fromId;
      let to = slotOf.get(farId) ?? -1;

      if (to < 0) {
        to = idOf.length;
        slotOf.set(farId, to);
        idOf.push(farId);
        cache?.push(cached?.get(farId));

        if (to >= st.cap) {
          st.cap *= 2;

          const grownWays = new Float64Array(st.cap);
          const grownNext = new Float64Array(st.cap);

          grownWays.set(st.ways);
          grownNext.set(st.next);
          st.ways = grownWays;
          st.next = grownNext;
        }
      }

      if (st.next[to] === 0) {
        // The gate is applied on the 0 -> w TRANSITION, so the vertex is resolved only here and
        // an ungated pass never pays item 194's ~190ns endpoint lookup. A vertex that fails is
        // simply never pushed, and because `next[to]` stays 0 it is re-tested if another edge
        // reaches it — which is the behaviour, not an oversight. See below.
        // `out`, NOT `leg.out` (item 1097). This one line was left on `leg.out` when the
        // label check and `farId` above moved to the per-pass `out`, so a `both` leg's IN
        // pass applied the gate to `e.to` — the vertex it came FROM — and admitted positions
        // it should have rejected. Four tests caught it as an OVERCOUNT (20 against 11, 17
        // against 8), and only the ones carrying an inline GATE: a label on the same position
        // is checked above and was already correct, so the label cases passed and read as
        // proof the leg was right.
        if (
          leg.gate !== undefined &&
          !inlineHolds(leg.gate, out ? e.to : e.from, binding, params, graph)
        ) {
          continue;
        }

        nextFrontier.push(to);
      }

      st.next[to] += w;
    }
  }
};

/**
 * THE SAME FORWARD PASS, with each slot's FAR SLOTS remembered the first time they are resolved.
 *
 * Item 1105 ablated `sweepOneDirection`'s per-edge body and found the `slotOf.get(farId)` string
 * lookup is **24% of the row** (`count 4-hop`, 570.6 ms against 432.0 with the lookup removed —
 * ~46 ns an edge, where item 1104's micro-probe had predicted ~28 and so UNDERSTATED it). There is
 * no dense vertex ordinal to replace it with: `Graph` is string-id-keyed by design (item 1104).
 *
 * But a sweep makes ONE PASS PER LEG over the same adjacency, so when every pass would resolve the
 * same edges to the same slots, the second and later passes need not resolve them again. A 4-hop
 * chain runs three passes (the last position is a weighted DEGREE sum, not a pass), so two of the
 * three are answered from the remembered list.
 *
 * THE CONDITIONS, each load-bearing and each checked in {@link sweepChain}:
 *
 *   * `uniform` — one index for the whole chain, so a slot's adjacency is the same every pass.
 *     This is the condition the per-slot `cache` already needed (item 300).
 *   * the same edge TYPES on every leg — `edgesOfTypes` applies each leg's own types, so legs
 *     that differ would walk different edge subsets out of one slot.
 *   * NO far label and NO gate on any leg — those decide which far slots are ADMITTED, and the
 *     remembered list holds slots rather than vertices. Re-testing a label would mean resolving
 *     `idOf[to]` back to a vertex, which costs more than the lookup it saves.
 *
 * A SEPARATE FUNCTION rather than a branch in the shared body, which is items 159, 1033 and
 * 1091's rule: the last of those measured **1.54x on a control the change cannot reach** for
 * folding a per-pass choice into a per-edge body. The branch here is per SLOT (one per ~degree
 * edges), not per edge.
 *
 * Byte-identity: the count is a sum of exact-integer way counts, so the order the frontier is
 * built in cannot change it, and duplicates are kept in the remembered list exactly as parallel
 * edges produce them.
 */
const sweepSlotCached = (st: SweepState, leg: Leg, slotNbrs: (Int32Array | undefined)[]): void => {
  const { cache, cached, idOf, slotOf, frontier, nextFrontier } = st;
  const { out } = leg;
  // Reused across slots, so the walk allocates one `Int32Array` per slot and nothing else.
  const scratch: number[] = [];

  for (const slot of frontier) {
    // Nonzero by construction — a slot joins a frontier only on its 0 -> w transition.
    const w = st.ways[slot];
    const known = slotNbrs[slot];

    if (known !== undefined) {
      for (const to of known) {
        if (st.next[to] === 0) {
          nextFrontier.push(to);
        }

        st.next[to] += w;
      }

      continue;
    }

    scratch.length = 0;

    for (const e of edgesOfTypes(cache === undefined ? undefined : cache[slot], leg.types)) {
      const farId = out ? e.toId : e.fromId;
      let to = slotOf.get(farId) ?? -1;

      if (to < 0) {
        to = idOf.length;
        slotOf.set(farId, to);
        idOf.push(farId);
        cache?.push(cached?.get(farId));

        if (to >= st.cap) {
          st.cap *= 2;

          const grownWays = new Float64Array(st.cap);
          const grownNext = new Float64Array(st.cap);

          grownWays.set(st.ways);
          grownNext.set(st.next);
          st.ways = grownWays;
          st.next = grownNext;
        }
      }

      scratch.push(to);

      if (st.next[to] === 0) {
        nextFrontier.push(to);
      }

      st.next[to] += w;
    }

    slotNbrs[slot] = Int32Array.from(scratch);
  }
};

/** Do two legs accept the same edge types? `undefined` is "any type" and matches only itself. */
const sameLegTypes = (a: string[] | undefined, b: string[] | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && a.every((t, i) => t === b[i]);

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
  // An UNDIRECTED leg has no single index, so the per-slot adjacency cache below cannot apply
  // (item 1097). It is worth 1.73x on a uniform DIRECTED chain and nothing is lost here: the
  // shapes this disables it for were declining entirely a moment ago.
  const uniform = legs.every((l) => !l.both && l.out === legs[0].out);
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
  // REMEMBER each slot's far slots when every pass would resolve the same ones (item 1106).
  //
  // `passes > 2` IS MEASURED, not a guess. The first pass PAYS for the memo — a scratch push per
  // edge and an `Int32Array.from` per slot — and only later passes are refunded. With exactly two
  // passes one building pass is refunded by one consuming pass and the trade is a small LOSS:
  // `count 3-hop + start filter` (3 legs, 2 passes) read 162.0 ms against 165.7 over three
  // alternated rounds, consistently the wrong way. At three passes two are refunded and
  // `count 4-hop` goes 550.5 -> 297.5, **1.85x**.
  const slotNbrs: (Int32Array | undefined)[] | undefined =
    uniform &&
    passes > 2 &&
    legs.every(
      (l) =>
        sameLegTypes(l.types, legs[0].types) &&
        l.gate === undefined &&
        effectiveLabel(graph, l.label) === undefined,
    )
      ? []
      : undefined;

  for (let i = 0; i < passes; i++) {
    const leg = legs[i];
    const far = effectiveLabel(graph, leg.label);
    const nextFrontier: number[] = [];
    // A SECOND array rather than updating in place: a slot can be both read and written in one
    // pass, through a self-loop or any cycle shorter than the chain.
    const next = new Float64Array(cap);
    // The mutable slot state, handed to each direction pass. `ways`, `next` and `cap` are
    // REASSIGNED when the arrays grow, so they live here and are read back after the passes.
    const st = {
      graph,
      params,
      binding,
      slotOf,
      idOf,
      cache,
      cached,
      ways,
      next,
      cap,
      frontier,
      nextFrontier,
    };

    // REJECTED, with its numbers, so it is not re-attempted: an INDEXED loop here instead of
    // `for...of` looked worth ~5% (715.5 against 752.7ms at five hops, three alternated rounds,
    // ranges disjoint) and did NOT reproduce — putting the indexed spelling back read 760.1, no
    // better than the `for...of` it was supposed to beat. The third round had moved every row on
    // that side (255 -> 290, 961 -> 1197), which is the tell. DISJOINT RANGES OVER THREE ROUNDS
    // ARE NOT PROOF WHEN THE WHOLE SIDE MOVES; the control has to hold still too, and here it did
    // on the first reading and not on the second.
    // ONE CALL PER DIRECTION the leg traverses: one for `out`/`in`, two for `both` (item 1097).
    // Per LEG, so the per-edge body inside is the same work it was — item 159's rule, and item
    // 1091's 1.54x is what a direction choice inside a hop body costs a control it cannot reach.
    if (slotNbrs === undefined) {
      for (const out of legDirections(leg)) {
        sweepOneDirection(st, leg, far, out);
      }
    } else {
      sweepSlotCached(st, leg, slotNbrs);
    }

    // Nothing reaches this position, so nothing reaches any later one either.
    if (nextFrontier.length === 0) {
      return 0;
    }

    // Read back from `st`, because a pass that grew the arrays replaced them there.
    ({ next: ways, cap } = st);
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
  // THE LAST POSITION IS A DEGREE, AND AN UNDIRECTED LAST LEG IS AN UNDIRECTED DEGREE (item 1097).
  // This read `side(…, last.out, …)` and the per-leg direction loop above does not reach here —
  // the last position is answered by a weighted sum of degrees rather than by a pass. So an
  // undirected chain counted ONE direction at its final hop and answered EXACTLY HALF: two
  // existing tests from item 484 caught it at 8 against 16 and 0 against 1, which is what a test
  // asserting the answer buys over one asserting the route.
  const lastLoops = last.both && loopsOfTypes(graph, last.types);

  for (const slot of frontier) {
    count +=
      ways[slot] *
      (last.both
        ? undirectedSide(graph, idOf[slot], last.types, lastFar, lastLoops)
        : side(graph, idOf[slot], last.out, last.types, lastFar));
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
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
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

  // DISTINCT and an ORDER BY on the OUTPUT COLUMN are identities on one row, which is the
  // argument `detectCountShortcut` makes for SKIP/LIMIT and items 544 and 545 extended to the
  // other rungs. Refusing them here cost, at 200,000 vertices and one case per process
  // (item 546):
  //
  //   FOR x IN [1, 2, 3] RETURN count(*)            0.00 ms   DISTINCT  98.72
  //   FOR t IN n.tags    RETURN count(*)            3.08                73.61   24x
  //   OPTIONAL MATCH …   RETURN count(*)           29.77               397.91   13x
  //
  // A sort key that is NOT that column is refused, because any other expression could FAULT
  // while being evaluated for the sort and a rung that skipped the sort would skip the fault.
  const sortsOnColumn = (proj.orderBy ?? []).every(
    (sort) => sort.expr.kind === 'var' && sort.expr.name === column,
  );

  return sortsOnColumn ? column : null;
};

/**
 * The per-ANCHOR gate for a lone-node `MATCH`, composing all three spellings of one filter, or
 * `null` to decline. `undefined` means there is no filter at all.
 *
 * Extracted at item 560 because item 559 needed it twice within two ticks, and a second copy of
 * this composition is exactly the duplicate that has fooled a bulk edit ten times in this session.
 * The three spellings are the start node's INLINE property map, its inline `WHERE`, and the
 * clause `WHERE` — one filter written three ways, and a rung that admits only one of them is the
 * equivalent-spelling bug this engine exists to avoid. Composed with `reduceRight` so they are
 * evaluated in WRITTEN order, inline before clause, which is what lets an inline filter that
 * matches nothing short-circuit a faulting clause `WHERE` (both engines do).
 *
 * `inlineOf` returns `null` for an inline form that cannot be gated per anchor — a property value
 * reading a variable, or an inline `WHERE` with no node variable — and that refusal is passed
 * straight through.
 */
const anchorFilterGate = (
  start: NodePattern,
  where: Expr | undefined,
  anchorVar: string,
): InlineGate | undefined | null => {
  const preds: InlinePred[] = [];
  const inlineAnchor = inlineOf(start);

  if (inlineAnchor === null) {
    return null;
  }

  if (inlineAnchor !== undefined) {
    preds.push(inlineAnchor);
  }

  if (where !== undefined) {
    // Reading any name BUT the anchor would make this a correlated filter rather than a
    // per-anchor one, and a lone-node MATCH has nothing else bound to correlate with. (Both
    // engines reject an UNBOUND name before this runs, so the check is for a name bound by an
    // earlier clause.)
    for (const nameRead of freePredicateVars(where)) {
      if (nameRead !== anchorVar) {
        return null;
      }
    }

    preds.push(predFor(compilePredicate(undefined, where, anchorVar), anchorVar, true));
  }

  return preds.reduceRight<InlineGate | undefined>(
    (rest, ip) => (vertex, binding, params, graph) =>
      inlineHolds(ip, vertex, binding, params, graph) &&
      (rest === undefined || rest(vertex, binding, params, graph)),
    undefined,
  );
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

  if (anchor.segments.length !== 0 || anchor.pathVar !== undefined || v === undefined) {
    return null;
  }

  // A FILTERED anchor (item 559). The rung's arithmetic is Σ max(1, degree) over the anchors, so a
  // filter changes WHICH anchors are summed and nothing else — `sideOfVertex` below is untouched.
  // Refusing one cost 191.69 ms against the unfiltered 8.12 at 200,000 vertices, and the INLINE
  // property spelling 391.04, which `plainNode` was refusing on top. All three spellings go
  // through `anchorFilterGate`; `plainNode` is deliberately NOT asked of the anchor any more,
  // since it refuses exactly the inline forms this rung now takes.
  const anchorGate = anchorFilterGate(anchor.start, m.where, v);

  if (anchorGate === null) {
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
  const one = (graph: Graph, params: Params): Row => {
    const vertices: Iterable<Vertex> =
      name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []);
    // ONE binding map for the whole scan, rewritten per anchor — the general path's cost is a
    // fresh `Map` per row, which is what this rung exists to avoid.
    const binding = new Map<string, unknown>();
    let total = 0;

    for (const vertex of vertices) {
      if (anchorGate !== undefined && !anchorGate(vertex, binding, params, graph)) {
        continue;
      }

      // The FLOOR is the whole difference from the plain hop count: an anchor with no
      // matching neighbour still contributes its one null-filled row.
      const d = sideOfVertex(vertex, out, types, far);

      total += d === 0 ? 1 : d;
    }

    return { [column]: total };
  };

  if (proj.skip === undefined && proj.limit === undefined) {
    return (graph, params) => [one(graph, params)];
  }

  return (graph, params) =>
    pageOneRow(() => one(graph, params), graph, params, proj.skip, proj.limit);
};

/**
 * `MATCH … FOR x IN [a, b, c] RETURN count(*)` — the row multiplier as ARITHMETIC.
 *
 * A `FOR` over a CONSTANT list multiplies every incoming row by the list's length, so the count
 * is the count of the `MATCH` times that length. The general path builds all of them:
 * `MATCH (n:Person) FOR x IN [1, 2, 3] RETURN count(*)` materialized 600,000 rows to count them
 * at **175.1 ms** against the native engine's 3.4 (audit item 515).
 *
 * The base count is the EXISTING shortcut, asked of the clause list with the `FOR` removed —
 * so every shape `detectCountShortcut` already answers (a bare node, a hop, a product, a
 * degree chain) is multiplied, and nothing about counting is re-derived here. The whole rung is
 * "ask the ladder, then multiply".
 *
 * Constant means a LITERAL list whose elements are literals. A per-row list (`FOR t IN n.tags`,
 * 191.1 ms against native's 15.8) needs Σ length over the rows, which is a different walk and
 * is left to the general path; a `$param` list is constant per run but not per compile, and
 * reaching it needs the list evaluated once per execution rather than once per compile.
 */
/**
 * `MATCH (n:L) FOR t IN n.<key> RETURN count(*)` — a PER-ROW list, counted as Σ its lengths.
 *
 * Item 515 took the constant list (one multiplication). A list read from the row needs the
 * anchors walked, but not a row per element: 191.1 ms at 200,000 vertices with three tags each
 * against the native engine's 15.8, because the general path materialized 600,000 rows to count
 * them (audit item 518).
 *
 * ISO's unwind semantics are the whole arithmetic, and each case is a different number:
 *
 *   - a LIST contributes its length (an empty list contributes 0 — the anchor's row disappears);
 *   - NULL or a missing property contributes 0;
 *   - any other scalar contributes 1, because a non-list unwinds as a one-element list.
 *
 * The anchor must be a lone node whose variable the property reads, with no inline properties or
 * `WHERE` — the same admission as item 510's optional count, and for the same reason: its bucket
 * is what this walks.
 */
const perRowForCount = (
  clauses: readonly Clause[],
  list: Extract<Expr, { kind: 'prop' }>,
  ret: Extract<Clause, { kind: 'return' }>,
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 3) {
    return null;
  }

  const [m] = clauses;

  if (m.kind !== 'match' || m.optional || m.patterns.length !== 1) {
    return null;
  }

  const [pattern] = m.patterns;
  const { start } = pattern;

  if (
    pattern.segments.length !== 0 ||
    pattern.pathVar !== undefined ||
    // The property must read the ANCHOR. Its mutant survives and is equivalent by
    // construction: with ONE lone-node `MATCH` clause the anchor's variable is the only name in
    // scope, so a property on anything else is an unbound reference the compiler rejects before
    // this runs — and a pattern WITH segments (where a second name exists) is refused one line
    // above.
    start.variable !== list.variable
  ) {
    return null;
  }

  // A FILTERED anchor, by item 559's argument on its sibling rung: Σ over the anchors of the
  // list's length is unchanged by WHICH anchors are summed, so a per-anchor gate is all a filter
  // needs. Refusing one cost, at 200,000 vertices with three tags each:
  //
  //   MATCH (n:Person) FOR t IN n.tags RETURN count(*)             3.70 ms
  //   ...WHERE n.age > 60                                         52.75      14.3x
  //   MATCH (n:Person {tag: 'x'}) ...                            125.56      33.9x
  //   MATCH (n:Person WHERE n.age > 60) ...                        52.93      14.3x
  //
  // All three spellings together, for item 559's reason: admitting only the clause form would be
  // the equivalent-spelling bug, and the inline property map was the worst of the three there too.
  const anchorGate = anchorFilterGate(start, m.where, list.variable);

  if (anchorGate === null) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const column = countStarColumn(ret.projection);

  if (column === null) {
    return null;
  }

  const proj = ret.projection;
  const name = label?.name;
  const { key } = list;
  const one = (graph: Graph, params: Params): Row => {
    const vertices: Iterable<Vertex> =
      name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []);
    // ONE binding map for the whole scan, rewritten per anchor — the general path's cost is a
    // fresh `Map` per row, which is what this rung exists to avoid.
    const binding = new Map<string, unknown>();
    let total = 0;

    for (const vertex of vertices) {
      if (anchorGate !== undefined && !anchorGate(vertex, binding, params, graph)) {
        continue;
      }

      const value = vertex.properties[key];

      if (value === null || value === undefined) {
        continue;
      }

      total += Array.isArray(value) ? value.length : 1;
    }

    return { [column]: total };
  };

  if (proj.skip === undefined && proj.limit === undefined) {
    return (graph, params) => [one(graph, params)];
  }

  return (graph, params) =>
    pageOneRow(() => one(graph, params), graph, params, proj.skip, proj.limit);
};

/**
 * `MATCH (n[:L]) FOR t IN <list> RETURN <items>` — the `FOR` PROJECTION off the label bucket.
 *
 * Items 515 and 518 gave the `count(*)` form the arithmetic. The projection has to emit the rows,
 * so there is no arithmetic to replace the walk with — the cost is the walk itself, and the
 * general path pays three allocations an ELEMENT for it: `runFor` copies the whole binding into a
 * `new Map` per element, `elems.map` materializes an array of those per input row, and
 * `mapToRow` walks the surviving map again at the end.
 *
 * Measured at 200,000 vertices with three list elements each (item 528):
 *
 * ```text
 *   MATCH (n:Person) FOR t IN n.tags RETURN t AS t      ts 92.7 ms   native 50.8
 *   MATCH (n:Person) FOR x IN [1, 2, 3] RETURN x AS x   ts 97.4      native 40.1
 *   MATCH (n:Person) RETURN n.age AS k   (no FOR)       ts  9.5      native 11.0
 * ```
 *
 * The third row is the diagnosis: without a `FOR` the TS engine is FASTER than native, so the
 * 2.0-2.4x is not a projection gap — it is the per-element binding machinery, which the plain
 * projection's own rung never touches. 162 ns a row against 48.
 *
 * ONE scratch binding is reused across every element of every anchor, because nothing retains it:
 * `projectRow` reads it and returns a fresh `Row`. The same trick as item 524's landing gate, and
 * for the same reason it is sound there — the only consumer finishes with the binding before the
 * next element overwrites it.
 *
 * The admission:
 *
 *   - exactly `MATCH` / `FOR` / `RETURN`, with a lone plain anchor node (no inline properties, no
 *     clause or inline `WHERE`), since its bucket is what this walks;
 *   - a plain row projection — no `*`, DISTINCT, grouping, ORDER BY or paging, and not
 *     aggregating (items 515 and 518 own the aggregate form);
 *   - the list is either a ROW-INVARIANT expression (`freePredicateVars` empty — evaluated ONCE
 *     and shared, the same invariance check `unwind_rows` makes in the engine, item 519) or a
 *     PROPERTY of the anchor, read straight off the vertex;
 *   - every item's free names are the anchor, the `FOR` variable, or the ordinality variable.
 *     Anything else is not in scope here anyway, but checking is what makes the scratch binding
 *     complete rather than nearly complete.
 *
 * ISO's unwind rule is the same as the counting rungs': a LIST contributes one row per element,
 * an empty list contributes none (the anchor's row disappears), NULL or a missing key contributes
 * none, and any other scalar contributes ONE row — a non-list unwinds as a one-element list.
 */
/**
 * How a `FOR` projection item's cell is produced when the walk already holds the value (item 838):
 * the current list ELEMENT, the ANCHOR vertex, or a property read off that vertex. `undefined`
 * means "not a direct shape", and the item's compiled closure runs as before.
 */
type ForDirect = { kind: 'elem' } | { kind: 'anchor' } | { kind: 'prop'; key: string } | undefined;

/** The two parameterless variants, allocated once rather than per plan. */
const ELEM: ForDirect = { kind: 'elem' };
const ANCHOR: ForDirect = { kind: 'anchor' };

export const detectForProjection = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 3) {
    return null;
  }

  const [m, loop, ret] = clauses;
  const [, cloop, cret] = compiled;

  if (m.kind !== 'match' || loop.kind !== 'for' || ret.kind !== 'return') {
    return null;
  }

  if (cloop?.kind !== 'for' || cret?.kind !== 'return' || cret.projection.aggregating) {
    return null;
  }

  if (!plainRowProjection(ret.projection) || m.optional || m.where !== undefined) {
    return null;
  }

  if (m.patterns.length !== 1) {
    return null;
  }

  const [pattern] = m.patterns;
  const { start } = pattern;
  const anchor = start.variable;

  if (
    pattern.segments.length !== 0 ||
    pattern.pathVar !== undefined ||
    anchor === undefined ||
    !plainNode(start) ||
    (start.properties !== undefined && start.properties.length > 0)
  ) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const names = new Set<string>([anchor, loop.alias]);

  if (loop.ordinality !== undefined) {
    names.add(loop.ordinality.var);
  }

  for (const item of ret.projection.items) {
    for (const free of freePredicateVars(item.expr)) {
      if (!names.has(free)) {
        return null;
      }
    }
  }

  // The LIST, in the two forms worth intercepting: row-invariant (one evaluation, shared) or a
  // property of the anchor (read off the vertex, no expression evaluation at all).
  const invariant = freePredicateVars(loop.list).size === 0;
  const key = loop.list.kind === 'prop' && loop.list.variable === anchor ? loop.list.key : null;

  if (!invariant && key === null) {
    return null;
  }

  const name = label?.name;
  const { alias, ordinality } = loop;
  const { projection } = cret;
  const listFn = cloop.list;

  // ITEM 838: the direct read, item 835's lever where the loop holds BOTH variables.
  //
  // Item 832 scoped 835 to a single-variable projection because "a multi-variable projection has
  // no single element to read from". That is true of a HOP, where one end is reached per edge, and
  // false here: this walk holds the anchor vertex and the current list element at once, so every
  // name the admission above permits is already in hand. `compileExpr`'s `var` arm is
  // `(env) => env.binding.get(name)` and its `prop` arm is
  // `(env) => propOf(env.binding.get(variable), key)`, so for these three shapes the closure
  // writes a value into a `Map`, builds an `env` and reads the same value straight back out.
  // Byte-identical by construction: the same value, and `propOf` is the same function on the same
  // vertex.
  //
  // `star` keeps the old path — it projects the BINDING rather than items, so there is nothing to
  // read directly. (`plainRowProjection` already refuses it; this is belt and braces, because the
  // cost of being wrong here is a wrong answer rather than a slow one.)
  const directs: readonly ForDirect[] =
    projection.star || ret.projection.items.length !== projection.items.length
      ? projection.items.map(() => undefined)
      : ret.projection.items.map((it): ForDirect => {
          const e = it.expr;

          if (e.kind === 'prop') {
            return e.variable === anchor ? { kind: 'prop', key: e.key } : undefined;
          }

          if (e.kind !== 'var') {
            return undefined;
          }

          if (e.name === alias) {
            return ELEM;
          }

          return e.name === anchor ? ANCHOR : undefined;
        });

  return (graph, params) =>
    forProjectionRows(graph, params, {
      anchor,
      name,
      alias,
      ordinality,
      projection,
      listFn,
      invariant,
      key,
      cols: projection.items.map((it) => it.name),
      fns: projection.items.map((it) => it.fn),
      directs,
    });
};

/**
 * The per-ROW half of `detectForProjection`, at module scope rather than inside the returned
 * closure: a walk written inline in a closure gives UNRELATED queries a new slow mode (item 268,
 * 4x), and this is a walk over every vertex of a label.
 */
const forProjectionRows = (
  graph: Graph,
  params: Params,
  plan: {
    anchor: string;
    name: string | undefined;
    alias: string;
    ordinality: { kind: 'ordinality' | 'offset'; var: string } | undefined;
    projection: CProjection;
    listFn: CompiledExpr;
    invariant: boolean;
    key: string | null;
    cols: readonly string[];
    fns: readonly CompiledExpr[];
    directs: readonly ForDirect[];
  },
): Row[] => {
  const { anchor, name, alias, ordinality, projection, listFn, invariant, key } = plan;
  const { cols, fns, directs } = plan;
  const width = cols.length;
  // Item 838. `anyDirect` keeps the untouched shapes on EXACTLY the old path, `projectRow` and
  // all, so a projection this lever cannot serve cannot be slowed by it either.
  const anyDirect = directs.some((d) => d !== undefined);
  const allDirect = width > 0 && directs.every((d) => d !== undefined);
  const vertices: Iterable<Vertex> =
    name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []);
  const binding = new Map<string, unknown>();
  const out: Row[] = [];
  // A ROW-INVARIANT list is evaluated ONCE, which is the whole point of the check: the engine's
  // `unwind_rows` does the same, and item 519 is the record of what happens when a fast path
  // mirrors an operator's element rule without its invariance rule.
  const shared = invariant ? listFn({ binding, params, graph }) : undefined;

  for (const vertex of vertices) {
    // When every item is direct the binding is never read, so writing it is dead work — item
    // 803's rule, and the same deletion item 835 made at the node-scan site.
    if (!allDirect) {
      binding.set(anchor, vertex);
    }

    const value = key === null ? shared : vertex.properties[key];

    if (value === null || value === undefined) {
      continue;
    }

    const elems: readonly unknown[] = Array.isArray(value) ? value : [value];

    for (let i = 0; i < elems.length; i++) {
      if (!allDirect) {
        binding.set(alias, elems[i]);

        if (ordinality !== undefined) {
          binding.set(ordinality.var, ordinality.kind === 'ordinality' ? i + 1 : i);
        }
      }

      if (!anyDirect) {
        out.push(projectRow(projection, binding, params, graph));
        continue;
      }

      const row: Row = {};

      for (let c = 0; c < width; c++) {
        const d = directs[c];

        if (d === undefined) {
          row[cols[c]] = fns[c]({ binding, params, graph });
        } else if (d.kind === 'elem') {
          row[cols[c]] = elems[i];
        } else if (d.kind === 'anchor') {
          row[cols[c]] = vertex;
        } else {
          row[cols[c]] = propOf(vertex, d.key);
        }
      }

      out.push(row);
    }
  }

  return out;
};

export const detectForCount = (
  clauses: readonly Clause[],
  compiled: readonly CClause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length < 3) {
    return null;
  }

  const ret = clauses[clauses.length - 1];
  const loop = clauses[clauses.length - 2];

  if (ret.kind !== 'return' || loop.kind !== 'for') {
    return null;
  }

  if (loop.list.kind === 'prop') {
    return perRowForCount(clauses, loop.list, ret);
  }

  if (loop.list.kind !== 'list') {
    return null;
  }

  // Only a literal list is constant at compile time. One non-literal element and the length is
  // still known — but an element that FAULTS must fault, and the general path is where that
  // happens, so the whole list has to be inert.
  if (loop.list.items.some((e) => e.kind !== 'lit')) {
    return null;
  }

  const column = countStarColumn(ret.projection);

  if (column === null) {
    return null;
  }

  // The base count, asked of the ladder with the `FOR` taken out. `compiled` is sliced the same
  // way so the two lists stay aligned — `detectCountShortcut` reads the compiled start node for
  // its index seeds.
  const base = detectCountShortcut(
    [...clauses.slice(0, -2), ret],
    [...compiled.slice(0, -2), compiled[compiled.length - 1]],
  );

  if (base === null) {
    return null;
  }

  const times = loop.list.items.length;

  return (graph, params) =>
    base(graph, params).map((row) => ({ ...row, [column]: Number(row[column]) * times }));
};

/**
 * `MATCH (a:A)-[:T]->{m,n}(b:B) RETURN count(*)` — answer it with {@link varLengthDegreeCount}.
 *
 * NARROW, and every condition earns its place:
 *
 * - **OUT only, `1 <= max <= 2`, WALK or TRAIL.** The arithmetic is the native engine's and
 *   carries its limits: an unbounded or deeper quantifier has no two-term closed form here, and
 *   SIMPLE / ACYCLIC forbid the node-repeating paths the degree product counts.
 * - **No `unit`.** The parenthesized GROUP spelling reaches this through item 569's
 *   `dropUnreadGroupBinds`, which turns a group whose bindings nothing reads into exactly this
 *   abbreviated form — so one implementation serves both spellings and they cannot diverge in
 *   cost. A group that still carries bindings keeps the walk, because a per-rep LIST is the
 *   answer rather than a filter. In the AST that is `hopFrom`; `unit` is the COMPILED shape.
 * - **No per-hop rel predicate** (`plainRel` minus its quantifier test) and **no clause WHERE**.
 *   A per-rep predicate folds into the native twin as a traversal mask (item 572); this is the
 *   TS side's first step and does not attempt it.
 * - **Endpoint LABEL is admitted**, as the `passes` test. A vacuous label is detected and
 *   `passesIsVacuous` keeps the degree a sum of set SIZES — item 566's note that a label which
 *   excludes nothing must not be allowed to turn a degree product into a per-edge scan.
 */
/**
 * The PATTERN half of {@link detectVarLengthCount}'s shape test — a lone bounded OUT var-length
 * hop between two bare nodes.
 *
 * Its own function because the detector sits on the complexity gate: inline, the chain read 38
 * against a maximum of 35. `tallyGroupShapes` and `genQuantifiedGroup` were split for the same
 * reason, and the gate has been right each time.
 *
 * `selector` DEFAULTS to the string 'walk' (all walks) rather than to undefined, so the guard is
 * `!== 'walk'`. Written as `!== undefined` it declines EVERY query — which is how this started,
 * and the measurement showed no change at all until it was found.
 *
 * The ENDPOINT node is no longer required to be plain (item 583): its constraint is carried as an
 * `InlinePred` and applied per reached endpoint. The detector decides whether it can be carried.
 */
const degreeCountShape = (pattern: PathPattern): boolean => {
  if (
    pattern.pathVar !== undefined ||
    pattern.segments.length !== 1 ||
    (pattern.selector !== undefined && pattern.selector !== 'walk') ||
    !plainNode(pattern.start) ||
    (pattern.mode !== undefined && pattern.mode !== 'trail' && pattern.mode !== 'walk')
  ) {
    return false;
  }

  const [seg] = pattern.segments;
  // The ENDPOINT `node` is deliberately NOT read here (item 583) — its constraint is carried, not
  // refused, and `detectVarLengthCount` decides whether it can be.
  const { rel } = seg;

  return !(
    seg.hopFrom !== undefined ||
    seg.nested !== undefined ||
    rel.quantifier === undefined ||
    (rel.direction !== 'out' && rel.direction !== 'in') ||
    (rel.properties?.length ?? 0) > 0 ||
    rel.where !== undefined ||
    rel.variable !== undefined
  );
};

/**
 * Whether a depth-4 TRAIL may take the closed form (item 692) — true for every other shape.
 *
 * Depth 4 is admitted only with NO endpoint constraint of any kind. Its terms were derived and
 * validated for a TRIVIAL endpoint mask (items 687-689) and nothing checks them against a filtered
 * one, so a carried predicate or label falls back to enumeration.
 *
 * The test has to be STATIC. `passesIsVacuous` is the flag that actually matters, but it is a
 * QUERY-TIME value — it calls `vacuousLabel(graph, …)` — and `walkLevelCount` returns a number with
 * no way to decline once chosen. So this refuses on the SYNTAX, which is stricter than necessary: a
 * label every node happens to carry would be vacuous at runtime and is refused here anyway.
 */
const depth4Admissible = (
  max: number,
  mode: string | undefined,
  endPred: unknown,
  endLabel: unknown,
): boolean => max !== 4 || mode === 'walk' || (endPred === undefined && endLabel === undefined);

/**
 * Whether the MIRROR spelling (`<-[:T]-{n,m}`) may take this route (item 744).
 *
 * `true` for every forward query. For a backward one it needs the LEVEL RECURRENCE, which is the
 * only route taught about direction: it builds a CSR from the named adjacency and hands `{off,
 * nbr}` on, so the trail correction inherits the direction. `takesTheLevelRecurrence` is
 * `max >= 2`, so a shallower or UNBOUNDED mirror would fall to the `max <= 2` arithmetic, whose
 * `degreeOf` reads the out-adjacency directly and would answer the FORWARD count for a backward
 * query.
 *
 * Its own function rather than three clauses inline, because `detectVarLengthCount` sits ON the
 * complexity gate — inline it read 36 against a maximum of 35, which is the same reason this file
 * already factors out `depth4Admissible`.
 *
 * 🛑 BOTH CLAUSES ARE REDUNDANT TODAY, which is why a mutant replacing this whole body with `true`
 * SURVIVES (item 744 recorded that survivor as unexplained; item 745 explains it):
 *
 *   - `max === 1` cannot reach here. `dropVacuousQuantifier` removes a `{1,1}` quantifier outright
 *     (`vacuousQuantifier`: `min === 1 && max === 1` plus a plain rel), so `degreeCountShape` then
 *     sees `rel.quantifier === undefined` and refuses the segment before this is consulted.
 *   - `max === null` is refused nine lines below, for BOTH directions, by the depth bound
 *     `max === null || max < 1 || (max > 4 && mode !== 'walk')`.
 *
 * It stays for the reason this file keeps `!spec.isTrail`: the hazard is real and the guard is
 * against a RELAXATION of either condition above. Below `max >= 2`, `varLengthDegreeCount` falls to
 * arithmetic whose `edgesOf` reads `v.adjFrom` directly, and it cannot decline once chosen — it
 * returns a number. So the only place to refuse is here, upstream, and item 692 is the record of
 * exactly this guard-against-a-future-relaxation being needed when the future arrived.
 */
const mirrorAdmissible = (inward: boolean, max: number | null): boolean =>
  !inward || (max !== null && max >= 2);

export const detectVarLengthCount = (
  clauses: readonly Clause[],
): ((graph: Graph, params: Params) => Row[]) | null => {
  if (clauses.length !== 2) {
    return null;
  }

  const [m, ret] = clauses;

  if (m?.kind !== 'match' || m.optional || m.patterns.length !== 1 || ret?.kind !== 'return') {
    return null;
  }

  const column = countStarColumn(ret.projection);

  if (column === null || (ret.projection.orderBy ?? []).length > 0) {
    return null;
  }

  const [pattern] = m.patterns;

  if (!degreeCountShape(pattern)) {
    return null;
  }

  const [seg] = pattern.segments;
  const { rel, node } = seg;
  const { min, max } = rel.quantifier!;
  const inward = rel.direction === 'in';

  // Refusing here keeps a shallow or unbounded mirror on the route it has always taken, rather
  // than letting a relaxed bound meet arithmetic that was not relaxed with it — the mistake items
  // 692 and 699 both made one depth down.
  if (!mirrorAdmissible(inward, max)) {
    return null;
  }

  // DEPTH (item 588). `max > 2` was refused outright; a WALK now takes the level recurrence, so
  // only a TRAIL is still bounded at two. The bound is the trail CORRECTION: at two hops there is
  // exactly one way to reuse an edge and the closed form subtracts it, while at three there are
  // several interacting ways and no single term. Native drew the line in the same place at item
  // 587, which is what keeps the two engines on one answer.
  if (max === null || max < 1 || (max > 4 && pattern.mode !== 'walk')) {
    return null;
  }

  const types = relTypeNames(rel.label);

  if (types === null) {
    return null;
  }

  const endLabel = node.label;

  if (endLabel !== undefined && endLabel.kind !== 'label') {
    return null;
  }

  // THE ENDPOINT PREDICATE, from EITHER spelling, and the two must be one route (item 583).
  //
  // `(y WHERE y.age > 50)` and `(y) WHERE y.age > 50` are the same question. Carrying only the
  // inline one would have CREATED a cliff — 270.82ms against 334.13 before this, and the inline
  // side alone would have gone to ~45. Items 303/304 are the precedent and the warning: an
  // inline `{k: 1}` reached `inlineOf` through the pattern node while the identical clause
  // `WHERE` cost 4708.2ms against 33.9, "139x, item 125's bug class at the far end of the
  // family". `chainGatesOf` + `gateWith` is the composition they built for exactly this, so both
  // spellings reach the same `InlinePred` here.
  //
  // The predicate is applied per REACHED endpoint, not per node in the store — which is why this
  // needs no fault fallback where native's `node_pass_mask` does (items 570, 572). The rung
  // evaluates it on exactly the set the walk would.
  const gates =
    m.where === undefined ? undefined : chainGatesOf(m.where, pattern.start, pattern.segments);

  if (gates === null) {
    return null;
  }

  // A gate on the START is a filter on the SEED, which this rung does not carry — declining
  // keeps both of ITS spellings on the walk together rather than making a new cliff. Its INLINE
  // spelling needs no test here: `degreeCountShape` already requires `plainNode(pattern.start)`,
  // so a start carrying properties or an inline `WHERE` never reaches this function. A duplicate
  // guard here SURVIVED mutation for exactly that reason, which is what dead code looks like.
  if (
    pattern.start.variable !== undefined &&
    (gates?.get(pattern.start.variable)?.length ?? 0) > 0
  ) {
    return null;
  }

  const endPred = gateWith(
    node,
    node.variable === undefined ? undefined : gates?.get(node.variable),
  );

  if (endPred === null) {
    return null;
  }

  if (!depth4Admissible(max, pattern.mode, endPred, node.label)) {
    return null;
  }

  const startLabel = pattern.start.label;

  if (startLabel !== undefined && startLabel.kind !== 'label') {
    return null;
  }

  const isTrail = pattern.mode !== 'walk';

  // TWO closures, not one with a branch inside it. The predicate-free case — which is everything
  // item 573 already carried — keeps the closure it had, capturing exactly what it captured, and
  // the new one is reached only by a query that has a predicate. The reason is prophylactic, and
  // the honest version of the measurement is worth having here because the first reading looked
  // like more than it was. Written as ONE closure, the unfiltered control read 183.87 / 190.39 /
  // 182.44 against 210.01 / 184.26 / 219.62 over three alternated isolated rounds at 200,000
  // vertices: mins 1.01x apart, but the spread went 1.04x to 1.19x, which looked like
  // [[ts-closure-size-is-load-bearing]] — the slow mode this file has measured five times. Split,
  // the same harness read 178.84 / 190.05 / 171.92 against 193.15 / 181.37 / 190.49: mins 1.055x
  // apart with the PRISTINE side now the looser one. The two runs disagree about which side is
  // tighter, both gaps are under the ~10% noise floor, so the first reading was noise and the
  // split did not fix a measured regression. It is kept because an unfiltered query running
  // literally the code it ran before cannot produce an ambiguous reading like that again —
  // which is the cheap half of the lesson.
  if (endPred === undefined) {
    return (graph) => {
      // A VACUOUS endpoint label costs a per-edge test that cannot fail, which is the difference
      // between a degree product and a per-edge scan wearing one (item 566 / `effectiveLabel`).
      const eff =
        endLabel === undefined || vacuousLabel(graph, endLabel) ? undefined : endLabel.name;

      return [
        {
          [column]: varLengthDegreeCount(graph, {
            types,
            min,
            max,
            isTrail,
            inward,
            startName: startLabel?.name,
            passes: eff === undefined ? alwaysTrue : (v: Vertex): boolean => v.labels.has(eff),
            passesIsVacuous: eff === undefined,
          }),
        },
      ];
    };
  }

  return (graph, params) => {
    const eff = endLabel === undefined || vacuousLabel(graph, endLabel) ? undefined : endLabel.name;
    // One binding map reused across endpoints — the idiom `buildNodeCount` already uses, since
    // `inlineHolds` overwrites the node's own variable per element.
    const binding = new Map<string, unknown>();
    const passes =
      eff === undefined
        ? (v: Vertex): boolean => inlineHolds(endPred, v, binding, params, graph)
        : (v: Vertex): boolean =>
            v.labels.has(eff) && inlineHolds(endPred, v, binding, params, graph);

    return [
      {
        [column]: varLengthDegreeCount(graph, {
          types,
          min,
          max,
          isTrail,
          inward,
          startName: startLabel?.name,
          passes,
          // A carried predicate is never vacuous — it is the whole reason this arm exists.
          passesIsVacuous: false,
        }),
      },
    ];
  };
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
    proj.groupBy !== undefined ||
    proj.having !== undefined ||
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

  // DISTINCT and ORDER BY are NOT refused, and the reason is the one this function already gives
  // for SKIP/LIMIT two comments up: an un-grouped `count(*)` with one item is exactly ONE ROW. A
  // row cannot be deduplicated away from itself and cannot be reordered, so both clauses are
  // identities here — and refusing them cost a 0.00 ms answer **29.78 ms** (`RETURN DISTINCT
  // count(*)`) and **34.53** (`ORDER BY c`) at 200,000 vertices, measured one case per process.
  // Neither spelling is contrived: ordering by the count you just asked for, or writing DISTINCT
  // out of habit, is what a reader does (item 544).
  //
  // ORDER BY is admitted only for a sort key that is a plain reference to the OUTPUT column.
  // Any other expression could FAULT while being evaluated for the sort — `ORDER BY 1/0` raises
  // on the general path — and a shortcut that skipped the sort would skip the fault with it. A
  // reference to the column just produced cannot fault beyond producing it.
  //
  // The `kind === 'var'` half is load-bearing and its mutant is caught. The NAME comparison is
  // equivalent by construction and its mutant survives: an aggregating projection's ORDER BY
  // resolves against the OUTPUT columns, and there is exactly one of them here, so any valid
  // `var` key already IS this column. Kept as the local statement of the rule, and recorded
  // rather than left as an unexplained survivor.
  const orderOnOutput = (proj.orderBy ?? []).every(
    (sort) => sort.expr.kind === 'var' && sort.expr.name === column,
  );

  if (!orderOnOutput) {
    return null;
  }

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
 * A `LocalTime`'s whole identity as ONE finite number, or `undefined` when it is not raw-keyable.
 *
 * Item 850 raw-keyed `LocalDate` on `days` and stopped, because the other kinds "have more than
 * one field and no single raw key". That is true of the FIELDS and not of the VALUE: a
 * `LocalTime`'s `secs` is bounded by 86,400 and its `nanos` by 1e9, so `secs * 1e9 + nanos` is at
 * most 8.64e13 — comfortably inside the 2^53 integers a double represents exactly, so the packing
 * is a bijection and two times share a key iff they share both fields.
 *
 * FINITE only, for item 843's reason: `valueKey` renders a non-finite field through a path that
 * collapses `NaN` and `Infinity` together, and that collapse is PINNED. Falling back here keeps
 * it bit-for-bit instead of "improving" it inside a speedup.
 */
const localTimeKey = (v: LocalTime): number | undefined =>
  Number.isFinite(v.secs) && Number.isFinite(v.nanos) ? v.secs * 1e9 + v.nanos : undefined;

/**
 * Whether a `LocalDateTime` is raw-keyable. Unlike `LocalTime` its `secs` is unbounded, so
 * `secs * 1e9 + nanos` leaves the exact-integer range as soon as `secs` exceeds ~9e6 (104 days).
 * It gets a TWO-LEVEL container — `secs` outer, `nanos` inner — which still builds no string.
 */
const dateTimeKeyable = (v: LocalDateTime): boolean =>
  Number.isFinite(v.secs) && Number.isFinite(v.nanos);

/** `a -> b` nested membership. True when the pair is NEW. */
const addNested = (m: Map<number, Set<number>>, a: number, b: number): boolean => {
  const inner = m.get(a);

  if (inner === undefined) {
    m.set(a, new Set([b]));

    return true;
  }

  if (inner.has(b)) {
    return false;
  }

  inner.add(b);

  return true;
};

/**
 * A ZONED value's second-level key — its `(nanos, offset)` pair packed into one number — or
 * `undefined` when it is not raw-keyable (item 1018).
 *
 * `nanos < 1e9` and an `offset` is whole minutes, so `nanos * 2 ** 21 + (offset + 2 ** 20)` is at
 * most ~2.1e15: inside the exactly-representable integers, so the packing is a bijection on the
 * pair and a zoned key nests only TWO levels like `LocalDateTime`'s. The guard rejects an offset
 * outside ±2^20 minutes rather than assuming none exists.
 *
 * **Written out rather than calling `@lenke/core`'s shared `temporalKeyFields`, and that was
 * MEASURED rather than assumed (item 1018).** Routing these two sites through the shared form
 * cost `count(DISTINCT <localtime>)` **2.1 -> 4.8 ms** and `GROUP BY <datetime>` **2.7 -> 5.2**,
 * because it returns an ARRAY — one allocation per row, which is noise against the Gremlin dedup
 * path's 50-77 ms (item 1017) and dominates at 2 ms. A non-allocating `temporalKeyInto` writing
 * into scratch fixed the first and not the second, since the tally also needs a slot per key and
 * that helper returned `{ slot, created }` and took a closure: `GROUP BY` went to 8.0. A third
 * attempt replaced the `instanceof` chain with one dispatch on the `kind` tag and a shared
 * `bumpNested` — which is a CLOSURE PER ROW, and `GROUP BY <datetime>` read 7.1. So the shared
 * abstraction is right where keys are cheap relative to the work and wrong here. Item 1015's "a
 * narrow key beats a general one", for the third and fourth time.
 */
const zonedTailKey = (v: ZonedTime | ZonedDateTime): number | undefined =>
  Number.isFinite(v.secs) &&
  Number.isFinite(v.nanos) &&
  Number.isFinite(v.offset) &&
  Math.abs(v.offset) < 2 ** 20
    ? v.nanos * 2 ** 21 + (v.offset + 2 ** 20)
    : undefined;

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
  let dates: Set<number> | undefined;
  // Item 1014: the kinds item 850's note set aside. One container per KIND, never shared — the
  // tagged `valueKey` strings (`t1`, `t2`, …) keep the kinds apart, so raw keying has to as well,
  // or a `LocalTime` and a `LocalDateTime` with equal fields would collapse into one group.
  let times: Set<number> | undefined;
  let datetimes: Map<number, Set<number>> | undefined;
  // Item 1018: the zoned kinds, a container each for the reason item 1014 gives — the tagged
  // `valueKey` strings keep the kinds apart, so raw keying has to as well.
  let zonedTimes: Map<number, Set<number>> | undefined;
  let zonedDateTimes: Map<number, Set<number>> | undefined;
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

      // A `LocalDate` IS raw-keyable, on its epoch-day count (item 850). The note below says
      // non-primitives are not, because "two equal lists, records, temporals or elements are
      // different objects" — true of every other case and false of this one: a `LocalDate`'s
      // whole identity is `days`, which items 843/847/848 established is in bijection with its
      // rendering, so two dates share a group iff they share the number.
      //
      // WHY IT MATTERS, AND WHY THE KEYING ABLATION COULD NOT SEE IT. `RETURN DISTINCT <date>`
      // over 200,000 rows cost 19.56 ms against a range-matched number column's 4.71 (4.15x).
      // That is not the key's arithmetic: keying a date and keying a number of the same magnitude
      // measured 14.77 against 12.97 ns, 1.14x. It is that the primitive branch above builds NO
      // STRING AT ALL, while an object pays a `valueKey` string per row — so the number path was
      // never doing the work the ablation compared it on.
      //
      // A THIRD container rather than `prim`, for the reason the note gives for a second one: a
      // raw `5` and `LocalDate(5)` would otherwise collide.
      //
      // Only `LocalDate`. The kinds carrying a sub-second or zone part have more than one field
      // and no single raw key, so they keep `valueKey`.
      // FINITE only, and the test that found this is item 843's. `JSON.stringify` renders both
      // `NaN` and `Infinity` as `null`, so `valueKey` puts those two dates in ONE group; raw
      // keying on `days` separates them, because a `Set` uses SameValueZero. Item 843 chose to
      // keep that collapse bit-for-bit rather than "improve" it inside a speedup, and pinned it —
      // so this guard is that decision holding one item later, caught by the assertion rather
      // than by review.
      if (v instanceof LocalDate && Number.isFinite(v.days)) {
        dates ??= new Set();

        if (dates.has(v.days)) {
          return false;
        }

        dates.add(v.days);

        return true;
      }

      // Item 1014. Both arms keep the per-kind decision in a module-scope helper rather than
      // inline here: this closure is on the hot path for every DISTINCT, and the repo records a
      // walk inlined into a returned closure giving UNRELATED queries a new slow mode.
      if (v instanceof LocalTime) {
        const k = localTimeKey(v);

        if (k !== undefined) {
          times ??= new Set();

          if (times.has(k)) {
            return false;
          }

          times.add(k);

          return true;
        }
      }

      if (v instanceof LocalDateTime && dateTimeKeyable(v)) {
        datetimes ??= new Map();

        return addNested(datetimes, v.secs, v.nanos);
      }

      if (v instanceof ZonedTime || v instanceof ZonedDateTime) {
        const tail = zonedTailKey(v);

        if (tail !== undefined) {
          const root =
            v instanceof ZonedTime ? (zonedTimes ??= new Map()) : (zonedDateTimes ??= new Map());

          return addNested(root, v.secs, tail);
        }
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
  let dates: Map<number, GroupSlot> | undefined;
  // Item 1014, mirroring `valueSet`: one container per KIND, never shared.
  let times: Map<number, GroupSlot> | undefined;
  let datetimes: Map<number, Map<number, GroupSlot>> | undefined;
  let zonedTimes: Map<number, Map<number, GroupSlot>> | undefined;
  let zonedDateTimes: Map<number, Map<number, GroupSlot>> | undefined;
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

      // A `LocalDate` keys on its epoch-day count — see `valueSet` above for why this one
      // non-primitive IS raw-keyable and why it needs its own map rather than `prim`. Measured:
      // `GROUP BY <date>` with `count(*)` over 200,000 rows cost 21.82 ms against a range-matched
      // number key's 3.21 (6.8x), which is the string-key cost this function's own ladder prices
      // at 50.7 ns against 12.5.
      // FINITE only — see `valueSet` above: the non-finite collapse is item 843's pinned
      // behaviour.
      if (raw instanceof LocalDate && Number.isFinite(raw.days)) {
        dates ??= new Map();

        const hit = dates.get(raw.days);

        if (hit === undefined) {
          dates.set(raw.days, open(raw, by, rep));
        } else {
          hit.n += by;
        }

        return;
      }

      // Item 1014. The kinds item 850 set aside, priced at 6.5-12.8 ms against the raw-keyed
      // date arm's 1.2-1.6 on the same shape and group count. Per-kind decisions live in
      // module-scope helpers for the reason `valueSet` gives.
      if (raw instanceof LocalTime) {
        const k = localTimeKey(raw);

        if (k !== undefined) {
          times ??= new Map();

          const hit = times.get(k);

          if (hit === undefined) {
            times.set(k, open(raw, by, rep));
          } else {
            hit.n += by;
          }

          return;
        }
      }

      if (raw instanceof LocalDateTime && dateTimeKeyable(raw)) {
        datetimes ??= new Map();

        let inner = datetimes.get(raw.secs);

        if (inner === undefined) {
          inner = new Map();
          datetimes.set(raw.secs, inner);
        }

        const hit = inner.get(raw.nanos);

        if (hit === undefined) {
          inner.set(raw.nanos, open(raw, by, rep));
        } else {
          hit.n += by;
        }

        return;
      }

      // Item 1018: the zoned kinds, same two-level shape with `zonedTailKey` as the second level.
      // Open-or-bump is written out rather than factored into a helper: a closure built per row
      // cost `GROUP BY <datetime>` 2.7 -> 7.1 ms when this was tried that way.
      if (raw instanceof ZonedTime || raw instanceof ZonedDateTime) {
        const tail = zonedTailKey(raw);

        if (tail !== undefined) {
          const root =
            raw instanceof ZonedTime ? (zonedTimes ??= new Map()) : (zonedDateTimes ??= new Map());
          let inner = root.get(raw.secs);

          if (inner === undefined) {
            inner = new Map();
            root.set(raw.secs, inner);
          }

          const hit = inner.get(tail);

          if (hit === undefined) {
            inner.set(tail, open(raw, by, rep));
          } else {
            hit.n += by;
          }

          return;
        }
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
const sortGroupRows = (rows: Row[], sort: readonly ColSort[]): Row[] =>
  // The tally's own sort has no window — it pages through its `pageGroups` instead.
  sortRowsByColumns(rows, { sorts: sort, skip: 0, limit: undefined });

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
 * The clause `WHERE` as an inline predicate on the KEYED end — `null` to decline, `undefined` when
 * there is none.
 *
 * Extracted from `detectGroupedHopAggregate` because admitting `ORDER BY` there (item 1249) pushed
 * it to 36 of the 35 complexity cap, and this block is the cheapest honest thing to lift out: the
 * decision reads only the clause and the keyed variable. Same reason `hopAccFor` and item 1247's
 * wiring were extracted; the cap has been right in this file every time.
 *
 * A predicate reading ANY other variable declines, because this walk binds only the keyed end.
 */
const keyedClausePred = (
  where: Expr | undefined,
  keyedVar: string | undefined,
): InlinePred | null | undefined => {
  if (where === undefined) {
    return undefined;
  }

  for (const nameRead of freePredicateVars(where)) {
    if (nameRead !== keyedVar) {
      return null;
    }
  }

  return predFor(compilePredicate(undefined, where, keyedVar), keyedVar, true);
};

/**
 * `ORDER BY` for the REACHABILITY rung, resolved to its own output columns (item 1250).
 *
 * ⚠️ THIS ONE IS NOT A SLOWDOWN, IT IS AN ERROR. `detectReachableShortcut` refused every
 * `ORDER BY`, so an ordered query fell to the general path — which ENUMERATES TRAILS over an
 * UNBOUNDED pattern and dies on the trail budget. 3,000 nodes / 15,000 edges:
 *
 * ```text
 *   MATCH (a:P)-[:T]->*(x) RETURN count(DISTINCT x) AS c            OK     58 ms, 1 row
 *   ... ORDER BY c                                                  THROW  E_RESOURCE_EXHAUSTED
 *   MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n                 OK     29 ms, 3000 rows
 *   ... ORDER BY n                                                  THROW  E_RESOURCE_EXHAUSTED
 * ```
 *
 * Two spellings of one question where one ANSWERS and the other FAILS — and on the count form the
 * `ORDER BY` is a no-op, because one row is already in order. That is worse than the cost gaps
 * items 1247 and 1249 fixed: a user who adds a sort to a working query gets an error telling them
 * to "add a tighter bound".
 *
 * EVERY KEY MUST RESOLVE TO AN OUTPUT COLUMN, by name or by BEING that column's expression. The
 * first half is the tally's own argument (item 190): an output column's value is already computed,
 * so nothing is left unevaluated and no raise can be swallowed. The second half is there because
 * `outputColumnSorts` matches names ONLY, and item 1062 measured the asymmetry that creates at
 * 3.8x — here it would be answer-versus-error, which is worse than 3.8x.
 *
 * ⚠️ PAGING DECLINES, and that is a correctness boundary rather than caution: `runReach` applies
 * `skip`/`limit` ITSELF, so a sort layered on top of its output would slice BEFORE ordering and
 * return the wrong rows. Ordering with a window needs the slice moved inside, which is a different
 * change and is not made here.
 */
const reachSortApplier = (
  ret: Extract<Clause, { kind: 'return' }>,
  cols: readonly CReturnItem[],
  exprs: readonly Expr[],
): ((rows: Row[]) => Row[]) | null => {
  const keys = ret.projection.orderBy ?? [];

  if (keys.length === 0) {
    return (rows) => rows;
  }

  if (ret.projection.skip !== undefined || ret.projection.limit !== undefined) {
    return null;
  }

  const names = new Set(cols.map((c) => c.name));

  // Two items sharing one output NAME make a name ambiguous — the same refusal the tally makes.
  if (names.size !== cols.length) {
    return null;
  }

  const out: ColSort[] = [];

  for (const k of keys) {
    const byName = k.expr.kind === 'var' && names.has(k.expr.name) ? k.expr.name : undefined;
    const at = exprs.findIndex((e) => sameGroupingExpr(k.expr, e));
    const col = byName ?? (at >= 0 ? cols[at].name : undefined);

    if (col === undefined) {
      return null;
    }

    out.push({ col, descending: k.descending, nullsFirst: k.nullsFirst });
  }

  // At most one row per REACHED node, which is at most the graph — and far less than the trails
  // the general path was enumerating to answer the same question.
  return (rows) => sortGroupRows(rows, out);
};

/**
 * `colSortsOf` for a GROUPED AGGREGATE's N output columns rather than the tally's two (item 1249).
 *
 * ⚠️ THIS EXISTS BECAUSE BOTH GROUPED AGGREGATE RUNGS REFUSED EVERY `ORDER BY` WHILE THEIR TALLY
 * SIBLING ADMITTED THEM, which made two spellings of one question cost far apart. Measured at
 * 200,000 nodes / 1,000,000 edges, one shape per process:
 *
 * ```text
 *   HOP   RETURN x.city AS c, min(x.age) AS lo              313718.8 us
 *   HOP   ... ORDER BY c                                    670623.3     2.14x
 *   NODE  RETURN x.city AS c, min(x.age) AS lo                8038.1
 *   NODE  ... ORDER BY c                                     94934.9     11.81x
 * ```
 *
 * Eight groups do not take 357 ms to sort, let alone 87. Disabling the hop rung confirmed the cause
 * by ELIMINATION: the UNORDERED spelling went 313718 -> 702617 (it reaches the rung) while the
 * ORDERED one did not move at all (it never did).
 *
 * THE REFUSAL WAS NOT AN OVERSIGHT, which is why this is a resolver and not a deleted line. The
 * single-row aggregate rungs admit an `ORDER BY` for free through `sortsOnOutputOnly` — ordering
 * one row is a no-op. These two return one row per GROUP, so admitting it means SORTING. The tally
 * already does exactly that via `sortGroupRows`, whose note gives the argument: the sort is over
 * the GROUPS, which is at most what the query returns.
 *
 * BOTH SPELLINGS of a key resolve, which is why this reuses the tally's rule instead of
 * `outputColumnSorts`: that one matches an output NAME only, and item 1062 measured the asymmetry
 * it creates at 3.8x on `bun run spelling`. A key may name any output column, or BE the grouping
 * expression (`ORDER BY x.city` beside `RETURN x.city AS c`).
 */
const groupedSortApplier = (
  keys: readonly SortItem[],
  cols: readonly string[],
  keyCol: string,
  keyExpr: Expr,
): ((rows: Row[]) => Row[]) | null => {
  // THE IDENTITY when there is no `ORDER BY`, so each rung spends ONE branch (the decline) rather
  // than three — a ternary here, a null test, and a second ternary at the return.
  // `detectGroupedHopAggregate` was at 37 of 35 with the inline form, and this file's cap has been
  // right before (`hopAccFor`, and item 1247's own extraction).
  if (keys.length === 0) {
    return (rows) => rows;
  }

  // Two items sharing one output NAME collapse into one row key, so which column a name refers to
  // is ambiguous and cannot be resolved — the tally refuses the same case.
  if (new Set(cols).size !== cols.length) {
    return null;
  }

  const names = new Set(cols);
  const out: ColSort[] = [];

  for (const k of keys) {
    const byName = k.expr.kind === 'var' && names.has(k.expr.name) ? k.expr.name : undefined;
    const col = byName ?? (sameGroupingExpr(k.expr, keyExpr) ? keyCol : undefined);

    if (col === undefined) {
      return null;
    }

    out.push({ col, descending: k.descending, nullsFirst: k.nullsFirst });
  }

  // One row per GROUP, so this sorts at most what the query returns — the tally's own argument
  // (`sortGroupRows`), which uses `compareSort` so DESC and NULLS placement match the engine
  // rather than being re-derived here.
  return (rows) => sortGroupRows(rows, out);
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
  // COMPUTED ONCE (item 919). `hasSubqueryExpr` is a generic structural walk of the whole
  // expression and was called twice on the same `where` — here, negated, and again in the ternary
  // at the end of this function. A CPU profile put it at 184.2 ms of a clause-`WHERE` compile
  // against 31.9 for the inline spelling.
  const hasSub = hasSubqueryExpr(where);

  if (!hasSub) {
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
  // `nodeVar` is passed as that own variable, and the free-variable loop directly above is what
  // establishes the argument: every free name of `where` IS `nodeVar`, so the predicate is
  // element-local.
  //
  // THAT LOOP IS A ROUTE GATE, NOT A CORRECTNESS GUARD — measured, not assumed (item 919).
  // Inverting its condition (so a subquery-free predicate SKIPS the check and never declines)
  // survived the whole gql suite, and a direct probe of the shape it exists to decline — a node
  // projection whose clause `WHERE` reads an OUTER variable, `MATCH (z:P) WHERE z.k = 'b' MATCH
  // (n:P) WHERE n.n = z.n RETURN n.k` — returned identical rows with and without it, across `=`,
  // `>` and `<>`. The reason is the one item 128 recorded for this guard's twin in
  // `pushWhereIntoNode`: a node predicate is evaluated against the INCOMING binding, which
  // already holds every earlier clause's variables, so an outer reference resolves in the
  // pattern exactly as it did in the clause filter. Kept regardless, on item 128's rule — a
  // guard whose necessity is unproven is not a guard shown to be unnecessary — but do not cite
  // it as load-bearing for correctness. Without it the clause spelling of a filtered projection cost 9.64 ms against
  // the inline spelling's 6.78 on 200,000 vertices — 1.42x for one question, and the last group
  // the spelling probe still flagged (audit item 231).
  //
  // The two branches still differ by `gatePredicate` against `compileExpr`, and that
  // discrimination is load-bearing for a measured reason: the mutant routing EVERY predicate
  // through `gatePredicate` costs 18% on the indexed point lookup (95.4k -> 80.8k ops/s) from the
  // indirection alone. A subquery-bearing predicate has nothing else available anyway —
  // `compilePredicate` does not know about subqueries, and a correlated sub-pattern is not a
  // property equality — so `ownVar` would buy it nothing even if it were passed.
  return predFor(
    hasSub
      ? { props: [], where: gatePredicate(where) }
      : compilePredicate(undefined, where, nodeVar),
    nodeVar,
    true,
  );
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
/**
 * A single-node scan's filter gate: the start node's INLINE constraint and the clause `WHERE`
 * composed into one predicate, `undefined` for no filter, or `null` to decline the shape.
 *
 * Extracted (item 651) so the row-projecting path and the aggregate paths build the SAME gate
 * from the same pieces. That matters more than the saved lines: an aggregate path assembling its
 * own gate could admit a shape the row path declines, or filter differently — wrong answers, not
 * slow ones. Both spellings go through the general path's own `inlineHolds` / `nodeWhereOf`,
 * which is what keeps this filter identical to the general path's rather than merely similar.
 *
 * ⚠️ NOT shared with `detectGroupedNodeAggregate`, whose gate is character-identical at the
 * `reduceRight` and at everything above the `WHERE` — but carries the `WHERE` through
 * `compilePredicate` and its own `freePredicateVars` loop instead of `nodeWhereOf`. The two are
 * not interchangeable, and an anchored edit here matches BOTH sites; that is how this was found.
 *
 * The free-variable checks on the `WHERE` and on each item are DEFENSIVE, not load-bearing,
 * and mutation confirms it: with exactly two clauses, one pattern and no segments, `nodeVar`
 * is the ONLY name anything can be bound to — there is no earlier clause to bind another and
 * no far end to introduce one, so a reference to any other name does not resolve at all.
 * Removing either check changes no answer. They stay because that argument depends on the
 * clause-count and segment-count guards above keeping their exact shape, and because
 * (An earlier version of this note claimed `freePredicateVars` descends into a subquery and so
 * would catch one here. It does NOT — it returns the empty set for `exists` / `countSubquery` /
 * `valueSubquery`, per item 213 — so the ALLOWLIST is the only thing refusing a subquery, and
 * these checks are purely about outer names.) The same reasoning, and the same
 * wording, as `detectHopProjection`'s rel-variable and path-variable checks.
 */
const nodeScanGate = (
  start: NodePattern,
  where: Expr | undefined,
  nodeVar: string,
): InlineGate | undefined | null => {
  const preds: InlinePred[] = [];
  const inStart = inlineOf(start);

  if (inStart === null) {
    return null;
  }

  if (inStart !== undefined) {
    preds.push(inStart);
  }

  if (where !== undefined) {
    const carried = nodeWhereOf(where, nodeVar);

    if (carried === 'decline') {
      return null;
    }

    preds.push(carried);
  }

  return preds.reduceRight<InlineGate | undefined>(
    (rest, ip) => (v, binding, params, graph) =>
      inlineHolds(ip, v, binding, params, graph) &&
      (rest === undefined || rest(v, binding, params, graph)),
    undefined,
  );
};

/**
 * The candidate vertices a single-node scan shortcut walks, and whether they came from an INDEX.
 *
 * Extracted (item 651) so the row-projecting path and the aggregate paths share ONE copy of the
 * seed decision rather than three. That decision is the dangerous part of this preamble, not the
 * loop around it: written as a raw bucket walk first, it made the INDEXED point lookup 50x
 * SLOWER (80.9k -> 1.6k ops/s in `bench:usage`) while making the unindexed one 2x faster,
 * because it claimed the query ahead of the general path's index seek and then scanned.
 * `count-shortcuts-must-seek` names that failure and its signature.
 *
 * `hopSeek` returns a candidate set only when it is strictly smaller than the label bucket, so
 * an unindexed graph still walks the bucket and pays nothing for the attempt.
 *
 * ⚠️ `seeded` is returned, not just the iterable, and every caller must use it: a seeded set is
 * a SUPERSET — an index hint is a NECESSARY condition, not a sufficient one, so it can hand back
 * a same-named vertex of the WRONG LABEL. Two tests caught that omission as a WRONG ANSWER, not
 * as a slow one. The bucket walk satisfies the label by construction, which is why the recheck is
 * guarded on `seeded` rather than run unconditionally.
 */
const scanCandidates = (
  graph: Graph,
  cstart: CNode | undefined,
  label: LabelExpr | undefined,
  labelName: string | undefined,
  env: EvalEnv,
): { vertices: Iterable<Vertex>; seeded: ReadonlySet<Vertex> | undefined } => {
  const seeded = hopSeek(graph, cstart, label, env);

  return {
    seeded,
    vertices:
      seeded ??
      (labelName === undefined
        ? graph.verticesById.values()
        : (graph.verticesByLabel.get(labelName) ?? [])),
  };
};

/**
 * The pieces a single-node aggregate needs to walk the scan and fold VALUES directly, without
 * `detectNodeProjection` materializing a `Row` per vertex first — or `null` when the shape is
 * not one this can drive.
 *
 * ## Why this exists (item 651)
 *
 * `detectNodeAggregate` builds a synthetic one-item projection and delegates to
 * `detectNodeProjection`, which returns a MATERIALIZED `Row[]`. So `RETURN max(n.w)` over
 * 200,000 vertices allocated 200,000 row objects, wrote the value under a computed key, pushed
 * each to an array, and only then read it back out to fold. Measured at 200,000 vertices, min of
 * 3 alternated rounds:
 *
 * | | before | after | |
 * | --- | --- | --- | --- |
 * | `RETURN max(n.w)` (fold path) | 11.46 ms | **4.00** | **2.87x** |
 * | `RETURN sum(n.w)` (collecting path) | 12.32 ms | **6.64** | **1.86x** |
 *
 * The materialization was the whole gap and not the fold: a BARE `RETURN n.w AS w` over the same
 * scan — the same materialization, none of the fold — measured 9.61 ms, MORE than the entire
 * grouped aggregate (8.45) that folds during its walk.
 *
 * ## `rowsFn` still decides WHETHER the shape is claimed
 *
 * The caller keeps its `detectNodeProjection` call and its null check, so which queries this
 * family claims is unchanged by construction — no new shape becomes claimable, which is the
 * failure mode `count-shortcuts-must-seek` records. This only changes HOW an already-claimed
 * shape is executed. Everything `detectNodeProjection` verifies about the pattern (no path
 * variable, no segments, item locality, free variables) therefore holds whenever `rowsFn` is
 * non-null, and the synthetic projection carries no sort, skip or limit.
 *
 * The candidate set and the gate come from `scanCandidates` and `nodeScanGate` — the SAME
 * helpers the row path uses — so the two agree by construction rather than by a copy being
 * right. Both callers' loops must keep the row path's exact ORDER: label recheck, then gate,
 * then `binding.set`. The gate takes the vertex explicitly and runs before the binding is set.
 */
type NodeScan = {
  nodeVar: string;
  label: LabelExpr | undefined;
  labelName: string | undefined;
  cstart: CNode | undefined;
  gate: InlineGate | undefined;
};

/**
 * The scan pieces themselves, shared by the single-aggregate path and the MULTI-aggregate one
 * (item 652). Split out of `valueScanOf` rather than copied: the multi path supplies one compiled
 * argument function PER ACCUMULATOR, so it cannot use `valueScanOf`'s single `argFn`, but the
 * derivation of the candidate set and the gate has to stay identical across both.
 */
const nodeScanOf = (m: Clause, cm: CClause): NodeScan | null => {
  if (m.kind !== 'match' || cm.kind !== 'match' || m.patterns.length !== 1) {
    return null;
  }

  const [{ start }] = m.patterns;
  const nodeVar = start.variable;

  if (nodeVar === undefined) {
    return null;
  }

  const { label } = start;

  if (label !== undefined && label.kind !== 'label') {
    return null;
  }

  const gate = nodeScanGate(start, m.where, nodeVar);

  if (gate === null) {
    return null;
  }

  return {
    nodeVar,
    label,
    labelName: label?.name,
    cstart: cm.patterns[0].start,
    gate,
  };
};

const valueScanOf = (
  m: Clause,
  cm: CClause,
  argExpr: Expr,
): (NodeScan & { argFn: CompiledExpr }) | null => {
  const scan = nodeScanOf(m, cm);

  return scan === null ? null : { ...scan, argFn: compileExpr(argExpr) };
};

/**
 * The vertex a KEY ROW was ranked for, carried on the row itself.
 *
 * A SYMBOL rather than a reserved name because the row's other keys are the query's own output
 * column names, and a string key cannot be proven not to collide with one. A parallel array
 * cannot be used at all: the sort permutes the rows and the association has to survive it.
 */
const HELD_VERTEX = Symbol('heldVertex');

type KeyRow = Row & { [HELD_VERTEX]: Vertex };

/** One resolved `ORDER BY` key: the column the ranking writes it to, and how to compute it. */
type DeferredKey = { col: string; fn: CompiledExpr };

/**
 * The `ORDER BY` keys of a windowed sort, COMPILED, or `null` to decline.
 *
 * RANKING ON COMPILED KEYS RATHER THAN ON OUTPUT COLUMNS, which is what makes two spellings of
 * one question cost the same. `outputColumnSorts` requires every key to NAME an output column and
 * substitutes only a `prop` alias, so `RETURN n.k + 1 AS c ORDER BY c` resolved and
 * `… ORDER BY n.k + 1` did not. Ranking the first and not the second measured **3.8x apart on
 * `bun run spelling`** (11.30 ms against 43.13) — this repo's named defect class, created by the
 * first cut of item 1062 and caught by the probe before it shipped, where both spellings had been
 * converged at ~34 ms before. Evaluating the key expression itself has no such asymmetry: there is
 * nothing to match an alias against.
 *
 * The key row is DISCARDED — only the full projection is returned — so the keys go to synthetic
 * column names and never have to agree with `cols`.
 *
 * WHAT IT REFUSES, each for a reason the general path states:
 *
 *   - A key that is not ROW-LOCAL to the scan's own variable (`itemLocal`, plus the free-variable
 *     test the items already pass). An aggregate is excluded by `itemLocal`: it is defined over a
 *     group, not a row.
 *   - A SUBQUERY key. `freePredicateVars` returns the empty set for one — it does not descend —
 *     so the free-variable test cannot see its names, and substituting a subquery sort key was a
 *     live cross-engine divergence at item 213.
 *   - A key whose free name is also an OUTPUT name. In the sort scope the output columns are
 *     overlaid on the binding, so that name resolves to the COLUMN and means something else;
 *     `aliasDefinition` declines for exactly this and native does the same.
 */
const deferredSortKeys = (
  keys: readonly SortItem[],
  proj: Projection,
  cols: readonly string[],
  nodeVar: string,
): DeferredKey[] | null => {
  const outNames = new Set(cols);
  const out: DeferredKey[] = [];

  for (const [i, k] of keys.entries()) {
    // `ORDER BY <alias>` IS `ORDER BY <the expression the alias names>`, and the item's own
    // expression is what gets compiled — the same rewrite `aliasDefinition` performs for the
    // general path, so the two agree on which expression is the key.
    const key = k.expr;
    const named =
      key.kind === 'var'
        ? proj.items.find((it) => (it.alias ?? columnName(it.expr)) === key.name)
        : undefined;
    const expr = named === undefined ? key : named.expr;

    if (!itemLocal(expr) || hasSubqueryExpr(expr)) {
      return null;
    }

    for (const nameRead of freePredicateVars(expr)) {
      if (nameRead !== nodeVar || outNames.has(nameRead)) {
        return null;
      }
    }

    out.push({ col: `\u0000k${i}`, fn: compileExpr(expr) });
  }

  return out;
};

/**
 * A windowed, sorted node scan that RANKS ON THE KEYS AND PROJECTS ONLY THE EMITTED ROWS.
 *
 * WHY IT EXISTS (item 1062). `detectNodeProjection` refused a window whenever any projected item
 * could fault — `outputColumnSorts`'s rule — because it projected every row and sliced, which
 * would raise on a row the query never emits. So `RETURN n.k + 1 AS c ORDER BY c LIMIT 10` fell to
 * the general path at ~34 ms where the plain-property spelling takes this rung at 11-14 (items
 * 1058/1060/1061 located that boundary and priced it). The refusal was not about the ITEM being
 * unprojectable — `itemLocal` admits any row-local expression — it was about projecting it too
 * often.
 *
 * This arm does what the general path does, which is also what native does: evaluate the SORT
 * KEYS per row, rank those, then project the full width for the `cap` survivors only. A non-key
 * item that faults on a discarded row is never evaluated, exactly as in `applyProjection` after
 * `aliasDefinition` has substituted the alias; a KEY item that faults still raises, because the
 * general path evaluates every key per row too.
 *
 * A SEPARATE WALK, not a branch in the existing one. The plain arm is byte-for-byte unchanged:
 * item 1033 measured a branch added to a sibling hot loop costing three queries this rung's
 * change could not reach about 2x, and item 1034 built a module-scope walk instead for exactly
 * that reason ([[ts-closure-size-is-load-bearing]]).
 *
 * `binding` is always written here, with no `allDirect` test: this arm is reached only when some
 * item is NOT a direct property read, so the binding is always consulted.
 */
const deferredSortedNodeWalk = (spec: {
  cstart: CNode | undefined;
  label: LabelExpr | undefined;
  labelName: string | undefined;
  gate: InlineGate | undefined;
  nodeVar: string;
  cols: readonly string[];
  fns: readonly CompiledExpr[];
  directKeys: readonly (string | undefined)[];
  keys: readonly DeferredKey[];
  plan: SortPlan;
}): ((graph: Graph, params: Params) => Row[]) => {
  const { cstart, label, labelName, gate, nodeVar, cols, fns, directKeys, keys, plan } = spec;
  const width = cols.length;

  return (graph, params) => {
    const keyed: KeyRow[] = [];
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const { vertices, seeded } = scanCandidates(graph, cstart, label, labelName, env);

    for (const v of vertices) {
      // Both tests, in the same order and for the same reasons the plain arm states.
      if (seeded !== undefined && !matchesLabel(v, label)) {
        continue;
      }

      if (gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      binding.set(nodeVar, v);

      const kr = { [HELD_VERTEX]: v } as KeyRow;

      for (const k of keys) {
        kr[k.col] = k.fn(env);
      }

      keyed.push(kr);
    }

    // The ONE sorter, so the comparator, the bounded heap and the window all stay shared with the
    // plain arm — the key rows carry fewer columns, and nothing in there reads any other.
    const picked = sortRowsByColumns(keyed, plan) as KeyRow[];
    const out: Row[] = [];

    for (const kr of picked) {
      const v = kr[HELD_VERTEX];

      binding.set(nodeVar, v);

      const row: Row = {};

      for (let i = 0; i < width; i++) {
        const dk = directKeys[i];

        row[cols[i]] = dk === undefined ? fns[i](env) : propOf(v, dk);
      }

      out.push(row);
    }

    return out;
  };
};

/**
 * Is selecting `cap` of `rows` with a heap cheaper than sorting all of them?
 *
 * `* 16` is `sortRowsByColumns`'s own MEASURED crossover, not a guess: a heap is O(n log cap)
 * against the sort's O(n log n), so it wins only while `cap` is a small fraction of `n`, and at
 * `cap` near `n` it is a slower way to sort everything. That item's cap sweep at 200,000 rows read
 * 2.9x at 100, 3.2x at 1,000, 2.1x at 5,000, 1.45x at 10,000 and 0.99x at 20,000 — so the heap
 * stops paying at about `n/10` and this admits to `n/16`, inside the win. A looser `* 8` measured
 * 0.95x on `LIMIT 20,000`, which is the regression the constant exists to keep out.
 *
 * A PURE FUNCTION because the choice is answer-equivalent — both arms return the same rows in the
 * same order — so every mutation of it survives the differential tests and only its own unit tests
 * can see it (`perf-gate-needs-its-own-test`, items 1038/1044).
 */
export const heapBeatsSort = (cap: number, rows: number): boolean => cap * 16 <= rows;

/**
 * Can this sort plan be served by selecting the top `cap` during the scan (item 1064)?
 *
 * EXTRACTED AS A PURE FUNCTION because the choice is ANSWER-EQUIVALENT: both arms return the same
 * rows in the same order, so every mutation of a condition inline in the detector would survive the
 * differential tests. `perf-gate-needs-its-own-test` is the rule, learned at items 1038 and 1044.
 *
 * It needs a WINDOW (without a `limit` there is no `cap` to select) and every sort key must be a
 * DIRECT property read of the scan's own variable, because the selection reads keys off the vertex
 * rather than out of a projected row. A key that is not — an arithmetic expression, or a column
 * whose item is not a `prop` — keeps the plain arm, which is correct and only slower.
 */
export const topKPlan = (
  plan: SortPlan,
  cols: readonly string[],
  directKeys: readonly (string | undefined)[],
): { keyProps: readonly string[]; plan: SortPlan & { limit: number } } | undefined => {
  if (plan.limit === undefined || plan.sorts.length === 0) {
    return undefined;
  }

  const keyProps: string[] = [];

  for (const s of plan.sorts) {
    const dk = directKeys[cols.indexOf(s.col)];

    if (dk === undefined) {
      return undefined;
    }

    keyProps.push(dk);
  }

  return { keyProps, plan: { ...plan, limit: plan.limit } };
};

/**
 * A WINDOWED SORT ON DIRECT PROPERTY KEYS: select the top `cap` during the scan, project only
 * those.
 *
 * WHY (item 1064). The plain arm projects a `Row` for EVERY surviving vertex and then hands all of
 * them to `sortRowsByColumns`, whose heap selects `cap`. Over 200,000 vertices that is 200,000 row
 * objects to emit ten, and it measured 12.9 ms where native does the same query in 1.10. Locating
 * the cost took three measurements and refuted two hypotheses:
 *
 * ```text
 *   count(*)                                   0.00 ms   (no scan of properties at all)
 *   min(n.k)         scan + property read      4.63      ← the FLOOR for this shape in TS
 *   RETURN n.k AS c  + a row per vertex        8.42
 *   … ORDER BY c LIMIT 10                     12.9       ← the 4.5 ms on top is the selection
 * ```
 *
 *   - **Routing it through the deferred arm (item 1062) measured 14.25 — SLOWER.** That arm still
 *     allocates a key row per candidate, so it trades one object for another.
 *   - **A flat key array plus a full index sort measured 27.60 — much slower.** Avoiding the row
 *     object is not the win; the O(n log n) is.
 *
 * What works is both together: collect the surviving VERTICES (one array push, no object), select
 * `cap` of them with `boundedTopKeyed`, and project only those. 12.9 → 6.65 ms, which is within
 * 1.4x of the scan floor the `min` row establishes — so most of what is left is the scan, and
 * `pull`-style work on the remaining 2 ms would be chasing the layout ceiling.
 *
 * `boundedTopKeyed` is REUSED rather than re-implemented, for the reason `sortRowsByColumns` gives
 * about comparators: it already carries the arrival-index tiebreak that makes the heap's order the
 * stable sort's total order, and tie order under `ORDER BY` is observable between the engines (item
 * 605). A second selection with its own tiebreak is exactly what byte-identity cannot survive.
 *
 * THE CAP GUARD IS PER CALL, not per compile, because it depends on the row count. `* 16` is
 * `sortRowsByColumns`'s own MEASURED crossover — a heap is O(n log cap) against the sort's
 * O(n log n), so it wins only while `cap` is a small fraction of `n`, and at `cap` near `n` it is a
 * slower way to sort everything. Above it this walk does what the plain arm does, which is why
 * the large-`cap` shape cannot regress past one extra array.
 */
const topKNodeWalk = (spec: {
  cstart: CNode | undefined;
  label: Extract<LabelExpr, { kind: 'label' }> | undefined;
  gate: InlineGate | undefined;
  nodeVar: string;
  cols: readonly string[];
  fns: readonly CompiledExpr[];
  directKeys: readonly (string | undefined)[];
  keyProps: readonly string[];
  plan: SortPlan & { limit: number };
}): ((graph: Graph, params: Params) => Row[]) => {
  const { cstart, label, gate, nodeVar, cols, fns, directKeys, keyProps, plan } = spec;
  const labelName = label?.name;
  const width = cols.length;
  const cap = plan.skip + plan.limit;
  const allDirect = directKeys.every((k) => k !== undefined);

  return (graph, params) => {
    const binding = new Map<string, unknown>();
    const env = { binding, params, graph };
    const { vertices, seeded } = scanCandidates(graph, cstart, label, labelName, env);
    const kept: Vertex[] = [];

    for (const v of vertices) {
      // Both tests, in the same order and for the same reasons the plain arm states.
      if (seeded !== undefined && !matchesLabel(v, label)) {
        continue;
      }

      if (gate !== undefined && !gate(v, binding, params, graph)) {
        continue;
      }

      kept.push(v);
    }

    const project = (v: Vertex): Row => {
      if (!allDirect) {
        binding.set(nodeVar, v);
      }

      const row: Row = {};

      for (let i = 0; i < width; i++) {
        const dk = directKeys[i];

        row[cols[i]] = dk === undefined ? fns[i](env) : propOf(v, dk);
      }

      return row;
    };

    // ABOVE THE CROSSOVER, do what the plain arm does: project everything and let
    // `sortRowsByColumns` sort and slice. Same answer, and the only extra is the `kept` array.
    if (!heapBeatsSort(cap, kept.length)) {
      return sortRowsByColumns(kept.map(project), plan);
    }

    const top = boundedTopKeyed(kept, (v, i) => propOf(v, keyProps[i]), plan.sorts, cap);

    return top.slice(plan.skip).map(project);
  };
};

/**
 * THE DEFERRED ARM's compile-time half (item 1062), extracted because inlining it put
 * `detectNodeProjection` at a complexity of 42 against a ceiling of 35 — the same reason item
 * 1038 pulled `relBoundRoute` out of its own detector.
 *
 * `outputColumnSorts` has just refused a window — most often because a projected item could fault
 * and the plain arm projects every row — and this answers the same shape by ranking on the keys
 * and projecting only the rows it emits, which is what the general path and native both do. Its
 * own window rules, each with its reason:
 *
 *   - `limit === undefined` DECLINES. A `SKIP` with no `LIMIT` is not a top-k: with no cap the
 *     general path sorts and projects EVERY row and then drops the skipped ones, so
 *     `RETURN <faulting> AS x, n.n AS t ORDER BY t OFFSET 1` raises on both engines even though
 *     the window discards the faulting row. `page-fold-fault.test.ts`'s existing control caught
 *     the first cut of this arm admitting it.
 *   - `limit === 0` DECLINES, and here that is CORRECTNESS rather than speed: `applyProjection`
 *     returns `[]` before ranking or projecting anything, so evaluating keys to emit nothing
 *     would raise where the query does not. The identical guard in `outputColumnSorts` is only a
 *     speed guard, which is why it is documented in both places.
 *   - A PARAMETERIZED window declines: the route is chosen once at compile time while the value
 *     lives in `params`, which the plan cache is shared across.
 */
const deferredRoute = (spec: {
  proj: Projection;
  cstart: CNode | undefined;
  // The NARROWED label, as the detector has it: a plain `:L`, the only form the scan takes.
  label: Extract<LabelExpr, { kind: 'label' }> | undefined;
  gate: InlineGate | undefined;
  nodeVar: string;
  cols: readonly string[];
  fns: readonly CompiledExpr[];
  directKeys: readonly (string | undefined)[];
}): ((graph: Graph, params: Params) => Row[]) | null => {
  const { proj, cstart, label, gate, nodeVar, cols, fns, directKeys } = spec;
  const { skip, limit } = proj;
  const keys = proj.orderBy;

  if (
    keys === undefined ||
    keys.length === 0 ||
    typeof limit !== 'number' ||
    limit === 0 ||
    (skip !== undefined && typeof skip !== 'number')
  ) {
    return null;
  }

  const deferredKeys = deferredSortKeys(keys, proj, cols, nodeVar);

  if (deferredKeys === null) {
    return null;
  }

  return deferredSortedNodeWalk({
    cstart,
    label,
    labelName: label?.name,
    gate,
    nodeVar,
    cols,
    fns,
    directKeys,
    keys: deferredKeys,
    plan: {
      sorts: keys.map((k, i) => ({
        col: deferredKeys[i].col,
        descending: k.descending,
        nullsFirst: k.nullsFirst,
      })),
      skip: typeof skip === 'number' ? skip : 0,
      limit,
    },
  });
};

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
    proj.items.length === 0
  ) {
    return null;
  }

  // `orderBy` is NO LONGER an outright decline (item 605) — see `outputColumnSorts`, which admits
  // it when every key is an output column AND there is no window. `skip`/`limit` are refused
  // THERE rather than here, because the two decisions are one rule: a window without a sort must
  // also decline, since the general path is LAZY for it and a `LIMIT 5` short-circuits after a
  // few rows where this path materializes everything — `sortOf` records that as a ~280x
  // regression for the DISTINCT walk, which is the same trade in the same place.
  if ((proj.orderBy?.length ?? 0) === 0 && (proj.skip !== undefined || proj.limit !== undefined)) {
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

  const { where } = m;
  const gate = nodeScanGate(start, where, nodeVar);

  if (gate === null) {
    return null;
  }

  const cols: string[] = [];
  const fns: CompiledExpr[] = [];
  /** Per item: the property key when it is `<nodeVar>.<key>`, else `undefined`. See the push. */
  const directKeys: (string | undefined)[] = [];

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
    // A DIRECT READ for `<nodeVar>.<key>` (item 835). `compileExpr`'s `prop` arm is exactly
    // `(env) => propOf(env.binding.get(variable), key)`, so for the scan's OWN variable the
    // compiled closure writes the element into a `Map`, builds an `env`, and reads it straight
    // back out. Recording the key here lets the loop call `propOf(v, key)` on the vertex it
    // already holds — byte-identical by construction, because it is the same function on the same
    // element.
    //
    // This is the projection half of what items 224/230 did for PREDICATES (lifting
    // `<ownVar>.<key>` out of the general evaluator) and what item 803 did for the binding write.
    // Measured at item 833: the write, the env and the read-back-out are 11.3 ns a row together,
    // disjoint over three rounds.
    //
    // `variable === nodeVar` is REDUNDANT TODAY and kept deliberately — mutation says so: removing
    // it leaves all 2,634 tests green, because the `freePredicateVars` loop above has already
    // returned `null` for any item reading another name, and a `prop` expr carries no subquery so
    // that loop always ran for it. It is the coupling this read silently depends on, so it stays
    // as the thing that fails loudly if that check is ever loosened — the same reason the rollback
    // path keeps its `schema_reverted` guard. Item 475's rule: a surviving mutant on a new guard
    // means "redundant" as readily as "untested", and the two have opposite fixes.
    directKeys.push(
      item.expr.kind === 'prop' && item.expr.variable === nodeVar ? item.expr.key : undefined,
    );
  }

  // When EVERY item reads the element directly, nothing in the projection consults the binding, so
  // the per-vertex `Map` write is dead too — item 803's rule, applied to the projection.
  const allDirect = directKeys.every((k) => k !== undefined);

  // The sort is resolved AFTER `cols`, because the rule is about output columns and those are
  // what `cols` holds. `undefined` means no sort (the streaming path, unchanged); `null` declines.
  const sorts = outputColumnSorts(ret, cols);

  if (sorts === null) {
    return deferredRoute({
      proj,
      cstart: cm.patterns[0].start,
      label,
      gate,
      nodeVar,
      cols,
      fns,
      directKeys,
    });
  }

  // THE TOP-K ARM (item 1064). `sorts` is a WINDOWED sort this rung already serves by projecting
  // every row and letting `sortRowsByColumns` select — so the answer is the same either way and
  // this is a pure route choice, which is why `topKPlan` is a tested pure function rather than a
  // condition inline here (`perf-gate-needs-its-own-test`).
  const topK = sorts === undefined ? undefined : topKPlan(sorts, cols, directKeys);

  if (topK !== undefined) {
    return topKNodeWalk({
      cstart: cm.patterns[0].start,
      label,
      gate,
      nodeVar,
      cols,
      fns,
      directKeys,
      keyProps: topK.keyProps,
      plan: topK.plan,
    });
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
    // SEED FROM THE INDEX when one is cheaper than the label bucket. The decision, and the
    // 50x `bench:usage` regression that shaped it, are documented once on `scanCandidates`.
    const { vertices, seeded } = scanCandidates(graph, cstart, label, labelName, {
      binding,
      params,
      graph,
    });

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
      if (!allDirect) {
        binding.set(nodeVar, v);
      }

      const row: Row = {};

      for (let i = 0; i < width; i++) {
        const dk = directKeys[i];

        row[cols[i]] = dk === undefined ? fns[i]({ binding, params, graph }) : propOf(v, dk);
      }

      out.push(row);
    }

    // `sortGroupRows` is the tally's sorter and is reused deliberately: it goes through
    // `compareSort`, the engine's own comparator, whose doc states "the Rust `compare_sort`
    // matches" — so DESC and the NULLS placement cannot drift from native, and a second
    // comparator is exactly the thing byte-identity cannot survive.
    //
    // `Array.prototype.sort` is STABLE, so ties keep the scan's arrival order. That matters:
    // tie order under `ORDER BY` is OBSERVABLE between the engines — measured at item 605 over a
    // 60-row fixture with 20 ties per group, where TS and native agree exactly on every ordered
    // spelling — and this path scans the same candidate vertices in the same order the general
    // path does, so a stable sort preserves that agreement.
    // `sortRowsByColumns`, not `sortGroupRows`: the plan may carry a WINDOW (item 610), which
    // the tally's wrapper does not take — it pages through `pageGroups` instead.
    return sorts === undefined ? out : sortRowsByColumns(out, sorts);
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

    preds.push(predFor(compilePredicate(undefined, where, start.variable), start.variable, true));
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

    preds.push(predFor(compilePredicate(undefined, where, keyed.variable), keyed.variable, true));
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
    // is a RUNTIME property of the graph — so the degree walk is chosen per call, with the
    // per-edge walk as the always-correct alternative rather than a decline. (A `ReachFn`
    // returns rows; it has no way to decline once built.)
    const bucketSumSound = bucketSumsAreSound(types, graph.multiTypeEdgeCount);
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
 * also includes the seed(s). Mirrors the native engine's `varlen_distinct_endpoint_count`
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
  // reachable set. The native side has no named counterpart to grep for: it seeds
  // from a `Plan::Scan` with the label and leaves the inline predicate as a `Filter`
  // above it, so the narrowing is a plan shape rather than a function.
  // (`reach_seed_vertices` xref:gone.)
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
    // nulls, dedup values — mirrors the native `varlen_distinct_endpoint_count`.
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
 * `refsOnlyVar` gate as `exec::fastpath::refs_only_slot`, so both engines take the
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
  // labelled endpoint bound to a variable, a buildable rel type. An `ORDER BY` is resolved below
  // rather than refused here (item 1250) — refusing it sent the query to the general path, which
  // enumerates trails over an unbounded pattern and THROWS on the trail budget.
  if (
    q?.max !== null ||
    rel.variable !== undefined ||
    rel.direction === 'both' ||
    (rel.properties?.length ?? 0) > 0 ||
    rel.where !== undefined ||
    bVar === undefined ||
    (node.properties?.length ?? 0) > 0 ||
    node.where !== undefined ||
    types === null
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

  const applySort = reachSortApplier(
    ret,
    cret.projection.items,
    ret.projection.items.map((it) => it.expr),
  );

  if (applySort === null) {
    return null;
  }

  return (graph, params) => applySort(runReach(spec, graph, params));
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
): { name: string; frac: number; expr: Extract<Expr, { kind: 'func' }> }[] | undefined => {
  if (!unfilteredScan(m) || ret.kind !== 'return') {
    return undefined;
  }

  const { items } = ret.projection;

  if (items.length !== 1) {
    return undefined;
  }

  const [only] = items;
  // ITEM 1196: the aggregate need not BE the item. `collectAggregates` finds the one inside
  // `size(collect(a.k))` / `coalesce(collect(a.k), 1)`, and requiring EXACTLY one keeps the
  // single-accumulator contract the rest of this function is built on — a second aggregate
  // (`size(collect(a.k)) + count(*)`) still falls to the general path. Matching `only.expr`
  // directly, as this did, declined every wrapped spelling: measured at 6.65-7.97x the bare one.
  const found = collectAggregates(only.expr);

  if (found.length !== 1) {
    return undefined;
  }

  const [e] = found;

  if (e.star || e.distinct) {
    return undefined;
  }

  // The SINGLE-item gate, and the one that was actually refusing the five slow aggregates: it
  // ran ahead of the multi-item path, so widening only that one moved almost nothing (item 530).
  // `grep the pattern elsewhere` applies inside one file as readily as across a repo.
  const frac = percentileFraction(e);

  if (frac === null || !VALUES_AGGREGATES.has(e.name)) {
    return undefined;
  }

  return [{ name: e.name, frac, expr: e }];
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
    proj.items.length !== 1 ||
    proj.having !== undefined ||
    !sortsOnOutputOnly(ret, proj) ||
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
  // THE AGGREGATE NEED NOT BE THE PROJECTION ITEM, on either path (items 1197 and 1198). The node
  // comes from whichever descriptor found it — `unfilteredScanAgg` searched inside the item for the
  // collecting path, `foldedAggs` for the fold path — and the folded value is handed to the
  // wrapping expression by `emit` below. Requiring identity here declined every wrapped spelling:
  // measured at 6.52-10.22x the bare one on the collecting path, and 8.12-9.46x on the fold path
  // (`upper(max(a.str))` 47.8ms against `min(a.num)`'s 3.9).
  const aggNode = collect !== undefined ? collect[0].expr : (agg?.expr ?? item.expr);

  // The THIRD arity gate in this one function, and the last one a percentile had to pass.
  // `percentileFraction` is `0` for a well-formed one-argument aggregate and the clamped
  // fraction for a well-formed percentile, so it says exactly what this gate wants to know for
  // both the fold path and the collecting one (item 530).
  if (aggNode.kind !== 'func' || percentileFraction(aggNode) === null) {
    return null;
  }

  const [argExpr] = aggNode.args;
  // When the aggregate is WRAPPED, the item's own expression still has to run — but ONCE, over a
  // one-row group view carrying the folded value under the aggregate's AST node. That is the key
  // `compileAggregate` already looks a pre-folded value up by, so the wrapping expression goes
  // through the SAME evaluator the general path uses instead of a second implementation of it.
  // `null` for the bare spelling, which must keep returning the aggregate value untouched.
  const outerFn = item.expr === aggNode ? null : compileExpr(item.expr);
  const outName = proj.items[0].name;
  /**
   * Apply the wrapping expression to a streaming closure's single row — or hand the closure back
   * untouched when there is nothing to wrap.
   *
   * ⚠️ A POST-PROCESSOR, not a change inside the loops, and that is MEASURED. The first build of
   * this item threaded the wrapping through each of the four streaming arms, which grew their
   * returned closures' captured environment and cost all three BARE controls in the same
   * direction — `max(a.num)` 0.84x, `count(a.num)` 0.89x and the `min(a.num)` floor 0.95x over
   * three alternated rounds — and making the row counter conditional did NOT recover it. That is
   * this repo's "TS closure size is load-bearing" hazard, and item 1184's measured rule that a
   * widening in place taxes the path it widened. Wrapping from OUTSIDE leaves all four loops
   * byte-identical, so the bare spelling is a path this change cannot reach at all.
   *
   * The group view's SIZE is deliberately unavailable: the arity gate above admits exactly ONE
   * aggregate, so nothing in the wrapping expression can read `group.length` — only a second
   * aggregate would. Rather than invent a number, the view THROWS if its length is ever read, so
   * widening that gate fails loudly instead of silently reporting a wrong count.
   */
  const applyOuter = (
    inner: (graph: Graph, params: Params) => Row[],
  ): ((graph: Graph, params: Params) => Row[]) => {
    if (outerFn === null) {
      return inner;
    }

    return (graph, params) => {
      const [row] = inner(graph, params);

      return [
        {
          [outName]: outerFn({
            binding: new Map<string, unknown>(),
            params,
            graph,
            group: foldedAggOnlyView(aggNode, row[outName]),
          }),
        },
      ];
    };
  };
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

  // `rowsFn` above decided WHETHER to claim this shape; `vs` only changes HOW it runs — folding
  // the argument's values during the walk instead of materializing a `Row` per vertex. `null`
  // falls through to the row-reading loops below, which stay the only implementation for
  // anything this cannot drive. See `valueScanOf`.
  //
  // `detectMultiNodeAggregate` materializes the same way and is NOT wired here: it reads SEVERAL
  // columns off each row, so it needs a per-aggregate accumulator set rather than one argument
  // function. Same lever, bigger change, measured separately.
  const vs = valueScanOf(m, compiled[0], argExpr);

  // THE COLLECTING PATH (item 468): stream the argument VALUES — one per row, no `Binding`
  // `Map` — and hand them to the same `aggregateOverValues` the general path runs. The nullish
  // filter mirrors the general path's `nonNull`, which is the same rule the fold path applies
  // per step.
  if (collect !== undefined) {
    const [{ name: aggName, frac }] = collect;

    if (vs !== null) {
      const { nodeVar: sv, label, labelName, cstart, gate, argFn } = vs;

      return applyOuter((graph, params) => {
        const binding = new Map<string, unknown>();
        const env = { binding, params, graph };
        const { vertices, seeded } = scanCandidates(graph, cstart, label, labelName, env);
        const values: unknown[] = [];

        for (const v of vertices) {
          if (seeded !== undefined && !matchesLabel(v, label)) {
            continue;
          }

          if (gate !== undefined && !gate(v, binding, params, graph)) {
            continue;
          }

          binding.set(sv, v);

          const value = argFn(env);

          if (!isNullish(value)) {
            values.push(value);
          }
        }

        return [{ [outName]: aggregateOverValues(aggName, values, frac) }];
      });
    }

    return applyOuter((graph, params) => {
      const values: unknown[] = [];

      for (const row of rowsFn(graph, params)) {
        const v = row[VALUE_COL];

        if (!isNullish(v)) {
          values.push(v);
        }
      }

      return [{ [outName]: aggregateOverValues(aggName, values, frac) }];
    });
  }

  const { fold } = agg!;

  if (vs !== null) {
    const { nodeVar: sv, label, labelName, cstart, gate, argFn } = vs;

    return applyOuter((graph, params) => {
      const binding = new Map<string, unknown>();
      const env = { binding, params, graph };
      const { vertices, seeded } = scanCandidates(graph, cstart, label, labelName, env);
      let acc = fold.init();

      for (const v of vertices) {
        if (seeded !== undefined && !matchesLabel(v, label)) {
          continue;
        }

        if (gate !== undefined && !gate(v, binding, params, graph)) {
          continue;
        }

        binding.set(sv, v);

        const value = argFn(env);

        if (!isNullish(value)) {
          acc = fold.step(acc, value);
        }
      }

      // The same `fold.finish` over an untouched accumulator that gives an EMPTY scan its one
      // row holding null, which is what an ungrouped aggregate owes ISO.
      return [{ [outName]: fold.finish(acc) }];
    });
  }

  return applyOuter((graph, params) => {
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
  });
};

/**
 * One projected aggregate's accumulator in the MULTI-aggregate scan path (item 469).
 *
 * `rows` is `count(*)`, which needs no value at all — it counts rows, nullish included, which
 * is why it is a separate arm rather than a fold over a projected column.
 */
type MultiAcc =
  | { readonly kind: 'rows'; readonly out: string }
  | {
      readonly kind: 'fold';
      readonly out: string;
      readonly fold: AggFold;
      readonly col: string;
      /**
       * The aggregate's ARGUMENT, compiled (item 652). The streaming walk evaluates this per
       * vertex; `col` is the synthetic column the row-reading fallback reads instead. Both are
       * carried because that fallback is still the only implementation for a shape the walk
       * cannot drive.
       */
      readonly argFn: CompiledExpr;
    }
  | {
      readonly kind: 'collect';
      readonly out: string;
      readonly name: string;
      readonly col: string;
      /** The percentile fraction, already clamped. 0 for every other name, which ignores it. */
      readonly frac: number;
      /** See the `fold` variant's `argFn`. */
      readonly argFn: CompiledExpr;
    };

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
/**
 * Finish a multi-aggregate accumulator set into its single output row. Shared by the streaming
 * walk and the row-reading fallback (item 652) so the two cannot drift: `fold.finish` over an
 * untouched accumulator is what gives an EMPTY scan its one row holding null, and
 * `aggregateOverValues` is the same function the general path calls.
 */
const finishMultiAccs = (accs: readonly MultiAcc[], state: readonly unknown[], n: number): Row => {
  const out: Row = {};

  for (let i = 0; i < accs.length; i += 1) {
    const a = accs[i];

    if (a.kind === 'rows') {
      out[a.out] = n;
    } else if (a.kind === 'fold') {
      out[a.out] = a.fold.finish(state[i]);
    } else {
      out[a.out] = aggregateOverValues(a.name, state[i] as unknown[], a.frac);
    }
  }

  return out;
};

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
    proj.items.length < 2 ||
    proj.having !== undefined ||
    !sortsOnOutputOnly(ret, proj) ||
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

    // The PERCENTILES take `(value, <numeric literal>)`; every other aggregate takes one
    // argument. A malformed percentile call is REFUSED rather than diagnosed here, so the
    // general path raises the same error it always did (item 530).
    const frac = percentileFraction(e);

    if (frac === null) {
      return null;
    }

    const [arg] = e.args;
    // A name no GQL identifier can collide with, one per item.
    const col = ` nodeagg${i}`;
    const fold = foldFor(e.name, false, false);

    const argFn = compileExpr(arg);

    if (fold !== undefined) {
      accs.push({ kind: 'fold', out, fold, col, argFn });
    } else if (VALUES_AGGREGATES.has(e.name) && unfiltered) {
      accs.push({ kind: 'collect', out, name: e.name, col, frac, argFn });
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

  // STREAM the accumulators during the walk instead of over a materialized `Row[]` (item 652,
  // item 651's lever at the multi-aggregate site). `rowsFn` above still decides WHETHER the shape
  // is claimed, so nothing becomes newly claimable; this only changes HOW.
  //
  // Measured at 200,000 vertices, min of three alternated rounds: `max(n.w), min(n.w)` 8.99 ms
  // and `max(n.w), min(n.k)` 9.13, against 3.54 for the SINGLE-aggregate spelling over the same
  // column — which 651 had already put on a streaming walk. A second accumulator is one extra
  // fold step per row; it was costing 2.5x, and the difference was the `Row` per vertex.
  const vs = nodeScanOf(m, compiled[0]);

  if (vs !== null) {
    const { nodeVar: sv, label, labelName, cstart, gate } = vs;

    return (graph, params) => {
      const binding = new Map<string, unknown>();
      const env = { binding, params, graph };
      const { vertices, seeded } = scanCandidates(graph, cstart, label, labelName, env);
      const state = accs.map((a) => (a.kind === 'fold' ? a.fold.init() : ([] as unknown[])));
      let n = 0;

      for (const v of vertices) {
        // The row path's exact order: label recheck, then gate, then `binding.set`. The gate
        // takes the vertex explicitly and runs before the binding is set.
        if (seeded !== undefined && !matchesLabel(v, label)) {
          continue;
        }

        if (gate !== undefined && !gate(v, binding, params, graph)) {
          continue;
        }

        binding.set(sv, v);
        n += 1;

        // An INDEX loop, not `accs.entries()`, for item 469's measured reason: the iterator
        // allocates a `[i, a]` tuple per accumulator per row, which alone cost
        // `count(n.age), count(*)` 17.8 ms against 9.4 at 200,000 rows.
        //
        // 🛑 DEDUPLICATING IDENTICAL ARGUMENTS IS REFUTED FOR THE COMMON CASE (item 653), and
        // item 652 recorded it as open before it was priced. `max(n.w), min(n.w)` evaluates
        // `n.w` twice per vertex, so a compile-time grouping by argument expression looked free.
        // Priced with NO code written, using `max(n.w), count(*)` — structurally the CSE'd shape,
        // since it holds the accumulator count at two and varies only the number of argument
        // evaluations (652 measured the `rows` arm as free). 200,000 vertices, min of three
        // alternated rounds:
        //
        //   max(n.w), min(n.w)   TWO evals   6.13 ms
        //   max(n.w), count(*)   ONE eval    6.46      <- two evals is FASTER
        //   grouped twin                     8.06 against 7.76 (3.9%, under the noise floor)
        //
        // A bare property read off an already-bound vertex is the cheapest expression there is,
        // and evaluating it twice costs less than any machinery to avoid it. Since two evals
        // measure FASTER than one here, an always-dedup would add an extra loop level to a path
        // where the saving is zero — a REGRESSION on the shape people actually write.
        //
        // The other half of the enum is real but narrow: with an EXPENSIVE shared argument
        // (`abs(n.w) * 2 + 1`) the same pair reads 27.23 against 20.85, about 1.31x. Capturing
        // it would need a cost model to decide "is this argument expensive", because applying it
        // unconditionally loses the cheap case above. That is a lot of apparatus for
        // `max(<non-trivial expr>), min(<the same expr>)`, so it is NOT built.
        for (let i = 0; i < accs.length; i += 1) {
          const a = accs[i];

          if (a.kind === 'rows') {
            continue;
          }

          const value = a.argFn(env);

          if (isNullish(value)) {
            continue;
          }

          if (a.kind === 'fold') {
            state[i] = a.fold.step(state[i], value);
          } else {
            (state[i] as unknown[]).push(value);
          }
        }
      }

      return [finishMultiAccs(accs, state, n)];
    };
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

    return [finishMultiAccs(accs, state, n)];
  };
};

/**
 * The one-argument aggregates that have NO streaming fold and so run over the group's VALUES.
 *
 * `foldFor` answers `count`/`min`/`max`; everything else here reaches `aggregateOverValues`, the
 * single shared implementation the general path also calls — so routing them through the scan
 * rung changes WHERE the values come from and nothing about the arithmetic or the order. That is
 * the whole reason this is a name set rather than five hand-written folds: a second
 * implementation of `sum` could not even be written correctly (the operation is chosen by looking
 * at the whole collection — item 467), and a second `stddev` would be a byte-identity hazard.
 *
 * PRICED AS AN ENUM (item 530). All eleven ISO aggregate names, same scan, same argument, ts at
 * 200,000 vertices — six took the rung and five did not:
 *
 * ```text
 *   count(n.age) 10.9   max 11.2   min 11.3   sum 13.6   avg 13.7   count(DISTINCT) 3.0
 *   stddev_pop 50.9   percentile_cont 56.8   percentile_disc 64.3   stddev_samp 69.9
 *   collect 72.4
 * ```
 *
 * The native engine answers all eleven from 0.4 to 5.6 ms, so the gap was TS-only and as wide as
 * 64x on `stddev_samp`.
 */
const VALUES_AGGREGATES: ReadonlySet<string> = new Set([
  'sum',
  'avg',
  'collect',
  'collect_list',
  'stddev_pop',
  'stddev_samp',
  'percentile_cont',
  'percentile_disc',
]);

/** One projected aggregate's per-group accumulator in the grouped scan path (item 474). */
type GroupAcc =
  | { readonly kind: 'rows'; readonly out: string }
  | {
      readonly kind: 'fold';
      readonly out: string;
      readonly fold: AggFold;
      readonly argFn: CompiledExpr;
      readonly argExpr: Expr;
    }
  // An aggregate with NO streaming fold, collected per group and finished through the same
  // `aggregateOverValues` the general path runs (item 553). Admitted only on an UNFILTERED scan —
  // see `groupedAccs`' `unfiltered` parameter for the measured reason.
  | {
      readonly kind: 'values';
      readonly out: string;
      readonly name: string;
      readonly frac: number;
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
  /**
   * Is the source UNFILTERED? Then the aggregates with no streaming fold may be collected per
   * group (item 553), because this rung visits vertices in scan order and so does the general
   * path. With a filter it may not, and the reason is demonstrable rather than theoretical: with
   * a range index on `age`,
   *
   * ```text
   *   WHERE n.age >= 5 RETURN n.tag, collect(n.age)   no index [7,5,9] / [8,6]
   *                                                   indexed  [5,7,9] / [6,8]
   * ```
   *
   * The seek visits in INDEX order, so the values reach their group in a different order — and
   * the same predicate written `n.age + 0 >= 5`, which cannot seed, is unchanged either way,
   * which is what isolates the cause to the seed. Both engines agree on both answers, so this is
   * a REAL order the rung would have to reproduce and cannot.
   *
   * `sum`/`avg` and the stddevs differ in the last ulp under reordering, and `collect`'s order IS
   * its answer. The percentiles sort their values and so would be safe either way; they ride the
   * same flag because a second condition for one name is a guard with no test.
   */
  unfiltered: boolean,
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

    if (!rowLocal(argExpr)) {
      return null;
    }

    if (fold === undefined) {
      const frac = unfiltered ? percentileFraction(e) : null;

      if (frac === null || !(VALUES_AGGREGATES.has(e.name) || e.args.length === 1)) {
        return null;
      }

      accs.push({
        kind: 'values',
        out,
        name: e.name,
        frac,
        argFn: compileExpr(argExpr),
        argExpr,
      });
      continue;
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
  // UNFILTERED means both spellings of a filter are absent — the start node's INLINE constraint
  // and the clause `WHERE`. `groupedAccs` needs it to admit an aggregate with no streaming fold;
  // `inlineOf` is read again below for the gate itself.
  const unfiltered = inlineOf(start) === undefined && m.where === undefined;
  const picked = groupedAccs(ret.projection.items, proj.items, nodeVar, unfiltered);

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
  // Resolved HERE rather than in the gate, because it needs the output columns and the grouping
  // expression. `null` declines the whole rung; otherwise it is the sort to apply, which is the
  // IDENTITY when the query has no `ORDER BY`.
  const applySort = groupedSortApplier(
    ret.projection.orderBy ?? [],
    proj.items.map((i) => i.name),
    keyCol,
    keyExpr,
  );

  if (applySort === null) {
    return null;
  }

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

    preds.push(predFor(compilePredicate(undefined, where, nodeVar), nodeVar, true));
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
        slot = {
          key: raw,
          n: 0,
          state: accs.map((a) => {
            if (a.kind === 'fold') {
              return a.fold.init();
            }

            return a.kind === 'values' ? [] : 0;
          }),
        };
        bySeen.set(id, slot);
        slots.push(slot);
      }

      slot.n += 1;
      binding.set(nodeVar, v);

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (a.kind === 'rows') {
          continue;
        }

        const value = a.argFn(env);

        // The same nullish rule as every other fold in this file and in `stepFolded`.
        if (isNullish(value)) {
          continue;
        }

        if (a.kind === 'values') {
          (slot.state[i] as unknown[]).push(value);
        } else {
          slot.state[i] = a.fold.step(slot.state[i], value);
        }
      }
    }

    const rows = slots.map((slot) => {
      const row: Row = {};

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (i === keyAt) {
          row[keyCol] = slot.key;
        } else if (a.kind === 'rows') {
          row[a.out] = slot.n;
        } else if (a.kind === 'values') {
          row[a.out] = aggregateOverValues(a.name, slot.state[i] as unknown[], a.frac);
        } else {
          row[a.out] = a.fold.finish(slot.state[i]);
        }
      }

      return row;
    });

    // One row per GROUP, so this sorts at most what the query returns — the tally's own argument
    // (`sortGroupRows`), and it uses `compareSort` so DESC and NULLS placement match the engine
    // rather than being re-derived here.
    return applySort(rows);
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
  //
  // ITEM 553 SAID THIS RUNG NEEDED THE WALK FORCING AND THAT WAS WRONG — a guess from item 419's
  // rule rather than a reading of the loop below, which iterates
  // `candidateVertexSource(graph, startLabel)` and expands, with no far-driven alternative
  // anywhere. Its visit order is the start side's, which is the general path's. So the only
  // condition is the SEED hazard item 553 demonstrated, and it is the same flag (item 554).
  //
  // The `unfiltered` value itself is computed below, once the keyed end is known: the filter can
  // be written on EITHER end's inline properties or in the clause `WHERE`, and which end is
  // "keyed" decides which of those this rung may even accept.
  const picked = groupedAccs(ret.projection.items, proj.items, null, true);

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
    if (a.kind !== 'rows' && !refsOnlyVar(a.argExpr, keyExpr.variable)) {
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

  const wherePred = keyedClausePred(m.where, keyed.variable);

  if (wherePred === null) {
    return null;
  }

  if (wherePred !== undefined) {
    preds.push(wherePred);
  }

  // THE SEED HAZARD, checked here rather than at the `groupedAccs` call because `preds` is what
  // answers it and `preds` needs the keyed end, which `groupedAccs` is what decides. A FILTERED
  // source may seed from an index in the general path, and then the values reach their group in
  // index order rather than scan order — item 553 demonstrated that on the scan rung with a
  // `collect` that read `[7,5,9]` without an index and `[5,7,9]` with one. This walk always
  // iterates the start side, so it cannot reproduce a seeded order and must decline.
  if (preds.length > 0 && accs.some((a) => a.kind === 'values')) {
    return null;
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
  // Resolved HERE rather than in the gate, because it needs the output columns and the grouping
  // expression. `null` declines the whole rung; otherwise it is the sort to apply, which is the
  // IDENTITY when the query has no `ORDER BY`.
  const applySort = groupedSortApplier(
    ret.projection.orderBy ?? [],
    proj.items.map((i) => i.name),
    keyCol,
    keyExpr,
  );

  if (applySort === null) {
    return null;
  }

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
            state: accs.map((a) => {
              if (a.kind === 'fold') {
                return a.fold.init();
              }

              return a.kind === 'values' ? [] : 0;
            }),
          };
          bySeen.set(id, slot);
          slots.push(slot);
        }

        slot.n += 1;
        binding.set(keyVar, keyedNode);

        for (let i = 0; i < accs.length; i += 1) {
          const a = accs[i];

          if (a.kind === 'rows') {
            continue;
          }

          const value = a.argFn(env);

          if (isNullish(value)) {
            continue;
          }

          if (a.kind === 'values') {
            (slot.state[i] as unknown[]).push(value);
          } else {
            slot.state[i] = a.fold.step(slot.state[i], value);
          }
        }
      }
    }

    const rows = slots.map((slot) => {
      const row: Row = {};

      for (let i = 0; i < accs.length; i += 1) {
        const a = accs[i];

        if (i === keyAt) {
          row[keyCol] = slot.key;
        } else if (a.kind === 'rows') {
          row[a.out] = slot.n;
        } else if (a.kind === 'values') {
          row[a.out] = aggregateOverValues(a.name, slot.state[i] as unknown[], a.frac);
        } else {
          row[a.out] = a.fold.finish(slot.state[i]);
        }
      }

      return row;
    });

    // One row per GROUP, so this sorts at most what the query returns — the tally's own argument
    // (`sortGroupRows`), and it uses `compareSort` so DESC and NULLS placement match the engine
    // rather than being re-derived here.
    return applySort(rows);
  };
};
