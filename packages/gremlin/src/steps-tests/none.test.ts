import { describe, expect, test } from 'bun:test';
import { run, toArray, toSet } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { Cardinality, Scope, V, count, hasLabel, none, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('none() / toArray / toSet / Scope / Cardinality', () => {
  const g = createTestTinkerGraph();

  test('none() drops every traverser', () => {
    const r = arr(run(traversal(V(), hasLabel('PERSON'), none()), g));
    expect(r).toEqual([]);
  });

  test('downstream steps after none() see an empty stream', () => {
    // count() over an empty stream should yield 0 (count is a reducer that
    // emits one traverser regardless of input cardinality).
    const r = arr(run(traversal(V(), none(), count()), g));
    expect(r).toEqual([0]);
  });

  test('toArray collects every emitted value', () => {
    const result = toArray(traversal(V(), hasLabel('PERSON'), values('name')), g);
    expect(result.sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('toSet de-dupes primitive values via JS equality', () => {
    const result = toSet(traversal(V(), values('name')), g);
    expect(result.size).toBe(6);
    expect(result.has('marko')).toBe(true);
  });

  test('Scope and Cardinality are exported as distinct symbols', () => {
    // Wiring is deferred; the symbols must at least exist and not collide.
    expect(typeof Scope.global).toBe('symbol');
    expect(typeof Scope.local).toBe('symbol');
    expect(Scope.global).not.toBe(Scope.local);
    expect(typeof Cardinality.single).toBe('symbol');
    expect(typeof Cardinality.list).toBe('symbol');
    expect(typeof Cardinality.set).toBe('symbol');
    expect(Cardinality.single).not.toBe(Cardinality.list);
    expect(Cardinality.list).not.toBe(Cardinality.set);
  });
});
