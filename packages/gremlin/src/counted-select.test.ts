import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { effectivePlan, toArray } from './executor.js';
import {
  V,
  as_,
  count,
  has,
  inject,
  out,
  select,
  union,
  pipe,
  traversal,
  values,
} from './index.js';

/**
 * `dropCountedSelect` (item 1800): `as(x) … select(x).count()` loses the `select`, which lets
 * `dropUnreadAs` lose the `as` and puts the shape back on the count rungs.
 *
 * ```text
 *   V().as('a').out('E').select('a').count()    ~460 ms  ->  7.4   (20 reps)
 * ```
 *
 * ⚠️ **`select` IS A PROJECTION FOR A TRAVERSER THAT HAS THE TAG AND A FILTER FOR ONE THAT DOES
 * NOT** — `selectStep` does `continue` when `recallTag` misses. So the entire question is whether
 * every traverser reaching the select is guaranteed to carry the tag, and the whole gate exists for
 * the cases where it is not:
 *
 *   `inject(1)` starts a traverser with NO tags at all.
 *   `union(…)` can hold an arm that does.
 *   a second `V()` re-sources the stream.
 *
 * After any of those the select legitimately DROPS rows, and dropping the select would count them.
 * Those are the tests that matter here; the ones that fire are the easy half.
 *
 * ⚠️ A MODULATED SELECT IS REFUSED OUTRIGHT, because `select('a').by('age')` filters even when the
 * tag resolves — a selected element with no `age` is dropped.
 */

const g = (): Graph => {
  const graph = new Graph();

  for (const id of ['a', 'b', 'c']) {
    graph.addVertex({ id, labels: ['P'], properties: { k: id } });
  }

  const v = (id: string): Vertex => graph.getVertexById(id) as Vertex;

  graph.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['E'], properties: {} });
  graph.addEdge({ id: 'e2', from: v('a'), to: v('c'), labels: ['E'], properties: {} });

  return graph;
};

const kindsOf = (plan: ReturnType<typeof traversal>): string[] =>
  effectivePlan(plan, g(), false).steps.map((s) => s.kind);
const answer = (plan: ReturnType<typeof traversal>): unknown[] => toArray(plan, g());

describe('it fires where the tag is guaranteed', () => {
  test('the plain shape loses both steps', () => {
    expect(kindsOf(traversal(V(), as_('a'), out('E'), select('a'), count()))).toEqual([
      'V',
      'out',
      'count',
    ]);
  });

  test('tag-preserving steps in between are looked through', () => {
    expect(
      kindsOf(traversal(V(), as_('a'), out('E'), has('k', 'b'), select('a'), count())),
    ).toEqual(['V', 'out', 'has', 'count']);
  });

  test('the ANSWER is unchanged', () => {
    // Two `E` edges, so the count is 2 whichever way the plan is shaped.
    expect(answer(traversal(V(), as_('a'), out('E'), select('a'), count()))).toEqual([2]);
    expect(answer(traversal(V(), out('E'), count()))).toEqual([2]);
  });
});

describe('⚠️ the refusals, each one a shape where select FILTERS', () => {
  test('an inject between them — the injected traverser has no tags', () => {
    const plan = traversal(V(), as_('a'), inject(1), select('a'), count());

    expect(kindsOf(plan)).toContain('select');
    // And the answer proves the refusal is not pedantry: the injected row is DROPPED by the
    // select, so the count differs from the one a rewrite would produce.
    expect(answer(plan)).toEqual([3]); // three tagged vertices; the injected 1 is dropped
    expect(answer(traversal(V(), as_('a'), inject(1), count()))).toEqual([4]);
  });

  test('a union between them, where one arm re-sources', () => {
    const plan = traversal(
      V(),
      as_('a'),
      union(pipe(out('E')), pipe(inject(9))),
      select('a'),
      count(),
    );

    expect(kindsOf(plan)).toContain('select');
  });

  test('a select with a by() modulator, which filters on the property', () => {
    const plan = traversal(V(), as_('a'), out('E'), select('a'), count());
    const modulated = {
      ...plan,
      steps: plan.steps.map((s) =>
        s.kind === 'select' ? { ...s, bys: [{ kind: 'key' as const, key: 'nosuch' }] } : s,
      ),
    };

    expect(effectivePlan(modulated, g(), false).steps.map((s) => s.kind)).toContain('select');
  });

  test('a tail that is not a bare count', () => {
    expect(kindsOf(traversal(V(), as_('a'), out('E'), select('a'), values('k')))).toContain(
      'select',
    );
    expect(kindsOf(traversal(V(), as_('a'), out('E'), select('a')))).toContain('select');
  });

  test('no as() at all — nothing guarantees the tag', () => {
    expect(kindsOf(traversal(V(), out('E'), select('a'), count()))).toContain('select');
  });

  test('the as() binds a DIFFERENT tag', () => {
    expect(kindsOf(traversal(V(), as_('b'), out('E'), select('a'), count()))).toContain('select');
  });
});
