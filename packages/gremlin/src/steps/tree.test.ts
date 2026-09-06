import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, has, out, tree, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];
// Normalize a (null-prototype) tree into a plain object for structural comparison — this
// is also exactly what `JSON.stringify` produces, i.e. the observable output. (These tests
// once asserted the internal `Map` — `.keys()`/`.get()`/`.size` — which hid a real bug:
// the tree serialized to `{}` because `JSON.stringify(Map)` is `{}`. They now assert the
// serializable structure the native engine round-trips against.)
const norm = (x: unknown): unknown => structuredClone(x);

describe('tree tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // g.V().has('name','josh').out('created').values('name').tree()
  // josh created ripple + lop; the values('name') leaf keys the last level by name.
  test('tree builds a nested map keyed by element JSON then leaf value', () => {
    const [root] = arr(
      run(
        traversal(
          V(),
          has('name', { op: 'eq', value: 'josh' }),
          out('CREATED'),
          values('name'),
          tree(),
        ),
        tinkerGraph,
      ),
    ) as [Record<string, unknown>];

    // One root — josh — keyed by its canonical element JSON.
    const joshKey = '{"id":"4","labels":["PERSON"],"properties":{"age":32,"name":"josh"}}';
    expect(Object.keys(root)).toEqual([joshKey]);

    // Josh -> two software elements -> each -> its name leaf (from values('name')).
    const lopKey = '{"id":"3","labels":["SOFTWARE"],"properties":{"lang":"java","name":"lop"}}';
    const rippleKey =
      '{"id":"5","labels":["SOFTWARE"],"properties":{"lang":"java","name":"ripple"}}';
    expect(norm(root)).toEqual({
      [joshKey]: { [lopKey]: { lop: {} }, [rippleKey]: { ripple: {} } },
    });
  });

  test('bare tree() over a single 1-hop path keys each level by element JSON', () => {
    const [root] = arr(
      run(
        traversal(V(), has('name', { op: 'eq', value: 'marko' }), out('CREATED'), tree()),
        tinkerGraph,
      ),
    ) as [Record<string, unknown>];

    const markoKey = '{"id":"1","labels":["PERSON"],"properties":{"age":29,"name":"marko"}}';
    const lopKey = '{"id":"3","labels":["SOFTWARE"],"properties":{"lang":"java","name":"lop"}}';
    expect(norm(root)).toEqual({ [markoKey]: { [lopKey]: {} } });
  });

  // g.V().out().out().tree().by('name'): keys are name strings (round-robin by()).
  test("tree().by('name') keys nodes by their name property", () => {
    const [root] = arr(run(traversal(V('1'), out(), out(), tree().by('name')), tinkerGraph)) as [
      Record<string, unknown>,
    ];

    // 2-hop paths from marko: marko->josh->ripple, marko->josh->lop.
    expect(norm(root)).toEqual({ marko: { josh: { ripple: {}, lop: {} } } });
  });

  test('tree is empty when the stream is empty', () => {
    const [root] = arr(
      run(traversal(V(), has('name', { op: 'eq', value: 'nobody' }), tree()), tinkerGraph),
    ) as [Record<string, unknown>];

    expect(norm(root)).toEqual({});
  });
});
