import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { E } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('E tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('we can get all the edges', () => {
    const result = arr(run(traversal(E()), tinkerGraph));
    expect(result).toHaveLength(6);
  });

  test('edges are returned in insertion order', () => {
    const result = arr(run(traversal(E()), tinkerGraph));
    expect(result.map((e: any) => e.id)).toEqual(['7', '8', '9', '10', '11', '12']);
  });

  test('we can get a specific edge by id', () => {
    const result = arr(run(traversal(E('7')), tinkerGraph));
    expect(result).toHaveLength(1);
    expect((result[0] as any).from.id).toBe('1');
    expect((result[0] as any).to.id).toBe('2');
    expect([...(result[0] as any).labels]).toEqual(['KNOWS']);
  });
});
