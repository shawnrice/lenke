import type { Element, Graph, Vertex } from '@lenke/core';

import type { Plan } from '../ast.js';
import type { Hop } from './hop-arm.js';
import type { HopValues } from './hop-values.js';
import { adjacentEdges, soleTypeBucket } from './movement.js';
import { optionalSingleHop } from './optional-hop.js';

/**
 * `V().choose(<one hop>, <value arm>, <value arm>)` answered WHOLESALE (item 2014).
 *
 * ⚠️⚠️ **THIS IS THE MIRROR OF ITEM 1999's RUNG, AND THE TWO DO NOT OVERLAP.** `choose-hop-values.ts`
 * takes a VERTEX-FILTER test with HOP arms (`choose(has(k,v), out(E), in_(E))`); this takes a HOP test
 * with VALUE arms (`choose(out(E), values(k), constant(c))`). Item 1999 deliberately declined the hop
 * test — "that asks whether an edge exists, not a vertex predicate" — and its route test pins the
 * decline. So this is the shape that decline left behind, and the Gremlin workload screen put it
 * SECOND on the surface, behind only the closed `pathdep: tree` row.
 *
 * 🔑 **THE TEST NEVER TRAVERSES AN EDGE.** `choose`'s test is "does the sub-plan produce anything",
 * and for a bare hop that is exactly "is the adjacency non-empty" — a bucket presence check, not a
 * walk. The general path runs the hop as a sub-plan per traverser and materializes its output to ask
 * whether it was empty.
 *
 * MEASURED, isolated at 200,000 vertices (one shape per process, item 762's rule), against a hand
 * ceiling that does exactly one bucket lookup and one property read per vertex — digests identical:
 *
 * ```text
 *     choose(out(E), values(n), constant('none'))   101.40 ms   507 ns/row
 *     hand ceiling                                   10.21 ms    51 ns/row    9.9x
 * ```
 *
 * ⚠️ THE ARM SEMANTICS ARE NOT INTERCHANGEABLE, and the fixture that priced this cannot tell them
 * apart — every vertex there carries `n`. They differ exactly when the key is MISSING:
 *
 * ```text
 *     values(k)     emits NOTHING for a vertex without `k`  — the row DISAPPEARS
 *     identity()    emits the vertex itself                 — always one row
 *     constant(c)   emits `c`                               — always one row
 * ```
 *
 * So `values` is the only arm that can drop a row, and a route that emitted `undefined` instead would
 * agree on that fixture and diverge on any graph with a sparse property. `drops` carries that per arm.
 */
type ValueArm =
  | { readonly kind: 'values'; readonly key: string }
  | { readonly kind: 'identity' }
  | { readonly kind: 'constant'; readonly value: unknown };

/** The arm shapes this rung admits — a single step that needs no traversal. */
const valueArmOf = (plan: Plan): ValueArm | null => {
  if (plan.steps.length !== 1) {
    return null;
  }

  const [only] = plan.steps;

  if (only.kind === 'identity') {
    return { kind: 'identity' };
  }

  if (only.kind === 'constant') {
    return { kind: 'constant', value: only.value };
  }

  // ⚠️ ONE KEY ONLY: `values()` with no key emits every property value and `values(a, b)` fans out
  // per key, so neither is one row per vertex.
  return only.kind === 'values' && only.keys.length === 1
    ? { kind: 'values', key: only.keys[0] }
    : null;
};

/** `true` when this vertex has at least one edge the hop would take — no edge is traversed. */
const hopHasAny = (graph: Graph, v: Vertex, hop: Hop): boolean => {
  const direct = soleTypeBucket(v, hop.kind, hop.labels);

  if (direct !== undefined) {
    return direct.set.size > 0;
  }

  // `both`, a multi-type hop and an untyped one have no single bucket, so they fall back to the
  // shared iterator — but still stop at the FIRST edge rather than draining it.
  for (const _ of adjacentEdges(hop.kind, graph, v, hop.labels)) {
    void _;

    return true;
  }

  return false;
};

/**
 * ⚠️ ONE LOOP, PARAMETERIZED, AT MODULE SCOPE — [[ts-closure-size-is-load-bearing]], where a walk
 * written inline in a returned closure gave UNRELATED queries a new slow mode at 4x.
 */
const chooseTestWalk = (
  graph: Graph,
  spec: {
    readonly test: Hop;
    // ⚠️ `whenTrue`, NOT `then` — an object with a `then` property is THENABLE, so it would be
    // awaited rather than passed if it ever reached an `await`. The `unicorn/no-thenable` lint rule
    // caught it, and it is a real hazard rather than a style preference.
    readonly whenTrue: ValueArm;
    readonly otherwise: ValueArm | undefined;
  },
): Iterable<unknown> => ({
  *[Symbol.iterator]() {
    const { test, whenTrue: thenArm, otherwise } = spec;

    for (const v of graph.vertices) {
      const arm = hopHasAny(graph, v, test) ? thenArm : otherwise;

      // ⚠️ AN ABSENT `else` PASSES THE TRAVERSER THROUGH — per TinkerPop, which `chooseStep`'s own
      // comment records against the AST comment that reads the other way.
      if (arm === undefined) {
        yield v;

        continue;
      }

      if (arm.kind === 'constant') {
        yield arm.value;

        continue;
      }

      if (arm.kind === 'identity') {
        yield v;

        continue;
      }

      const own = (v as Element).properties[arm.key];

      // ⚠️ `values(k)` DROPS a vertex without `k`; it does not emit `undefined`. See the header.
      if (own !== undefined) {
        yield own;
      }
    }
  },
});

export const chooseTestValues = (plan: Plan, graph: Graph): HopValues | undefined => {
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

  // THE TEST IS A SINGLE HOP. A vertex-filter test is item 1999's rung, which runs above this one.
  const test = optionalSingleHop(wrapper.test);

  if (test === undefined) {
    return undefined;
  }

  const whenTrue = valueArmOf(wrapper.thenPlan);

  if (whenTrue === null) {
    return undefined;
  }

  const otherwise = wrapper.elsePlan === undefined ? undefined : valueArmOf(wrapper.elsePlan);

  if (wrapper.elsePlan !== undefined && otherwise === null) {
    return undefined;
  }

  return {
    // ⚠️ THE ARMS **ARE** THE PROJECTION, so everything after the `choose` is `rest` — unlike item
    // 1999's rung, where a `values` step follows the wrapper and is folded in.
    rest: steps.slice(2),
    values: chooseTestWalk(graph, { test, whenTrue, otherwise: otherwise ?? undefined }),
  };
};
