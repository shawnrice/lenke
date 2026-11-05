import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run } from './executor.js';
import { V, count, group, values } from './steps.js';
import { traversal } from './traversal.js';

/**
 * Item 1474 split `groupStep` into two bucket shapes — a traversal value-by still buffers the
 * group's `Traverser`s (it is applied as a barrier), while every other value-by is evaluated at
 * insertion and only the VALUE is kept (1.27x, and it stops retaining the whole stream).
 *
 * ⚠️ MUTATION FOUND THESE MISSING. A mutant that keeps a member whose value-by yields NO_VALUE —
 * instead of dropping it from the list — **survived all 1,241 Gremlin tests**. The nine existing
 * `group()` tests cover a missing KEY ("no null bucket") but never a missing VALUE, which is a
 * different rule with a different consequence:
 *
 *   - a missing KEY filters the traverser out entirely, so no bucket appears;
 *   - a missing VALUE drops that member from its bucket's list, **but its key still created the
 *     bucket** — so a bucket can legitimately map to an EMPTY list.
 *
 * That asymmetry is the whole subtlety of the step, and it was unasserted in either engine arm.
 */

/** Three vertices sharing a label; only some carry `age`. */
const partialAges = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { name: 'a', age: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { name: 'b' } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { name: 'c', age: 3 } });

  return g;
};

/**
 * `run` returns an ITERABLE, not an array. `group` takes ONE `{ keyBy, valueBy }` object for plain
 * bys — and a TRAVERSAL value-by is written with the fluent modulator, `group().by(k).by(count())`,
 * not by wrapping a step in `traversal()` inside the config.
 */
const asMap = (rows: Iterable<unknown>): Map<unknown, unknown> => {
  const out = [...rows];

  expect(out).toHaveLength(1);
  expect(out[0]).toBeInstanceOf(Map);

  return out[0] as Map<unknown, unknown>;
};

describe('a member whose VALUE-by yields nothing drops out of its bucket', () => {
  test('only present values are collected, with no placeholder for the absent one', () => {
    const g = partialAges();
    const m = asMap(run(traversal(V(), group({ keyBy: 'name', valueBy: 'age' })), g));

    // `b` has no age: its bucket exists (the key resolved) and its list is EMPTY.
    expect(m.get('a')).toEqual([1]);
    expect(m.get('c')).toEqual([3]);
    expect(m.get('b')).toEqual([]);
  });

  test('the absent-value bucket is PRESENT — a missing value is not a missing key', () => {
    const g = partialAges();
    const m = asMap(run(traversal(V(), group({ keyBy: 'name', valueBy: 'age' })), g));

    expect(m.has('b')).toBe(true);
    expect([...m.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  test('a bucket with several members keeps only the present values, in stream order', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, age: 10 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1 } });
    g.addVertex({ id: 'c', labels: ['P'], properties: { k: 1, age: 30 } });

    const m = asMap(run(traversal(V(), group({ keyBy: 'k', valueBy: 'age' })), g));

    expect(m.get(1)).toEqual([10, 30]);
  });

  test('every member missing the value leaves an EMPTY list, not a dropped bucket', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 7 } });
    g.addVertex({ id: 'b', labels: ['P'], properties: { k: 7 } });

    const m = asMap(run(traversal(V(), group({ keyBy: 'k', valueBy: 'age' })), g));

    expect(m.has(7)).toBe(true);
    expect(m.get(7)).toEqual([]);
  });
});

describe('the traversal value-by arm still folds as a barrier', () => {
  test('by(count()) counts the GROUP, including a member with no such property', () => {
    const g = partialAges();
    const m = asMap(run(traversal(V(), group().by('name').by(count())), g));

    // The count is over MEMBERS, so `b` counts even though it has no age.
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(1);
    expect(m.get('c')).toBe(1);
  });

  test('a traversal value-by over a shared key counts every member', () => {
    const g = new Graph();

    for (const id of ['a', 'b', 'c']) {
      g.addVertex({ id, labels: ['P'], properties: { k: 1 } });
    }

    const m = asMap(run(traversal(V(), group().by('k').by(count())), g));

    expect(m.get(1)).toBe(3);
  });

  test('a MAPPING traversal value-by collects each output rather than folding', () => {
    const g = partialAges();
    const m = asMap(run(traversal(V(), group().by('name').by(values('age'))), g));

    expect(m.get('a')).toEqual([1]);
    expect(m.get('c')).toEqual([3]);
    // `values('age')` yields nothing for `b`, so its collected list is empty.
    expect(m.get('b')).toEqual([]);
  });
});

describe('a missing KEY is still a different rule', () => {
  test('a traverser whose key-by yields nothing creates NO bucket at all', () => {
    const g = partialAges();
    // keyed by `age`: `b` has none, so it is filtered out entirely.
    const m = asMap(run(traversal(V(), group({ keyBy: 'age', valueBy: 'name' })), g));

    expect([...m.keys()].sort()).toEqual([1, 3]);
    expect(m.get(1)).toEqual(['a']);
    expect(m.get(3)).toEqual(['c']);
  });
});
