import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { Pop, V, as_, out, pipe, repeat, select, values } from '../steps.js';
import { traversal } from '../traversal.js';

const arr = (r: Iterable<unknown>): unknown[] => [...r];

describe('select with Pop modes', () => {
  const tinkerGraph = createTestTinkerGraph();

  // Without iteration, a label is only ever tagged once. last == first == [single].
  test('default pop is "last" — single tag returns the value', () => {
    const r = arr(
      run(traversal(V('1'), as_('start'), select('start'), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['marko']);
  });

  test('Pop.first with single tag is equivalent to last', () => {
    const r = arr(
      run(traversal(V('1'), as_('start'), select(Pop.first, 'start'), values('name')), tinkerGraph),
    );
    expect(r).toEqual(['marko']);
  });

  test('Pop.all with single tag returns a 1-element list', () => {
    const r = arr(run(traversal(V('1'), as_('start'), select(Pop.all, 'start')), tinkerGraph));
    expect(r).toHaveLength(1);
    const list = r[0] as unknown[];
    expect(list).toHaveLength(1);
  });

  // Inside repeat, `as_('a')` re-tags each iteration.
  test('Pop.last (default) inside repeat returns the last iteration tag', () => {
    // marko -> vadas -> ?  (vadas has no out, so repeat(out().as_('a')).times(2) yields nothing)
    // Use marko -> josh -> ripple instead.
    const r = arr(
      run(
        traversal(
          V('4'), // josh
          repeat(pipe(out('CREATED'), as_('a'))).times(1),
          select('a'),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    // Last iteration's tags. Josh -> ripple, lop. Default last = whichever was tagged last.
    expect((r as string[]).sort()).toEqual(['lop', 'ripple']);
  });

  test('Pop.first inside repeat returns the FIRST iteration tag', () => {
    // marko's out() = {vadas, josh, lop}. Of those, only josh has further out (-> ripple, lop).
    // 2-hop survivors: marko -> josh -> ripple, marko -> josh -> lop.
    // Each survivor's hop[0] = josh.
    const r = arr(
      run(
        traversal(
          V('1'),
          repeat(pipe(out(), as_('hop'))).times(2),
          select(Pop.first, 'hop'),
          values('name'),
        ),
        tinkerGraph,
      ),
    );
    expect((r as string[]).sort()).toEqual(['josh', 'josh']);
  });

  test('Pop.all inside repeat collects all per-iteration tags', () => {
    const r = arr(
      run(
        traversal(V('1'), repeat(pipe(out(), as_('hop'))).times(2), select(Pop.all, 'hop')),
        tinkerGraph,
      ),
    ) as unknown[][];
    // Two surviving traversers, each with hop = [josh, ripple|lop].
    expect(r).toHaveLength(2);

    for (const list of r) {
      expect(list).toHaveLength(2);
    }
  });
});
