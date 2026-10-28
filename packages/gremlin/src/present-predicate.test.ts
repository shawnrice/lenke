import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, count, has, hasKey, out, toArray, traversal } from './index.js';
import { matches } from './predicates.js';

/**
 * Item 1140. A single-key `hasKey` now rides the count shortcut as a synthetic `has` with the
 * `present` predicate. The shortcut and the general traversal must agree, and the case that
 * separates `present` from a value predicate is a STORED PRESENT-NULL: `hasKey` counts it
 * (`dispatch.ts` tests `k in bag`), and anything written as `!= null` would not.
 */
const fixture = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  // A STORED null — present, with a null value. This is the row that fails a `!= null` test.
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: null } });
  const c = g.addVertex({ id: 'c', labels: ['P'], properties: {} }); // absent
  // Carries ONLY the second key of the multi-key test. Without it, `hasKey(k, z)` and `has(k)`
  // give the same answer and the multi-key guard's mutant SURVIVES — which it did.
  const d = g.addVertex({ id: 'd', labels: ['P'], properties: { z: 1 } });
  const hub = g.addVertex({ id: 'hub', labels: ['P'], properties: { k: 9 } });

  g.addEdge({ id: 'e1', labels: ['K'], from: hub, to: a, properties: {} });
  g.addEdge({ id: 'e2', labels: ['K'], from: hub, to: b, properties: {} });
  g.addEdge({ id: 'e3', labels: ['K'], from: hub, to: c, properties: {} });
  g.addEdge({ id: 'e4', labels: ['K'], from: hub, to: d, properties: {} });

  return g;
};

describe('the present predicate', () => {
  test('is true for a stored null and false only for an absent key', () => {
    // The whole point: `null` is PRESENT, `undefined` is the absence marker.
    expect(matches({ op: 'present' }, null)).toBe(true);
    expect(matches({ op: 'present' }, undefined)).toBe(false);
    expect(matches({ op: 'present' }, 0)).toBe(true);
    expect(matches({ op: 'present' }, '')).toBe(true);
    expect(matches({ op: 'present' }, false)).toBe(true);
    expect(matches({ op: 'present' }, Number.NaN)).toBe(true);
  });
});

describe('a presence filter after a hop reaches the count shortcut', () => {
  test('counts a stored present-null, like the general traversal does', () => {
    const g = fixture();

    // a (value 1) and b (stored null) carry `k`; c does not. The shortcut must say 2, NOT 1.
    expect(toArray(traversal(V(), out('K'), has('k'), count()), g)).toEqual([2]);
    expect(toArray(traversal(V(), out('K'), hasKey('k'), count()), g)).toEqual([2]);
  });

  test('agrees with the same question asked without the terminal count', () => {
    const g = fixture();
    const rows = toArray(traversal(V(), out('K'), has('k')), g);

    // The shortcut's number must equal the length of the stream the general path produces.
    expect(toArray(traversal(V(), out('K'), has('k'), count()), g)).toEqual([rows.length]);
  });

  test('a MULTI-key hasKey declines rather than being folded as a conjunction', () => {
    const g = fixture();

    // ANY-of over FOUR far vertices: a and b have `k`, d has only `z`, c has neither. So
    // `hasKey(k, z)` is 3 while `has(k)` alone is 2 — which is what makes this test able to fail.
    // A guard that let the multi-key form through as `has(keys[0])` would answer 2.
    expect(toArray(traversal(V(), out('K'), hasKey('k', 'z'), count()), g)).toEqual([3]);
    expect(toArray(traversal(V(), out('K'), has('k'), count()), g)).toEqual([2]);
    // And the other order, so the mutant cannot pass by picking the lucky key.
    expect(toArray(traversal(V(), out('K'), hasKey('z', 'k'), count()), g)).toEqual([3]);
  });

  test('a presence filter mixed with a value filter still agrees', () => {
    const g = fixture();

    expect(toArray(traversal(V(), out('K'), has('k'), has('k', 1), count()), g)).toEqual([1]);
  });
});
