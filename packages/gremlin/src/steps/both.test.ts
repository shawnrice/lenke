import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { both, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('both tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // Out-neighbors first (CREATED → ripple, lop), then in-neighbors (KNOWS → marko).
  test('toy test', () => {
    const result = arr(run(traversal(V('4'), both('KNOWS', 'CREATED', 'BLAH')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['ripple', 'lop', 'marko']);
  });

  test('get a specific label', () => {
    const result = arr(run(traversal(V('1'), both('KNOWS')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['vadas', 'josh']);
  });

  test('getting all the labels is like asking for none of the labels', () => {
    const result = arr(run(traversal(V('4'), both()), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['ripple', 'lop', 'marko']);
  });

  // doc: g.V(4).both('knows','created','blah') → v[5], v[3], v[1]
  test('both(knows,created,blah) on v[4] yields v[5], v[3], v[1]', () => {
    const result = arr(
      run(traversal(V('4'), both('KNOWS', 'CREATED', 'blah')), tinkerGraph),
    ) as Array<{ id: string }>;
    expect(result.map((v) => v.id)).toEqual(['5', '3', '1']);
  });
});
