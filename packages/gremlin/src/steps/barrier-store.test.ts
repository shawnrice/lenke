import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, aggregate, barrier, cap, hasLabel, store, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('barrier and store', () => {
  const g = createTestTinkerGraph();

  test('barrier() is observationally identity (passes traversers through)', () => {
    const r = arr(run(traversal(V(), hasLabel('PERSON'), barrier(), values('name')), g));
    expect((r as string[]).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('store(key) collects each traverser into a named bag, transparent forward', () => {
    const r = arr(
      run(traversal(V(), hasLabel('SOFTWARE'), store('softs'), values('name'), cap('softs')), g),
    ) as unknown[][];
    expect(r).toHaveLength(1);
    const [bag] = r;
    expect(bag).toHaveLength(2);
  });

  test('store and aggregate are interchangeable in v2', () => {
    const a = arr(run(traversal(V(), hasLabel('SOFTWARE'), aggregate('x'), cap('x')), g)) as unknown[][];
    const b = arr(run(traversal(V(), hasLabel('SOFTWARE'), store('x'), cap('x')), g)) as unknown[][];
    expect(a[0]).toHaveLength(2);
    expect(b[0]).toHaveLength(2);
  });
});
