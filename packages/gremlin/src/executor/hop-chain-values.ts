import type { Edge, Graph, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { collectVertexFilters } from './count-shortcut.js';
import type { HopValues, HopWalk } from './hop-values.js';
import {
  type Gate,
  compileGates,
  isVertexFilterStep,
  survives,
} from './start-filtered-hop-values.js';

/**
 * `V().out(T).out(T).values(k)` — TWO hops answered by one nested walk instead of the traverser
 * pipeline (item 1614).
 *
 * ⚠️ A STRUCTURAL HOLE, not a known cost, and the reason it survived this long is worth stating:
 * EVERY two-hop shape in the profile corpus ends in `count()`, which `hopChainCount` answers from
 * degrees without walking at all (item 590). So the two-hop WALK had only ever been profiled in the
 * arm where it does not run. `hopValuesShortcut` takes `[V, hop, proj]` and declines at a second
 * hop, so one extra `out` dropped the whole query onto the pipeline:
 *
 * ```text
 *    V().out(E).values(k)              2.07 ms   79996 rows    25.9 ns/row   <- the fused walk
 *    V().out(E).out(E).values(k)      81.47     319972        254.6          <- the pipeline
 *    V().out(E).out(E).id()           76.01     319972        237.6
 *    the same nested walk BY HAND     12.25     319972         38.3          <- THE FLOOR
 *    ... id by hand                   11.23     319972         35.1
 * ```
 *
 * 6.65x of headroom, and the floor's per-row sits beside the ONE-hop fused walk's 25.9 — so the
 * fusion generalizes rather than merely applying twice. The profiles say the same thing: the one-hop
 * shape's frames are `drain` 15.9% and `pick` 8.9%, the two-hop shape's are `iterLabeled` 19.3%,
 * `otherEndpoint` 14.8%, `traverseToVertex` 11.3%, `unwrap` 3.1%, `extend` 1.6% — a different
 * machine entirely, not the same one doing twice the work.
 *
 * ORDER IS TINKERPOP'S OWN, by construction: `out` flatMaps per traverser, so the row sequence is
 * the depth-first nesting written literally below — per vertex, per out-edge in bucket order, per
 * out-edge of that far end. Gremlin streams are compared ORDERED by the differential fuzzer (unlike
 * GQL rows), so any cleverer structure — walking the edge index once, hoisting the far side — is a
 * cross-engine failure and not an optimization. That is the same limit items 167, 1431 and 1432 each
 * recorded; this walk removes DELEGATION only.
 *
 * ⚠️ NO DEDUPLICATION, and that is the contract rather than an omission. Two different paths reaching
 * the same far vertex are two rows, and a self-loop is a legitimate step. `dedupe()` would appear in
 * `rest` and run over the values, exactly as it does for the one-hop walk.
 *
 * NO MULTI-TYPE GUARD IS NEEDED because nothing is summed — each hop reads its own single bucket per
 * vertex, so a type appearing twice cannot double-count the way `degreeOfTypes` can (the guard
 * `hopChainShape` carries, for the COUNT rungs).
 *
 * ⚠️ AND A FILTER IN ANY OF THE THREE POSITIONS (item 1615), which this rung declined on its first
 * day and which left the only two shapes `gremlin-cliff-finder.ts` still read as `pipeline`. Both
 * profiles are the same delegation chain the walk above removes — `iterLabeled` + `iterByLabel` +
 * `outEdgesOf` + `otherEndpoint` + `traverseToVertex` is **53.7%** of the trailing shape and
 * **49.7%** of the mid one. The same instrument, PRE by reverting this file to its item-1614 state:
 *
 * ```text
 *    arm                              PRE      POST    verdict
 *    2 hop + TRAILING has, values   79.18    20.27     3.91x
 *    2 hop + MID has, values        45.44    16.93     2.68x
 *    2 hop + LEAD has, values       44.49    16.96     2.62x
 *    2 hop values  (no filter)      15.77    16.15     flat (control)
 *    2 hop id      (no filter)      11.69    11.70     flat (control)
 *    1 hop values                    2.23     2.47     flat (control)
 *    3 hop values  (declined)      385.60   361.18     flat (control)
 * ```
 *
 * The trailing shape cost **4.7x its own unfiltered neighbour for FIFTY TIMES FEWER ROWS** before
 * this, because it walked every traverser down the pipeline and filtered at the end. The three
 * unfiltered controls are flat because the `any*` booleans mean no call at all where a position has
 * no filter — item 1602's `anyStart` split.
 *
 * ⚠️ AND ANY DEPTH SINCE ITEM 1617 — three hops yielding went **3772.5 to 1047.6 ms on the
 * 1,000,000-edge bench (3.60x), from 3.3x behind native to PARITY (ts/nat 1.0)**, and 394.89 to
 * 103.79 on the isolated 20,000x4 probe (3.80x). Every other row in the sweep is flat. Depth 3 and
 * up take `stackedWalk` below; depth 2 keeps the literal nesting here because replacing it with the
 * stack measured a **1.29x regression** on the commonest shape in the family.
 *
 * ~~EXACTLY TWO HOPS~~ SINGLE-NAMED-TYPE, NON-`both` — a deliberate specialization, for `pairTypes`'
 * stated reason in `hop-values.ts`: a general N is a loop over a stack of iterators, which is the
 * per-vertex array that branch measured as the whole cost of the general form. Three hops are
 * ~~priced and left open~~ — **TAKEN AT ITEM 1617** (3.60x on the bench, 3.80x isolated). The hand
 * floor that priced it was 59.12 ms against the pipeline's 381.37 at 1,279,840 rows, 6.45x; the
 * shipped stacked walk reads 103.79, which is 1.36x its own floor and the same residual the depth-2
 * walk pays.
 */
export const hopChainValuesShortcut = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  // `V` + two hops at the very least.
  if (steps.length < 3) {
    return undefined;
  }

  const [source] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — `hopValuesShortcut`'s own refusal.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  /**
   * TWO OR MORE hops, anywhere in the plan, with a filter run between each neighbouring pair.
   *
   * A `both` declines outright (its contract is out-bucket then in-bucket per vertex, so nesting two
   * of them is four interleaved orders rather than one). The hop COUNT was capped at two until item
   * 1617 lifted it; see `stackedWalk` below for why depth 2 still gets its own loop.
   *
   * ⚠️ THE `both` CHECK IS REDUNDANT, and the mutant proves it rather than the reasoning doing so —
   * item 475's rule is that a survivor on a new guard means "redundant" as readily as "untested",
   * and the two have opposite fixes. `singleTypeHop` admits only `out`/`in`, so a `both` is never
   * pushed to `hops`; it then lands in a filter run, where `collectVertexFilters` refuses it. Kept
   * because it states the rung's shape where a reader looks for it, at one test per step per query.
   */
  const at: number[] = [];

  for (let i = 1; i < steps.length; i += 1) {
    const k = steps[i].kind;

    if (k === 'both') {
      return undefined;
    }

    if (k === 'out' || k === 'in') {
      at.push(i);
    }
  }

  if (at.length < 2) {
    return undefined; // one hop is `hopValuesShortcut`'s and `startFilteredHopValues`' shape
  }

  const hops: (readonly [string, boolean])[] = [];

  for (const i of at) {
    const h = singleTypeHop(steps[i]);

    if (h === undefined) {
      return undefined;
    }

    hops.push(h);
  }

  /**
   * ONE FILTER RUN BETWEEN EACH NEIGHBOURING PAIR — `at.length + 1` of them: before the first hop,
   * between each two, and after the last.
   *
   * ⚠️ `refuseSeekable` IS TRUE FOR THE LEAD RUN ONLY, and the asymmetry is `collectVertexFilters`'
   * own, stated at item 1603: the refusal exists because a seek seeds the SOURCE and the values
   * shortcuts run before `seedFromIndex`, so a walk that scanned would preempt a better route.
   * Nothing seeds from the far side of a hop — `seedForStep` reads the source step — so refusing
   * there would decline the shape on every indexed graph and gain nothing. Every INTERIOR run is a
   * far side too, which is the same split `interleavedHopChainCount` makes for its interior run.
   */
  const last = at[at.length - 1];
  // The final run ends at the first step that is not a vertex filter — the projection, or the residual.
  let farEnd = last + 1;

  while (farEnd < steps.length && isVertexFilterStep(steps[farEnd])) {
    farEnd += 1;
  }

  const runs: Gate[][] = [];

  for (let h = 0; h <= at.length; h += 1) {
    const from = h === 0 ? 1 : at[h - 1] + 1;
    const to = h === at.length ? farEnd : at[h];
    // ⚠️ `h === 0` — the LEAD run refuses a seekable `has`, every interior and trailing run admits
    // one. I wrote this `h !== 0` and item 1615's index test caught it immediately, which is the
    // only reason that test exists.
    const f = collectVertexFilters(steps.slice(from, to), graph, h === 0);

    if (f === undefined) {
      return undefined;
    }

    runs.push(compileGates(f));
  }

  const tail = projectionOf(steps[farEnd]);

  if (tail === undefined) {
    return undefined;
  }

  const { pick, drops, consumed } = tail;
  const rest = steps.slice(farEnd + consumed);

  if (walkKindFor(at.length) === 'stacked') {
    return { rest, values: stackedWalk(graph, hops, runs, pick, drops) };
  }

  const [[t0, fwd0], [t1, fwd1]] = hops;
  const [leadGates, midGates, farGates] = runs;
  /**
   * The `any*` booleans keep the unfiltered walk at its item-1614 cost: with no filters in a
   * position there is no call at all, not a call over an empty array. That is item 1602's `anyStart`
   * split, and it is what makes the unfiltered controls flat.
   *
   * `compileGates` (called in the parse above) is `start-filtered-hop-values.ts`'s, exported rather
   * than reimplemented — it is worth 1.93x on the label side and 1.16x on the predicate side (items
   * 1536/1492), and a second copy of a specialization table is exactly the drift this executor keeps
   * paying for.
   */
  const anyLead = leadGates.length > 0;
  const anyMid = midGates.length > 0;
  const anyFar = farGates.length > 0;

  /**
   * ⚠️ WRITTEN TWICE, LAZY AND EAGER, AS THE SAME LOOP — `hop-values.ts`'s rule, for its reason:
   * `run` returns an iterable a caller may `break` out of, so the walk stays lazy, while `toArray`
   * is `[...run(…)]` and already drains it in full, where the eager form is the same answer by a
   * cheaper route (item 1412 measured 53.8% on `V().out(E)`). `drain` is read only when `rest` is
   * empty, so no downstream step has to be reasoned about.
   *
   * A second DERIVATION is what must not happen, and does not: both loops nest the identical two
   * bucket reads in the identical order.
   */
  return {
    rest,
    values: {
      *[Symbol.iterator]() {
        for (const v of graph.vertices) {
          if (anyLead && !survives(v, leadGates)) {
            continue;
          }

          const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

          if (b0 === undefined) {
            continue;
          }

          for (const e0 of b0) {
            const midV = fwd0 ? e0.to : e0.from;

            if (anyMid && !survives(midV, midGates)) {
              continue;
            }

            const b1 = (fwd1 ? midV.adjFrom : midV.adjTo)?.get(t1);

            if (b1 === undefined) {
              continue;
            }

            for (const e1 of b1) {
              const farV = fwd1 ? e1.to : e1.from;

              if (anyFar && !survives(farV, farGates)) {
                continue;
              }

              const value = pick(farV);

              if (!drops || value !== undefined) {
                yield value;
              }
            }
          }
        }
      },
      drain() {
        const acc: unknown[] = [];

        for (const v of graph.vertices) {
          if (anyLead && !survives(v, leadGates)) {
            continue;
          }

          const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

          if (b0 === undefined) {
            continue;
          }

          for (const e0 of b0) {
            const midV = fwd0 ? e0.to : e0.from;

            if (anyMid && !survives(midV, midGates)) {
              continue;
            }

            const b1 = (fwd1 ? midV.adjFrom : midV.adjTo)?.get(t1);

            if (b1 === undefined) {
              continue;
            }

            for (const e1 of b1) {
              const farV = fwd1 ? e1.to : e1.from;

              if (anyFar && !survives(farV, farGates)) {
                continue;
              }

              const value = pick(farV);

              if (!drops || value !== undefined) {
                acc.push(value);
              }
            }
          }
        }

        return acc;
      },
    },
  };
};

/**
 * WHICH WALK A GIVEN HOP COUNT GETS. Depth 2 has its own literal nesting; 3 and up share the generic
 * stack.
 *
 * ⚠️ EXTRACTED AS A PURE FUNCTION BECAUSE A ROUTE CHOICE IS ANSWER-EQUIVALENT, so no differential
 * test can pin it — the mutant that sent depth 2 through the stack SURVIVED the whole suite, exactly
 * as `perf-gate-needs-its-own-test` says it would. The threshold is the only thing here that is a
 * PERFORMANCE claim rather than a correctness one, so it is unit-tested directly in
 * `hop-chain-values.test.ts`, with the numbers that chose it recorded on `stackedWalk` below.
 *
 * ⚠️ WHAT THE EXTRACTION BUYS IS NOT A GUARD AT THE CALL SITE. A mutant that inlines `at.length > 2`
 * back into the caller SURVIVES, and must: it is the same predicate written out, equivalent in both
 * answer and speed. What dies instead is a changed THRESHOLD — `hops > 1` and `hops > 3` are each
 * caught by this function's own test, where neither was caught by anything before the extraction.
 */
export const walkKindFor = (hops: number): 'literal' | 'stacked' =>
  hops > 2 ? 'stacked' : 'literal';

/**
 * ⚠️ THE GENERIC WALK, ANY DEPTH — a STACK of bucket iterators rather than a nesting level per hop
 * (item 1617). Used at depth 3 and above; depth 2 keeps its literal nesting, and the split is
 * MEASURED rather than assumed.
 *
 * `hop-chain-depth-floor.ts` prices both shapes by hand, outside the engine so neither inherits the
 * other's inlining (items 1413/1440 measured an in-file A/B moving unrelated branches ~16% in an
 * arbitrary direction, which is why the pricing happens there):
 *
 * ```text
 *    depth 2  LITERAL nesting      13.06 ms    319972 rows    40.8 ns/row
 *    depth 2  ITERATOR STACK       16.87                      52.7          1.29x the literal
 *    depth 2  the engine           15.86                      49.6
 *    depth 3  LITERAL nesting      64.36      1279840         50.3
 *    depth 3  ITERATOR STACK       82.29                      64.3          1.28x the literal
 *    depth 3  the engine          394.89                     308.5          <- the pipeline
 * ```
 *
 * So the stack costs a flat **~28%** over literal nesting at both depths, and is still **4.80x**
 * the pipeline at depth 3. Replacing the depth-2 specialization with it would therefore be a 1.29x
 * REGRESSION on the commonest shape in the family — which is why both exist, and why a fourth and
 * fifth nesting level do not: one generic loop covers every depth above the one that matters most.
 *
 * ⚠️ IT EMITS THE SAME ORDER BY CONSTRUCTION, which is the only property that could not be
 * compromised: Gremlin streams are compared ORDERED by the differential fuzzer. The stack advances
 * the deepest live iterator and descends on each non-leaf edge, which is depth-first PREORDER —
 * exactly what the nested loops produce. The tests assert that against the pipeline, element for
 * element, rather than resting on this paragraph.
 *
 * ⚠️ AND `hop-values.ts`' PRIOR AGAINST A GENERAL FORM DOES NOT APPLY HERE, which is worth stating
 * because it nearly stopped this. `pairTypes`' note says "a loop over N hoisted locals is the array
 * again", measured at item 1441 — but that array was allocated PER VERTEX, over the whole graph.
 * This one is allocated ONCE per plan and reused across every source vertex, so the cost it priced
 * is not the cost here. The 28% above is the `next()` call and the depth bookkeeping.
 */
const stackedWalk = (
  graph: Graph,
  hops: readonly (readonly [string, boolean])[],
  runs: readonly Gate[][],
  pick: (far: Vertex) => unknown,
  drops: boolean,
): HopWalk => {
  const depth = hops.length;
  const [leadGates] = runs;
  const anyLead = leadGates.length > 0;

  /**
   * ⚠️ STILL WRITTEN TWICE, and the sink closure does NOT avoid that — a generator cannot `yield`
   * from inside a callback, so the lazy side has to be its own loop whatever the eager side looks
   * like. I tried to collapse the pair here and it is not collapsible in JavaScript.
   *
   * The alternative was to drop `drain` entirely and let `toArray` spread the generator, which is
   * one loop — but item 1411 measured the generator protocol at **1.9-2.2x** and item 1412 measured
   * `drain` at **53.8%** of `V().out(E)`, so that trades a real cost for a cosmetic one. The pair
   * stays, and what makes it safe is that item 1616's screen now mutates BOTH halves of every such
   * loop in the executor: a drift between them is caught rather than reasoned about.
   */
  const [[t0, fwd0]] = hops;

  const walk = (sink: (value: unknown) => void): void => {
    /**
     * Hoisted ONCE and reused across source vertices — see the note above on why item 1441's
     * per-vertex array is a different cost.
     *
     * ⚠️ THE `length` IS A PRE-SIZING HINT ONLY, and the mutant that set it to 1 SURVIVED, correctly:
     * `its[d] = …` past the end extends a JS array, so the walk is right at any initial length. It
     * is written as `depth` so the array never grows during the walk.
     */
    const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

    for (const v of graph.vertices) {
      if (anyLead && !survives(v, leadGates)) {
        continue;
      }

      const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

      if (b0 === undefined) {
        continue;
      }

      its[0] = b0[Symbol.iterator]();

      let d = 0;

      while (d >= 0) {
        const step = its[d]!.next();

        if (step.done === true) {
          its[d] = undefined;
          d -= 1;
          continue;
        }

        const [, fwd] = hops[d];
        const far = fwd ? step.value.to : step.value.from;
        const gates = runs[d + 1];

        if (gates.length > 0 && !survives(far, gates)) {
          continue;
        }

        if (d === depth - 1) {
          const value = pick(far);

          if (!drops || value !== undefined) {
            sink(value);
          }

          continue;
        }

        const [tn, fwdn] = hops[d + 1];
        const next = (fwdn ? far.adjFrom : far.adjTo)?.get(tn);

        if (next === undefined) {
          continue;
        }

        d += 1;
        its[d] = next[Symbol.iterator]();
      }
    }
  };

  return {
    *[Symbol.iterator]() {
      const its: (Iterator<Edge> | undefined)[] = Array.from({ length: depth });

      for (const v of graph.vertices) {
        if (anyLead && !survives(v, leadGates)) {
          continue;
        }

        const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

        if (b0 === undefined) {
          continue;
        }

        its[0] = b0[Symbol.iterator]();

        let d = 0;

        while (d >= 0) {
          const step = its[d]!.next();

          if (step.done === true) {
            its[d] = undefined;
            d -= 1;
            continue;
          }

          const [, fwd] = hops[d];
          const far = fwd ? step.value.to : step.value.from;
          const gates = runs[d + 1];

          if (gates.length > 0 && !survives(far, gates)) {
            continue;
          }

          if (d === depth - 1) {
            const value = pick(far);

            if (!drops || value !== undefined) {
              yield value;
            }

            continue;
          }

          const [tn, fwdn] = hops[d + 1];
          const next = (fwdn ? far.adjFrom : far.adjTo)?.get(tn);

          if (next === undefined) {
            continue;
          }

          d += 1;
          its[d] = next[Symbol.iterator]();
        }
      }
    },
    drain() {
      const acc: unknown[] = [];

      walk((value) => acc.push(value));

      return acc;
    },
  };
};

/** One named edge type in one direction, as `[type, forward]`; `undefined` for anything else. */
const singleTypeHop = (step: Step | undefined): readonly [string, boolean] | undefined => {
  if (step === undefined || (step.kind !== 'out' && step.kind !== 'in')) {
    return undefined;
  }

  // ⚠️ `both` IS DECLINED, and by the `kind` test above rather than here: its contract is out-bucket
  // then in-bucket PER VERTEX (`iterBoth`, and `hop-values.ts`'s `bothOneType` walk), so nesting two
  // of them is four interleaved orders rather than one. A correct `both` chain is a different walk.
  return step.labels.length === 1 ? [step.labels[0], step.kind === 'out'] : undefined;
};

/** What comes off the LAST far vertex, and how many steps that consumes — `hopValuesShortcut`'s set. */
const projectionOf = (
  proj: Step | undefined,
): { pick: (far: Vertex) => unknown; drops: boolean; consumed: number } | undefined => {
  // ONE key. `values()` with no key emits every property value and `values(a, b)` fans out per key;
  // both are different shapes. A monomorphic closure chosen ONCE per plan, not a per-edge branch.
  if (proj?.kind === 'values' && proj.keys.length === 1) {
    const [key] = proj.keys;

    // `values(k)` DROPS a far vertex lacking `k`, which is why `drops` belongs to the VALUE mode and
    // not to the walk — a bare hop and `id()` drop nothing.
    return { pick: (far) => far.properties[key], drops: true, consumed: 1 };
  }

  /**
   * A bare two-hop, with nothing to project off the far end.
   *
   * ⚠️ `consumed` COUNTS PROJECTION STEPS ONLY (0 or 1) since item 1615, because `rest` is now
   * measured from the end of the far filter run rather than from the start of the plan. Item 1614's
   * version counted from the start, which was fine while the step positions were fixed and is wrong
   * the moment a filter can sit anywhere — and the off-by-one would have been SILENT on the
   * unfiltered shapes, which are exactly the ones item 1614's tests covered.
   */
  if (proj === undefined) {
    return { pick: (far) => far, drops: false, consumed: 0 };
  }

  if (proj.kind === 'id') {
    return { pick: (far) => far.id, drops: false, consumed: 1 };
  }

  // Any other step declines the whole shortcut, as `hopValuesShortcut` does: treating an
  // unrecognised step as a residual over a bare hop would re-route a family nothing has measured.
  return undefined;
};
