// Item 431: HOW MUCH OF A CHAIN COUNT'S COST IS THE ADJACENCY LAYOUT?
//
// Item 430 left a 1.70x direction asymmetry on a 3-hop count with no label anywhere — reversed
// 296 ms against forward 174 at 200,000 vertices of degree 3 — and called it open. This probe is
// the diagnosis, and it refutes it as an engine target.
//
// The two graphs have the SAME node count, edge count and degree, and differ only in where each
// edge points:
//
//   SCATTER  i -> xorshift()      each node's `from` bucket is filled sequentially (node 0's
//                                 three edges, then node 1's) while the `to` buckets are filled
//                                 in scattered order
//   RING     i -> (i + 1 + d) % N node j's in-edges come from j-1, j-2, j-3 — so BOTH adjacencies
//                                 are built near-sequentially
//
// It is deliberately NOT part of `chain-depth-probe`, which sweeps DEPTH to eleven hops over 200
// nodes. 200 nodes is entirely cache-resident, so it cannot show a locality effect at all; the
// repo's own rule is that cache-resident and not are different questions and the transition is
// between 200k and 1M. Different question, different size, different probe.
//
// ONE SHAPE PER PROCESS (`PROBE_ONLY`). Run as a table, the 2-hop pair SWAPPED which side was
// slower between two runs of the same binary — whichever ran first paid — and that artifact read
// as "the asymmetry starts at two hops".
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';

import { nativeBackend } from './src/conformance-harness.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.PROBE_N ?? 200_000);
const DEG = 3;
const REPS = Number(process.env.PROBE_REPS ?? 5);
const LAYOUT = process.env.PROBE_LAYOUT ?? 'scatter';

const target = (() => {
  if (LAYOUT === 'ring') {
    return (i: number, d: number): number => (i + 1 + d) % N;
  }

  let x = 12345;

  return (_i: number, _d: number): number => {
    x ^= x << 13;
    x ^= x >>> 7;
    x ^= x << 17;

    return (x >>> 0) % N;
  };
})();

// One edge list, used for BOTH engines, so neither can disagree about the fixture.
const edges: Array<[number, number]> = [];

for (let i = 0; i < N; i++) {
  for (let d = 0; d < DEG; d++) {
    edges.push([i, target(i, d)]);
  }
}

const tsGraph = new Graph();
const ids = Array.from({ length: N }, (_, i) =>
  tsGraph.addVertex({ labels: ['N'], properties: { i } }),
);

for (const [from, to] of edges) {
  tsGraph.addEdge({ from: ids[from], to: ids[to], labels: ['E'], properties: {} });
}

const ndjson = (): string => {
  const lines: string[] = [];

  for (let i = 0; i < N; i++) {
    lines.push(JSON.stringify({ type: 'vertex', id: `v${i}`, labels: ['N'], properties: { i } }));
  }

  for (const [i, [from, to]] of edges.entries()) {
    lines.push(
      JSON.stringify({
        type: 'edge',
        id: `e${i}`,
        from: `v${from}`,
        to: `v${to}`,
        labels: ['E'],
        properties: {},
      }),
    );
  }

  return `${lines.join('\n')}\n`;
};

const nat = graphFromNdjson(nativeBackend(), ndjson());

const timed = (run: () => number): { ms: number; answer: number } => {
  let best = Number.POSITIVE_INFINITY;
  let answer = -1;

  for (let r = 0; r < REPS; r++) {
    const t0 = performance.now();

    answer = run();

    const t = performance.now() - t0;

    if (t < best) {
      best = t;
    }
  }

  return { ms: best, answer };
};

const shapes: Array<[string, string]> = [
  ['2hop fwd', 'MATCH (a)-[:E]->(b)-[:E]->(c) RETURN count(*) AS c'],
  ['2hop rev', 'MATCH (c)<-[:E]-(b)<-[:E]-(a) RETURN count(*) AS c'],
  ['3hop fwd', 'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c'],
  ['3hop rev', 'MATCH (d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a) RETURN count(*) AS c'],
  ['4hop fwd', 'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e) RETURN count(*) AS c'],
  ['4hop rev', 'MATCH (e)<-[:E]-(d)<-[:E]-(c)<-[:E]-(b)<-[:E]-(a) RETURN count(*) AS c'],
];
const only = process.env.PROBE_ONLY;

console.log(`${LAYOUT} layout, ${N} nodes, ${N * DEG} edges, degree ${DEG}, min of ${REPS}`);
console.log('shape        ts ms    native ms   agree');

for (const [name, q] of only === undefined ? shapes : shapes.filter(([n]) => n === only)) {
  const ts = timed(() => ([...tsQuery(tsGraph, q)] as Array<{ c: number }>)[0]?.c ?? -1);
  const nt = timed(() => (nat.query(q)[0] as { c: number } | undefined)?.c ?? -1);

  console.log(
    `${name.padEnd(12)}${ts.ms.toFixed(1).padStart(8)}${nt.ms.toFixed(1).padStart(12)}` +
      `   ${ts.answer === nt.answer ? 'yes' : `NO (ts ${ts.answer}, native ${nt.answer})`}`,
  );
}
