import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// `MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q) RETURN count(*)` is now a sum of products —
// one per value of the shared variable — instead of an enumeration of the pairs (audit item
// 156). O(V + E) rather than O(pairs), so 6.9x at in-degree 20 and 44x at 60.
//
// EVERY test here checks the shortcut against the ENUMERATED answer for the same query. That is
// `productCountOf`'s rule: the oracle is what the engine already returns, not an argument from
// what the shape ought to mean. A count asserted against a hand-computed number proves only
// that the author and the code agree.
const counted = (g: Graph, pattern: string): number => {
  const viaCount = query(g, `${pattern} RETURN count(*) AS c`) as { c: number }[];
  const viaRows = query(g, `${pattern} RETURN 1 AS one`) as unknown[];

  expect(viaCount[0]?.c).toBe(viaRows.length);

  return viaRows.length;
};

/**
 * Hub-and-spoke with UNEVEN in-degrees. A ring cannot test any of this: with every in-degree 1,
 * `SUM d^2`, `SUM d` and the edge count all coincide, so a wrong formula agrees with a right
 * one. Hub j collects j + 1 edges, so the degrees are 1, 2, 3, …
 */
const hubs = (n: number, label = 'P'): Graph => {
  const g = new Graph();
  let src = 0;

  for (let j = 0; j < n; j++) {
    const h = g.addVertex({ id: `h${j}`, labels: [label], properties: { hub: 1, k: j } });

    for (let d = 0; d <= j; d++) {
      const s = g.addVertex({ id: `s${src++}`, labels: ['P'], properties: { hub: 0, k: d } });

      g.addEdge({ from: s, to: h, labels: ['E'], properties: { w: d } });
    }
  }

  return g;
};

describe('a keyed count equals the enumeration', () => {
  test('uneven in-degrees', () => {
    // SUM of 1..4 squared = 1 + 4 + 9 + 16 = 30, which the enumeration confirms.
    expect(counted(hubs(4), 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q)')).toBe(30);
  });

  test('a larger spread of degrees', () => {
    expect(counted(hubs(8), 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q)')).toBe(204);
  });

  test('the COMMA spelling of the same join agrees', () => {
    const g = hubs(5);
    const two = counted(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q)');
    const comma = counted(g, 'MATCH (a:P)-[:E]->(q:P), (b:P)-[:E]->(q)');

    expect(comma).toBe(two);
  });

  test('PARALLEL edges count once per EDGE, not per neighbour', () => {
    // Two a->q edges make two matches of one pattern, so four pairs — a formula counting
    // distinct neighbours would answer 1.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const q = g.addVertex({ id: 'q', labels: ['P'], properties: {} });

    g.addEdge({ from: a, to: q, labels: ['E'], properties: { w: 1 } });
    g.addEdge({ from: a, to: q, labels: ['E'], properties: { w: 2 } });

    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:P)-[:E]->(z)')).toBe(4);
  });

  test('a SELF-LOOP is counted like any other edge', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });

    g.addEdge({ from: a, to: a, labels: ['E'], properties: {} });

    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:P)-[:E]->(z)')).toBe(1);
  });

  test('no edges at all is zero', () => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: {} });

    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:P)-[:E]->(z)')).toBe(0);
  });

  test('DIFFERENT edge types per side', () => {
    // Side 1 walks E, side 2 walks F, so the product per q is indegE x indegF — not a square.
    const g = new Graph();
    const q = g.addVertex({ id: 'q', labels: ['P'], properties: {} });
    const e1 = g.addVertex({ id: 'e1', labels: ['P'], properties: {} });
    const e2 = g.addVertex({ id: 'e2', labels: ['P'], properties: {} });
    const f1 = g.addVertex({ id: 'f1', labels: ['P'], properties: {} });

    g.addEdge({ from: e1, to: q, labels: ['E'], properties: {} });
    g.addEdge({ from: e2, to: q, labels: ['E'], properties: {} });
    g.addEdge({ from: f1, to: q, labels: ['F'], properties: {} });

    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:P)-[:F]->(z)')).toBe(2);
  });

  test('a side with NO matching edges makes the whole product zero', () => {
    const g = hubs(4);

    expect(counted(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:NOSUCH]->(q)')).toBe(0);
  });

  test('MIXED directions: one side in, one side out', () => {
    // `(y)<-[:E]-(z)` walks z's OUT edges while `(x)-[:E]->(z)` walks its IN edges.
    const g = new Graph();
    const q = g.addVertex({ id: 'q', labels: ['P'], properties: {} });
    const up = g.addVertex({ id: 'up', labels: ['P'], properties: {} });
    const d1 = g.addVertex({ id: 'd1', labels: ['P'], properties: {} });
    const d2 = g.addVertex({ id: 'd2', labels: ['P'], properties: {} });

    g.addEdge({ from: up, to: q, labels: ['E'], properties: {} });
    g.addEdge({ from: q, to: d1, labels: ['E'], properties: {} });
    g.addEdge({ from: q, to: d2, labels: ['E'], properties: {} });

    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:P)<-[:E]-(z)')).toBe(2);
  });

  test('both sides walking OUT edges', () => {
    const g = new Graph();
    const q = g.addVertex({ id: 'q', labels: ['P'], properties: {} });
    const d1 = g.addVertex({ id: 'd1', labels: ['P'], properties: {} });
    const d2 = g.addVertex({ id: 'd2', labels: ['P'], properties: {} });

    g.addEdge({ from: q, to: d1, labels: ['E'], properties: {} });
    g.addEdge({ from: q, to: d2, labels: ['E'], properties: {} });

    expect(counted(g, 'MATCH (x:P)<-[:E]-(z:P) MATCH (y:P)<-[:E]-(z)')).toBe(4);
  });

  test('an UNTYPED hop counts every edge type', () => {
    const g = new Graph();
    const q = g.addVertex({ id: 'q', labels: ['P'], properties: {} });
    const e1 = g.addVertex({ id: 'e1', labels: ['P'], properties: {} });
    const f1 = g.addVertex({ id: 'f1', labels: ['P'], properties: {} });

    g.addEdge({ from: e1, to: q, labels: ['E'], properties: {} });
    g.addEdge({ from: f1, to: q, labels: ['F'], properties: {} });

    expect(counted(g, 'MATCH (x:P)-[]->(z:P) MATCH (y:P)-[]->(z)')).toBe(4);
  });
});

describe('constraints on the far ends and the shared vertex are applied', () => {
  test("the far end's LABEL narrows its side", () => {
    const g = new Graph();
    const q = g.addVertex({ id: 'q', labels: ['P'], properties: {} });
    const p1 = g.addVertex({ id: 'p1', labels: ['P'], properties: {} });
    const r1 = g.addVertex({ id: 'r1', labels: ['P', 'R'], properties: {} });

    g.addEdge({ from: p1, to: q, labels: ['E'], properties: {} });
    g.addEdge({ from: r1, to: q, labels: ['E'], properties: {} });

    // Side 1 accepts both sources, side 2 only the :R one.
    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:R)-[:E]->(z)')).toBe(2);
    // A label nothing carries zeroes the side.
    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:ZZ)-[:E]->(z)')).toBe(0);
  });

  test("the far end's INLINE PROPS narrow its side", () => {
    const g = hubs(4);

    // Sources carry k = 0..j; only k = 0 exists on every hub.
    const all = counted(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q)');
    const narrowed = counted(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P {k: 0})-[:E]->(q)');

    expect(narrowed).toBeLessThan(all);
    expect(narrowed).toBe(10); // SUM over hubs of indeg x 1
  });

  test("the far end's inline PREDICATE narrows its side", () => {
    const g = hubs(4);
    const narrowed = counted(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P WHERE b.k = 0)-[:E]->(q)');

    expect(narrowed).toBe(10);
  });

  test("the SHARED vertex's label is applied, from either pattern", () => {
    const g = new Graph();
    const q1 = g.addVertex({ id: 'q1', labels: ['P', 'HUB'], properties: {} });
    const q2 = g.addVertex({ id: 'q2', labels: ['P'], properties: {} });
    const s = g.addVertex({ id: 's', labels: ['P'], properties: {} });

    g.addEdge({ from: s, to: q1, labels: ['E'], properties: {} });
    g.addEdge({ from: s, to: q2, labels: ['E'], properties: {} });

    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:P)-[:E]->(z)')).toBe(2);
    // Written on the FIRST pattern's endpoint...
    expect(counted(g, 'MATCH (x:P)-[:E]->(z:HUB) MATCH (y:P)-[:E]->(z)')).toBe(1);
    // ...and on the SECOND's, which must narrow identically.
    expect(counted(g, 'MATCH (x:P)-[:E]->(z:P) MATCH (y:P)-[:E]->(z:HUB)')).toBe(1);
  });

  test("the SHARED vertex's inline props are applied from either pattern", () => {
    const g = hubs(4);

    // `hub: 1` holds for every shared vertex here, so it must not change the answer...
    expect(counted(g, 'MATCH (a:P)-[:E]->(q:P {hub: 1}) MATCH (b:P)-[:E]->(q)')).toBe(30);
    // ...and `hub: 0` holds for none of them, so it must zero it.
    expect(counted(g, 'MATCH (a:P)-[:E]->(q:P {hub: 0}) MATCH (b:P)-[:E]->(q)')).toBe(0);
    expect(counted(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q {hub: 0})')).toBe(0);
  });

  test('a $param on a far end resolves per execution', () => {
    const g = hubs(4);

    expect(
      query(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P {k: $v})-[:E]->(q) RETURN count(*) AS c', {
        v: 0,
      }),
    ).toEqual([{ c: 10 }]);
    expect(
      query(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P {k: $v})-[:E]->(q) RETURN count(*) AS c', {
        v: 99,
      }),
    ).toEqual([{ c: 0 }]);
  });
});

describe('shapes outside the form decline and still answer', () => {
  // Each must equal its enumeration, which `counted` checks — so a guard that wrongly ACCEPTED
  // one of these would show up as a mismatch here.
  test('a clause WHERE (it can correlate the sides)', () => {
    const g = hubs(4);

    expect(
      counted(g, 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q) WHERE b.k = a.k'),
    ).toBeGreaterThan(0);
  });

  test('an edge VARIABLE', () => {
    expect(counted(hubs(4), 'MATCH (a:P)-[r:E]->(q:P) MATCH (b:P)-[s:E]->(q)')).toBe(30);
  });

  test('an edge inline PROPERTY', () => {
    expect(counted(hubs(4), 'MATCH (a:P)-[:E {w: 0}]->(q:P) MATCH (b:P)-[:E]->(q)')).toBe(10);
  });

  test('an UNDIRECTED hop', () => {
    expect(counted(hubs(3), 'MATCH (a:P)-[:E]-(q:P) MATCH (b:P)-[:E]->(q)')).toBeGreaterThan(0);
  });

  test('a QUANTIFIED hop', () => {
    expect(counted(hubs(3), 'MATCH (a:P)-[:E]->{1,2}(q:P) MATCH (b:P)-[:E]->(q)')).toBeGreaterThan(
      0,
    );
  });

  test('THREE patterns', () => {
    expect(
      counted(hubs(3), 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q) MATCH (c:P)-[:E]->(q)'),
    ).toBeGreaterThan(0);
  });

  test('the shared variable at the START of one pattern, not its endpoint', () => {
    // `(q)-[:E]->(c)` shares `q` as its START, which the form does not cover.
    expect(counted(hubs(4), 'MATCH (a:P)-[:E]->(q:P) MATCH (q)-[:E]->(c:P)')).toBe(0);
  });

  test('TWO shared variables', () => {
    expect(counted(hubs(4), 'MATCH (a:P)-[:E]->(q:P) MATCH (a)-[:E]->(q)')).toBe(10);
  });

  test('NO shared variable is a product, not a keyed sum', () => {
    // `productCountOf` owns this; the keyed path must not intercept it.
    expect(counted(hubs(3), 'MATCH (a:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(r:P)')).toBe(36);
  });

  test('a two-SEGMENT pattern', () => {
    expect(
      counted(hubs(3), 'MATCH (a:P)-[:E]->(m:P)-[:E]->(q:P) MATCH (b:P)-[:E]->(q)'),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('the shared variable as BOTH ends of a pattern', () => {
  // `(q)-[:E]->(q)` makes the shared variable its own far end, so the far-end count cannot
  // treat it as free. This is the only shape where the "start is not the shared variable"
  // guard does any work: found by mutation, which showed that dropping it changed nothing
  // until this case existed — every other two-shared-variable or shared-at-start shape is
  // already refused by the "endpoint must be the shared variable" guard.
  const withLoop = (): Graph => {
    const g = new Graph();
    const q = g.addVertex({ id: 'q', labels: ['P'], properties: {} });
    const s1 = g.addVertex({ id: 's1', labels: ['P'], properties: {} });
    const s2 = g.addVertex({ id: 's2', labels: ['P'], properties: {} });
    const other = g.addVertex({ id: 'other', labels: ['P'], properties: {} });

    g.addEdge({ from: s1, to: q, labels: ['E'], properties: {} });
    g.addEdge({ from: s2, to: q, labels: ['E'], properties: {} });
    g.addEdge({ from: q, to: q, labels: ['E'], properties: {} }); // the self-loop
    g.addEdge({ from: s1, to: other, labels: ['E'], properties: {} });

    return g;
  };

  test('a self-referencing second pattern', () => {
    // q has three in-edges (s1, s2 and its own loop) and one out-edge (the loop). The pattern
    // `(z)-[:E]->(z)` holds only for q, so the count is q's in-degree x 1 = 3.
    expect(counted(withLoop(), 'MATCH (x:P)-[:E]->(z:P) MATCH (z)-[:E]->(z)')).toBe(3);
  });

  test('a self-referencing FIRST pattern', () => {
    expect(counted(withLoop(), 'MATCH (z:P)-[:E]->(z) MATCH (y:P)-[:E]->(z)')).toBe(3);
  });
});
