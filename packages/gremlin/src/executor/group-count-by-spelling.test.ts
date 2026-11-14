import { describe, expect, test } from 'bun:test';

/**
 * `groupCount({ by: k })` AND `groupCount().by(k)` MUST COST AND ANSWER THE SAME — item 1856.
 *
 * `asGroupCountByKey` tested `typeof bys[0] === 'string'`, but `.by('k')` builds a
 * `{ kind: 'key', key: 'k' }` modulator while `groupCount({ by: 'k' })` sets a legacy `by` field.
 * So the modulator spelling never matched and the whole fused hop chain declined for it:
 * **2.9x at one hop and 19.2x at two, for the same seven groups.** CLAUDE.md's opening defect
 * class — the planner recognising one spelling and scanning for another that means the same thing.
 *
 * ⚠️ THE MAP'S ORDER IS PART OF ITS ANSWER, so every assertion here compares `[...map]` as an
 * ARRAY. `groupCount` returns a Map whose iteration order is first-occurrence order of the keys,
 * and byte-identity with the Rust engine is a hard invariant — two spellings agreeing on the
 * groups but not on their order would still be a divergence. Item 1834 made the same point when it
 * fused this walk in the first place.
 *
 * ⚠️ AND A GROUP COUNT OVER AN EMPTY FRONTIER PROVES NOTHING. The first version of the companion
 * spelling-probe group used an edge label the fixture does not carry, so both spellings answered
 * an EMPTY Map and converged trivially. The fixture below is asserted non-vacuous.
 */
import { Graph } from '@lenke/core';

import { V, groupCount, hasLabel, in_ as inV, out, toArray, traversal } from '../index.js';
import { asGroupCountByKey } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const n = 60;

  for (let i = 0; i < n; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: i % 5 === 0 ? ['T', 'Odd'] : ['T'],
      // `k` repeats so there are real groups; `miss` is absent on most vertices so the NO_VALUE
      // path is exercised too.
      properties: i % 4 === 0 ? { k: i % 3 } : { k: i % 3, miss: i % 2 },
    });
  }

  for (let h = 0; h < 2; h += 1) {
    for (let i = 0; i < n; i += 1) {
      const from = g.getVertexById(`v${i}`);
      const to = g.getVertexById(`v${(i * 7 + 3 + h) % n}`);

      if (from === null || to === null) {
        throw new Error('fixture is broken');
      }

      g.addEdge({ id: `e${h * n + i}`, from, to, labels: ['E'] });
    }
  }

  return g;
};

const entries = (g: Graph, plan: Parameters<typeof toArray>[0]): [unknown, number][] => {
  const [m] = toArray(plan, g) as Map<unknown, number>[];

  return [...m];
};

describe('the two groupCount by-spellings', () => {
  test('agree on the entries AND their order, at every width', () => {
    const g = build();
    const pairs: [string, Parameters<typeof toArray>[0], Parameters<typeof toArray>[0]][] = [
      ['scan', traversal(V(), groupCount({ by: 'k' })), traversal(V(), groupCount().by('k'))],
      [
        'one hop',
        traversal(V(), out('E'), groupCount({ by: 'k' })),
        traversal(V(), out('E'), groupCount().by('k')),
      ],
      [
        'two hops',
        traversal(V(), out('E'), out('E'), groupCount({ by: 'k' })),
        traversal(V(), out('E'), out('E'), groupCount().by('k')),
      ],
      [
        'three hops',
        traversal(V(), out('E'), out('E'), out('E'), groupCount({ by: 'k' })),
        traversal(V(), out('E'), out('E'), out('E'), groupCount().by('k')),
      ],
      [
        'incoming',
        traversal(V(), inV('E'), inV('E'), groupCount({ by: 'k' })),
        traversal(V(), inV('E'), inV('E'), groupCount().by('k')),
      ],
      [
        'after a label filter',
        traversal(V(), hasLabel('Odd'), out('E'), groupCount({ by: 'k' })),
        traversal(V(), hasLabel('Odd'), out('E'), groupCount().by('k')),
      ],
      [
        'a key most vertices lack',
        traversal(V(), out('E'), groupCount({ by: 'miss' })),
        traversal(V(), out('E'), groupCount().by('miss')),
      ],
    ];

    for (const [name, config, modulator] of pairs) {
      const a = entries(g, config);
      const b = entries(g, modulator);

      // ⚠️ NON-VACUOUS, asserted: an empty Map would make the comparison meaningless.
      expect(`${name}: ${String(a.length)}`).not.toBe(`${name}: 0`);
      expect(`${name}: ${JSON.stringify(b)}`).toBe(`${name}: ${JSON.stringify(a)}`);
    }
  });

  /**
   * ⚠️ THE COUNTS MUST SUM TO THE WALK'S LENGTH, which is the check that does not depend on the
   * other spelling. Two routes that made the same mistake would agree with each other; this
   * compares against the number of elements the hop actually produced.
   */
  test('the tallies sum to the number of elements walked', () => {
    const g = build();
    const walked = toArray(traversal(V(), out('E'), out('E')), g).length;

    for (const plan of [
      traversal(V(), out('E'), out('E'), groupCount({ by: 'k' })),
      traversal(V(), out('E'), out('E'), groupCount().by('k')),
    ]) {
      expect(entries(g, plan).reduce((n, [, c]) => n + c, 0)).toBe(walked);
    }
  });

  /**
   * ⚠️ AN AMBIGUOUS PLAN CARRYING BOTH SPELLINGS, and a MULTI-`by` modulation, are refused rather
   * than resolved — a plan that said two things about its key should not have one of them silently
   * chosen. Both still answer, down the general pipeline.
   */
  test('a second by-modulator still answers', () => {
    const g = build();
    const two = entries(g, traversal(V(), out('E'), groupCount().by('k').by('miss')));
    const one = entries(g, traversal(V(), out('E'), groupCount().by('k')));

    // This engine ignores a second `by` (recorded at item 1834), so the two agree — the point is
    // that the refusal does not change the answer.
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });
});

/**
 * THE GATE ITSELF — item 1856.
 *
 * ⚠️ THESE ARE THE ONLY TESTS THAT CAN FAIL ON THIS CHANGE, and the mutation run is what proved
 * it: all four gate mutants (reject the modulator spelling, admit a non-`key` by, admit an
 * ambiguous plan, admit a multi-`by`) SURVIVED every answer test above, because a route choice is
 * answer-equivalent by construction — the general pipeline computes the same Map, just slowly.
 * `perf-gate-needs-its-own-test` names this exact situation, and the codebase's own answer is to
 * export the gate and test it as a function, as `dropUnreadPathVar` is.
 */
describe('the route gate', () => {
  const claims = (plan: Parameters<typeof toArray>[0]): boolean =>
    asGroupCountByKey(plan) !== undefined;

  test('claims BOTH by-spellings', () => {
    expect(claims(traversal(V(), out('E'), groupCount({ by: 'k' })))).toBe(true);
    expect(claims(traversal(V(), out('E'), groupCount().by('k')))).toBe(true);
    expect(claims(traversal(V(), out('E'), out('E'), groupCount().by('k')))).toBe(true);
  });

  test('rewrites to the same values plan for both spellings', () => {
    const fromConfig = asGroupCountByKey(traversal(V(), out('E'), groupCount({ by: 'k' })));
    const fromModulator = asGroupCountByKey(traversal(V(), out('E'), groupCount().by('k')));

    expect(JSON.stringify(fromModulator?.plan.steps)).toBe(JSON.stringify(fromConfig?.plan.steps));
    // …and that plan ends in a `values` step naming the key, which is the whole rewrite.
    expect(fromModulator?.plan.steps[fromModulator.plan.steps.length - 1]).toEqual({
      kind: 'values',
      keys: ['k'],
    });
  });

  test('refuses an ambiguous plan carrying both spellings', () => {
    const plan = traversal(V(), out('E'), groupCount({ by: 'k' }));
    const last = plan.steps[plan.steps.length - 1] as { bys?: unknown[] };
    const ambiguous = {
      ...plan,
      steps: [...plan.steps.slice(0, -1), { ...last, bys: [{ kind: 'key', key: 'k' }] }],
    };

    expect(claims(ambiguous as Parameters<typeof toArray>[0])).toBe(false);
  });

  test('refuses a multi-by modulation and a non-key by', () => {
    expect(claims(traversal(V(), out('E'), groupCount().by('k').by('miss')))).toBe(false);
    expect(claims(traversal(V(), out('E'), groupCount()))).toBe(false);
  });

  test('refuses a plan whose last step is not a groupCount', () => {
    expect(claims(traversal(V(), out('E')))).toBe(false);
  });
});
