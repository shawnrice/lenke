import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasLabel, index, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('index tests', () => {
  const g = createTestTinkerGraph();

  // doc-derived: g.V().hasLabel('software').values('name').index() — pair values with positions.
  test('index() pairs each value with positional index', () => {
    const r = arr(run(traversal(V(), hasLabel('SOFTWARE'), values('name'), index()), g));
    expect(r).toEqual([
      ['lop', 0],
      ['ripple', 1],
    ]);
  });
});
