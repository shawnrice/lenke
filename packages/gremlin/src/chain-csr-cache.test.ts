// `slotChainCount`'s adjacency CSR is cached ACROSS traversals, keyed on `graph.topologyVersion`
// plus the direction and edge labels every hop walks (item 1678).
//
// ⚠️ EVERY TEST HERE IS AN INVALIDATION TEST, AND THE 2,017 TESTS ALREADY IN THIS PACKAGE CANNOT BE.
// A cache that never invalidates returns the correct answer for every read-only traversal ever
// written; the whole suite passed on the first build of this one and would have passed on a broken
// one. The failure mode is "traverse, write, traverse".
//
// ⚠️ THE ROUTE HAS TWO ADMISSION CONDITIONS and a test that misses either exercises a DIFFERENT
// route and proves nothing about this cache:
//
//     oneWalkThroughout(hops) && seeds.length > Math.max(graph.vertexCount >> 4, 1024)
//
// so every hop must walk the same index with the same labels, the seed set must be WIDE — past 1024
// vertices — and the chain must be at least THREE hops, since a 2-hop unfiltered count is answered
// by the degree inner product instead. `seedWidth` below is why these fixtures are not three
// vertices.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { V, count, hasLabel, in_, out, toArray, traversal } from './index.js';

/** Past `max(vertexCount >> 4, 1024)`, which is what admits the dense-slot route at all. */
const WIDE = 1100;

const chain = (hops: number) => {
  const steps = [V(), hasLabel('P'), ...Array.from({ length: hops }, () => out('E'))];

  return traversal(...steps, count());
};

const CHAIN3 = chain(3);

const countOf = (g: Graph, plan = CHAIN3): number => Number(toArray(plan, g)[0] ?? 0);

/**
 * `WIDE` vertices in a ring, every one `:P` with one `:E` edge to the next. A 3-hop count over a
 * ring of N is exactly N, which makes every assertion below readable by hand.
 */
const ring = (): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < WIDE; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
  }

  for (let i = 0; i < WIDE; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[(i + 1) % WIDE],
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

describe('the route is actually being taken', () => {
  /**
   * ⚠️ FIRST, BECAUSE EVERY OTHER TEST HERE IS VACUOUS IF IT IS NOT. If the fixture fell below the
   * seed-width threshold, or the chain were two hops, these would all pass against a route with no
   * cache in it and say nothing. A ring of N has exactly N k-walks for every k, so the arithmetic
   * also pins the traversal.
   */
  test('a wide 3-hop chain over a ring counts the ring', () => {
    const g = ring();

    expect(g.vertexCount).toBeGreaterThan(Math.max(g.vertexCount >> 4, 1024));
    expect(countOf(g)).toBe(WIDE);
    expect(countOf(g, chain(4))).toBe(WIDE);
  });
});

describe('a write between two identical traversals', () => {
  test('an added edge is seen by the second traversal', () => {
    const g = ring();

    expect(countOf(g)).toBe(WIDE);

    // A second edge out of v0 doubles the walks that start by leaving v0, and also every walk that
    // passes through v0. Rather than hand-derive it, assert it MOVED and that a fresh graph with the
    // same edge agrees — the cache is what is under test, not the arithmetic.
    const add = (h: Graph): void => {
      h.addEdge({
        id: 'extra',
        from: h.getVertexById('v0')!,
        to: h.getVertexById('v500')!,
        labels: ['E'],
        properties: {},
      });
    };

    add(g);

    const fresh = ring();
    add(fresh);

    expect(countOf(g)).toBe(countOf(fresh));
    expect(countOf(g)).not.toBe(WIDE);
  });

  test('a removed edge is seen by the second traversal', () => {
    const g = ring();

    expect(countOf(g)).toBe(WIDE);

    g.removeEdge(g.getEdgeById('e0')!);

    // The ring is now a path, so the 3-hop walks are only those with room to run.
    expect(countOf(g)).toBe(WIDE - 3);
  });

  test('a removed vertex is seen by the second traversal', () => {
    const g = ring();

    expect(countOf(g)).toBe(WIDE);

    g.removeVertex(g.getVertexById('v0')!);

    const fresh = ring();
    fresh.removeVertex(fresh.getVertexById('v0')!);

    expect(countOf(g)).toBe(countOf(fresh));
    expect(countOf(g)).not.toBe(WIDE);
  });

  /**
   * ⚠️ THE CASE A FOUR-SITE TOPOLOGY COUNTER GOT WRONG (item 1675). The adjacency boxes are keyed BY
   * EDGE TYPE and `labels` selects buckets from them, so `addLabelToEdge` moves an edge into the `E`
   * bucket through `indexEdgeLabel` without touching `insertEdge`, `edgesById`, or the vertex set.
   */
  test('⚠️ an edge GAINING the walked label is seen by the second traversal', () => {
    const g = ring();

    // Added as `F`, so the `:E` chain cannot see it yet.
    g.addEdge({
      id: 'extra',
      from: g.getVertexById('v0')!,
      to: g.getVertexById('v500')!,
      labels: ['F'],
      properties: {},
    });
    expect(countOf(g)).toBe(WIDE);

    g.addLabelToEdge('E', g.getEdgeById('extra')!);

    expect(countOf(g)).not.toBe(WIDE);
  });

  test('⚠️ an edge LOSING the walked label is seen by the second traversal', () => {
    const g = ring();

    g.addLabelToEdge('F', g.getEdgeById('e0')!);
    expect(countOf(g)).toBe(WIDE);

    g.removeLabelFromEdge('E', g.getEdgeById('e0')!);

    // `e0` is now `:F` only, so the `:E` ring is a path.
    expect(countOf(g)).toBe(WIDE - 3);
  });
});

describe('the shape is part of the key, not just the topology', () => {
  /**
   * ⚠️ OUT AND IN CANNOT BE TOLD APART BY A WHOLE-GRAPH WALK COUNT, AND THAT IS A THEOREM, NOT A
   * FIXTURE PROBLEM. Reversing every edge is a BIJECTION on walks, so the number of k-walks in `G`
   * equals the number in `G` reversed — for every k, on every graph. The first two attempts at this
   * test were a ring and then a star, both of which dutifully reported equal counts, and a mutant
   * that dropped the direction from the cache key SURVIVED both.
   *
   * What breaks the symmetry is the SEED SET. Seeding only `:P` while the chain's far end is `:Q`
   * makes the two directions ask different questions:
   *
   *     hub(:Q) -> a(:P) -> b(:P) -> c(:P)
   *
   * Forwards from a `:P` vertex the longest run is `a -> b -> c`, two hops, so there is no 3-walk at
   * all. Backwards from `c` it is `c <- b <- a <- hub`, three hops, one per spoke. 0 against WIDE.
   */
  test('⚠️ an inward chain does not read the outward CSR', () => {
    const g = new Graph();
    const hub = g.addVertex({ id: 'hub', labels: ['Q'], properties: {} });

    for (let i = 0; i < WIDE; i += 1) {
      const a = g.addVertex({ id: `a${i}`, labels: ['P'], properties: {} });
      const b = g.addVertex({ id: `b${i}`, labels: ['P'], properties: {} });
      const c = g.addVertex({ id: `c${i}`, labels: ['P'], properties: {} });

      g.addEdge({ id: `h${i}`, from: hub, to: a, labels: ['E'], properties: {} });
      g.addEdge({ id: `p${i}`, from: a, to: b, labels: ['E'], properties: {} });
      g.addEdge({ id: `q${i}`, from: b, to: c, labels: ['E'], properties: {} });
    }

    const outward = Number(
      toArray(traversal(V(), hasLabel('P'), out('E'), out('E'), out('E'), count()), g)[0] ?? 0,
    );
    const inward = Number(
      toArray(traversal(V(), hasLabel('P'), in_('E'), in_('E'), in_('E'), count()), g)[0] ?? 0,
    );

    expect(outward).toBe(0);
    expect(inward).toBe(WIDE);

    // Interleaved, so neither direction can be served from the other's entry on a second ask.
    expect(
      Number(
        toArray(traversal(V(), hasLabel('P'), out('E'), out('E'), out('E'), count()), g)[0] ?? 0,
      ),
    ).toBe(0);
    expect(
      Number(
        toArray(traversal(V(), hasLabel('P'), in_('E'), in_('E'), in_('E'), count()), g)[0] ?? 0,
      ),
    ).toBe(WIDE);
  });

  /**
   * ⚠️ THE TWO LABELS MUST GIVE DIFFERENT COUNTS, which the first version of this test did not
   * arrange — it built an `:E` ring and an `:F` ring, both counting WIDE, so a mutant that dropped
   * the labels from the cache key answered correctly and SURVIVED. A cache test whose two shapes
   * agree cannot detect a key that conflates them.
   *
   * Here `:E` is the full ring (WIDE 3-walks) and `:F` is a single 3-chain (exactly one), so serving
   * either from the other's entry is immediately visible.
   */
  test('⚠️ a different edge label does not read another label’s CSR', () => {
    const g = ring();

    // One `:F` 3-chain, and nothing else carries `:F`.
    g.addEdge({
      id: 'f0',
      from: g.getVertexById('v0')!,
      to: g.getVertexById('v1')!,
      labels: ['F'],
      properties: {},
    });
    g.addEdge({
      id: 'f1',
      from: g.getVertexById('v1')!,
      to: g.getVertexById('v2')!,
      labels: ['F'],
      properties: {},
    });
    g.addEdge({
      id: 'f2',
      from: g.getVertexById('v2')!,
      to: g.getVertexById('v3')!,
      labels: ['F'],
      properties: {},
    });

    const fPlan = traversal(V(), hasLabel('P'), out('F'), out('F'), out('F'), count());

    expect(countOf(g)).toBe(WIDE);
    expect(countOf(g, fPlan)).toBe(1);
    // Alternate, so neither can be served from the other's entry.
    expect(countOf(g)).toBe(WIDE);
    expect(countOf(g, fPlan)).toBe(1);
  });

  /**
   * ⚠️ MORE DISTINCT SHAPES THAN THE CAP, which no key mutant can reach: clearing a cache can only
   * cost a rebuild, never return a wrong answer. So the property is that crossing the cap breaks
   * nothing.
   */
  test('more distinct labels than the shape cap still answer correctly', () => {
    const g = ring();
    const labels = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'TA', 'TB'];

    labels.forEach((t, j) => {
      for (let i = 0; i < WIDE; i += 1) {
        g.addEdge({
          id: `${t}-${i}`,
          from: g.getVertexById(`v${i}`)!,
          to: g.getVertexById(`v${(i + 1 + j) % WIDE}`)!,
          labels: [t],
          properties: {},
        });
      }
    });

    const ask = (t: string): number =>
      Number(toArray(traversal(V(), hasLabel('P'), out(t), out(t), out(t), count()), g)[0] ?? 0);

    for (const t of labels) {
      expect(ask(t)).toBe(WIDE);
    }

    // Second pass reads back whatever survived the clear.
    for (const t of labels) {
      expect(ask(t)).toBe(WIDE);
    }
  });
});

describe('what the cache must NOT hold', () => {
  /**
   * A vertex label write does not bump `topologyVersion` and must not need to: the CSR numbers every
   * vertex regardless of label. What a label change moves is which vertices the traversal SEEDS,
   * and that is read per call.
   */
  test('a vertex label write changes the answer even though the CSR did not', () => {
    const g = ring();

    expect(countOf(g)).toBe(WIDE);

    g.removeLabelFromVertex('P', g.getVertexById('v0')!);

    // v0 is no longer seeded, so the walks starting there are gone.
    expect(countOf(g)).toBe(WIDE - 1);
  });
});

describe('transactions', () => {
  test('a committed write is seen by the next traversal', () => {
    const g = ring();

    expect(countOf(g)).toBe(WIDE);

    g.transaction(() => {
      g.removeEdge(g.getEdgeById('e0')!);
    });

    expect(countOf(g)).toBe(WIDE - 3);
  });

  /**
   * ⚠️ A ROLLBACK MUST NOT LEAVE THE PRE-TRANSACTION ENTRY SERVING THE POST-ROLLBACK GRAPH. It does
   * not, because the undo log replays inverses through the same public mutators and so bumps the
   * version again — the entry is rebuilt rather than restored, which over-invalidates by one build
   * and cannot under-invalidate.
   */
  test('a rolled-back write leaves the next traversal correct', () => {
    const g = ring();

    expect(countOf(g)).toBe(WIDE);

    expect(() =>
      g.transaction(() => {
        g.removeEdge(g.getEdgeById('e0')!);

        throw new Error('rollback');
      }),
    ).toThrow('rollback');

    expect(countOf(g)).toBe(WIDE);
  });
});

describe('two graphs do not share an entry', () => {
  test('a second graph with a different topology gets its own CSR', () => {
    const g1 = ring();
    const g2 = ring();

    g2.removeEdge(g2.getEdgeById('e0')!);

    expect(countOf(g1)).toBe(WIDE);
    expect(countOf(g2)).toBe(WIDE - 3);
    // Interleaved, in case the cache were keyed on anything but graph identity.
    expect(countOf(g1)).toBe(WIDE);
    expect(countOf(g2)).toBe(WIDE - 3);
  });
});
