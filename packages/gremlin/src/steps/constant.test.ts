import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, choose, coalesce, constant, hasLabel, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('constant tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().choose(hasLabel('person'), values('name'), constant('inhuman'))
  // — marko; vadas; josh; peter; inhuman; inhuman (v2 fixture order)
  test('constant as fallback in choose', () => {
    const r = arr(
      run(
        traversal(V(), choose(hasLabel('PERSON'), values('name'), constant('inhuman'))),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter', 'inhuman', 'inhuman']);
  });

  // doc: g.V().coalesce(hasLabel('person').values('name'), constant('inhuman'))
  test('constant as fallback in coalesce', () => {
    const r = arr(
      run(
        traversal(
          V(),
          coalesce((p) => values('name')(hasLabel('PERSON')(p)), constant('inhuman')),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter', 'inhuman', 'inhuman']);
  });

  // doc: g.V().constant('foo') — replace every traverser's value with 'foo'.
  test('constant replaces every traverser with the same value', () => {
    const r = arr(run(traversal(V(), constant('foo')), tinkerGraph));
    expect(r).toEqual(['foo', 'foo', 'foo', 'foo', 'foo', 'foo']);
  });

  // doc: constant works with non-string scalars too.
  test('constant works with numeric values', () => {
    const r = arr(run(traversal(V(), hasLabel('SOFTWARE'), constant(42)), tinkerGraph));
    expect(r).toEqual([42, 42]);
  });
});
