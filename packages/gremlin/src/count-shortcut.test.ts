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
  gt,
  has,
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

// `V().out(T).has(k, pred).count()` walks the edge bucket and tallies, with no traversers
// (audit item 132). That shape is 86.7% generator plumbing, so the tally is 1.66x.
//
// THE ORACLE is again a forced decline — a leading `hasLabel('P')` makes it three intermediate
// steps, which the shortcut does not take, and the fixture's `P` is... NOT vacuous, so the
// comparison needs a label every vertex carries. `hasLabel('ALL')` is added for exactly that:
// a vacuous filter changes the route without changing the answer.
describe('a filtered hop count tallies the edge bucket', () => {
  const ages = [10, 20, 30, 40, 50, 60];
  const hop = (): Graph => {
    const g = new Graph();
    const vs = ages.map((age, i) =>
      g.addVertex({
        // `ALL` is on every vertex so a leading `hasLabel('ALL')` is a vacuous filter — the
        // forced-decline route has to answer the same question, not a narrower one.
        id: `h${i}`,
        labels: [...LABELS[i], 'ALL'],
        properties: { age },
      }),
    );

    for (const [a, b, label] of EDGES) {
      g.addEdge({ from: vs[a], to: vs[b], labels: [label], properties: {} });
    }

    return g;
  };

  test('it matches the arithmetic and the forced-decline route', () => {
    const g = hop();

    for (const [t, bound] of [
      ['E', 25],
      ['E', 5],
      ['E', 100],
      ['F', 25],
    ] as const) {
      // out(T): the far endpoint is the edge's TARGET.
      const wantOut = EDGES.filter(([, b, l]) => l === t && ages[b] > bound).length;

      expect(n(g, V(), out(t), has('age', gt(bound)), count())).toBe(wantOut);
      expect(n(g, V(), hasLabel('ALL'), out(t), has('age', gt(bound)), count())).toBe(wantOut);

      // in(T): the far endpoint is the edge's SOURCE.
      const wantIn = EDGES.filter(([a, , l]) => l === t && ages[a] > bound).length;

      expect(n(g, V(), in_(t), has('age', gt(bound)), count())).toBe(wantIn);
      expect(n(g, V(), hasLabel('ALL'), in_(t), has('age', gt(bound)), count())).toBe(wantIn);
    }

    // No type at all: every edge, filtered on its target.
    expect(n(g, V(), out(), has('age', gt(25)), count())).toBe(
      EDGES.filter(([, b]) => ages[b] > 25).length,
    );
  });

  test('an absent key matches nothing', () => {
    const g = hop();

    expect(n(g, V(), out('E'), has('nope', gt(0)), count())).toBe(0);
    expect(n(g, V(), hasLabel('ALL'), out('E'), has('nope', gt(0)), count())).toBe(0);
  });

  // Shapes the tally must decline, each checked against the same question another way.
  test('shapes it declines still answer correctly', () => {
    const g = hop();

    // `both()` makes a self-loop incident twice, so it is not a bucket walk.
    expect(n(g, V(), both('E'), has('age', gt(0)), count())).toBe(
      n(g, V(), hasLabel('ALL'), both('E'), has('age', gt(0)), count()),
    );
    // The second step is not a `has`.
    expect(n(g, V(), out('E'), hasLabel('Q'), count())).toBe(
      n(g, V(), hasLabel('ALL'), out('E'), hasLabel('Q'), count()),
    );
  });

  // One edge carrying two types is traversed ONCE by `out('E','F')`, so a bucket sum would
  // double-count it.
  test('a multi-type edge is counted once through the filter', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { age: 10 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { age: 90 } });

    g.addEdge({ from: a, to: b, labels: ['E', 'F'], properties: {} });

    expect(n(g, V(), out('E'), has('age', gt(50)), count())).toBe(1);
    expect(n(g, V(), out('E', 'F'), has('age', gt(50)), count())).toBe(1);
    expect(n(g, V(), out('E', 'F'), has('age', gt(95)), count())).toBe(0);
  });
});

// `V().out(T).dedupe().count()` reads the DISTINCT far endpoints off the reverse adjacency
// index — O(V) instead of O(E), and no Set of its own (audit item 133). 369.5 -> 6.8ms, 54x.
describe('a distinct hop count reads the reverse index', () => {
  const g = (): Graph => {
    const graph = new Graph();
    const vs = Array.from({ length: 6 }, (_, i) =>
      graph.addVertex({ id: `d${i}`, labels: [...LABELS[i], 'ALL'], properties: { k: i } }),
    );

    for (const [a, b, label] of EDGES) {
      graph.addEdge({ from: vs[a], to: vs[b], labels: [label], properties: {} });
    }

    return graph;
  };
  // Distinct targets / sources of the type-`t` edges, straight from the known edge list.
  const targets = (t?: string): number =>
    new Set(EDGES.filter(([, , l]) => t === undefined || l === t).map(([, b]) => b)).size;
  const sources = (t?: string): number =>
    new Set(EDGES.filter(([, , l]) => t === undefined || l === t).map(([a]) => a)).size;

  test('it matches the arithmetic and the forced-decline route', () => {
    const graph = g();

    for (const t of ['E', 'F']) {
      expect(n(graph, V(), out(t), dedupe(), count())).toBe(targets(t));
      expect(n(graph, V(), in_(t), dedupe(), count())).toBe(sources(t));
      // A vacuous leading `hasLabel('ALL')` makes it three intermediate steps, so the shortcut
      // declines and the same question runs through `dedupe`'s own Set.
      expect(n(graph, V(), hasLabel('ALL'), out(t), dedupe(), count())).toBe(targets(t));
      expect(n(graph, V(), hasLabel('ALL'), in_(t), dedupe(), count())).toBe(sources(t));
    }

    // No type: every edge.
    expect(n(graph, V(), out(), dedupe(), count())).toBe(targets());
    expect(n(graph, V(), in_(), dedupe(), count())).toBe(sources());
    expect(n(graph, V(), out(), dedupe(), count())).toBe(
      n(graph, V(), hasLabel('ALL'), out(), dedupe(), count()),
    );
    // PARALLEL edges and SELF-LOOPS are in the fixture: `[0,1]` appears once but `[3,3]` and
    // `[1,1]` are loops, so a vertex can be its own distinct target.
    expect(targets('E')).toBeLessThan(EDGES.filter(([, , l]) => l === 'E').length);
  });

  // MULTI-TYPE needs no extra condition here, unlike the edge counts: this counts VERTICES, and
  // "has an edge of any of these types" is a union per vertex. An edge carrying both types makes
  // its target qualify once either way — which a bucket SUM would get wrong.
  test('a multi-type edge does not double-count its endpoint', () => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['P', 'ALL'], properties: {} });
    const b = graph.addVertex({ id: 'b', labels: ['P', 'ALL'], properties: {} });

    graph.addEdge({ from: a, to: b, labels: ['E', 'F'], properties: {} });

    expect(n(graph, V(), out('E', 'F'), dedupe(), count())).toBe(1);
    expect(n(graph, V(), out('E', 'F'), dedupe(), count())).toBe(
      n(graph, V(), hasLabel('ALL'), out('E', 'F'), dedupe(), count()),
    );
  });

  // THE SUBTLE ONE. `deIndexEdgeLabel` removes a label's entry when its set empties but leaves
  // the per-vertex entry behind, so a vertex whose last `T` edge was DELETED is still a key in
  // the index. Counting keys rather than NON-EMPTY buckets would over-count it.
  test('a vertex whose last edge of that type was deleted is not counted', () => {
    const graph = new Graph();
    const a = graph.addVertex({ id: 'a', labels: ['ALL'], properties: {} });
    const b = graph.addVertex({ id: 'b', labels: ['ALL'], properties: {} });
    const c = graph.addVertex({ id: 'c', labels: ['ALL'], properties: {} });
    const keep = graph.addEdge({ from: a, to: b, labels: ['E'], properties: {} });
    const gone = graph.addEdge({ from: a, to: c, labels: ['E'], properties: {} });

    expect(n(graph, V(), out('E'), dedupe(), count())).toBe(2);

    graph.removeEdge(gone);

    expect(n(graph, V(), out('E'), dedupe(), count())).toBe(1);
    expect(n(graph, V(), out('E'), dedupe(), count())).toBe(
      n(graph, V(), hasLabel('ALL'), out('E'), dedupe(), count()),
    );

    graph.removeEdge(keep);

    expect(n(graph, V(), out('E'), dedupe(), count())).toBe(0);
    expect(n(graph, V(), hasLabel('ALL'), out('E'), dedupe(), count())).toBe(0);
    // The UNTYPED spelling walks a different branch (`anyNonEmpty`), so it gets the same
    // after-deletion check rather than inheriting the typed one's coverage.
    expect(n(graph, V(), out(), dedupe(), count())).toBe(0);
    expect(n(graph, V(), hasLabel('ALL'), out(), dedupe(), count())).toBe(0);
  });

  test('shapes it declines still answer correctly', () => {
    const graph = g();

    // `both()` reaches a vertex from either side, so it is not one index.
    expect(n(graph, V(), both('E'), dedupe(), count())).toBe(
      n(graph, V(), hasLabel('ALL'), both('E'), dedupe(), count()),
    );
    // A by-modulator dedupes on something other than the element. The by-key must REPEAT or
    // the case proves nothing: with `k: i` (unique per vertex) distinct-by-k equals
    // distinct-vertex, and a mutant that took the shortcut anyway passed. `grp` is `k % 2`.
    const grouped = new Graph();
    const gv = Array.from({ length: 6 }, (_, i) =>
      grouped.addVertex({ id: `g${i}`, labels: ['ALL'], properties: { grp: i % 2 } }),
    );

    for (const [a, b, label] of EDGES) {
      grouped.addEdge({ from: gv[a], to: gv[b], labels: [label], properties: {} });
    }

    // Distinct targets of E is more than the distinct `grp` values among them (there are two),
    // so the shortcut's answer and the by-modulated answer MUST differ.
    expect(n(grouped, V(), out('E'), dedupe().by('grp'), count())).toBe(
      n(grouped, V(), hasLabel('ALL'), out('E'), dedupe().by('grp'), count()),
    );
    expect(n(grouped, V(), out('E'), dedupe().by('grp'), count())).not.toBe(
      n(grouped, V(), out('E'), dedupe(), count()),
    );
  });
});

// `V().out(T).has(k, pred).count()` is answered from the FAR side since audit item 168: one
// predicate test per far VERTEX contributing that vertex's degree, instead of one per EDGE with
// a vertex lookup to go with it. Measured 130.1ms -> 50.4ms on the 1,000,000-edge bench (3.06x
// in isolation), because the per-edge far lookup was a random-order cache miss.
//
// THE ORACLE IS NOT `dedupe()` HERE, and that mistake is worth recording: the note at the top of
// this file says `dedupe()` is the identity "over a frontier that is already distinct", and the
// frontier after `out()` is NOT — vertex 2 is the target of two `E` edges, so `dedupe()` folds
// 3 rows into 2 and reads as a wrong answer. The decline used instead is the SAME filter twice:
// `countShortcut` takes only `mid.length === 2`, so a second `has` pushes the question through
// the general walk, and an idempotent filter cannot change the count.
const declined = (g: Graph, ...steps: Parameters<typeof traversal>): number => n(g, ...steps);

describe('a filtered hop count is answered from the far side', () => {
  // E edges: 0->1, 0->2, 1->2, 3->3.  F edges: 2->0, 3->1, 1->1.
  // Far endpoints of out('E'): 1, 2, 2, 3 — so k = 1, 2, 2, 3 and `gt(1)` keeps three.
  test('a single-type out hop matches the forced decline and the arithmetic', () => {
    const g = build();

    expect(n(g, V(), out('E'), has('k', gt(1)), count())).toBe(3);
    expect(n(g, V(), out('E'), has('k', gt(1)), count())).toBe(
      declined(g, V(), out('E'), has('k', gt(1)), has('k', gt(1)), count()),
    );
  });

  test('a vertex with SEVERAL in-edges contributes its whole degree', () => {
    // Vertex 2 is the far end of TWO `E` edges (0->2 and 1->2), and `gt(1)` keeps it. Counting
    // the vertex once instead of twice is the one mistake the flip makes available, and it
    // would read 2 here.
    const g = build();

    expect(n(g, V(), out('E'), has('k', gt(1)), count())).toBe(3);
    // Only vertex 2 and vertex 3 pass; 2 brings two edges and 3 brings one.
    expect(n(g, V(), out('E'), has('k', gt(2)), count())).toBe(1);
  });

  test('the IN direction reads the mirror index', () => {
    // Sources of the `E` edges are 0, 0, 1, 3 — k = 0, 0, 1, 3, so `gt(1)` keeps one.
    const g = build();

    expect(n(g, V(), in_('E'), has('k', gt(1)), count())).toBe(1);
    expect(n(g, V(), in_('E'), has('k', gt(1)), count())).toBe(
      declined(g, V(), in_('E'), has('k', gt(1)), has('k', gt(1)), count()),
    );
  });

  test('an UNTYPED hop sums every type', () => {
    // All seven edges; far ends 1,2,2,0,3,1,1 — k the same, so `gt(1)` keeps three.
    const g = build();

    expect(n(g, V(), out(), has('k', gt(1)), count())).toBe(3);
    expect(n(g, V(), out(), has('k', gt(1)), count())).toBe(
      declined(g, V(), out(), has('k', gt(1)), has('k', gt(1)), count()),
    );
  });

  test('an untyped hop sums every type OF ONE VERTEX, not just its first', () => {
    // `gt(1)` above cannot see this: vertex 1 is the only far endpoint whose in-edges span TWO
    // types ({E: 1, F: 2}), and k=1 FAILS `gt(1)`, so its degree never reaches the total. A
    // mutant summing only the first type bucket survived every test until this one.
    //
    // `gt(0)` keeps vertices 1 (deg 3), 2 (deg 2) and 3 (deg 1) and drops vertex 0 (k=0), so
    // the answer is 6 — and 4 if only the first bucket of vertex 1 counted.
    const g = build();

    expect(n(g, V(), out(), has('k', gt(0)), count())).toBe(6);
    expect(n(g, V(), out(), has('k', gt(0)), count())).toBe(
      declined(g, V(), out(), has('k', gt(0)), has('k', gt(0)), count()),
    );
  });

  test('a MULTI-TYPE hop with no multi-type edge sums the named buckets', () => {
    const g = build();

    expect(n(g, V(), out('E', 'F'), has('k', gt(1)), count())).toBe(3);
    expect(n(g, V(), out('E', 'F'), has('k', gt(1)), count())).toBe(
      declined(g, V(), out('E', 'F'), has('k', gt(1)), has('k', gt(1)), count()),
    );
  });

  test('a multi-type hop sums BOTH named types of one vertex', () => {
    // The named-type mirror of the test above, and it caught the same class of mutant.
    const g = build();

    expect(n(g, V(), out('E', 'F'), has('k', gt(0)), count())).toBe(6);
    // One type at a time, so the sum above cannot be a coincidence: E gives 4, F gives 3, and
    // `gt(0)` drops vertex 0's single F edge — 4 + 2 = 6.
    expect(n(g, V(), out('E'), has('k', gt(0)), count())).toBe(4);
    expect(n(g, V(), out('F'), has('k', gt(0)), count())).toBe(2);
  });

  test('a multi-type hop WITH a two-type edge stays on the edge-driven walk', () => {
    // Summing per-vertex buckets would count a two-type edge twice. The vertex-driven form is
    // declined here, and the answer must still be the general walk's.
    const g = build();
    const vs = [...g.vertices];

    g.addEdge({ from: vs[4], to: vs[2], labels: ['E', 'F'], properties: {} });

    expect(g.multiTypeEdgeCount).toBeGreaterThan(0);
    expect(n(g, V(), out('E', 'F'), has('k', gt(1)), count())).toBe(
      declined(g, V(), out('E', 'F'), has('k', gt(1)), has('k', gt(1)), count()),
    );
  });

  test('a self-loop is counted once', () => {
    // 3->3 is an `E` self-loop and sits in BOTH adjacency indexes; the walk reads one, so it
    // must contribute exactly 1. k=3 passes `gt(2)`, and nothing else does.
    const g = build();

    expect(n(g, V(), out('E'), has('k', gt(2)), count())).toBe(1);
    expect(n(g, V(), out('E'), has('k', gt(2)), count())).toBe(
      declined(g, V(), out('E'), has('k', gt(2)), has('k', gt(2)), count()),
    );
  });

  test('`both` still declines, as it always did', () => {
    // `both` double-counts a self-loop, which is why it was never on this path.
    const g = build();

    expect(n(g, V(), both('E'), has('k', gt(1)), count())).toBe(
      declined(g, V(), both('E'), has('k', gt(1)), has('k', gt(1)), count()),
    );
  });
});

describe('the filtered hop count agrees with the general walk on a cross-type compare', () => {
  /** `s` carries a STRING `k`, where every other vertex carries a number. */
  const mixed = (withEdge: boolean): Graph => {
    const g = new Graph();
    const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
    const s = g.addVertex({ id: 's', labels: ['P'], properties: { k: 'text' } });

    g.addEdge({ from: a, to: b, labels: ['E'], properties: {} });

    if (withEdge) {
      g.addEdge({ from: a, to: s, labels: ['E'], properties: {} });
    }

    return g;
  };

  // I expected `gt(0)` against `'text'` to THROW here (the note on the predicate comparator in
  // `predicates.ts` says it does, mirroring TinkerPop's ClassCastException) and wrote two tests
  // asserting a throw. Both failed: `has` filters the incomparable value out instead. So what
  // is pinned is the behaviour the engine actually has, on BOTH paths — which is the parity that
  // matters either way.
  test('an incomparable value is filtered, not raised, on both paths', () => {
    for (const withEdge of [false, true]) {
      const g = mixed(withEdge);

      expect(n(g, V(), out('E'), has('k', gt(0)), count())).toBe(1);
      expect(n(g, V(), out('E'), has('k', gt(0)), count())).toBe(
        declined(g, V(), out('E'), has('k', gt(0)), has('k', gt(0)), count()),
      );
    }
  });

  test('a string predicate against numbers agrees too', () => {
    for (const withEdge of [false, true]) {
      const g = mixed(withEdge);

      expect(n(g, V(), out('E'), has('k', gt('aa')), count())).toBe(
        declined(g, V(), out('E'), has('k', gt('aa')), has('k', gt('aa')), count()),
      );
    }
  });

  test('a vertex with no edge of the queried type is never tested', () => {
    // `s` is not a far endpoint of any `E` edge when `withEdge` is false. The flip iterates
    // VERTICES, so it could start evaluating it; the degree-0 skip is what prevents that. The
    // observable consequence is only the count here, since nothing throws.
    const g = mixed(false);

    expect(n(g, V(), out('E'), has('k', gt(0)), count())).toBe(1);
    expect(n(g, V(), out('E'), count())).toBe(1);
  });
});
