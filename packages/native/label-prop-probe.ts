/**
 * ONE ALGORITHM PER PROCESS, with the fixture build OUTSIDE the measured window (item 1625).
 *
 * `labelPropagation` is the slowest procedure per vertex in `algo-scaling-bench.mjs` by a wide
 * margin — **2056-2535 ns/V against `peerPressure`'s 1000-1344 and `pagerank`'s 490-505** — and its
 * profile has the only UNPRICED frame left in the TS algorithm surface:
 *
 * ```text
 *    computeGen            20.4%   ZERO mentions — the per-round tally loop
 *    writeIncidentEnds     16.1%   the CSR build, priced at 21.6% already
 *    countIncidentEdgesFlat 5.3%   same
 *    buildAdjacency         4.7%   ZERO mentions
 * ```
 *
 * ⚠️ AND THE ALGORITHM IS ABOUT HALF THAT PROFILE. The rest is the FIXTURE BUILD — `indexEdgeLabel`
 * 6.1%, `#commitNormalized` 3.7%, `insertEdge` 1.6%, `commitElementLabels` 3.1% — which the bench's
 * own timing excludes but a whole-process profile does not. So a share read off that profile
 * overstates the algorithm's own terms by ~2x, which is why this probe exists.
 *
 *     bun label-prop-probe.ts
 *     NODES=200000 FANOUT=4 REPS=5 bun label-prop-probe.ts
 */
import { Graph, runAlgorithmSync } from '@lenke/core';
import type { Vertex } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 80_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 7);

const g = new Graph();
const vs: Vertex[] = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } }));
}

/** ⚠️ Split on the REPEAT INDEX — items 1516/1518; a linear `(a*k+b)%N` makes the graph functional. */
let edges = 0;

for (let k = 0; k < NODES * FANOUT; k += 1) {
  const from = k % NODES;
  const to = (from * 7 + Math.floor(k / NODES) * 2657 + 1) % NODES;

  if (to === from) {
    continue;
  }

  g.addEdge({ id: `e${k}`, from: vs[from], to: vs[to], labels: ['E'], properties: {} });
  edges += 1;
}

// COUNT THE DISTINCT ENDPOINTS AND THE BRANCHING before trusting any number off this fixture.
const targets = new Set<string>();
const degree = new Map<string, number>();

for (const e of g.edges) {
  targets.add(e.to.id);
  degree.set(e.from.id, (degree.get(e.from.id) ?? 0) + 1);
}

const branching = [...degree.values()].filter((d) => d > 1).length;

if (targets.size < NODES * 0.4) {
  throw new Error('DEGENERATE FIXTURE — the generator collapsed');
}

const series: number[] = [];
let communities = 0;

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();
  // ⚠️ `runAlgorithmSync` IS THE ENTRY POINT BOTH ENGINES DISPATCH THROUGH — `algo-scaling-bench`'s
  // own note, and the reason the probe asks it rather than a method on `Graph`.
  const rows = runAlgorithmSync('labelPropagation', { edgeLabel: 'E', iterations: 10 }, g);

  series.push(performance.now() - t0);
  // ⚠️ `AlgorithmRow` is `{ node } & Record<K, V>` with the column name varying by algorithm, so the
  // read goes through an index rather than a cast to a made-up shape.
  communities = new Set((rows as unknown as Record<string, unknown>[]).map((r) => r.label)).size;
}

// MEDIAN of the post-warmup reps — `ts-spelling-probe`'s estimator.
const tail = series.slice(2).sort((a, b) => a - b);
const median = tail[Math.floor(tail.length / 2)];

console.log(
  JSON.stringify({
    nodes: NODES,
    edges,
    distinctTargets: targets.size,
    branching,
    // ⚠️ THE ANSWER, so an ablation that changes it is visible rather than silently "faster".
    communities,
    median_ms: Number(median.toFixed(2)),
    ns_per_v: Number(((median * 1e6) / NODES).toFixed(0)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
