import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasId, properties, value } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('value tests', () => {
  const g = createTestTinkerGraph();

  // doc: g.V(1).properties().value() — unwrap {key,value} to bare values.
  test('value() unwraps {key,value} from properties()', () => {
    const r = arr(run(traversal(V(), hasId('1'), properties('name'), value()), g));
    expect(r).toEqual(['marko']);
  });

  test('value() is identity for non-property values', () => {
    const r = arr(run(traversal(V(), hasId('1'), value()), g));
    // Vertex passes through.
    expect(r.length).toBe(1);
  });
});
