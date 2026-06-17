import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { bothV, inE, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('bothV tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(run(traversal(V('4'), inE(), bothV()), tinkerGraph));
    expect((result[0] as any).properties.name).toBe('marko');
    expect((result[1] as any).properties.name).toBe('josh');
  });

  // doc: g.V(4).inE().bothV() — v[1]; v[4]
  test('inE().bothV() on v[4] yields v[1] and v[4]', () => {
    const result = arr(run(traversal(V('4'), inE(), bothV()), tinkerGraph)) as Array<{
      id: string;
    }>;
    expect(result.map((v) => v.id)).toEqual(['1', '4']);
  });
});
