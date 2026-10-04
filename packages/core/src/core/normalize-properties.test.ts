import { describe, expect, test } from 'bun:test';

import { Graph } from './Graph.js';
import { normalizeProperties } from './validate.js';

// `normalizeProperties` lifts a tagged temporal (`{"@date": …}`) to its instance, and is the
// single funnel every property write passes through. Audit item 147 made it allocate its copy
// ONLY once a value actually moves — which is what its contract already claimed and what the
// code did not do: it filled all K slots on every call, then returned the original and threw
// the copy away.
//
// That matters because a single-property `SET` already pays an O(K) spread and an O(K) freeze,
// so a third full pass was a third of the per-write cost on a wide element. These tests pin the
// lifting that must still happen, and the identity that proves the copy is skipped.

describe('normalizeProperties', () => {
  test('returns the SAME object when nothing is lifted', () => {
    const bag = { a: 1, b: 'x', c: true, d: null };

    // Identity, not equality: this is the whole optimization. A copy would compare equal and
    // say nothing.
    expect(normalizeProperties(bag)).toBe(bag);
  });

  test('returns the same object for an EMPTY bag', () => {
    const bag = {};

    expect(normalizeProperties(bag)).toBe(bag);
  });

  test('lifts a tagged temporal, and copies when it does', () => {
    const bag = { when: { '@date': '2020-01-01' }, n: 1 };
    const out = normalizeProperties(bag);

    expect(out).not.toBe(bag);
    // The tagged form is gone, replaced by something that is not a plain tagged object.
    expect(out.when).not.toEqual({ '@date': '2020-01-01' });
    // Every other key survives untouched.
    expect(out.n).toBe(1);
  });

  test('lifts EVERY tagged value, not just the first', () => {
    const bag = {
      a: { '@date': '2020-01-01' },
      b: 2,
      c: { '@date': '2021-06-15' },
    };
    const out = normalizeProperties(bag);

    // The lazy copy is seeded from the bag on the FIRST move, so a later move has to be
    // written into the copy rather than into the original.
    expect(out.a).not.toEqual({ '@date': '2020-01-01' });
    expect(out.c).not.toEqual({ '@date': '2021-06-15' });
    expect(out.b).toBe(2);
  });

  test('a tagged value in the LAST position is still lifted', () => {
    // The copy is created on first move; a value that moves at the end exercises the path
    // where the copy already exists and is being filled late.
    const bag = { a: 1, b: 2, c: { '@date': '2020-01-01' } };
    const out = normalizeProperties(bag);

    expect(out).not.toBe(bag);
    expect(out.c).not.toEqual({ '@date': '2020-01-01' });
    expect(out.a).toBe(1);
    expect(out.b).toBe(2);
  });

  test('the ORIGINAL bag is never mutated', () => {
    const bag = { a: 1, when: { '@date': '2020-01-01' } };

    normalizeProperties(bag);

    // The lazy copy must be a copy — writing the lifted value into `bag` would corrupt a
    // caller's object, and `setProperty` passes a freshly-spread bag whose source is the
    // graph's own frozen one.
    expect(bag.when).toEqual({ '@date': '2020-01-01' });
  });

  test('a tagged temporal inside a LIST is lifted', () => {
    const bag = { xs: [{ '@date': '2020-01-01' }, 2] };
    const out = normalizeProperties(bag) as { xs: unknown[] };

    expect(out).not.toBe(bag);
    expect(out.xs[0]).not.toEqual({ '@date': '2020-01-01' });
    expect(out.xs[1]).toBe(2);
  });
});

describe('the write path still lifts, whichever entry point writes', () => {
  // The funnel's reason for existing: a value that round-trips out of the graph and back in
  // must store as an instance, or it compares equal to nothing.
  const tagged = { '@date': '2020-01-01' };

  test('the constructor lifts', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'a', labels: ['P'], properties: { when: tagged, n: 1 } });

    expect(v.properties.when).not.toEqual(tagged);
    expect(v.properties.n).toBe(1);
  });

  test('setProperty lifts', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });

    v.setProperty('when', tagged);

    expect(v.properties.when).not.toEqual(tagged);
    // And the untouched key is preserved across the write.
    expect(v.properties.n).toBe(1);
  });

  test('setProperties lifts', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });

    v.setProperties({ when: tagged });

    expect(v.properties.when).not.toEqual(tagged);
  });

  test('an ordinary write preserves every other key', () => {
    // The identity fast path must not change what a write produces: a wide element keeps all
    // of its properties when one is set.
    const g = new Graph();
    const props: Record<string, unknown> = {};

    for (let i = 0; i < 40; i++) {
      props[`p${i}`] = i;
    }

    const v = g.addVertex({ id: 'a', labels: ['P'], properties: props });

    v.setProperty('p0', 99);

    expect(Object.keys(v.properties)).toHaveLength(40);
    expect(v.properties.p0).toBe(99);
    expect(v.properties.p39).toBe(39);
  });

  test('the stored bag is frozen', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'a', labels: ['P'], properties: { n: 1 } });

    // The freeze is what turns a stray `v.properties.x = …` into a loud throw instead of
    // silent index corruption, and it is applied to whichever object the funnel returns —
    // including the original when nothing was lifted.
    expect(Object.isFrozen(v.properties)).toBe(true);
  });
});
