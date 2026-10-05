import { describe, expect, test } from 'bun:test';

import { ErrorCode } from '@lenke/errors';
import type { LenkeError } from '@lenke/errors';

import { Edge } from './Edge.js';
import { Graph } from './Graph.js';
import { Vertex } from './Vertex.js';

// An element's property bag now lives in a BOX that the element caches, so a read is a field
// load instead of a string-keyed `Map.get` into a map with one entry per element (audit item
// 161). Measured 16.17ms -> 1.83ms over 200,000 vertices reading one property each.
//
// A cache is only as good as its invalidation, and there are exactly three ways this one could
// go stale. Each gets a test, because each would be a SILENT wrong read rather than an error:
//
//   1. TWO attached instances sharing an id — one writes, the other must see it.
//   2. An element MOVED to another graph — it must not read the old graph's properties.
//   3. An element EVICTED from its graph — it must read as empty, as it did before.
describe('a property write is visible through every instance of the element', () => {
  test('two Vertex instances for one id share the write', () => {
    // `new Vertex({ ..., graph })` outside `addVertex` is a real construction path — `Graph`'s
    // own test suite uses it — so two ATTACHED instances can hold the same id. Caching the bag
    // itself (rather than a box) would let the first go stale here, silently.
    const g = new Graph();
    const first = g.addVertex({ id: 'v', labels: ['P'], properties: { k: 1 } });

    // Read through `first` BEFORE the second instance exists, so its cache is populated and a
    // stale read is possible.
    expect(first.properties.k).toBe(1);

    const second = new Vertex({ id: 'v', labels: ['P'], properties: { k: 2 }, graph: g });

    expect(second.properties.k).toBe(2);
    expect(first.properties.k).toBe(2);
  });

  test('a write through the SECOND instance reaches the first', () => {
    const g = new Graph();
    const first = g.addVertex({ id: 'v', labels: ['P'], properties: { k: 1 } });

    expect(first.properties.k).toBe(1);

    const second = new Vertex({ id: 'v', labels: ['P'], properties: { k: 1 }, graph: g });

    second.setProperty('k', 99);

    expect(first.properties.k).toBe(99);
    expect(second.properties.k).toBe(99);
  });

  test('a write through the FIRST instance reaches the second', () => {
    const g = new Graph();
    const first = g.addVertex({ id: 'v', labels: ['P'], properties: { k: 1 } });
    const second = new Vertex({ id: 'v', labels: ['P'], properties: { k: 1 }, graph: g });

    expect(second.properties.k).toBe(1);
    first.setProperty('k', 42);

    expect(second.properties.k).toBe(42);
    expect(first.properties.k).toBe(42);
  });

  test('two Edge instances for one id share the write', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });
    const first = g.addEdge({ id: 'e', from: a, to: b, labels: ['E'], properties: { w: 1 } });

    expect(first.properties.w).toBe(1);

    const second = new Edge({
      id: 'e',
      from: a,
      to: b,
      labels: ['E'],
      properties: { w: 7 },
      graph: g,
    });

    expect(second.properties.w).toBe(7);
    expect(first.properties.w).toBe(7);
  });
});

describe('moving an element to another graph drops the cached box', () => {
  test('a Vertex reassigned to a new graph does not read the old properties', () => {
    // The box belongs to the FIRST graph's map. Without clearing the cache on reassignment the
    // element would keep reading the old graph's bag.
    const g1 = new Graph();
    const v = g1.addVertex({ id: 'v', labels: ['P'], properties: { k: 'one' } });

    expect(v.properties.k).toBe('one');

    const g2 = new Graph();

    v.graph = g2;

    // g2 knows nothing about this id, so there is no bag to read.
    expect(v.properties).toEqual({});

    v.setProperty('k', 'two');
    expect(v.properties.k).toBe('two');
    // And the ORIGINAL graph still holds its own value, untouched.
    expect(g1.elementProperties.get('v')?.bag).toEqual({ k: 'one' });
  });
});

describe('an evicted element reads as empty', () => {
  test('a removed Vertex has no properties', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: { k: 1 } });

    expect(v.properties.k).toBe(1);
    g.removeVertex(v);

    // This was the behaviour before the box existed (the getter short-circuits on a null graph),
    // and a cached box must not resurrect it.
    expect(v.properties).toEqual({});
  });

  test('writing to an evicted Vertex is still a coded error', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: { k: 1 } });

    g.removeVertex(v);

    let code: string | undefined;

    try {
      v.setProperty('k', 2);
    } catch (e) {
      ({ code } = e as LenkeError);
    }

    expect(code).toBe(ErrorCode.InvalidGraphOp);
  });
});

describe('the bag stays frozen and the ordinary paths still work', () => {
  test('a top-level write to the bag throws', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: { k: 1 } });

    expect(() => {
      (v.properties as { k: number }).k = 2;
    }).toThrow();
  });

  test('setProperty, setProperties and removeProperty all read back', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: { a: 1 } });

    v.setProperty('b', 2);
    expect(v.properties).toEqual({ a: 1, b: 2 });

    v.setProperties({ c: 3 });
    expect(v.properties.c).toBe(3);

    v.removeProperty('a');
    expect('a' in v.properties).toBe(false);
    expect(v.properties.c).toBe(3);
  });

  test('an element with NO properties reads as an empty bag', () => {
    const g = new Graph();
    const v = g.addVertex({ id: 'v', labels: ['P'], properties: {} });

    expect(v.properties).toEqual({});
  });

  test('a property index still sees writes made through a second instance', () => {
    // The index is maintained by the write path, not the read path — but if a reader saw a
    // stale bag it could disagree with the index, which is the corruption the freeze exists to
    // prevent. This pins reader and index together.
    const g = new Graph();

    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

    const v = g.addVertex({ id: 'v', labels: ['P'], properties: { k: 1 } });
    const alias = new Vertex({ id: 'v', labels: ['P'], properties: { k: 1 }, graph: g });

    alias.setProperty('k', 5);

    expect(v.properties.k).toBe(5);
    expect(alias.properties.k).toBe(5);
  });
});
