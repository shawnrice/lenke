import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { eq } from '../predicates.js';
import { V, filter, is, label, pipe, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('filter tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().filter(label().is('person')) — v[1]; v[2]; v[4]; v[6]
  test('filter keeps traversers whose sub-traversal yields a value', () => {
    const r = arr(
      run(
        traversal(
          V(),
          filter(pipe(label(), is(eq('PERSON')))),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko', 'vadas', 'josh', 'peter']);
  });
});
