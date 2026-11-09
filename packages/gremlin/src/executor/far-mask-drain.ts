/**
 * THE FAR-FILTERED HOP'S EAGER DRAIN, OVER FLAT SLOT RUNS (item 1692), priced by item 1691.
 *
 * `V().out(T).has(k, p).id()` is the widest TS-vs-native ratio of any yielding row in
 * `bun run bench:gremlin`: TS 159.7 ms against native 2.69. Item 1691 corrected both halves of the
 * heading that called its headroom small — there is no `createIndex` in that bench, so native has
 * nothing to seek, and the "1.51x hand floor" it cited was a hand arm that still resolves the far
 * VERTEX OBJECT and reads `.properties` per edge, which is a floor on tuning the same data access
 * rather than on the question. One arm per process, 14 reps, median of the warm ones:
 *
 * ```text
 *    engine                   143.5 ms    1.00x
 *    perEdge                  109.4       1.31x    the audit's hand floor, reproduced
 *    perVertex                 76.4       1.88x    predicate per vertex, Map lookup per edge
 *    perEdgeCsr                67.7       2.12x    flat CSR, predicate still per edge
 *    lazyMaskCsr               21.7       6.47x    CSR + resolve on first arrival, IN the hot loop
 *    markThenMask               3.4      ~42x      what this module does
 *    perVertexCsrPlusMask       2.9      ~46x      CSR + an EAGER mask over all V
 * ```
 *
 * ⚠️ AN EAGER MASK OVER ALL V, AND THE THREE-PASS FORM THAT PRECEDED IT WAS JUSTIFIED BY THE WRONG
 * ENGINE'S RULE. The draft marked which slots an edge reaches and resolved the predicate only for
 * those, to keep the evaluated set exactly the walk's — because in GQL a predicate can THROW (a
 * string-vs-temporal `<=` does, settled policy there) and gating an unreached vertex would raise an
 * error the walk does not.
 *
 * ⚠️ THAT DOES NOT HOLD HERE, and `predicates.ts` says so in terms: for ordering predicates "a
 * cross-type pair is `NaN`, so every comparison against it is false and the predicate FILTERS the
 * value out rather than throwing — `g.V().has('name', gte(0))` returns nothing, exactly as
 * TinkerPop (verified on createModern())". And this arm only runs when `specializePredicate`
 * returned a closure, every branch of which is a total `typeof v === … && …` test. So the predicate
 * is TOTAL on this route and gating a vertex the walk never reaches is unobservable.
 *
 * Which makes the mark pass pure cost: it measured **3.4 ms against the eager form's 2.9**, and a
 * mutation replacing it with the eager form SURVIVED — correctly, because the two are
 * answer-equivalent. Two passes:
 *
 *   1. RESOLVE the predicate once per vertex into a `Uint8Array`
 *   2. EMIT    the accepted arrivals, in slot order then bucket order
 *
 * (Importing the other engine's constraint is the mistake this file now records. `CLAUDE.md` warns
 * against reasoning about GQL from Cypher; the same applies between lenke's own two engines, whose
 * comparison policies differ deliberately.)
 *
 * ⚠️ IT SERVES `drain` ONLY, AND THAT IS THE DESIGN RATHER THAN A GAP. A mark pass runs O(V+E)
 * before the first row, so wiring it into the LAZY iterator would destroy early exit — the
 * 473x/3680x failure the eager-tail-cache entry records for both engines. `drain` is already eager
 * and is read only by `toArray` when `rest` is empty (item 1412), so a plan carrying `limit(1)` puts
 * a step in `rest`, takes the lazy iterator, and is untouched by this. Both lazy loop bodies stay
 * byte for byte the code they were, which is what `start-filtered-hop-values.ts` requires: a
 * dedicated single-gate LOOP measured WORSE there (719.7 -> 731, `both` 458 -> 507) and items
 * 1441/1466 measured an edit to a hot values walk at up to 16% on unrelated rows.
 *
 * ⚠️ ORDER IS PRESERVED BY CONSTRUCTION, WHICH THIS ROUTE REQUIRES ABSOLUTELY. Gremlin streams are
 * compared ORDERED by the differential fuzzer (unlike GQL rows, whose order is unspecified), and
 * `start-filtered-hop-values.ts` states the limit in terms: "any cleverer structure — walking the
 * edge index once, hoisting the far side — is a cross-engine failure and not an optimization".
 * `chainCsrFor` numbers slots by `graph.verticesById` iteration order and fills each slot's run from
 * that vertex's own bucket in set order, so walking slots in order and each run in order emits the
 * identical sequence to the generator walk. Nothing is hoisted across vertices.
 */
import type { Graph, Vertex } from '@lenke/core';

import { chainCsrFor } from './count-shortcut.js';

/**
 * ⚠️ A LEAF MODULE, which is why `Gate` is declared here rather than imported. The obvious import is
 * `survives`/`Gate` from `start-filtered-hop-values.ts` — and that file imports THIS one, so the
 * import is a cycle and `import/no-cycle` is an error here. Same shape as `csr-cache.ts` on the GQL
 * side, which `var-length-count.ts` forced into a leaf for the same reason. The gate loop is four
 * lines; a shared four-line loop is not worth a cycle.
 */
type Gate = (v: Vertex) => boolean;

const allPass = (v: Vertex, tests: readonly Gate[]): boolean => {
  for (const gate of tests) {
    if (!gate(v)) {
      return false;
    }
  }

  return true;
};

/**
 * ⚠️ THERE IS NO ELIGIBILITY PREDICATE HERE, AND ITS ABSENCE IS THE POINT.
 *
 * The first draft had one, `farMaskDrainApplies({ both, fastKey })`, with its own unit test — and a
 * mutation that made it ALWAYS APPLY survived, because the call site passed two literal constants:
 * `both: false` (this arm lives in the `out`/`in` branch, which the `both` hop returns before
 * reaching) and `fastKey: true` (implied by the mask state being set at all). A predicate that
 * cannot decline is decoration, and a unit test for it passes vacuously while reading like coverage
 * — the same shape as the dead seed branch item 1688 removed after a mutant survived it.
 *
 * So the guard is the real condition at the call site, and the two exclusions are recorded where
 * they actually happen:
 *
 *   `both`  — that hop walks a vertex's OUT bucket then its IN bucket, so its order spans two
 *             directions per vertex where one CSR run holds one, and it carries the self-loop rule
 *             items 1092/1093 settled (ISO-GQL emits an undirected self-loop once where Gremlin's
 *             `both()` yields it twice). Its branch returns before this module is reached.
 *   a non-specialized far filter — a `hasLabel`, or more than one filter, keeps the general path;
 *             the mask state is only built for the single-`has` shape
 *             `start-filtered-hop-values.ts` already collapses into one closure.
 */

/**
 * The drain, as mark / resolve / emit over a `topologyVersion`-keyed CSR.
 *
 * `inner` is the projection with the filter NOT folded in — the arm applies the filter from its mask
 * instead, so the per-edge work is one `Int32Array` read and one `Uint8Array` read.
 */
export const farMaskDrain = (spec: {
  graph: Graph;
  forward: boolean;
  type: string;
  tests: readonly Gate[];
  inner: (far: { readonly id: string; readonly properties: Record<string, unknown> }) => unknown;
  drops: boolean;
  key: string;
  fast: (value: unknown) => boolean;
}): unknown[] => {
  const { graph, forward, type, tests, inner, drops, key, fast } = spec;
  const { vtx, memo } = chainCsrFor(graph, forward, [type]);
  const n = vtx.length;
  const accept = new Uint8Array(n);
  const live = new Uint8Array(n);

  // 1. RESOLVE the far filter once per vertex, and the start filters once per source.
  for (let s = 0; s < n; s += 1) {
    const v = vtx[s];

    live[s] = tests.length === 0 || allPass(v, tests) ? 1 : 0;

    if (fast(v.properties[key])) {
      accept[s] = 1;
    }
  }

  // 2. EMIT, in slot order then run order — the generator walk's own sequence.
  const acc: unknown[] = [];

  for (let s = 0; s < n; s += 1) {
    if (live[s] === 0) {
      continue;
    }

    const base = memo.off[s];
    const end = base + memo.len[s];

    for (let i = base; i < end; i += 1) {
      const far = memo.flat[i];

      if (accept[far] === 0) {
        continue;
      }

      const value = inner(vtx[far]);

      if (!drops || value !== undefined) {
        acc.push(value);
      }
    }
  }

  return acc;
};

/** Exported for the arm's own tests: the slot order the emit pass walks. */
export const farMaskSlotOrder = (graph: Graph, forward: boolean, type: string): Vertex[] => {
  const { vtx } = chainCsrFor(graph, forward, [type]);

  return [...vtx];
};
