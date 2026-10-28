import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { beats } from './executor/count-shortcut.js';
import {
  E,
  Scope,
  V,
  bothE,
  count,
  has,
  hasLabel,
  inE,
  outE,
  toArray,
  traversal,
} from './index.js';
import { gt } from './predicates.js';

// Item 1044: `V().outE(T…).has(k, v)….count()` is seeded from the edge property index, where it
// previously reached no count rung at all and fell to the general traversal (item 1043 priced the
// gap at 550-650x).
//
// THE NON-OBVIOUS EXPECTATIONS HERE WERE READ OFF A REAL TINKERPOP CONSOLE, not derived. On a
// fixture of 4 `T` edges including a SELF-LOOP plus one `U`, TinkerPop 3.7.3 returns:
//
//   E().count() 5   E().hasLabel(T).count() 4   V().outE().count() 5   V().outE(T).count() 4
//   V().inE(T).count() 4        V().bothE(T).count() 8        V().outE(T,U).count() 5
//   V().outE(T).has(w,1) 3      V().inE(T).has(w,1) 3         E().hasLabel(T).has(w,1) 3
//
// So `outE`/`inE` visit each edge exactly ONCE — the self-loop included — which is what makes the
// answer "the number of matching edges", and `bothE` visits it TWICE, which is why `bothE` is
// excluded from the rung rather than served by it.

const fixture = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'] });
  const b = g.addVertex({ id: 'b', labels: ['P'] });
  const c = g.addVertex({ id: 'c', labels: ['P'] });

  g.addEdge({ id: 'e1', from: a, to: b, labels: ['T'], properties: { w: 1, tag: 'x' } });
  g.addEdge({ id: 'e2', from: b, to: c, labels: ['T'], properties: { w: 2, tag: 'x' } });
  g.addEdge({ id: 'e3', from: c, to: a, labels: ['T'], properties: { w: 1, tag: 'y' } });
  // A DIFFERENT TYPE carrying the same key — the type residual's edge. The index bucket for
  // `w: 1` holds it, so a rung that forgot to re-apply the hop's labels would count it.
  g.addEdge({ id: 'u1', from: a, to: c, labels: ['U'], properties: { w: 1, tag: 'x' } });
  // A SELF-LOOP, which is where `bothE` differs from `outE`/`inE`.
  g.addEdge({ id: 'e4', from: a, to: a, labels: ['T'], properties: { w: 1, tag: 'z' } });
  g.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });

  return g;
};

const g = fixture();
const n = (t: ReturnType<typeof traversal>): unknown => toArray(t, g)[0];

describe('an edge hop + has filters, seeded (item 1044)', () => {
  test('outE matches the E().hasLabel() spelling of the same question', () => {
    // TinkerPop: both 3.
    expect(n(traversal(V(), outE('T'), has('w', 1), count()))).toBe(3);
    expect(n(traversal(E(), hasLabel('T'), has('w', 1), count()))).toBe(3);
  });

  test('inE gives the same answer as outE — every edge is an in-edge of its target', () => {
    // TinkerPop: 3.
    expect(n(traversal(V(), inE('T'), has('w', 1), count()))).toBe(3);
  });

  test('the HOP LABEL is re-applied — the `U` in the same index bucket is not a `T`', () => {
    expect(n(traversal(V(), outE('T'), has('w', 1), count()))).toBe(3);
    expect(n(traversal(V(), outE('U'), has('w', 1), count()))).toBe(1);
    // ...and both types together is the union, counted once each.
    expect(n(traversal(V(), outE('T', 'U'), has('w', 1), count()))).toBe(4);
  });

  test('NO hop label means every type', () => {
    expect(n(traversal(V(), outE(), has('w', 1), count()))).toBe(4);
  });

  test('bothE is NOT served by this rung — it visits each edge twice', () => {
    // TinkerPop: V().bothE(T).count() is 8 against outE's 4, the self-loop included. If the rung
    // ever claimed `bothE` this would read 3 instead of 6.
    expect(n(traversal(V(), bothE('T'), has('w', 1), count()))).toBe(6);
  });

  test('the SELF-LOOP is counted once by outE and once by inE', () => {
    // `e4` is a→a with `w: 1`, and it is one of the three above. Asking for its tag isolates it.
    expect(n(traversal(V(), outE('T'), has('tag', 'z'), count()))).toBe(1);
    expect(n(traversal(V(), inE('T'), has('tag', 'z'), count()))).toBe(1);
  });

  test('a RESIDUAL filter is applied as well as the seeded one', () => {
    // Seeded on `w = 1` (4 edges across both types), then `:T` keeps 3, then `tag = 'x'` keeps 1.
    expect(n(traversal(V(), outE('T'), has('w', 1), has('tag', 'x'), count()))).toBe(1);
  });

  test('the filter order does not change the answer', () => {
    expect(n(traversal(V(), outE('T'), has('tag', 'x'), has('w', 1), count()))).toBe(1);
  });

  test('a RANGE predicate on the indexed key, which the seed keeps as a residual', () => {
    expect(n(traversal(V(), outE('T'), has('w', gt(1)), count()))).toBe(1);
  });

  test('an UNINDEXED key still answers — the rung declines and the old path runs', () => {
    expect(n(traversal(V(), outE('T'), has('tag', 'x'), count()))).toBe(2);
  });

  test('a value NO edge carries answers 0', () => {
    expect(n(traversal(V(), outE('T'), has('w', 99), count()))).toBe(0);
  });

  test('count(local) is a different question and must not take this route', () => {
    // `count(local)` counts within each element. The rung requires a GLOBAL count terminal, and
    // `countShortcut` refuses `scope === 'local'` before any rung sees it.
    const got = toArray(traversal(V(), outE('T'), has('w', 1), count(Scope.local)), g);

    expect(got).toHaveLength(3);
  });
});

describe('beats — the answer-equivalent choice, tested directly (item 1044)', () => {
  // A mutant flipping `<` to `>` passed all 864 Gremlin tests, because every candidate's bucket is
  // a SUPERSET of the answer and the hop labels and residual filters are re-applied afterwards —
  // so the wider seed is slower and never wrong. The choice is therefore tested as arithmetic,
  // which is the only place it is observable (`perf-gate-needs-its-own-test`).
  const c = (count: number): Parameters<typeof beats>[0] => ({
    count,
    build: () => new Set(),
    removable: true,
  });

  test('anything beats NO incumbent, including an empty bucket', () => {
    expect(beats(c(7), null)).toBe(true);
    expect(beats(c(0), null)).toBe(true);
  });

  test('narrower wins, wider loses', () => {
    expect(beats(c(3), c(7))).toBe(true);
    expect(beats(c(7), c(3))).toBe(false);
  });

  test('a TIE keeps the incumbent, so the choice is deterministic', () => {
    expect(beats(c(4), c(4))).toBe(false);
  });

  test('an EMPTY bucket beats a non-empty one — it is a real answer, not an absent seed', () => {
    expect(beats(c(0), c(9))).toBe(true);
  });
});

describe('a START-FILTERED edge hop, seeded (item 1046)', () => {
  // THE TINKERPOP FIXTURE, REPRODUCED EXACTLY, because these expectations are its readings:
  //
  //   E(T).has(w,1) 4
  //   hasLabel(Person).outE(T).has(w,1) 3    hasLabel(Co).outE(T).has(w,1) 1    <- by SOURCE
  //   hasLabel(Person).inE(T).has(w,1)  2    hasLabel(Co).inE(T).has(w,1)  2    <- by TARGET
  //
  // THE FIXTURE IS DELIBERATELY ASYMMETRIC — TWO `Person -> Co` edges against ONE `Co -> Person` —
  // and that is the whole point. The first version had one of each, which makes the source-split
  // and the target-split BOTH 3/1, so reading the wrong endpoint gives the identical answers and
  // the `wrong-endpoint` mutant SURVIVED while a test comment claimed it was "the sharpest pair".
  // With two against one the splits are 3/1 and 2/2, and only then does the direction show.
  const g2 = (() => {
    const graph = new Graph();
    const p1 = graph.addVertex({ id: 'p1', labels: ['Person'], properties: { n: 1 } });
    const p2 = graph.addVertex({ id: 'p2', labels: ['Person'], properties: { n: 2 } });
    const co = graph.addVertex({ id: 'co', labels: ['Co'], properties: { n: 3 } });

    // TWO Person -> Co, ONE Co -> Person: the asymmetry the header explains.
    graph.addEdge({ id: 'a1', from: p1, to: co, labels: ['T'], properties: { w: 1 } });
    graph.addEdge({ id: 'a2', from: p1, to: co, labels: ['T'], properties: { w: 1 } });
    graph.addEdge({ id: 'a3', from: co, to: p2, labels: ['T'], properties: { w: 1 } });
    // The SELF-LOOP, counted once by each direction.
    graph.addEdge({ id: 'a4', from: p2, to: p2, labels: ['T'], properties: { w: 1 } });
    graph.createIndex({ on: 'edge', kind: 'hash', keys: ['w'] });

    return graph;
  })();
  const c = (t: ReturnType<typeof traversal>): unknown => toArray(t, g2)[0];

  test('the total is 4, so the splits below must sum to it', () => {
    expect(c(traversal(E(), hasLabel('T'), has('w', 1), count()))).toBe(4);
  });

  test('outE partitions by the edge SOURCE — 3 and 1', () => {
    expect(c(traversal(V(), hasLabel('Person'), outE('T'), has('w', 1), count()))).toBe(3);
    expect(c(traversal(V(), hasLabel('Co'), outE('T'), has('w', 1), count()))).toBe(1);
  });

  test("inE partitions by the edge TARGET — 2 and 2, NOT outE's 3 and 1", () => {
    // THE ARM THAT CATCHES A SWAPPED ENDPOINT. It only works because the fixture is asymmetric:
    // 3/1 by source against 2/2 by target. Both splits still sum to 4, so the totals prove
    // nothing and the SHAPE of the split is the whole signal.
    expect(c(traversal(V(), hasLabel('Person'), inE('T'), has('w', 1), count()))).toBe(2);
    expect(c(traversal(V(), hasLabel('Co'), inE('T'), has('w', 1), count()))).toBe(2);
  });

  test('hasLabel with several labels is the UNION', () => {
    expect(c(traversal(V(), hasLabel('Person', 'Co'), outE('T'), has('w', 1), count()))).toBe(4);
  });

  test('a label NO vertex carries answers 0', () => {
    expect(c(traversal(V(), hasLabel('Nope'), outE('T'), has('w', 1), count()))).toBe(0);
  });

  test('a residual filter applies on top of the label', () => {
    expect(
      c(traversal(V(), hasLabel('Person'), outE('T'), has('w', 1), has('w', gt(0)), count())),
    ).toBe(3);
  });

  test('an UNINDEXED key still answers — the rung declines and the old path runs', () => {
    expect(c(traversal(V(), hasLabel('Person'), outE('T'), has('n', 1), count()))).toBe(0);
  });

  test('a leading step that is NOT a hasLabel must not be PEELED AND DROPPED', () => {
    // The rung peels `mid[0]` as a start-label constraint. A mutant that peeled ANY leading step
    // survived the whole suite, because nothing exercised a leading `has` before an edge hop —
    // and dropping it answers 4 where TinkerPop answers 2. Console readings: `has(n,1).outE(T)`
    // is 2, `has(n,2).outE(T)` is 1, and `hasLabel(Person).has(n,1).outE(T)` is 2.
    expect(c(traversal(V(), has('n', 1), outE('T'), has('w', 1), count()))).toBe(2);
    expect(c(traversal(V(), has('n', 2), outE('T'), has('w', 1), count()))).toBe(1);
    expect(
      c(traversal(V(), hasLabel('Person'), has('n', 1), outE('T'), has('w', 1), count())),
    ).toBe(2);
  });
});
