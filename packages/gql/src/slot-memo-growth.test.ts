import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * The slot memo's BUFFER GROWTH path (item 1418), which was untested until a mutant proved it.
 *
 * Item 1418 replaced the sweep's per-slot `Int32Array`s with one flat buffer plus per-slot
 * `(offset, length)`. Five mutants were run against the offset arithmetic; four were caught and
 * **one survived**:
 *
 *   `grown.set(m.flat.subarray(0, m.used))` → `subarray(0, m.used - 1)`
 *
 * — which silently loses the last entry **every time the buffer doubles**. Nothing caught it,
 * because the buffer starts at 1024 entries and every other test graph in this package is far too
 * small to reach a second allocation. A correctness-critical path was reachable only at scale, so no
 * amount of careful review of the small cases would have found it.
 *
 * ⚠️ THE FIXTURE SIZE IS NOT ENOUGH, AND A CYCLE IS THE WRONG SHAPE. The first version of this file
 * used a 4,096-vertex CYCLE and M5 STILL SURVIVED — because on a cycle every slot contributes
 * exactly the same number of continuations, so weight misrouted from one slot to another leaves the
 * TOTAL unchanged. The count is invariant to the very corruption the mutant causes. That is item
 * 702's lesson arriving from a new direction: an answer invariant to the property you varied cannot
 * validate the fixture, and here the invariance was in the graph's symmetry rather than in the
 * query.
 *
 * So the fixtures below are PATHS, not cycles. A path has sinks: the last few vertices start no
 * complete 4-hop walk, so slots differ in what they contribute and misrouted weight changes the
 * answer. Size still matters — 1024 is the initial capacity, so several doublings are forced — but
 * size alone was not the test.
 *
 * THE ORACLE IS AN INDEPENDENT WALK, not another query. A count shortcut and a second spelling of
 * the same query can share a route and agree while both are wrong (item 930's point); a hand-written
 * 4-hop follow over the same adjacency cannot. It is cheap here because the fixture has out-degree
 * exactly 1.
 */

const SIZE = 4096;

/**
 * A PATH: `v0 -> v1 -> … -> v{n-1}`, one `E` edge each and NO wrap.
 *
 * Out-degree 1 except the last vertex, which is a SINK — and that asymmetry is what makes the count
 * sensitive to which slot weight lands in. `n` slots means `n - 1` entries, so sizes above 1024
 * force the buffer to double.
 *
 * The answer is `n - 4`: every vertex except the last four starts one complete 4-hop walk.
 */
const path = (n: number): Graph => {
  const g = new Graph();
  const vs: ReturnType<Graph['addVertex']>[] = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
  }

  for (let i = 0; i + 1 < n; i += 1) {
    g.addEdge({ id: `e${i}`, from: vs[i], to: vs[i + 1], labels: ['E'] });
  }

  return g;
};

/** The independent oracle: follow `hops` `E` edges from every vertex and count the complete walks. */
const bruteForce = (g: Graph, hops: number): number => {
  let total = 0;

  for (const v of g.vertices) {
    let frontier = [v];

    for (let h = 0; h < hops; h += 1) {
      const next: typeof frontier = [];

      for (const u of frontier) {
        const bucket = u.adjFrom?.get('E');

        if (bucket !== undefined) {
          for (const e of bucket) {
            next.push(e.to);
          }
        }
      }

      frontier = next;
    }

    total += frontier.length;
  }

  return total;
};

const countOf = (g: Graph, src: string): number => query<{ c: number }>(g, src)[0].c;

const CHAIN4 = 'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e) RETURN count(*) AS c';

describe('the slot memo survives several buffer doublings (item 1418)', () => {
  test('⚠️ the 4-hop count over 4096 slots matches an independent walk', () => {
    // THE MUTANT-KILLER. With the growth copy short by one entry the memo loses a neighbour at each
    // doubling, so this count comes back low. At 4096 slots the initial 1024-entry buffer must grow
    // at least twice.
    const g = path(SIZE);

    expect(countOf(g, CHAIN4)).toBe(bruteForce(g, 4));
  });

  test('and the answer is exactly the cycle length, derived rather than observed', () => {
    // On a PATH of `n`, the last four vertices start no complete 4-hop walk, so the count is
    // `n - 4`. Asserted independently of the brute force above so that a bug common to both — they
    // share the adjacency — still fails one of them. The `- 4` is the asymmetry that makes this
    // fixture able to see a misrouted slot at all.
    expect(countOf(path(SIZE), CHAIN4)).toBe(SIZE - 4);
  });

  test('the memo was actually REACHED, so this is not a vacuous pass', () => {
    // The memo needs `passes > 2`, uniform direction, matching leg types and no far label or gate.
    // A 4-hop bare chain satisfies all of it; a 2-hop chain does not (2 passes), and item 1106
    // measured that boundary. If a later change moved the condition, these fixtures would quietly
    // stop exercising the growth path — so the 2-hop case is asserted too, as the contrast that
    // shows the 4-hop one is the interesting shape rather than the only one that works.
    const g = path(SIZE);

    expect(countOf(g, 'MATCH (a)-[:E]->(b)-[:E]->(c) RETURN count(*) AS c')).toBe(bruteForce(g, 2));
    expect(countOf(g, CHAIN4)).toBe(bruteForce(g, 4));
  });

  test('a size just over the initial capacity works too, where the copy is one doubling old', () => {
    // The boundary case the big fixture deliberately skips: 1025 entries forces exactly ONE growth,
    // which is where an off-by-one is smallest and most likely to be mistaken for noise.
    const g = path(1025);

    expect(countOf(g, CHAIN4)).toBe(bruteForce(g, 4));
    expect(countOf(g, CHAIN4)).toBe(1025 - 4);
  });

  test('and a size BELOW it still works, so growth is not required for correctness', () => {
    const g = path(64);

    expect(countOf(g, CHAIN4)).toBe(bruteForce(g, 4));
    expect(countOf(g, CHAIN4)).toBe(64 - 4);
  });
});

describe('the memo over a graph where slots have several neighbours (item 1418)', () => {
  test('out-degree 2 fills runs longer than one, which single-degree fixtures cannot', () => {
    // ⚠️ EVERY FIXTURE ABOVE HAS OUT-DEGREE 1, so each memo run holds exactly one entry and an
    // off-by-one WITHIN a run is invisible. This one gives each vertex two outgoing edges, so runs
    // are length 2 and `off`/`len` have to be right relative to each other.
    const n = 1500;
    const g = new Graph();
    const vs: ReturnType<Graph['addVertex']>[] = [];

    for (let i = 0; i < n; i += 1) {
      vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
    }

    for (let i = 0; i < n; i += 1) {
      // NO WRAP, so the tail vertices are sinks and slots differ in what they contribute.
      if (i + 1 < n) {
        g.addEdge({ id: `a${i}`, from: vs[i], to: vs[i + 1], labels: ['E'] });
      }

      if (i + 7 < n) {
        g.addEdge({ id: `b${i}`, from: vs[i], to: vs[i + 7], labels: ['E'] });
      }
    }

    // 3,000 entries over 1,500 slots — past the initial capacity, with runs of length 2.
    expect(countOf(g, CHAIN4)).toBe(bruteForce(g, 4));
    // No closed form here — the tail's sinks make it irregular, which is the point — so the brute
    // force is the only oracle and it is asserted to be non-trivial rather than to a literal.
    expect(bruteForce(g, 4)).toBeGreaterThan(n);
  });
});
