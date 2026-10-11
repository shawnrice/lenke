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

for (const [name, q] of CASES) {
  let best = Infinity;
  let answer = -1;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();
    const rows = [...query(g, q)] as { c: number }[];
    const dt = performance.now() - t0;

    best = Math.min(best, dt);
    answer = rows[0]?.c ?? -1;
  }

  console.log(`${name.padEnd(20)}${best.toFixed(1).padStart(10)} ms   answer=${answer}`);
}
