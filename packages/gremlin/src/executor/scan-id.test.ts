/*
 * Item 2056 — `V().id()` admitted into the scan rung.
 *
 * **THE ANSWER WAS ALWAYS RIGHT — only the ROUTE was wrong — so every test here asserts the route
 * or the exact sequence, never just "it returns ids".** The route census is what found this
 * (`scan: id` generic, 1 dispatch) where the timing alone looked like noise on an 8 ms row.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { dedupe, hasLabel, id, label, order, toArray, traversal, V, values } from '../index.js';
import { nodeValuesDedupeShortcut, nodeValuesShortcut } from './node-values.js';

const build = (): Graph => {
  const g = new Graph();

  for (const [vid, k] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ] as const) {
    g.addVertex({ id: vid, labels: ['T'], properties: { k } });
  }

  // No `k` at all: its id must still be emitted, where a `values('k')` walk drops it.
  g.addVertex({ id: 'd', labels: ['T'], properties: {} });

  return g;
};

describe('scan id arm (item 2056)', () => {
  const g = build();

  test('THE ROUTE: the rung claims V().id()', () => {
    expect(nodeValuesShortcut(traversal(V(), id()), g)).toBeDefined();
  });

  test('every id is emitted IN ORDER, including a vertex with no properties', () => {
    /*
     * THE `d` VERTEX IS THE POINT: `V().values('k')` drops it (no such key) while `V().id()` must
     * not — an id always exists. A walk that copied the `values` guard would silently lose a row, and
     * `toStrictEqual` on the sequence is what sees that ([[toequal-blind-to-trailing-undefined]]:
     * `toEqual` would accept a missing trailing element).
     */
    expect(toArray(traversal(V(), id()), g)).toStrictEqual(['a', 'b', 'c', 'd']);
    expect(toArray(traversal(V(), values('k')), g)).toStrictEqual([1, 2, 3]);
  });

  test('the ITERATOR and `drain` agree exactly', () => {
    const claimed = nodeValuesShortcut(traversal(V(), id()), g);

    expect(claimed).toBeDefined();
    expect([...claimed!]).toStrictEqual(claimed!.drain!());
  });

  test('THE ROUTE: the rung claims V().label() too (item 2080)', () => {
    expect(nodeValuesShortcut(traversal(V(), label()), g)).toBeDefined();
  });

  test('every label is emitted IN ORDER, and a MULTI-LABEL vertex yields its FIRST', () => {
    /*
     * `firstLabel` TAKES THE SET'S FIRST ELEMENT, which is insertion order — so a vertex created
     * with `['T', 'U']` yields `T`. The fused walk must agree with `dispatch.ts`'s `case 'label'`
     * exactly, which is why `firstLabel` is imported there rather than re-implemented.
     */
    const multi = new Graph();

    multi.addVertex({ id: 'm', labels: ['T', 'U'], properties: {} });
    multi.addVertex({ id: 'n', labels: ['U', 'T'], properties: {} });

    expect(toArray(traversal(V(), label()), multi)).toStrictEqual(['T', 'U']);
  });

  test('an UNLABELLED vertex yields NULL, not undefined', () => {
    /*
     * `?? null` IS THE CONTRACT, not a tidy-up: `dispatch.ts` returns `firstLabel(v.labels) ?? null`,
     * so a vertex with no labels produces a NULL row — and it still produces a ROW, unlike `values(k)`
     * which drops a vertex lacking the key. A fused walk that yielded `undefined`, or dropped the row,
     * would differ from the generic path on exactly this vertex.
     */
    const bare = new Graph();

    bare.addVertex({ id: 'x', labels: [], properties: {} });
    bare.addVertex({ id: 'y', labels: ['T'], properties: {} });

    expect(toArray(traversal(V(), label()), bare)).toStrictEqual([null, 'T']);
  });

  test("the label walk's ITERATOR and `drain` agree exactly", () => {
    const claimed = nodeValuesShortcut(traversal(V(), label()), g);

    expect(claimed).toBeDefined();
    expect([...claimed!]).toStrictEqual(claimed!.drain!());
  });

  test('a LABELLED label() declines — item 1870s refusal covers this arm too', () => {
    expect(nodeValuesShortcut(traversal(V(), hasLabel('T'), label()), g)).toBeUndefined();
  });

  test('a TRAILING step after label() declines', () => {
    expect(nodeValuesShortcut(traversal(V(), label(), order()), g)).toBeUndefined();
  });

  test('the DEDUPE rung declines a label projection — its gate is `values` only', () => {
    expect(nodeValuesDedupeShortcut(traversal(V(), label(), dedupe()), g)).toBeUndefined();
  });

  test('a LABELLED id declines — item 1870s refusal still governs this rung', () => {
    /*
     * `V().hasLabel(T).id()` must NOT be claimed here. Item 1870 refused `hasLabel` in this rung
     * because the rung is a FULL SCAN while the pipeline seeds from the label index, losing up to
     * 678x as the label narrows. The `id` arm inherits that refusal rather than re-opening it.
     */
    expect(nodeValuesShortcut(traversal(V(), hasLabel('T'), id()), g)).toBeUndefined();
    expect(toArray(traversal(V(), hasLabel('T'), id()), g)).toStrictEqual(['a', 'b', 'c', 'd']);
  });

  test('a TRAILING step declines — the rung serves only the bare two-step shape', () => {
    expect(nodeValuesShortcut(traversal(V(), id(), order()), g)).toBeUndefined();
    expect(toArray(traversal(V(), id(), order()), g)).toStrictEqual(['a', 'b', 'c', 'd']);
  });

  test('the DEDUPE rung declines an id projection, deliberately', () => {
    /*
     * Ids are already distinct, so `V().id().dedupe()` is a tautology this rung would pay for —
     * and a second keyer in this area silently changed an ANSWER twice (items 1561/1562). The decline
     * is asserted so it cannot be "tidied up" later.
     */
    expect(nodeValuesDedupeShortcut(traversal(V(), id(), dedupe()), g)).toBeUndefined();
    expect(toArray(traversal(V(), id(), dedupe()), g)).toStrictEqual(['a', 'b', 'c', 'd']);
  });

  test('V(ids) declines — a given set is not the whole graph', () => {
    expect(nodeValuesShortcut(traversal(V('a', 'b'), id()), g)).toBeUndefined();
    expect(toArray(traversal(V('a', 'b'), id()), g)).toStrictEqual(['a', 'b']);
  });
});
