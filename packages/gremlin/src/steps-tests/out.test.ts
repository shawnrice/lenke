import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { out, V } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('out tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('toy test', () => {
    const result = arr(run(traversal(V('4'), out()), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['ripple', 'lop']);
  });

  test('double out', () => {
    const result = arr(run(traversal(V(), out(), out()), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['ripple', 'lop']);
  });

  test('get a specific label', () => {
    const result = arr(run(traversal(V('1'), out('KNOWS')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['vadas', 'josh']);
  });

  test('get multiple labels', () => {
    const result = arr(run(traversal(V('1'), out('KNOWS', 'CREATED')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['vadas', 'josh', 'lop']);
  });

  test('getting all the labels is like asking for none of the labels', () => {
    const a = arr(run(traversal(V('1'), out('KNOWS', 'CREATED')), tinkerGraph));
    const b = arr(run(traversal(V('1'), out()), tinkerGraph));
    expect(a).toEqual(b);
  });

  test('querying labels in order matters', () => {
    const result = arr(run(traversal(V('1'), out('CREATED', 'KNOWS')), tinkerGraph));
    expect(result.map((x: any) => x.properties.name)).toEqual(['lop', 'vadas', 'josh']);
  });

  // From doc: g.V().out('created').toList() — v[3]; v[5]; v[3]; v[3]
  test('out(created) across all vertices yields creator targets in order', () => {
    const result = arr(run(traversal(V(), out('CREATED')), tinkerGraph));
    expect((result as Array<{ id: string }>).map((x) => x.id)).toEqual(['3', '5', '3', '3']);
  });

  // From doc: g.V().out().out().values('name') — ripple; lop
  test('out().out() chained reaches grand-children', () => {
    const result = arr(run(traversal(V(), out(), out()), tinkerGraph));
    expect((result as any[]).map((v) => v.properties.name)).toEqual(['ripple', 'lop']);
  });
});
