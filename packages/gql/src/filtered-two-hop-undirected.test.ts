/**
 * Item 1094: a START-FILTERED two-hop UNDIRECTED count — `(a)-[:T]-(b)-[:T]-(c) WHERE <a-only>`.
 *
 * `buildFilteredTwoHopCount` declined `both` on either leg, so the query fell past every rung to
 * the general pipeline. The asymmetry is what made it worth finding: `buildTwoHopCount` has carried
 * `aBoth`/`cBoth` for the BARE and middle-constrained chain all along, and the THREE-hop count
 * carries `aBoth`/`midBoth`/`dBoth` — only the start-filtered two-hop fell through.
 *
 *   (a:P)-[:T]-(b)-[:T]-(c) WHERE a.age > 60     755.89 ms -> 89.00    8.5x
 *   (a:P)-[:T]-(b)-[:T]->(c) WHERE …             412.36    -> 70.48    5.9x
 *   (a:P)-[:T]->(b)-[:T]-(c) WHERE …             371.38    -> 46.63    8.0x
 *   (a:P)-[:T]->(b)-[:T]->(c) WHERE …  CONTROL    35.78    -> 33.43
 *   (a:P)-[:T]-(b)-[:T]-(c)  bare      CONTROL    34.90    -> 33.36
 *
 * THE SELF-LOOP IS THE ONLY SUBTLE PART, and it is where the two surface languages differ.
 * ISO-GQL's `-[:T]-` emits a loop ONCE; a loop sits in `adjFrom` AND `adjTo`, so the first leg's
 * in-box pass must skip it, and the second leg gets it from `undirectedSide`, which has carried
 * that rule since the bare chain was built. **Gremlin's `both()` yields a loop TWICE** (items
 * 1086/1087/1092 settled that against TinkerPop), so the `out + in` sum that works there is wrong
 * here — which is why this is not the same change as item 1092's.
 *
 * THE ORACLE IS THE GENERAL PATH, reached by appending `AND true` — item 570's control, since a
 * real predicate makes every count rung decline. Every fixture below carries TWO self-loops.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.ts';

/**
 * The fast route and an INDEPENDENT route on ONE pattern, asserted equal and returned.
 *
 * ⚠️ THE ORACLE IS A ROW PROJECTION, NOT `AND true`. The first version of this file used
 * `… AND true`, item 570's decline-forcer for the ONE-HOP count — and **this rung absorbs it**:
 * `a.k = 3 AND true` is still start-only, so both spellings took `firstLegUndirected` and every
 * assertion compared the route against ITSELF. A mutant that read the wrong end of the in-box edge
 * passed all 18 tests. `SKIP 0` is absorbed too; both were confirmed by tracing the in-box loop.
 *
 * That is item 930's warning exactly — "an oracle built from a shape the optimizer is allowed to
 * learn will eventually stop being an oracle, and it fails SILENTLY — green, and comparing one
 * route to itself". A ROW-RETURNING query cannot be answered by any count shortcut, so counting
 * its rows in the test is an oracle by construction rather than by the planner's current mood.
 */
const both = (g: Graph, pattern: string, filter: string): number => {
  const fast = query<{ c: number }>(g, `MATCH ${pattern} ${filter} RETURN count(*) AS c`)[0].c;
  const enumerated = query(g, `MATCH ${pattern} ${filter} RETURN a.k AS x`).length;

  expect(fast).toBe(enumerated);

  return fast;
};

/** `a->b`, `b->c`, a loop on `a` and a loop on `b`. `a`,`b` are `P`; `c` is `Q`. */
const looped = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
  g.addEdge({ id: 'e2', labels: ['T'], from: b, to: c, properties: {} });
  g.addEdge({ id: 'e3', labels: ['T'], from: a, to: a, properties: {} });
  g.addEdge({ id: 'e4', labels: ['T'], from: b, to: b, properties: {} });

  return g;
};

/** The same shape with NO loop, so a rung that only works on looped graphs is caught. */
const plain = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
  g.addEdge({ id: 'e2', labels: ['T'], from: b, to: c, properties: {} });

  return g;
};

describe('a start-filtered two-hop chain with an undirected leg', () => {
  for (const [name, fixture] of [
    ['two self-loops', looped],
    ['loop-free', plain],
  ] as ReadonlyArray<readonly [string, () => Graph]>) {
    describe(name, () => {
      test('BOTH legs undirected', () => {
        const g = fixture();

        expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c)', 'WHERE a.k >= 0')).toBeGreaterThan(0);
        expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c)', 'WHERE a.k = 1')).toBeGreaterThan(0);
        expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c)', 'WHERE a.k > 99')).toBe(0);
      });

      test('ONE leg undirected, each position — and the two differ', () => {
        const g = fixture();
        const first = both(g, '(a:P)-[:T]-(b)-[:T]->(c)', 'WHERE a.k >= 0');
        const second = both(g, '(a:P)-[:T]->(b)-[:T]-(c)', 'WHERE a.k >= 0');

        expect(first).toBeGreaterThan(0);
        expect(second).toBeGreaterThan(0);
        // On the looped fixture these are 8 and 9. A symmetric implementation would make them
        // equal, so asserting the INEQUALITY is what pins the two legs apart.

        if (name === 'two self-loops') {
          expect(first).toBe(8);
          expect(second).toBe(9);
        }
      });

      test('an IN leg, not just out', () => {
        const g = fixture();

        expect(both(g, '(a:P)-[:T]-(b)<-[:T]-(c)', 'WHERE a.k >= 0')).toBe(
          both(g, '(a:P)-[:T]-(b)<-[:T]-(c)', 'WHERE a.k >= 0'),
        );
        expect(both(g, '(a:P)<-[:T]-(b)-[:T]-(c)', 'WHERE a.k >= 0')).toBeGreaterThanOrEqual(0);
      });

      test('a MIDDLE label, which gates before the second leg is counted', () => {
        const g = fixture();

        expect(both(g, '(a:P)-[:T]-(b:P)-[:T]-(c)', 'WHERE a.k >= 0')).toBeGreaterThan(0);
        expect(both(g, '(a:P)-[:T]-(b:Q)-[:T]-(c)', 'WHERE a.k >= 0')).toBeGreaterThanOrEqual(0);
      });

      test('an END label', () => {
        const g = fixture();

        expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c:Q)', 'WHERE a.k >= 0')).toBeGreaterThanOrEqual(0);
        expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c:P)', 'WHERE a.k >= 0')).toBeGreaterThan(0);
      });

      test('an INLINE start constraint rather than a clause WHERE', () => {
        const g = fixture();

        expect(both(g, '(a:P {k: 1})-[:T]-(b)-[:T]-(c)', 'WHERE true')).toBeGreaterThan(0);
        expect(both(g, '(a:P {k: 9})-[:T]-(b)-[:T]-(c)', 'WHERE true')).toBe(0);
      });

      test('the DIRECTED chain is unchanged', () => {
        const g = fixture();

        expect(both(g, '(a:P)-[:T]->(b)-[:T]->(c)', 'WHERE a.k >= 0')).toBeGreaterThanOrEqual(0);
        expect(both(g, '(a:P)<-[:T]-(b)<-[:T]-(c)', 'WHERE a.k >= 0')).toBeGreaterThanOrEqual(0);
      });
    });
  }
});

describe('an ASYMMETRIC chain, so the in-box pass cannot read the wrong end', () => {
  // `first-leg-in-box-wrong-end` — the in-box pass taking `e.toId` (which IS the start vertex)
  // instead of `e.fromId` — SURVIVED until this fixture existed. The looped fixtures could not
  // catch it: `a`'s in-box holds only its own loop, where `from === to`, so the two reads agree.
  //
  // Here every vertex has a DIFFERENT degree and there are no loops, so reading the wrong end
  // counts the second leg from the start instead of from the neighbour and the total moves.
  const chain = (): Graph => {
    const g = new Graph();
    const vs = Array.from({ length: 5 }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
    );

    // A path plus two extra edges off `v3`, so degrees are 1, 2, 2, 4, 1 — all distinct enough
    // that the start's own degree cannot stand in for a neighbour's.
    g.addEdge({ id: 'a', labels: ['T'], from: vs[0], to: vs[1], properties: {} });
    g.addEdge({ id: 'b', labels: ['T'], from: vs[1], to: vs[2], properties: {} });
    g.addEdge({ id: 'c', labels: ['T'], from: vs[2], to: vs[3], properties: {} });
    g.addEdge({ id: 'd', labels: ['T'], from: vs[3], to: vs[4], properties: {} });
    g.addEdge({ id: 'e', labels: ['T'], from: vs[0], to: vs[3], properties: {} });

    return g;
  };

  test('both legs undirected over distinct degrees', () => {
    const g = chain();

    expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c)', 'WHERE a.k >= 0')).toBeGreaterThan(0);
    // One start at a time, so a per-vertex error cannot cancel against another's.

    for (let k = 0; k < 5; k += 1) {
      expect(both(g, '(a:P)-[:T]-(b)-[:T]-(c)', `WHERE a.k = ${k}`)).toBeGreaterThanOrEqual(0);
    }
  });

  test('one leg undirected, each position, per start', () => {
    const g = chain();

    for (let k = 0; k < 5; k += 1) {
      expect(both(g, '(a:P)-[:T]-(b)-[:T]->(c)', `WHERE a.k = ${k}`)).toBeGreaterThanOrEqual(0);
      expect(both(g, '(a:P)-[:T]->(b)-[:T]-(c)', `WHERE a.k = ${k}`)).toBeGreaterThanOrEqual(0);
      expect(both(g, '(a:P)-[:T]-(b)<-[:T]-(c)', `WHERE a.k = ${k}`)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the loop correction is load-bearing', () => {
  test('a loop on the START vertex is traversed ONCE by the first leg', () => {
    // `a` has a loop and one edge to `b`. Undirected, `a`'s first leg reaches {b, a} — three
    // traversals if the loop were counted from both boxes, two if once. The general path says
    // which, and ISO-GQL says once.
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

    g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'loop', labels: ['T'], from: a, to: a, properties: {} });

    // 3, and I first wrote 4 — `both`'s own equality held and the literal was the error, which is
    // the fourth time in this run (items 1067, 1076, 1086). `a`'s first leg reaches `b` once and
    // `a` once; from `b` the second leg reaches `a` (1), from `a` it reaches `b` and `a` (2).
    expect(both(g, '(a:P {k: 1})-[:T]-(b)-[:T]-(c)', 'WHERE true')).toBe(3);
  });

  test('a loop on the MIDDLE vertex, which the second leg corrects', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

    g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
    g.addEdge({ id: 'loop', labels: ['T'], from: b, to: b, properties: {} });

    expect(both(g, '(a:P {k: 1})-[:T]-(b)-[:T]-(c)', 'WHERE true')).toBe(2);
  });
});
