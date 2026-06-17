import { describe, expect, test } from 'bun:test';
import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { V, aggregate, cap, filter, in_, out, values, withoutBag } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('aggregate / cap tests', () => {
  const tinkerGraph = createTestTinkerGraph();

  // doc: g.V(1).out('created').aggregate('x') — v[3]
  test('aggregate stashes traversers but passes them through', () => {
    const r = arr(
      run(traversal(V('1'), out('CREATED'), aggregate('x'), values('name')), tinkerGraph),
    ) as string[];
    expect(r).toEqual(['lop']);
  });

  // doc: g.V(1).out('created').aggregate('x').in('created') — v[1]; v[4]; v[6]
  test('aggregate is transparent — downstream sees the same traversers', () => {
    const r = arr(
      run(traversal(V('1'), out('CREATED'), aggregate('x'), in_('CREATED')), tinkerGraph),
    ) as Array<{ id: string }>;
    expect(r.map((v) => v.id).sort()).toEqual(['1', '4', '6']);
  });

  // doc: g.V().out('knows').aggregate('x').cap('x') — [v[2],v[4]]
  test('cap reads back the bag at the end', () => {
    const r = arr(run(traversal(V(), out('KNOWS'), aggregate('x'), cap('x')), tinkerGraph));
    // cap emits a single traverser whose value is the array bag.
    expect(r).toHaveLength(1);
    const bag = r[0] as Array<{ id: string }>;
    expect(bag.map((v) => v.id)).toEqual(['2', '4']);
  });

  test('cap on an empty key yields an empty bag', () => {
    const r = arr(run(traversal(V('1'), cap('never-set')), tinkerGraph));
    expect(r).toEqual([[]]);
  });

  test('aggregate accumulates across the full stream before cap', () => {
    const r = arr(run(traversal(V(), aggregate('all'), cap('all')), tinkerGraph));
    const bag = (r[0] as Array<{ id: string }>).map((v) => v.id).sort();
    expect(bag).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  // doc: g.V(1).out('created').aggregate('x').in('created').out('created')
  //        .where(without('x')).values('name') — ripple
  // v2 expresses this with `filter(withoutBag('x'))` rather than the P-form.
  // The closure receives the run's side-effect map via `t.sideEffects`, and
  // `withoutBag` is sugar over `(v, t) => !t.sideEffects.get('x')?.includes(v)`.
  test('aggregate + filter(withoutBag): exclude already-seen', () => {
    const r = arr(
      run(
        traversal(
          V('1'),
          out('CREATED'), // {lop}
          aggregate('x'),
          in_('CREATED'), // {marko, josh, peter}
          out('CREATED'), // {lop, lop, ripple, lop}
          filter(withoutBag('x')), // exclude lop → {ripple}
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect(r).toEqual(['ripple']);
  });

  // doc: g.V(1).out('created').aggregate('x').in('created').out('created') — v[3]; v[5]; v[3]; v[3]
  test('aggregate is transparent across longer chains', () => {
    const r = arr(
      run(
        traversal(V('1'), out('CREATED'), aggregate('x'), in_('CREATED'), out('CREATED')),
        tinkerGraph,
      ),
    ) as Array<{ id: string }>;
    expect(r.map((v) => v.id).sort()).toEqual(['3', '3', '3', '5']);
  });

  // Two independent bags accumulate side-by-side; cap reads either.
  test('multiple aggregates with independent keys', () => {
    const r = arr(
      run(traversal(V(), aggregate('persons'), aggregate('all'), cap('persons')), tinkerGraph),
    );
    const bag = (r[0] as Array<{ id: string }>).map((v) => v.id).sort();
    expect(bag).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});
