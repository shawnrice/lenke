import { describe, expect, test } from 'bun:test';

import { run } from '../executor.js';
import { createTestTinkerGraph } from '../fixtures/createTestTinkerGraph.js';
import { neq } from '../predicates.js';
import {
  as_,
  Column,
  groupCount,
  in_,
  Order,
  order,
  out,
  Scope,
  select,
  V,
  values,
  where,
} from '../steps.js';
import { traversal } from '../traversal.js';

// The collaborative-filtering step trio: `where(neq('me'))`, `order(local)` with a
// `Column` selector, and `select(Column)` to read the ranked result as a list.
describe('STEP, collaborative-filtering (where(neq) + order(local).by(Column) + select(Column))', () => {
  const g = createTestTinkerGraph();
  const arr = (r: Iterable<unknown>): unknown[] => [...r];

  test('where(neq(label)) excludes the seed among co-creators', () => {
    // lop's co-creators are marko, josh, peter; `where(neq('me'))` drops the seed marko.
    const result = arr(
      run(
        traversal(
          V('1'),
          as_('me'),
          out('CREATED'),
          in_('CREATED'),
          where(neq('me')),
          values('name'),
        ),
        g,
      ),
    );

    expect(result).toEqual(['josh', 'peter']);
  });

  test('order(local).by(values, desc).select(keys) ranks a groupCount map by count', () => {
    // CREATED targets: lop (created by 3), ripple (by 1) → ranked [lop, ripple].
    const ranked = arr(
      run(
        traversal(
          V(),
          out('CREATED'),
          groupCount().by('name'),
          order(Scope.local).by(Column.values, Order.desc),
          select(Column.keys),
        ),
        g,
      ),
    );

    expect(ranked).toEqual([['lop', 'ripple']]);
  });

  test('order(local).by(keys, desc).select(values) sorts on the entry key', () => {
    // Keys sorted descending (ripple > lop lexically) → their values [1, 3].
    const byKeys = arr(
      run(
        traversal(
          V(),
          out('CREATED'),
          groupCount().by('name'),
          order(Scope.local).by(Column.keys, Order.desc),
          select(Column.values),
        ),
        g,
      ),
    );

    expect(byKeys).toEqual([[1, 3]]);
  });

  test('select(Column.values) on the default (by-value) local order', () => {
    // No Column by → sort a Map by value; `by(values)` is the explicit default.
    const asc = arr(
      run(
        traversal(
          V(),
          out('CREATED'),
          groupCount().by('name'),
          order(Scope.local).by(Column.values, Order.asc),
          select(Column.values),
        ),
        g,
      ),
    );

    expect(asc).toEqual([[1, 3]]);
  });
});
