// `MATCH (n:L) FOR t IN n.tags RETURN count(*)` is Σ the list lengths — a PER-ROW list needs the
// anchors walked, but not a row per element. Item 515 took the constant list; this one cost
// 191.1ms at 200,000 vertices against the native engine's 15.8, because the general path
// materialized 600,000 rows to count them (item 518).
//
// ISO's unwind semantics ARE the arithmetic, and every case is a different number — which is
// what this file pins. The oracle throughout is `count(*) + 0`, an aggregate EXPRESSION that
// declines the rung and is answered by the general path.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

const build = (): Graph => {
  const g = new Graph();

  // Three tags, one tag, an EMPTY list, a non-list scalar, and no property at all.
  g.addVertex({ id: 'a', labels: ['P'], properties: { tags: [1, 2, 3] } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { tags: [9] } });
  g.addVertex({ id: 'c', labels: ['P'], properties: { tags: [] } });
  g.addVertex({ id: 'd', labels: ['P'], properties: { tags: 'solo' } });
  g.addVertex({ id: 'e', labels: ['P'], properties: {} });
  g.addVertex({ id: 'q', labels: ['Q'], properties: { tags: [1, 2, 3, 4] } });

  return g;
};

const g = build();
const both = (q: string, want: number) => {
  const c = (text: string): unknown => (query(g, text)[0] as Record<string, unknown>)?.c;

  expect(c(q)).toBe(want);
  // `count(*) + 0` is an aggregate expression, so the rung declines and the general path answers.
  expect(c(q.replace('count(*)', 'count(*) + 0'))).toBe(want);
};

describe('count(*) over a per-row list (item 518)', () => {
  test('each unwind case contributes its own number', () => {
    // 3 + 1 + 0 (empty) + 1 (a scalar unwinds as one element) + 0 (missing) = 5.
    both('MATCH (n:P) FOR t IN n.tags RETURN count(*) AS c', 5);
    // The other label, on its own: one node with four tags.
    both('MATCH (n:Q) FOR t IN n.tags RETURN count(*) AS c', 4);
    // Unlabelled: every vertex, so 5 + 4.
    both('MATCH (n) FOR t IN n.tags RETURN count(*) AS c', 9);
  });

  test('a key nothing has is zero, not one per row', () => {
    both('MATCH (n:P) FOR t IN n.nope RETURN count(*) AS c', 0);
  });

  test('SKIP and LIMIT page the one row', () => {
    expect(
      query<{ c: number }>(g, 'MATCH (n:P) FOR t IN n.tags RETURN count(*) AS c LIMIT 1')[0]?.c,
    ).toBe(5);
    expect(query(g, 'MATCH (n:P) FOR t IN n.tags RETURN count(*) AS c LIMIT 0')).toEqual([]);
    expect(query(g, 'MATCH (n:P) FOR t IN n.tags RETURN count(*) AS c SKIP 1')).toEqual([]);
  });

  // The refusals. Each is answered by the general path, and each answer is checked.
  test('a CONSTRAINED anchor declines', () => {
    expect(
      query<{ c: number }>(g, "MATCH (n:P {tags: 'solo'}) FOR t IN n.tags RETURN count(*) AS c")[0]
        ?.c,
    ).toBe(1);
  });

  test('a list read from something OTHER than the anchor declines', () => {
    // `m` is a second pattern, so the walk this rung does would be the wrong one.
    expect(
      query<{ c: number }>(g, 'MATCH (n:P) MATCH (m:Q) FOR t IN m.tags RETURN count(*) AS c')[0]?.c,
    ).toBe(20);
  });

  test('a hop anchor declines, and still counts', () => {
    const h = new Graph();
    const x = h.addVertex({ id: 'x', labels: ['P'], properties: { tags: [1, 2] } });
    const y = h.addVertex({ id: 'y', labels: ['P'], properties: { tags: [1, 2, 3] } });

    h.addEdge({ id: 'xy', from: x, to: y, labels: ['T'], properties: {} });
    // One edge, and `y` has three tags.
    expect(
      query<{ c: number }>(h, 'MATCH (a:P)-[:T]->(b) FOR t IN b.tags RETURN count(*) AS c')[0]?.c,
    ).toBe(3);
  });
});
