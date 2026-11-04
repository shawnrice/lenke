/**
 * IS THE BY-ID DRIFT COMPLEXITY OR CACHE? The discriminator item 1326 did not run (item 1395).
 *
 *   node id-lookup-hotset-probe.mjs            # the whole grid
 *   HOT=1000 N=800000 node id-lookup-hotset-probe.mjs
 *
 * `id-lookup-is-o1-probe.ts` verifies that per-lookup cost is FLAT in graph size, and it is nearly
 * so — but not exactly. Over a 16x range it reads **105.7 -> 112.6 -> 129.5 ns** for
 * `getVertexById` and **99.9 -> 111.9 -> 130.5** for `getEdgeById`: **+22.5%** and **+30.6%**.
 *
 * ⚠️ THAT DRIFT IS NUMERICALLY INDISTINGUISHABLE FROM O(log N) and must not be waved away.
 * `log2(800000) / log2(50000)` is **1.26** — so a logarithmic structure would predict +26%, which is
 * between the two numbers measured. "It is just cache effects" is the right answer only if it is
 * demonstrated, and a size sweep alone cannot demonstrate it, because N moves the working set and
 * the structure together.
 *
 * THE DISCRIMINATOR: hold the graph size fixed and vary how many DISTINCT ids are looked up.
 *
 *   - If the cost is CACHE, it tracks the HOT SET. Looking up 1,000 ids in an 800,000-vertex graph
 *     touches 1,000 entries however large the map is, so it should match 1,000 ids in a 50,000-vertex
 *     graph — and the 16x sweep's drift should reappear when the hot set grows at FIXED N.
 *   - If the cost is COMPLEXITY, it tracks N. A lookup in an 800,000-entry map costs more than one
 *     in a 50,000-entry map no matter how few distinct keys are asked for.
 *
 * These predictions are opposite, which is what makes this a test rather than a story. One grid cell
 * per process, because measuring several in one process has inverted four conclusions in this
 * directory (items 1320, 1321, 1323, 1325).
 */
import { Graph } from '@lenke/core';

const N = Number(process.env.N ?? 200_000);
const HOT = Number(process.env.HOT ?? 1_000);
const REPS = Number(process.env.REPS ?? 40);
const KIND = process.env.KIND ?? 'vertex';

const g = new Graph();
const vs = [];

for (let i = 0; i < N; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
}

if (KIND === 'edge') {
  for (let i = 0; i + 1 < N; i += 1) {
    g.addEdge({ id: `e${i}`, from: vs[i], to: vs[i + 1], labels: ['E'], properties: {} });
  }
}

// The hot ids are SPREAD across the whole key space rather than taken from the front, so a
// contiguous-prefix layout cannot make a large graph look small — the trap `ordinal-churn-probe.mjs`
// fell into (its first version put the live set at slots 0..LIVE-1 and churn measured free).
const stride = Math.max(Math.floor(N / HOT), 1);
const ids = [];

for (let k = 0; k < HOT; k += 1) {
  ids.push(KIND === 'edge' ? `e${(k * stride) % (N - 1)}` : `v${(k * stride) % N}`);
}

/**
 * ⚠️ CONSTRUCT=1 BUILDS THE ID STRING PER LOOKUP, which is what `id-lookup-is-o1-probe.ts` does
 * (`g.getVertexById(\`v${i}\`)`). That matters for reading ITS numbers: a fresh string has to be
 * concatenated and hashed, and its LENGTH grows with N — ids are 6 characters at 50,000 and 7 at
 * 800,000. So a size sweep that constructs its keys is partly measuring key construction, and the
 * drift it reports is not necessarily the engine's.
 */
const CONSTRUCT = process.env.CONSTRUCT === '1';
const nums = ids.map((id) => Number(id.slice(1)));
const pickLookup = () => {
  if (KIND === 'edge') {
    return CONSTRUCT ? (i) => g.getEdgeById(`e${nums[i]}`) : (i) => g.getEdgeById(ids[i]);
  }

  return CONSTRUCT ? (i) => g.getVertexById(`v${nums[i]}`) : (i) => g.getVertexById(ids[i]);
};

const lookup = pickLookup();
const series = [];
let sink = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  for (let pass = 0; pass < 50; pass += 1) {
    for (let k = 0; k < ids.length; k += 1) {
      if (lookup(k) !== undefined) {
        sink += 1;
      }
    }
  }

  series.push(((performance.now() - t0) * 1e6) / (50 * ids.length));
}

if (sink === 0) {
  throw new Error(`${KIND} lookups all missed — measuring the miss path, not the hit path`);
}

const kept = series.slice(Math.max(Math.floor(REPS / 4), 2)).sort((a, b) => a - b);

console.log(
  JSON.stringify({
    kind: KIND,
    construct: CONSTRUCT,
    n: N,
    hot: HOT,
    nsPerLookup: Number(kept[Math.floor(kept.length / 4)].toFixed(2)),
    median: Number(kept[Math.floor(kept.length / 2)].toFixed(2)),
    sink,
  }),
);
