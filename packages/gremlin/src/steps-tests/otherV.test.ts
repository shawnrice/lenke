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

  // doc: g.V(4).bothE('knows','created','blah').otherV() — v[5]; v[3]; v[1]
  // (TinkerPop emits out edges first; our impl emits per-label so ordering
  // differs — compare by set parity.)
  test('otherV() over bothE(knows,created,blah) on v[4] yields v[1], v[5], v[3]', () => {
    const result = arr(
      run(traversal(V('4'), bothE('KNOWS', 'CREATED', 'blah'), otherV()), tinkerGraph),
    ) as Array<{ id: string }>;
    expect(new Set(result.map((v) => v.id))).toEqual(new Set(['1', '5', '3']));
  });
});
