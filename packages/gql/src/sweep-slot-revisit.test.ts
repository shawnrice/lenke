import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

/**
 * THE SWEEP'S TWO PATHS THAT NO FIXTURE IN THIS PACKAGE REACHED (item 1791), both in
 * `executor/shortcuts.ts` and both found by instrumenting them rather than by reading:
 *
 *   1. **The slot memo's READ-BACK.** Item 1106 remembers each slot's far slots on the pass that
 *      first resolves them, so later passes skip the `slotOf.get(farId)` string lookup item 1105
 *      measured at 24% of the 4-hop row. A counter put the WRITE side at 14 calls across this
 *      suite and the READ side — `memo.len[slot] !== undefined`, the contiguous run through
 *      `memo.off` — at **zero**.
 *   2. **The start-slot array growth.** `ways` starts at 256 slots and doubles. No query here ever
 *      seeded more than 256 start vertices into `sweepChain`, so that `cap *= 2` never ran.
 *
 * ⚠️ TWO THINGS HAVE TO BE TRUE AT ONCE, and missing either is why no existing fixture reaches
 * these. Both were established by sentinel before this file was written:
 *
 *   **(a) THE QUERY MUST BE SEEDED, or `sweepChain` is never entered at all.**
 *   `filteredChainCsrApplies` is `legs.length > 0 && !seeded && legs.every((l) => !l.both)`, so an
 *   ordinary unseeded chain count takes item 1688's flat-array CSR arm — 333 of the suite's calls
 *   do. The other exit is an undirected leg, which is no use here: `uniform` is a precondition of
 *   the memo, so a `both` leg disables the very path under test. An INDEX SEEK is the only way in,
 *   and it must also pass `seekIsWorthIt`, which is why the fixture is 4,000 vertices with 300
 *   seeded rather than 400 with 300: the seek has to be SELECTIVE to be chosen.
 *
 *   **(b) A SLOT MUST APPEAR AT TWO DIFFERENT DEPTHS, or the memo is written and never read.**
 *   `slot-memo-growth.test.ts` grows the memo's flat buffer on a 4,096-vertex PATH, where each
 *   slot is visited at exactly one depth, so pass 2's frontier is disjoint from pass 1's and every
 *   lookup is a first visit. Revisits need a cycle.
 *
 * ⚠️ AND A PLAIN CYCLE IS THE WRONG SHAPE, for the reason item 1418 recorded when a mutant survived
 * its first fixture: on a uniform cycle every slot contributes the same number of continuations, so
 * weight misrouted between slots leaves the TOTAL unchanged and the count is invariant to the
 * corruption it is supposed to catch. So the fixture is a path (sinks, asymmetric out-degree) with
 * back edges to one hub (revisits, cycles of many different lengths).
 *
 * THE ORACLE IS AN INDEPENDENT WALK rather than a second spelling of the query: a count shortcut
 * and another query can share a route and agree while both are wrong (item 930). The level-by-level
 * DP below is built from the fixture's own construction rules and touches none of the executor.
 */

const SIZE = 4000;
const SEEDED = 300; // > 256, so the start-slot array must double; 7.5% of the label, so the seek wins
const HUB_EVERY = 7;

/**
 * `v0 -> v1 -> … -> v{n-1}`, plus `v{7k} -> v0` for every k > 0. The first `SEEDED` vertices carry
 * `g = 1`; everything else carries `g = 0`.
 *
 * The back edges create the revisits: `v0` is reached at depth 1 from `v7`, depth 2 from `v6`, and
 * so on, so from the second pass onwards the frontier holds slots the first pass already memoized.
 * The tail stays a run of sinks, which is what keeps the count sensitive to WHICH slot weight
 * lands in.
 */
const hubbedPath = (n: number, seeded: number): Graph => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < n; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { g: i < seeded ? 1 : 0 } }));
  }

  let e = 0;

  for (let i = 0; i + 1 < n; i += 1) {
    g.addEdge({ id: `e${(e += 1)}`, from: vs[i], to: vs[i + 1], labels: ['E'] });
  }

  for (let i = HUB_EVERY; i < n; i += HUB_EVERY) {
    g.addEdge({ id: `e${(e += 1)}`, from: vs[i], to: vs[0], labels: ['E'] });
  }

  // ⚠️ THE IRREGULAR EDGES ARE LOAD-BEARING, and they are here because a mutant proved it.
  // With only the path and the hub, every slot had out-degree 1 or 2 and the memo's flat runs were
  // laid out in path order — so reading each run SHIFTED BY ONE (`flat[base + i + 1]`) just moved
  // every target one step along a homogeneous path and the total did not change. 470 either way,
  // checked directly rather than inferred from a green test. These two rules give the runs
  // different LENGTHS and send them to unrelated parts of the graph, so a shifted read crosses a
  // run boundary into a target with a different continuation count.
  for (let i = 0; i < n; i += 5) {
    g.addEdge({ id: `e${(e += 1)}`, from: vs[i], to: vs[(i * 7 + 3) % n], labels: ['E'] });
  }

  for (let i = 0; i < n; i += 11) {
    g.addEdge({ id: `e${(e += 1)}`, from: vs[i], to: vs[Math.floor(i / 11)], labels: ['E'] });
  }

  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['g'] });

  return g;
};

/** Every `hops`-edge walk from a seeded vertex, over an adjacency built from the same rules. */
const bruteForce = (n: number, seeded: number, hops: number): number => {
  const out: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i + 1 < n; i += 1) {
    out[i].push(i + 1);
  }

  for (let i = HUB_EVERY; i < n; i += HUB_EVERY) {
    out[i].push(0);
  }

  for (let i = 0; i < n; i += 5) {
    out[i].push((i * 7 + 3) % n);
  }

  for (let i = 0; i < n; i += 11) {
    out[i].push(Math.floor(i / 11));
  }

  // A chain pattern with distinct variables and no path mode is a WALK: repeats are allowed, so
  // the count is exactly the level-by-level sum and no trail bookkeeping is needed.
  let level = new Float64Array(n);

  for (let i = 0; i < seeded; i += 1) {
    level[i] = 1;
  }

  for (let h = 0; h < hops; h += 1) {
    const nxt = new Float64Array(n);

    for (let v = 0; v < n; v += 1) {
      const w = level[v];

      if (w !== 0) {
        for (const t of out[v]) {
          nxt[t] += w;
        }
      }
    }

    level = nxt;
  }

  let total = 0;

  for (let v = 0; v < n; v += 1) {
    total += level[v];
  }

  return total;
};

const countOf = (g: Graph, q: string): number =>
  (query(g, q, { g: 1 })[0] as Record<string, number>).c;

// 4 legs and no leg gate → 3 passes, which is the `passes > 2` the memo is gated on.
const CHAIN_4 = `MATCH (a:P {g: $g})-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e) RETURN count(*) AS c`;
// 3 legs → 2 passes → below the gate, so the UNCACHED sweep runs over the same fixture.
const CHAIN_3 = `MATCH (a:P {g: $g})-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c`;

describe('the seeded sweep over a graph whose slots are revisited', () => {
  test('a 4-leg chain count agrees with an independent walk count', () => {
    expect(countOf(hubbedPath(SIZE, SEEDED), CHAIN_4)).toBe(bruteForce(SIZE, SEEDED, 4));
  });

  test('CONTROL a 3-leg chain, BELOW the memo gate, agrees over the same fixture', () => {
    // `slotNbrs` is `undefined` here, so this runs the uncached sweep. Without it the test above
    // could pass for a memo that was never built; with it, the two routes are checked against the
    // same oracle on the same graph.
    expect(countOf(hubbedPath(SIZE, SEEDED), CHAIN_3)).toBe(bruteForce(SIZE, SEEDED, 3));
  });

  test('⚠️ the answer MOVES with the fixture, which is what makes it an oracle', () => {
    // The guard against item 1418's trap: a count invariant to the corruption cannot catch it.
    // Three seed sizes, three different answers, and each still matched by the walk.
    const a4 = bruteForce(SIZE, SEEDED, 4);

    expect(a4).toBeGreaterThan(0);
    expect(bruteForce(SIZE, 260, 4)).not.toBe(a4);
    expect(bruteForce(SIZE, SEEDED, 3)).not.toBe(a4);
  });

  test('seed sizes either side of the 256-slot boundary', () => {
    // 257 forces exactly one doubling with the copied prefix nearly the whole array — the
    // arithmetic most likely to be off by one — and 100 forces none, so the pair tests the growth
    // rather than the sweep.
    for (const seeded of [100, 256, 257, 513, SEEDED]) {
      expect(countOf(hubbedPath(SIZE, seeded), CHAIN_4)).toBe(bruteForce(SIZE, seeded, 4));
    }
  });
});
