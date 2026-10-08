import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 231 passed `nodeVar` as the predicate's own variable at `detectNodeProjection`'s clause
// `WHERE`, so `directEqProps` (items 224, 230) can lift its equality conjuncts and read the element
// directly instead of through the binding. The spelling probe's oldest standing gap closed with it:
// `a filtered node projection (item 204)` went from 6.70 vs 3.81 ms to 3.91 vs 3.75.
//
// Item 230's tests cover the same lifting on the COUNT path. These are the PROJECTION path's own,
// and they assert the ROWS rather than a count on purpose: a count cannot see which rows survived,
// so a predicate that selects the wrong elements is invisible to it — the failure mode recorded for
// the `examples/` probes, which passed while the engine returned wrong rows three times.
const graph = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, j: 2, s: 'a', tags: [1, 2] } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: 1, j: 9, s: 'b', tags: [1, 2] } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { k: 5, j: 2, s: 'c' } });
  g.addVertex({ id: 'd', labels: ['P'], properties: { k: null, j: 2, s: 'd' } });
  g.addVertex({ id: 'e', labels: ['P'], properties: { k: 1, s: 'e' } });

  return g;
};

/** The projected `s` values, SORTED — row order is unspecified, membership is not. */
const names = (text: string, params: Record<string, unknown> = {}): unknown[] =>
  (query(graph(), text, params) as { s: unknown }[]).map((r) => r.s).sort();

describe('a filtered projection selects the same rows as the inline spelling', () => {
  test('one equality picks exactly the matching elements', () => {
    expect(names('MATCH (n:P) WHERE n.k = 1 RETURN n.s AS s')).toEqual(['a', 'b', 'e']);
    expect(names('MATCH (n:P {k: 1}) RETURN n.s AS s')).toEqual(['a', 'b', 'e']);
    expect(names('MATCH (n:P WHERE n.k = 1) RETURN n.s AS s')).toEqual(['a', 'b', 'e']);
  });

  test('an AND of two equalities picks exactly one', () => {
    expect(names('MATCH (n:P) WHERE n.k = 1 AND n.j = 2 RETURN n.s AS s')).toEqual(['a']);
    expect(names('MATCH (n:P {k: 1, j: 2}) RETURN n.s AS s')).toEqual(['a']);
  });

  test('either operand order is the same question', () => {
    expect(names('MATCH (n:P) WHERE 1 = n.k RETURN n.s AS s')).toEqual(['a', 'b', 'e']);
    expect(names('MATCH (n:P) WHERE 1 = n.k AND 2 = n.j RETURN n.s AS s')).toEqual(['a']);
  });

  test('a MISSING property is not a match', () => {
    // `e` has no `j`, and must not be selected by `j = 2`.
    expect(names('MATCH (n:P) WHERE n.j = 2 RETURN n.s AS s')).toEqual(['a', 'c', 'd']);
  });

  test('a STORED null is not matched by a value, nor by a null literal', () => {
    expect(names('MATCH (n:P) WHERE n.k = null RETURN n.s AS s')).toEqual([]);
    // The inline spelling of the same thing is an IS NULL test — settled, different behaviour.
    // Only `d` holds a stored null; every other vertex here HAS a `k`, so this fixture does not
    // distinguish a stored null from an ABSENT key. That distinction is deliberately left out —
    // it is what makes a null value unliftable in the first place, it is settled behaviour rather
    // than this item's, and giving it a case here would duplicate item 230's.
    expect(names('MATCH (n:P {k: null}) RETURN n.s AS s')).toEqual(['d']);
  });

  test('a LIST-valued literal compares structurally', () => {
    expect(names('MATCH (n:P) WHERE n.tags = [1, 2] RETURN n.s AS s')).toEqual(['a', 'b']);
    expect(names('MATCH (n:P) WHERE n.tags = [1, 2] AND n.j = 9 RETURN n.s AS s')).toEqual(['b']);
  });

  test('a PARAM conjunct does not lift and still selects correctly', () => {
    expect(names('MATCH (n:P) WHERE n.k = $k RETURN n.s AS s', { k: 1 })).toEqual(['a', 'b', 'e']);
    expect(names('MATCH (n:P) WHERE n.k = 1 AND n.j = $j RETURN n.s AS s', { j: 9 })).toEqual([
      'b',
    ]);
    // A param resolving to NULL matches nothing — the reason params stay with the general
    // evaluator rather than lifting into a `structuralEq` check.
    expect(names('MATCH (n:P) WHERE n.k = $k RETURN n.s AS s', { k: null })).toEqual([]);
  });

  test('projecting SEVERAL columns keeps each row intact', () => {
    // A single projected column cannot see a predicate that selects the wrong element while
    // happening to produce the right multiset of values. Two columns from the same element can.
    const rows = query(
      graph(),
      'MATCH (n:P) WHERE n.k = 1 AND n.j = 9 RETURN n.s AS s, n.j AS j, n.k AS k',
    ) as { s: unknown; j: unknown; k: unknown }[];

    expect(rows).toEqual([{ s: 'b', j: 9, k: 1 }]);
  });

  test('a chain the rule declines is unchanged', () => {
    expect(names('MATCH (n:P) WHERE n.k = 1 AND n.j > 2 RETURN n.s AS s')).toEqual(['b']);
    expect(names('MATCH (n:P) WHERE n.k = 1 AND n.j IS NOT NULL RETURN n.s AS s')).toEqual([
      'a',
      'b',
    ]);
  });

  test('a SUBQUERY-bearing predicate keeps its own gate and answers the same', () => {
    // `nodeWhereOf`'s other branch, which deliberately does NOT get `ownVar`: it routes through
    // `gatePredicate` so a cheap conjunct is ordered ahead of the subquery, and
    // `compilePredicate` knows nothing about subqueries anyway.
    const g = graph();

    g.addVertex({ id: 'q', labels: ['Q'], properties: { k: 1 } });

    expect(
      query(g, 'MATCH (n:P) WHERE n.k = 1 AND EXISTS { MATCH (m:Q) } RETURN n.s AS s')
        .map((r) => r.s)
        .sort(),
    ).toEqual(['a', 'b', 'e']);
  });
});
