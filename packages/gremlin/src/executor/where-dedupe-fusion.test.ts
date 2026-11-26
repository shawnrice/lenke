/*
 * Item 2079 — `V().where(<one hop>).values(k).dedupe()`, the one priced row item 2026 left open.
 *
 * **THE KEYER IS THE RISK, NOT THE ROUTE.** `node-values.ts` records that "items 1561/1562 each
 * found a silent ANSWER change from a second keyer in this area", so this rung reuses
 * `valueDedupeFilter` rather than writing one — and these tests pin the SEQUENCE, not just the set,
 * because a different keyer most often shows up as a reordering or a dropped duplicate-of-a-null.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { dedupe, limit, neq, order, out, toArray, traversal, V, values, where } from '../index.js';
import { scanWhereValuesDedupe } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  /*
   * THE FIXTURE CARRIES DUPLICATES, A MISSING KEY, AND A VERTEX THAT FAILS THE HOP — so each of
   * the three filters the walk applies can be seen to matter independently.
   */
  g.addVertex({ id: 'a', labels: ['T'], properties: { n: 10 } });
  g.addVertex({ id: 'b', labels: ['T'], properties: { n: 20 } });
  g.addVertex({ id: 'c', labels: ['T'], properties: { n: 10 } }); // duplicate of `a`
  g.addVertex({ id: 'd', labels: ['T'], properties: { other: 1 } }); // no `n`
  g.addVertex({ id: 'e', labels: ['T'], properties: { n: 99 } }); // no out-edge

  for (const [from, to] of [
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'],
    ['d', 'a'],
  ] as const) {
    g.addEdge({
      id: `e-${from}-${to}`,
      from: g.getVertexById(from)!,
      to: g.getVertexById(to)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

const plan = (): ReturnType<typeof traversal> =>
  traversal(V(), where(traversal(out('E'))), values('n'), dedupe());

describe('fused where + dedupe (item 2079)', () => {
  const g = build();

  test('THE ROUTE: the rung claims the four-step shape', () => {
    expect(scanWhereValuesDedupe(plan(), g)).toBeDefined();
  });

  test('the SEQUENCE is first-seen distinct, and all three filters show', () => {
    /*
     * `a`(10), `b`(20), `c`(10 — a DUPLICATE, dropped by the dedupe), `d`(has the edge but NO `n`,
     * dropped by the projection), `e`(has `n` but NO out-edge, dropped by the hop). So [10, 20] in
     * first-seen order — and `toStrictEqual` on the sequence is what catches a reordering, which
     * [[toequal-blind-to-trailing-undefined]] is the reason to prefer here.
     */
    expect(toArray(plan(), g)).toStrictEqual([10, 20]);
  });

  test('the ITERATOR and `drain` agree exactly', () => {
    const claimed = scanWhereValuesDedupe(plan(), g);

    expect(claimed).toBeDefined();
    expect([...claimed!]).toStrictEqual(claimed!.drain!());
  });

  test('it agrees with the GENERIC path, which a trailing step forces', () => {
    /*
     * A vacuous `limit` cannot change the answer but DOES defeat this four-step rung, so it is the
     * generic path's own sequence — the same oracle `seeded-node-values.test.ts` uses.
     */
    expect(toArray(plan(), g)).toStrictEqual(
      toArray(traversal(V(), where(traversal(out('E'))), values('n'), dedupe(), limit(1000)), g),
    );
  });

  test('a LABELLED dedupe declines — it keys on a tagged step, not the value', () => {
    expect(
      scanWhereValuesDedupe(
        traversal(V(), where(traversal(out('E'))), values('n'), dedupe('x')),
        g,
      ),
    ).toBeUndefined();
  });

  test('a `by`-KEYED dedupe declines — and this test exists because a mutant survived', () => {
    /*
     * THE `bys` GATE HAD NO TEST. `dedupe('x')` above exercises the `labels` gate; `dedupe().by(k)`
     * is the `bys` modulator, a DIFFERENT field, and deleting its check changed no answer in my file.
     * `dedupe().by('n')` keys on a projection of the element rather than on the value in hand, which
     * is exactly the "second keyer" items 1561/1562 found silent answer changes from.
     */
    const byKeyed = {
      steps: [
        { kind: 'V' },
        { kind: 'where', plan: traversal(out('E')) },
        { kind: 'values', keys: ['n'] },
        { kind: 'dedupe', bys: [{ kind: 'key', key: 'n' }] },
      ],
    } as never;

    expect(scanWhereValuesDedupe(byKeyed, g)).toBeUndefined();
  });

  test('a FOUR-step plan whose last step is NOT a dedupe declines', () => {
    /*
     * MY FILE ONLY TESTED `order()` AS A FIFTH STEP, which the length gate rejects — so deleting
     * the `last?.kind !== 'dedupe'` check survived here and was caught only by the wide suite. A
     * four-step plan ending in something else is what isolates that gate.
     */
    expect(
      scanWhereValuesDedupe(traversal(V(), where(traversal(out('E'))), values('n'), order()), g),
    ).toBeUndefined();
    expect(
      toArray(traversal(V(), where(traversal(out('E'))), values('n'), order()), g),
    ).toStrictEqual([10, 10, 20]);
  });

  test('THREE steps decline — the undeduped rung owns that shape', () => {
    expect(
      scanWhereValuesDedupe(traversal(V(), where(traversal(out('E'))), values('n')), g),
    ).toBeUndefined();
  });

  test('FIVE steps decline — a residual would see a different element type', () => {
    expect(
      scanWhereValuesDedupe(
        traversal(V(), where(traversal(out('E'))), values('n'), dedupe(), order()),
        g,
      ),
    ).toBeUndefined();
    expect(
      toArray(traversal(V(), where(traversal(out('E'))), values('n'), dedupe(), order()), g),
    ).toStrictEqual([10, 20]);
  });

  test('a PREDICATE `where` declines — the overload the prefix rung already refuses', () => {
    /*
     * INHERITED, NOT RESTATED. `where(pred)` is a value comparison against a tagged step, not an
     * existence test, and `singleHopExistence` reads `plan` — so this declines by construction
     * because the prefix rung does. Asserted so the inheritance is observable.
     */
    // THIS TEST ORIGINALLY RAN `values().dedupe().dedupe()` — four steps with NO `where` at all,
    // so it asserted the length gate and not the overload, under a name claiming otherwise. The same
    // mislabelling cost item 2063 a surviving mutant. A FOUR-step plan whose second step is a
    // PREDICATE `where` is what isolates it.
    expect(
      scanWhereValuesDedupe(traversal(V(), where(neq('x')), values('n'), dedupe()), g),
    ).toBeUndefined();
  });

  test('a MULTI-KEY projection declines', () => {
    expect(
      scanWhereValuesDedupe(
        traversal(V(), where(traversal(out('E'))), values('n', 'other'), dedupe()),
        g,
      ),
    ).toBeUndefined();
  });

  test('V(ids) declines — a given set is not the whole graph', () => {
    expect(
      scanWhereValuesDedupe(
        traversal(V('a', 'b'), where(traversal(out('E'))), values('n'), dedupe()),
        g,
      ),
    ).toBeUndefined();
  });
});
