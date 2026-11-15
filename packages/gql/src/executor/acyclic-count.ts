import type { Graph, Vertex } from '@lenke/core';

import type { CClause, Params, Row } from './core.js';
import { csrFor } from './csr-cache.js';
import type { InlinePred } from './inline-gate.js';
import { inlineHolds } from './inline-gate.js';
import { vacuousLabel } from './labels.js';
import { seekedSeeds } from './matching.js';
import { alwaysTrue } from './shortcuts.js';

/**
 * `MATCH ACYCLIC (a)-[:T]->{m,n}(b) RETURN count(*)` — counted by a per-source DFS (item 2002).
 *
 * ⚠️⚠️ **WHY THIS IS ITS OWN MODULE AND NOT A MODE FLAG IN `var-length-count.ts`.** That file
 * answers a WALK or a TRAIL with a level-wise recurrence over `Float64Array`s plus a closed-form
 * correction, and its own header records what happens when a new mode is admitted into that
 * machinery without every bound moving together: **item 692 relaxed the detector to depth 4 and
 * left `varLengthDegreeCount`'s bound at 3, so a depth-4 trail fell through to the `max <= 2`
 * arithmetic and answered the WALK count — 3 where the trail answers 0 on a triangle.** Routing
 * ACYCLIC through `isTrail` would be that mistake deliberately: `isTrail` is `mode !== 'walk'`, so
 * an acyclic pattern would silently take the TRAIL correction and answer a trail count.
 *
 * Nothing here touches `walkLevelCount`, `varLengthDegreeCount` or `takesTheLevelRecurrence`, so
 * there is no sibling bound to leave stale.
 *
 * 🔑 **AND IT NEEDS NO INCLUSION-EXCLUSION, WHICH IS THE POINT.** Item 2001 derived a closed-form
 * acyclic correction twice and both were wrong — the first invisibly so on any graph without dense
 * self-loops (the error term was `sum(L_a^2)`, which is ~0 on the workload screen's own fixtures).
 * A DFS that carries the visited set has no correction to get wrong: acyclicity is the DFS's own
 * loop condition. `perSourceTrailCount` is the same idea one axis over — it carries visited EDGE
 * POSITIONS — so this is that function's structure with the set keyed on the vertex instead.
 *
 * ⚠️ THE THREE SEMANTICS THIS GETS RIGHT BY CONSTRUCTION, each pinned in
 * `packages/native/src/acyclic-selfloop-parity.test.ts` against the Rust engine:
 *
 *   - A SELF-LOOP is skipped, because its far end is the vertex we are standing on and that is
 *     already in `seen`. So `ACYCLIC {1,1}` over one vertex with one self-loop is 0, which is the
 *     behaviour `CLOSED.md` records as settled.
 *   - PARALLEL EDGES keep their multiplicity, because two edges `a->b` are two iterations of the
 *     `k` loop with the same `nbr[k]`, each pushing and popping `b` independently. Two rows, not
 *     one.
 *   - A 2-CYCLE `a->b->a` is rejected at the second hop, because `a` is still in `seen` — this is
 *     the case that makes ACYCLIC differ from TRAIL at all, and the only one the general matcher's
 *     600,000-path enumeration was being paid 234x to find (64 paths in 600,000, item 2001).
 */
export type AcyclicCountSpec = {
  readonly types: string[] | undefined;
  readonly min: number;
  readonly max: number;
  /** Walk the IN-adjacency instead of the out-adjacency — the mirror spelling. */
  readonly inward: boolean;
  readonly startName: string | undefined;
  /** Endpoint test, applied per REACHED endpoint — never to the store at large. */
  readonly passes: (v: Vertex) => boolean;
  /** Per-SEED test, from either spelling of a start predicate; `undefined` when there is none. */
  readonly seedPasses?: (v: Vertex) => boolean;
  /** Seeked source list when an index serves the start predicate (item 1979), else `undefined`. */
  readonly seeds?: () => readonly Vertex[] | undefined;
};

/**
 * ⚠️⚠️ **THE WORK CEILING IS A HANG GUARD, NOT A ROUTE CHOICE — and sizing it as a route choice was
 * a measured mistake** (item 2002). This started at `levels * (|V| + |E|)`, copied from
 * `perSourceBudget`, with the stated reasoning that "a route that exceeds the work the level-wise
 * recurrence would have cost has lost its reason to exist". **That reasoning is wrong for this
 * mode, and the number proved it: the UNSEEDED count — the 520x case this route was built for —
 * declined on the budget and stayed at 869 ms, while the seeded case took the route and went
 * 15.28 -> 1.05 ms.** At 40,000 vertices and fanout 5 the DFS does `40000 * (5 + 25)` = 1.2M edge
 * steps against a budget of `2 * 240000` = 480k.
 *
 * The comparator was the error. `perSourceBudget` guards a route whose ALTERNATIVE is the level
 * recurrence, so "costs more than the recurrence" means "take the recurrence". ACYCLIC has no
 * recurrence — `var-length-count.ts` refuses the mode outright — so the alternative is the general
 * clause loop, which **enumerates exactly the same paths** and allocates a binding `Map` for each
 * one. There is no crossover to find: the DFS visits the same path set with strictly less work per
 * path, so it is never the worse choice and a budget derived from a cheaper arm is bounding against
 * an arm that does not exist.
 *
 * So the ceiling is deliberately generous, and its only job is to refuse to sit in a DFS whose path
 * count is astronomical — a case where the general loop would not finish either, but where
 * declining at least returns control. ⚠️ It is NOT a performance tuning knob: lowering it cannot
 * make any query faster, it can only send a query back to the slower arm.
 */
const WORK_FACTOR = 64;

const budgetFor = (max: number, vertices: number, edges: number): number =>
  Math.max(max, WORK_FACTOR) * (vertices + edges);

/**
 * Count acyclic paths from `src`, or `undefined` if the budget blows.
 *
 * ⚠️ `seen` IS ONE SET REUSED ACROSS SOURCES, cleared per source rather than reallocated — the
 * per-frame-allocation lever this repo has rejected before ([[closed-perf-targets]], the per-frame
 * adjacency hash at item 172). A `Set` per source would allocate |sources| of them for a walk that
 * is already the cheap arm.
 *
 * ⚠️ AND IT IS A `Set<number>` OF CSR SLOTS, not of `Vertex` objects: slots are small integers so
 * the set is monomorphic, and `order[slot]` recovers the vertex only where a predicate needs it.
 */
export const acyclicPerSourceCount = (graph: Graph, spec: AcyclicCountSpec): number | undefined => {
  const { types, min, max, inward, startName, passes, seedPasses } = spec;
  const { order, idx, off, nbr } = csrFor(graph, inward, types);
  const seeked = spec.seeds?.();
  const unfiltered =
    seeked ?? (startName === undefined ? order : [...(graph.verticesByLabel.get(startName) ?? [])]);
  const src = seedPasses === undefined ? unfiltered : unfiltered.filter((v) => seedPasses(v));
  const budget = budgetFor(max, order.length, nbr.length);
  const seen = new Set<number>();
  let work = 0;
  let total = 0;
  let blown = false;

  const extend = (v: number, len: number): void => {
    // ⚠️ THE ENDPOINT TEST IS APPLIED AT EVERY ADMISSIBLE LENGTH, not only at `max`. A quantified
    // `{1,3}` counts paths of length 1, 2 AND 3, so each is a row of its own and each must be
    // tested — counting only the deepest is the off-by-a-whole-level this shape invites.
    if (len >= 1 && len >= min && passes(order[v])) {
      total += 1;
    }

    if (len === max) {
      return;
    }

    const end = off[v + 1];

    work += end - off[v];

    if (work > budget) {
      blown = true;

      return;
    }

    for (let k = off[v]; k < end; k += 1) {
      const w = nbr[k];

      // THE WHOLE RESTRICTION, and the reason no correction term is needed: a far end already on
      // the current path is not a candidate. A self-loop fails this against the vertex itself.
      if (seen.has(w)) {
        continue;
      }

      seen.add(w);
      extend(w, len + 1);
      seen.delete(w);

      if (blown) {
        return;
      }
    }
  };

  for (const s of src) {
    /*
     * ⚠️ `idx.get` CANNOT MISS, and a guard here was DELETED at item 2004 after two false
     * justifications. `csrFor` builds `order` from `[...graph.verticesById.values()]`, so every
     * vertex has a slot — an isolated one and one carrying only another edge type included, which is
     * what the guard's note claimed made it reachable. Its second justification, a staleness window,
     * is false too: `topologyVersion` advances SYNCHRONOUSLY and exists so an adjacency structure
     * CAN be cached (`topology-version.test.ts`, item 1571). A seed absent from `verticesById` would
     * be an index-maintenance bug, to fix at the index rather than mask in a walk.
     */
    const slot = idx.get(s)!;

    seen.clear();
    seen.add(slot);
    extend(slot, 0);

    if (blown) {
      return undefined;
    }
  }

  return total;
};

/**
 * The detector's ACYCLIC arm: `detectVarLengthCount`'s closure for this mode (item 2002).
 *
 * ⚠️ IT LIVES HERE AND NOT IN `var-length-count.ts` FOR TWO REASONS, one architectural and one
 * mechanical. Architecturally, nothing about ACYCLIC belongs in the file that owns the walk/trail
 * arithmetic — that separation is what guarantees no shared bound can be left stale, which is the
 * failure item 692 recorded. Mechanically, written inline it took `detectVarLengthCount` to a lint
 * complexity of 38 against a cap of 35, the cap that file's own note warns is already reached.
 *
 * ⚠️ THE CLOSURE MAY RETURN `undefined`, which is the runtime decline `clauses.ts` documents as this
 * rung's privilege (item 1399) — it falls through to the general clause loop, the arm that serves
 * this mode today, so a decline is a no-op rather than a regression.
 */
export const acyclicCountRow = (args: {
  readonly types: string[] | undefined;
  readonly min: number;
  readonly max: number;
  readonly inward: boolean;
  readonly column: string;
  readonly endLabel: { kind: 'label'; name: string } | undefined;
  readonly endPred: InlinePred | undefined;
  readonly startPred: InlinePred | undefined;
  readonly startLabel: { kind: 'label'; name: string } | undefined;
  readonly compiled: CClause | undefined;
}): ((graph: Graph, params: Params) => Row[] | undefined) => {
  const { types, min, max, inward, column, endLabel, endPred, startPred, startLabel, compiled } =
    args;

  return (graph, params) => {
    // A VACUOUS endpoint label costs a per-element test that cannot fail, so it is dropped — the
    // same `vacuousLabel` question every rung in this family asks, and it is a GRAPH property, so
    // this is the earliest point it can be asked.
    const eff = endLabel === undefined || vacuousLabel(graph, endLabel) ? undefined : endLabel.name;
    // ONE binding map reused across elements: `inlineHolds` writes the node's OWN variable, and a
    // pattern's start and endpoint are necessarily different variables, so the two tests write
    // different keys and cannot overwrite each other.
    const binding = new Map<string, unknown>();
    const passes = acyclicPasses(endPred, eff, binding, params, graph);
    const seedPasses =
      startPred === undefined
        ? undefined
        : (v: Vertex): boolean => inlineHolds(startPred, v, binding, params, graph);
    const n = acyclicPerSourceCount(graph, {
      types,
      min,
      max,
      inward,
      startName: startLabel?.name,
      passes,
      seedPasses,
      /*
       * ⚠️ THE **COMPILED** NODE, not the AST one — which is what makes all three seed spellings
       * seek (item 1979). `compileLinear` attaches a clause `WHERE` reading the start to the
       * compiled node as `pred`/`seedHints`, so one call finds the same index candidate for
       * `WHERE a.n = $p`, `(a {n: $p})` and `(a WHERE a.n = $p)` alike.
       *
       * ⚠️ Only when there IS a start predicate: a node without one has nothing to seek, and
       * `seekedSeeds` returning `undefined` is what keeps the label-extent path for that case
       * (routing it through the seeker's generator instead cost 1.37-1.72x at item 1979).
       */
      seeds:
        startPred === undefined
          ? undefined
          : (): readonly Vertex[] | undefined =>
              compiled?.kind === 'match' && compiled.patterns.length === 1
                ? seekedSeeds(graph, compiled.patterns[0].start, new Map(), params)
                : undefined,
    });

    return n === undefined ? undefined : [{ [column]: n }];
  };
};

/** The endpoint test, composed once per query from the label and the carried predicate. */
const acyclicPasses = (
  endPred: InlinePred | undefined,
  eff: string | undefined,
  binding: Map<string, unknown>,
  params: Params,
  graph: Graph,
): ((v: Vertex) => boolean) => {
  if (endPred === undefined) {
    return eff === undefined ? alwaysTrue : (v: Vertex): boolean => v.labels.has(eff);
  }

  return eff === undefined
    ? (v: Vertex): boolean => inlineHolds(endPred, v, binding, params, graph)
    : (v: Vertex): boolean => v.labels.has(eff) && inlineHolds(endPred, v, binding, params, graph);
};
