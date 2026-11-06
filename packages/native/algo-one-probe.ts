/**
 * ONE ALGORITHM PER PROCESS, with the fixture build OUTSIDE the measured window (items 1625/1626).
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
 *     bun algo-one-probe.ts
 *     ALGO=shortestPath WEIGHTED=1 bun algo-one-probe.ts
 *     ALGO=betweenness NODES=1000 REPS=3 bun algo-one-probe.ts
 *
 * ⚠️ THE CENTRALITIES NEED A SMALL `NODES`, and the default will hang. `betweenness` and `closeness`
 * are O(V·E): `algo-scaling-bench` runs them at V=1000/4000 while everything else runs at 40,000+,
 * which is what its `div` column is for. At this probe's default 80,000 a single rep does not finish
 * — I ran it, it blew past a 600-second timeout and had to be killed. Pass `NODES=1000`.
 */
import { Graph, runAlgorithmSync } from '@lenke/core';
import type { AlgorithmName } from '@lenke/core';
import type { Vertex } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 80_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 7);
/**
 * Which procedure (item 1626). `labelPropagation` is the default because item 1625 built this probe
 * for it; every other name goes through the same `runAlgorithmSync` entry point, so the comparison
 * across algorithms is apples to apples.
 *
 * ⚠️ `ANSWER_COL` IS NOT COSMETIC. The probe prints a fingerprint of the result so an ABLATION that
 * changes the answer cannot read as a win — item 1625's tie-break ablation moved it from 2118 to
 * 79860, which is the only reason that arm was obviously not shippable. Each algorithm names its
 * result column (`AlgorithmRow` is `{ node } & Record<K, V>`), so the column has to come with the
 * algorithm.
 */
/**
 * ⚠️ THE COLUMN MAP IS DERIVED FROM THE ENGINE, NOT GUESSED. My first version had `score` for the
 * two centralities and a name (`shortestPathWeighted`) that does not exist — `runAlgorithmSync`
 * returned `undefined` for it and the probe crashed, and `closeness` read ONE distinct answer
 * because `r.score` was `undefined` on every row. Both were caught by the fingerprint and the crash
 * rather than by reading, so the map below was printed off the engine:
 *
 * ```text
 *    degree -> degree              connectedComponents -> componentId
 *    labelPropagation -> label     stronglyConnectedComponents -> componentId
 *    peerPressure -> cluster       onCycle -> onCycle
 *    pagerank -> score             personalizedPagerank -> score
 *    shortestPath -> distance      betweenness -> centrality
 *    closeness -> centrality       neighborAggregate -> needs a `feature`, not covered
 * ```
 *
 * ⚠️ AND THERE IS NO `shortestPathWeighted` ALGORITHM. `algo-scaling-bench` runs `shortestPath` with
 * a `weightProperty` and LABELS the row `shortestPathWeighted`, which is why reaching for the name
 * found nothing. `WEIGHTED=1` is this probe's equivalent.
 */
const ALGO = (process.env.ALGO ?? 'labelPropagation') as AlgorithmName;
const WEIGHTED = process.env.WEIGHTED === '1';
const ANSWER_COL: Record<string, string> = {
  labelPropagation: 'label',
  peerPressure: 'cluster',
  degree: 'degree',
  connectedComponents: 'componentId',
  stronglyConnectedComponents: 'componentId',
  onCycle: 'onCycle',
  pagerank: 'score',
  personalizedPagerank: 'score',
  shortestPath: 'distance',
  betweenness: 'centrality',
  closeness: 'centrality',
};
const COL = ANSWER_COL[ALGO] ?? 'score';

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

  /**
   * ⚠️ A REAL `w`, AND THE THIRD THING THE ANSWER FINGERPRINT CAUGHT THIS TICK. The edges carried
   * `properties: {}`, so `WEIGHTED=1` asked for a `weightProperty` nothing had — and the weighted
   * run reported **ONE distinct distance over 80,000 rows** while measuring a tidy 1.98x. Without
   * the fingerprint that 1.98x was publishable and wrong: it priced the missing-weight path, not
   * weighted shortest path.
   *
   * `1..9` rather than `0..8`: a zero-weight edge makes every distance along it equal and collapses
   * the answer for a different reason.
   */
  g.addEdge({
    id: `e${k}`,
    from: vs[from],
    to: vs[to],
    labels: ['E'],
    properties: { w: (k % 9) + 1 },
  });
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
let rowCount = 0;

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();
  // ⚠️ `runAlgorithmSync` IS THE ENTRY POINT BOTH ENGINES DISPATCH THROUGH — `algo-scaling-bench`'s
  // own note, and the reason the probe asks it rather than a method on `Graph`.
  const rows = runAlgorithmSync(
    ALGO,
    // ⚠️ `source` is REQUIRED by the shortest-path family and ignored by the rest, so it is always
    // passed: an algorithm that needs it and does not get it throws, which in a timing loop would
    // read as "this algorithm is infinitely fast".
    {
      edgeLabel: 'E',
      iterations: 10,
      source: 'v0',
      ...(WEIGHTED ? { weightProperty: 'w' } : {}),
    },
    g,
  );

  series.push(performance.now() - t0);
  // ⚠️ `AlgorithmRow` is `{ node } & Record<K, V>` with the column name varying by algorithm, so the
  // read goes through an index rather than a cast to a made-up shape.
  const bag = rows as unknown as Record<string, unknown>[];

  rowCount = bag.length;
  communities = new Set(bag.map((r) => r[COL])).size;
}

// MEDIAN of the post-warmup reps — `ts-spelling-probe`'s estimator.
const tail = series.slice(2).sort((a, b) => a - b);
const median = tail[Math.floor(tail.length / 2)];

console.log(
  JSON.stringify({
    algo: ALGO,
    nodes: NODES,
    edges,
    distinctTargets: targets.size,
    // ⚠️ THE ROW COUNT, because `distinctAnswers: 1` is ambiguous without it: one distinct value
    // over 80,000 rows is a suspicious answer, over ONE row it is the only possible one.
    rows: rowCount,
    branching,
    // ⚠️ THE ANSWER, so an ablation that changes it is visible rather than silently "faster".
    // The answer's fingerprint — distinct values in the result column. See `ANSWER_COL`.
    distinctAnswers: communities,
    median_ms: Number(median.toFixed(2)),
    ns_per_v: Number(((median * 1e6) / NODES).toFixed(0)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
