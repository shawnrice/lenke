// Item 638. A hop PROJECTION now carries the rel's inline constraint instead of refusing the
// whole route (`closedRelPred`), closing 4.34x on the properties spelling and 4.59x on the
// inline `WHERE`. Item 637 did the same for the one-hop TALLY; the projection ladder refused
// both spellings independently, so neither fix generalized to the other.
//
// The shapes that matter are the ones where dropping the constraint is SILENT — the walks
// that cannot apply it must DECLINE, and a decline returns the right answer slowly while a
// drop returns a wrong one quickly. Every count below is hand-checkable against the fixture.
import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

let g: Graph;

const rows = (q: string, params: Record<string, unknown> = {}): unknown[] => [
  ...(query(g, q, params) as Iterable<unknown>),
];

const xs = (q: string, params: Record<string, unknown> = {}): unknown[] =>
  (rows(q, params) as { x: unknown }[]).map((r) => r.x).sort();

beforeAll(() => {
  g = new Graph();

  const v = Array.from({ length: 4 }, (_, i) =>
    g.addVertex({ id: `a${i}`, labels: ['P'], properties: { k: i } }),
  );

  // e0 a0->a1 w=1 | e1 a1->a2 w=2 | e2 a2->a3 w=2
  // e3 a3->a0 w=null (STORED null) | e4 a0->a2 (key ABSENT)
  g.addEdge({ id: 'e0', from: v[0], to: v[1], labels: ['E'], properties: { w: 1 } });
  g.addEdge({ id: 'e1', from: v[1], to: v[2], labels: ['E'], properties: { w: 2 } });
  g.addEdge({ id: 'e2', from: v[2], to: v[3], labels: ['E'], properties: { w: 2 } });
  g.addEdge({ id: 'e3', from: v[3], to: v[0], labels: ['E'], properties: { w: null } });
  g.addEdge({ id: 'e4', from: v[0], to: v[2], labels: ['E'], properties: {} });
});

describe('the projected spellings of one question agree', () => {
  test('projecting the EDGE', () => {
    expect(xs('MATCH (a:P)-[r:E]->(b) WHERE r.w = 2 RETURN r.w AS x')).toEqual([2, 2]);
    expect(xs('MATCH (a:P)-[r:E {w: 2}]->(b) RETURN r.w AS x')).toEqual([2, 2]);
    expect(xs('MATCH (a:P)-[r:E WHERE r.w = 2]->(b) RETURN r.w AS x')).toEqual([2, 2]);
  });

  test('projecting the START, so nothing in the projection reads the edge', () => {
    // e1 starts at a1, e2 at a2.
    expect(xs('MATCH (a:P)-[r:E]->(b) WHERE r.w = 2 RETURN a.k AS x')).toEqual([1, 2]);
    expect(xs('MATCH (a:P)-[r:E {w: 2}]->(b) RETURN a.k AS x')).toEqual([1, 2]);
    expect(xs('MATCH (a:P)-[r:E WHERE r.w = 2]->(b) RETURN a.k AS x')).toEqual([1, 2]);
  });

  test('projecting the FAR end', () => {
    // e1 ends at a2, e2 at a3.
    expect(xs('MATCH (a:P)-[r:E {w: 2}]->(b) RETURN b.k AS x')).toEqual([2, 3]);
  });

  test('a $param value', () => {
    expect(xs('MATCH (a:P)-[r:E {w: $w}]->(b) RETURN a.k AS x', { w: 2 })).toEqual([1, 2]);
  });
});

describe('IS-NULL semantics survive the projection route too', () => {
  test('inline {w: null} projects the stored null AND the absent key', () => {
    // e3 (stored null) starts at a3; e4 (absent key) starts at a0.
    expect(xs('MATCH (a:P)-[r:E {w: null}]->(b) RETURN a.k AS x')).toEqual([0, 3]);
  });

  test('a clause r.w = null projects nothing', () => {
    expect(xs('MATCH (a:P)-[r:E]->(b) WHERE r.w = null RETURN a.k AS x')).toEqual([]);
  });
});

describe('the walks that cannot apply the constraint DECLINE rather than drop it', () => {
  test('UNDIRECTED: no rel-bound form, so the general path must answer', () => {
    // Each matching edge is met from both ends: e1 from a1 and a2, e2 from a2 and a3.
    expect(xs('MATCH (a:P)-[r:E {w: 2}]-(b) RETURN a.k AS x')).toEqual([1, 2, 2, 3]);
  });

  test('UNDIRECTED projecting only the FAR end, which is what reaches the walk', () => {
    // The row above projects `a.k`, so `needsStart` is true and `undirectedHopWalk` declines
    // on its own — mutation showed the decline SURVIVING against it, INERT rather than
    // untested. With only `b.k` projected the walk is actually reached, so dropping the
    // decline would run it WITHOUT the constraint and return all five edges from both ends.
    //
    // e1 (a1->a2) seen from a1 gives b=a2 and from a2 gives b=a1; e2 (a2->a3) gives a3 and a2.
    expect(xs('MATCH (a:P)-[r:E {w: 2}]-(b) RETURN b.k AS x')).toEqual([1, 2, 2, 3]);
  });

  test('a QUANTIFIED rel is a walk, not one hop', () => {
    expect(rows('MATCH (a:P)-[r:E {w: 2}]->{1,2}(b) RETURN a.k AS x')).toHaveLength(3);
  });

  test('a CORRELATED inline value is not closed', () => {
    // Only a2 (k=2) has an out-edge whose `w` equals its own `k`: e2.
    expect(xs('MATCH (a:P)-[r:E {w: a.k}]->(b) RETURN a.k AS x')).toEqual([2]);
  });

  // PROJECTING THE FAR END, which is what makes these two discriminating. The versions above
  // project `a.k`, so the start is bound anyway and a wrongly-admitted correlation still
  // evaluates correctly — mutation showed both `closedRelPred` free-variable checks SURVIVING
  // against them. With only `b.k` projected the start need not be bound, so admitting the
  // correlation reads an unbound `a` and the answer moves.
  test('a correlated inline value, with the start NOT otherwise needed', () => {
    // e2 is a2->a3, so the far end is a3.
    expect(xs('MATCH (a:P)-[r:E {w: a.k}]->(b) RETURN b.k AS x')).toEqual([3]);
  });

  test('a correlated inline WHERE, with the start NOT otherwise needed', () => {
    expect(xs('MATCH (a:P)-[r:E WHERE r.w = a.k]->(b) RETURN b.k AS x')).toEqual([3]);
  });

  test('an UNFILTERED hop is unaffected — every edge, including the null-valued ones', () => {
    expect(rows('MATCH (a:P)-[r:E]->(b) RETURN a.k AS x')).toHaveLength(5);
  });
});

describe('the rel constraint composes with the other carried ones', () => {
  test('beside a FAR node inline constraint (closedFarPred, the precedent)', () => {
    // `{w: 2}` keeps e1 (-> a2) and e2 (-> a3); the far filter keeps only e1.
    expect(xs('MATCH (a:P)-[r:E {w: 2}]->(b:P {k: 2}) RETURN a.k AS x')).toEqual([1]);
  });

  test('beside a clause WHERE on the START', () => {
    expect(xs('MATCH (a:P)-[r:E {w: 2}]->(b) WHERE a.k = 1 RETURN a.k AS x')).toEqual([1]);
  });

  test('beside a clause WHERE that DISAGREES on the rel, keeping neither alone', () => {
    // `{w: 2}` keeps e1, e2; `r.w = 1` keeps e0. The conjunction is EMPTY — a route that
    // dropped either predicate would return one row or two.
    expect(xs('MATCH (a:P)-[r:E {w: 2}]->(b) WHERE r.w = 1 RETURN a.k AS x')).toEqual([]);
  });

  test('an inline rel WHERE beside a clause WHERE on the far end', () => {
    expect(xs('MATCH (a:P)-[r:E WHERE r.w = 2]->(b) WHERE b.k = 3 RETURN a.k AS x')).toEqual([2]);
  });
});
