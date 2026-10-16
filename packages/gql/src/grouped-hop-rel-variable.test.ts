import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 488: an unread rel variable in the grouped hop TALLY and the grouped hop AGGREGATE. Both
// walks bind only nodes, so a name nothing reads is inert — refusing it cost 2.3x and 2.1x
// (761 against 328, 805 against 392 at 200,000 nodes / 1,000,000 edges).
//
// `relVarInert` also refuses a name that COLLIDES with an end, which is this item's precondition
// rather than its discovery: item 487 shipped exactly that class of bug one tick earlier.
const build = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 'a', n: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 'b', n: 2 } });

  g.addEdge({ id: 'ab', from: a, to: b, labels: ['T'], properties: { w: 1 } });
  g.addEdge({ id: 'ba', from: b, to: a, labels: ['T'], properties: { w: 2 } });

  return g;
};

describe('an unread rel variable in a grouped hop (item 488)', () => {
  test('the TALLY answers as it does without the name, in order', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN b.k AS k, count(*) AS c')).toEqual(
      query(g, 'MATCH (:P)-[:T]->(b) RETURN b.k AS k, count(*) AS c'),
    );
    expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN b.k AS k, count(*) AS c')).toEqual([
      { k: 'b', c: 1 },
      { k: 'a', c: 1 },
    ]);
  });

  test('the AGGREGATE answers as it does without the name', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN b.k AS k, max(b.n) AS m')).toEqual(
      query(g, 'MATCH (:P)-[:T]->(b) RETURN b.k AS k, max(b.n) AS m'),
    );
    expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN b.k AS k, max(b.n) AS m')).toEqual([
      { k: 'b', m: 2 },
      { k: 'a', m: 1 },
    ]);
  });

  test('a name COLLIDING with an end matches nothing and must not be ignored', () => {
    const g = build();

    // `(x:P)-[x:T]->(b)` binds the start and the rel to one name, which matches nothing. A
    // fast path that merely ignored the rel name would return rows — the wrong answer item 487
    // shipped in the product one tick ago, written down here BEFORE the widening rather than
    // after it.
    expect(query(g, 'MATCH (x:P)-[x:T]->(b) RETURN b.k AS k, count(*) AS c')).toEqual([]);
    expect(query(g, 'MATCH (x:P)-[x:T]->(b) RETURN b.k AS k, max(b.n) AS m')).toEqual([]);
    // The far end's name too.
    expect(query(g, 'MATCH (:P)-[y:T]->(y) RETURN y.k AS k, count(*) AS c')).toEqual([]);
  });

  test('anything that READS the edge declines, and still answers', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[r:T]->(b) WHERE r.w > 1 RETURN b.k AS k, count(*) AS c')).toEqual([
      { k: 'a', c: 1 },
    ]);
    expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN r.w AS k, count(*) AS c')).toEqual([
      { k: 1, c: 1 },
      { k: 2, c: 1 },
    ]);
    expect(query(g, 'MATCH (a:P)-[r:T]->(b) RETURN b.k AS k, max(r.w) AS m')).toEqual([
      { k: 'b', m: 1 },
      { k: 'a', m: 2 },
    ]);
  });

  test('an ORDER BY reading the edge declines', () => {
    const g = build();

    // ORDER BY is part of the projection, so `relVarInert` checks it: a sort on `r.w` would be
    // computed from an edge the walk never binds. `ORDER BY k` is the admitted twin, so the
    // pair shows the check is about the EDGE and not about sorting.
    expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN b.k AS k, count(*) AS c ORDER BY k')).toEqual([
      { k: 'a', c: 1 },
      { k: 'b', c: 1 },
    ]);
    expect(query(g, 'MATCH (:P)-[r:T]->(b) RETURN b.k AS k, count(*) AS c ORDER BY r.w')).toEqual([
      { k: 'b', c: 1 },
      { k: 'a', c: 1 },
    ]);
  });

  test('an inline rel CONSTRAINT still declines', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[r:T {w: 1}]->(b) RETURN b.k AS k, count(*) AS c')).toEqual([
      { k: 'b', c: 1 },
    ]);
  });
});
