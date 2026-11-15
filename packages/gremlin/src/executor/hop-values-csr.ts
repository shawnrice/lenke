import type { Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { chainCsrFor } from './count-shortcut.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { seenBefore } from './second-ask.js';

/**
 * `V().out(T).values(k)` over the CSR — the ONE-hop twin of the walk the TWO-hop rung has used since
 * item 1680 (item 1889).
 *
 * ⚠️⚠️ **THE TWO-HOP WALK IS 6.4x CHEAPER PER ROW THAN THE ONE-HOP WALK AT SCALE, WHILE DOING FOUR
 * TIMES THE ROWS.** That is the finding, and it is only visible at size — CLAUDE.md's "sweep the
 * size: cache-resident and not are different questions; the transition is between 200k and 1M
 * elements". Isolated, one shape per process, 200,000 vertices / 1,000,000 edges, median of 9:
 *
 * ```text
 *   V().out(E).values(n)              81.31 ms     800,000 rows   102 ns a row
 *   V().out(E).out(E).values(n)       51.45      3,200,000         16          ⬅ FOUR times the
 *                                                                                 rows, a sixth of
 *                                                                                 the per-row cost
 *   V().optional(out(E)).values(n)   174.13        800,000        218
 * ```
 *
 * At the screens' usual 20,000 vertices the same two shapes read 54 and 17 ns a row — a third of the
 * gap — which is why six items of work on this surface never surfaced it. `hopValuesShortcut` walks
 * `v.adjFrom.get(T)` per vertex: a `Map` lookup and a `Set` iteration per vertex, both pointer-chasing
 * structures. `hopChainValuesShortcut` walks `chainCsrFor`'s flat `Int32Array` of neighbour SLOTS,
 * which is sequential memory. At 200,000 vertices the difference stops being a constant factor.
 *
 * ⚠️ IT IS CONSULTED **BEFORE** `hopValuesShortcut`, WHICH IS A DELIBERATE PRECEDENCE CHANGE — the
 * only one in this family. Item 1535's rule is that `??` order means no plan an earlier rung already
 * admits can change route, and every other rung here was added AFTER for exactly that reason. This
 * one is added FIRST because it is faster on the shapes it claims, so the gate is as narrow as the
 * claim: `V()` with no ids, ONE `out`/`in` hop with ONE label, and a single-key `values`, an `id()`
 * or nothing. `both`, a multi-type hop, an untyped hop, a filtered start or far end, and every other
 * projection decline and land on exactly the rung they land on today.
 *
 * ⚠️ `both` AND MULTI-TYPE ARE REFUSED FOR A CORRECTNESS REASON, not a scope one. `buildChainCsr`
 * appends one named bucket at a time and is sound only "because the multi-type guard has already
 * cleared", so an edge carrying two of the named types would be appended TWICE where `iterLabeled`
 * dedupes it; and `both` is two directions, which one CSR cannot express.
 *
 * ⚠️ THE ORDER IS THE BUCKET WALK'S, which the differential fuzzer compares ORDERED for Gremlin.
 * `far-mask-drain.ts` states the argument this inherits: "`chainCsrFor` numbers slots by
 * `graph.verticesById` iteration order and fills each slot's run from that vertex's own bucket in
 * set order, so walking slots in order and each run in order emits the identical sequence to the
 * generator walk. Nothing is hoisted across vertices."
 *
 * ⚠️ AND THE BUILD IS CACHED per graph per `topologyVersion` per shape, dropped WHOLE on any
 * topology write. Item 1695's criterion — safe iff the walk costs more than the rebuild — is checked
 * in the entry rather than assumed, including at the small size where the walk is cheapest.
 */
export const hopValuesCsr = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  const [source, hop, proj] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the same bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if ((hop.kind !== 'out' && hop.kind !== 'in') || hop.labels.length !== 1) {
    return undefined;
  }

  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  const picked = pickFor(proj, valueKey);

  if (picked === undefined) {
    return undefined;
  }

  // ⚠️ THE SECOND-CALL POLICY, and it is what makes this arm safe to put FIRST — see `seenBefore`.
  if (!seenBefore(graph, hop.kind === 'out', hop.labels[0])) {
    return undefined;
  }

  return {
    // ⚠️ A `fold` IS NOT CONSUMED: it stays in `rest` for `fusedProjectedResidual` to fold over
    // the drained walk (item 1909), which is the whole point of admitting it here.
    rest: steps.slice(picked.consumesProj ? 3 : 2),
    values: walk(graph, {
      forward: hop.kind === 'out',
      type: hop.labels[0],
      ...picked,
    }),
  };
};

export { seenBefore };

type Element = { readonly id: string; readonly properties: Record<string, unknown> };
type Picked = {
  pick: (e: Element) => unknown;
  drops: boolean;
  /**
   * Does the projection step get CONSUMED, or stay in `rest` for the residual dispatch? (item 1911.)
   *
   * ⚠️ CARRIED HERE rather than re-derived at the `rest` slice: two copies of "which kinds are
   * consumed" is how one falls behind the other (item 606's reason), and a `rest` that disagreed
   * with the pick would either drop a step or run it twice.
   */
  consumesProj: boolean;
};

/**
 * What the plan asks for about the far vertex; `undefined` declines the plan.
 *
 * `values(k)` DROPS a far vertex lacking `k` — `projectValues`' own rule (`k in props`) — while a
 * bare hop yields the element and `id()` a string, neither of which can produce `undefined` of its
 * own, so the sentinel cannot swallow a real value. A property stored as `null` is PRESENT and is
 * emitted.
 */
const pickFor = (proj: Step | undefined, valueKey: string | undefined): Picked | undefined => {
  if (valueKey !== undefined) {
    return { pick: (e) => e.properties[valueKey], drops: true, consumesProj: true };
  }

  /*
   * ⚠️ A `fold` PROJECTION IS THE BARE-ELEMENT PICK WITH THE FOLD LEFT IN `rest` (item 1910) — the
   * same named residual `hop-values.ts` admits, so the two rungs agree on which shapes they serve.
   * Without it this rung declined `V().out(T).fold()` and the shape fell to the SLOWER bucket walk:
   * 29.71 ms against 4.13 for the identical hop through this CSR, after item 1910's gate change had
   * already taken it from 99.53.
   */
  if (
    proj === undefined ||
    proj.kind === 'fold' ||
    proj.kind === 'aggregate' ||
    proj.kind === 'store'
  ) {
    // ⚠️ `consumesProj: false` — the step STAYS in `rest` for the residual dispatch to decide.
    // Carried on `Picked` rather than re-derived at the `rest` slice (item 1911): two copies of
    // "which kinds are consumed" is how one of them falls behind the other, which is item 606's
    // reason and the shape of the wrong answer item 1903 cost.
    return { pick: (e) => e, drops: false, consumesProj: false };
  }

  return proj.kind === 'id' ? { pick: (e) => e.id, drops: false, consumesProj: true } : undefined;
};

type WalkSpec = {
  readonly forward: boolean;
  readonly type: string;
  readonly pick: (e: Element) => unknown;
  readonly drops: boolean;
};

/**
 * ⚠️ ONE LOOP OVER SEQUENTIAL MEMORY, PARAMETERIZED, AT MODULE SCOPE
 * ([[ts-closure-size-is-load-bearing]]). The inner loop reads `memo.flat` — an `Int32Array` of
 * neighbour slots — and indexes `vtx` once per row; there is no `Map` lookup and no `Set` iterator
 * anywhere in it, which is the whole difference from the bucket walk.
 */
const walk = (graph: Graph, spec: WalkSpec): HopWalk => ({
  *[Symbol.iterator]() {
    const { forward, type, pick, drops } = spec;
    const { vtx, memo } = chainCsrFor(graph, forward, [type]);

    for (let slot = 0; slot < vtx.length; slot += 1) {
      const from = memo.off[slot];
      const to = from + memo.len[slot];

      for (let i = from; i < to; i += 1) {
        const value = pick(vtx[memo.flat[i]]);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
  /**
   * ⚠️ THE EAGER FILL IS MOST OF THE WIN, AND MEASURING WITHOUT IT NEARLY SANK THE ITEM. With the
   * generator alone the CSR walk read **67.59 ms against the bucket walk's 81.31 — 1.20x**, which
   * is exactly the "no delegation left to remove" figure `hop-values.ts` records, and it looked
   * like the data structure was worth almost nothing. `toArray` is `drain()` when the walk offers
   * one (item 1412), and every arm of `hopValuesShortcut` offers one — so the arm this replaces was
   * being compared with its generator hand tied.
   *
   * ⚠️ IT NEVER REPLACES THE ITERABLE, which is `hop-values.ts`'s own rule: `run` stays exactly as
   * lazy as it was for a caller that `break`s out, and `drain` is read only where the shortcut
   * consumed the whole plan (`rest.length === 0`), so there is no downstream step to reason about.
   *
   * ⚠️ AND IT IS THE SAME LOOP OVER THE SAME ARRAYS, not a second derivation — item 169's rule, and
   * Gremlin results are compared ORDERED, so a reordering between the two fills would be a
   * cross-engine failure rather than an unspecified-order liberty.
   */
  drain() {
    const { forward, type, pick, drops } = spec;
    const { vtx, memo } = chainCsrFor(graph, forward, [type]);
    const out: unknown[] = [];

    for (let slot = 0; slot < vtx.length; slot += 1) {
      const from = memo.off[slot];
      const to = from + memo.len[slot];

      for (let i = from; i < to; i += 1) {
        const value = pick(vtx[memo.flat[i]]);

        if (!drops || value !== undefined) {
          out.push(value);
        }
      }
    }

    return out;
  },
});
