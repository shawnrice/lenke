import type { Graph, Vertex } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import type { HopValues } from './hop-values.js';

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
 * EXACTLY TWO HOPS, SINGLE-NAMED-TYPE, NON-`both` — a deliberate specialization, for `pairTypes`'
 * stated reason in `hop-values.ts`: a general N is a loop over a stack of iterators, which is the
 * per-vertex array that branch measured as the whole cost of the general form. Three hops are
 * priced and left open — the hand floor is **59.12 ms against the pipeline's 381.37 at 1,279,840
 * rows, 6.45x**, essentially this item's own ratio, so the lever is real; it is a second
 * measurement rather than a free extension of this one.
 */
export const hopChainValuesShortcut = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 3) {
    return undefined;
  }

  const [source, h0, h1, proj] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — `hopValuesShortcut`'s own refusal.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  const first = singleTypeHop(h0);
  const second = singleTypeHop(h1);

  if (first === undefined || second === undefined) {
    return undefined;
  }

  /**
   * A THIRD hop declines the whole shortcut rather than riding as a residual: the residual would be
   * a hop over bare VALUES, which is not a traversable element, so admitting it would be wrong and
   * not merely slow.
   *
   * ⚠️ REDUNDANT, not untested — the mutant SURVIVED, and the reason is `projectionOf` below: a
   * third hop arrives there as `proj`, matches none of its three arms and falls to its closing
   * `return undefined`, so the shortcut declines either way. Kept because it states the rung's ARITY
   * where a reader looks for it, at one test per query, and because the two readings have opposite
   * fixes (item 475).
   */
  if (steps[3]?.kind === 'out' || steps[3]?.kind === 'in' || steps[3]?.kind === 'both') {
    return undefined;
  }

  const tail = projectionOf(proj);

  if (tail === undefined) {
    return undefined;
  }

  const { pick, drops, consumed } = tail;
  const rest = steps.slice(consumed);
  const [t0, fwd0] = first;
  const [t1, fwd1] = second;

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
          const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

          if (b0 === undefined) {
            continue;
          }

          for (const e0 of b0) {
            const mid = fwd0 ? e0.to : e0.from;
            const b1 = (fwd1 ? mid.adjFrom : mid.adjTo)?.get(t1);

            if (b1 === undefined) {
              continue;
            }

            for (const e1 of b1) {
              const value = pick(fwd1 ? e1.to : e1.from);

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
          const b0 = (fwd0 ? v.adjFrom : v.adjTo)?.get(t0);

          if (b0 === undefined) {
            continue;
          }

          for (const e0 of b0) {
            const mid = fwd0 ? e0.to : e0.from;
            const b1 = (fwd1 ? mid.adjFrom : mid.adjTo)?.get(t1);

            if (b1 === undefined) {
              continue;
            }

            for (const e1 of b1) {
              const value = pick(fwd1 ? e1.to : e1.from);

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
    return { pick: (far) => far.properties[key], drops: true, consumed: 4 };
  }

  /**
   * A bare two-hop. ⚠️ `consumed: 3` here is UNOBSERVABLE and the mutant to 4 SURVIVED, correctly:
   * this arm is reached only when `steps[3]` is `undefined`, which means `steps.length === 3`, where
   * `slice(3)` and `slice(4)` are both empty. It is written as 3 because that is the step count this
   * arm consumed, not because anything distinguishes it.
   */
  if (proj === undefined) {
    return { pick: (far) => far, drops: false, consumed: 3 };
  }

  if (proj.kind === 'id') {
    return { pick: (far) => far.id, drops: false, consumed: 4 };
  }

  // Any other step declines the whole shortcut, as `hopValuesShortcut` does: treating an
  // unrecognised step as a residual over a bare hop would re-route a family nothing has measured.
  return undefined;
};
