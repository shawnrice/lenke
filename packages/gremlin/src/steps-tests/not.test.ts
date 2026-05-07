import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { gt } from '../predicates.js';
import { V, count, hasLabel, is, not, out, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('not tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().hasLabel('person').not(out('created').count().is(gt(1))).values('name')
  // — marko; vadas; peter
  test('not filters by sub-traversal absence', () => {
    const r = arr(
      run(
        traversal(
          V(),
          hasLabel('PERSON'),
          not((p) => is(gt(1))(count()(out('CREATED')(p)))),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['marko', 'vadas', 'peter']);
  });

  // legacy: g.V().not(hasLabel('PERSON')).values('name') — lop, ripple
  test('not(hasLabel) keeps non-matching labels', () => {
    const r = arr(run(traversal(V(), not(hasLabel('PERSON')), values('name')), tinkerGraph));
    expect(r).toEqual(['lop', 'ripple']);
  });
});
