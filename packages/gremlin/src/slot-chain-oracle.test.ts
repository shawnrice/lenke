import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { V, count, hasLabel, out, toArray, traversal } from './index.js';

/**
 * `slotChainCount` against an INDEPENDENT WALK — the oracle `slot-chain-count.test.ts` does not have
 * (item 1423).
 *
 * ⚠️ THIS FILE EXISTS BECAUSE I ALMOST DESTROYED THAT ONE. Item 1110 already wrote
 * `slot-chain-count.test.ts` — TinkerPop 3.7.3 ground truth, three/four/five hops, the shapes the
 * dense route must decline, and a seed wide enough that the memo actually runs. I wrote a file of
 * the same name over it, and the only reason it surfaced is that a mutant which had been CAUGHT
 * (`off = base + 1`) suddenly survived: the test that caught it was the one I had just deleted. The
 * suite total went 1203 → 1199 and that four-test drop is what there was to notice.
 *
 * So what follows is only what item 1110's file does NOT do, under a name that cannot collide:
 *
 *   * an INDEPENDENT ORACLE — a hand-written k-hop follow over the same adjacency. Item 1110
 *     compares the dense route against TinkerPop's recorded numbers and against its own
 *     route-vs-route decline, both of which are stronger for CONFORMANCE; a brute-force walk shares
 *     nothing with the engine but the graph, which is what makes it an arithmetic check.
 *   * a SELF-LOOP, which contributes exactly one walk at every depth.
 *   * OUT-DEGREE 2, so memo runs exceed one entry and `(off, len)` must be right relative to each
 *     other — a path gives every run length 1, where an off-by-one WITHIN a run is invisible.
 *
 * The memo is written on pass 1 and read from pass 2, and a k-hop chain runs k-1 passes, so 2 hops
 * never read it and 3+ do. Every case here is 3 hops or more, with a 2-hop contrast.
 */

const build = (n: number, edges: (i: number, n: number) => number[]): Graph => {
  const g = new Graph();
  const vs: Vertex[] = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
  }

  let e = 0;

  for (let i = 0; i < n; i += 1) {
    for (const to of edges(i, n)) {
      g.addEdge({ id: `e${e}`, from: vs[i], to: vs[to], labels: ['E'] });
      e += 1;
    }
  }

  return g;
};

/** Follow `hops` `E` edges from every vertex and count the complete walks. Shares only the graph. */
const bruteForce = (g: Graph, hops: number): number => {
  let total = 0;

  for (const v of g.vertices) {
    let frontier: Vertex[] = [v];

    for (let h = 0; h < hops; h += 1) {
      const next: Vertex[] = [];

      for (const u of frontier) {
        const bucket = u.adjFrom?.get('E');

        if (bucket !== undefined) {
          for (const edge of bucket) {
            next.push(edge.to);
          }
        }
      }

      frontier = next;
    }

    total += frontier.length;
  }

  return total;
};

const chain = (hops: number): ReturnType<typeof traversal> =>
  traversal(V(), hasLabel('P'), ...Array.from({ length: hops }, () => out('E')), count());

const countOf = (g: Graph, hops: number): number => toArray(chain(hops), g)[0] as number;

/** A PATH has sinks, so slots differ in what they contribute — see item 1418 on why that matters. */
const path = (n: number): Graph => build(n, (i, m) => (i + 1 < m ? [i + 1] : []));
/** Out-degree 2 with a wrap on one leg: runs longer than one entry, and slots that repeat. */
const branchy = (n: number): Graph =>
  build(n, (i, m) => (i + 1 < m ? [i + 1, (i + 7) % m] : [(i + 7) % m]));

describe('the 3+ hop chain count agrees with an independent walk (item 1423)', () => {
  for (const hops of [3, 4, 5]) {
    test(`${hops} hops over a 2,000-vertex path`, () => {
      const g = path(2000);

      expect(countOf(g, hops)).toBe(bruteForce(g, hops));
      // Derived as well as compared: a path of `n` with out-degree 1 has `n - hops` complete walks.
      expect(countOf(g, hops)).toBe(2000 - hops);
    });
  }

  for (const hops of [3, 4]) {
    test(`${hops} hops over a branchy 1,500-vertex graph, where runs exceed one entry`, () => {
      // ⚠️ A PATH GIVES EVERY MEMO RUN LENGTH 1, so an off-by-one WITHIN a run is invisible there.
      // Out-degree 2 makes runs length 2 and slots repeat across frontiers, which is what exercises
      // the `(off, len)` pair relative to each other.
      const g = branchy(1500);

      expect(countOf(g, hops)).toBe(bruteForce(g, hops));
    });
  }

  test('a 2-hop count is the CONTRAST: one pass, so it never reads the memo', () => {
    // Included so a later change to the pass count cannot quietly make every case above a 2-hop
    // one and still pass. If this is the only shape that works, the file is testing nothing.
    const g = path(2000);

    expect(countOf(g, 2)).toBe(bruteForce(g, 2));
    expect(countOf(g, 2)).toBe(1998);
  });

  test('a graph with no edges counts zero at every depth', () => {
    const g = build(50, () => []);

    for (const hops of [2, 3, 4]) {
      expect(countOf(g, hops)).toBe(0);
    }
  });

  test('a SELF-LOOP contributes a walk at every depth', () => {
    // One vertex pointing at itself: exactly one k-hop walk for any k, which a dedupe or a
    // mis-indexed run would lose or multiply.
    const g = build(1, () => [0]);

    for (const hops of [2, 3, 4, 5]) {
      expect(countOf(g, hops)).toBe(1);
      expect(countOf(g, hops)).toBe(bruteForce(g, hops));
    }
  });

  test('a graph big enough to grow the memo buffer past its initial capacity', () => {
    // The buffer starts at 1,024 entries; 3,000 slots with one entry each force several doublings.
    // The direct guard is `memo-reserve.test.ts`, but a query-level case costs nothing here.
    const g = path(3000);

    expect(countOf(g, 3)).toBe(bruteForce(g, 3));
    expect(countOf(g, 3)).toBe(2997);
  });
});
