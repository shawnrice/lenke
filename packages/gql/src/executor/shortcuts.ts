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
import { candidateCount, candidateVertexSource, matchesLabel } from '../graph-queries.js';
import { countEdges, edgesOfTypes, relTypeNames } from './adjacency.js';
import { relHasPredicate } from './bindings.js';
// The shortcuts read shared primitives + compiled types out of the executor
// trunk, and the trunk imports the two detectors back — a safe function-level
// cycle (resolved lazily at call time), matching the other executor submodules.
import type {
  AggFold,
  CNode,
  CompiledExpr,
  CPredicate,
  CReturnItem,
  EvalEnv,
  Params,
  Row,
} from './core.js';
import { compileExpr, compilePredicate, specializeNarrowPred, percentileFraction } from './core.js';
import { freePredicateVars } from './expr-analysis.js';
import { filteredChainCsrApplies, filteredChainCsrCount } from './filtered-chain-csr.js';
import { plainNode, plainRel, side as hopSide, sideOfVertex } from './hop-sides.js';
import { composeInlineGate, inlineHolds, inlineOf, inlinePredOf, predFor } from './inline-gate.js';
import type { InlineGate, InlinePred } from './inline-gate.js';
import { interiorConstrained, interiorPredOf } from './interior-route-choice.js';
import type { InteriorGates } from './interior-route-choice.js';
import { anyEmptyLabel, effectiveLabel, vacuousLabel } from './labels.js';
import { indexCandidates, seekIsWorthIt } from './matching.js';
import type { SeedCandidate } from './matching.js';
import type { ColSort } from './ordered-rows.js';
import { sortRowsByColumns } from './ordered-rows.js';
import { satisfies } from './predicates.js';
import { foldFor } from './projection.js';
import { columnName, resolveCount, valueKey } from './rows.js';
import { AGGREGATES, asTruth } from './scalars.js';
import { threeHopCsrCount } from './three-hop-degree-product.js';
import { twoHopFilteredCsrApplies, twoHopFilteredCsrCount } from './two-hop-filtered-csr.js';

export type CountFn = (graph: Graph, params: Params) => Row;

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
/**
 * The ONE property key this pred list asserts an equality on and nothing else, or `undefined`.
 *
 * ⚠️ ITEM 1607 — THE EXACTNESS DECISION, and it is a CORRECTNESS gate, not a route choice. If this
 * says `k` and the chosen seed sought on `k`, the seeded set IS the matching set and the
 * re-validation below can be skipped. If it is wrong, rows appear that should not — so unlike items
 * 1600/1601/1604 the mutants here are wrong answers and the differential tests DO see them. It is
 * still extracted and tested directly, because a gate that is only ever exercised through four
 * other conditions is a gate nobody can read.
 *
 * ⚠️ IT IS COMPUTED FROM `preds`, THE THING BEING SKIPPED — not from the `CNode` the seek came
 * from. Item 1597's sketch put an `exact` flag on the candidate, which would have judged a
 * `CNode.pred` and applied the verdict to a separately-built `InlinePred` list. They express the
 * same constraints today; nothing makes them, and a flag that crosses that gap is a wrong answer
 * waiting for the day they drift. So `indexCandidates` reports only what it SOUGHT (`eqKey`) and
 * the verdict is formed here against what is actually held.
 *
 * EXACT means EVERYTHING the list asserts is that one equality:
 *
 *   - exactly one `InlinePred`, with no `bindVar` (a correlated value reads a binding this never
 *     writes — the same condition `fastTallyPred` has);
 *   - its predicate carries exactly one entry, in `props` or `eqProps`, and NOTHING else: no
 *     residual `where`, no second carrier, no unknown carrier. The loop below iterates the keys
 *     PRESENT so a thirteenth carrier added to `CPredicate` REFUSES rather than being ignored —
 *     `specializeSingleProp`'s own structure, for the reason its first version shipped a wrong
 *     answer by missing four.
 *
 * ⚠️ THE NULL CASE IS ALREADY CLOSED, upstream, and that is load-bearing here. `{k: null}` means
 * IS NULL — stored null OR absent key — which a value bucket cannot represent, and item 1605 fixed
 * `indexCandidates` to decline a null-valued seek entirely. So no null seed can reach this verdict,
 * and `eqProps`'s null rejection cannot be skipped either. Had this item shipped first, that bug
 * would have become a wrong answer instead of an under-count.
 *
 * THE LABEL IS NOT COVERED and must still be tested: the index returns vertices by VALUE across all
 * labels, which is the first of the two risks item 149 names.
 */
/**
 * Does this chosen seed make the predicate redundant? The two-line verdict, extracted so it can be
 * tested DIRECTLY (item 1607).
 *
 * ⚠️ IT IS EXTRACTED BECAUSE EVERY MUTANT OF IT SURVIVED INLINE. Dropping the key comparison,
 * accepting any candidate kind, and reporting `eqKey` on a `within` or a `range` candidate all left
 * the suite green — because `soleEqualityKey` is already so narrow that when it answers, the only
 * candidate `indexCandidates` can produce IS the equality on that key. The comparison is therefore
 * REDUNDANT TODAY and load-bearing by design, which item 475 says have opposite fixes: the fix for
 * "redundant" is to pin it where it can be seen, not to delete it.
 *
 * What it guards is the gap the type comment on `SeedCandidate` describes: the candidate is built
 * from a `CNode`'s `pred` and the verdict is applied to a separately-built `InlinePred` list. They
 * agree today and nothing makes them. A seek on `n` must never satisfy a predicate about `team`.
 */
export const seedIsExact = (
  candidate: { eqKey?: string } | undefined,
  soleKey: string | undefined,
): boolean => candidate?.eqKey !== undefined && candidate.eqKey === soleKey;

export const soleEqualityKey = (preds: readonly InlinePred[]): string | undefined => {
  const [sole] = preds;

  if (preds.length !== 1 || sole.bindVar !== undefined) {
    return undefined;
  }

  const { pred } = sole;
  let only: 'props' | 'eqProps' | undefined;

  for (const [carrier, held] of Object.entries(pred)) {
    if (held === undefined || (Array.isArray(held) && held.length === 0)) {
      continue;
    }

    if (
      !Array.isArray(held) ||
      only !== undefined ||
      (carrier !== 'props' && carrier !== 'eqProps')
    ) {
      return undefined;
    }

    only = carrier;
  }

  const entries = only === 'props' ? pred.props : (pred.eqProps ?? []);

  return entries.length === 1 ? entries[0].key : undefined;
};

/**
 * The tally's per-element predicate pre-resolved, or `undefined` to keep the `inlineHolds` loop.
 *
 * ⚠️ TWO `InlinePred`s, NOT ONE, and item 1604 is why. The gate here read `preds.length === 1`, and
 * the ISO spelling of a two-conjunct filter arrives as TWO preds — `inlineOf(start)` carries the
 * inline `{score: $s}` and `nodeWhereOf(where)` carries the lifted `u.active = true` — so the
 * clause spelling (one pred holding `eqProps(2)`) specialized and the inline one did not. Keeping
 * that would have opened an EQUIVALENT-SPELLING GAP on the row that nominated the work, which is
 * the defect class this engine is named after.
 *
 * ⚠️ FOUND BY A TRIPWIRE, not by reading. The width-2 specializer was built, the clause row moved
 * 1.27x and the inline row measured FLAT — and the reason was invisible in the predicate, because
 * the inline form's carriers (`props(1) eqProps(1)`) are exactly what `specializeEqPair` admits.
 * A one-line stderr print of `bindVar` and the live carriers at this call site showed the inline
 * shape never arriving at all. Item 1586's `fused-hits=0` lesson, in a new place.
 *
 * `bindVar` must be absent on EVERY pred, for the reason the single-pred version gave: `inlineHolds`
 * WRITES the binding for a correlated conjunct before testing it, and a specialized closure never
 * writes one.
 *
 * A route choice is ANSWER-EQUIVALENT, so every mutant of it survives the differential tests — hence
 * an exported pure function with its own test (`perf-gate-needs-its-own-test`).
 */
export const fastTallyPred = (
  preds: readonly InlinePred[],
): ((element: Vertex, env: EvalEnv) => boolean) | undefined => {
  if (preds.length === 0 || preds.length > 2) {
    return undefined;
  }

  for (const ip of preds) {
    if (ip.bindVar !== undefined) {
      return undefined;
    }
  }

  const first = specializeNarrowPred(preds[0].pred);

  if (first === undefined || preds.length === 1) {
    return first;
  }

  const second = specializeNarrowPred(preds[1].pred);

  // IN `preds` ORDER, which is the WRITTEN order (inline before clause) and the order the
  // `inlineHolds` loop below iterates — the same property item 1601's `composeInlineGate` keeps,
  // so an inline filter matching nothing still short-circuits a faulting clause `WHERE`.
  return second === undefined
    ? undefined
    : (element, env) => first(element, env) && second(element, env);
};

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

  // ITEM 1338: the per-element predicate PRE-RESOLVED, once per query, for the one shape a
  // filtered count almost always has — a single ordering comparison on one property. `undefined`
  // for everything else, and the loop then calls `inlineHolds` exactly as before.
  //
  // `bindVar` must be absent: it means something in the predicate reads the binding back (item
  // 803), and the fast closure never writes one.
  //
  // ⚠️ MUTATION SAYS THIS GUARD IS UNREACHABLE FROM HERE, and it is kept anyway. Dropping it
  // SURVIVED item 1338's pass and SURVIVED AGAIN at item 1598 — but the REASON changed, and the
  // second reason is the one to keep.
  //
  // Item 1338's reason: `predFor` sets `bindVar` only when `where` is present or `props` is
  // non-empty, and `specializeSingleProp` refused both carriers. Item 1598 admitted `props`, so
  // that half of the argument is gone.
  //
  // What stands in its place: `predFor`'s `props` clause is `!closedProps && props.length > 0`,
  // and EVERY production call site passes `closedProps: true` — nine of them, checked. Closedness
  // is proved UPSTREAM rather than by the flag: `inlinePredOf` and `gateWith` run the
  // `freePredicateVars(c.value).size > 0` loop and return `null` for a correlated `(b {k: a.k})`,
  // so such a predicate never reaches `predFor` at all. A CLOSED `{k: $v}` is therefore the only
  // inline shape that gets here, and it carries no `bindVar`.
  //
  // It stays because the invariant is NOT global, which is the reason it originally stayed: the
  // two-hop middle gate builds an `InlinePred` directly (`{ pred: compilePredicate(...), bindVar }`)
  // with `bindVar` set unconditionally, so a predicate CAN carry one while every carrier the
  // allow-list inspects is empty. Should that construction ever feed this tally, or should a future
  // caller pass `closedProps: false`, this is what keeps a specialized closure from evaluating a
  // correlated value against a binding the tally never wrote — items 121-123's correlation problem.
  // The cost is one comparison PER QUERY, not per element.
  const fastPred = fastTallyPred(preds);
  // Decided ONCE PER QUERY, like `fastPred` and `labelTest`: which single key, if any, the whole
  // pred list asserts an equality on. `undefined` for every other shape, and the seek then
  // re-validates exactly as before.
  const soleKey = soleEqualityKey(preds);

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
    /**
     * ⚠️ ITEM 1608 — REJECTED, WITH ITS NUMBERS, and the reason is CONSISTENCY rather than trust.
     *
     * `effectiveLabel`/`vacuousLabel` (items 1551/1552) drop a label carried by EVERY vertex, and
     * they are used at TEN sites in this file — every one a hop builder. `buildNodeCount` is not
     * among them, so a single-label graph pays a per-candidate label test that is a tautology. That
     * looked like free money, and after item 1607 removed the predicate it is the biggest remaining
     * frame: `evalLabelExpr` 66.3% + `get labels` 4.6% + `matchesLabel` 1.7% = **72.6%**.
     *
     * Built and measured — an asserted A/B over 1000 seeded candidates:
     *
     * ```text
     *    SINGLE label (vacuous: the elision fires)
     *      one-clause      13877 14255 ns  ->  2463 2516      5.6x
     *    MULTI label (NOT vacuous: it cannot fire)
     *      one-clause      13563 14325     -> 14001 14268      flat (CONTROL)
     *      two-clause      36889 37414     -> 36374 38660      flat (CONTROL)
     * ```
     *
     * 5.6x, with the control a fixture the change COULD have reached and provably does not. And it
     * is reverted anyway, because of what it does to a graph written through the RAW `labels`
     * SETTER, which does not maintain `verticesByLabel` (memory's `label-index-vs-setter`, an OPEN
     * owner decision). On ten vertices all labelled `P`, then `v.labels = ['Q']`:
     *
     * ```text
     *    MATCH (n:P) WHERE n.k = $v RETURN count(*)   5     <- with the elision
     *    MATCH (n:P) WHERE n.k = $v RETURN n.k        4 rows
     * ```
     *
     * ⚠️ **TWO SPELLINGS OF ONE QUESTION, DISAGREEING** — the defect class this engine is named
     * after, as a correctness bug rather than a slow path. The ten existing sites do NOT have this
     * problem: measured, a hop count and a hop ROWS query both answer 9 after the same setter write,
     * so they are uniformly elided and agree with each other. Adding an eleventh site here would
     * make the count and the rows spelling of the SAME query disagree, because the rows path
     * (`detectNodeProjection`) does not elide.
     *
     * So the lever is worth 5.6x and its blocker is not the trust question — it is that taking it
     * HERE alone breaks spelling consistency.
     *
     * ⚠️ WHAT IS FASTER ACROSS THE BOARD, asked and measured rather than chosen. The alternative is
     * to fix the raw setter so `verticesByLabel` is never stale, which would make the elision sound
     * everywhere. `label-setter-cost-probe.mjs`, 20,000 vertices:
     *
     * ```text
     *    v.labels = [different]    the raw setter today       35.2  37.1 ns
     *    v.addLabel + removeLabel  the MAINTAINED API        390.6 412.9      ~200 ns a call
     *    v.setProperty             for scale                 121.0 126.6
     * ```
     *
     * So maintaining the index on a label write costs what the maintained API costs — **5.5x the
     * raw setter** — for READ gains identical to the elision's. And it is not a 150 ns patch:
     * `verticesByLabel` holds vertex OBJECTS (so the setter would have to find the canonical
     * instance, since two `Vertex`es can share an id) and `addLabelToVertex` participates in the
     * TX-TOUCHED SET AND THE UNDO LOG. A setter that mutated the buckets without joining that
     * machinery would leave a rolled-back transaction with a stale index — the same bug in a new
     * place. Doing it properly makes the raw setter into `addLabel`.
     *
     * **So the faster answer is the elision, not the setter fix**: all of the read win, no write
     * cost, no new machinery. Its one requirement is UNIFORMITY — this line appears at SEVEN sites
     * in this file and today none of them elides, so the engine is consistent. Eliding at all seven
     * keeps it consistent; eliding at fewer is the count-vs-rows gap above. That is a seven-site
     * edit to hot walks, which `executor-edits-perturb` prices at up to 16% on unrelated rows and
     * therefore wants measured PER SITE — its own item, not the tail of this one.
     *
     * Do not re-derive any of this: the read numbers are above, the write numbers are here, and the
     * measurements are `two-conjunct-seek-probe.mjs` with `MULTI=1` as the control plus
     * `label-setter-cost-probe.mjs`.
     */
    // Whether that seed made the predicate redundant — see `soleEqualityKey` and the assignment
    // below. FALSE on the bucket route, which never seeks.
    let exactSeed = false;

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
        // ITEM 1607: when the seek's equality is EVERYTHING the predicate asserts, the seeded set
        // IS the matching set and re-validating every candidate is pure waste. Ablating that
        // re-validation measured 12766-13279 ns down to 6324-6354 on the 400-hit seeded count —
        // 2.08x — and for an exact seed skipping it is that ablation rather than an approximation
        // of it. The LABEL test below still runs: the index returns vertices by value across all
        // labels.
        exactSeed = seedIsExact(best, soleKey);
      }
    }

    // ONE env for the whole tally, where `satisfies` allocates one per element. Sound because
    // `binding`, `params` and `graph` are fixed for the call — and reachable only from
    // `fastPred`, which never writes the binding.
    const fastEnv = { binding, params, graph };

    const vertices: Iterable<Vertex> =
      seeded ??
      (name === undefined ? graph.verticesById.values() : (graph.verticesByLabel.get(name) ?? []));
    let n = 0;

    // ITEM 1609: the label with a VACUOUS one dropped, resolved ONCE PER CALL. Hoisting is the
    // whole change: with `effectiveLabel` called per ELEMENT the control fixture (a multi-label
    // graph, where it can never elide) measured 1.32x WORSE — 15295 ns against 20207 — while
    // hoisted it is flat. Per EXECUTION, not per compile: universality is a property of the graph
    // (item 1551), so a cached plan cannot carry it.
    const labelEff = effectiveLabel(graph, label);

    for (const v of vertices) {
      // A seek returns vertices by VALUE, not by label, so the label has to be applied here.
      // The bucket path inherits it from the seed and must not pay for it again.
      if (seeded !== undefined && !matchesLabel(v, labelEff)) {
        continue;
      }

      // ITEM 1607: an EXACT seed has already decided the predicate, so every candidate that
      // passes the label test is a match. This is the whole 2.08x — the two arms below are what
      // the ablation removed.
      if (exactSeed) {
        n += 1;

        continue;
      }

      if (fastPred !== undefined) {
        if (fastPred(v, fastEnv)) {
          n += 1;
        }

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
export const chainGatesOf = (
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
export const gateWith = (
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
/**
 * `|union of the named global edge buckets|`, or `undefined` when there are too many names to be
 * worth it.
 *
 * WHY THIS EXISTS BESIDE {@link bucketSumsAreSound} rather than inside it: that rule answers "may I
 * SUM these buckets", and when the answer is no the union is still the right number and still cheap.
 * An edge belongs to exactly one FIRST bucket, so count it where it first appears — bucket 0
 * contributes its `.size` untouched and bucket `i` counts only what no earlier bucket holds. No
 * overlap counter is needed, which is the whole point.
 *
 * ⚠️ SORTED DESCENDING. Bucket 0 is free and later buckets are iterated, so an unsorted walk costs
 * whatever order the query named its types — items 1382 and 1384 each shipped that and measured
 * 3.53x and 1.42x equivalent-spelling gaps before fixing it.
 *
 * ⚠️ THE GREMLIN TWIN IS `unionOfBuckets` in `gremlin/src/executor/count-shortcut.ts`, and these two
 * ARE a deliberate pair of copies — this repo treats the surfaces as parallel implementations
 * sharing only core's data types. **But the order defect above drifted across them and had to be
 * fixed twice, two items apart (1382 then 1384).** If you change one, read the other.
 *
 * Capped for the same reason the Gremlin side is: bucket `i` pays `i` membership tests per edge, so
 * the work is `O(k x |E|)` for `k` types — far under the walk at the two or three a query names, and
 * unmeasured above that.
 */
const UNION_MAX_TYPES = 8;

const globalBucketUnion = (types: readonly string[], graph: Graph): number | undefined => {
  if (types.length === 0 || types.length > UNION_MAX_TYPES) {
    return undefined;
  }

  const buckets: ReadonlySet<Edge>[] = [];

  for (const t of types) {
    const bucket = graph.edgesByLabel.get(t);

    if (bucket !== undefined && bucket.size > 0) {
      buckets.push(bucket);
    }
  }

  if (buckets.length === 0) {
    return 0;
  }

  buckets.sort((x, y) => y.size - x.size);

  let n = buckets[0].size;

  for (let i = 1; i < buckets.length; i += 1) {
    for (const e of buckets[i]) {
      let earlier = false;

      for (let j = 0; j < i; j += 1) {
        if (buckets[j].has(e)) {
          earlier = true;

          break;
        }
      }

      if (!earlier) {
        n += 1;
      }
    }
  }

  return n;
};

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
/**
 * The seed AND the equality key it sought on — item 1610, the input the exactness verdict needs.
 *
 * ⚠️ ONE CHOOSE LOOP, NOT TWO. `hopSeek` below delegates here rather than keeping its own copy:
 * this file's own note records what two copies of one seed rule cost before (the far endpoint on a
 * per-edge tally), and the choosing is the dangerous half of the preamble, not the walk around it.
 * Every existing caller of `hopSeek` is untouched.
 *
 * `eqKey` is a FACT about the chosen candidate, never a verdict — see `SeedCandidate`'s own note on
 * why exactness is decided against the predicate actually held rather than stamped on the seed.
 */
export const hopSeekWithKey = (
  graph: Graph,
  cstart: CNode | undefined,
  pa: LabelExpr | undefined,
  env: EvalEnv,
): { seeded: ReadonlySet<Vertex> | undefined; eqKey: string | undefined } => {
  if (cstart === undefined) {
    return { seeded: undefined, eqKey: undefined };
  }

  let best: SeedCandidate | undefined;

  for (const candidate of indexCandidates(graph, cstart, env)) {
    if (best === undefined || candidate.count < best.count) {
      best = candidate;
    }
  }

  // Same rule as every other seed site (item 409): `< candidateCount` admitted anything
  // narrower than the whole bucket, where the break-even is ~1/8 of it.
  return best !== undefined && seekIsWorthIt(graph, pa, best.count)
    ? { seeded: best.build(), eqKey: best.eqKey }
    : { seeded: undefined, eqKey: undefined };
};

export const hopSeek = (
  graph: Graph,
  cstart: CNode | undefined,
  pa: LabelExpr | undefined,
  env: EvalEnv,
): ReadonlySet<Vertex> | undefined => hopSeekWithKey(graph, cstart, pa, env).seeded;

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
 *
 * ⚠️ REJECTED LEVER — "the far walk is ~4x its start twin" (item 1263). A filtered hop count read
 * 46.1 ms filtering the far end against 10.7 ms filtering the start, at 200k nodes / 800k edges,
 * which looked like this function still owing what item 137 paid its twin. It owes nothing: the
 * two bodies are already identical, and the gap is MEMORY LOCALITY in the fixture.
 *
 * The route was verified before the time was trusted (items 1185, 1242, 1260), without
 * instrumenting: a predicate that keeps NOTHING costs a vertex walk 200k visits and an edge scan
 * 800k, and BOTH ends read 4.1-4.6 ms — ~20ns a vertex, matching item 164's 29ns. So this walk is
 * running, and the whole gap is in the survivor degree sum: 200k identical `degreeOfTypes` calls,
 * 6.1 ms through `adjFrom` against 42.0 ms through `adjTo`.
 *
 * Not caching, which both accessors do alike (`Vertex.adjFrom`/`adjTo`, `??=`). The fixture built
 * edges with `from = k % N` (sequential) and `to = (k * 7919) % N` (a permutation), so the reverse
 * index's `Set` objects were ALLOCATED in scrambled order and reading `.size` is a pointer chase
 * to a random address — which survives caching the box, because the box is not what is scattered.
 *
 * The control: ingest the SAME graph with the edge list sorted by TARGET. The asymmetry FLIPS,
 * cleanly, which no code-side cause can produce:
 *
 * ```text
 *                      far filter   start filter
 *   edges in SOURCE order   45.4 ms      10.3
 *   edges in TARGET order   13.7         44.5
 * ```
 *
 * So there is nothing here to make faster, and a future reading of "the far side is slower" is
 * this fixture. The question worth asking instead is whether the scattered `Set` is worth
 * replacing with a per-vertex count, which is a STORAGE change and not a change to this walk.
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
export const alwaysTrue = (): true => true;

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

    // THE UNION, where the sum above is unsound (item 1386). Overlapping buckets cannot be SUMMED,
    // but they can still be counted: `-[:E|F]->` was **5.96 ms** against `-[:E]->`'s 0.003 purely
    // because this fell through to the deduping walk.
    if (a === undefined && b === undefined && types !== undefined) {
      const union = globalBucketUnion(types, graph);

      if (union !== undefined) {
        return rowOf(union);
      }
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
  const n = hopSide(graph, bId, true, types, far) + hopSide(graph, bId, false, types, far);

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

  /**
   * ⚠️ THE FLAT-ARRAY ARM (item 1690), priced at 51.05x / 30.19x warm and 1.73x / 1.89x with the
   * whole O(V+E) CSR build inside the timed region. Each clause's reason lives on
   * `twoHopFilteredCsrApplies`, a pure function with its own test, precisely so a wrongly TIGHTENED
   * clause — which silently abandons the arm rather than returning a wrong count — is caught.
   *
   * Both filtered two-hop shapes land here, the END-filtered one included, because the pattern is
   * oriented so the predicate-carrying node becomes the start. A route counter established that;
   * reading the code had suggested the end filter fell to the general pipeline.
   */
  if (
    twoHopFilteredCsrApplies({
      firstBoth,
      secondBoth,
      cEff,
      seeded: seeded !== undefined,
      predReadsOnlyStart:
        pred === undefined || (pred.farVar === undefined && pred.relVar === undefined),
    })
  ) {
    return twoHopFilteredCsrCount(graph, params, {
      aLabel,
      midEff,
      firstOut,
      t1,
      fromCOut,
      t2,
      inStart,
      accept:
        pred === undefined
          ? undefined
          : (a) => {
              if (startVar !== undefined) {
                binding.set(startVar, a);
              }

              return asTruth(pred.fn(env)) === true;
            },
    });
  }

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
          : hopSide(graph, firstOut ? e.toId : e.fromId, fromCOut, t2, cEff);

        continue;
      }

      const b = firstOut ? e.to : e.from;

      if (!matchesLabel(b, midEff)) {
        continue;
      }

      count += secondBoth
        ? undirectedSide(graph, b.id, t2, cEff, loop2)
        : hopSide(graph, b.id, fromCOut, t2, cEff);
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
    secondBoth
      ? undirectedSide(graph, id, t2, cEff, loop2)
      : hopSide(graph, id, fromCOut, t2, cEff);
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
/**
 * THE DEGREE PRODUCT OVER FLAT ARRAYS — {@link buildThreeHopCount}'s fast arm (item 1685).
 *
 * ⚠️ ITS OWN FUNCTION BECAUSE THE CALLER SITS ON THE COMPLEXITY BUDGET, which is this file's
 * standing precedent (`hopChainShape`, and `hopChainCount`'s own note). Inlined it took
 * `buildThreeHopCount` to 47 against a maximum of 35.
 *
 * The arithmetic is the caller's, unchanged: `sum over b of indeg(b) * sum over (b->c) of outdeg(c)`.
 * What changes is where each degree comes from — `off[s + 1] - off[s]` on a `topologyVersion`-keyed
 * CSR instead of a string-keyed `edgesFromByLabel.get(id)`, which item 1684 counted at |V| + |E|
 * lookups for this shape and measured at 242.94x / 297.93x / 278.24x (fanout 3 / 8 / 15), or
 * 4.76x / 4.38x / 3.76x with the whole CSR build inside the timed region.
 *
 * ⚠️ NOT THE LEVER ITEMS 1335 AND 310 REFUTED AT THIS LOOP. Item 1335 read `b`'s own adjacency box
 * instead of the id string (0.99x); item 310 memoized the `d`-side degree per `c` (rejected on
 * alternated rounds). Both keep a HASH LOOKUP per unit. This replaces it with an index.
 *
 * The three CSRs are keyed `(direction, types)` independently, so the legs may differ in both — and
 * they share one slot numbering because every CSR numbers by `verticesById` order.
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

  // `composeInlineGate` directly: the local alias this used to go through captured nothing from
  // its enclosing scope, so it was rebuilt on every call to buy a shorter name.
  const bGate = composeInlineGate(interior.b);
  const cGate = composeInlineGate(interior.c);

  return (graph, params) => {
    // The same guard on the three-hop shape, for the same reason (item 1552).
    if (anyEmptyLabel(graph, [aLabel, bLabel, cLabel, dLabel])) {
      return rowOf(0);
    }

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
      : (g: Graph, id: string): number => hopSide(g, id, fromDOut, t3, dEff);
    // The `c` VERTEX has to be resolved when anything reads it — its label or its gate. With
    // neither, the edge's stored ID is all the `d` side needs (items 140, 218).
    const needsC = cEff !== undefined || cGate !== undefined;
    const binding = new Map<string, unknown>();
    /**
     * ⚠️ THE SAME ARITHMETIC OVER FLAT ARRAYS (item 1685). This route is a degree product —
     * `count = sum over b of indeg(b) * sum over (b->c) of outdeg(c)` — and it pays a STRING-KEYED
     * `edgesFromByLabel.get(id)` for each of those degrees: one per VERTEX for the `a` side and one
     * per MIDDLE EDGE for the `d` side, which item 1684 counted as |V| + |E| lookups. Over a
     * `topologyVersion`-keyed CSR each becomes one `Int32Array` read at the same complexity.
     *
     * Item 1684 measured 242.94x / 297.93x / 278.24x against this loop at fanout 3 / 8 / 15, and
     * 4.76x / 4.38x / 3.76x with the whole CSR build inside the timed region — so it wins on a cold
     * first call too, and the ratio holds across fanout because the complexity matches.
     *
     * ⚠️ NOT THE LEVER ITEMS 1335 AND 310 REFUTED AT THIS EXACT LOOP. Item 1335 replaced the
     * id-string lookup with `b`'s own box read (0.99x) and item 310 memoized the `d`-side degree per
     * `c` (rejected on alternated rounds). Both keep a HASH LOOKUP per unit; this replaces it with an
     * index, which is a different operation rather than a cheaper route to the same one.
     *
     * ⚠️ THE GUARDS ARE NARROW ON PURPOSE, because a degree array cannot express any of what they
     * exclude:
     *
     *   - every leg DIRECTED: an undirected leg is `undirectedSide`'s sum of two buckets minus the
     *     self-loops counted twice, which item 1097 fixed a half-answer bug in. Not a `len[]`.
     *   - no EFFECTIVE label at `a`, `c` or `d`: a label-filtered degree counts only edges whose far
     *     endpoint carries it, where `len[]` counts them all. (A VACUOUS label is already
     *     `undefined` here, so `(a:Person)` on an all-Person graph still takes this path.)
     *   - no `b` or `c` GATE: both are predicates over a vertex the array has reduced to a number.
     *
     * `bLabel` is the one constraint that survives, because it only narrows which `b` slots are
     * visited and `verticesByLabel` still supplies them.
     */
    // ⚠️ THE FLAT-ARRAY DEGREE PRODUCT (item 1685), when every leg is directed and nothing
    // constrains a position the arm reduces to a number. Each clause's reason lives on
    // `csrDegreeProductApplies`, which is a pure function with its own test precisely so a wrongly
    // TIGHTENED clause — which silently abandons the arm rather than returning a wrong count — is
    // caught. `bLabel` survives because it only narrows which `b` the walk visits.

    /**
     * ⚠️ THE FLAT-ARRAY ARMS (items 1685 and 1689), behind one dispatcher. Each clause's reason
     * lives on the predicate it belongs to in `three-hop-degree-product.ts` — pure functions with
     * their own tests, precisely so a wrongly TIGHTENED clause, which silently abandons the arm
     * rather than returning a wrong count, is caught.
     *
     * The split between them: a constraint on `b` or `c` says which VERTICES are accepted and is a
     * mask over the shared slot numbering; a label at `a` or `d` says which edges a DEGREE may
     * count, which a flat array cannot express. So the gated arm takes `cEff`, `cGate` and `bGate`,
     * and `aEff`, `dEff` and every undirected leg still fall through to the walk below.
     *
     * Item 1689's row is the one the `needsC` loop gates ONCE PER MIDDLE EDGE: 526.8 ms against the
     * same question's start- and end-filtered twins at 10.3 and 21.5 after item 1688.
     */
    const viaCsr = threeHopCsrCount(
      graph,
      bLabel,
      { toAOut, t1, midOut, t2, fromDOut, t3 },
      { aBoth, midBoth, dBoth, aEff, cEff, dEff, cGate, bGate, params },
    );

    if (viaCsr !== undefined) {
      return rowOf(viaCsr);
    }

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
      //
      // ❌ REJECTED LEVER, with its numbers (item 1335): reading `b`'s OWN adjacency box here —
      // `sideOfVertex(b, toAOut, t1, aEff)` — instead of the id-string lookup. That is item 1334's
      // lever, and it is worth 1.92x on this loop's UNFILTERED twin, where two such lookups per
      // middle ARE the whole loop body. Here it bought nothing: at 200,000 vertices and degree 3,
      // `WHERE b.age > 45`, three processes each —
      //
      //     id-string lookup   24.15 / 25.44 / 25.50 ms   median 25.44
      //     vertex box read    25.68 / 26.57 / 25.61      median 25.68   0.99x
      //
      // with the unfiltered shape flat beside it as the control. The condition item 355 names
      // (each `b` visited exactly once) DOES hold here, so the memo is available — it simply has
      // nothing to save against this loop's real work: a gate evaluation and an inner per-edge
      // walk amortize the one lookup away. The lever is sound and the ratio is the amortization,
      // which is why it has to be measured per loop rather than inferred from 1334.
      const waysToA = aBoth
        ? undirectedSide(graph, b.id, t1, aEff, aLoops)
        : hopSide(graph, b.id, toAOut, t1, aEff);

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
  const gate = composeInlineGate(midPreds);

  return (graph, params) => {
    // Once per execution and before the driver set is even built: a label no vertex carries makes
    // the whole chain empty. The middle gets this free from an empty driver; the ends are the
    // filters that would otherwise sweep the graph to discover nothing (item 1552).
    if (anyEmptyLabel(graph, [aLabel, cLabel, midLabel])) {
      return rowOf(0);
    }

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

      // ITEM 1334: the DIRECTED arms read the middle's OWN adjacency box rather than looking it
      // up by id string. `hopSide(graph, b.id, …)` does `edgesFromByLabel.get(bId)` — a string-keyed
      // `Map.get`, ~190 ns by item 194's measurement — and this loop calls it TWICE per middle, so
      // an unfiltered two-hop count over 200,000 middles pays 400,000 string hashes.
      //
      // `Vertex.adjFrom` is a LAZY MEMO over exactly that lookup (`#adjFrom ??= graph
      // .edgesFromByLabel.get(this.id)`), so the first access costs what `side` costs and every
      // later one is a private-field read. The memo lives on the vertex and survives across
      // queries until an adjacency write clears it, which makes this free on a cold graph and a
      // saving on every repeat.
      //
      // ⚠️ `twoHopSide`'s own header records the box read as MEASURED FLAT (369.9/384.4/367.7
      // against 384.1/364.2/372.0) and that is NOT a contradiction: there the middle is revisited
      // once per incoming EDGE, so the box is already warm within one query and the memo has
      // nothing left to save. Here each middle is visited EXACTLY ONCE per query, which is the
      // condition item 355 names.
      //
      // The `both` arms are left on `undirectedSide` deliberately: they are a different shape
      // (two sides plus a loop correction) and have not been measured here.
      const ways = aBoth
        ? undirectedSide(graph, b.id, t1, aEff, aLoops)
        : sideOfVertex(b, toAOut, t1, aEff);

      if (ways === 0) {
        continue;
      }

      count +=
        ways *
        (cBoth
          ? undirectedSide(graph, b.id, t2, cEff, cLoops)
          : sideOfVertex(b, fromCOut, t2, cEff));
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
/**
 * Is this pattern's START pinned to a handful of elements by an id seed?
 *
 * Item 1329. `patternCountOf` sends a THREE-segment count to `sweepChain` before anything else
 * gets a say, because the sweep is the only route that can carry an END constraint (item 306).
 * That is right for an end-gated chain and wrong when the START is pinned: the sweep walks the
 * whole graph to answer a question about one vertex.
 *
 * Measured at 200,000 vertices, `MATCH (a:P)-[:E]->(b)-[:E]->(c)-[:E]->(d) … RETURN count(*)`:
 *
 *     WHERE element_id(a) = $id          13.0146 ms   the sweep
 *     WHERE element_id(a) IN [3 ids]     12.7397      the sweep
 *     the same at TWO segments             0.0084      seeded, no sweep
 *     the same returning ROWS              0.0314      seeded enumeration
 *     the same as count(d.k)               0.0538      fires NO rung at all
 *
 * 1550x against the two-segment form, and the cliff is at 3+ segments. It hits the SINGLE-id seed
 * (item 618) as much as item 1315's id list, so it long predates both.
 *
 * DECLINING IS ANSWER-SAFE BY CONSTRUCTION, which is the whole argument: this file's own contract
 * is that "a fast path is a performance decision, never a semantic one", so refusing one falls to
 * the general matcher — the oracle every rung here is checked against. And the fallback is not a
 * guess: `count(d.k)` already fires no rung and answers the same question 247x faster, so the
 * route being declined to is measured, not hoped for.
 */
export const startIsPinnedById = (cstart: CNode | undefined): boolean =>
  cstart?.seedHints?.some((h) => h.kind === 'id' || h.kind === 'idIn') ?? false;

/**
 * The segment count the SWEEP rungs are allowed to see: the real count, or 0 when the start is
 * pinned and the sweep must be declined.
 *
 * This exists to hold `patternCountOf`'s complexity at its budget (35). Spelling the guard inline
 * at both rungs read better and cost two decision points, which took the function to 37 — so the
 * decision moves here and the call sites spend none. A guard that cannot be added without
 * breaking the budget is a signal about the function, not about the guard.
 */
const sweepableSegmentCount = (segments: readonly unknown[], cstart: CNode | undefined): number =>
  startIsPinnedById(cstart) ? 0 : segments.length;

export const patternCountOf = <T>(
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
  //
  // NOT WHEN THE START IS PINNED BY AN ID SEED (item 1329): the sweep walks the whole graph, and
  // for a start pinned to a handful of elements that is 1550x the two-segment form of the same
  // question. See {@link startIsPinnedById}.
  if (sweepableSegmentCount(segments, cstart) === 3) {
    const swept = endGatedChainCount(start, segments, where, rowOf, cstart);

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
  // THREE-segment interior gates, bucketed by the position each conjunct reads.
  // `null` means a conjunct names something this shape cannot gate, which declines.
  let interiorPred: InteriorGates | null | undefined;

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
    //
    // ⚠️ NOW PRICED (item 1515), which is what "open rather than guessed at" was waiting for. The
    // four spellings of the two-segment count, TS engine, `BENCH_ONLY` so each is its own process,
    // at BENCH_N=200,000:
    //
    //     count 2-hop                 51.4 ms    the degree product — no edge pass at all
    //     count 2-hop + mid filter    31.6        the product, gated once per middle — FASTER
    //     count 2-hop + start filter 141.4        2.75x the bare product
    //     count 2-hop + end filter   132.4        2.58x the bare product  <- this comment's shape
    //
    // So a STRICTLY MORE SELECTIVE query costs up to 1.96x, which is the equivalent-spelling
    // failure family this engine is named for — except these are not equivalent spellings, they
    // are a query and a narrowing of it, and the narrowing is the slow one.
    //
    // ⚠️ THE START CASE IS NOT A DEFECT AND SHOULD NOT BE CHASED WITH IT. The bare product is O(V)
    // arithmetic over middles and touches no edge; any start-gated form has to enumerate a→b, so
    // 51.4 → 141.4 is "an edge pass against no edge pass" and is inherent.
    //
    // ⚠️ AND THE END IS NOT A SEPARATE COST CLASS — item 1515 claimed it was, from end (100.0)
    // measuring WORSE than start (88.5), and item 1516 refuted that by fixing the fixture: the
    // numbers above are the corrected ones and the sign is REVERSED (start 141.4 > end 132.4). An
    // end predicate becomes the start of the REVERSED pattern (`reversedTwoHop`), so the two are
    // one algorithm in two directions and the old 11.5 ms gap was the degenerate fixture's
    // forward/reverse asymmetry, not a route doing extra work.
    //
    // What makes the 2-vs-3 split real is that it SURVIVED the fixture fix: at two segments a filter
    // COSTS 2.58-2.75x, at three it SAVES ~1.3x (475.3 bare against 363.8/369.2 gated). Two
    // segments is the only arity whose unfiltered form touches no edge, so it is the only one a
    // gate can make worse.
    //
    // ⚠️ BUT THE FORMULA IS NOT THE ANSWER — BUILT AND REFUTED AT ITEM 1517, and the sentence above
    // about "a different cost class" is exactly why. It was implemented properly: `sideOfVertexGated`
    // as the second factor, both the clause and inline spellings routed in, answers verified against
    // brute force and `bun run fuzz` 20/0 green. It measures **265.5 ms against the reversed walk's
    // 132.4 — 2.0x WORSE** (the other three rows of the family moved not at all, so the arm was what
    // ran).
    //
    // The reason is selectivity, and it is structural rather than a tuning problem. The formula
    // evaluates `p` once per EDGE — 1,000,000 endpoint resolves plus 1,000,000 predicate calls at
    // this fixture — while the reversed walk evaluates it once per end VERTEX (200,000) and then
    // expands only the ~32% that pass. **The walk is selectivity-aware and the formula cannot be**:
    // there is no way to enumerate "edges whose target passes p" without either visiting every edge
    // or starting from the targets, and starting from the targets IS the reversed walk. Caching the
    // passing vertices in a set first does not help — it replaces the predicate call but keeps all
    // 1,000,000 endpoint resolves.
    //
    // So the 2.58x stands as a real cost with no known cure on this route, and the next idea needs
    // to attack the degree product's start factor rather than its end factor.
    //
    // Not built here: a new count route is 100-300x territory, so it needs the byte-identity
    // fuzzers and a mutation pass, not the tail of a measuring tick.
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
    return threeSegmentRoute(start, segments, rowOf, interiorPred, where, cstart);
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
  // ⚠️ THE 3-HOP HALF OF THAT IS STALE — re-measured at item 1592, and the product's 1.50x win is
  // GONE. Degree is the axis item 301 could not vary (a product's cost grows with degree, a
  // sweep's is O(E) per pass and flat in it), and at 200,000 vertices:
  //
  //   depth 3, degree 3   product 321.975ms   sweep 315.117ms   TIE (1.02x)
  //   depth 3, degree 5   product 458.477     sweep 410.423     sweep 1.12x
  //   depth 3, degree 8   product 610.077     sweep 531.207     sweep 1.15x
  //
  // and at degree 8 over three tight non-overlapping rounds, sweep 1.20x on medians / 1.35x on
  // minima. So the sweep is never slower at three segments and improves with degree.
  //
  // ⚠️ THE ROUTING STILL DID NOT MOVE, and the reason is a correctness gap rather than a cost one:
  // routed sweep-first, the gql suite went 4028/10 with every failure an INLINE-gated three-hop
  // count (item 456's tests among them). `longChainCount` ACCEPTS those shapes and then ignores
  // the constraint — it takes `clauseGates` for the clause-`WHERE` spelling but nothing for an
  // inline one, so `(x {k: 0})` silently stops filtering. The product is here partly BECAUSE it
  // gates those positions once per visit (item 219).
  //
  // To move this: teach the sweep inline node constraints, re-measure, then route by degree. Not a
  // one-line reroute. The TWO-segment case should be left alone regardless — at 52.7 ms for
  // 1,000,000 edges it already runs at the sweep's own per-pass rate, so two passes would lose.
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
  if (sweepableSegmentCount(segments, cstart) >= 4) {
    // A PINNED START DECLINES HERE TOO (item 1329). This is the SECOND route to the sweep:
    // the three-segment branch above reaches it through `endGatedChainCount`, and four-or-more
    // segments reach it here through `longChainCount`. Guarding only the first left a pinned
    // 5-hop count at 12.6682 ms while the 3-hop it had just fixed read 0.0358 — found by
    // instrumenting which rung fired at each depth rather than assuming one guard covered the
    // family.
    //
    // A clause `WHERE` is split across positions (item 305). `null` means one of its conjuncts is
    // not a per-vertex test on a position — a correlation, a constant, or a name this pattern does
    // not bind — and the whole family declines, as it did for every clause `WHERE` before.
    const clauseGates = where === undefined ? undefined : chainGatesOf(where, start, segments);

    if (clauseGates === null) {
      return null;
    }

    return longChainCount(start, segments, rowOf, clauseGates, cstart);
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
  /** Forwarded to the sweep so it can seed its start set from an index (item 1330). */
  cstart?: CNode,
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
  return longChainCount(start, segments, rowOf, clauses ?? undefined, cstart);
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
  interiorPred: InteriorGates | null | undefined,
  /** The clause `WHERE`, so the SWEEP can be given its gates (item 1705). */
  where: Expr | undefined,
  /** Carried only so the sweep can seed its start set from an index (item 1330). */
  cstart: CNode | undefined,
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

  /**
   * ⚠️ THE SWEEP IS GIVEN THE CLAUSE'S GATES (item 1705), AND THAT IS THE WHOLE FIX. This used to
   * read `if (product === null || interiorPred !== undefined || !labelled) return product;` — so
   * ANY clause `WHERE` skipped the sweep, because the call below passed no gates and sweeping would
   * have silently dropped the predicate. Its comment said exactly that, and it was true of the call
   * rather than of the sweep: `longChainCount` has taken `clauseGates` since item 305, which is how
   * the four-or-more-segment branch sweeps a clause correctly.
   *
   * What that cost: once the CSR arms decline — which they do whenever the start label is NOT
   * VACUOUS, since a label-filtered degree is not an `off` delta — `product` is `null` and the
   * three-segment branch returns unconditionally, so a clause-filtered count fell to the general row
   * pipeline while its INLINE twin swept. Item 1703 measured 35x-44x for four edgeless vertices
   * under another label, and item 1704's route counters located it here.
   *
   * `chainGatesOf` returns `null` when a conjunct is not a per-vertex test on a position — a
   * correlation, a constant, or an unbound name — and THAT is the case the sweep genuinely cannot
   * take, so it is the only one that still skips.
   *
   * ⚠️ AND THAT NULL CHECK IS UNREACHABLE TODAY, which a mutation pass established rather than a
   * reading: removing it SURVIVES the whole suite. `patternCountOf` returns `null` at
   * `interiorPred === null` BEFORE calling this, and `interiorPredOf` declines any conjunct that is
   * not a per-vertex test on `b` or `c` — a stricter rule than `chainGatesOf`'s. So inside this
   * function `where !== undefined` implies `gates !== null`. It is kept as the honest statement of
   * what the sweep requires, not as a live branch; if the interior reader is ever widened to admit
   * the ends, this is the check that must already be here.
   */
  const gates = where === undefined ? undefined : chainGatesOf(where, start, segments);
  const swept =
    labelled && gates !== null ? longChainCount(start, segments, rowOf, gates, cstart) : null;

  // The product declining is no longer the end of the road: the sweep may still answer.
  if (product === null) {
    return swept;
  }

  if (swept === null) {
    return product;
  }

  // ⚠️ AN INTERIOR CONSTRAINT PREFERS THE SWEEP — a SHAPE test, not the label one below. Numbers
  // and reasons on `interiorConstrained` (item 1708); its own module because of this file's cap.
  if (interiorConstrained(segments, interiorPred)) {
    return swept;
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
  /**
   * The compiled START node, carried ONLY so the sweep can seed its start set from an index
   * (item 1330). It is not consulted for anything else, and when the seek is not worth making
   * the sweep enumerates the label bucket exactly as before.
   */
  cstart?: CNode,
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

    // A SEEDED START AND A FLIPPED READING CANNOT CO-OCCUR, so this is unconditional and the
    // `pick === forward` guard it replaced was DEAD CODE. The proof is two lines above and one
    // below: `labelMayFlip` requires `allGates[0] === undefined` — no constraint on the start —
    // while `sweepStartSeed` returns a set only when the start HAS one, inline or clause. So
    // `reversed` is `undefined` exactly when a seed is possible, and `pick` is already `forward`.
    //
    // Found by mutation, not by reading: `seeds-flipped-reading-too` survived three passes, which
    // looked like a coverage gap and was twice treated as one. It is answer-equivalent in every
    // REACHABLE state, so no test can kill it. Confirmed by making the impossible state throw and
    // running the suite — 3,390 tests over 207 files, no throw — before deleting the branch.
    //
    // The guard's reasoning was still right and is kept, because it becomes live the moment the
    // flip is priced: `pick` chooses by comparing LABEL BUCKET sizes, which knows nothing about
    // how selective a seed would be. Items 172 and 173 are that same mistake one family along,
    // where `orient` reversed away from a selective start. Anyone making the flip seed-aware must
    // re-introduce a guard here, or seed a reading that was chosen for the wrong reason.
    const startSource = sweepStartSeed(graph, params, cstart, pick.startLabel);

    // ⚠️ THE FLAT-ARRAY ARM (item 1688), priced by item 1687 at 92.27x / 66.87x warm and ~3.6x with
    // the CSR build inside the timed region. Every position's constraint becomes a per-slot mask, so
    // one arm serves a start, interior or end filter; `filteredChainCsrApplies` carries the two
    // exclusions and their reasons — an undirected leg, and a query an index already seeded, where
    // the arm's O(V) masks would throw away a sub-linear seek. Falls through to the sweep otherwise
    // — and in particular
    // this does NOT relax `sweepChain`'s own `passes > 2` memo gate, which item 1683 did on an
    // assumption and had to revert.
    if (filteredChainCsrApplies(pick.legs, startSource !== undefined)) {
      // No `startSource`: the predicate above refuses a seeded query, so the arm has no seed path.
      return rowOf(filteredChainCsrCount({ graph, params, ...pick }));
    }

    return rowOf(sweepChain({ graph, params, ...pick, startSource }));
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
  /**
   * The START set, when an index seek beat the label bucket (item 1330). `undefined` means the
   * sweep enumerates the bucket exactly as it always has, so the unindexed path is untouched.
   */
  startSource?: ReadonlySet<Vertex>;
};

/**
 * Item 1330: the sweep's START source — an index seek when one is available AND selective, else
 * `undefined` so the caller keeps the label bucket.
 *
 * The depth ladder that found this: an INDEXED `a.k = 7` start is seeded at 0, 1 and 2 hops
 * (0.005-0.007 ms at 200,000 vertices) and then costs 5.63 ms at three and 5.73 at four, because
 * the chain rungs hand the whole label bucket to the sweep and let `startGate` filter it. The id
 * pin reads 0.038 at the same depth.
 *
 * WHY THIS IS A RUN-TIME DECISION AND NOT A COMPILE-TIME DECLINE. Item 1329 fixed the id-pinned
 * twin by declining the rung outright, which works because an id hint is selective on every
 * graph. A property hint is not: whether `k` is indexed is a property of the GRAPH, and plans are
 * cached across graphs, so a compile-time decline would have to assume. Measured what assuming
 * costs — admitting `eq` to item 1329's pin and declining unconditionally:
 *
 *     prop3 with an index      5.4341 -> 0.0380 ms   143x FASTER
 *     prop3 with NO index      5.6257 -> 16.5443      0.34x, a 2.9x REGRESSION
 *
 * So the indexed column alone would have shipped a regression. Seeding the sweep instead keeps
 * both: a seek when there is one to make, and byte-for-byte today's enumeration when there is not.
 *
 * `seedVertices` is not used despite doing the same choosing, for the reason recorded at the
 * `seeded` site above: it hides WHETHER it seeded, and here the difference is exactly what the
 * caller needs. The ceiling itself is NOT duplicated — `seekIsWorthIt` is the shared rule, which
 * is what item 407's drift was about.
 */
const sweepStartSeed = (
  graph: Graph,
  params: Params,
  cstart: CNode | undefined,
  startLabel: LabelExpr | undefined,
): ReadonlySet<Vertex> | undefined => {
  if (cstart === undefined) {
    return undefined;
  }

  const env: EvalEnv = { binding: new Map(), params, graph };
  let best: SeedCandidate | undefined;

  for (const candidate of indexCandidates(graph, cstart, env)) {
    if (!best || candidate.count < best.count) {
      best = candidate;
    }
  }

  if (!best || !seekIsWorthIt(graph, startLabel, best.count)) {
    return undefined;
  }

  return best.build();
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
const sweepSlotCached = (st: SweepState, leg: Leg, memo: SlotMemo): void => {
  const { cache, cached, idOf, slotOf, frontier, nextFrontier } = st;
  const { out } = leg;
  // Reused across slots, so the walk allocates one `Int32Array` per slot and nothing else.
  const scratch: number[] = [];

  for (const slot of frontier) {
    // Nonzero by construction — a slot joins a frontier only on its 0 -> w transition.
    const w = st.ways[slot];
    const n0 = memo.len[slot];

    if (n0 !== undefined) {
      // A CONTIGUOUS RUN of the one buffer, not a per-slot array: an index walk rather than a
      // pointer chase, and the whole memo is one allocation instead of ~100,000.
      const base = memo.off[slot];
      const { flat } = memo;

      for (let i = 0; i < n0; i += 1) {
        const to = flat[base + i];

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

    // APPENDED TO THE ONE BUFFER (item 1418), where item 1417 built a per-slot `Int32Array` here.
    // The hand copy it introduced stays — `Int32Array.from` went through the iterator protocol and
    // measured 4.85x slower over 100,000 small arrays — it just writes into a shared run now.
    const n = scratch.length;

    memoReserve(memo, n);

    const base = memo.used;

    for (let i = 0; i < n; i += 1) {
      memo.flat[base + i] = scratch[i];
    }

    memo.used = base + n;
    memo.off[slot] = base;
    memo.len[slot] = n;
  }
};

/**
 * THE REMEMBERED FAR SLOTS, FLAT (item 1418).
 *
 * Item 1106 held this as one `Int32Array` per slot. That is ~100,000 typed arrays on a 4-hop chain
 * over 100,000 vertices, every one of them RETAINED for the whole query — so they are promoted
 * rather than collected cheaply, and `chain4`'s profile still showed the garbage collector at
 * **14.2%** after item 1417 removed the `Int32Array.from` from building them.
 *
 * So: ONE growable buffer, with each slot's run recorded as an offset and a length. No per-slot
 * object exists at all, and the replay pass reads a contiguous run instead of chasing a pointer per
 * slot.
 *
 * `len[slot] === undefined` is "not resolved yet" — the same sentinel the array-of-arrays used, kept
 * so the branch in the walk is unchanged.
 */
export type SlotMemo = {
  flat: Int32Array;
  used: number;
  readonly off: number[];
  readonly len: number[];
};

/**
 * Room for `need` more entries, doubling as needed.
 *
 * ⚠️ EXPORTED FOR ITS OWN UNIT TEST, which is the only thing that guards it (item 1418).
 *
 * Five mutants were run against this memo's offset arithmetic and four were caught by the query
 * suite. The fifth — `grown.set(m.flat.subarray(0, m.used))` shortened by one — SURVIVED every
 * black-box attempt: a 4,096-slot fixture (growth fires 3 times, verified by counter), a cycle, a
 * path with sinks, and an out-degree-2 graph. Its effect is confined to a couple of entries whose
 * read depends on frontier ordering, so no query shape reached it.
 *
 * Two theories were wrong along the way, each refuted by a counter rather than by argument: that the
 * fixtures were too small to grow the buffer (growth ran 3 times), and that a path never reads the
 * memo back (it reads it 8,189 times).
 *
 * So the guard is a DIRECT test of the arithmetic, which is this repo's recorded answer to a mutant
 * the differential tests cannot see: extract the arithmetic as a pure function and unit-test it.
 * `memo-reserve.test.ts` asserts every previously written entry survives each growth.
 */
export const memoReserve = (m: SlotMemo, need: number): void => {
  if (m.used + need <= m.flat.length) {
    return;
  }

  let cap = m.flat.length === 0 ? 1024 : m.flat.length;

  while (cap < m.used + need) {
    cap *= 2;
  }

  const grown = new Int32Array(cap);

  grown.set(m.flat.subarray(0, m.used));
  m.flat = grown;
};

/** Do two legs accept the same edge types? `undefined` is "any type" and matches only itself. */
const sameLegTypes = (a: string[] | undefined, b: string[] | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && a.every((t, i) => t === b[i]);

const sweepChain = ({ graph, params, legs, startLabel, startGate, startSource }: Sweep): number => {
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

  for (const v of startSource ?? candidateVertexSource(graph, startLabel)) {
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
  const slotNbrs: SlotMemo | undefined =
    uniform &&
    passes > 2 &&
    legs.every(
      (l) =>
        sameLegTypes(l.types, legs[0].types) &&
        l.gate === undefined &&
        effectiveLabel(graph, l.label) === undefined,
    )
      ? { flat: new Int32Array(0), used: 0, off: [], len: [] }
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
  // This read `hopSide(…, last.out, …)` and the per-leg direction loop above does not reach here —
  // the last position is answered by a weighted sum of degrees rather than by a pass. So an
  // undirected chain counted ONE direction at its final hop and answered EXACTLY HALF: two
  // existing tests from item 484 caught it at 8 against 16 and 0 against 1, which is what a test
  // asserting the answer buys over one asserting the route.
  const lastLoops = last.both && loopsOfTypes(graph, last.types);

  /**
   * ⚠️ THE MEMO ALREADY KNOWS THIS DEGREE, AND THE LAST POSITION WAS PAYING A STRING-KEYED MAP
   * LOOKUP TO RE-ASK IT (item 1683). `hopSide(graph, idOf[slot], …)` does
   * `edgesFromByLabel.get(id)` — an id STRING through a Map — once per frontier slot, where
   * `memo.len[slot]` is the same number as an `Int32Array` read.
   *
   * Sound only because of what `slotNbrs`' own eligibility already guarantees: `uniform` means every
   * leg shares a direction and none is `both`, and the memo additionally requires every leg to carry
   * the same types with no gate and no effective label. So the LAST leg is the leg the memo was
   * built from, and `len[slot]` is exactly the degree this position wants. `lastFar` is `undefined`
   * and `last.both` is `false` whenever `slotNbrs` exists, which is why neither is consulted here.
   *
   * `len[slot] === undefined` is "this slot was never walked as a SOURCE" — a slot first reached in
   * the final pass has no run — so the fallback is the original call, unchanged.
   */
  if (slotNbrs !== undefined) {
    const { len } = slotNbrs;

    for (const slot of frontier) {
      count +=
        ways[slot] * (len[slot] ?? hopSide(graph, idOf[slot], last.out, last.types, lastFar));
    }

    return count;
  }

  for (const slot of frontier) {
    count +=
      ways[slot] *
      (last.both
        ? undirectedSide(graph, idOf[slot], last.types, lastFar, lastLoops)
        : hopSide(graph, idOf[slot], last.out, last.types, lastFar));
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
  current: InteriorGates | null | undefined,
): InteriorGates | null | undefined => {
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
    return { b: [inB], c: [] };
  }

  return undefined;
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
  interiorPred: InteriorGates | null | undefined,
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
    // BOTH positions, which is item 1700's fix: the clause reader now buckets per position exactly
    // as the inline reader does, so `WHERE b.k = 7 AND c.k > 60` lands here instead of declining.
    bPreds.push(...interiorPred.b);
    cPreds.push(...interiorPred.c);
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
export const productCountOf = <T>(
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
export const keyedCountOf = <T>(
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
export const countStarColumn = (proj: Projection): string | null => {
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
export const anchorFilterGate = (
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

  return composeInlineGate(preds);
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
export const pageOneRow = (
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
export const keepGroups = (
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
  // Elements and anything else `valueKey` keys by id — see the use site for why this is its own
  // container and why the key is `String(v.id)` rather than the raw value.
  let ids: Set<string> | undefined;

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

      // An ELEMENT (or anything else `valueKey` keys by id) gets its own container keyed on the
      // ID ITSELF, which builds NO STRING for the common case. `valueKey` would return
      // `'@' + String(v.id)`; the `'@'` is a constant within a container of its own, so dropping
      // it is exactly `valueKey`'s equivalence restricted to this branch — the same "one container
      // per kind" trade `LocalDate` and the zoned kinds make above, and the same reason they are
      // never shared: the tag is what keeps the kinds apart, so a separate container has to.
      //
      // `String(v.id)` is kept rather than raw-keying `v.id`, deliberately: `valueKey` collapses
      // an id `5` and an id `'5'` into one value, and a raw key would split them. For a string id
      // — which is every id this engine mints — `String(s)` returns `s` with no allocation, so the
      // common path builds nothing while the equivalence is unchanged.
      // ⚠️ REJECTED, WITH ITS NUMBERS (item 1589): keying a graph ELEMENT on its own OBJECT
      // IDENTITY instead of on `String(v.id)`, in a `Set<object>` with no key built at all.
      //
      // Item 1587 made this look compelling: it is exactly what Gremlin's `dedupe` does ("stable
      // graph-element references dedupe directly in this Set — value/identity equality, no
      // allocation (the hot path)"), Gremlin answers the hop-distinct question in 0.527 ms where
      // GQL takes ~7-9, and identity would ALSO fix divergence 13 (two distinct vertices with ids
      // `5` and `'5'` collapse here and do not in native). It is sound, too — the graph hands out
      // one object per id, verified at item 1584 through every path.
      //
      // It is still a small REGRESSION. An asserted A/B at 40 reps, reading the TIGHT arms rather
      // than the noisy ones:
      //
      //     count(DISTINCT n)  node-only   PRE 2.569-2.610   POST 2.700-2.730   1.05x WORSE
      //     RETURN DISTINCT b              PRE 10.39-11.39   POST 10.76-13.30   worse
      //     count(DISTINCT b)  hop         PRE  8.35-10.05   POST  6.63- 8.62   ranges OVERLAP
      //     count(DISTINCT n.n) control    PRE 1.934-2.006   POST 1.900-1.955   flat
      //
      // The hop arm's apparent 1.26x is noise — its PRE minimum (8.348) sits inside POST's range
      // (6.625-8.623). The node-only arm is tight on BOTH sides and does not overlap, so the 5%
      // regression is the real reading. A `Set<object>` probe costs more than `'@' + id` saves,
      // which is item 1584's refutation arriving again by a different route: there identity was
      // added IN FRONT of the key, here it REPLACED it, and both are slower.
      //
      // ⚠️ So Gremlin's 12x on that shape is NOT its dedup keying, and the three mechanisms tested
      // so far — `valueKey` string building (1584, the only one that paid), identity keying (1584
      // and here), and the per-element binding + `evalFn` (1584, flat) — do not explain it. The
      // next attempt needs a different instrument: a step-by-step comparison of what Gremlin's
      // route for that plan actually does against GQL's, rather than another guess at the keying.
      if ('id' in v) {
        ids ??= new Set();

        const id = typeof v.id === 'string' ? v.id : String(v.id);

        if (ids.has(id)) {
          return false;
        }

        ids.add(id);

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
export const groupIndex = (): {
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
export const sortGroupRows = (rows: Row[], sort: readonly ColSort[]): Row[] =>
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
export const groupedSortApplier = (
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

export const groupedClauses = (clauses: readonly Clause[]): GroupedShape | null => {
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

/**
 * The projection shapes this can answer: one or two items, one of them `count(*)`, nothing else
 * on.
 *
 * `keyCol` is the output column the group key goes in, or `undefined` for the ONE-COLUMN form,
 * which projects only the count and so emits no key column at all.
 */
export const groupedProjection = (
  proj: Projection,
  letName: string | undefined,
): {
  countAt: number;
  sort: readonly ColSort[];
  having: CompiledExpr | undefined;
  keyExpr: Expr;
  keyCol: string | undefined;
} | null => {
  // SKIP/LIMIT are NOT refused. A grouped count's rows come out in FIRST-SEEN group order,
  // which is the pinned contract both engines keep (a `Map`'s insertion order here, the
  // general path's own `Map<string, Binding[]>` there) — so a window over them is a slice of
  // this list and equals the general path's window over its list.
  //
  // `ORDER BY` used to decline here, because it reorders the groups BEFORE the window and the
  // tally did not sort. It sorts now (`colSortsOf` + `sortGroupRows`, item 190), which is that
  // same order, applied to one row per GROUP instead of one per input element.
  // ONE item is admitted as well as two, and that is item 1582's change. The gate used to be
  // `!== 2`, which declined `MATCH (n) RETURN count(*) AS c GROUP BY n.k` — a grouped count that
  // does not want the key in its output — for lacking a second projection item the tally has no
  // use for. It asks for strictly LESS than the two-column form and cost 24.6x more:
  //
  //     MATCH (n) RETURN n.k AS key, count(*) AS c GROUP BY n.k     0.652ms   <- reached here
  //     MATCH (n) RETURN count(*) AS c GROUP BY n.k                16.051     the general path
  //     MATCH (n) LET grp = n.k RETURN count(*) AS c GROUP BY grp   22.421     34.4x
  //
  // Found by `cross-surface-probe`, which flagged the shape at 27x Gremlin's `groupCount` — and
  // the Gremlin side's 0.78ms is the two-column form's cost, so the fast rung was the correct
  // price and these two spellings were the defect (item 1581).
  // No lower bound on the item count, and that is a removal rather than an omission: an EMPTY
  // projection already declines at `countAt === -1` below, because `findIndex` finds no
  // `count(*)` in it. A `proj.items.length < 1` guard here survived its mutant for exactly that
  // reason, so it went the way of item 475's — a line no test can fail on, whose redundancy is
  // provable by reading.
  if (proj.star || proj.distinct || proj.items.length > 2) {
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

  // ONE-COLUMN: there is no key ITEM, so the key can only come from an explicit `GROUP BY`, and
  // without one the query is an UNGROUPED count that belongs to a different rung entirely
  // (`buildNodeCount`, measured at 0.003ms). `ORDER BY` declines here rather than being
  // supported: its only resolvable target is the count column, and `colSortsOf` is written
  // around a projected KEY column that this form does not have. Left for a shape that asks.
  const oneColumn = proj.items.length === 1;

  if (oneColumn) {
    const only = proj.groupBy;

    // No shape check on the key beyond "there is exactly one": each CALLER resolves it through
    // its own `LET` and then requires `keySource.kind === 'prop'` on the node it scans, which is
    // strictly stronger than anything checkable here. A second check in this function would be
    // the redundant guard item 475 removed.
    if (only?.length !== 1 || (proj.orderBy?.length ?? 0) !== 0) {
      return null;
    }

    return {
      countAt,
      sort: [],
      having: proj.having === undefined ? undefined : compileExpr(proj.having),
      keyExpr: only[0],
      keyCol: undefined,
    };
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
    keyExpr: keyItem.expr,
    keyCol: keyItem.alias ?? columnName(keyItem.expr),
  };
};

/**
 * One grouped-count row: the count alone for the one-column form, otherwise the count and the
 * key in the order the projection wrote them.
 *
 * Shared by the node and hop tallies, which had the same three-way branch spelled out twice —
 * and `keyCol === undefined` is the whole of the one-column form's output difference, so having
 * one place that knows it is what keeps the two rungs from drifting apart.
 */
export const groupedCountRow = (
  slot: { readonly key: unknown; readonly n: number },
  countCol: string,
  keyCol: string | undefined,
  countFirst: boolean,
): Row => {
  if (keyCol === undefined) {
    return { [countCol]: slot.n };
  }

  return countFirst
    ? { [countCol]: slot.n, [keyCol]: slot.key }
    : { [keyCol]: slot.key, [countCol]: slot.n };
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
export const ROW_LOCAL_KINDS: ReadonlySet<string> = new Set([
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

  // ⚠️ A `lit` IS `{ kind: 'lit'; value: unknown }` — one field, and that field is DATA, never an
  // expression. Stopping here is therefore not an optimization but the structural truth, and
  // descending was a WRONG DECLINE (item 1490).
  //
  // `rowLocalChild`'s note below says "descending into a non-`Expr` object is safe because every
  // `Expr` carries a `kind`". That is true and it is the wrong direction: the walk relies on the
  // CONVERSE — that everything carrying a string `kind` is an `Expr` — and a stored temporal
  // breaks it. `LenkeDate` and its five siblings each carry `readonly kind = 'date'` (etc.) as
  // their `instanceof` discriminant, so `DATE '2029-11-10'`, which the parser lowers to
  // `{ kind: 'lit', value: <LenkeDate> }`, was handed to `rowLocal` AS AN EXPRESSION, missed the
  // allowlist, and declined the whole shape.
  //
  // It cost an EQUIVALENT SPELLING 2.41x — the exact failure class `CLAUDE.md` names, where the
  // planner recognizes one spelling of a predicate and not another that means the same thing.
  // `WHERE n.d > DATE '…'` and `WHERE n.d > $cut` are one filter; at 200,000 vertices the first
  // measured 15.90 ms against the second's 6.59, because only the param spelling (which puts no
  // temporal in the AST) reached this path. Both answered correctly, so no correctness test could
  // have caught it.
  //
  // The guard is on the `lit` rather than on `isTemporal(value)` because the temporals are only
  // today's instance: any future value class with a `kind` — or a stored map carrying a user key
  // named `kind` — fails the same way, and a literal has no sub-expression to check in any case.
  if (e.kind === 'lit') {
    return true;
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

export type ReachFn = (graph: Graph, params: Params) => Row[];

/** Whether `e` reads only variable `v` (a bare `v`, `v.key`, or a constant). */
export const refsOnlyVar = (e: Expr, v: string): boolean => {
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
export const VALUES_AGGREGATES: ReadonlySet<string> = new Set([
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
export const groupedAccs = (
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
