// `MATCH … FOR x IN [a, b, c] RETURN count(*)` is the base count TIMES the list length — a
// constant `FOR` multiplies every incoming row. The general path builds all of them: 600,000
// rows materialized to count them, 175.1ms at 200,000 vertices against native's 3.4 (item 515).
//
// The rung asks `detectCountShortcut` for the base and multiplies, so every shape the ladder
// already counts is covered. This file pins the arithmetic and the refusals.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1, tags: [1, 2] } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2, tags: [3] } });

  g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });
  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: {} });
  g.addEdge({ id: 'ba', from: b, to: a, labels: ['T'], properties: {} });

  return g;
};

const g = build();
const c = (q: string): unknown => (query(g, q)[0] as Record<string, unknown>)?.c;

describe('count(*) over a constant FOR (item 515)', () => {
  test('the base count times the list length', () => {
    // Two `:P` nodes x three elements.
    expect(c('MATCH (n:P) FOR x IN [1, 2, 3] RETURN count(*) AS c')).toBe(6);
    expect(c('MATCH (n:P) FOR x IN [1] RETURN count(*) AS c')).toBe(2);
    // An EMPTY list yields no rows at all, for any base.
    expect(c('MATCH (n:P) FOR x IN [] RETURN count(*) AS c')).toBe(0);
  });

  test('every base the ladder counts is multiplied', () => {
    // A hop: two T edges x two elements.
    expect(c('MATCH (:P)-[:T]->(y) FOR x IN [1, 2] RETURN count(*) AS c')).toBe(4);
    // A node with an inline constraint.
    expect(c('MATCH (n:P {k: 1}) FOR x IN [1, 2] RETURN count(*) AS c')).toBe(2);
    // A label that matches nothing: zero times anything is zero.
    expect(c('MATCH (n:ZZZ) FOR x IN [1, 2, 3] RETURN count(*) AS c')).toBe(0);
  });

  test('WITH ORDINALITY binds a second name and does not change the count', () => {
    expect(c('MATCH (n:P) FOR x IN [1, 2, 3] WITH ORDINALITY o RETURN count(*) AS c')).toBe(6);
  });

  test('SKIP and LIMIT page the one row', () => {
    expect(c('MATCH (n:P) FOR x IN [1, 2, 3] RETURN count(*) AS c LIMIT 1')).toBe(6);
    expect(query(g, 'MATCH (n:P) FOR x IN [1, 2, 3] RETURN count(*) AS c LIMIT 0')).toEqual([]);
    expect(query(g, 'MATCH (n:P) FOR x IN [1, 2, 3] RETURN count(*) AS c SKIP 1')).toEqual([]);
  });

  // The refusals, each answered by the general path.
  test('a PER-ROW list declines and counts correctly', () => {
    // `a` has two tags and `b` one, so Σ length is 3 — not a multiple of anything.
    expect(c('MATCH (n:P) FOR t IN n.tags RETURN count(*) AS c')).toBe(3);
  });

  test('a list with a NON-LITERAL element declines', () => {
    // The length is still 2, but an element that faults must fault, and that happens on the
    // general path — so the whole list has to be inert for the arithmetic to be used.
    expect(c('MATCH (n:P) FOR x IN [1, n.k] RETURN count(*) AS c')).toBe(4);
  });

  test('a FAULTING element still faults — the length alone is not enough', () => {
    // The length is 2 either way, so `[1, n.k]` cannot tell the literal check apart: only an
    // element that RAISES can. With the check, the list is evaluated per row on the general
    // path and the query throws; without it, the arithmetic would answer 4. Item 512's
    // `cheapPureExpr` survivor had exactly this shape.
    expect(() => query(g, 'MATCH (n:P) FOR x IN [1, 1 / 0] RETURN count(*) AS c')).toThrow();
    expect(() =>
      query(g, "MATCH (n:P) FOR x IN [1, CAST('abc' AS INTEGER)] RETURN count(*) AS c"),
    ).toThrow();
  });

  test('reading the FOR variable is not count(*)', () => {
    // `count(x)` counts non-null values, which is a different question from the row count.
    expect(c('MATCH (n:P) FOR x IN [1, 2, 3] RETURN count(x) AS c')).toBe(6);
    expect(c('MATCH (n:P) FOR x IN [1, null, 3] RETURN count(x) AS c')).toBe(4);
    // And a grouped count is per key, not one row.
    expect(query(g, 'MATCH (n:P) FOR x IN [1, 2] RETURN x AS k, count(*) AS c').length).toBe(2);
  });

  test('TWO FOR clauses decline, and the product is still right', () => {
    expect(c('MATCH (n:P) FOR x IN [1, 2] FOR y IN [1, 2, 3] RETURN count(*) AS c')).toBe(12);
  });
});
