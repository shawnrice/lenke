import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate } from './executor/core.js';
import { specializedConjunct } from './executor/inline-gate.js';
import { satisfies } from './executor/predicates.js';
import { query } from './index.js';

/**
 * Item 1600: `nodeScanGate` pre-resolves each conjunct's per-element work once per query instead of
 * re-dispatching `inlineHolds` -> `satisfies` over twelve carriers per element.
 *
 * ```text
 *                            PRE (asserted)                POST
 *    proj-clause  scan       435346 445185 436398    329933 331853 346457    1.31x
 *    proj-inline  scan       409378 410108 409949    317971 330609 331586    1.25x
 *    uniq-clause  scan       404190 404713 416251    312620 318662 320686    1.28x
 *    proj-nofilter scan      224135 226294 226806    225275 231411 232277    flat (NULL CONTROL)
 * ```
 *
 * ⚠️ THE ROUTE IS ANSWER-EQUIVALENT, so the differential tests cannot see a wrong decision — both
 * arms compute the same predicate. That is why the decision is an exported pure function and this
 * file tests it directly (`perf-gate-needs-its-own-test`). The answer tests below are the other
 * half: they pin that the arm the route selects still answers what `satisfies` answers, including
 * the two shapes where the arms must DIFFER in what they do (a correlated conjunct, which has to
 * write the binding, and an inline null, whose reading is not `eqProps`'s).
 */

const predOf = (
  props: readonly { key: string; value: unknown }[] | undefined,
  where: unknown,
): ReturnType<typeof compilePredicate> =>
  compilePredicate(
    props?.map((p) => ({ key: p.key, value: { kind: 'lit' as const, value: p.value } })),
    where as never,
    'u',
  );

describe('which conjuncts take the pre-resolved arm', () => {
  test('a lone inline property does', () => {
    expect(
      specializedConjunct({ pred: predOf([{ key: 'k', value: 1 }], undefined) }),
    ).toBeDefined();
  });

  test('a lone lifted equality does', () => {
    const where = {
      kind: 'compare',
      op: '=',
      left: { kind: 'prop', variable: 'u', key: 'k' },
      right: { kind: 'lit', value: 1 },
    };

    expect(specializedConjunct({ pred: predOf(undefined, where) })).toBeDefined();
  });

  test('a CORRELATED conjunct does NOT — the slow arm writes the binding it reads', () => {
    /**
     * ⚠️ THE ONE MUTANT THAT IS A WRONG ANSWER RATHER THAN A SLOW ONE. `inlineHolds` sets
     * `binding[bindVar]` before calling `satisfies`; a specialized closure never writes a binding,
     * so admitting a `bindVar`-carrying conjunct would evaluate its value against a name nothing
     * had bound. The `bindVar` here is what `predFor` sets for a non-closed inline constraint.
     */
    const pred = predOf([{ key: 'k', value: 1 }], undefined);

    expect(specializedConjunct({ pred, bindVar: 'u' })).toBeUndefined();
    // The control: the SAME predicate without the bindVar does take the fast arm, so the refusal
    // above is caused by the bindVar and not by the predicate's shape.
    expect(specializedConjunct({ pred })).toBeDefined();
  });

  test('TWO carriers do not — one closure cannot answer a conjunction', () => {
    const where = {
      kind: 'and',
      items: [
        {
          kind: 'compare',
          op: '=',
          left: { kind: 'prop', variable: 'u', key: 'k' },
          right: { kind: 'lit', value: 1 },
        },
        {
          kind: 'compare',
          op: '>',
          left: { kind: 'prop', variable: 'u', key: 'n' },
          right: { kind: 'lit', value: 2 },
        },
      ],
    };

    expect(specializedConjunct({ pred: predOf(undefined, where) })).toBeUndefined();
  });

  test('the selected arm agrees with satisfies element by element', () => {
    const g = new Graph();

    for (let i = 0; i < 60; i += 1) {
      g.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i % 5, n: i } });
    }

    const pred = predOf([{ key: 'k', value: 2 }], undefined);
    const fast = specializedConjunct({ pred });

    expect(fast).toBeDefined();

    let matched = 0;

    for (let i = 0; i < 60; i += 1) {
      const v = g.getVertexById(`u${i}`);
      const slow = satisfies(v as never, pred, new Map(), {}, g);

      expect(fast?.(v as never, { binding: new Map(), params: {}, graph: g })).toBe(slow);

      if (slow) {
        matched += 1;
      }
    }

    // A literal, so the differential is not vacuous: 60 vertices, k = i % 5, so 12 carry k = 2.
    expect(matched).toBe(12);
  });
});

describe('the answers the gate feeds are unchanged', () => {
  const g = new Graph();

  for (let i = 0; i < 60; i += 1) {
    // `a`/`b` are constants so a TWO-property inline filter matches every vertex (the slow-arm
    // chain test needs that), and `flagless` is a NUMBER so reading it in boolean context
    // raises (the written-order test needs that).
    const properties: Record<string, unknown> = {
      k: i % 5,
      n: i,
      tags: [i % 3],
      a: 1,
      b: 2,
      flagless: i,
    };

    if (i % 4 === 0) {
      properties.note = null;
    } else if (i % 4 !== 1) {
      properties.note = 'x';
    }

    g.addVertex({ id: `u${i}`, labels: ['P'], properties });
  }

  for (let i = 0; i < 59; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`u${i}`) as never,
      to: g.getVertexById(`u${i + 1}`) as never,
      labels: ['E'],
      properties: {},
    });
  }

  const c = (text: string, params: Record<string, unknown> = {}): number =>
    Number(query(g, text, params)[0]?.c);

  test('a lifted equality and its inline twin agree, and on the right number', () => {
    expect(c('MATCH (u:P) WHERE u.k = 2 RETURN count(*) AS c')).toBe(12);
    expect(c('MATCH (u:P {k: 2}) RETURN count(*) AS c')).toBe(12);
    expect(c('MATCH (u:P) WHERE u.k = $v RETURN count(*) AS c', { v: 2 })).toBe(12);
  });

  test('an inline null keeps the IS NULL reading through the gate', () => {
    // 15 stored nulls (i % 4 === 0) and 15 absent (i % 4 === 1) in 60.
    expect(c('MATCH (u:P {note: null}) RETURN count(*) AS c')).toBe(30);
    expect(c('MATCH (u:P) WHERE u.note = null RETURN count(*) AS c')).toBe(0);
  });

  test('the carriers that are NOT single still answer — the slow arm stays correct', () => {
    expect(c('MATCH (u:P) WHERE u.k = 2 AND u.n > 30 RETURN count(*) AS c')).toBe(6);
    expect(c('MATCH (u:P) WHERE u.k IN [1, 2] RETURN count(*) AS c')).toBe(24);
    expect(c('MATCH (u:P) WHERE u.note IS NULL RETURN count(*) AS c')).toBe(30);
    expect(c('MATCH (u:P) WHERE u.n >= 50 RETURN count(*) AS c')).toBe(10);
    expect(c('MATCH (u:P {tags: [1]}) RETURN count(*) AS c')).toBe(20);
  });

  test('a CORRELATED inline constraint over a hop still answers', () => {
    // The shape whose conjunct carries a bindVar, so it must take the slow arm. Each edge goes
    // u_i -> u_i+1, and k = i % 5, so `b.k = a.k` can never hold on consecutive ids.
    expect(c('MATCH (a:P)-[:E]->(b:P {k: a.k}) RETURN count(*) AS c')).toBe(0);
    // And the control, so the 0 above is not a query that matches nothing for another reason.
    expect(c('MATCH (a:P)-[:E]->(b:P {n: a.n}) RETURN count(*) AS c')).toBe(0);
    expect(c('MATCH (a:P)-[:E]->(b:P) WHERE b.n = a.n + 1 RETURN count(*) AS c')).toBe(59);
  });

  test('the conjuncts run in WRITTEN order, so an inline non-match short-circuits a faulting clause', () => {
    /**
     * ⚠️ ITEM 1601 FOUND THIS UNTESTED, by mutation. `composeInlineGate` uses `reduceRight` so the
     * conjuncts evaluate inline-before-clause, and the function's own comment says that is what
     * lets an inline filter matching nothing short-circuit a faulting clause `WHERE`. Switching it
     * to `reduce` — reversing the order — left all 4,058 tests green, so the documented claim had
     * no test at all.
     *
     * ⚠️ AND THE SHAPE HAS TO BE A PROJECTION, not a count. A count takes `countShortcut` ->
     * `buildNodeCount`, which has its OWN `for (const ip of preds)` loop and never reaches this
     * composition — the first version of these two tests was written as counts, both mutants
     * survived again, and that is what said so.
     *
     * A property in BOOLEAN CONTEXT is the fault: it is DYNAMIC under the static boolean-context
     * check, so a non-boolean value must RAISE at evaluation (item 875's condition for
     * `truthProps` existing). `{a: 999}` matches nothing, so in written order nothing is ever
     * evaluated against it.
     */
    expect(query(g, 'MATCH (n:P {a: 999}) WHERE n.flagless RETURN n.k AS k', {}).length).toBe(0);

    // TWO controls, because a `0` that is not caused by the short-circuit proves nothing:
    //   - with no inline filter the clause IS reached, and raises;
    //   - with an inline filter that MATCHES it is reached too, and raises.
    expect(() => query(g, 'MATCH (n:P) WHERE n.flagless RETURN n.k AS k', {})).toThrow();
    expect(() => query(g, 'MATCH (n:P {a: 1}) WHERE n.flagless RETURN n.k AS k', {})).toThrow();
  });

  test('a conjunct on the SLOW arm still chains to the ones after it', () => {
    /**
     * ⚠️ ALSO FOUND UNTESTED BY MUTATION (item 1601). Dropping the `rest` call from the SLOW arm —
     * so the first conjunct answers for the whole chain — survived the suite, because with item
     * 1600's fast arm in place every tested multi-conjunct gate had its FIRST conjunct specialize.
     * The slow arm's chain is reached only when a conjunct does NOT specialize and another follows
     * it, and nothing had that shape.
     *
     * TWO inline properties do not specialize (one closure cannot answer a conjunction), so this
     * puts the slow arm first and a rejecting clause `WHERE` after it.
     */
    expect(query(g, 'MATCH (n:P {a: 1, b: 2}) WHERE n.n = 999 RETURN n.k AS k', {}).length).toBe(0);
    // The control: without the clause the inline pair matches every vertex, so the 0 above is the
    // chain working and not the inline pair rejecting.
    expect(query(g, 'MATCH (n:P {a: 1, b: 2}) RETURN n.k AS k', {}).length).toBe(60);
  });

  test('a projection through the gate yields the same rows', () => {
    const rows = query(g, 'MATCH (u:P) WHERE u.k = 2 RETURN u.n AS n', {});

    expect(rows.length).toBe(12);
    expect(rows.map((r) => Number(r.n)).sort((a, b) => a - b)).toEqual([
      2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57,
    ]);
  });
});
