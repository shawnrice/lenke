import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { inE, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('inE tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(run(traversal(V('4'), inE()), tinkerGraph));
    const fromV = (result[0] as any).from;
    expect(fromV.properties.name).toBe('marko');
    expect(fromV.properties.age).toBe(29);
    expect((result[0] as any).properties.weight).toBe(1.0);
  });

  test('get a specific label', () => {
    const result = arr(run(traversal(V('1'), inE('KNOWS')), tinkerGraph));
    expect(result).toHaveLength(0);
  });

  // doc: g.V(4).inE('knows') — e[8][1-knows->4]
  test('inE(knows) on v[4]', () => {
    const r = arr(run(traversal(V('4'), inE('KNOWS')), tinkerGraph)) as Array<{ id: string }>;
    expect(r.map((e) => e.id)).toEqual(['8']);
  });

  // doc: g.V(4).inE('created') — (no result)
  test('inE(created) on v[4] yields nothing', () => {
    const r = arr(run(traversal(V('4'), inE('CREATED')), tinkerGraph));
    expect(r).toEqual([]);
  });

  test('get a specific label 2', () => {
    const result = arr(run(traversal(V('3'), inE('CREATED')), tinkerGraph));
    expect(result).toHaveLength(3);
    expect(result.map((x: any) => x.from.properties.name)).toEqual(['marko', 'josh', 'peter']);
    expect(result.map((x: any) => x.properties.weight)).toEqual([0.4, 0.4, 0.2]);
  });
});
