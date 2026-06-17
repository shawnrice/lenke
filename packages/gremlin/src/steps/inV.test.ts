import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { inV, outE, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('inV tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(run(traversal(V('4'), outE(), inV()), tinkerGraph));
    expect((result[0] as any).properties.name).toBe('ripple');
    expect((result[1] as any).properties.name).toBe('lop');
  });

  // doc: g.V(4).outE().inV() — v[5]; v[3]
  test('outE().inV() on v[4] yields v[5] and v[3]', () => {
    const result = arr(run(traversal(V('4'), outE(), inV()), tinkerGraph)) as Array<{
      id: string;
    }>;
    expect(result.map((v) => v.id)).toEqual(['5', '3']);
  });
});
