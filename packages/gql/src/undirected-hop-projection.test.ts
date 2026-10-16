import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 480: an UNDIRECTED hop projection walks each start vertex's out-bucket and then its
// in-bucket, which is the order `expand` emits for `direction: 'both'` — including its skip of
// the self-loop in the in-pass, since a loop is indexed under both maps.
//
// 754 -> 357-395 ns a row at 200,000 nodes / 1,000,000 edges. The comparison that matters is
// against the START-DRIVEN directed walk (321-330 ns a row), not the far-driven one: an
// undirected walk cannot be far-driven.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], props: Record<string, unknown>) =>
    g.addVertex({ id, labels, properties: props });

  const a = v('a', ['P'], { k: 'a' });
  const b = v('b', ['P'], { k: 'b' });
  const x = v('x', ['F'], { k: 'x' });
  const y = v('y', ['G'], { k: 'y' });

  // a: one out (x), one in (b). b: one out (a), one in (nothing). Plus a `G` far end so the
  // far label excludes something.
  g.addEdge({ id: 'e1', from: a, to: x, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e2', from: b, to: a, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e3', from: a, to: y, labels: ['T'], properties: {} });
  g.addEdge({ id: 'e4', from: a, to: x, labels: ['S'], properties: {} }); // another TYPE

  return g;
};

describe('an undirected hop projection (item 480)', () => {
  test('ROW ORDER matches the general path: per start vertex, out-steps then in-steps', () => {
    const g = build();

    // `SKIP 0` declines every hop rung while preserving order, so it is the order-faithful
    // oracle — `ORDER BY` would compare sorted rows and hide exactly what this test is about.
    expect(query(g, 'MATCH (:P)-[:T]-(z) RETURN z.k AS k')).toEqual(
      query(g, 'MATCH (:P)-[:T]-(z) RETURN z.k AS k SKIP 0'),
    );
    // a's out-steps (x, y), then a's in-step (b); then b's out-step (a).
    expect(query(g, 'MATCH (:P)-[:T]-(z) RETURN z.k AS k')).toEqual([
      { k: 'x' },
      { k: 'y' },
      { k: 'b' },
      { k: 'a' },
    ]);
  });

  test('a SELF-LOOP is emitted ONCE, as the general path emits it', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a' } });
    const o = g.addVertex({ id: 'o', labels: ['P'], properties: { k: 'o' } });

    g.addEdge({ id: 'loop', from: a, to: a, labels: ['T'], properties: {} });
    g.addEdge({ id: 'plain', from: a, to: o, labels: ['T'], properties: {} });

    // The loop is indexed under BOTH adjacency maps; the in-pass must skip it. A duplicate row
    // here is the projection twin of the wrong answer item 478 shipped a decline for.
    expect(query(g, 'MATCH (:P)-[:T]-(z) RETURN z.k AS k')).toEqual(
      query(g, 'MATCH (:P)-[:T]-(z) RETURN z.k AS k SKIP 0'),
    );
    expect(query(g, 'MATCH (:P)-[:T]-(z) RETURN z.k AS k')).toEqual([
      { k: 'a' },
      { k: 'o' },
      { k: 'a' },
    ]);
  });

  test('the far LABEL and the edge TYPE both still select', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[:T]-(z:F) RETURN z.k AS k')).toEqual([{ k: 'x' }]);
    expect(query(g, 'MATCH (:P)-[:S]-(z) RETURN z.k AS k')).toEqual([{ k: 'x' }]);
  });

  test('a START LABEL that excludes still excludes', () => {
    const g = build();

    // Only `a` and `b` are `P`; starting from `F` finds just x's single incident T edge.
    expect(query(g, 'MATCH (:F)-[:T]-(z) RETURN z.k AS k')).toEqual([{ k: 'a' }]);
  });

  test('the shapes this rung does NOT take still answer', () => {
    const g = build();

    // A carried WHERE, a far predicate, an edge variable and a start-reading projection each
    // keep the general path — the walk binds only the far end.
    expect(query(g, "MATCH (:P)-[:T]-(z) WHERE z.k <> 'y' RETURN z.k AS k").length).toBe(3);
    expect(query(g, "MATCH (:P)-[:T]-(z {k: 'x'}) RETURN z.k AS k")).toEqual([{ k: 'x' }]);
    expect(query(g, 'MATCH (:P)-[r:T]-(z) RETURN r.id AS r').length).toBe(4);
    expect(query(g, 'MATCH (s:P)-[:T]-(z) RETURN s.k AS s, z.k AS k').length).toBe(4);
  });

  test('DISTINCT over an undirected hop dedupes by value', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[:T]-(z) RETURN DISTINCT z.k AS k').length).toBe(4);
  });
});
