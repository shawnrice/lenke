/**
 * THE FILTERED CHAIN COUNT OVER FLAT SLOT RUNS (item 1688) — `sweepChain`'s fast arm.
 *
 * Item 1685 answered the UNFILTERED three-hop count from a degree product at 81.4x. Adding any
 * filter cost 18x-44x of that, because a filter constrains a position the product reaches only as a
 * DEGREE, so the query fell back to `sweepChain`'s per-pass walk — 36.2% of which profiled in
 * `sweepOneDirection` (`edgesOfTypes` generator plus a string-keyed slot lookup per edge).
 *
 * Item 1687 priced the replacement:
 *
 * ```text
 *    engineStart             299.2 ms      1.00x
 *    csrStart                  3.2        92.27x
 *    csrStartPlusBuild        82.3         3.64x    full O(V+E) build inside the timed region
 *    engineEnd               306.7         1.00x
 *    csrEnd                    4.6        66.87x
 *    csrEndPlusBuild          83.7         3.66x
 * ```
 *
 * ⚠️ EVERY POSITION'S CONSTRAINT BECOMES A PER-SLOT MASK, which is what lets one arm serve a start,
 * interior or end filter uniformly. A label and an inline gate are both per-vertex questions, so each
 * costs O(V) once per query against a walk over E per pass — free at any realistic degree.
 *
 * ⚠️ AND THE MASK IS ONLY SOUND BECAUSE `inlinePredOf` REFUSES A CORRELATED PREDICATE, which was
 * checked rather than assumed: it returns `null` when any inline property's value has free
 * variables, and for an inline `WHERE` it refuses every free name but the node's own. So an
 * `InlinePred` is a pure function of its own vertex. A CLAUSE `WHERE` cannot make that claim —
 * `inline-gate.ts` says so directly — which is why this arm takes its gates from the compiled legs
 * and asks no questions about where they came from.
 *
 * ⚠️ THE MASKS AND THE SEED SET ARE PER-QUERY AND MUST NEVER BE CACHED ON `topologyVersion`. They
 * read PROPERTIES, and a property write deliberately does not bump that signal (items 1674/1675) so
 * that a `SET` cannot discard an adjacency cache. Only the CSRs are cached. That is the same split
 * item 1680 recorded for its projection memo and item 1685 for its degree arrays.
 *
 * ⚠️ NOT ITEM 1106'S REFUTED MEMO. `sweepChain` carries `slotNbrs`, a flat PER-QUERY slot memo gated
 * `passes > 2` because "the first pass PAYS for the memo and only later passes are refunded" — at two
 * passes it measured a small LOSS (162.0 against 165.7). That is correct on its own terms. A CACHED
 * CSR needs no amortisation on a hit, which removes the premise rather than disputing the number.
 * ⚠️ The `passes > 2` gate is NOT touched here; item 1683 relaxed it on an assumption and had to
 * revert.
 */
import type { Graph, Vertex } from '@lenke/core';

import type { LabelExpr } from '../ast.js';
import { matchesLabel } from '../graph-queries.js';
import type { Params } from './core.js';
import { csrFor } from './csr-cache.js';
import { inlineHolds } from './inline-gate.js';
import type { InlinePred } from './inline-gate.js';

/** One chain leg, as `sweepChain` compiles it: the hop plus its LANDED node's constraints. */
export type CsrLeg = {
  out: boolean;
  both: boolean;
  types: string[] | undefined;
  label: LabelExpr | undefined;
  gate: InlinePred | undefined;
};

/**
 * MAY THIS CHAIN TAKE THE FLAT-ARRAY ARM?
 *
 * ⚠️ A PURE FUNCTION WITH ITS OWN TEST, for the asymmetry item 1685 recorded: a wrongly RELAXED
 * clause returns a WRONG COUNT and the differential tests catch it, while a wrongly TIGHTENED one
 * silently abandons the arm and every answer stays right. Only a direct assertion covers the second
 * direction.
 *
 * Two exclusions, neither for tidiness.
 *
 * `both`: an undirected leg walks two adjacency indexes and must count a self-loop ONCE, which item
 * 1097 fixed a half-answer bug over. A single CSR run cannot express it and a union of two would
 * double the loop.
 *
 * ⚠️ `seeded`: AN INDEX SEED MAKES THIS ARM A REGRESSION, AND A TEST CAUGHT IT RATHER THAN
 * REASONING. `sweepStartSeed` returns a set when an index seek beat the label bucket (item 1330), so
 * the query is already SUB-LINEAR — it touches a handful of start vertices. This arm's masks are
 * O(V) per constrained position, which throws that away: `seeded-sweep-start.test.ts` asserts the
 * 5,000-element label bucket is walked ZERO times for a selective `a.k = 7`, and with the arm taking
 * the query it walked 5,000. The ANSWER was right (the test's count assertion passed); only the work
 * was wrong, which is exactly what that test exists to observe.
 */
export const filteredChainCsrApplies = (legs: readonly CsrLeg[], seeded: boolean): boolean =>
  legs.length > 0 && !seeded && legs.every((l) => !l.both);

/**
 * A per-slot accept mask for one position, or `undefined` when the position is unconstrained.
 *
 * Returning `undefined` rather than an all-ones array is deliberate: the recurrence then skips the
 * multiply entirely, which keeps the unfiltered shape at item 1685's cost instead of paying a pass
 * over V to learn that nothing is excluded.
 */
const maskFor = (
  graph: Graph,
  params: Params,
  order: readonly Vertex[],
  label: LabelExpr | undefined,
  gate: InlinePred | undefined,
): Uint8Array | undefined => {
  if (label === undefined && gate === undefined) {
    return undefined;
  }

  const mask = new Uint8Array(order.length);
  // ONE binding reused across slots, exactly as the walk does — a gate reads only its own vertex
  // (see the module header), so nothing carries between iterations.
  const binding = new Map<string, unknown>();

  for (let s = 0; s < order.length; s += 1) {
    const v = order[s];

    mask[s] =
      (label === undefined || matchesLabel(v, label)) &&
      (gate === undefined || inlineHolds(gate, v, binding, params, graph))
        ? 1
        : 0;
  }

  return mask;
};

/**
 * The chain count, as a mask-weighted level recurrence over cached CSRs.
 *
 * `count = sum over seeds of the number of surviving walks`, accumulated level by level. The LAST
 * position is a degree sum when it is unconstrained and one more pass when it is not — which is
 * `sweepChain`'s own `lastGated` split, for its reason: a degree cannot say which of a vertex's
 * edges land somewhere that passes.
 */
export const filteredChainCsrCount = (spec: {
  graph: Graph;
  params: Params;
  legs: readonly CsrLeg[];
  startLabel: LabelExpr | undefined;
  startGate: InlinePred | undefined;
}): number => {
  const { graph, params, legs, startLabel, startGate } = spec;
  // `csrFor`'s `inward` is the negation of an `out` hop: `out` reads `edgesFromByLabel`.
  const csrs = legs.map((l) => csrFor(graph, !l.out, l.types));
  const [{ order }] = csrs;
  const n = order.length;

  let ways = new Float64Array(n);
  let next = new Float64Array(n);

  /**
   * EVERY SLOT STARTS LIVE, AND THE START'S OWN MASK REMOVES THE REST.
   *
   * ⚠️ THERE IS NO SEED-SET BRANCH HERE, AND ITS ABSENCE IS DELIBERATE. An earlier draft carried
   * one, narrowing `ways` to `sweepStartSeed`'s vertices — and a mutation pass SURVIVED replacing
   * its condition with `false`, because `filteredChainCsrApplies` returns false for a seeded query,
   * so the branch was unreachable and no test could ever distinguish it. Dead code behind a live
   * one is worse than no code: it reads as a tested path. If the `seeded` exclusion is ever lifted,
   * the seed path comes back WITH the test that reaches it.
   */
  ways.fill(1);

  const startMask = maskFor(graph, params, order, startLabel, startGate);

  if (startMask !== undefined) {
    for (let s = 0; s < n; s += 1) {
      if (startMask[s] === 0) {
        ways[s] = 0;
      }
    }
  }

  const last = legs.length - 1;
  const lastMask = maskFor(graph, params, order, legs[last].label, legs[last].gate);
  // An unconstrained last position is answered by a weighted sum of DEGREES and needs no pass.
  const passes = lastMask === undefined ? last : legs.length;

  for (let p = 0; p < passes; p += 1) {
    const { off, nbr } = csrs[p];

    next.fill(0);

    for (let s = 0; s < n; s += 1) {
      const w = ways[s];

      if (w === 0) {
        continue;
      }

      const end = off[s + 1];

      for (let i = off[s]; i < end; i += 1) {
        next[nbr[i]] += w;
      }
    }

    // The LANDED position's mask, applied once per vertex rather than once per arriving edge.
    const mask = p === last ? lastMask : maskFor(graph, params, order, legs[p].label, legs[p].gate);

    if (mask !== undefined) {
      for (let s = 0; s < n; s += 1) {
        if (mask[s] === 0) {
          next[s] = 0;
        }
      }
    }

    const swap = ways;
    ways = next;
    next = swap;
  }

  let total = 0;

  if (lastMask === undefined) {
    const { off } = csrs[last];

    for (let s = 0; s < n; s += 1) {
      total += ways[s] * (off[s + 1] - off[s]);
    }

    return total;
  }

  for (let s = 0; s < n; s += 1) {
    total += ways[s];
  }

  return total;
};
