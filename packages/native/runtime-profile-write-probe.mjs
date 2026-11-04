/**
 * Find UNPRICED hot code in the TS WRITE path, mechanically. The third probe in the screen's set,
 * after `runtime-profile-probe.mjs` (GQL queries) and `runtime-profile-gremlin-probe.mjs`.
 *
 * WHY IT EXISTS. Items 1358 and 1359 screened both QUERY surfaces and found every nomination already
 * priced. Neither probe touches the write path, and the GQL `control` profile is the hint: with
 * `RETURN 1` as the query, its hottest engine frames are all ingest — `indexEdgeLabel`,
 * `commitElementLabels`, `insertEdge`, `pushTokens`, `getVertexById` — because the fixture build is
 * most of that process. ~100 ms to load 40,000 elements is ~2.5 us an element, and nothing in the
 * screen was looking at it.
 *
 * Item 312 WITHDREW `addVertex` as a target at 7.4%, and `ts-ingest-is-constant-factor` records the
 * 4x native gap as JSON.parse + alloc + freeze with `addEdge` at ~85% of it. So the expectation here
 * is a negative. The point is to have looked with an instrument rather than to infer it from two
 * entries, since that inference is exactly what item 1356 got wrong.
 *
 * ONE SHAPE PER PROCESS (item 762).
 *
 *     node --cpu-prof --cpu-prof-dir=<dir> --cpu-prof-name=w-<shape>.cpuprofile \
 *          runtime-profile-write-probe.mjs <shape> <reps>
 *
 * ⚠️ Writes ALLOCATE, so every shape builds a fresh graph per rep and the reps are sized per shape.
 * Run it under the cgroup cap: `timeout 600 systemd-run --user --scope -q -p MemoryMax=16G
 * -p MemorySwapMax=0 …` — item 1357's `withEdges` arm was OOM-killed (exit -9) for exactly this.
 */
import { Graph } from '@lenke/core';

const SHAPE = process.argv[2] ?? 'addVertexProps';
const REPS = Number(process.argv[3] ?? 10);
const N = Number(process.env.N ?? 20_000);
const FANOUT = 5;

/** Vertices only, one label, no properties — the THINNEST write, so per-vertex constants dominate. */
const addVertexBare = () => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'] });
  }

  return g.vertexCount;
};

/** Three properties, the shape real ingest has (item 312's withdrawal was measured on this). */
const addVertexProps = () => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  return g.vertexCount;
};

/** Edges onto a prebuilt vertex set, so the measured work is `addEdge` and its label indexing. */
const addEdgeOnly = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'] }));
  }

  for (let k = 0; k < N * FANOUT; k += 1) {
    g.addEdge({
      id: `e${k}`,
      from: vs[(k * 7919) % N],
      to: vs[(k * 104_729) % N],
      labels: ['E'],
      properties: { w: k % 13 },
    });
  }

  return g.edgeCount;
};

/** Property UPDATES on a warm graph — `ts-set-is-o-width` says this makes three O(K) passes. */
const setProps = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i, s: 'x' } }));
  }

  for (let i = 0; i < N; i += 1) {
    vs[i].properties = { k: i + 1, s: 'y' };
  }

  return g.vertexCount;
};

/** DELETES, which item 1357 flagged as the unmeasured half of the ordinal question. */
const removeVertices = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i } }));
  }

  for (let i = 0; i < N; i += 1) {
    g.removeVertex(vs[i]);
  }

  return g.vertexCount === 0 ? 1 : 0;
};

/** The O(1)-BY-ID CONTROL, which the standing instruction names explicitly. */
const pointLookups = () => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['P'] });
  }

  let hits = 0;

  for (let r = 0; r < 10; r += 1) {
    for (let i = 0; i < N; i += 1) {
      if (g.getVertexById(`v${i}`) !== undefined) {
        hits += 1;
      }
    }
  }

  return hits;
};

const SHAPES = {
  addVertexBare,
  addVertexProps,
  addEdgeOnly,
  setProps,
  removeVertices,
  pointLookups,
};

const fn = SHAPES[SHAPE];

if (fn === undefined) {
  throw new Error(`unknown shape ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

let sink = 0;
const t0 = performance.now();

for (let i = 0; i < REPS; i += 1) {
  sink += fn();
}

const ms = performance.now() - t0;

// Asserted, not printed and ignored: a shape that silently did nothing would profile the error path
// and look like a result.
if (sink === 0) {
  throw new Error(
    `${SHAPE} produced NOTHING across ${REPS} runs — the profile would be of nothing`,
  );
}

console.log(JSON.stringify({ shape: SHAPE, reps: REPS, n: N, ms: Number(ms.toFixed(1)), sink }));
