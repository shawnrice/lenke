import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { bothE, otherV, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('otherV tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(
      run(traversal(V('4'), bothE('KNOWS', 'CREATED', 'blah'), otherV()), tinkerGraph),
    );
    expect(result.map((x: any) => x.id)).toEqual(['1', '5', '3']);
    expect((result[0] as any).properties.name).toBe('marko');
    expect((result[1] as any).properties.name).toBe('ripple');
    expect((result[2] as any).properties.name).toBe('lop');
  });
});
