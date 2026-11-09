/**
 * THE THREE-HOP COUNT'S FLAT-ARRAY DEGREE PRODUCT (item 1685), and its eligibility predicate.
 *
 * ⚠️ ITS OWN MODULE FOR TWO REASONS, ONE OF THEM A GATE. `buildThreeHopCount` was already at the
 * complexity ceiling (47 against 35 with this inlined, 42 with only the loop extracted), and
 * `shortcuts.ts` then crossed the 3,000-line cap this repo added for exactly this — so the limit
 * that fired is the one that says "this belongs somewhere else", not a formality to raise.
 *
 * Acyclic: `candidateVertexSource` and `matchesLabel` live in `graph-queries.ts` and the CSR in
 * `csr-cache.ts`, so nothing here imports `shortcuts.ts` back.
 */
import type { Graph } from '@lenke/core';

import type { LabelExpr } from '../ast.js';
import { candidateVertexSource, matchesLabel } from '../graph-queries.js';
import { csrFor } from './csr-cache.js';

/**
 * MAY THE THREE-HOP COUNT TAKE THE FLAT-ARRAY DEGREE PRODUCT? (item 1685.)
 *
 * ⚠️ A PURE FUNCTION WITH ITS OWN TEST, because a route choice is ANSWER-EQUIVALENT: every one of
 * these clauses, if wrongly relaxed, returns a WRONG COUNT rather than a slow one — so unlike the
 * route thresholds this file also carries, the differential tests DO catch a relaxation. What they
 * cannot catch is a clause wrongly TIGHTENED, which silently abandons the arm. That is what
 * `shortcuts.ts`'s own test pins, and it is why this is not inlined at the call site.
 *
 * It is also where the reason for each clause lives, next to the clause:
 *
 *   `*Both`  an undirected leg is `undirectedSide`'s two buckets minus the self-loops counted
 *            twice (item 1097 fixed a half-answer bug there). Not an `off` delta.
 *   `*Eff`   a label-filtered degree counts only edges whose far endpoint carries the label, where
 *            the CSR counts them all. A VACUOUS label is already `undefined`, so `(a:Person)` on an
 *            all-Person graph still qualifies.
 *   `*Gated` a gate is a predicate over a vertex the array has already reduced to a number.
 */
export const csrDegreeProductApplies = (w: {
  aBoth: boolean;
  midBoth: boolean;
  dBoth: boolean;
  aEff: LabelExpr | undefined;
  cEff: LabelExpr | undefined;
  dEff: LabelExpr | undefined;
  bGated: boolean;
  cGated: boolean;
}): boolean =>
  !w.aBoth &&
  !w.midBoth &&
  !w.dBoth &&
  w.aEff === undefined &&
  w.cEff === undefined &&
  w.dEff === undefined &&
  !w.bGated &&
  !w.cGated;

export const threeHopDegreeProductOverCsr = (
  graph: Graph,
  bLabel: LabelExpr | undefined,
  legs: {
    toAOut: boolean;
    t1: string[] | undefined;
    midOut: boolean;
    t2: string[] | undefined;
    fromDOut: boolean;
    t3: string[] | undefined;
  },
): number => {
  // `csrFor`'s `inward` is the negation of `hopSide`'s `out`: `out` reads `edgesFromByLabel`.
  const aSide = csrFor(graph, !legs.toAOut, legs.t1);
  const mid = csrFor(graph, !legs.midOut, legs.t2);
  const dSide = csrFor(graph, !legs.fromDOut, legs.t3);
  const { idx } = aSide;
  let total = 0;

  for (const b of candidateVertexSource(graph, bLabel)) {
    if (!matchesLabel(b, bLabel)) {
      continue;
    }

    const slot = idx.get(b);

    if (slot === undefined) {
      continue;
    }

    const ways = aSide.off[slot + 1] - aSide.off[slot];

    if (ways === 0) {
      continue;
    }

    let inner = 0;
    const end = mid.off[slot + 1];

    for (let i = mid.off[slot]; i < end; i += 1) {
      const c = mid.nbr[i];

      inner += dSide.off[c + 1] - dSide.off[c];
    }

    total += ways * inner;
  }

  return total;
};
