import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { inE, outV, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('outV tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(run(traversal(V('4'), inE(), outV()), tinkerGraph));
    expect((result[0] as any).properties.name).toBe('marko');
  });

  // doc: g.V(4).inE().outV() — v[1]
  test('inE().outV() on v[4] yields v[1]', () => {
    const result = arr(run(traversal(V('4'), inE(), outV()), tinkerGraph)) as Array<{
      id: string;
    }>;
    expect(result.map((v) => v.id)).toEqual(['1']);
  });
});
