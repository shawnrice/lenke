/*
 * Item 2059 — the unindexed `V().has(k, pred).values(key)` fused scan.
 *
 * ⚠️⚠️ **THE ANSWER WAS ALWAYS RIGHT HERE TOO — only the ROUTE was wrong — so these tests assert the
 * route, the exact row SEQUENCE, and the two refusals that keep the rung honest.** Item 2058 priced
 * the generic route it replaces at ~47 ns a vertex against a 25 ns fused scan.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  eq,
  gte,
  has,
  hasLabel,
  limit,
  order,
  regex,
  toArray,
  traversal,
  V,
  values,
} from '../index.js';
import { specializePredicate } from '../predicates.js';
import {
  pickScanWalk,
  seededNodeValuesShortcut,
  unindexedHasValuesShortcut,
} from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['T'], properties: { k: 3, n: 10, s: 'xy' } });
  g.addVertex({ id: 'b', labels: ['T'], properties: { k: 9, n: 20, s: 'zz' } });
  g.addVertex({ id: 'c', labels: ['U'], properties: { k: 3, n: 30, s: 'xq' } });
  // Passes the filter but has NO `n`: `values('n')` must drop it, as the plain scan does.
  g.addVertex({ id: 'd', labels: ['T'], properties: { k: 3 } });
  // Has `n` but NO `k` at all: the filter must reject it rather than throw.
  g.addVertex({ id: 'e', labels: ['T'], properties: { n: 40 } });
  /*
   * ⚠️ `f` EXISTS BECAUSE A MUTANT SURVIVED. It passes `regex('^x')` on `s` — a predicate
   * `specializePredicate` DECLINES, so the GENERAL walk — and has NO `n`. Dropping the
   * `projKey in props` test from that walk was invisible until this vertex existed: every other
   * regex-passing vertex happened to carry `n`.
   */
  g.addVertex({ id: 'f', labels: ['T'], properties: { s: 'xf' } });

  return g;
};

describe('unindexed has+values scan (item 2059)', () => {
  const g = build();

  test('THE ROUTE: the rung claims the bare three-step shape', () => {
    expect(unindexedHasValuesShortcut(traversal(V(), has('k', 3), values('n')), g)).toBeDefined();
  });

  test('the row SEQUENCE matches the pipeline, dropping a filter-passing vertex with no projected key', () => {
    /*
     * 🔑 `d` PASSES `has('k', 3)` AND HAS NO `n`, so it must emit NOTHING — the `values()` contract.
     * A walk that yielded `undefined` there would add a row the generic route never produces, and
     * [[toequal-blind-to-trailing-undefined]] is why `toEqual` would not notice. `e` has no `k`, so
     * the predicate must reject a MISSING value rather than throw.
     */
    expect(toArray(traversal(V(), has('k', 3), values('n')), g)).toStrictEqual([10, 30]);
  });

  test('the ITERATOR and `drain` agree exactly', () => {
    const claimed = unindexedHasValuesShortcut(traversal(V(), has('k', 3), values('n')), g);

    expect(claimed).toBeDefined();
    expect([...claimed!]).toStrictEqual(claimed!.drain!());
  });

  test('a RANGE predicate takes the same walk and the same answer', () => {
    expect(
      unindexedHasValuesShortcut(traversal(V(), has('k', gte(3)), values('n')), g),
    ).toBeDefined();
    expect(toArray(traversal(V(), has('k', gte(3)), values('n')), g)).toStrictEqual([10, 20, 30]);
  });

  test('a predicate `specializePredicate` DECLINES still routes here and answers correctly', () => {
    /*
     * ⚠️ THE GENERAL WALK IS NOT DEAD CODE. `specializePredicate` returns `undefined` for anything
     * but a number/string operand, so a `regex` lands on the `matches` walk — a separate closure, so
     * a mutant can target one without the other.
     */
    const plan = traversal(V(), has('s', regex('^x')), values('n'));

    expect(unindexedHasValuesShortcut(plan, g)).toBeDefined();
    /*
     * 🔑 `f` PASSES THE REGEX AND HAS NO `n`, so it must emit nothing — the same `values()` contract
     * the fast walk keeps for `d`. Until `f` existed, a mutant removing `projKey in props` from the
     * GENERAL walk survived every test in this file.
     */
    expect(toArray(plan, g)).toStrictEqual([10, 30]);
  });

  test('⚠️ THE WALK CHOICE ITSELF, as a pure function — a route mutant changes no answer', () => {
    /*
     * ⚠️⚠️ `pickScanWalk` IS EXPORTED SOLELY SO THIS CAN BE ASSERTED. Forcing the rung onto the
     * general walk is answer-equivalent, so it survived the whole suite;
     * [[perf-gate-needs-its-own-test]] prescribes exactly this: extract the decision and test it.
     */
    expect(pickScanWalk(specializePredicate(eq(3)))).toBe('fast');
    expect(pickScanWalk(specializePredicate(gte(3)))).toBe('fast');
    expect(pickScanWalk(specializePredicate(regex('^x')))).toBe('general');
    expect(pickScanWalk(undefined)).toBe('general');
  });

  test('⚠️ a LEADING hasLabel is REFUSED — item 1870 measured that form losing up to 678x', () => {
    /*
     * ⚠️⚠️ THIS IS THE REFUSAL THAT MATTERS MOST. The rung is a FULL SCAN whatever the label matches,
     * while the pipeline seeds from `graph.verticesByLabel` and visits only the labelled vertices —
     * so the labelled form ties when the label covers everything and loses 1.93x at one-in-two,
     * 7.98x at one-in-ten and 678x at one-in-a-thousand.
     *
     * ⚠️ AND THE WORKLOAD SCREEN CANNOT CATCH THIS, which is why it is asserted here: every read
     * screen is label-homogeneous ([[label-vacuity-gates-fast-paths]]), so a vacuous label makes the
     * scan look like a 2.39x WIN on exactly the shape that would regress on real data.
     */
    const labelled = traversal(V(), hasLabel('T'), has('k', 3), values('n'));

    expect(unindexedHasValuesShortcut(labelled, g)).toBeUndefined();
    expect(toArray(labelled, g)).toStrictEqual([10]);
  });

  test('a TRAILING step declines — the rung serves only the bare three-step shape', () => {
    expect(
      unindexedHasValuesShortcut(traversal(V(), has('k', 3), values('n'), order()), g),
    ).toBeUndefined();
    expect(toArray(traversal(V(), has('k', 3), values('n'), order()), g)).toStrictEqual([10, 30]);
  });

  test('V(ids) declines — a given set is not the whole graph', () => {
    expect(
      unindexedHasValuesShortcut(traversal(V('a', 'c'), has('k', 3), values('n')), g),
    ).toBeUndefined();
    expect(toArray(traversal(V('a', 'c'), has('k', 3), values('n')), g)).toStrictEqual([10, 30]);
  });

  test('a MULTI-KEY projection declines — values(a, b) fans out per key', () => {
    expect(
      unindexedHasValuesShortcut(traversal(V(), has('k', 3), values('n', 's')), g),
    ).toBeUndefined();
  });

  test('⚠️ PRECEDENCE: an INDEXED key is claimed by the SEEDED rung, which visits only the bucket', () => {
    /*
     * ⚠️ THE ORDERING IS THIS RUNG'S GATE. It does not probe the index itself — `index.ts` consults
     * `seededNodeValuesShortcut` first and returns if it claims, so this one is reached only once
     * that declined. Re-probing here would duplicate `seedForStep` per query and could drift from
     * the rung that owns the decision; this test is what holds the ordering in place instead.
     */
    const indexed = new Graph();

    indexed.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
    indexed.addVertex({ id: 'a', labels: ['T'], properties: { k: 3, n: 10 } });
    indexed.addVertex({ id: 'b', labels: ['T'], properties: { k: 9, n: 20 } });

    const plan = traversal(V(), has('k', 3), values('n'));

    expect(seededNodeValuesShortcut(plan, indexed)).toBeDefined();
    expect(toArray(plan, indexed)).toStrictEqual([10]);
  });

  test('⚠️⚠️ a RANGE predicate on an INDEXED key declines — the regression an existing test caught', () => {
    /*
     * ⚠️⚠️ **THIS IS THE CASE THAT BROKE, AND PRECEDENCE DID NOT COVER IT.** The first cut of this
     * rung had no index check and relied on sitting below `seededNodeValuesShortcut`. But that rung
     * DECLINES a range even on an indexed key — its `seedForStep` cap of `0` demands a `removable`
     * candidate, which a range never is — while the PIPELINE still seeds the range from the index.
     * So this shape fell through to the full scan and changed the row SEQUENCE from bucket order to
     * vertex order, failing `seeded-node-values.test.ts`'s "a RANGE predicate" case.
     *
     * 🔑 Both halves are asserted: the rung DECLINES, and the answer still matches the pipeline's
     * SEQUENCE (a trailing vacuous `order()` is a different route, so the bare form is compared
     * against the four-step form the way that test does it).
     */
    const indexed = new Graph();

    indexed.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
    indexed.addVertex({ id: 'a', labels: ['T'], properties: { k: 3, n: 10 } });
    indexed.addVertex({ id: 'b', labels: ['T'], properties: { k: 9, n: 20 } });
    indexed.addVertex({ id: 'c', labels: ['T'], properties: { k: 5, n: 30 } });

    const ranged = traversal(V(), has('k', gte(3)), values('n'));

    expect(unindexedHasValuesShortcut(ranged, indexed)).toBeUndefined();
    expect(seededNodeValuesShortcut(ranged, indexed)).toBeUndefined();

    /*
     * ⚠️ COMPARED AGAINST THE FOUR-STEP FORM, EXACTLY AS THE SIBLING TEST DOES IT — a vacuous
     * `limit` cannot change the answer but DOES defeat every three-step rung, so it is the
     * pipeline's own sequence. My first attempt here compared against a SORTED `order()` result and
     * failed on `[10, 30, 20]` against `[10, 20, 30]`: the bare form emits in BUCKET order, which is
     * the very thing under test, so sorting the oracle threw away the property being asserted.
     */
    expect(toArray(ranged, indexed)).toStrictEqual(
      toArray(traversal(V(), has('k', gte(3)), values('n'), limit(1000)), indexed),
    );
    expect(toArray(ranged, indexed)).toHaveLength(3);
  });

  test('an EQUALITY on an indexed key also declines here, so the gate is the INDEX not the predicate kind', () => {
    const indexed = new Graph();

    indexed.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
    indexed.addVertex({ id: 'a', labels: ['T'], properties: { k: 3, n: 10 } });

    expect(
      unindexedHasValuesShortcut(traversal(V(), has('k', 3), values('n')), indexed),
    ).toBeUndefined();
  });
});
