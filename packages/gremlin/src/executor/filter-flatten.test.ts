/**
 * `filter(has(…))` and `and(has(…), hasLabel(…))` flatten into the enclosing chain (item 1308).
 *
 * THE REWRITE IS ANSWER-EQUIVALENT WHERE IT APPLIES, so a flattener that silently stops firing
 * returns the same rows through the traverser pipeline and no answer test can see it. Item 1303
 * measured that, and item 1307 found the sharper version of the same hole: asserting the rewrite
 * FUNCTION leaves alive the mutant that stops CALLING it. So both are asserted here — the
 * function, and `effectivePlan`, which is the composition the executor actually uses.
 *
 * FLATTENING WHERE IT IS NOT SOUND IS A WRONG ANSWER, and one case makes the whole rule: a body
 * that REPLACES the element rather than keeping-or-dropping it. `filter(out('T'))` keeps vertices
 * that have an outgoing `T` edge; splicing `out('T')` would replace each vertex with its
 * neighbours. That is asserted as an answer, not just as a plan shape.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import type { Step } from '../ast.js';
import { gte } from '../predicates.js';
import {
  E,
  V,
  and,
  count,
  dedupe,
  filter,
  has,
  hasId,
  hasKey,
  hasLabel,
  hasNot,
  not,
  or,
  out,
  outE,
  properties,
  values,
} from '../steps.js';
import { traversal } from '../traversal.js';
import { effectivePlan, flattenFilterWrappers, toArray } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 6; i++) {
    g.addVertex({
      id: `v${i}`,
      labels: i % 2 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: i, s: `s${i % 3}` },
    });
  }

  const v = (i: number) => g.verticesById.get(`v${i}`)!;

  g.addEdge({ id: 'e1', from: v(0), to: v(1), labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: v(2), to: v(3), labels: ['T'], properties: {} });

  return g;
};

const kinds = (steps: readonly { kind: string }[]): string[] => steps.map((s) => s.kind);
const ids = (rows: readonly unknown[]): unknown[] =>
  rows.map((r) => (typeof r === 'object' && r !== null ? (r as { id: unknown }).id : r));

describe('a wrapped filter flattens into the chain', () => {
  test('filter(has) becomes has', () => {
    const flat = flattenFilterWrappers(traversal(V(), filter(has('k', gte(3))), count()));

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'count']);
  });

  test('and(has, hasLabel) becomes the two steps chained, IN WRITTEN ORDER', () => {
    const flat = flattenFilterWrappers(
      traversal(V(), and(has('k', gte(2)), hasLabel('Q')), count()),
    );

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'hasLabel', 'count']);
  });

  test('a three-branch and flattens every branch', () => {
    const flat = flattenFilterWrappers(
      traversal(V(), and(has('k', gte(2)), hasLabel('Q'), hasKey('s')), count()),
    );

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'hasLabel', 'hasKey', 'count']);
  });

  test('a plan with no wrapper is returned UNCHANGED, by identity', () => {
    const plan = traversal(V(), has('k', gte(3)), count());

    expect(flattenFilterWrappers(plan)).toBe(plan);
  });

  test('the rewrite is WIRED into effectivePlan', () => {
    // Asserting the function alone leaves alive the mutant that stops calling it — the suite then
    // answers identically through the traverser pipeline (items 1303, 1307).
    const flat = effectivePlan(traversal(V(), filter(has('k', gte(3))), count()), build(), false);

    expect(kinds(flat.steps)).toEqual(['V', 'has', 'count']);
  });
});

describe('has(label, key, pred) splits into the two steps it fuses (item 1309)', () => {
  test('the three-argument has becomes hasLabel + has', () => {
    const flat = flattenFilterWrappers(traversal(V(), has('Q', 'k', gte(2)), count()));

    expect(kinds(flat.steps)).toEqual(['V', 'hasLabel', 'has', 'count']);
  });

  test('it is WIRED into effectivePlan', () => {
    const flat = effectivePlan(traversal(V(), has('Q', 'k', gte(2)), count()), build(), false);

    expect(kinds(flat.steps)).toEqual(['V', 'hasLabel', 'has', 'count']);
  });

  test('a hasLabelAnd inside an and() is flattened AND split', () => {
    // The split lives in the same pass as the wrapper flattening so this composes: the `and`
    // splices its branches, and the `hasLabelAnd` that comes out is then split.
    const flat = flattenFilterWrappers(
      traversal(V(), and(has('Q', 'k', gte(2)), hasKey('s')), count()),
    );

    expect(kinds(flat.steps)).toEqual(['V', 'hasLabel', 'has', 'hasKey', 'count']);
  });

  const SPLIT_PAIRS: ReadonlyArray<
    readonly [string, ReturnType<typeof traversal>, ReturnType<typeof traversal>]
  > = [
    [
      'the middle case',
      traversal(V(), hasLabel('Q'), has('k', gte(2))),
      traversal(V(), has('Q', 'k', gte(2))),
    ],
    [
      'counted',
      traversal(V(), hasLabel('Q'), has('k', gte(2)), count()),
      traversal(V(), has('Q', 'k', gte(2)), count()),
    ],
    [
      'a label NO element carries',
      traversal(V(), hasLabel('Nope'), has('k', gte(0))),
      traversal(V(), has('Nope', 'k', gte(0))),
    ],
    [
      'an ABSENT key',
      traversal(V(), hasLabel('Q'), has('zz', gte(0))),
      traversal(V(), has('Q', 'zz', gte(0))),
    ],
    [
      'projected off the end',
      traversal(V(), hasLabel('Q'), has('k', gte(2)), values('k')),
      traversal(V(), has('Q', 'k', gte(2)), values('k')),
    ],
  ];

  for (const [name, flat, fused] of SPLIT_PAIRS) {
    test(`${name} agrees`, () => {
      const g = build();

      expect(ids(toArray(fused, g))).toEqual(ids(toArray(flat, g)));
    });
  }
});

describe('bodies that are NOT keep-or-drop must decline', () => {
  test('filter(out(T)) does not flatten, and keeps its EXISTENCE meaning', () => {
    const g = build();
    const plan = traversal(V(), filter(out('T')));

    expect(kinds(flattenFilterWrappers(plan).steps)).toEqual(['V', 'filter']);
    // This is the assertion that makes the rule necessary rather than merely cautious: the answer
    // is the vertices that HAVE an outgoing `T`, not their neighbours.
    expect(ids(toArray(plan, g))).toEqual(['v0', 'v2']);
  });

  test('an and with ONE non-filter branch does not flatten', () => {
    const plan = traversal(V(), and(has('k', gte(2)), out('T')), count());

    expect(kinds(flattenFilterWrappers(plan).steps)).toEqual(['V', 'and', 'count']);
  });

  test('a nested wrapper does not flatten (a filter is not a pure element filter)', () => {
    const plan = traversal(V(), filter(filter(has('k', gte(3)))), count());

    // Not recursive by design: one level is what was measured. A recursive version would be its
    // own item, with its own numbers.
    expect(kinds(flattenFilterWrappers(plan).steps)).toEqual(['V', 'filter', 'count']);
  });

  /**
   * ⚠️ THIS CASE USED TO ASSERT `not(hasNot(k))` WAS LEFT ALONE, and item 1331 changed it
   * deliberately. The distinction item 1327 draws applies: the assertion recorded a CONDITION of
   * this pass (it did not handle `not`), not a CONTRACT someone chose. Its stated reason — a
   * wrapper body must not be SPLICED into the chain, because a disjunction is not a chain — is
   * untouched: item 1331 does not splice the body, it replaces the whole step with the single
   * filter that means the same thing.
   *
   * So the decline is still asserted, on a body that genuinely cannot fold.
   */
  test('or is left alone, and so is a not whose body is not a presence test', () => {
    const orPlan = traversal(V(), or(has('k', gte(4)), hasLabel('Q')), count());
    const notPlan = traversal(V(), not(out('T')), count());

    expect(kinds(flattenFilterWrappers(orPlan).steps)).toEqual(['V', 'or', 'count']);
    expect(kinds(flattenFilterWrappers(notPlan).steps)).toEqual(['V', 'not', 'count']);
  });

  test('a not whose body is MORE than one step is left alone', () => {
    // `not(hasNot(k).dedupe())` is a different question: the fold claims nothing about a body
    // that filters and then does something else.
    const plan = traversal(V(), not(traversal(hasNot('k'), dedupe())), count());

    expect(kinds(flattenFilterWrappers(plan).steps)).toEqual(['V', 'not', 'count']);
  });

  test('not(hasNot(k)) folds to hasKey, and not(hasKey(k)) folds to hasNot', () => {
    // Item 1331's 17x. The `not` step applies a whole sub-plan PER TRAVERSER, so this spelling
    // paid 200,000 sub-plan applications where `hasKey` reads a property bag.
    expect(kinds(flattenFilterWrappers(traversal(V(), not(hasNot('k')), count())).steps)).toEqual([
      'V',
      'hasKey',
      'count',
    ]);
    expect(kinds(flattenFilterWrappers(traversal(V(), not(hasKey('k')), count())).steps)).toEqual([
      'V',
      'hasNot',
      'count',
    ]);
  });

  test('the fold DECLINES once the stream is no longer elements', () => {
    /**
     * The soundness gate, and it is a MEASURED requirement rather than caution. `hasKey` is
     * `keys.some(k => k in bag)` and `hasNot` is `keys.every(k => !(k in bag))`, so on elements
     * "not all absent" IS "at least one present". On a non-element `hasNot` returns false, so
     * `not(hasNot(k))` PASSES what `hasKey(k)` filters — measured at 1 vs 3 after `properties()`
     * and 0 vs 2 after `values()`. Folding there would be a WRONG ANSWER.
     */
    const afterProperties = traversal(V(), properties(), not(hasNot('k')), count());
    const afterValues = traversal(V(), values('k'), not(hasNot('k')), count());

    expect(kinds(flattenFilterWrappers(afterProperties).steps)).toEqual([
      'V',
      'properties',
      'not',
      'count',
    ]);
    expect(kinds(flattenFilterWrappers(afterValues).steps)).toEqual([
      'V',
      'values',
      'not',
      'count',
    ]);
  });

  test('a hop keeps the stream elements, so the fold still applies after one', () => {
    const plan = traversal(V(), out('T'), not(hasNot('k')), count());

    expect(kinds(flattenFilterWrappers(plan).steps)).toEqual(['V', 'out', 'hasKey', 'count']);
  });

  /**
   * Item 1332: `or` of same-kind ANY-of filters merges into one. A PLAN assertion, because that is
   * the real signal and time is only the backstop — and here the timing is genuinely bimodal
   * after the fold ([81.6, 79.6, 47.9, 81.7] across four rounds), so a plan check is the only
   * thing that settles equivalence.
   *
   * Measured at 1,000,000 vertices, four rounds order-alternated, medians: the `or` spelling
   * 163.501 -> 81.623 ms, **2.00x**, and it now reads the same as the direct `hasLabel(a,b)`
   * (82.112) which is flat at 1.03x as the control.
   */
  test('or of same-kind ANY-of filters merges: hasLabel, hasId and hasKey', () => {
    expect(
      kinds(
        flattenFilterWrappers(
          traversal(V(), or(traversal(hasLabel('P')), traversal(hasLabel('Q'))), count()),
        ).steps,
      ),
    ).toEqual(['V', 'hasLabel', 'count']);

    expect(
      kinds(
        flattenFilterWrappers(
          traversal(V(), or(traversal(hasKey('a')), traversal(hasKey('b'))), count()),
        ).steps,
      ),
    ).toEqual(['V', 'hasKey', 'count']);

    expect(
      kinds(
        flattenFilterWrappers(
          traversal(V(), or(traversal(hasId('v1')), traversal(hasId('v2'))), count()),
        ).steps,
      ),
    ).toEqual(['V', 'hasId', 'count']);
  });

  test('the merged list is the CONCATENATION, deduped, in first-seen order', () => {
    // Not just the right step KIND — the right contents. A fold that produced `hasLabel(P)` alone
    // would pass the kind assertion above and answer a different question.
    const [, folded] = flattenFilterWrappers(
      traversal(V(), or(traversal(hasLabel('P', 'R')), traversal(hasLabel('Q', 'P'))), count()),
    ).steps;

    expect(folded.kind).toBe('hasLabel');
    expect((folded as Extract<Step, { kind: 'hasLabel' }>).labels).toEqual(['P', 'R', 'Q']);
  });

  test('a MIXED-kind or does not merge, and neither does a multi-step branch', () => {
    // `or(hasLabel(a), hasId(x))` is not a merge of either list; merging would answer a different
    // question silently. And a branch that filters then does something else is not a filter.
    const mixed = traversal(V(), or(traversal(hasLabel('P')), traversal(hasId('v1'))), count());
    const multi = traversal(
      V(),
      or(traversal(hasLabel('P'), dedupe()), traversal(hasLabel('Q'))),
      count(),
    );

    expect(kinds(flattenFilterWrappers(mixed).steps)).toEqual(['V', 'or', 'count']);
    expect(kinds(flattenFilterWrappers(multi).steps)).toEqual(['V', 'or', 'count']);
  });

  test('a ONE-branch or is left alone, and that scope limit is deliberate', () => {
    /**
     * Folding `or(hasLabel(P))` to `hasLabel(P)` would be ANSWER-EQUIVALENT — a one-branch
     * disjunction is just its branch — so no answer test can ever see the difference, and mutation
     * said so: `single-branch-admitted` SURVIVED with every other mutant dead. It is not a
     * coverage gap and not dead code; it is an unmeasured candidate, and item 1328's rule applies
     * — a new form waits for a measurement instead of being admitted by omission.
     *
     * So the decline gets a PLAN assertion, which is the only instrument that can hold it. If
     * someone measures the one-branch form and wants it folded, this is the test to change, with
     * the number attached.
     */
    const plan = traversal(V(), or(traversal(hasLabel('P'))), count());

    expect(kinds(flattenFilterWrappers(plan).steps)).toEqual(['V', 'or', 'count']);
  });

  test('hasLabelAnd is NOT an ANY-of kind and does not merge', () => {
    // A separate step kind with conjunctive semantics: merging its lists would be a wrong answer,
    // and the allow-list keyed by kind is what keeps it out.
    const plan = traversal(V(), or(traversal(hasLabel('P')), traversal(hasKey('a'))), count());

    // Different ANY-of kinds also decline — same rule, and this is the pair most likely to look
    // mergeable at a glance.
    expect(kinds(flattenFilterWrappers(plan).steps)).toEqual(['V', 'or', 'count']);
  });

  test('the or-fold needs NO element gate, unlike the not-fold', () => {
    /**
     * Item 1331's fold had to be gated because `not` INVERTS: a non-element's false became a pass.
     * `or` does not invert, so both spellings reject a non-element identically — measured as
     * element 2 and 2, after `properties()` 0 and 0, after `values()` 0 and 0. So the fold applies
     * even where the stream has stopped carrying elements, and that is deliberate rather than
     * overlooked.
     */
    const plan = traversal(
      V(),
      properties(),
      or(traversal(hasKey('k')), traversal(hasKey('other'))),
      count(),
    );

    expect(kinds(flattenFilterWrappers(plan).steps)).toEqual([
      'V',
      'properties',
      'hasKey',
      'count',
    ]);
  });

  /**
   * EDGES are elements too, and nothing here said so. Mutation found it: `edge-source-dropped`
   * removes `'E'` from `ELEMENT_SOURCES` and SURVIVED a pass where all six other mutants died,
   * because every case used a vertex source. `hasKey` and `hasNot` both test
   * `isVertex(v) || isEdge(v)` and read the same property bag, so the duality holds identically
   * for an edge — the gap was in the tests, not the rule.
   */
  test('an EDGE source is elements as well, so the fold applies to E() too', () => {
    expect(kinds(flattenFilterWrappers(traversal(E(), not(hasNot('w')), count())).steps)).toEqual([
      'E',
      'hasKey',
      'count',
    ]);
    // And through an edge hop, which lands on edges rather than vertices.
    expect(
      kinds(flattenFilterWrappers(traversal(V(), outE('T'), not(hasNot('w')), count())).steps),
    ).toEqual(['V', 'outE', 'hasKey', 'count']);
  });
});

describe('the wrapped and flat spellings answer identically', () => {
  const PAIRS: ReadonlyArray<
    readonly [string, ReturnType<typeof traversal>, ReturnType<typeof traversal>]
  > = [
    [
      'filter(has) vs has',
      traversal(V(), has('k', gte(3))),
      traversal(V(), filter(has('k', gte(3)))),
    ],
    [
      'and(has, hasLabel) vs the chain',
      traversal(V(), has('k', gte(2)), hasLabel('Q')),
      traversal(V(), and(has('k', gte(2)), hasLabel('Q'))),
    ],
    [
      'the chain in the OTHER order',
      traversal(V(), hasLabel('Q'), has('k', gte(2))),
      traversal(V(), and(hasLabel('Q'), has('k', gte(2)))),
    ],
    [
      'counted',
      traversal(V(), has('k', gte(2)), hasLabel('Q'), count()),
      traversal(V(), and(has('k', gte(2)), hasLabel('Q')), count()),
    ],
    [
      'projected',
      traversal(V(), has('k', gte(2)), values('k')),
      traversal(V(), filter(has('k', gte(2))), values('k')),
    ],
    [
      'a wrapper that keeps NOTHING',
      traversal(V(), has('k', gte(99))),
      traversal(V(), filter(has('k', gte(99)))),
    ],
    [
      'a wrapper that keeps EVERYTHING',
      traversal(V(), has('k', gte(0))),
      traversal(V(), filter(has('k', gte(0)))),
    ],
  ];

  for (const [name, flat, wrapped] of PAIRS) {
    test(`${name} agrees`, () => {
      const g = build();

      expect(ids(toArray(wrapped, g))).toEqual(ids(toArray(flat, g)));
    });
  }

  test('a cross-type comparison answers EMPTY in every spelling, and raises in none', () => {
    const g = build();

    // Raise parity, checked rather than assumed: a splice that short-circuited where the wrapper
    // did not would turn a fault into a row. On this surface the comparison is simply false, so
    // there is no fault to reorder — and that is a property of THIS surface, not carried over from
    // the GQL side's cross-type policy.
    expect(ids(toArray(traversal(V(), has('s', gte(5))), g))).toEqual([]);
    expect(ids(toArray(traversal(V(), filter(has('s', gte(5)))), g))).toEqual([]);
    expect(ids(toArray(traversal(V(), and(has('k', gte(0)), has('s', gte(5)))), g))).toEqual([]);
  });
});
