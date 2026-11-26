import type { Element, Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { type ChainCsr, chainCsrFor, collectVertexFilters } from './count-shortcut.js';
import { type Hop, csrEligible, hopArm } from './hop-arm.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { optionalSingleHop } from './optional-hop.js';
import { seenBefore } from './second-ask.js';
import { type Gate, compileGates, survives } from './start-filtered-hop-values.js';

/**
 * `V().choose(<vertex filter>, <one hop>, <one hop>).values(k)` answered WHOLESALE (item 1999).
 *
 * **THE MACHINERY WAS THE COST AND THE ARM NEVER WAS, which item 1992 decomposed and item 1999
 * confirmed from the other side.** `chooseSameArm` — both arms the same hop, so routing cannot
 * possibly matter — measured **321.93 ms** against `chooseTwoArm`'s **331.61**, isolated, 800,000
 * rows each. The two numbers are the same number. So there was never an arm to optimize: the cost is
 * `chooseStep`'s two `applyPlanToStream` calls per traverser, one for the test and one for the arm,
 * and the cure is to not make them.
 *
 * **THE HAND CEILING IS NOT THE FLOOR, and reading it as one would have stopped this item at
 * 2.96x.** `coalesce-vs-optional-1990.mjs`'s `handChoose` arm reads the adjacency through
 * `v.adjFrom.get('E')` — a BUCKET walk — and measures 111.97 ms, so it advertises 2.96x. Item 1998
 * measured that exact difference on this family: for one shape, a fused bucket walk read 174.20 ms
 * where the CSR read 72.70. The reachable floor here is the ~45 ms of the bare hops, not the hand
 * arm's 112, which is why both arms get a CSR below rather than the bucket walk the hand arm used.
 *
 * **THE TEST IS EVALUATED INLINE, AND ONLY A VERTEX-FILTER TEST IS ADMITTED.** `choose`'s test is
 * "does the test plan produce anything for this traverser", which for a plan of `has`/`hasLabel`
 * steps is exactly `survives` over `compileGates` — the same compiled closures
 * `start-filtered-hop-values.ts` uses, where item 1536 prices the compilation at **1.93x** against
 * the straightforward per-vertex form. A test with a hop in it (`choose(out(E), …)`) is a different
 * question and keeps the general loop.
 *
 * **`refuseSeekable` IS PASSED `false` HERE, AND THAT IS NOT A RELAXATION — IT IS THE OPPOSITE
 * OF WHAT A SEEK ROUTE WANTS.** `collectVertexFilters` defaults to refusing a filter an index could
 * seek, because a FILTER route should hand that case to the seek instead. A `choose` test cannot be
 * seeked at all: a seek narrows the source to the survivors, and `choose` must visit the
 * NON-survivors too — they are exactly who takes the else arm. Refusing a seekable test here would
 * decline the route precisely on the graphs that have an index.
 *
 * AN ABSENT `elsePlan` IS NOT AN EMPTY ARM — per TinkerPop the traverser PASSES THROUGH
 * unchanged, which `chooseStep`'s own comment records and `coalesce-vs-optional-1990.mjs` had to
 * verify against the engine because the AST comment reads the other way. That shape is admitted
 * below as a pass-through arm, not declined, because declining it would leave the commonest
 * conditional spelling on the general loop.
 */
type ChooseSpec = {
  readonly gates: readonly Gate[];
  readonly thenHop: Hop;
  /** `undefined` means an absent `elsePlan`: the traverser passes through unchanged. */
  readonly elseHop: Hop | undefined;
  readonly pick: (e: Element) => unknown;
  readonly drops: boolean;
};

/**
 * ONE LOOP, PARAMETERIZED, AT MODULE SCOPE — [[ts-closure-size-is-load-bearing]], where a walk
 * defined inside a returned closure gave unrelated queries a new slow mode at 4x.
 */
const chooseWalk = (graph: Graph, spec: ChooseSpec): Iterable<unknown> => ({
  *[Symbol.iterator]() {
    const { gates, thenHop, elseHop, pick, drops } = spec;

    for (const v of graph.vertices) {
      const hop = survives(v, gates) ? thenHop : elseHop;

      if (hop === undefined) {
        // The absent-else pass-through: the traverser itself, projected.
        const own = pick(v);

        if (!drops || own !== undefined) {
          yield own;
        }

        continue;
      }

      yield* hopArm(graph, v, hop, pick, drops);
    }
  },
});

/** One slot's edges out of a prepared CSR, projected — the hot path, pure flat-array reads. */
const csrSlot = function* (
  csr: ChainCsr,
  slot: number,
  pick: (e: Element) => unknown,
  drops: boolean,
): Iterable<unknown> {
  const { vtx, memo } = csr;
  const from = memo.off[slot];
  const to = from + memo.len[slot];

  for (let i = from; i < to; i += 1) {
    const value = pick(vtx[memo.flat[i]]);

    if (!drops || value !== undefined) {
      yield value;
    }
  }
};

/**
 * BOTH ARMS OVER THE CSR where each arm qualifies, the other on `hopArm` (item 1999).
 *
 * **BOTH ARMS, NOT JUST THE "THEN" ARM, AND THE FIXTURE IS WHY.** The screen's row tests
 * `has('n', 0)` over `n = i % 97`, so **96 of every 97 vertices take the ELSE arm**. A route that
 * CSR'd only the then arm would fuse 1% of the work and measure as a null — the same mistake in
 * fixture-reading that item 1993 made when it compared an inward-hop shape against an outward-hop
 * control.
 *
 * ONE SLOT INDEXES BOTH ARMS, and that is a property of `buildChainCsr` worth stating because
 * the route is wrong without it: `vtx` is built by iterating `graph.verticesById.values()` for
 * EVERY direction and label set, so slot `i` is the same vertex in the forward CSR and the reverse
 * one. Two CSRs built from one topology version are co-indexed.
 *
 * BEHIND `seenBefore`, item 1889's second-ask policy, for its reasons verbatim: a ONE-SHOT query
 * never builds, a WRITE-EVERY-READ workload never reaches a second ask on one topology version so
 * it never builds either, and a repeated read pays the build once. BOTH arms must have been seen
 * — a route that built one CSR on the first ask would charge a one-shot query for half a build.
 */
const csrBothArms = (
  graph: Graph,
  spec: ChooseSpec,
  thenCsr: ChainCsr | undefined,
  elseCsr: ChainCsr | undefined,
): HopWalk => {
  const { gates, thenHop, elseHop, pick, drops } = spec;
  // The slot ordering is shared, so either arm's `vtx` can drive the loop (and one of them exists:
  // the gate below refuses the all-bucket case, which `chooseWalk` already answers).
  const driver = thenCsr ?? elseCsr;

  return {
    *[Symbol.iterator]() {
      const { vtx } = driver!;

      for (let slot = 0; slot < vtx.length; slot += 1) {
        const v = vtx[slot];
        const take = survives(v, gates);
        const csr = take ? thenCsr : elseCsr;

        if (csr !== undefined) {
          yield* csrSlot(csr, slot, pick, drops);

          continue;
        }

        const hop = take ? thenHop : elseHop;

        if (hop === undefined) {
          const own = pick(v);

          if (!drops || own !== undefined) {
            yield own;
          }

          continue;
        }

        yield* hopArm(graph, v, hop, pick, drops);
      }
    },
    /*
     * THE EAGER `drain` IS NOT OPTIONAL, AND ITEM 1998 IS THE PRICE OF LEARNING THAT TWICE.
     * `toArray` PREFERS `drain` when a walk offers one (item 1412), so a walk without it is measured
     * against controls that have it with its generator hand tied — item 1998's route read 72.70 ms
     * generator-only against a 47.05 control and the whole remaining 1.55x was the missing drain.
     * `csrOneHop`'s header says the same about item 1889. Write the drain in the same edit as the
     * iterator.
     *
     * THE TWO FILLS ARE THE SAME LOOP WRITTEN TWICE — item 169's rule. Gremlin results are
     * compared ORDERED, so a divergence between them is a cross-engine failure rather than a style
     * question, and `battery-1999.mjs` compares them positionally across three asks.
     */
    drain() {
      const { vtx } = driver!;
      const out: unknown[] = [];

      for (let slot = 0; slot < vtx.length; slot += 1) {
        const v = vtx[slot];
        const take = survives(v, gates);
        const csr = take ? thenCsr : elseCsr;

        if (csr !== undefined) {
          const { vtx: far, memo } = csr;
          const from = memo.off[slot];
          const to = from + memo.len[slot];

          for (let i = from; i < to; i += 1) {
            const value = pick(far[memo.flat[i]]);

            if (!drops || value !== undefined) {
              out.push(value);
            }
          }

          continue;
        }

        const hop = take ? thenHop : elseHop;

        if (hop === undefined) {
          const own = pick(v);

          if (!drops || own !== undefined) {
            out.push(own);
          }

          continue;
        }

        for (const own of hopArm(graph, v, hop, pick, drops)) {
          out.push(own);
        }
      }

      return out;
    },
  };
};

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
   * **A TERMINAL THIS WALK DOES NOT PROJECT STILL GETS THE WALK (item 2028).** `count()` used to
   * decline the ENTIRE plan here, so the route census read this family's count shape GENERIC with
   * **4002 `applyStep` calls** — the sub-plan re-dispatched per traverser, which is exactly the cost
   * the rung exists to remove. The same decision item 1956 made for the edge-filter rung and item
   * 2027 for the `optional` one; a `pickFor` audit found four rungs still carrying the gap.
   *
   * IT IS NOT CONSUMED: this walk has nothing to contribute to a count beyond yielding the
   * elements, so `count` stays in `rest` and runs over this stream. Since item 2020 that residual is
   * counted on the walk's `drain`.
   *
   * AND THE GATE NEED NOT CHECK `count`'s SCOPE, where item 2020's FUSED count must: an
   * unconsumed terminal is still executed by its own step, so `Scope.local` is honoured by
   * `countStep` itself. Item 2020 replaces the count, so there the scope is refused at the gate.
   */
  return proj.kind === 'count' ? { pick: (e) => e, drops: false, consumed: false } : undefined;
};

/** The arm's CSR if it qualifies AND has been asked before, else `undefined`. */
const armCsr = (graph: Graph, hop: Hop | undefined): ChainCsr | undefined =>
  hop !== undefined && csrEligible(hop) && seenBefore(graph, hop.kind === 'out', hop.labels[0])
    ? chainCsrFor(graph, hop.kind === 'out', [hop.labels[0]])
    : undefined;

export const chooseHopValues = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  const [source, wrapper] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (wrapper.kind !== 'choose') {
    return undefined;
  }

  /*
   * THE TEST MUST BE INLINE-EVALUABLE, AND `collectVertexFilters` IS THE WHOLE ADMISSION — a hop in
   * the test (`choose(out(E), …)`, which asks whether an edge exists) makes it return `undefined`
   * and the shape keeps the general loop.
   *
   * **A SECOND `every(isVertexFilterStep)` GUARD STOOD HERE AND WAS NOT MERELY REDUNDANT — it
   * was STRICTLY NARROWER THAN THE LINE BELOW IT.** `isVertexFilterStep` admits `hasLabel` and
   * `has`; `collectVertexFilters` additionally admits a single-key `hasKey`, which it compiles to a
   * `present` predicate. So the guard declined `choose(hasKey(k), …)` for no reason while reading
   * like a safety check. Item 1999's mutation round found it by SURVIVING: deleting the guard
   * changed no answer, which is the definition of dead code rather than a missing test.
   *
   * AN EMPTY TEST PLAN IS ALSO ADMITTED, and that too was a needless decline. `chooseStep` runs
   * the test as "does this plan produce anything", and an empty plan yields the traverser — so an
   * empty test is TRUE for every vertex, which is exactly what `survives` over zero gates answers.
   * Declining it would have been a spelling that costs more for no semantic reason.
   *
   * `refuseSeekable: false` — see the header. A seek narrows to the survivors and `choose` needs
   * the non-survivors too, so the default refusal would decline exactly the indexed graphs.
   */
  const filters = collectVertexFilters(wrapper.test.steps, graph, false);

  if (filters === undefined) {
    return undefined;
  }

  const thenHop = optionalSingleHop(wrapper.thenPlan);
  // An ABSENT elsePlan is a pass-through arm (TinkerPop), not an empty one. A PRESENT else plan must
  // be one vertex step; a multi-step arm needs the chain walk, a different route with a different
  // cost, so it keeps the general loop.
  const elseHop = wrapper.elsePlan === undefined ? undefined : optionalSingleHop(wrapper.elsePlan);

  if (thenHop === undefined || (wrapper.elsePlan !== undefined && elseHop === undefined)) {
    return undefined;
  }

  const [, , proj] = steps;
  // ONE key: `values()` with no key emits every property value and `values(a, b)` fans out per key.
  const valueKey = proj?.kind === 'values' && proj.keys.length === 1 ? proj.keys[0] : undefined;
  const picked = pickFor(proj, valueKey);

  if (picked === undefined) {
    return undefined;
  }

  const spec: ChooseSpec = { gates: compileGates(filters), thenHop, elseHop, ...picked };
  const thenCsr = armCsr(graph, thenHop);
  const elseCsr = armCsr(graph, elseHop);
  // BOTH arms must be served before the CSR walk is worth taking: with only one of them fused the
  // other still pays the bucket walk per vertex, and on a test that sends 96 of 97 vertices one way
  // (the screen's own fixture) fusing the minority arm measures as a null.
  const bothServed =
    (thenCsr !== undefined || !csrEligible(thenHop)) &&
    (elseCsr !== undefined || elseHop === undefined || !csrEligible(elseHop));
  const csr =
    bothServed && (thenCsr !== undefined || elseCsr !== undefined)
      ? csrBothArms(graph, spec, thenCsr, elseCsr)
      : undefined;

  return {
    // `consumed` rather than `proj === undefined`: an unconsumed terminal must stay in `rest`.
    rest: steps.slice(picked.consumed ? 3 : 2),
    values: csr ?? chooseWalk(graph, spec),
  };
};
