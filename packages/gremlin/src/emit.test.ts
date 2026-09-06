import { describe, expect, test } from 'bun:test';

import {
  count,
  fold,
  max,
  mean,
  min,
  planToGremlin,
  Scope,
  sum,
  traversal,
  V,
  values,
} from './index.js';

// Regression: the reducing aggregations carry an optional `Scope.local`, and the emitter
// must render it. Emitting a bare `count()` for `count(Scope.local)` silently turns a
// local (per-list) aggregation into a global one on the round-trip through text — a silent
// wrong answer on the native engine, which only ever sees the emitted text.
describe('planToGremlin: local-scope aggregations keep their scope', () => {
  const cases: [string, ReturnType<typeof traversal>, string][] = [
    ['count local', traversal(V(), values('age'), fold(), count(Scope.local)), 'count(local)'],
    ['sum local', traversal(V(), values('age'), fold(), sum(Scope.local)), 'sum(local)'],
    ['min local', traversal(V(), values('age'), fold(), min(Scope.local)), 'min(local)'],
    ['max local', traversal(V(), values('age'), fold(), max(Scope.local)), 'max(local)'],
    ['mean local', traversal(V(), values('age'), fold(), mean(Scope.local)), 'mean(local)'],
  ];

  for (const [name, plan, expected] of cases) {
    test(name, () => {
      expect(planToGremlin(plan)).toContain(expected);
    });
  }

  test('global aggregations stay bare (no scope argument)', () => {
    expect(planToGremlin(traversal(V(), values('age'), count()))).toEndWith('count()');
    expect(planToGremlin(traversal(V(), values('age'), sum()))).toEndWith('sum()');
  });
});
