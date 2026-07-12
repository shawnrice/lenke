import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// TinkerPop "Modern" people (ages: marko 29, vadas 27, josh 32, peter 35), with
// one KNOWS edge — enough to exercise FOR's row-multiply and the batch OPTIONAL
// MATCH shape. Mirrors the Rust `gql::tests` FOR suite for cross-engine parity.
const modern = (): Graph => {
  const g = new Graph();
  const marko = g.addVertex({ labels: ['Person'], properties: { name: 'marko', age: 29 } });
  g.addVertex({ labels: ['Person'], properties: { name: 'vadas', age: 27 } });
  const josh = g.addVertex({ labels: ['Person'], properties: { name: 'josh', age: 32 } });
  g.addVertex({ labels: ['Person'], properties: { name: 'peter', age: 35 } });
  g.addEdge({ from: marko, to: josh, labels: ['KNOWS'], properties: { weight: 1 } });

  return g;
};

describe('GQL: FOR (ISO list unwind / UNWIND)', () => {
  test('unwinds a literal list', () => {
    expect(query(modern(), 'FOR x IN [1, 2, 3] RETURN x')).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
  });

  test('WITH ORDINALITY counts from 1', () => {
    expect(query(modern(), "FOR x IN ['a', 'b'] WITH ORDINALITY i RETURN x, i")).toEqual([
      { x: 'a', i: 1 },
      { x: 'b', i: 2 },
    ]);
  });

  test('WITH OFFSET counts from 0', () => {
    expect(query(modern(), "FOR x IN ['a', 'b'] WITH OFFSET i RETURN x, i")).toEqual([
      { x: 'a', i: 0 },
      { x: 'b', i: 1 },
    ]);
  });

  test('FOR over null yields no rows', () => {
    expect(query(modern(), 'FOR x IN null RETURN x')).toEqual([]);
  });

  test('FOR over an empty list yields no rows', () => {
    expect(query(modern(), 'FOR x IN [] RETURN x')).toEqual([]);
  });

  test('FOR over a scalar unwinds as a singleton', () => {
    expect(query(modern(), 'FOR x IN 5 RETURN x')).toEqual([{ x: 5 }]);
  });

  test('FOR multiplies prior MATCH rows', () => {
    expect(
      query(modern(), "MATCH (p:Person {name: 'marko'}) FOR t IN ['x', 'y'] RETURN p.name, t"),
    ).toEqual([
      { 'p.name': 'marko', t: 'x' },
      { 'p.name': 'marko', t: 'y' },
    ]);
  });

  test('the FOR list can reference a bound variable', () => {
    expect(
      query(modern(), "MATCH (p:Person {name: 'marko'}) FOR x IN [p.name, p.age] RETURN x"),
    ).toEqual([{ x: 'marko' }, { x: 29 }]);
  });

  test('a bare WITH after FOR starts a new clause (not a modifier)', () => {
    expect(query(modern(), 'FOR x IN [1, 2] WITH x AS y RETURN y')).toEqual([{ y: 1 }, { y: 2 }]);
  });

  test('FOR as the first clause needs no seed row', () => {
    expect(query(modern(), "FOR x IN ['only'] RETURN x")).toEqual([{ x: 'only' }]);
  });

  test('FOR drives a batch OPTIONAL MATCH (allow + deny per name)', () => {
    // josh exists (age 32); nobody does not, so OPTIONAL MATCH leaves p null.
    expect(
      query(
        modern(),
        "FOR name IN ['josh', 'nobody'] OPTIONAL MATCH (p:Person {name: name}) RETURN name, p.age",
      ),
    ).toEqual([
      { name: 'josh', 'p.age': 32 },
      { name: 'nobody', 'p.age': null },
    ]);
  });
});
