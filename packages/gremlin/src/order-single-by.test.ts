import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { inject, order, toArray, traversal, V, values } from './index.js';

// Item 879: `sortByBys` gained a single-`by` arm with a scalar key and a loop-free comparator.
// It is the common case and it is answer-equivalent to the general path, so these assertions are
// about the properties the general path guarantees — not about speed:
//
//   - STABILITY. Ties keep arrival order, which is OBSERVABLE and compared against the native
//     engine by the byte-identity fuzzer. A key-only comparator that lost it would pass any
//     "is it sorted?" check.
//   - `desc` negates the SAME comparison rather than swapping arguments, so nothing rests on
//     `compareTotal` being antisymmetric.
//   - A `by()` yielding no value FILTERS the item (TinkerPop), where a stored `null` is a value.
//   - An element key FAULTS, and only after every key has been evaluated.

const g = (): Graph => {
  const h = new Graph();

  // ages deliberately TIED in groups, with a distinct `tag` recording arrival order, so a lost
  // tiebreak shows up as a permuted `tag` sequence rather than a wrong set
  const ages = [3, 1, 3, 2, 1, 3, 2];

  ages.forEach((age, i) => {
    h.addVertex({ id: `v${i}`, labels: ['P'], properties: { age, tag: i } });
  });

  return h;
};

const run = (h: Graph, t: unknown): unknown[] => [...toArray(t as never, h)];

describe('single-by order() (item 879)', () => {
  test('ascending, and TIES keep arrival order', () => {
    const h = g();
    // ages 3,1,3,2,1,3,2 -> sorted asc: 1,1,2,2,3,3,3 with tags 1,4,3,6,0,2,5
    expect(run(h, traversal(V(), order().by('age'), values('tag')))).toEqual([1, 4, 3, 6, 0, 2, 5]);
  });

  test('descending reverses the KEY and keeps arrival order within a tie', () => {
    const h = g();
    // desc: 3,3,3,2,2,1,1 -> tags 0,2,5,3,6,1,4. The tie groups stay in ARRIVAL order, which is
    // what distinguishes a negated comparison from a reversed array.
    expect(run(h, traversal(V(), order({ desc: true }).by('age'), values('tag')))).toEqual([
      0, 2, 5, 3, 6, 1, 4,
    ]);
  });

  test('a missing by-key FILTERS the item out of the ordering', () => {
    const h = g();

    h.addVertex({ id: 'nokey', labels: ['P'], properties: { tag: 99 } });
    // the vertex without `age` is dropped, not sorted to an end
    expect(run(h, traversal(V(), order().by('age'), values('tag')))).toEqual([1, 4, 3, 6, 0, 2, 5]);
  });

  test('a stored null IS a value and orders, rather than being filtered', () => {
    const h = new Graph();

    h.addVertex({ id: 'a', labels: ['P'], properties: { age: 2, tag: 0 } });
    h.addVertex({ id: 'b', labels: ['P'], properties: { age: null, tag: 1 } });
    h.addVertex({ id: 'c', labels: ['P'], properties: { age: 1, tag: 2 } });

    const out = run(h, traversal(V(), order().by('age'), values('tag')));

    expect(out.length).toBe(3);
    // all three survive; only the POSITION of the null is the engine's ordering contract
    expect([...out].sort()).toEqual([0, 1, 2]);
  });

  test('ordering a plain value stream (no by) still works', () => {
    const h = new Graph();

    expect(run(h, traversal(inject(3, 1, 2), order()))).toEqual([1, 2, 3]);
  });

  // THE RUNTIME ELEMENT FAULT NEEDS A MIXED STREAM. A pure-element `order()` is rejected at PARSE
  // time by `checkStep`, so asserting `V().order()` throws proves nothing about this code — the
  // parser threw first, and the runtime fault's mutant survived until this test used a stream
  // whose frontier is no longer "element". `sortByBys`' own comment names the shape.
  test('an ELEMENT key in a MIXED stream faults at runtime', () => {
    const h = g();

    expect(() => run(h, traversal(V(), inject(1), order()))).toThrow(
      /no natural order|not supported/,
    );
  });

  test('a pure-element order() is still rejected (by the parser, earlier)', () => {
    const h = g();

    expect(() => run(h, traversal(V(), order()))).toThrow();
  });
});
