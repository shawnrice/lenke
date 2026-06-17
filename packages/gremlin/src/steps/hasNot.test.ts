import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, hasNot, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('hasNot tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V().hasNot('age').values('name') — lop; ripple
  test('hasNot filters vertices missing the given key', () => {
    const r = arr(run(traversal(V(), hasNot('age'), values('name')), tinkerGraph));
    expect(r).toEqual(['lop', 'ripple']);
  });

  test('hasNot accepts variadic keys (none-of semantics)', () => {
    // No vertex has both 'age' and 'lang' missing... lop and ripple lack 'age' but
    // have 'lang', so listing both keys excludes them too.
    const r = arr(run(traversal(V(), hasNot('age', 'lang'), values('name')), tinkerGraph));
    expect(r).toEqual([]);
  });
});
