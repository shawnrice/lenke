import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { outE, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('outE tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(run(traversal(V('4'), outE()), tinkerGraph));
    expect(result.map((x: any) => x.properties.weight)).toEqual([1, 0.4]);
  });

  test('get a specific label', () => {
    const result = arr(run(traversal(V('1'), outE('KNOWS')), tinkerGraph));
    expect(result).toHaveLength(2);
    expect((result[0] as any).to.properties?.name).toBe('vadas');
    expect((result[0] as any).properties.weight).toBe(0.5);
    expect((result[1] as any).to.properties?.name).toBe('josh');
    expect((result[1] as any).properties.weight).toBe(1);
    expect(result[2]).toBeUndefined();
  });

  test('get multiple labels', () => {
    const result = arr(run(traversal(V('1'), outE('KNOWS', 'CREATED')), tinkerGraph));
    expect((result[0] as any).to.properties?.name).toBe('vadas');
    expect((result[0] as any).properties.weight).toBe(0.5);
    expect((result[1] as any).to.properties?.name).toBe('josh');
    expect((result[1] as any).properties.weight).toBe(1);
    expect((result[2] as any).to.properties?.name).toBe('lop');
    expect((result[2] as any).properties.weight).toBe(0.4);
    expect(result[3]).toBeUndefined();
  });

  test('getting all the labels is like asking for none of the labels', () => {
    const a = arr(run(traversal(V('1'), outE('CREATED', 'KNOWS')), tinkerGraph));
    const b = arr(run(traversal(V('1'), outE()), tinkerGraph));
    // Order differs (label order vs insertion order); compare by id set instead.
    expect(new Set(a.map((e: any) => e.id))).toEqual(new Set(b.map((e: any) => e.id)));
  });
});
