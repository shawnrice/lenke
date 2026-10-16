import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 476: a GROUPED aggregate over a hop that the `count(*)` tally cannot take. At 200,000
// nodes over 1,000,000 edges: `b.age AS k, max(b.age)` 759 -> 358 ms, `b.age AS k, count(*),
// max(b.age)` 895 -> 405, with the tally's own shape flat at ~333.
//
// Group order is FIRST-SEEN and observable, so every comparison below is on the row ARRAY in
// order — the rule `grouped-hop.test.ts`'s header records, for the reason it records it: a walk
// can count every edge correctly and still emit the groups in the wrong order.
const build = (): Graph => {
  const g = new Graph();
  const v = (id: string, labels: string[], props: Record<string, unknown>) =>
    g.addVertex({ id, labels, properties: props });

  const a = v('a', ['P'], { k: 'ka', n: 1 });
  const b = v('b', ['P'], { k: 'kb', n: 2 });
  const q = v('q', ['Q'], { k: 'kq', n: 3 }); // NOT a P: the start label must exclude it
  const y = v('y', ['F'], { k: 'KY', n: 10 });
  const z = v('z', ['F'], { k: 'KZ', n: 20 });
  const w = v('w', ['F'], { k: 'KY', n: 40 }); // same key as `y`, so a group holds two edges

  v('lonely', ['F'], { k: 'KL' }); // no edges, and no `n`
  // A far end with NO `n`: `count(x.n)` must skip it where `count(*)` counts it, which is what
  // makes the nullish-skip mutant fail. Without such an edge that mutant SURVIVES.
  const nn = v('nn', ['F'], { k: 'KN' });

  // Inserted out of order on purpose: b's edge first, so first-seen order is not the vertex
  // insertion order.
  g.addEdge({ from: b, to: z, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: y, labels: ['T'], properties: {} });
  g.addEdge({ from: a, to: w, labels: ['T'], properties: {} });
  g.addEdge({ from: b, to: y, labels: ['T'], properties: {} });
  g.addEdge({ from: q, to: z, labels: ['T'], properties: {} }); // excluded by `:P`
  g.addEdge({ from: b, to: nn, labels: ['T'], properties: {} });

  return g;
};

describe('a grouped hop aggregate beyond the count tally (item 476)', () => {
  test('key and max on the far end, agreeing with the general path IN ORDER', () => {
    const g = build();
    const fast = query<{ k: string; m: number | null }>(
      g,
      'MATCH (:P)-[:T]->(x) RETURN x.k AS k, max(x.n) AS m',
    );
    // `ORDER BY` declines this rung, so the general path answers the same question. Sorting the
    // fast rows by the same key makes the two comparable without hiding a row difference.
    const slow = query<{ k: string; m: number | null }>(
      g,
      'MATCH (:P)-[:T]->(x) RETURN x.k AS k, max(x.n) AS m ORDER BY k',
    );

    expect([...fast].sort((p, r) => p.k.localeCompare(r.k))).toEqual(slow);
    // KY is first: the walk's OUTER loop is over start vertices (a, then b), so a's two edges
    // come before b's whatever order the edges were inserted in. I expected the insertion order
    // and the test said otherwise — the oracle above is what settles it, not my reading.
    expect(fast).toEqual([
      { k: 'KY', m: 40 },
      { k: 'KZ', m: 20 },
      { k: 'KN', m: null },
    ]);
  });

  test('count(*) beside max, and count of a sometimes-absent property', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[:T]->(x) RETURN x.k AS k, count(*) AS c, max(x.n) AS m')).toEqual([
      { k: 'KY', c: 3, m: 40 },
      { k: 'KZ', c: 1, m: 20 },
      { k: 'KN', c: 1, m: null },
    ]);
  });

  test('the START LABEL excludes, so the Q-sourced edge is not counted', () => {
    const g = build();

    // Without the label the `q -> z` edge would make KZ's count 2. `:P` is not vacuous here.
    expect(query(g, 'MATCH (:P)-[:T]->(x) RETURN x.k AS k, count(*) AS c, min(x.n) AS lo')).toEqual(
      [
        { k: 'KY', c: 3, lo: 10 },
        { k: 'KZ', c: 1, lo: 20 },
        { k: 'KN', c: 1, lo: null },
      ],
    );
  });

  test('key on the START end, aggregating the start', () => {
    const g = build();

    expect(query(g, 'MATCH (a:P)-[:T]->() RETURN a.k AS k, count(*) AS c, max(a.n) AS m')).toEqual([
      { k: 'ka', c: 2, m: 1 },
      { k: 'kb', c: 3, m: 2 },
    ]);
  });

  test('a WHERE on the keyed end carries', () => {
    const g = build();

    expect(
      query(g, 'MATCH (:P)-[:T]->(x) WHERE x.n > 15 RETURN x.k AS k, count(*) AS c, max(x.n) AS m'),
    ).toEqual([
      { k: 'KY', c: 1, m: 40 },
      { k: 'KZ', c: 1, m: 20 },
    ]);
  });

  test('an aggregate over the OTHER end declines, and still answers', () => {
    const g = build();

    // Only the keyed end is bound by this walk, so `max(a.n)` under a far key is the general
    // path's — and must be right.
    expect(query(g, 'MATCH (a:P)-[:T]->(x) RETURN x.k AS k, max(a.n) AS m')).toEqual([
      { k: 'KY', m: 2 },
      { k: 'KZ', m: 2 },
      { k: 'KN', m: 2 },
    ]);
  });

  test('sum and avg are REFUSED on a walk and still answer', () => {
    const g = build();

    expect(query(g, 'MATCH (:P)-[:T]->(x) RETURN x.k AS k, sum(x.n) AS s')).toEqual([
      { k: 'KY', s: 60 },
      { k: 'KZ', s: 20 },
      { k: 'KN', s: 0 },
    ]);
  });

  test('DISTINCT declines and differs from the non-DISTINCT answer', () => {
    const g = build();

    // KY's group holds y(10), w(40) and y(10) again — two distinct values across three edges.
    expect(query(g, 'MATCH (:P)-[:T]->(x) RETURN x.k AS k, count(DISTINCT x.n) AS d')).toEqual([
      { k: 'KY', d: 2 },
      { k: 'KZ', d: 1 },
      { k: 'KN', d: 0 },
    ]);
  });

  test('a far-end LABEL filter applies per edge', () => {
    // Its OWN fixture: in `build()` every far end is an `F`, so `:F` excludes nothing there and
    // the mutant that ignored the far label SURVIVED. CLAUDE.md's rule again — a label in a
    // fixture must exclude something — and this is the second time this session it bit.
    const mixed = new Graph();
    const src = mixed.addVertex({ id: 'src', labels: ['P'], properties: {} });
    const keep = mixed.addVertex({ id: 'keep', labels: ['F'], properties: { k: 'KEEP', n: 1 } });
    const drop = mixed.addVertex({ id: 'drop', labels: ['G'], properties: { k: 'DROP', n: 9 } });

    mixed.addEdge({ from: src, to: keep, labels: ['T'], properties: {} });
    mixed.addEdge({ from: src, to: drop, labels: ['T'], properties: {} });

    expect(
      query(mixed, 'MATCH (:P)-[:T]->(x:F) RETURN x.k AS k, count(*) AS c, max(x.n) AS m'),
    ).toEqual([{ k: 'KEEP', c: 1, m: 1 }]);
    // Without the label both appear, which is what makes the line above a filter test.
    expect(
      query(mixed, 'MATCH (:P)-[:T]->(x) RETURN x.k AS k, count(*) AS c, max(x.n) AS m'),
    ).toEqual([
      { k: 'KEEP', c: 1, m: 1 },
      { k: 'DROP', c: 1, m: 9 },
    ]);

    const g = build();

    expect(query(g, 'MATCH (:P)-[:T]->(x:F) RETURN x.k AS k, count(*) AS c')).toEqual([
      { k: 'KY', c: 3 },
      { k: 'KZ', c: 1 },
      { k: 'KN', c: 1 },
    ]);
    expect(query(g, 'MATCH (:P)-[:T]->(x:Nope) RETURN x.k AS k, count(*) AS c')).toEqual([]);
  });

  test('a null-valued aggregate argument is skipped, and count(*) is not', () => {
    const g = build();

    // `nn` has a `k` but no `n`: its group counts one row and no value, and `max` over nothing
    // is NULL rather than a number.
    expect(
      query(
        g,
        'MATCH (:P)-[:T]->(x) RETURN x.k AS k, count(*) AS c, count(x.n) AS vals, max(x.n) AS m',
      ),
    ).toEqual([
      { k: 'KY', c: 3, vals: 3, m: 40 },
      { k: 'KZ', c: 1, vals: 1, m: 20 },
      { k: 'KN', c: 1, vals: 0, m: null },
    ]);
  });

  test('an INLINE constraint on the start end declines, with the key on the far end', () => {
    const g = build();

    // The keyed end is `x`, so the constraint sits on the NON-keyed end and `plainNode(other)`
    // refuses the shape. The mutant that swapped the two ends applied `{k: 'ka'}` to the FAR
    // node instead — it SURVIVED until this case, because nothing else here constrains an end.
    expect(query(g, "MATCH (a:P {k: 'ka'})-[:T]->(x) RETURN x.k AS k, count(*) AS c")).toEqual([
      { k: 'KY', c: 2 },
    ]);
  });

  test('an undirected hop with an IN-edge to a start, which differs from the directed answer', () => {
    // `build()` has nothing pointing AT a `P`, so there the undirected answer equals the
    // directed one and an undirected test proves nothing. This fixture distinguishes them.
    const g = new Graph();
    const p = g.addVertex({ id: 'p', labels: ['P'], properties: { k: 'kp' } });
    const out = g.addVertex({ id: 'out', labels: ['F'], properties: { k: 'OUT', n: 1 } });
    const inn = g.addVertex({ id: 'in', labels: ['F'], properties: { k: 'IN', n: 2 } });

    g.addEdge({ from: p, to: out, labels: ['T'], properties: {} });
    g.addEdge({ from: inn, to: p, labels: ['T'], properties: {} });

    expect(query(g, 'MATCH (:P)-[:T]->(x) RETURN x.k AS k, count(*) AS c, max(x.n) AS m')).toEqual([
      { k: 'OUT', c: 1, m: 1 },
    ]);
    // Undirected sees both. This rung refuses `both` (the tally's inherited guard); the general
    // path answers, and the two must agree on what the answer IS.
    expect(query(g, 'MATCH (:P)-[:T]-(x) RETURN x.k AS k, count(*) AS c, max(x.n) AS m')).toEqual([
      { k: 'OUT', c: 1, m: 1 },
      { k: 'IN', c: 1, m: 2 },
    ]);
  });

  test('an undirected hop declines, and both directions still answer', () => {
    const g = build();

    // Two groups, not four: nothing points AT a or b, so the undirected walk finds the same
    // far ends (KY, KZ) the directed one does.
    expect(query(g, 'MATCH (:P)-[:T]-(x) RETURN x.k AS k, count(*) AS c')).toEqual([
      { k: 'KY', c: 3 },
      { k: 'KZ', c: 1 },
      { k: 'KN', c: 1 },
    ]);
  });
});
