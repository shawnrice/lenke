import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, in_, optional, out } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('optional tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V(2).optional(out('knows')) — v[2] (vadas has no out-knows, so falls back)
  test('optional falls back when sub-traversal is empty', () => {
    const r = arr(run(traversal(V('2'), optional(out('KNOWS'))), tinkerGraph));
    expect((r as Array<{ id: string }>).map((x) => x.id)).toEqual(['2']);
  });

  // doc: g.V(2).optional(__.in('knows')) — v[1]  (vadas has in-knows from marko)
  test('optional yields sub-traversal results when non-empty', () => {
    const r = arr(run(traversal(V('2'), optional(in_('KNOWS'))), tinkerGraph));
    expect((r as Array<{ id: string }>).map((x) => x.id)).toEqual(['1']);
  });
});
