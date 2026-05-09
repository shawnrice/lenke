import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { in_, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('in_ tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(run(traversal(V('4'), in_()), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['marko']);
  });

  test('get a specific label', () => {
    const result = arr(run(traversal(V('1'), in_('KNOWS')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual([]);
  });

  test('get a specific label 2', () => {
    const result = arr(run(traversal(V('3'), in_('CREATED')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['marko', 'josh', 'peter']);
  });

  test('getting all the labels is like asking for none of the labels', () => {
    const a = arr(run(traversal(V('3'), in_('CREATED')), tinkerGraph));
    const b = arr(run(traversal(V('3'), in_()), tinkerGraph));
    expect(a).toEqual(b);
  });

  // doc: g.V(2).in('knows') — v[1] (vadas is known by marko)
  test('in_(knows) on vadas yields marko', () => {
    const result = arr(run(traversal(V('2'), in_('KNOWS')), tinkerGraph)) as Array<{
      id: string;
    }>;
    expect(result.map((v) => v.id)).toEqual(['1']);
  });
});
