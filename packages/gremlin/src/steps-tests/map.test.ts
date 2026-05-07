import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, count, hasLabel, map, out, outE, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('map tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc-style: g.V(1).out().map(values('name')) — lop; vadas; josh
  test('map(values) projects each traverser to first sub-plan output', () => {
    const r = arr(run(traversal(V('1'), out(), map(values('name'))), tinkerGraph));
    expect(r.sort()).toEqual(['josh', 'lop', 'vadas']);
  });

  // map(count()) on each person yields 1 per person (count is per-traverser
  // because map runs the sub-plan over a 1-element stream).
  test('map(count()) is per-traverser', () => {
    const r = arr(run(traversal(V(), hasLabel('PERSON'), map(count())), tinkerGraph));
    expect(r).toEqual([1, 1, 1, 1]);
  });

  // doc: g.V().hasLabel('person').outE('created').count().map(...) — per-person count.
  // We verify map(values('name')) takes only the FIRST output of the sub-plan
  // for vertices with multiple values: marko has only single 'name' value.
  test('map(values("name")) on persons yields single name each', () => {
    const r = arr(run(traversal(V(), hasLabel('PERSON'), map(values('name'))), tinkerGraph));
    expect((r as string[]).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  // map drops traversers whose sub-plan is empty.
  test('map drops traversers when sub-plan is empty', () => {
    // Software vertices have no `outE('CREATED')`, so map(...) drops them.
    const r = arr(run(traversal(V(), map(outE('CREATED'))), tinkerGraph));
    // Only person vertices yield an outE('CREATED').
    expect(r.length).toBe(3);
  });
});
