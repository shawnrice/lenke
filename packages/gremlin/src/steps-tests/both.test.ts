import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { both, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('both tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(run(traversal(V('4'), both('KNOWS', 'CREATED', 'BLAH')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['marko', 'ripple', 'lop']);
  });

  test('get a specific label', () => {
    const result = arr(run(traversal(V('1'), both('KNOWS')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['vadas', 'josh']);
  });

  test('getting all the labels is like asking for none of the labels', () => {
    const result = arr(run(traversal(V('4'), both()), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['ripple', 'lop', 'marko']);
  });

  // doc: g.V(4).both('knows','created','blah') — TinkerPop emits v[5],v[3],v[1]
  // (out-neighbors then in-neighbors). Our impl iterates per-label, yielding
  // [1,5,3]. Same set; assert parity rather than order.
  test('both(knows,created,blah) on v[4] yields {v[1], v[5], v[3]} (set parity with docs)', () => {
    const result = arr(
      run(traversal(V('4'), both('KNOWS', 'CREATED', 'blah')), tinkerGraph),
    ) as Array<{ id: string }>;
    expect(new Set(result.map((v) => v.id))).toEqual(new Set(['5', '3', '1']));
  });
});
