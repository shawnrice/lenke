import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { T, V, dedupe, group, groupCount, hasLabel, order, path, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('Token-based by(T.id) / by(T.label)', () => {
  const tinkerGraph = createTestTinkerGraph();

  test('groupCount().by(T.label) groups by element label', () => {
    const r = arr(run(traversal(V(), groupCount().by(T.label)), tinkerGraph));
    expect(r).toHaveLength(1);
    const counts = r[0] as Map<unknown, number>;
    expect(counts.get('PERSON')).toBe(4);
    expect(counts.get('SOFTWARE')).toBe(2);
  });

  test('group().by(T.label) groups vertices by label', () => {
    const r = arr(run(traversal(V(), group().by(T.label)), tinkerGraph));
    expect(r).toHaveLength(1);
    const groups = r[0] as Map<unknown, unknown[]>;
    expect((groups.get('PERSON') as unknown[]).length).toBe(4);
    expect((groups.get('SOFTWARE') as unknown[]).length).toBe(2);
  });

  test('dedupe().by(T.label) yields one element per distinct label', () => {
    const r = arr(run(traversal(V(), dedupe().by(T.label), values('name')), tinkerGraph));
    // First PERSON (marko) and first SOFTWARE (lop, after the 4 persons in fixture order).
    expect((r as string[]).sort()).toEqual(['lop', 'marko']);
  });

  test('path().by(T.id) projects each path element to its id', () => {
    // marko -> vadas via out('KNOWS'). Path is [marko, vadas]; .by(T.id) → ['1', '2'].
    const r = arr(
      run(traversal(V('1'), hasLabel('PERSON'), path().by(T.id)), tinkerGraph),
    ) as string[][];
    expect(r[0]).toEqual(['1']);
  });

  test('order().by(T.id) sorts by id (stringified)', () => {
    const r = arr(run(traversal(V(), order().by(T.id), values('name')), tinkerGraph));
    // IDs are '1','2','3','4','5','6'. Lex order matches numeric for these.
    expect(r).toEqual(['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter']);
  });
});
