import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { bothE, otherV, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('otherV tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // Out-edges first → ripple (5), lop (3); then in-edge → marko (1).
  test('toy test', () => {
    const result = arr(
      run(traversal(V('4'), bothE('KNOWS', 'CREATED', 'blah'), otherV()), tinkerGraph),
    );
    expect(result.map((x: any) => x.id)).toEqual(['5', '3', '1']);
    expect((result[0] as any).properties.name).toBe('ripple');
    expect((result[1] as any).properties.name).toBe('lop');
    expect((result[2] as any).properties.name).toBe('marko');
  });

  // doc: g.V(4).bothE('knows','created','blah').otherV() → v[5], v[3], v[1]
  test('otherV() over bothE(knows,created,blah) on v[4] yields v[5], v[3], v[1]', () => {
    const result = arr(
      run(traversal(V('4'), bothE('KNOWS', 'CREATED', 'blah'), otherV()), tinkerGraph),
    ) as Array<{ id: string }>;
    expect(result.map((v) => v.id)).toEqual(['5', '3', '1']);
  });
});
