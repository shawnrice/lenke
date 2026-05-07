import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { E, V, propertyMap } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('propertyMap tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().propertyMap()
  test('propertyMap on vertices wraps each value in an array', () => {
    const r = arr(run(traversal(V(), propertyMap()), tinkerGraph));
    expect(r).toEqual([
      { name: ['marko'], age: [29] },
      { name: ['vadas'], age: [27] },
      { name: ['josh'], age: [32] },
      { name: ['peter'], age: [35] },
      { name: ['lop'], lang: ['java'] },
      { name: ['ripple'], lang: ['java'] },
    ]);
  });

  // doc: g.E().propertyMap()
  test('propertyMap on edges', () => {
    const r = arr(run(traversal(E(), propertyMap()), tinkerGraph));
    expect(r).toEqual([
      { weight: [0.5] },
      { weight: [1.0] },
      { weight: [0.4] },
      { weight: [1.0] },
      { weight: [0.4] },
      { weight: [0.2] },
    ]);
  });
});
