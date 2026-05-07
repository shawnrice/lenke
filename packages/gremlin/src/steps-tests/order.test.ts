import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasLabel, order, tail, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Gremlin tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('simple ordering works', () => {
    const result = arr(run(traversal(V(), values('name'), order()), tinkerGraph));
    expect(result).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('we can order by desc', () => {
    const result = arr(run(traversal(V(), values('name'), order({ desc: true })), tinkerGraph));
    expect(result).toEqual(['vadas', 'ripple', 'peter', 'marko', 'lop', 'josh']);
  });

  test('we can order by a property key', () => {
    const result = arr(
      run(traversal(V(), hasLabel('PERSON'), order({ key: 'age' }), values('name')), tinkerGraph),
    );
    expect(result).toEqual(['vadas', 'marko', 'josh', 'peter']);
  });

  // Same query via the modulator form — `order().by('age')` should match the
  // legacy `order({ key: 'age' })` form exactly.
  test('order().by(key) matches the legacy config form', () => {
    const result = arr(
      run(traversal(V(), hasLabel('PERSON'), order().by('age'), values('name')), tinkerGraph),
    );
    expect(result).toEqual(['vadas', 'marko', 'josh', 'peter']);
  });

  // doc: g.V().values('name').order().tail() — vadas
  test('order then tail() yields the last element', () => {
    const r = arr(run(traversal(V(), values('name'), order(), tail()), tinkerGraph));
    expect(r).toEqual(['vadas']);
  });

  // doc: g.V().values('name').order().tail(3) — peter; ripple; vadas
  test('order then tail(3) yields the last three', () => {
    const r = arr(run(traversal(V(), values('name'), order(), tail(3)), tinkerGraph));
    expect(r).toEqual(['peter', 'ripple', 'vadas']);
  });
});
