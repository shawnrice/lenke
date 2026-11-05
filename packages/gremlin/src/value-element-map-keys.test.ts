import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { run } from './executor.js';
import { E, V, elementMap, valueMap } from './steps.js';
import { traversal } from './traversal.js';

/**
 * Item 1475 replaced byte-identical property-copy loops in `valueMap` and `elementMap` with one
 * shared `copyProps`, and dropped a guard that could never fail: with no keys requested the targets
 * come FROM the property bag, so `k in props` was re-answering what `Object.keys` had just answered,
 * once per property per traverser (1.14x on `valueMap` over 50,000 vertices, 3/3).
 *
 * The two arms genuinely differ and both need pinning:
 *
 *   - **no keys requested** → every own property, in bag order, no guard needed;
 *   - **keys requested** → only those, and a REQUESTED KEY MAY BE ABSENT, so that arm keeps the test.
 *
 * ⚠️ Key ORDER is part of the contract, not an implementation detail — column order is observable in
 * the output bytes — so these assert `Object.keys(...)` sequences, not just membership.
 */

const mixed = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { x: 1, y: 2, z: 3 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { x: 10 } });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['E'], properties: { w: 5 } });

  return g;
};

const rows = (r: Iterable<unknown>): Record<string, unknown>[] =>
  [...r] as Record<string, unknown>[];

describe('valueMap with no keys copies the whole bag, in bag order', () => {
  test('every own property is present, in insertion order', () => {
    const out = rows(run(traversal(V(), valueMap()), mixed()));

    expect(out).toHaveLength(2);
    expect(Object.keys(out[0])).toEqual(['x', 'y', 'z']);
    expect(out[0]).toEqual({ x: 1, y: 2, z: 3 });
  });

  test('a sparser element yields only what it has, not placeholders', () => {
    const out = rows(run(traversal(V(), valueMap()), mixed()));

    expect(Object.keys(out[1])).toEqual(['x']);
    expect(out[1]).toEqual({ x: 10 });
  });

  test('an element with NO properties yields an empty map, not a dropped row', () => {
    const g = new Graph();

    g.addVertex({ id: 'bare', labels: ['P'], properties: {} });

    const out = rows(run(traversal(V(), valueMap()), g));

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({});
  });
});

describe('valueMap with keys requested keeps the absent-key guard', () => {
  test('a requested key that is absent is OMITTED, and the row survives', () => {
    const out = rows(run(traversal(V(), valueMap('x', 'y')), mixed()));

    // `b` has no `y`: the key is omitted and `b` still produces a row.
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ x: 1, y: 2 });
    expect(out[1]).toEqual({ x: 10 });
  });

  test('requested keys are emitted in REQUEST order, not bag order', () => {
    const out = rows(run(traversal(V(), valueMap('z', 'x')), mixed()));

    expect(Object.keys(out[0])).toEqual(['z', 'x']);
  });

  test('a key absent from every element yields empty maps', () => {
    const out = rows(run(traversal(V(), valueMap('nope')), mixed()));

    expect(out).toEqual([{}, {}]);
  });
});

describe('elementMap shares the same copy rule and keeps its tokens first', () => {
  test('tokens precede the properties, with no keys requested', () => {
    const out = rows(run(traversal(V(), elementMap()), mixed()));

    expect(Object.keys(out[0])).toEqual(['id', 'label', 'x', 'y', 'z']);
    expect(out[0].id).toBe('a');
  });

  test('a requested absent key is omitted here too, tokens still present', () => {
    const out = rows(run(traversal(V(), elementMap('y')), mixed()));

    expect(Object.keys(out[0])).toEqual(['id', 'label', 'y']);
    // `b` lacks `y`, so only the tokens remain.
    expect(Object.keys(out[1])).toEqual(['id', 'label']);
  });

  test('an edge keeps IN/OUT before its properties', () => {
    const out = rows(run(traversal(E(), elementMap()), mixed()));

    expect(Object.keys(out[0])).toEqual(['id', 'label', 'IN', 'OUT', 'w']);
    expect(out[0].w).toBe(5);
  });
});
