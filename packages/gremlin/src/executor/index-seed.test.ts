import { describe, expect, test } from 'bun:test';

import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { between, eq, gt, inside, within } from '../predicates.js';
import { has, hasLabel, out, V, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { run } from './index.js';
import { seedVerticesFromIndex } from './index-seed.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('index-seeded V() source', () => {
  test('equality has() returns the same result whether or not name is indexed', () => {
    const plain = createTestTinkerGraph();
    const indexed = createTestTinkerGraph();
    indexed.createVertexIndex('name');

    const plan = () => traversal(V(), has('name', 'marko'), values('age'));
    expect(arr(run(plan(), indexed))).toEqual(arr(run(plan(), plain)));
    expect(arr(run(plan(), indexed))).toEqual([29]);
  });

  test('3-arg has(label, key, value) keeps the label constraint when seeded', () => {
    const g = createTestTinkerGraph();
    g.createVertexIndex('name');
    // lop is SOFTWARE; the PERSON label must still exclude it.
    expect(arr(run(traversal(V(), has('PERSON', 'name', 'lop'), values('name')), g))).toEqual([]);
    expect(arr(run(traversal(V(), has('PERSON', 'name', 'marko'), values('name')), g))).toEqual([
      'marko',
    ]);
  });

  test('downstream steps still run after an index seed', () => {
    const g = createTestTinkerGraph();
    g.createVertexIndex('name');
    // marko -created-> lop, so out() then name should reach lop/vadas/josh.
    const result = arr(run(traversal(V(), has('name', 'marko'), out(), values('name')), g));
    expect((result as string[]).sort()).toEqual(['josh', 'lop', 'vadas']);
  });

  test('seedVerticesFromIndex drops a plain has but keeps other filters', () => {
    const g = createTestTinkerGraph();
    g.createVertexIndex('name');
    const plan = traversal(V(), hasLabel('PERSON'), has('name', eq('marko')));
    const seeded = seedVerticesFromIndex(plan, g, false);
    expect(seeded).not.toBeNull();
    // The consumed has('name', ...) is gone; hasLabel stays as a residual.
    expect(seeded!.steps.map((s) => s.kind)).toEqual(['hasLabel']);
    expect(arr(seeded!.stream).length).toBe(1); // only marko in the bucket
  });

  test('falls back (null) for an unindexed key', () => {
    const g = createTestTinkerGraph();
    const plan = traversal(V(), has('name', eq('marko')));
    expect(seedVerticesFromIndex(plan, g, false)).toBeNull();
  });

  test('range predicates are seeded but kept as a residual filter', () => {
    const g = createTestTinkerGraph();
    g.createVertexIndex('age');
    // Ages: marko=29, vadas=27, josh=32, peter=35.
    const seeded = seedVerticesFromIndex(traversal(V(), has('age', gt(30))), g, false);
    expect(seeded).not.toBeNull();
    expect(arr(seeded!.stream).length).toBe(2); // josh, peter
    expect(seeded!.steps.map((s) => s.kind)).toEqual(['has']); // residual kept
  });

  test('range results match the unindexed scan', () => {
    const plain = createTestTinkerGraph();
    const indexed = createTestTinkerGraph();
    indexed.createVertexIndex('age');
    const cases = [gt(30), between(28, 33), inside(28, 33)];
    for (const pred of cases) {
      const plan = () => traversal(V(), has('age', pred), values('name'));
      expect((arr(run(plan(), indexed)) as string[]).sort()).toEqual(
        (arr(run(plan(), plain)) as string[]).sort(),
      );
    }
  });

  test('within is seeded from a union of buckets and dropped', () => {
    const g = createTestTinkerGraph();
    g.createVertexIndex('name');
    const seeded = seedVerticesFromIndex(
      traversal(V(), has('name', within('marko', 'josh', 'nobody'))),
      g,
      false,
    );
    expect(seeded).not.toBeNull();
    expect(arr(seeded!.stream).length).toBe(2); // marko, josh (nobody → empty)
    expect(seeded!.steps).toEqual([]); // exact match set → has dropped
  });

  test('within results match the unindexed scan', () => {
    const plain = createTestTinkerGraph();
    const indexed = createTestTinkerGraph();
    indexed.createVertexIndex('name');
    const plan = () => traversal(V(), has('name', within('vadas', 'josh')), values('name'));
    expect((arr(run(plan(), indexed)) as string[]).sort()).toEqual(
      (arr(run(plan(), plain)) as string[]).sort(),
    );
  });

  test('falls back (null) for a non-seedable predicate', () => {
    const g = createTestTinkerGraph();
    g.createVertexIndex('name');
    // `neq` has no bucket to seed from.
    const plan = traversal(V(), has('name', { op: 'neq', value: 'marko' }));
    expect(seedVerticesFromIndex(plan, g, false)).toBeNull();
  });

  test('an empty bucket short-circuits to no results', () => {
    const g = createTestTinkerGraph();
    g.createVertexIndex('name');
    expect(arr(run(traversal(V(), has('name', 'nobody'), values('name')), g))).toEqual([]);
  });

  test('picks the most selective indexed equality filter', () => {
    const g = createTestTinkerGraph();
    g.createVertexIndex('name');
    g.createVertexIndex('lang');
    // lang=java matches 2 vertices, name=lop matches 1 → seed should be name.
    const plan = traversal(V(), has('lang', eq('java')), has('name', eq('lop')));
    const seeded = seedVerticesFromIndex(plan, g, false);
    expect(seeded).not.toBeNull();
    expect(arr(seeded!.stream).length).toBe(1);
    // The kept residual is the lang filter (the less selective one).
    expect(seeded!.steps.map((s) => s.kind)).toEqual(['has']);
  });
});
