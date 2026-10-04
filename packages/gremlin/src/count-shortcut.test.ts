import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import {
  E,
  Scope,
  V,
  both,
  count,
  dedupe,
  fold,
  hasLabel,
  in_,
  out,
  toArray,
  traversal,
} from './index.js';

// `count()` over a shape the graph already keeps a counter or bucket for is answered as a READ
// (audit item 131). Before this, `g.V().hasLabel('Person').count()` enumerated every vertex —
// 57.5ms at 200,000, where the GQL spelling of the same question was 0.0ms.
//
// THE ORACLE is a FORCED DECLINE: adding a step the shortcut does not recognise pushes the same
// question through the general walk. `dedupe()` over a frontier that is already distinct is the
// identity, so `V().hasLabel(L).dedupe().count()` must equal `V().hasLabel(L).count()` while
// taking a completely different route. Arithmetic from the known fixture backs it up.

const EDGES: readonly (readonly [number, number, string])[] = [
  [0, 1, 'E'],
  [0, 2, 'E'],
  [1, 2, 'E'],
  [2, 0, 'F'],
  [3, 3, 'E'], // self-loop
  [3, 1, 'F'],
  [1, 1, 'F'], // second self-loop, other type
];

// 0-2 are P only, 3 is both, 4-5 are Q only: |P| = 4, |Q| = 3, union = 6, sum = 7 — four
// distinct numbers, so no case can pass by coincidence.
const LABELS: readonly (readonly string[])[] = [['P'], ['P'], ['P'], ['P', 'Q'], ['Q'], ['Q']];

const build = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 6 }, (_, i) =>
    g.addVertex({
      // The label sets must OVERLAP WITHOUT NESTING, or a multi-label `hasLabel` cannot be
      // distinguished from "the first label's bucket". With every vertex carrying `P`, Q is a
      // subset of P and union(P, Q) === |P| — a mutant that read only `labels[0]` returned the
      // right answer for the wrong reason and survived. So: 0-2 are P only, 3 is both, 4-5 are
      // Q only. |P| = 4, |Q| = 3, union = 6.
      id: `v${i}`,
      labels: [...LABELS[i]],
      properties: { k: i },
    }),
  );

  for (const [a, b, label] of EDGES) {
    g.addEdge({ from: vs[a], to: vs[b], labels: [label], properties: {} });
  }

  return g;
};

const n = (g: Graph, ...steps: Parameters<typeof traversal>): number =>
  toArray(traversal(...steps), g)[0] as number;

describe('count() answered from a counter or bucket', () => {
  test('each shortcut equals its forced-decline twin and the arithmetic', () => {
    const g = build();

    // V().count() — every vertex.
    expect(n(g, V(), count())).toBe(6);
    expect(n(g, V(), count())).toBe(n(g, V(), dedupe(), count()));

    // E().count() — every edge.
    expect(n(g, E(), count())).toBe(EDGES.length);
    expect(n(g, E(), count())).toBe(n(g, E(), dedupe(), count()));

    // hasLabel(L).count() — the label bucket.
    expect(n(g, V(), hasLabel('P'), count())).toBe(4);
    expect(n(g, V(), hasLabel('Q'), count())).toBe(3);
    expect(n(g, V(), hasLabel('P'), count())).toBe(n(g, V(), hasLabel('P'), dedupe(), count()));
    expect(n(g, V(), hasLabel('Q'), count())).toBe(n(g, V(), hasLabel('Q'), dedupe(), count()));
    // a label no vertex carries
    expect(n(g, V(), hasLabel('NOPE'), count())).toBe(0);

    // out(T)/in(T).count() — one traverser per traversed EDGE, so the edge bucket.
    // `E().hasLabel(T).count()` is an independent route to the same number (an `E` source with
    // an intermediate step is not a shape the shortcut takes).
    for (const t of ['E', 'F']) {
      const want = EDGES.filter(([, , l]) => l === t).length;

      expect(n(g, V(), out(t), count())).toBe(want);
      expect(n(g, V(), in_(t), count())).toBe(want);
      expect(n(g, E(), hasLabel(t), count())).toBe(want);
    }

    // out() with no type — every edge, traversed once from its own source.
    expect(n(g, V(), out(), count())).toBe(EDGES.length);
    expect(n(g, V(), in_(), count())).toBe(EDGES.length);
  });

  // Shapes the shortcut must decline. Each is compared against the same question reached a
  // different way, or against arithmetic, so a wrong decline shows up as a wrong number.
  test('shapes it declines still answer correctly', () => {
    const g = build();

    // MULTI-LABEL hasLabel is a UNION. |P| = 4 and |Q| = 3 overlap on one vertex, so the
    // union is 6 — different from the SUM (7) and different from EITHER bucket (4, 3). All
    // three have to differ, or the case cannot tell a union from a sum from a first-label read.
    expect(n(g, V(), hasLabel('P', 'Q'), count())).toBe(6);
    expect(n(g, V(), hasLabel('P', 'Q'), count())).not.toBe(
      n(g, V(), hasLabel('P'), count()) + n(g, V(), hasLabel('Q'), count()),
    );
    expect(n(g, V(), hasLabel('P', 'Q'), count())).not.toBe(n(g, V(), hasLabel('P'), count()));
    expect(n(g, V(), hasLabel('P', 'Q'), count())).not.toBe(n(g, V(), hasLabel('Q'), count()));

    // `both()` walks out-edges then in-edges, so a self-loop is incident TWICE. Two self-loops
    // here, so the total exceeds the edge count and is not a bucket size.
    expect(n(g, V(), both(), count())).toBe(EDGES.length * 2);
    expect(n(g, V(), both('E'), count())).toBe(EDGES.filter(([, , l]) => l === 'E').length * 2);

    // `V(ids)` enumerates a given set, not the graph.
    expect(n(g, V('v1'), count())).toBe(1);
    expect(n(g, V('v1', 'v2'), count())).toBe(2);
    expect(n(g, V('nope'), count())).toBe(0);

    // count(local) is a different question — the size of each element of the frontier, so
    // `fold()` then `count(local)` is ONE row holding the list's length.
    expect(toArray(traversal(V(), hasLabel('Q'), fold(), count(Scope.local)), g)).toEqual([3]);
    // …and with NO intermediate step, which is the shape whose global twin IS shortcut. A
    // mutant that ignored the scope answered `vertexCount` here.
    expect(toArray(traversal(V(), count(Scope.local)), g)).not.toEqual([6]);

    // Two intermediate steps: not a shape with a counter. `P` is now a strict subset, so this
    // is a real filter rather than a vacuous one.
    expect(n(g, V(), hasLabel('P'), out('E'), count())).toBe(
      EDGES.filter(([a, , l]) => l === 'E' && LABELS[a].includes('P')).length,
    );
  });

  // Summing per-type buckets double-counts an edge carrying two of the types, so a multi-type
  // graph must decline the multi-type sum.
  test('a multi-type edge is counted once', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: {} });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: {} });

    g.addEdge({ from: a, to: b, labels: ['E', 'F'], properties: {} });

    expect(n(g, V(), out('E'), count())).toBe(1);
    expect(n(g, V(), out('F'), count())).toBe(1);
    // ONE edge, named twice: the walk yields it once, so a bucket SUM (2) would be wrong.
    expect(n(g, V(), out('E', 'F'), count())).toBe(1);
    expect(n(g, E(), count())).toBe(1);
  });

  test('an empty graph counts zero', () => {
    const g = new Graph();

    expect(n(g, V(), count())).toBe(0);
    expect(n(g, E(), count())).toBe(0);
    expect(n(g, V(), hasLabel('P'), count())).toBe(0);
    expect(n(g, V(), out('E'), count())).toBe(0);
  });
});
