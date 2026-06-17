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

  // doc: g.V().hasLabel('person').values('name').fold().order(local).by(...)
  // The reference shows index() applied to a list inside a fold/local; v2's
  // global index() emits one [v, idx] per traverser.
  test('index() over PERSON names labels in stream order', () => {
    const r = arr(run(traversal(V(), hasLabel('PERSON'), values('name'), index()), g));
    expect(r).toEqual([
      ['marko', 0],
      ['vadas', 1],
      ['josh', 2],
      ['peter', 3],
    ]);
  });

  // doc: g.V().hasLabel('software').index() — over vertex elements (not values).
  test('index() over vertex elements pairs each with index', () => {
    const r = arr(run(traversal(V(), hasLabel('SOFTWARE'), index()), g)) as Array<
      [{ id: string }, number]
    >;
    expect(r.map(([v, i]) => [v.id, i])).toEqual([
      ['3', 0],
      ['5', 1],
    ]);
  });
});
