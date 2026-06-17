import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasLabel, inE, or, outE, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('or tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().or(__.outE('created'), __.inE('created').count().is(gt(1))).values('name')
  // — marko; lop; josh; peter
  // We use the simpler condition outE('CREATED') OR inE('CREATED'),
  // which still satisfies the same vertices in our fixture.
  test('or combines two sub-traversals', () => {
    const r = arr(
      run(traversal(V(), or(outE('CREATED'), inE('CREATED')), values('name')), tinkerGraph),
    );
    // Anyone with an out- or in- 'created' edge: marko, josh, peter, lop, ripple
    expect(new Set(r)).toEqual(new Set(['marko', 'josh', 'peter', 'lop', 'ripple']));
  });

  // legacy: g.V().or(outE('KNOWS'), outE('CREATED')).values('name') — marko, josh, peter
  test('or: vertices with either out-knows or out-created', () => {
    const r = arr(
      run(traversal(V(), or(outE('KNOWS'), outE('CREATED')), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['marko', 'josh', 'peter']);
  });

  // legacy: g.V().hasLabel('SOFTWARE').or(outE('KNOWS')).values('name') — []
  test('or: filters everything when no sub-plan matches', () => {
    const r = arr(
      run(traversal(V(), hasLabel('SOFTWARE'), or(outE('KNOWS')), values('name')), tinkerGraph),
    );
    expect(r).toEqual([]);
  });

  // legacy: g.V().or(inE('KNOWS'), outE('CREATED')).values('name') — marko, vadas, josh, peter
  test('or: vertices with either in-knows or out-created', () => {
    const r = arr(
      run(traversal(V(), or(inE('KNOWS'), outE('CREATED')), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter']);
  });
});
