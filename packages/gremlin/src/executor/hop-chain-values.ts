import type { Graph, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { collectVertexFilters } from './count-shortcut.js';
import type { HopValues } from './hop-values.js';
import { compileGates, isVertexFilterStep, survives } from './start-filtered-hop-values.js';

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
 * EXACTLY TWO HOPS, SINGLE-NAMED-TYPE, NON-`both` — a deliberate specialization, for `pairTypes`'
 * stated reason in `hop-values.ts`: a general N is a loop over a stack of iterators, which is the
 * per-vertex array that branch measured as the whole cost of the general form. Three hops are
 * priced and left open — the hand floor is **59.12 ms against the pipeline's 381.37 at 1,279,840
 * rows, 6.45x**, essentially this item's own ratio, so the lever is real; it is a second
 * measurement rather than a free extension of this one.
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
   * EXACTLY TWO hops, anywhere in the plan — filters may sit before, between and after them. A
   * `both` declines outright (its contract is out-bucket then in-bucket per vertex), and a THIRD hop
   * declines rather than riding as a residual: the residual would be a hop over bare VALUES, which
   * is not a traversable element, so admitting it would be wrong and not merely slow.
   *
   * ⚠️ ALL THREE CHECKS BELOW ARE REDUNDANT, and the mutants prove it rather than the reasoning
   * doing so — item 475's rule is that a survivor on a new guard means "redundant" as readily as
   * "untested", and the two have opposite fixes. Each is caught downstream:
   *
   *   - `both` — `singleTypeHop` admits only `out`/`in`, so a `both` is never pushed to `hops`; the
   *     plan then has the wrong hop count, or the `both` lands in a filter run where
   *     `collectVertexFilters` refuses it.
   *   - a THIRD hop — `hops.length !== 2` below rejects three.
   *   - `hops.length !== 2` ITSELF — at 0 or 1 hops the destructure leaves `i1` undefined and
   *     `singleTypeHop(steps[undefined])` declines.
   *
   * Kept because together they state the rung's SHAPE where a reader looks for it, at one pass over
   * a handful of steps per query, and because each one's redundancy depends on a DIFFERENT distant
   * fact — exactly the coupling that breaks silently when one of them is widened.
   */
  const hops: number[] = [];

  for (let i = 1; i < steps.length; i += 1) {
    const k = steps[i].kind;

    if (k === 'both') {
      return undefined;
    }

    if (k === 'out' || k === 'in') {
      if (hops.length === 2) {
        return undefined;
      }

      hops.push(i);
    }
  }

  if (hops.length !== 2) {
    return undefined;
  }

  const [i0, i1] = hops;
  const first = singleTypeHop(steps[i0]);
  const second = singleTypeHop(steps[i1]);

  if (first === undefined || second === undefined) {
    return undefined;
  }

  /**
   * THE THREE FILTER RUNS (item 1615): before the first hop, between the hops, and after the second.
   *
   * ⚠️ `refuseSeekable` IS TRUE FOR THE LEAD RUN ONLY, and the asymmetry is `collectVertexFilters`'
   * own, stated at item 1603: the refusal exists because a seek seeds the SOURCE and the values
   * shortcuts run before `seedFromIndex`, so a walk that scanned would preempt a better route.
   * Nothing seeds from the far side of a hop — `seedForStep` reads the source step — so refusing
   * there would decline the shape on every indexed graph and gain nothing. The MIDDLE run is a far
   * side too, which is the same split `interleavedHopChainCount` makes for its interior run.
   */
  const leadF = collectVertexFilters(steps.slice(1, i0), graph);
  const midF = collectVertexFilters(steps.slice(i0 + 1, i1), graph, false);
  // The far run ends at the first step that is not a vertex filter — the projection, or the residual.
  let farEnd = i1 + 1;

  while (farEnd < steps.length && isVertexFilterStep(steps[farEnd])) {
    farEnd += 1;
  }

  const farF = collectVertexFilters(steps.slice(i1 + 1, farEnd), graph, false);

  if (leadF === undefined || midF === undefined || farF === undefined) {
    return undefined;
  }

  const tail = projectionOf(steps[farEnd]);

  if (tail === undefined) {
    return undefined;
  }

  const { pick, drops, consumed } = tail;
  const rest = steps.slice(farEnd + consumed);
  const [t0, fwd0] = first;
  const [t1, fwd1] = second;
  /**
   * COMPILED ONCE PER PLAN, and the `any*` booleans keep the unfiltered walk at its item-1614 cost:
   * with no filters in a position there is no call at all, not a call over an empty array. That is
   * item 1602's `anyStart` split, and it is what makes the three controls below flat.
   *
   * `compileGates` is `start-filtered-hop-values.ts`'s, exported rather than reimplemented — it is
   * worth 1.93x on the label side and 1.16x on the predicate side (items 1536/1492), and a second
   * copy of a specialization table is exactly the drift this executor keeps paying for.
   */
  const leadGates = compileGates(leadF);
  const midGates = compileGates(midF);
  const farGates = compileGates(farF);
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
