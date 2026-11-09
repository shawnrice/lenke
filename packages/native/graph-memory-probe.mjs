/**
 * WHAT DOES THE TS ENGINE'S GRAPH COST PER ELEMENT? — the first instrument for it (item 1720).
 *
 * The corpus has never measured this. `CLOSED.md`'s only bytes-per-edge figures are the RUST store's
 * label representation (2.5 -> 9.3 bytes/edge at item 682/728), and nothing measures the TS side at
 * all — so the maximum graph an embedder can hold has been an unknown, and so has the heap pressure
 * behind every GC share in every TS profile.
 *
 * ⚠️ IT IS A SPEED QUESTION, NOT ONLY A FOOTPRINT ONE. A windowed profile of
 * `project var-length 1-3 hops` put the garbage collector at **12.67%**, and item 1468 found 6.93%
 * GC inside `labelPropagation`'s CSR build. Allocation per element is what sets that floor.
 *
 * ⚠️ AND IT IS WHY THE ALGORITHM SWEEP CANNOT REACH ITS FOURTH POINT. `algo-scaling-bench` at
 * `SIZES=4` OOMs node's default ~4 GB heap at V=1,280,000 for both `onCycle` and
 * `stronglyConnectedComponents` — not an algorithm defect: at the rates below the GRAPH alone is
 * ~3.3 GB there.
 *
 * METHOD. `global.gc()` twice before each reading (one collection leaves floating garbage), then
 * `process.memoryUsage().heapUsed`. Each stage is measured as a DELTA from the previous one, so the
 * vertex and edge costs are separated rather than divided out of a total. Requires `--expose-gc`:
 *
 *     node --expose-gc graph-memory-probe.mjs
 *     V=80000 FANOUT=5 PROPS=3 node --expose-gc graph-memory-probe.mjs
 *
 * ⚠️ READ THE DELTAS, NOT A TOTAL DIVIDED BY V. At FANOUT=2 the per-vertex figure and the
 * per-vertex-including-its-edges figure differ by 4x, and quoting the wrong one understates the edge
 * cost — which is the larger of the two.
 */
const V = Number(process.env.V ?? 80_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const PROPS = Number(process.env.PROPS ?? 1);
const LABELS = Number(process.env.LABELS ?? 1);
const EDGE_PROPS = Number(process.env.EDGE_PROPS ?? 0);

const { Graph } = await import('@lenke/core');

if (typeof global.gc !== 'function') {
  console.log('run with --expose-gc; without it a reading is whatever the GC last felt like doing');
  process.exit(1);
}

/** Two collections: one leaves floating garbage that the next one reclaims. */
const settle = () => {
  global.gc();
  global.gc();

  return process.memoryUsage().heapUsed;
};

const vertexProps = (i) => {
  const p = {};

  for (let j = 0; j < PROPS; j += 1) {
    p[`k${j}`] = j === 0 ? i : `v${i}-${j}`;
  }

  return p;
};

const edgeProps = (k) => {
  const p = {};

  for (let j = 0; j < EDGE_PROPS; j += 1) {
    p[`w${j}`] = k % 13;
  }

  return p;
};

const labelsOf = (prefix) => Array.from({ length: LABELS }, (_, j) => `${prefix}${j}`);

const base = settle();
const g = new Graph();
const empty = settle();

for (let i = 0; i < V; i += 1) {
  g.addVertex({ id: `v${i}`, labels: labelsOf('P'), properties: vertexProps(i) });
}

const afterVertices = settle();

for (let k = 0; k < V * FANOUT; k += 1) {
  const i = k % V;

  g.addEdge({
    id: `e${k}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + Math.floor(k / V)) % V}`),
    labels: labelsOf('E'),
    properties: edgeProps(k),
  });
}

const afterEdges = settle();
const E = V * FANOUT;

console.log(
  JSON.stringify({
    V,
    E,
    fanout: FANOUT,
    vertexProps: PROPS,
    edgeProps: EDGE_PROPS,
    labelsPerElement: LABELS,
    emptyGraphBytes: empty - base,
    bytesPerVertex: Math.round((afterVertices - empty) / V),
    bytesPerEdge: Math.round((afterEdges - afterVertices) / E),
    bytesPerVertexInclEdges: Math.round((afterEdges - empty) / V),
    totalMB: Number(((afterEdges - base) / 1048576).toFixed(1)),
    // The size at which the graph ALONE fills node's default ~4 GB heap.
    verticesUntil4GB: Math.round((4 * 1024 ** 3) / ((afterEdges - empty) / V)),
  }),
);
