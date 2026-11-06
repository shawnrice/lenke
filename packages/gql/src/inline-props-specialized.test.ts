import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate, satisfies, specializeSingleProp } from './executor.js';
import { query } from './index.js';

/**
 * Item 1598: `specializeSingleProp` admits the INLINE carrier (`props`), closing a stable
 * equivalent-spelling gap item 1597's probe found between the two spellings of one seeded count.
 *
 * ```text
 *                               PRE                       POST
 *    (u:User {team: $v})        17790 ns   329634 unindexed  12804   220486    1.39x / 1.55x
 *    (u:User) WHERE u.team = $v 12505      212893            12387   219897    flat (control)
 * ```
 *
 * ⚠️ THE CORRECTNESS CONDITION IS THE NULL MATRIX, and it is the whole reason `props` gets its OWN
 * arm rather than joining `eqProps`'s. The two carriers implement DIFFERENT readings of equality:
 *
 * ```text
 *    {k: null}         matches a stored null AND an absent key
 *    WHERE n.k = null  matches NEITHER
 * ```
 *
 * `propOf` returns `null` for both an absent key and a stored null, so plain `structuralEq` gives
 * the inline reading and `eqProps`'s null rejection gives the expression one. Item 260 settled
 * that `{k: null}` means IS NULL. So the mutant that matters here is not "does it specialize" but
 * "does the specialized closure keep the two readings apart" — which is what the first describe
 * block pins from both directions.
 */

const N = 240;

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    const properties: Record<string, unknown> = {
      team: `t${i % 6}`,
      score: i % 10,
      tags: [i % 3, 9],
    };

    // Three populations for the null matrix: a STORED null, an ABSENT key, and a present value.
    if (i % 4 === 0) {
      properties.note = null;
    } else if (i % 4 !== 1) {
      properties.note = `n${i % 5}`;
    }

    g.addVertex({ id: `u${i}`, labels: ['User'], properties });
  }

  return g;
};

const countOf = (g: Graph, text: string, params: Record<string, unknown> = {}): number =>
  Number(query(g, text, params)[0]?.c);

describe('the null matrix survives specialization', () => {
  const g = build();
  // 60 stored nulls (i % 4 === 0) and 60 absent keys (i % 4 === 1) in 240 vertices.
  const storedNull = 60;
  const absent = 60;

  test('an inline {k: null} matches a stored null AND an absent key', () => {
    expect(countOf(g, 'MATCH (u:User {note: null}) RETURN count(*) AS c')).toBe(
      storedNull + absent,
    );
  });

  test('the same through a $param, which is the shape that reaches the fast arm', () => {
    // ⚠️ THE LITERAL AND THE PARAM ARE DIFFERENT ROUTES. A literal `null` can be folded at compile
    // time; a `$param` cannot, so this is the spelling whose value is resolved per element — the
    // one a null rejection in the wrong arm would break.
    expect(countOf(g, 'MATCH (u:User {note: $v}) RETURN count(*) AS c', { v: null })).toBe(
      storedNull + absent,
    );
  });

  test('a clause WHERE k = null matches NEITHER', () => {
    expect(countOf(g, 'MATCH (u:User) WHERE u.note = null RETURN count(*) AS c')).toBe(0);
    expect(countOf(g, 'MATCH (u:User) WHERE u.note = $v RETURN count(*) AS c', { v: null })).toBe(
      0,
    );
  });

  test('IS NULL agrees with the inline spelling, which is what makes them one question', () => {
    expect(countOf(g, 'MATCH (u:User) WHERE u.note IS NULL RETURN count(*) AS c')).toBe(
      storedNull + absent,
    );
  });

  test('the two readings are decided INSIDE the closure, not before it', () => {
    /**
     * The unit-level twin of the four counts above: both predicates carry the SAME key and the
     * same null right-hand side, differing only in which carrier holds it, and both specialize.
     * If one arm's rule leaked into the other this is where it shows, with no planner in between.
     */
    const inline = specializeSingleProp(
      compilePredicate([{ key: 'note', value: { kind: 'lit', value: null } }], undefined, 'u'),
    );
    const clause = specializeSingleProp(
      compilePredicate(
        undefined,
        {
          kind: 'compare',
          op: '=',
          left: { kind: 'prop', variable: 'u', key: 'note' },
          right: { kind: 'lit', value: null },
        },
        'u',
      ),
    );

    expect(inline).toBeDefined();
    expect(clause).toBeDefined();

    const env = { binding: new Map(), params: {}, graph: g } as never;
    const nulled = g.getVertexById('u0');
    const missing = g.getVertexById('u1');
    const present = g.getVertexById('u2');

    expect(inline?.(nulled as never, env)).toBe(true);
    expect(inline?.(missing as never, env)).toBe(true);
    expect(inline?.(present as never, env)).toBe(false);

    expect(clause?.(nulled as never, env)).toBe(false);
    expect(clause?.(missing as never, env)).toBe(false);
    expect(clause?.(present as never, env)).toBe(false);
  });
});

describe('the specialized inline arm agrees with satisfies on every value', () => {
  const g = build();

  test('a differential over the whole fixture, per vertex', () => {
    /**
     * The route assertion alone cannot catch a closure that computes the wrong thing, so this
     * compares the fast arm against `satisfies` — the general path's own implementation — element
     * by element, over values that are present, stored-null, absent, numeric and LIST-valued.
     */
    const cases: readonly { readonly key: string; readonly value: unknown }[] = [
      { key: 'team', value: 't3' },
      { key: 'team', value: 'nobody' },
      { key: 'score', value: 7 },
      { key: 'score', value: 0 },
      { key: 'note', value: null },
      { key: 'note', value: 'n2' },
      { key: 'tags', value: [1, 9] },
      { key: 'tags', value: [] },
      { key: 'missingKey', value: 'x' },
    ];

    for (const { key, value } of cases) {
      const pred = compilePredicate([{ key, value: { kind: 'lit', value } }], undefined, 'u');
      const fast = specializeSingleProp(pred);

      expect(fast).toBeDefined();

      let agreed = 0;

      for (let i = 0; i < N; i += 1) {
        const v = g.getVertexById(`u${i}`);
        const slow = satisfies(v as never, pred, new Map(), {}, g);

        expect(fast?.(v as never, { binding: new Map(), params: {}, graph: g })).toBe(slow);

        if (slow) {
          agreed += 1;
        }
      }

      // The differential is vacuous if nothing ever matched, so pin that each case is live or
      // deliberately empty.
      expect(agreed).toBe(
        Number(countOf(g, `MATCH (u:User {${key}: $v}) RETURN count(*) AS c`, { v: value })),
      );
    }
  });

  test('a LIST value matches a stored list structurally THROUGH the fast arm', () => {
    // ⚠️ Unlike `eqProps`, a list DOES reach this carrier — an inline list literal is one of the
    // shapes `props` carries. `satisfies` records the bug where JS `!==` made such a constraint
    // never match, so `structuralEq` must be the comparison here and not reference equality.
    const list = new Graph();

    list.addVertex({ id: 'a', labels: ['P'], properties: { tags: [1, 2] } });
    list.addVertex({ id: 'b', labels: ['P'], properties: { tags: [3] } });

    expect(countOf(list, 'MATCH (n:P {tags: [1, 2]}) RETURN count(*) AS c')).toBe(1);
    expect(countOf(list, 'MATCH (n:P {tags: $v}) RETURN count(*) AS c', { v: [1, 2] })).toBe(1);
  });
});

describe('the specializer still refuses what it must', () => {
  test('TWO inline properties refuse — one closure cannot answer a conjunction', () => {
    const two = compilePredicate(
      [
        { key: 'team', value: { kind: 'lit', value: 't1' } },
        { key: 'score', value: { kind: 'lit', value: 2 } },
      ],
      undefined,
      'u',
    );

    expect(specializeSingleProp(two)).toBeUndefined();
  });

  test('an inline property ALONGSIDE another carrier refuses', () => {
    const mixed = {
      props: [{ key: 's', value: () => 's1' }],
      cmpProps: [{ key: 'n', op: '>', value: () => 2 }],
    } as unknown as Parameters<typeof specializeSingleProp>[0];

    expect(specializeSingleProp(mixed)).toBeUndefined();
  });

  test('a CORRELATED inline property still answers correctly', () => {
    /**
     * `(b {k: a.k})` is a NON-CLOSED inline constraint, and this pins that admitting `props` to
     * the specializer did not reach it.
     *
     * ⚠️ IT IS NOT A TEST OF `buildNodeCount`'s `bindVar` GUARD, and item 1598's first version of
     * this comment claimed it was. Dropping that guard SURVIVES this test, because a correlated
     * constraint never reaches the guard: `inlinePredOf` runs `freePredicateVars` and returns
     * `null` first, so every production `predFor` call passes `closedProps: true`. The guard's
     * real standing is recorded at the call site; what this test is worth is the answer itself.
     */
    const g = new Graph();

    g.addVertex({ id: 'a1', labels: ['A'], properties: { k: 'x' } });
    g.addVertex({ id: 'a2', labels: ['A'], properties: { k: 'y' } });
    g.addVertex({ id: 'b1', labels: ['B'], properties: { k: 'x' } });
    g.addVertex({ id: 'b2', labels: ['B'], properties: { k: 'x' } });
    g.addVertex({ id: 'b3', labels: ['B'], properties: { k: 'y' } });

    // Two B's carry 'x' and one carries 'y', so a correlated match is 2 + 1 = 3 and a predicate
    // mis-evaluated against an unwritten binding could not reach it.
    expect(countOf(g, 'MATCH (a:A), (b:B {k: a.k}) RETURN count(*) AS c')).toBe(3);
  });
});
