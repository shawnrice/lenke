import type { Element, Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { chainCsrFor } from './count-shortcut.js';
import { type Hop, csrEligible, hopArm } from './hop-arm.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { adjacentEdges, otherEndpoint, soleTypeBucket } from './movement.js';
import { optionalSingleHop } from './optional-hop.js';
import { seenBefore } from './second-ask.js';

/**
 * `V().coalesce(<one hop>, <one hop>).values(k)` answered WHOLESALE (item 1998).
 *
 * ⚠️⚠️ **THE WHOLE GAP IS THAT THIS SHAPE WAS THE ONLY ONE OF ITS NEIGHBOURS NOT FUSED, and it took
 * five items and a route counter to establish that.** Items 1993-1996 priced it against three hop
 * "controls" and attributed the difference to a per-row toll, a sub-plan contract, closure size and a
 * step-specific residual in turn. Item 1997 counted `applyStep` calls:
 *
 * ```text
 *     out(E).values(n)              0 calls   FULLY FUSED
 *     out(E,F).values(n)            0 calls   FULLY FUSED
 *     both(E).values(n)             0 calls   FULLY FUSED
 *     coalesce(out,in).values(n)    2 calls   coalesce values   ⬅ the general stream
 * ```
 *
 * Every control was fused. There is no residual and no fifth mechanism — one shape of the four runs
 * the general stream, and this module is that shape's route.
 *
 * ⚠️ `coalesce(X, identity())` DOES NOT COME HERE: item 1990 normalizes it to `optional(X)`, which
 * `optional-hop-values.ts` already answers. This rung is for the form with no identity arm, which no
 * normalization can reach because there is no equivalent spelling to rewrite into (item 1995).
 *
 * 🔑 **THE SEMANTICS, AND THE ONE THING A FIXTURE CAN HIDE.** `coalesce` emits the first arm that
 * produces anything, per traverser. On a graph where every vertex has an arm-0 edge the answer is
 * arm 0's alone — item 1995 verified that `coalesce(out(E), in_(E))` is then POSITIONALLY IDENTICAL
 * to a bare `out(E)` hop. ⚠️ So a fixture without a vertex that MISSES arm 0 cannot tell this route
 * from a plain hop, and the test for it carries a sink deliberately.
 *
 * ⚠️ `any` IS SET PER EDGE, BEFORE THE PROJECTION — `walk`'s own order in
 * `optional-hop-values.ts`, and `coalesceStep`'s. A vertex whose arm-0 edges all lack the projected
 * key has still MATCHED arm 0, so it emits nothing rather than falling through to arm 1. Setting
 * `any` after the `drops` check would silently change the answer on a graph with missing properties.
 */
type CoalesceSpec = {
  readonly first: Hop;
  readonly second: Hop;
  readonly pick: (e: Element) => unknown;
  readonly drops: boolean;
};

/**
 * ⚠️ ONE LOOP, PARAMETERIZED, AT MODULE SCOPE — [[ts-closure-size-is-load-bearing]], where a walk
 * defined inside a returned closure gave unrelated queries a new slow mode at 4x.
 *
 * ⚠️ AND THE TWO EDGE SOURCES ARE `walk`'s TWO ARMS, for item 1628's reason: `soleTypeBucket` is a
 * cached `Map.get` priced at **16.1 ns** (items 162/321) and refuses `both`, a multi-type hop and an
 * untyped one — those keep `adjacentEdges`, which delegates through `iterByLabel`/`iterLabeled` and
 * allocates a `{edge, node}` per edge. Picking per arm rather than for the whole walk matters because
 * the two arms of one `coalesce` need not be the same shape.
 */
const coalesceWalk = (graph: Graph, spec: CoalesceSpec): Iterable<unknown> => ({
  *[Symbol.iterator]() {
    const { first, second, pick, drops } = spec;

    for (const v of graph.vertices) {
      let any = false;
      const direct = soleTypeBucket(v, first.kind, first.labels);

      if (direct === undefined) {
        for (const e of adjacentEdges(first.kind, graph, v, first.labels)) {
          any = true;

          const own = pick(otherEndpoint(first.kind, e, v));

          if (!drops || own !== undefined) {
            yield own;
          }
        }
      } else {
        const { set, forward } = direct;

        for (const e of set) {
          any = true;

          const own = pick(forward ? e.to : e.from);

          if (!drops || own !== undefined) {
            yield own;
          }
        }
      }

      if (any) {
        continue;
      }

      // ARM 1, reached only for a vertex arm 0 missed. Same two sources, chosen for THIS hop.
      const fallback = soleTypeBucket(v, second.kind, second.labels);

      if (fallback === undefined) {
        for (const e of adjacentEdges(second.kind, graph, v, second.labels)) {
          const own = pick(otherEndpoint(second.kind, e, v));

          if (!drops || own !== undefined) {
            yield own;
          }
        }
      } else {
        const { set, forward } = fallback;

        for (const e of set) {
          const own = pick(forward ? e.to : e.from);

          if (!drops || own !== undefined) {
            yield own;
          }
        }
      }
    }
  },
});

/** The projection this rung admits — `values(k)` with ONE key, `id`, or nothing. */
const pickFor = (
  proj: Step | undefined,
  valueKey: string | undefined,
): { pick: (e: Element) => unknown; drops: boolean; consumed: boolean } | undefined => {
  if (valueKey !== undefined) {
    return { pick: (e) => e.properties[valueKey], drops: true, consumed: true };
  }

  if (proj === undefined) {
    return { pick: (e) => e, drops: false, consumed: false };
  }

  if (proj.kind === 'id') {
    return { pick: (e) => e.id, drops: false, consumed: true };
  }

  /*
   * 🔑 A TERMINAL THIS WALK DOES NOT PROJECT STILL GETS THE WALK (item 2028) — item 1956's decision,
   * applied here after a `pickFor` audit found four rungs still carrying the gap.
   *
   * ⚠️⚠️ **AND THIS ONE WAS MEASURED SEPARATELY BECAUSE OPENING THE GATE IS NOT THE SAME AS THE ROUTE
   * BEING BETTER.** `coalesce`'s generic count path costs only TWO `applyStep` calls (the census
   * said so) where `choose`'s and `branch`'s cost 4002, so it was already cheap: 41.22 ms against
   * its own `values` twin's 46.37 — the count was ALREADY faster than projecting. Fusing it makes
   * the count ride `drain().length`, which materializes an 800,000-element array it then measures
   * (item 2020's own open note), so a regression was the live possibility rather than a formality.
   * See CLOSED.md item 2028 for the measured outcome.
   */
  return proj.kind === 'count' ? { pick: (e) => e, drops: false, consumed: false } : undefined;
};

/**
 * ARM 0 OVER THE CSR, with arm 1 kept on the bucket walk (item 1998).
 *
 * ⚠️⚠️ **THE BUCKET WALK ALONE IS ONLY 1.20x, AND THAT IS WHY THIS EXISTS.** Measured:
 * `coalesce: two hops` 209.55 -> 174.20 ms with `coalesceWalk` below. Item 1629's fast arm inside
 * `coalesceStep` is ALREADY a bucket walk, so a fused bucket walk only removes the step plumbing.
 * The control it is judged against (`hop1: values`, 46.65) is on item 1889's CSR, which that item
 * prices at **16 ns a row against a bucket walk's 102** — so the CSR is the gap, not the plumbing.
 *
 * 🔑 **ARM 1 NEEDS NO CSR, AND THE CSR ITSELF SAYS WHEN TO RUN IT.** `coalesce` reaches arm 1 only
 * for a vertex arm 0 missed, and an empty arm-0 bucket is exactly `memo.len[slot] === 0` — the same
 * test `csrOneHop` uses to decide it should emit the input. So the hot path is pure flat-array
 * reads and the cold path keeps `coalesceWalk`'s per-vertex logic, which costs nothing on a graph
 * where arm 0 matches everywhere and is correct on one where it does not.
 *
 * ⚠️ BEHIND `seenBefore`, item 1889's second-ask policy, for its reasons verbatim: a ONE-SHOT query
 * never builds, a WRITE-EVERY-READ workload never reaches a second ask on one topology version so
 * it never builds either, and a repeated read pays the build once. Item 1983 measured those three
 * modes directly when it gave the two-hop count the same treatment.
 *
 * ⚠️ AND THE KEY IS REUSED, NOT RE-KEYED — `chainCsrFor(graph, forward, [type])` is the same cache
 * entry every single-hop caller warms, so a graph where `V().out(T)` has been asked hands this route
 * a CSR it need not build.
 */
const csrArm0 = (
  graph: Graph,
  spec: CoalesceSpec & { forward: boolean; type: string },
): HopWalk => ({
  *[Symbol.iterator]() {
    const { forward, type, second, pick, drops } = spec;
    const { vtx, memo } = chainCsrFor(graph, forward, [type]);

    for (let slot = 0; slot < vtx.length; slot += 1) {
      const from = memo.off[slot];
      const to = from + memo.len[slot];

      if (from === to) {
        // ARM 0 MISSED THIS VERTEX — the one place `coalesce` differs from a plain hop.
        yield* hopArm(graph, vtx[slot], second, pick, drops);

        continue;
      }

      for (let i = from; i < to; i += 1) {
        const value = pick(vtx[memo.flat[i]]);

        if (!drops || value !== undefined) {
          yield value;
        }
      }
    }
  },
  /*
   * ⚠️⚠️ THE EAGER `drain` IS NOT OPTIONAL, AND OMITTING IT COST THIS ITEM MOST OF ITS WIN BEFORE
   * IT WAS NOTICED — exactly as `csrOneHop`'s own note says it cost item 1889. `toArray` PREFERS
   * `drain` when a walk offers one (item 1412), so a walk without it is measured against controls
   * that have it with its generator hand tied: this route read **72.70 ms** generator-only against
   * the bare hop's 47.05, and the remaining 1.55x was the missing drain rather than anything about
   * `coalesce`.
   *
   * ⚠️ THE TWO FILLS ARE THE SAME LOOP WRITTEN TWICE — item 169's rule, and Gremlin results are
   * compared ORDERED, so a reordering between them is a cross-engine failure rather than a style
   * question. The three-ask battery in `battery-1998.mjs` compares them positionally.
   */
  drain() {
    const { forward, type, second, pick, drops } = spec;
    const { vtx, memo } = chainCsrFor(graph, forward, [type]);
    const out: unknown[] = [];

    for (let slot = 0; slot < vtx.length; slot += 1) {
      const from = memo.off[slot];
      const to = from + memo.len[slot];

      if (from === to) {
        for (const own of hopArm(graph, vtx[slot], second, pick, drops)) {
          out.push(own);
        }

        continue;
      }

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

export const coalesceHopValues = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  const [source, wrapper] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  // EXACTLY TWO ARMS. Three or more is not this shape, and the general loop keeps it.
  if (wrapper.kind !== 'coalesce' || wrapper.plans.length !== 2) {
    return undefined;
  }

  const first = optionalSingleHop(wrapper.plans[0]);
  const second = optionalSingleHop(wrapper.plans[1]);

  // BOTH arms must be one vertex step. A multi-step arm needs the chain walk, which is a different
  // route with a different cost (`optionalHopChainValues`' note), so it keeps the general loop.
  if (first === undefined || second === undefined) {
    return undefined;
  }

  const [, , proj] = steps;
  // ONE key: `values()` with no key emits every property value and `values(a, b)` fans out per key.
  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  const picked = pickFor(proj, valueKey);

  if (picked === undefined) {
    return undefined;
  }

  const spec = { first, second, ...picked };
  // THE CSR IS TRIED FIRST and declines exactly where `csrOneHop` declines: `both`, a multi-type
  // hop, an untyped one, or a first ask on this topology version.
  const csr =
    csrEligible(first) && seenBefore(graph, first.kind === 'out', first.labels[0])
      ? csrArm0(graph, { ...spec, forward: first.kind === 'out', type: first.labels[0] })
      : undefined;

  return {
    // `consumed` rather than `proj === undefined`: an unconsumed terminal must stay in `rest`.
    rest: steps.slice(picked.consumed ? 3 : 2),
    values: csr ?? coalesceWalk(graph, spec),
  };
};
