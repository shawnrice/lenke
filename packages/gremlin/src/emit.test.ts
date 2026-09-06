import { describe, expect, test } from 'bun:test';

import {
  addE,
  addV,
  as_,
  count,
  drop,
  fold,
  has,
  id,
  max,
  mean,
  min,
  out,
  planToGremlin,
  Scope,
  sum,
  traversal,
  tree,
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

// Write- and tree-family steps must round-trip through the emitter (the native engine
// re-parses this text), so `planToGremlin` renders them instead of throwing "unsupported
// step" — which previously blinded the differential fuzzer/conformance to them entirely.
describe('planToGremlin: write / tree family steps', () => {
  test('addV emits with and without a label', () => {
    expect(planToGremlin(traversal(addV('T')))).toBe("g.addV('T')");
    expect(planToGremlin(traversal(addV('T'), id()))).toBe("g.addV('T').id()");
    expect(planToGremlin(traversal(addV()))).toBe('g.addV()');
  });

  test('drop emits as a bare terminal step', () => {
    expect(planToGremlin(traversal(V(), has('name', 'marko'), drop()))).toEndWith('drop()');
  });

  test('tree emits, with an optional by-key', () => {
    expect(planToGremlin(traversal(V(), tree()))).toBe('g.V().tree()');
    expect(planToGremlin(traversal(V(), out(), tree().by('name')))).toBe(
      "g.V().out().tree().by('name')",
    );
  });

  test('addE emits its label and from/to endpoints', () => {
    // current-traverser FROM (a preceding V(...)) + a V(id) TO.
    expect(planToGremlin(traversal(V('1'), addE('KNOWS').to(V('6'))))).toBe(
      "g.V('1').addE('KNOWS').to(V('6'))",
    );
    // explicit V(id) FROM and TO (source form).
    expect(planToGremlin(traversal(addE('KNOWS').from(V('1')).to(V('6'))))).toBe(
      "g.addE('KNOWS').from(V('1')).to(V('6'))",
    );
    // a tag endpoint (as()-recall) emits the bare tag — a TS superset native rejects.
    expect(
      planToGremlin(traversal(V('1'), as_('s'), out('KNOWS'), addE('M').from('s').to(V('6')))),
    ).toBe("g.V('1').as('s').out('KNOWS').addE('M').from('s').to(V('6'))");
  });
});
