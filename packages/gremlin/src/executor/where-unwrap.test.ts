/*
 * Item 2047 — `where(and(…))` unwrapped to `and(…)`.
 *
 * ⚠️⚠️ **THE REWRITE WAS DEAD CODE FOR MOST OF THIS ITEM, and nothing failed.** `KIND_BITS` is typed
 * `Readonly<Record<string, number>>`, so `KIND_BITS.where` type-checked while being `undefined`;
 * `FILTER_WRAPPER_BITS | undefined` is a no-op; a `where`-only plan kept `kinds === 0`; every
 * kinds-gated pass returned early. The unwrap compiled, shipped into the dist, and changed nothing —
 * the route census read an unchanged 2002 dispatches and gave no hint why. So these tests assert the
 * PLAN SHAPE, not just the answer: the answer was always right.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { and, count, dedupe, not, or, out, toArray, traversal, V, where } from '../index.js';
import { effectivePlan } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < 60; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 5 } });
  }

  for (let i = 0; i < 120; i += 1) {
    const from = i % 60;
    const hop = Math.floor(i / 60);

    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${from}`)!,
      to: g.getVertexById(`v${(from * 7 + 3 + hop * 2_654_435_761) % 60}`)!,
      labels: hop === 1 ? ['F'] : ['E'],
    });
  }

  return g;
};

const kindsOf = (t: ReturnType<typeof traversal>, g: Graph): string =>
  effectivePlan(t, g, false)
    .steps.map((s) => s.kind)
    .join(',');

describe('where() unwrapping (item 2047)', () => {
  const g = build();

  test('THE PLAN SHAPE: where(and) becomes and, matching the direct spelling exactly', () => {
    expect(kindsOf(traversal(V(), where(and(traversal(out('E')), traversal(out('F'))))), g)).toBe(
      kindsOf(traversal(V(), and(traversal(out('E')), traversal(out('F')))), g),
    );
    expect(kindsOf(traversal(V(), where(or(traversal(out('E')), traversal(out('F'))))), g)).toBe(
      'V,or',
    );
    expect(kindsOf(traversal(V(), where(not(traversal(out('E'))))), g)).toBe('V,not');
  });

  test('⚠️ where(out) is NOT unwrapped — `out` REPLACES the element', () => {
    /*
     * This is the case that makes the gate three kinds rather than "anything filter-ish":
     * `where(out('E'))` keeps vertices that HAVE an out-edge, while a bare `out('E')` would replace
     * each vertex with its neighbours. Different answers, not a different route.
     */
    expect(kindsOf(traversal(V(), where(traversal(out('E')))), g)).toBe('V,where');
  });

  test('⚠️ where(dedupe) is NOT unwrapped — dedupe is STATEFUL', () => {
    /*
     * `where(dedupe())` runs `dedupe` in a SUB-PLAN per traverser, so each sees its own empty state
     * and nothing is filtered; a bare `dedupe()` dedupes across the stream. A keeps-or-drops test
     * would have admitted this, which is why the gate is an allowlist.
     */
    expect(kindsOf(traversal(V(), where(traversal(dedupe()))), g)).toBe('V,where');
    expect(toArray(traversal(V(), where(traversal(dedupe())), count()), g)).toStrictEqual([60]);
  });

  test('the ANSWERS agree across both spellings, for and / or / not', () => {
    for (const [wrapped, direct] of [
      [
        traversal(V(), where(and(traversal(out('E')), traversal(out('F')))), count()),
        traversal(V(), and(traversal(out('E')), traversal(out('F'))), count()),
      ],
      [
        traversal(V(), where(or(traversal(out('E')), traversal(out('F')))), count()),
        traversal(V(), or(traversal(out('E')), traversal(out('F'))), count()),
      ],
      [
        traversal(V(), where(not(traversal(out('E')))), count()),
        traversal(V(), not(traversal(out('E'))), count()),
      ],
    ] as const) {
      expect(toArray(wrapped, g)).toStrictEqual(toArray(direct, g));
    }
  });

  test('a MULTI-step where body is NOT unwrapped', () => {
    // The gate requires exactly one step; two must stay wrapped.
    expect(kindsOf(traversal(V(), where(traversal(out('E'), out('F')))), g)).toBe('V,where');
  });

  test('⚠️ a multi-step body STARTING WITH `and` is not unwrapped either', () => {
    /*
     * ⚠️⚠️ **THE MUTANT THAT SURVIVED THE FIRST ROUND.** Relaxing the gate from `=== 1` to `>= 1`
     * takes `const [only] = step.plan.steps` — the FIRST step — and unwraps to it alone, silently
     * DROPPING the rest of the body. The test above cannot see that: its body starts with `out`, so
     * the kind check declines and the mutant is never exercised. A body that is multi-step AND starts
     * with an admitted kind is the only shape that distinguishes them.
     */
    const body = traversal(V(), where(traversal(and(traversal(out('E'))), out('F'))));

    expect(kindsOf(body, g)).toBe('V,where');

    // And the answer, because dropping `out('F')` turns a filter into a projection.
    expect(
      toArray(traversal(V(), where(traversal(and(traversal(out('E'))), out('F'))), count()), g),
    ).toStrictEqual(
      toArray(traversal(V(), where(traversal(and(traversal(out('E'))), out('F'))), count()), g),
    );
    expect(
      kindsOf(traversal(V(), where(traversal(and(traversal(out('E'))), out('F')))), g),
    ).not.toBe('V,and');
  });
});
