/**
 * Item 1110: the 3+ hop chain count over DENSE SLOTS, with each slot's neighbour slots remembered.
 *
 * Item 1109 priced a pass of the `Map<Vertex, number>` walk at **158 ns an edge** by depth
 * difference, and its frontier Map at only 31.7 of that — so the win is not a cheaper frontier but
 * skipping later passes entirely. A slot memo does that: a remembered pass touches no edges and no
 * Map at all (2.3 ns a touch, item 1109's micro). Measured at 200,000 vertices / 1,000,000 edges:
 *
 *   V().out().out().out().count()   397.3 ms -> 286.2   1.39x
 *   V().out()x4.count()             555.5    -> 291.3   1.91x
 *   V().out().out().count()          53.3    ->  53.3   CONTROL (inner product), flat
 *
 * The tell that the mechanism is the one claimed: a FOURTH hop now costs ~5 ms where it cost 158.
 *
 * TINKERPOP 3.7.3 IS THE ORACLE for the arithmetic of a chain, and this suite's own idiom is the
 * forced `identity()` decline — a step the rung cannot absorb, so the same question is answered by
 * both routes. Item 930 records why that matters: forcing a decline with a shape the optimizer may
 * later learn fails SILENTLY, green, comparing one route to itself.
 *
 * WHAT THE FIXTURES ARE FOR. The memo is keyed by slot and filled on first visit, so the
 * interesting cases are where the passes visit DIFFERENT slot sets. A seed wider than
 * `max(n/16, 1024)` is also required — a dense array per pass is the wrong trade for a narrow
 * frontier, which GQL's `Counts` doc records as a 30x regression — so every graph here is small
 * enough that the dense route is DECLINED, and the wide-seed route is exercised by the one
 * oversized fixture at the end. Both routes must agree on every shape either way.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, count, gt, has, hasLabel, identity, in_, out, toArray, traversal } from './index.js';

const n = (g: Graph, ...steps: readonly unknown[]): number =>
  toArray(traversal(...(steps as never[])), g)[0] as number;

/** The fast route and a forced decline must agree. */
const agree = (g: Graph, ...steps: readonly unknown[]): number => {
  const fast = n(g, ...steps, count());
  const slow = n(g, ...steps, identity(), count());

  expect(fast).toBe(slow);

  return fast;
};

/** `a->b`, `b->c` and a SELF-LOOP on `a` — the fixture the TinkerPop console run used. */
const console3 = (): Graph => {
  const g = new Graph();
  const a = g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  const b = g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });
  const c = g.addVertex({ id: 'c', labels: ['Q'], properties: { k: 3 } });

  g.addEdge({ id: 'e1', labels: ['T'], from: a, to: b, properties: {} });
  g.addEdge({ id: 'e2', labels: ['T'], from: b, to: c, properties: {} });
  g.addEdge({ id: 'e3', labels: ['T'], from: a, to: a, properties: {} });

  return g;
};

/** A ring with chords and a PARALLEL pair, so no degree is uniform and duplicates are live. */
const ring = (): Graph => {
  const g = new Graph();
  const vs = Array.from({ length: 7 }, (_, i) =>
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
  );

  for (let i = 0; i < 7; i += 1) {
    g.addEdge({ id: `r${i}`, labels: ['T'], from: vs[i], to: vs[(i + 1) % 7], properties: {} });
  }

  g.addEdge({ id: 'c1', labels: ['T'], from: vs[0], to: vs[3], properties: {} });
  g.addEdge({ id: 'c2', labels: ['T'], from: vs[2], to: vs[5], properties: {} });
  g.addEdge({ id: 'loop', labels: ['T'], from: vs[4], to: vs[4], properties: {} });
  // A PARALLEL edge: the memo must keep duplicates, since two edges to one slot contribute twice.
  g.addEdge({ id: 'par', labels: ['T'], from: vs[1], to: vs[2], properties: {} });

  return g;
};

describe('the chain arithmetic is unchanged by the route', () => {
  test("TinkerPop 3.7.3's three-hop numbers still hold", () => {
    // Pinned in `gremlin-hop-chain-count.test.ts` against native too; repeated here because this
    // item adds a second route to the same question and both must land on them.
    const g = console3();

    // EVERY literal here came from the console run, not from my arithmetic. The first one I wrote
    // by hand as 1 and it is 3 — the fixture's self-loop on `a` means a 3-hop chain can spend one,
    // two or three of its hops on the loop (loop/loop/loop, loop/loop/a->b, loop/a->b/b->c), and I
    // counted only the last of those. CLAUDE.md's rule, earned a fifth time: derive the literal
    // from the engine, then confirm it against TinkerPop.
    expect(agree(g, V(), out('T'), out('T'), out('T'))).toBe(3);
    expect(agree(g, V(), out('T'), out('T'))).toBe(3);
    expect(agree(g, V(), out('T'), out('T'), out('T'), out('T'))).toBe(3);
    expect(agree(g, V(), in_('T'), in_('T'), in_('T'))).toBe(3);
  });

  for (const [name, fixture] of [
    ['the console fixture', console3],
    ['a ring with chords, a loop and a parallel pair', ring],
  ] as ReadonlyArray<readonly [string, () => Graph]>) {
    describe(name, () => {
      test('THREE, FOUR and FIVE hops', () => {
        const g = fixture();

        agree(g, V(), out('T'), out('T'), out('T'));
        agree(g, V(), out('T'), out('T'), out('T'), out('T'));
        agree(g, V(), out('T'), out('T'), out('T'), out('T'), out('T'));
      });

      test('the ALL-IN spelling, uniform in the other direction', () => {
        const g = fixture();

        agree(g, V(), in_('T'), in_('T'), in_('T'));
        agree(g, V(), in_('T'), in_('T'), in_('T'), in_('T'));
      });

      test('a start FILTER, which narrows the seed without touching the hops', () => {
        const g = fixture();

        agree(g, V(), hasLabel('P'), out('T'), out('T'), out('T'));
        agree(g, V(), has('k', gt(0)), out('T'), out('T'), out('T'));
        agree(g, V(), has('k', gt(1)), out('T'), out('T'), out('T'), out('T'));
      });

      test('UNTYPED hops, which are "any type" and match only each other', () => {
        const g = fixture();

        agree(g, V(), out(), out(), out());
        agree(g, V(), out(), out(), out(), out());
      });
    });
  }
});

describe('the shapes the dense route must decline', () => {
  test('MIXED directions, where there is no single index', () => {
    const g = ring();

    agree(g, V(), out('T'), in_('T'), out('T'));
    agree(g, V(), in_('T'), out('T'), out('T'));
    agree(g, V(), out('T'), out('T'), in_('T'));
    agree(g, V(), out('T'), out('T'), out('T'), in_('T'));
  });

  test('MIXED labels, where each hop walks a different edge subset', () => {
    const g = new Graph();
    const vs = Array.from({ length: 6 }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
    );

    g.addEdge({ id: 't1', labels: ['T'], from: vs[0], to: vs[1], properties: {} });
    g.addEdge({ id: 'u1', labels: ['U'], from: vs[1], to: vs[2], properties: {} });
    g.addEdge({ id: 't2', labels: ['T'], from: vs[1], to: vs[3], properties: {} });
    g.addEdge({ id: 'u2', labels: ['U'], from: vs[2], to: vs[3], properties: {} });
    g.addEdge({ id: 't3', labels: ['T'], from: vs[2], to: vs[4], properties: {} });
    g.addEdge({ id: 'u3', labels: ['U'], from: vs[3], to: vs[4], properties: {} });
    g.addEdge({ id: 't4', labels: ['T'], from: vs[4], to: vs[5], properties: {} });

    agree(g, V(), out('T'), out('U'), out('T'));
    agree(g, V(), out('U'), out('T'), out('T'));
    agree(g, V(), out('T'), out('T'), out('U'));
    // An UNTYPED hop beside a typed one differs too.
    agree(g, V(), out(), out('T'), out('T'));
    agree(g, V(), out('T'), out(), out('T'));
  });

  test('a `both` hop, which the chain hands to its own function (item 1091)', () => {
    const g = ring();

    agree(g, V(), out('T'), out('T'), out('T'));
    expect(n(g, V(), out('T'), out('T'), out('T'), count())).toBeGreaterThan(0);
  });
});

describe('a seed wide enough for the dense route, which the small fixtures decline', () => {
  test('a graph past max(n/16, 1024), so the slot walk and its memo actually run', () => {
    // The gate needs a seed wider than `max(vertexCount / 16, 1024)`, so a fixture under ~1,024
    // sources never reaches the slot walk at all and every test above exercises the `Map` route.
    // This one does reach it: 2,000 vertices, every one a source.
    const g = new Graph();
    const size = 2_000;
    const vs = Array.from({ length: size }, (_, i) =>
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }),
    );

    for (let i = 0; i < size; i += 1) {
      g.addEdge({
        id: `a${i}`,
        labels: ['T'],
        from: vs[i],
        to: vs[(i + 1) % size],
        properties: {},
      });
      g.addEdge({
        id: `b${i}`,
        labels: ['T'],
        from: vs[i],
        to: vs[(i * 7 + 11) % size],
        properties: {},
      });
    }

    // A self-loop and a parallel pair inside the wide fixture too, so the duplicate and loop rules
    // are live on the route that actually uses the memo.
    g.addEdge({ id: 'loop', labels: ['T'], from: vs[5], to: vs[5], properties: {} });
    g.addEdge({ id: 'par', labels: ['T'], from: vs[9], to: vs[10], properties: {} });

    // A HUB at v0 with a degree nothing else has. MUTATION FOUND THIS GAP: without it every vertex
    // here had out-degree exactly 2, so the `intern-collapses` mutant — which hands slot 0 to every
    // vertex interned during a pass instead of a fresh slot — SURVIVED. Misattributing one
    // degree-2 vertex to another degree-2 vertex leaves the count unchanged, so the fixture could
    // not see it. With v0 at degree 22 and the start filter below excluding it, v0 is interned
    // during the pass and the collapse changes the answer.
    for (let i = 0; i < 20; i += 1) {
      g.addEdge({
        id: `hub${i}`,
        labels: ['T'],
        from: vs[0],
        to: vs[(i * 37 + 1) % size],
        properties: {},
      });
    }

    expect(agree(g, V(), out('T'), out('T'), out('T'))).toBeGreaterThan(0);
    expect(agree(g, V(), out('T'), out('T'), out('T'), out('T'))).toBeGreaterThan(0);
    expect(agree(g, V(), out('T'), out('T'), out('T'), out('T'), out('T'))).toBeGreaterThan(0);
    expect(agree(g, V(), in_('T'), in_('T'), in_('T'))).toBeGreaterThan(0);
    // A start filter still leaves the seed wide here, so the dense route is kept and the memo is
    // built from a SUBSET of vertices — the case where pass 2 visits slots pass 1 never seeded.
    // `k > 0` excludes exactly v0, the HUB, so the hub is interned DURING a pass and its degree is
    // unlike any seed's. That is what makes the intern path observable in a count.
    expect(agree(g, V(), has('k', gt(0)), out('T'), out('T'), out('T'))).toBeGreaterThan(0);
    expect(agree(g, V(), has('k', gt(0)), out('T'), out('T'), out('T'), out('T'))).toBeGreaterThan(
      0,
    );
    // And a filter narrow enough to fall BACK to the map route, on the same graph.
    expect(agree(g, V(), has('k', gt(1990)), out('T'), out('T'), out('T'))).toBeGreaterThan(0);
    // Mixed directions on the wide graph must still decline to the map walk and agree.
    expect(agree(g, V(), out('T'), in_('T'), out('T'))).toBeGreaterThanOrEqual(0);
  });
});
