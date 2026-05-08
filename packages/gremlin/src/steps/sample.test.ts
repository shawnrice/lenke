import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasLabel, outE, sample, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('sample tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('sample(n) returns at most n traversers', () => {
    const r = arr(run(traversal(V(), hasLabel('PERSON'), sample(2), values('name')), tinkerGraph));
    expect(r.length).toBe(2);
    // Each result is one of the four person names.
    for (const name of r) {
      expect(['marko', 'vadas', 'josh', 'peter']).toContain(name as string);
    }
  });

  test('sample(n) caps at stream size', () => {
    const r = arr(run(traversal(V(), hasLabel('SOFTWARE'), sample(99), values('name')), tinkerGraph));
    // Only two software vertices in the fixture.
    expect(r.length).toBe(2);
    expect([...r].sort()).toEqual(['lop', 'ripple']);
  });

  test('sample(0) yields nothing', () => {
    const r = arr(run(traversal(V(), sample(0)), tinkerGraph));
    expect(r).toEqual([]);
  });

  // doc: g.V().outE().sample(1).values('weight') — single weight value.
  test('sample(1) on outE yields exactly one weight', () => {
    const r = arr(run(traversal(V(), outE(), sample(1), values('weight')), tinkerGraph));
    expect(r.length).toBe(1);
    expect([0.5, 1.0, 0.4, 0.2]).toContain(r[0] as number);
  });
});
