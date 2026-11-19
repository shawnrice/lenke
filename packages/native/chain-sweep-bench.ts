// The way-count sweep (`longChainCount`) at SERVING SIZE, through the real engine.
//
// `chain-depth-probe.ts` answers "is the cost a degree product or an enumeration" and needs a
// tiny graph to do it. This answers a different question — what the sweep's own constant factor
// is — and so needs a graph big enough for that factor to dominate. Item 300 used it to take the
// sweep from a `Map<string, number>` to a lazy dense index with a per-slot adjacency cache
// (1006.8 -> 715.5ms at five hops, 1.41x, disjoint ranges over three alternated rounds).
//
// The first two cases are CONTROLS the sweep cannot reach: 3 and 4 segments route to
// `threeSegmentCount` and `fourSegmentCount`. One case per process is deliberate — item 290
// recorded a large speedup making its NEIGHBOUR read 0.87x slower purely by warming it.
//
// Run: cd packages/native && bun run bench:chain
import { Graph, type Vertex } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.CHAIN_N ?? 200_000);
const DEG = Number(process.env.CHAIN_DEG ?? 3);
const REPS = Number(process.env.CHAIN_REPS ?? 5);

const build = (): Graph => {
  const g = new Graph();
  const ids: Vertex[] = [];

  for (let i = 0; i < NODES; i++) {
    ids.push(g.addVertex({ labels: ['P'], properties: { k: i % 10 } }));
  }

  for (let i = 0; i < NODES; i++) {
    for (let d = 0; d < DEG; d++) {
      g.addEdge({
        from: ids[i],
        to: ids[(i * 7 + d * 31 + 1) % NODES],
        labels: ['E'],
        properties: {},
      });
    }
  }

  return g;
};

const chain = (hops: number): string =>
  `MATCH (a:P)${'-[:E]->()'.repeat(hops - 1)}-[:E]->(x) RETURN count(*) AS c`;

const CASES: [string, string][] = [
  ['3-hop  [CONTROL]', chain(3)],
  ['4-hop  [CONTROL]', chain(4)],
  ['5-hop', chain(5)],
  ['6-hop', chain(6)],
  ['7-hop reversed', `MATCH (x)${'<-[:E]-()'.repeat(6)}<-[:E]-(a:P) RETURN count(*) AS c`],
  // A MIXED chain, which declines the per-slot adjacency cache (the legs do not share a
  // direction) — so it is the row that says what the cache is worth.
  [
    '6-hop mixed dirs',
    'MATCH (a:P)-[:E]->()<-[:E]-()-[:E]->()<-[:E]-()-[:E]->(x) RETURN count(*) AS c',
  ],
];

const g = build();

console.log(`${NODES} vertices / ${NODES * DEG} edges, min of ${REPS}`);

/*
 * ONE CASE PER PROCESS, which this file's own header has always called deliberate — "item 290 recorded a
 * large speedup making its NEIGHBOUR read 0.87x slower purely by warming it" — and which the loop below
 * did not actually honour. `CHAIN_CASE` is a substring selector, the same shape the engine's example
 * binaries use.
 *
 * ⚠️ WITHOUT IT THIS BENCH REPORTED AN IMPOSSIBLE ORDERING, reproducibly across three processes: the
 * 4-hop case read 7.8-8.2 ms against the 5-hop's 5.6-5.7 and the 6-hop's 5.5-5.6, on a THIRD of the ways.
 * The 4-hop is simply the FIRST case that reaches the sweep — the 3-hop is a closed-form degree product at
 * 0.0 ms — so it absorbed the whole warm-up and the later, larger cases ran on warm code. Item 2367.
 */
const ONLY = process.env.CHAIN_CASE;
const SELECTED = ONLY === undefined ? CASES : CASES.filter(([name]) => name.includes(ONLY));

if (SELECTED.length === 0) {
  throw new Error(`no case matches CHAIN_CASE=${ONLY ?? ''}`);
}

for (const [name, q] of SELECTED) {
  const series: number[] = [];
  let best = Infinity;
  let answer = -1;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const rows = [...query(g, q)] as { c: number }[];
    const dt = performance.now() - t0;

    series.push(dt);
    best = Math.min(best, dt);
    answer = rows[0]?.c ?? -1;
  }

  /*
   * THE PER-REP SERIES IS PRINTED, AND CROSS-PROCESS REPETITION IS REQUIRED (item 2368).
   *
   * ⚠️ These rows are 5-10 ms, and at that size the 5-hop case is BIMODAL ACROSS PROCESSES: five separate
   * runs of the identical build and fixture read 5.3 / 8.5 / 4.6 / 9.2 / 4.6 ms — two modes 2.0x apart —
   * while the 4-hop case is unimodal at 7.0-8.3. A min-of-5 inside ONE process cannot see that, and item
   * 2367 read a "4-leg chain costs 1.37x a 5-leg one" off exactly that blind spot: true of the medians,
   * invertible by any single run, because the 5-hop's slow mode exceeds the 4-hop entirely.
   *
   * So: run each case in SEVERAL processes and compare medians, never one run against one run.
   */
  console.log(
    `${name.padEnd(20)}${best.toFixed(1).padStart(10)} ms   answer=${answer}` +
      `   reps=[${series.map((x) => x.toFixed(1)).join(' ')}]`,
  );
}
