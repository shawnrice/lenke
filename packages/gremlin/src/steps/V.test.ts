import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('V tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('we can get all the vertices', () => {
    const result = arr(run(traversal(V()), tinkerGraph));
    expect(result).toHaveLength(6);
  });

  test('we have stable query order', () => {
    const result = arr(run(traversal(V()), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual([
      'marko',
      'vadas',
      'josh',
      'peter',
      'lop',
      'ripple',
    ]);
  });

  test('we can get a vertex', () => {
    const result = arr(run(traversal(V('1')), tinkerGraph));
    expect((result[0] as any).properties.name).toBe('marko');
  });

  // doc: g.V(1) — v[1]
  test('V(id) returns the single matching vertex', () => {
    const result = arr(run(traversal(V('1')), tinkerGraph)) as Array<{ id: string }>;
    expect(result.map((v) => v.id)).toEqual(['1']);
  });
});
