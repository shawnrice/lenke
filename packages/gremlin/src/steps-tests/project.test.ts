import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, count, has, id, inE, outE, project } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('STEP, project', () => {
  const g = createTestTinkerGraph();

  // doc: g.V().project('n','a').by('name').by('age')
  test('project name/age map per traverser', () => {
    const result = arr(
      run(traversal(V(), has('name', eq('marko')), project(['n', 'a'], ['name', 'age'])), g),
    );
    expect(result).toEqual([{ n: 'marko', a: 29 }]);
  });

  test('project applies across all matching vertices', () => {
    const result = arr(
      run(traversal(V(), has('name', eq('josh')), project(['name'], ['name'])), g),
    );
    expect(result).toEqual([{ name: 'josh' }]);
  });

  test('project without bys yields the traverser value for every key', () => {
    // Inject a primitive so the per-key value passes through unchanged.
    const result = arr(run(traversal(V(), has('name', eq('vadas')), project(['x'])), g));
    expect(result).toHaveLength(1);
    const obj = result[0] as Record<string, unknown>;
    // The vertex itself is the value when `by` is unset.
    expect(obj.x).toBeDefined();
  });

  // doc: g.V().has('name','marko').project('id','name','out','in').by(id).by('name').by(outE().count()).by(inE().count())
  test('project with id() / count() bys via sub-traversal', () => {
    const result = arr(
      run(
        traversal(
          V(),
          has('name', eq('marko')),
          project(['id', 'name', 'out', 'in'])
            .by(id())
            .by('name')
            .by(traversal(outE(), count()))
            .by(traversal(inE(), count())),
        ),
        g,
      ),
    );
    expect(result).toEqual([{ id: '1', name: 'marko', out: 3, in: 0 }]);
  });
});
