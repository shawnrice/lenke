import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { lt } from '../predicates.js';
import { V, and, hasLabel, inE, is, outE, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('and tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().and(outE('knows'), values('age').is(lt(30))).values('name') — marko
  test('and combines two sub-traversals', () => {
    const r = arr(
      run(
        traversal(
          V(),
          and(outE('KNOWS'), (p) => is(lt(30))(values('age')(p))),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko']);
  });

  // legacy: g.V().and(outE('KNOWS'), outE('CREATED')).values('name') — marko
  test('and: vertices with both out-knows and out-created', () => {
    const r = arr(
      run(traversal(V(), and(outE('KNOWS'), outE('CREATED')), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['marko']);
  });

  // legacy: g.V().hasLabel('SOFTWARE').and(outE('KNOWS')).values('name') — []
  test('and: filters everything when no traverser matches', () => {
    const r = arr(
      run(traversal(V(), hasLabel('SOFTWARE'), and(outE('KNOWS')), values('name')), tinkerGraph),
    );
    expect(r).toEqual([]);
  });

  // legacy: g.V().and(inE('KNOWS'), outE('CREATED')).values('name') — josh
  test('and: vertices with both in-knows and out-created', () => {
    const r = arr(
      run(traversal(V(), and(inE('KNOWS'), outE('CREATED')), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['josh']);
  });
});
