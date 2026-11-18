/**
 * ✅✅ **THE EDGE TWIN OF ITEM 2320's SHIP (item 2321).**
 *
 * Item 2320 shipped 3.86x on `V().values(k)` by replacing `drain: () => [...walk()]` with a plain loop over
 * `graph.vertices`. 🔑 `edgeValuesShortcut` has the identical shape over `graph.edges`, and `E().values(k)`
 * is a common read that nothing measured this session.
 *
 * ⚠️ **A SEPARATE PROBE, NOT A NEW ARM IN `gremidx-2317.mjs`.** Adding edges to that fixture would change
 * the graph every one of its arms sees, so its PRE numbers from items 2317-2320 would no longer compare.
 *
 * ⚠️ **THE RULE THIS TICK ESTABLISHED, which decides whether a spread is worth converting at all**: a plain
 * `drain` loop still pays the generator protocol if the thing it iterates is ITSELF a generator (that is
 * why the labelled vertex scan, whose `drain` was already a plain loop over a `stream`, measured flat).
 * `graph.edges` is materialized, so this one qualifies.
 */
import { Graph } from '@lenke/core';
import { E, toArray, traversal, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const FAN = Number(process.env.FAN ?? 3);
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const ARM = process.env.ARM ?? 'edgeVals';

const graph = new Graph();

for (let i = 0; i < NODES; i += 1) {
  graph.addVertex({ id: `v${i}`, labels: ['N'], properties: { k: i % 97 } });
}

/*
 * ⚠️ **THE REPEAT-INDEX SPLIT (item 1633).** `to = (k * a) % N` is invariant under `k -> k + N`, so one
 * vertex's FAN edges would all land on the SAME target — out-degree looks perfect and the graph is
 * FUNCTIONAL. Splitting on `Math.floor(k / N)` is the fix, and the distinct-endpoint count below is the
 * check that it worked.
 */
const seen = new Set();

for (let k = 0; k < NODES * FAN; k += 1) {
  const to = ((k % NODES) * 104_729 + Math.floor(k / NODES) * 977) % NODES;

  seen.add(to);
  graph.addEdge({
    id: `e${k}`,
    from: graph.getVertexById(`v${k % NODES}`),
    to: graph.getVertexById(`v${to}`),
    labels: ['E'],
    properties: { w: k % 89 },
  });
}

/* ✅ A degenerate generator would collapse this; see item 1633 and `assertGraphDocBranches`. */
if (seen.size < NODES * 0.5) {
  throw new Error(`degenerate fixture: only ${seen.size} distinct endpoints of ${NODES}`);
}

const pEdgeVals = traversal(E(), values('w'));

const ARMS = {
  edgeVals: () => toArray(pEdgeVals, graph).length,
};

const arm = ARMS[ARM];

for (let w = 0; w < 20; w += 1) {
  arm();
}

let inner = 1;

for (;;) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 100_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  for (let i = 0; i < inner; i += 1) {
    arm();
  }

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];
const rows = arm();

console.log(
  `  ARM=${ARM.padEnd(9)} edges=${String(NODES * FAN).padStart(7)} distinctEndpoints=${seen.size}  ${(med * 1000).toFixed(2).padStart(10)} us  ${((med * 1000 * 1000) / rows).toFixed(2).padStart(7)} ns/row  rows=${rows}`,
);
