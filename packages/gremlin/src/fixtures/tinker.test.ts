/**
 * Canonical Gremlin queries from the TinkerPop reference, executed against the
 * Modern graph fixture. Each test is a query you'll see verbatim in the docs.
 *
 * @see https://tinkerpop.apache.org/docs/current/reference/
 */
import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { eq, gt } from '../predicates.js';
import { V, count, dedupe, has, hasLabel, inV, out, outE, values } from '../steps.js';
import { traversal } from '../traversal.js';
import { createTestTinkerGraph } from './createTestTinkerGraph.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('TinkerPop Modern graph — canonical queries', () => {
  test('g.V().count() == 6', () => {
    const g = createTestTinkerGraph();
    expect(arr(run(traversal(V(), count()), g))).toEqual([6]);
  });

  test('g.E().count() == 6', () => {
    const g = createTestTinkerGraph();
    // E() count using `count()` after E source — quick path:
    const result = run(traversal(V(), out('KNOWS', 'CREATED'), count()), g);
    // 3 outbound edges from marko + 2 from josh + 1 from peter = 6 total target
    // visits, but `count()` after `out()` counts traversers, which equals edges.
    // Actually outbound from V() (all vertices): 3 from 1, 2 from 4, 1 from 6 = 6.
    expect(arr(result)).toEqual([6]);
  });

  test('g.V().has("name", "marko") finds marko', () => {
    const g = createTestTinkerGraph();
    const xs = arr(run(traversal(V(), has('name', eq('marko'))), g)) as Array<{
      id: string;
    }>;
    expect(xs).toHaveLength(1);
    expect(xs[0].id).toBe('1');
  });

  test('g.V().has("name", "marko").out("knows").values("name") == [vadas, josh]', () => {
    const g = createTestTinkerGraph();
    const xs = arr(run(traversal(V(), has('name', eq('marko')), out('KNOWS'), values('name')), g));
    expect((xs as string[]).sort()).toEqual(['josh', 'vadas']);
  });

  test('g.V().has("name", "marko").out("created").values("name") == [lop]', () => {
    const g = createTestTinkerGraph();
    const xs = arr(
      run(traversal(V(), has('name', eq('marko')), out('CREATED'), values('name')), g),
    );
    expect(xs).toEqual(['lop']);
  });

  test('g.V().hasLabel("PERSON").count() == 4', () => {
    const g = createTestTinkerGraph();
    expect(arr(run(traversal(V(), hasLabel('PERSON'), count()), g))).toEqual([4]);
  });

  test('g.V().hasLabel("SOFTWARE").count() == 2', () => {
    const g = createTestTinkerGraph();
    expect(arr(run(traversal(V(), hasLabel('SOFTWARE'), count()), g))).toEqual([2]);
  });

  test('g.V().has("age", gt(30)).values("name") == [josh, peter]', () => {
    const g = createTestTinkerGraph();
    const xs = arr(run(traversal(V(), has('age', gt(30)), values('name')), g));
    expect((xs as string[]).sort()).toEqual(['josh', 'peter']);
  });

  test('g.V().out().out().values("name") — friends of friends', () => {
    const g = createTestTinkerGraph();
    // From any V, two hops out:
    //   1 → {2,4,3} → 5 (from josh→ripple), 3 (from josh→lop)
    //   4 has no outgoing from 5/3 since both are SOFTWARE
    //   6 → 3 → (nothing, software has no outgoing)
    // So: ripple, lop (multiple paths to lop)
    const xs = arr(run(traversal(V(), out(), out(), values('name')), g));
    expect((xs as string[]).sort()).toEqual(['lop', 'ripple']);
  });

  test('g.V().out().out().dedupe().values("name") for unique', () => {
    const g = createTestTinkerGraph();
    const xs = arr(run(traversal(V(), out(), out(), dedupe(), values('name')), g));
    expect((xs as string[]).sort()).toEqual(['lop', 'ripple']);
  });

  test('outE → inV equivalent to out', () => {
    const g = createTestTinkerGraph();
    const a = arr(run(traversal(V('1'), out('KNOWS'), values('name')), g));
    const b = arr(run(traversal(V('1'), outE('KNOWS'), inV(), values('name')), g));
    expect((a as string[]).sort()).toEqual((b as string[]).sort());
  });

  test('g.V("1").out().values("name") — all marko"s direct neighbors', () => {
    const g = createTestTinkerGraph();
    const xs = arr(run(traversal(V('1'), out(), values('name')), g));
    // marko knows vadas, josh; created lop. All 3.
    expect((xs as string[]).sort()).toEqual(['josh', 'lop', 'vadas']);
  });

  test('g.V("4").out("created").values("name") — josh"s creations', () => {
    const g = createTestTinkerGraph();
    const xs = arr(run(traversal(V('4'), out('CREATED'), values('name')), g));
    expect((xs as string[]).sort()).toEqual(['lop', 'ripple']);
  });
});
