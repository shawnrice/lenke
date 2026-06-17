import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasId, hasValue, properties, value } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('hasValue tests', () => {
  const g = createTestTinkerGraph();

  // doc: g.V(v).properties('name').hasValue('marko') — vp[name->marko]
  test('hasValue filters property objects by value field', () => {
    const r = arr(
      run(traversal(V(), hasId('1'), properties('name'), hasValue('marko'), value()), g),
    );
    expect(r).toEqual(['marko']);
  });

  test('hasValue excludes non-matching values', () => {
    const r = arr(run(traversal(V(), hasId('1'), properties('name'), hasValue('vadas')), g));
    expect(r).toEqual([]);
  });

  test('hasValue accepts multiple values (any-of)', () => {
    const r = arr(run(traversal(V(), properties('name'), hasValue('marko', 'lop'), value()), g));
    expect(r.sort()).toEqual(['lop', 'marko']);
  });
});
