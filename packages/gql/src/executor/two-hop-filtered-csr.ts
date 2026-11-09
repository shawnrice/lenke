/**
 * THE FILTERED TWO-HOP COUNT OVER FLAT SLOT RUNS (item 1690), and its eligibility predicate.
 *
 * The three-hop family is taken: item 1685 (unfiltered, 81.4x), item 1688 (start and end filters,
 * 33.9x and 28.8x) and item 1689 (interior filter, 14.8x). The two-hop family was the one left, and
 * `walkTwoHopFiltered` is where both of its filtered shapes land — the END-filtered row too, because
 * the pattern is ORIENTED so the predicate-carrying node becomes the start. A route counter said so;
 * reading the code had suggested the end filter fell to the general pipeline, and it does not.
 *
 * That walk is start-driven and sound. Its cost is one degree read per FIRST-LEG EDGE through
 * `side` — which is `bucketSize`, already O(1), so there is no repeated-lookup lever here (items
 * 1416/1637 settled that) — but O(1) through a `Map.get` plus an `edgesOfTypes` generator frame is
 * not O(1) through an `Int32Array`. Priced on 200,000 v / 1,000,000 e, each arm asserted against its
 * own engine count:
 *
 * ```text
 *    engineStart         141.4 ms     1.00x
 *    csrStart              2.8       51.05x
 *    csrStartPlusBuild    81.7        1.73x    full O(V+E) build inside the timed region
 *    engineEnd           161.3        1.00x
 *    csrEnd                5.3       30.19x
 *    csrEndPlusBuild      85.2        1.89x
 * ```
 *
 * ⚠️ NOT ITEM 1517'S REFUTED LEVER. That one built the "end formula" — the reversed walk — and
 * measured it **2.0x WORSE** (265.5 against 132.4), because it is selectivity-blind and structurally
 * so. This is not a cheaper route to the same degree lookup; it is an INDEX in place of the lookup,
 * which is the distinction items 1335 and 310 record at the three-hop twin.
 *
 * ⚠️ THE MASK IS PER-QUERY AND MUST NEVER BE CACHED ON `topologyVersion`. It reads PROPERTIES
 * through the predicate, and a property write deliberately does not bump that signal (items
 * 1674/1675), so a mask cached on it would go stale with no signal to catch it. Only the CSRs are
 * cached — the same split items 1680, 1685, 1688 and 1689 each recorded.
 *
 * Acyclic: `graph-queries.ts` and `csr-cache.ts` only, so nothing here imports `shortcuts.ts` back.
 */
import type { Graph, Vertex } from '@lenke/core';

import type { LabelExpr } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import type { Params } from './core.js';
import { csrFor } from './csr-cache.js';
import { inlineHolds } from './inline-gate.js';
import type { InlinePred } from './inline-gate.js';

/**
 * MAY THE FILTERED TWO-HOP COUNT TAKE THE FLAT-ARRAY ARM?
 *
 * ⚠️ A PURE FUNCTION WITH ITS OWN TEST, for the asymmetry that governs every route choice in this
 * family: a wrongly RELAXED clause returns a WRONG COUNT and the differential tests catch it, while
 * a wrongly TIGHTENED one silently abandons the arm and every answer stays right.
 *
 * Each clause, and why a flat array cannot express what it excludes:
 *
 * `firstBoth` / `secondBoth` — an undirected leg walks two adjacency boxes and must yield a
 * self-loop ONCE, which items 1092/1093 settled against Gremlin's `both()` yielding it twice. Not
 * an `off` delta, and a union of two runs would double the loop.
 *
 * `cEff` — a label at the END is the one constraint that is NOT a mask. It filters which edges the
 * final DEGREE may count, where the CSR counts them all; the same boundary item 1689 drew between a
 * constraint on a visited vertex and a constraint on a degree's far endpoint. (`midEff` is on the
 * other side of that line and is taken: the middle is a slot, so a label there is a per-slot mask.)
 *
 * `seeded` — `hopSeek` returns a candidate set when an index seek beats the label bucket, so the
 * query is already SUB-LINEAR. This arm's mask is O(V), which throws that away. Item 1688 learned
 * this from a TEST rather than from reasoning: `seeded-sweep-start.test.ts` asserts a 5,000-element
 * bucket is walked zero times for a selective key, and the arm walked 5,000 while answering
 * correctly — the answer right, the work wrong.
 *
 * `predReadsOnlyStart` — a `HopPred` may carry `farVar` or `relVar`. The walk binds only
 * `startVar` before calling it, so in practice the caller passes a start-only predicate; this
 * clause REFUSES the others rather than trusting that, because a predicate that reads the far node
 * or the edge has no per-vertex form at all.
 */
export const twoHopFilteredCsrApplies = (s: {
  firstBoth: boolean;
  secondBoth: boolean;
  cEff: LabelExpr | undefined;
  seeded: boolean;
  predReadsOnlyStart: boolean;
}): boolean =>
  !s.firstBoth && !s.secondBoth && s.cEff === undefined && !s.seeded && s.predReadsOnlyStart;

/**
 * `count = sum over b of (accepted a's reaching b) * outdeg(b)`, over cached CSRs.
 *
 * One pass over the first leg to accumulate arrivals, then a weighted DEGREE SUM for the second —
 * no second pass, because nothing constrains the end position (`cEff` declines above). That is the
 * same `lastGated` split items 1688 and 1689 use, for its reason: a degree cannot say which of a
 * vertex's edges land somewhere that passes.
 *
 * ⚠️ THE ACCEPT TEST ORDER IS THE WALK'S, AND THAT IS A CORRECTNESS PROPERTY. The walk enumerates
 * `candidateVertexSource(graph, aLabel)` — the label bucket — and only then applies the predicates.
 * A predicate can THROW (a string-vs-temporal `<=` does, which is settled policy here), so testing
 * the LABEL first keeps the evaluated set exactly the walk's: a vertex outside the bucket never
 * reaches the predicate, as it never does today.
 */
export const twoHopFilteredCsrCount = (
  graph: Graph,
  params: Params,
  spec: {
    aLabel: LabelExpr | undefined;
    midEff: LabelExpr | undefined;
    firstOut: boolean;
    t1: string[] | undefined;
    fromCOut: boolean;
    t2: string[] | undefined;
    inStart: InlinePred | undefined;
    /** Applied as the walk applies it: bind the start variable, then evaluate. */
    accept: ((a: Vertex) => boolean) | undefined;
  },
): number => {
  const { aLabel, midEff, firstOut, t1, fromCOut, t2, inStart, accept } = spec;
  // `csrFor`'s `inward` is the negation of `side`'s `out`: `out` reads `edgesFromByLabel`.
  const leg1 = csrFor(graph, !firstOut, t1);
  const leg2 = csrFor(graph, !fromCOut, t2);
  const { order } = leg1;
  const n = order.length;
  const binding = new Map<string, unknown>();
  const arrivals = new Float64Array(n);

  for (let s = 0; s < n; s += 1) {
    const a = order[s];

    if (aLabel !== undefined && !matchesLabel(a, aLabel)) {
      continue;
    }

    if (inStart !== undefined && !inlineHolds(inStart, a, binding, params, graph)) {
      continue;
    }

    if (accept !== undefined && !accept(a)) {
      continue;
    }

    const end = leg1.off[s + 1];

    for (let i = leg1.off[s]; i < end; i += 1) {
      arrivals[leg1.nbr[i]] += 1;
    }
  }

  let total = 0;

  if (midEff === undefined) {
    for (let s = 0; s < n; s += 1) {
      const w = arrivals[s];

      if (w !== 0) {
        total += w * (leg2.off[s + 1] - leg2.off[s]);
      }
    }

    return total;
  }

  // A MIDDLE label is a per-slot test, and only for slots something actually reached — which is
  // also the walk's evaluated set, since it tests the middle's label per first-leg edge.
  for (let s = 0; s < n; s += 1) {
    const w = arrivals[s];

    if (w !== 0 && matchesLabel(order[s], midEff)) {
      total += w * (leg2.off[s + 1] - leg2.off[s]);
    }
  }

  return total;
};
