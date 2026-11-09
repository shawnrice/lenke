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
import type { Params } from './core.js';
import { csrFor } from './csr-cache.js';
import type { InlineGate } from './inline-gate.js';

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

/**
 * MAY THE THREE-HOP COUNT TAKE THE *GATED* FLAT-ARRAY ARM? (item 1689.)
 *
 * ⚠️ THREE OF {@link csrDegreeProductApplies}'s FIVE EXCLUSIONS ARE LIFTED HERE, AND THE SPLIT IS
 * NOT COSMETIC: a constraint on `b` or `c` says which VERTICES are accepted, while a label at `a` or
 * `d` says which edges a DEGREE may count. The first is a mask over the shared slot numbering, and
 * costs O(V) once per query. The second would need a label-filtered degree — a different array,
 * which this arm does not have — so `aEff`, `dEff` and every `both` leg still decline.
 *
 * What this buys: `count 3-hop + interior filter` measured **526.8 ms against the same question's
 * start- and end-filtered twins at 10.3 and 21.5** (200,000 v / 1,000,000 e), because the `needsC`
 * branch gates `c` ONCE PER MIDDLE EDGE. Its own comment called that "the honest cost of this
 * position"; it is the honest cost of meeting `c` as an edge endpoint, and the cure is to stop
 * meeting it that way.
 *
 * ⚠️ A PURE FUNCTION WITH ITS OWN TEST, for the asymmetry that governs every route choice in this
 * file: a wrongly RELAXED clause returns a WRONG COUNT and the differential tests catch it, while a
 * wrongly TIGHTENED one silently abandons the arm and every answer stays right.
 */
export const csrGatedDegreeProductApplies = (w: {
  aBoth: boolean;
  midBoth: boolean;
  dBoth: boolean;
  aEff: LabelExpr | undefined;
  dEff: LabelExpr | undefined;
}): boolean => !w.aBoth && !w.midBoth && !w.dBoth && w.aEff === undefined && w.dEff === undefined;

/**
 * The same degree product, with `b` and `c` constrained.
 *
 * ⚠️ A LITERAL SIBLING OF {@link threeHopDegreeProductOverCsr} RATHER THAN A FLAG ON IT. Item 1681
 * measured 1.26x for one walk serving several shapes: V8's inline caches live on the FUNCTION, so a
 * branch inside the unfiltered arm would hand `count 3-hop` — 5.7 ms after item 1685, and the row
 * this file exists for — a second shape to dispatch over. A factory would not help, because the
 * caches would still be shared by the one closure body.
 *
 * `count = sum over b of ways(b) * sum over (b->c) of weight(c)`, where `weight(c)` folds the accept
 * test INTO the degree: `accept[c] ? outdeg(c) : 0`, precomputed once over the slot numbering. The
 * inner loop is then one `Float64Array` read per middle edge, exactly as in the unfiltered arm,
 * instead of a vertex resolve plus a label test plus a gate call.
 *
 * ⚠️ REJECTED, WITH ITS NUMBERS (item 1698): specializing this gate. An ablation puts the gate at
 * **83% of this row** — 89.82 -> 14.77 ms on a scattered fixture, ~375 ns per call against item
 * 1600's ~31 for a specialized one — and a route counter confirms the CLAUSE spelling takes the
 * general `inlineHolds` path while both INLINE spellings specialize: `bindVar: 'c'` makes
 * `specializedConjunct` refuse, for its own documented correctness reason.
 *
 * That looks like the whole 6.08x and it is not. The two spellings measure **1.11x apart** (69.73
 * clause against 62.97 inline), so the dispatch is ~7 ms of the gate's ~75. The rest is the
 * per-vertex `c.properties[key]` READ, and on a scattered adjacency each one is a cache miss — the
 * mechanism item 1694 priced at 2.26x for the walk itself. Native's twin of this row is
 * single-digit milliseconds because it stores properties COLUMNAR; that is the real lever, and it
 * is an architecture change rather than an arm.
 *
 * ⚠️ AND THIS ROW'S VARIANCE IS WIDE ON THAT FIXTURE: the same build read 89.82 and 69.73 across
 * processes (1.29x), so neither figure above should be quoted without the other.
 *
 * ⚠️ THE WEIGHTS ARE PER-QUERY AND MUST NEVER BE CACHED ON `topologyVersion`. They read PROPERTIES
 * through the gate, and a property write deliberately does not bump that signal (items 1674/1675),
 * so a weight array cached on it would go stale with no signal to catch it. Only the CSRs are
 * cached — the same split items 1680, 1685 and 1688 each recorded.
 */
export const threeHopGatedDegreeProductOverCsr = (
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
  constraints: {
    cEff: LabelExpr | undefined;
    cGate: InlineGate | undefined;
    bGate: InlineGate | undefined;
    params: Params;
  },
): number => {
  const aSide = csrFor(graph, !legs.toAOut, legs.t1);
  const mid = csrFor(graph, !legs.midOut, legs.t2);
  const dSide = csrFor(graph, !legs.fromDOut, legs.t3);
  const { idx, order } = aSide;
  const { cEff, cGate, bGate, params } = constraints;
  const n = order.length;
  // ONE binding reused across slots, as the walk does: a gate here reads only its own vertex, which
  // `inlinePredOf` guarantees by refusing any inline constraint with a free name but the node's own.
  const binding = new Map<string, unknown>();
  /**
   * `accept(c) ? outdeg(c) : 0`, per SLOT — MARKED on arrival, RESOLVED in slot order, then EMITTED.
   *
   * ⚠️ NOT A PASS OVER V — AND THE REASON IS A WORK BOUND, NOT CORRECTNESS. Items 1689 and the first
   * draft of 1699 both justified this by "a gate can THROW", and that is WRONG in a predicate
   * context: eighteen cross-type ordering comparisons were tried here (`> >= < <= = <>` against
   * string-vs-number, string-vs-date and number-vs-date) and **every one returns a clean no-match**.
   * The GQL throw rule `cross-type-comparison-no-error` records lives in ORDER BY / min / max, where
   * `compareValues` throws — not on this path. A mutation making the resolve pass eager SURVIVES the
   * whole suite, correctly, because the two forms are answer-equivalent and both total.
   *
   * What the mark pass actually buys is that the gate is evaluated once per REACHED slot rather than
   * once per vertex. Measured both ways on a dense fixture, where nearly every slot is reached, the
   * eager form is **1.08x FASTER** (17.65 against 19.30) — so on this row the mark pass costs a
   * little. It is kept because the two have different WORST cases: the mark pass's downside is
   * bounded at ~1.08x, while an eager resolve gates all |V| vertices even for a query whose middle
   * is selective enough to touch a handful. A bounded loss is preferred to an unbounded one.
   *
   * ⚠️ AND NOT RESOLVED ON FIRST ARRIVAL EITHER, WHICH IS WHAT THIS USED TO DO (item 1699). Arrival
   * order is the order `mid.nbr` happens to hold, so a lazy resolve touches 200,000 vertex objects
   * at RANDOM while a resolve pass in SLOT order walks them in `verticesById` order — which is the
   * order they were allocated in. Same reads, same set, sequential instead of scattered. Item 1691
   * measured exactly this shape on the Gremlin side at **3.4 ms against the lazy form's 21.7**, and
   * item 1698 established that the gate is 83% of this row with only 1.11x of it dispatch: the rest
   * is the property READ, and its cost is where it lands in memory.
   *
   * `reached` is marked, `state` is resolved, so a weight of zero — a rejected `c`, or an accepted
   * one with no out-edges — is never mistaken for "not yet asked".
   */
  const weight = new Float64Array(n);
  const reached = new Uint8Array(n);
  /** The `b` slots the walk expands, recorded by the mark pass so the emit pass does not re-derive
   *  them — the guards below (`bLabel`, `bGate`, a missing slot, `ways === 0`) all decide whether a
   *  `b`'s middle edges are walked at all, and the two passes must agree on that exactly. */
  const liveB: number[] = [];
  const liveWays: number[] = [];
  let total = 0;

  // 1. MARK: which `b` the walk expands, and which `c` slots its middle edges reach.
  for (const b of candidateVertexSource(graph, bLabel)) {
    if (!matchesLabel(b, bLabel)) {
      continue;
    }

    // ⚠️ `bGate` NEEDS NO MASK AND GETS NONE. This loop already visits each `b` exactly once, so the
    // gate is already a per-vertex cost here; a mask would add a pass over V to save nothing.
    if (bGate !== undefined && !bGate(b, binding, params, graph)) {
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

    liveB.push(slot);
    liveWays.push(ways);

    const end = mid.off[slot + 1];

    for (let i = mid.off[slot]; i < end; i += 1) {
      reached[mid.nbr[i]] = 1;
    }
  }

  // 2. RESOLVE, in SLOT order and only for marked slots — the walk's own evaluated set, read
  //    sequentially rather than in arrival order.
  for (let s = 0; s < n; s += 1) {
    if (reached[s] === 0) {
      continue;
    }

    const c = order[s];

    if (
      (cEff === undefined || matchesLabel(c, cEff)) &&
      (cGate === undefined || cGate(c, binding, params, graph))
    ) {
      weight[s] = dSide.off[s + 1] - dSide.off[s];
    }
  }

  // 3. EMIT.
  for (let k = 0; k < liveB.length; k += 1) {
    const slot = liveB[k];
    let inner = 0;
    const end = mid.off[slot + 1];

    for (let i = mid.off[slot]; i < end; i += 1) {
      inner += weight[mid.nbr[i]];
    }

    total += liveWays[k] * inner;
  }

  return total;
};

/**
 * PICK THE FLAT-ARRAY ARM FOR THIS THREE-HOP COUNT, or `undefined` to leave it to the walk.
 *
 * ⚠️ ONE ENTRY POINT BECAUSE THE CALLER IS AT ITS COMPLEXITY CEILING, and that ceiling is doing its
 * job rather than being in the way: `buildThreeHopCount` was already at 35 of 35 when item 1685
 * moved the first arm out here, and a second route check in the closure read 36. Dispatching once
 * PER QUERY costs nothing — it is the per-element loops that must stay in separate functions, which
 * they do.
 *
 * Order matters: the unfiltered arm is tried first because it is the cheaper of the two (no accept
 * memo, no branch in the inner loop) and it serves `count 3-hop`, the 5.7 ms row this file exists
 * for.
 */
export const threeHopCsrCount = (
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
  shape: {
    aBoth: boolean;
    midBoth: boolean;
    dBoth: boolean;
    aEff: LabelExpr | undefined;
    cEff: LabelExpr | undefined;
    dEff: LabelExpr | undefined;
    cGate: InlineGate | undefined;
    bGate: InlineGate | undefined;
    params: Params;
  },
): number | undefined => {
  if (
    csrDegreeProductApplies({
      aBoth: shape.aBoth,
      midBoth: shape.midBoth,
      dBoth: shape.dBoth,
      aEff: shape.aEff,
      cEff: shape.cEff,
      dEff: shape.dEff,
      bGated: shape.bGate !== undefined,
      cGated: shape.cGate !== undefined,
    })
  ) {
    return threeHopDegreeProductOverCsr(graph, bLabel, legs);
  }

  if (
    csrGatedDegreeProductApplies({
      aBoth: shape.aBoth,
      midBoth: shape.midBoth,
      dBoth: shape.dBoth,
      aEff: shape.aEff,
      dEff: shape.dEff,
    })
  ) {
    return threeHopGatedDegreeProductOverCsr(graph, bLabel, legs, {
      cEff: shape.cEff,
      cGate: shape.cGate,
      bGate: shape.bGate,
      params: shape.params,
    });
  }

  return undefined;
};
