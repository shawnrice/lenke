/**
 * ITEM 1505 — `Plan.kinds` is a bitmask of the step kinds that GATE a rewrite pass in
 * `effectivePlan`, so a pass that cannot fire returns in one test instead of walking the step list.
 * Measured on a reused plan: count 200 → 162 ns, hop 265 → 215, filtered 1031 → 968; cumulative with
 * item 1504, count 315 → 162 (1.94x) and hop 456 → 215 (2.12x).
 *
 * ⚠️ A WRONGLY-SKIPPED FUSION IS INVISIBLE TO EVERY ANSWER TEST. The passes are answer-equivalent
 * optimisations — `outE(T).inV()` becomes `out(T)` with identical rows — so a broken gate costs
 * speed and nothing else. Item 1307 measured that particular one at **18936-24433x**, and the 1,422
 * tests in this package would all stay green through it. That is `perf-gate-needed-its-own-test` in
 * its purest form, so this file tests the MASK, not the rows.
 *
 * The invariant it leans on: **`plan.kinds` must always equal `maskOfSteps(plan.steps)`**. That one
 * property covers construction, every rewrite, and the hazard below.
 *
 * ⚠️ THE HAZARD WORTH NAMING: `fuseLocal` runs FIRST in the pipeline and INLINES a sub-plan's steps
 * into the top level. So it can introduce a `union`, a `values` or an edge step that the original
 * mask never recorded — and a later pass gated on a stale mask would skip a fusion it should make.
 * Every rewrite therefore recomputes; `holdsInvariant` is what proves it.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { EDGE_STEP_BITS, FILTER_WRAPPER_BITS, KIND_BITS, maskOfSteps, type Plan } from './ast.js';
import { effectivePlan } from './executor/index.js';
import {
  V,
  both,
  bothE,
  coalesce,
  count,
  gt,
  has,
  hasLabel,
  inE,
  inV,
  in_,
  local,
  out,
  outE,
  toArray,
  traversal,
  union,
  values,
} from './index.js';

const graph = new Graph();

for (let i = 0; i < 8; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } });
}

for (let e = 0; e < 7; e += 1) {
  graph.addEdge({
    id: `e${e}`,
    labels: ['E'],
    from: graph.getVertexById(`v${e}`)!,
    to: graph.getVertexById(`v${e + 1}`)!,
  });
}

/** The invariant, asserted on a plan and on what `effectivePlan` turns it into. */
const holdsInvariant = (plan: Plan, label: string): void => {
  expect(plan.kinds, `${label}: as built`).toBe(maskOfSteps(plan.steps));

  const out_ = effectivePlan(plan, graph, false);

  expect(out_.kinds, `${label}: after effectivePlan`).toBe(maskOfSteps(out_.steps));
};

describe('the mask records exactly the gate kinds in the top-level steps', () => {
  it('sets the bit for each gate kind', () => {
    expect(traversal(V(), local(traversal(out('E')))).kinds & KIND_BITS.local).not.toBe(0);
    expect(traversal(V(), union(traversal(out('E')))).kinds & KIND_BITS.union).not.toBe(0);
    expect(traversal(V(), values('k')).kinds & KIND_BITS.values).not.toBe(0);
    expect(traversal(V(), outE('E')).kinds & KIND_BITS.outE).not.toBe(0);
    expect(traversal(V(), inE('E')).kinds & KIND_BITS.inE).not.toBe(0);
    expect(traversal(V(), bothE('E')).kinds & KIND_BITS.bothE).not.toBe(0);
  });

  it('leaves the bit clear when the kind is absent', () => {
    const plain = traversal(V(), out('E'), count());

    expect(plain.kinds & KIND_BITS.local).toBe(0);
    expect(plain.kinds & KIND_BITS.union).toBe(0);
    expect(plain.kinds & KIND_BITS.values).toBe(0);
    // ⚠️ `out` is NOT an edge step — `outE` is. A mask that confused them would gate `fuseEdgeHop`
    // on every vertex hop, which is the common case, and the pass would run for nothing.
    expect(plain.kinds & EDGE_STEP_BITS).toBe(0);
  });

  it('⚠️ TOP-LEVEL ONLY — a union buried in a sub-plan does not set the top-level bit', () => {
    // Each gated pass iterates `plan.steps` and never recurses, so a nested `union` is not
    // something it can fuse. Recording it would make the mask pessimistic and the gate useless.
    // (This is the opposite rule from `readsPath`, which MUST propagate — see item 1504.)
    const nested = traversal(V(), local(traversal(union(traversal(out('E'))))));

    expect(nested.kinds & KIND_BITS.local).not.toBe(0);
    expect(nested.kinds & KIND_BITS.union).toBe(0);
  });

  it('accumulates across steps and is order-independent', () => {
    const a = traversal(V(), values('k'), outE('E'));
    const b = traversal(V(), outE('E'), values('k'));

    expect(a.kinds).toBe(b.kinds);
    expect(a.kinds & KIND_BITS.values).not.toBe(0);
    expect(a.kinds & KIND_BITS.outE).not.toBe(0);
  });
});

describe('⚠️ the invariant survives every rewrite — kinds === maskOfSteps(steps)', () => {
  for (const [label, plan] of [
    ['plain count', traversal(V(), count())],
    ['vertex hop', traversal(V(), out('E'), count())],
    ['edge hop that FUSES to out()', traversal(V(), outE('E'), count())],
    ['values', traversal(V(), values('k'))],
    ['values + count', traversal(V(), values('k'), count())],
    ['local wrapping transparent steps', traversal(V(), local(traversal(out('E'))))],
    ['union of two hops', traversal(V(), union(traversal(out('E')), traversal(out('E'))))],
    [
      'union that fuses to both()',
      traversal(V(), union(traversal(out('E')), traversal(both('E')))),
    ],
    ['coalesce', traversal(V(), coalesce(traversal(out('E')), traversal(both('E'))))],
    ['nested local in union', traversal(V(), union(traversal(local(traversal(out('E'))))))],
  ] as const) {
    it(`holds for ${label}`, () => {
      holdsInvariant(plan, label);
    });
  }

  it('⚠️ holds when fuseLocal INLINES steps that carry a gate kind — the staleness hazard', () => {
    // `local` wrapping only LOCAL_TRANSPARENT_STEPS is inlined into the top level by `fuseLocal`,
    // the FIRST pass. If the inlined steps carry a gate bit the original plan lacked, a later pass
    // reading a stale mask would skip. `values` is both transparent and a gate kind, which is what
    // makes this shape the one that can catch it.
    const plan = traversal(V(), local(traversal(out('E'), values('k'))), count());

    expect(plan.kinds & KIND_BITS.local).not.toBe(0);

    const fused = effectivePlan(plan, graph, false);

    // ⚠️ UNCONDITIONAL, AND THE FIRST VERSION WAS NOT. It guarded these assertions with
    // `if ((fused.kinds & KIND_BITS.local) === 0)` — so a `wrong-gate` mutant (gate `fuseLocal` on
    // the `union` bit instead of `local`) made the fusion never happen, the `if` never run, and all
    // 20 tests pass. A gate that silently stops firing is invisible to every ANSWER test, because
    // the fusions are answer-equivalent; the only thing that can catch it is asserting the fusion
    // HAPPENED. `out` and `values` are both LOCAL_TRANSPARENT_STEPS, so `fuseLocal` must inline
    // this sub-plan and the `local` step must be gone.
    expect(
      fused.steps.some((st) => st.kind === 'local'),
      'local must be inlined',
    ).toBe(false);
    expect(
      fused.steps.some((st) => st.kind === 'values'),
      'values lifted to top level',
    ).toBe(true);
    expect(fused.kinds & KIND_BITS.values, 'the mask records the LIFTED values').not.toBe(0);

    // And whatever the pipeline produced, the mask must describe THOSE steps.
    expect(fused.kinds).toBe(maskOfSteps(fused.steps));
  });

  it('⚠️ each gated pass still FIRES for the plan it gates on', () => {
    // The companion to the test above, for the other four gates. Each asserts the rewrite's own
    // observable effect, because a gate on the wrong bit changes no answer.
    // ⚠️ `outE('E'), inV()` — NOT a bare `outE`. The pass fuses the PAIR into `out('E')` (item
    // 1307, measured at 18936-24433x); a lone `outE` has nothing to fuse and legitimately survives,
    // which is what the first version of this assertion got wrong.
    const edgeHop = effectivePlan(traversal(V(), outE('E'), inV(), count()), graph, false);

    expect(
      edgeHop.steps.some((st) => st.kind === 'outE'),
      'outE+inV fuses to out()',
    ).toBe(false);
    expect(
      edgeHop.steps.some((st) => st.kind === 'out'),
      'and becomes a vertex hop',
    ).toBe(true);

    // ⚠️ `union(out(L), in(L))` with IDENTICAL labels and exactly one step per arm — that is
    // `bothFromUnion`'s precondition, read from the code after guessing it wrong twice (a bare
    // `outE` with no `inV`, then `union(out, both)`). Each wrong guess made the assertion fail for
    // a reason that had nothing to do with the gate.
    const unioned = effectivePlan(
      traversal(V(), union(traversal(out('E')), traversal(in_('E'))), count()),
      graph,
      false,
    );

    expect(
      unioned.steps.some((st) => st.kind === 'union'),
      'union(out(L), in(L)) fuses to both(L)',
    ).toBe(false);
    expect(
      unioned.steps.some((st) => st.kind === 'both'),
      'and becomes both()',
    ).toBe(true);

    const valuesCount = effectivePlan(traversal(V(), values('k'), count()), graph, false);

    expect(valuesCount.kinds).toBe(maskOfSteps(valuesCount.steps));
  });
});

describe('⚠️ item 1506 — the two passes gated LAST, and the kind I first missed', () => {
  it('records hasLabel, and dropVacuousLabels still drops a vacuous label', () => {
    const labelled = traversal(V(), hasLabel('P'), count());

    expect(labelled.kinds & KIND_BITS.hasLabel).not.toBe(0);

    // Every vertex here carries `P`, so the label is VACUOUS and the pass must remove the step.
    const fused = effectivePlan(labelled, graph, false);

    expect(
      fused.steps.some((st) => st.kind === 'hasLabel'),
      'a vacuous hasLabel must be dropped',
    ).toBe(false);
    expect(fused.kinds).toBe(maskOfSteps(fused.steps));
  });

  it('a plan with no hasLabel leaves the bit clear', () => {
    expect(traversal(V(), out('E'), count()).kinds & KIND_BITS.hasLabel).toBe(0);
  });

  it('⚠️ FILTER_WRAPPER_BITS covers all FIVE kinds, including hasLabelAnd', () => {
    // My first gate listed four — `not`, `filter`, `or`, `and` — read off the function body's
    // explicit `step.kind ===` tests. The fifth is `pushSplit`, which runs unconditionally at the
    // bottom of the loop and splits `hasLabelAnd` (item 1309); two existing tests failed on it.
    // Enumerating from the code rather than the comments is what fixed it.
    for (const kind of ['not', 'filter', 'or', 'and', 'hasLabelAnd'] as const) {
      expect(KIND_BITS[kind], kind).toBeGreaterThan(0);
      expect(
        FILTER_WRAPPER_BITS & KIND_BITS[kind],
        `${kind} must be in FILTER_WRAPPER_BITS`,
      ).not.toBe(0);
    }
  });

  it('⚠️ the hasLabelAnd split still FIRES — the fold the four-bit gate silently lost', () => {
    // `has(label, key, pred)` builds a `hasLabelAnd`, which must split into `hasLabel` + `has`.
    const plan = traversal(V(), has('P', 'k', gt(3)), count());

    expect(plan.kinds & KIND_BITS.hasLabelAnd).not.toBe(0);

    const fused = effectivePlan(plan, graph, false);

    expect(
      fused.steps.some((st) => st.kind === 'hasLabelAnd'),
      'hasLabelAnd must be split',
    ).toBe(false);
    expect(
      fused.steps.some((st) => st.kind === 'has'),
      'into a has',
    ).toBe(true);
    expect(fused.kinds).toBe(maskOfSteps(fused.steps));
  });

  it('a plan with none of the five leaves the wrapper bits clear', () => {
    expect(traversal(V(), out('E'), count()).kinds & FILTER_WRAPPER_BITS).toBe(0);
    expect(traversal(V(), values('k')).kinds & FILTER_WRAPPER_BITS).toBe(0);
  });
});

describe('the gates do not change answers', () => {
  // Thin by design — the answer surface is covered by 1,422 other tests. These exist so that a
  // gate which skips a fusion outright is at least not also wrong.
  for (const [label, plan, want] of [
    ['edge hop', traversal(V(), outE('E'), count()), 7],
    ['vertex hop', traversal(V(), out('E'), count()), 7],
    ['union', traversal(V(), union(traversal(out('E')), traversal(out('E'))), count()), 14],
    ['local', traversal(V(), local(traversal(out('E'))), count()), 7],
    ['values', traversal(V(), values('k'), count()), 8],
  ] as const) {
    it(`${label} answers ${want}`, () => {
      expect(toArray(plan, graph)).toEqual([want]);
    });
  }
});
