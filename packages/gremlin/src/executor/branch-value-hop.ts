import type { Element, Graph } from '@lenke/core';

import type { Plan, Step } from '../ast.js';
import { type Hop, hopArm } from './hop-arm.js';
import type { HopValues, HopWalk } from './hop-values.js';
import { optionalSingleHop } from './optional-hop.js';

/**
 * `V().branch(values(k)).option(m, <arm>)….none(<arm>).values(k)` answered WHOLESALE (item 2015).
 *
 * ⚠️⚠️ **IT IS THE THIRD AND LAST RECONVERGING-BRANCH SHAPE, and the two before it took the other
 * two halves of the square.** Item 1999's rung is a vertex-FILTER test with HOP arms; item 2014's is
 * a HOP test with VALUE arms; this is a VALUE test with HOP-or-identity arms. The remaining corner —
 * a hop test with hop arms — is `coalesce`'s shape and item 1998 has it.
 *
 * 🔑 **THE TEST IS ONE PROPERTY READ, AND `branch`'s OPTION LOOKUP IS A MAP GET.** `branchStep` runs
 * the test as a sub-plan per traverser (`applyPlanToStream(test, [t], …)`, taking the first result
 * and breaking), then `tupleKey`s that result and `indexOf`s it in a precomputed key array, then
 * runs the chosen arm as a SECOND sub-plan. For a `values(k)` test the first of those is
 * `props[k]`, and the second is a hash lookup — so the whole conditional costs two sub-plan
 * invocations to do a property read and a `Map.get`.
 *
 * MEASURED, isolated at 200,000 vertices / 800,000 edges (one shape per process, item 762's rule),
 * against a hand ceiling that reads one property per vertex, dispatches on its value and walks an
 * adjacency only for the values that name one — digests identical, 212,373 rows each:
 *
 * ```text
 *     branch(values(n)).option(0, out(E)).option(1, in_(E)).none(identity()).values(n)
 *       the general loop                            43.72 ms   207 ns/row
 *       THIS RUNG                                    9.66 ms    46 ns/row    4.5x
 *     hand ceiling                                   6.12 ms    29 ns/row    1.6x remaining
 * ```
 *
 * ⚠️ THE POST ARM'S OWN SPREAD WAS 9.35-13.73 ACROSS THREE ROUNDS of `rung-control-ab-2015.sh`,
 * which is this row's noise floor and is why the figure above is a median of arm minima rather than
 * a single run. The six CONTROL shapes in that A/B — `hop`, `hopIn`, `optional`, `coalesce`,
 * `chooseConst`, `chooseTwoArm` — none moved beyond that floor; `chooseTwoArm` read 1.03x on minima
 * with two of three POST rounds ~12% high, unresolved within the noise rather than flat. That check
 * is not optional for a new rung: [[executor-edits-perturb]], where a new walk variant cost
 * UNRELATED rows up to 16% and item 1466 declined a 3.3x on exactly that ground.
 *
 * ⚠️⚠️ **NO CSR ARM HERE, AND THAT IS A MEASUREMENT RATHER THAN AN OMISSION — the fixture's
 * dominant arm touches no adjacency at all.** Item 1999's rung gives BOTH arms a CSR because its
 * test (`has('n', 0)` over `n = i % 97`) sends 96 of 97 vertices into a hop. This shape's test is
 * the value itself, with `option(0)` and `option(1)` the only routed values — so **95 of every 97
 * vertices fall to `none(identity())`**, which emits the vertex and never reads an edge. A CSR
 * would fuse 2/97 of the work and pay a full build for it, which is item 1999's own
 * "fusing the minority arm measures as a null" with the arms the other way round. That is also why
 * the hand ceiling above is a BUCKET walk and is still the honest floor (item 1951's rule): there
 * are almost no buckets to walk.
 *
 * ⚠️ AND THE BARE HOP IS NOT THIS ROW'S FLOOR EITHER, for the same reason — a hop walks every
 * vertex's adjacency where this shape walks 2/97 of them, so the hop row on the screen is the
 * SLOWER computation. Comparing against it would have hidden the entire 7.2x.
 */
/** One option's (or `none()`'s) plan, reduced to what the walk needs. */
type Arm = { readonly kind: 'hop'; readonly hop: Hop } | { readonly kind: 'identity' };

/** The arm shapes this rung admits: one vertex step, or `identity()`. */
const armOf = (plan: Plan): Arm | null => {
  if (plan.steps.length === 1 && plan.steps[0].kind === 'identity') {
    return { kind: 'identity' };
  }

  const hop = optionalSingleHop(plan);

  return hop === undefined ? null : { kind: 'hop', hop };
};

/**
 * ⚠️⚠️ **THE OPTION KEYS ARE KEYED RAW, AND THE GATE BELOW IS WHAT MAKES THAT EQUAL `tupleKey`.**
 * `branchStep` matches by VALUE through `tupleKey([match])` — TinkerPop keys `.option()` through a
 * Java `Map`, so a structurally-equal list or map token matches. A `Map` keyed on the raw value uses
 * SameValueZero instead, and the two agree for a string, a boolean and a FINITE number (`+0`/`-0`
 * share a key under both) while they DISAGREE on two shapes:
 *
 * ```text
 *     NaN    JSON.stringify(NaN) is "null", so tupleKey COLLIDES NaN with null; a Map does not
 *     a list / map / element    tupleKey compares them STRUCTURALLY; a Map compares identity
 * ```
 *
 * So the route admits only primitive option keys, and a `branch` keyed on a list, a map, an element
 * or `NaN` keeps the general loop — where `tupleKey` still does the structural thing. A route that
 * widened this without widening the lookup would answer a different arm, which is a wrong answer
 * rather than a slow one.
 *
 * ⚠️ FIRST WINS on a duplicate option key, because `branchStep` uses `indexOf` on the key array.
 *
 * ⚠️⚠️ **IT ALSO REFUSES `undefined`, AND `branchWalk` DEPENDS ON THAT RATHER THAN MERELY BENEFITING
 * FROM IT.** A vertex LACKING the test key reads as `undefined`, and the walk relies on no option
 * being keyed `undefined` so that such a vertex falls through to the fallback — which is where
 * `branchStep` sends it, since `values(k)` produces nothing for it and `sawResult` stays false.
 * Admitting `undefined` here without restoring a presence check in the walk is a WRONG ANSWER.
 */
const keyable = (k: unknown): boolean =>
  typeof k === 'string' || typeof k === 'boolean' || (typeof k === 'number' && Number.isFinite(k));

/**
 * ⚠️ ONE LOOP, PARAMETERIZED, AT MODULE SCOPE — [[ts-closure-size-is-load-bearing]], where a walk
 * written inline in a returned closure gave UNRELATED queries a new slow mode at 4x.
 */
type BranchSpec = {
  readonly testKey: string;
  readonly byValue: Map<unknown, Arm>;
  /** `undefined` means NO `none()` arm: an unmatched traverser is DROPPED. */
  readonly fallback: Arm | undefined;
  readonly pick: (e: Element) => unknown;
  readonly drops: boolean;
};

const branchWalk = (graph: Graph, spec: BranchSpec): HopWalk => ({
  *[Symbol.iterator]() {
    const { testKey, byValue, fallback, pick, drops } = spec;

    for (const v of graph.vertices) {
      const props = (v as Element).properties;
      /*
       * ⚠️⚠️ **NO `testKey in props` CHECK, AND A SURVIVING MUTANT IS WHY.** `projectValues` yields
       * a key that is PRESENT (`k in props`), so a `values(k)` test over a vertex LACKING `k`
       * produces nothing at all: `branchStep`'s `sawResult` stays false, no option can match, and
       * the traverser goes to `default`. So the presence test LOOKS load-bearing — and it is
       * redundant, because a missing key reads as `undefined` and **`keyable` refuses `undefined`
       * as an option key**, so `byValue` can never hold it and the `?? fallback` below is the same
       * answer by the same route. Item 2015's mutation round deleted the check and caught nothing,
       * which is the definition of dead code rather than a missing test (item 1999's lesson).
       *
       * ⚠️ THE COUPLING IS REAL AND IS PINNED: this is correct ONLY while `keyable` refuses
       * `undefined`, so the route test asserts `option(undefined)` DECLINES. Widen `keyable` to
       * admit it and this line silently starts answering the fallback where the engine answers that
       * option.
       */
      const arm = byValue.get(props[testKey]) ?? fallback;

      /*
       * ⚠️ NO MATCH AND NO `none()` DROPS THE ROW, which is the opposite of `choose`'s absent-else.
       * `branchStep`'s `if (target)` runs nothing when neither an option nor a default was found, so
       * the traverser vanishes — while `chooseStep` PASSES IT THROUGH. Item 2014's rung carries the
       * other rule for the other step, and conflating them would be a wrong answer each way.
       */
      if (arm === undefined) {
        continue;
      }

      if (arm.kind === 'identity') {
        const own = pick(v);

        if (!drops || own !== undefined) {
          yield own;
        }

        continue;
      }

      yield* hopArm(graph, v, arm.hop, pick, drops);
    }
  },
  /*
   * ⚠️⚠️ THE EAGER `drain` IS NOT OPTIONAL, AND ITEM 1998 PAID FOR LEARNING THAT TWICE. `toArray`
   * PREFERS `drain` when a walk offers one (item 1412), so a walk without one is measured against
   * controls that have it with its generator hand tied — item 1998's route read 72.70 ms
   * generator-only against a 47.05 control and the whole remaining 1.55x was the missing drain.
   * Here the generator-only form read 13.79 ms against the hand ceiling's 6.12 (2.25x); with this
   * fill it reads 10.58 (1.73x), so the drain was a THIRD of the residual over the ceiling — worth
   * its duplicated loop and not more.
   *
   * ⚠️ THE TWO FILLS ARE THE SAME LOOP WRITTEN TWICE — item 169's rule. Gremlin results are compared
   * ORDERED, so a divergence between them is a cross-engine failure rather than a style question,
   * and `battery-2015.mjs` compares them positionally across three asks.
   */
  drain() {
    const { testKey, byValue, fallback, pick, drops } = spec;
    const out: unknown[] = [];

    for (const v of graph.vertices) {
      // See the generator above for why there is no `testKey in props` check.
      const arm = byValue.get((v as Element).properties[testKey]) ?? fallback;

      if (arm === undefined) {
        continue;
      }

      if (arm.kind === 'identity') {
        const own = pick(v);

        if (!drops || own !== undefined) {
          out.push(own);
        }

        continue;
      }

      for (const own of hopArm(graph, v, arm.hop, pick, drops)) {
        out.push(own);
      }
    }

    return out;
  },
});

/** The projection this rung admits — `values(k)` with ONE key, `id`, or nothing. */
const pickFor = (
  proj: Step | undefined,
): { pick: (e: Element) => unknown; drops: boolean } | undefined => {
  if (proj === undefined) {
    return { pick: (e) => e, drops: false };
  }

  // ONE key: `values()` with no key emits every property value and `values(a, b)` fans out per key.
  if (proj.kind === 'values') {
    return proj.keys.length === 1
      ? { pick: (e) => e.properties[proj.keys[0]], drops: true }
      : undefined;
  }

  return proj.kind === 'id' ? { pick: (e) => e.id, drops: false } : undefined;
};

/** Every option's arm, keyed raw, or `null` if any option is a shape this rung cannot serve. */
const armsByValue = (
  options: readonly { match: unknown; plan: Plan }[],
): Map<unknown, Arm> | null => {
  const byValue = new Map<unknown, Arm>();

  for (const opt of options) {
    if (!keyable(opt.match)) {
      return null;
    }

    const arm = armOf(opt.plan);

    if (arm === null) {
      return null;
    }

    // FIRST WINS — `branchStep` resolves through `indexOf`, so a later duplicate is unreachable.
    if (!byValue.has(opt.match)) {
      byValue.set(opt.match, arm);
    }
  }

  return byValue;
};

export const branchValueHop = (plan: Plan, graph: Graph): HopValues | undefined => {
  const { steps } = plan;

  if (steps.length < 2) {
    return undefined;
  }

  const [source, wrapper] = steps;

  // `V(id, …)` enumerates a given set, not the whole graph — the bound every values rung has.
  if (source.kind !== 'V' || (source.ids?.length ?? 0) > 0) {
    return undefined;
  }

  if (wrapper.kind !== 'branch') {
    return undefined;
  }

  // THE TEST IS A SINGLE-KEY `values`. Anything else — a hop, a filter, a multi-step plan — is a
  // different question with a different cost and keeps the general loop.
  const [testStep] = wrapper.test.steps;

  if (wrapper.test.steps.length !== 1 || testStep.kind !== 'values' || testStep.keys.length !== 1) {
    return undefined;
  }

  const byValue = armsByValue(wrapper.options);

  if (byValue === null) {
    return undefined;
  }

  // ⚠️ AN ABSENT `none()` IS ADMITTED as a DROP, not declined — see `branchWalk`. A PRESENT one must
  // be an arm this rung can serve, or the whole shape declines: reading a refused `none()` as an
  // absent one would drop rows the engine emits.
  const fallback = wrapper.default === undefined ? undefined : armOf(wrapper.default);

  if (fallback === null) {
    return undefined;
  }

  const [, , proj] = steps;
  const picked = pickFor(proj);

  if (picked === undefined) {
    return undefined;
  }

  return {
    rest: steps.slice(proj === undefined ? 2 : 3),
    values: branchWalk(graph, {
      testKey: testStep.keys[0],
      byValue,
      fallback: fallback ?? undefined,
      ...picked,
    }),
  };
};
