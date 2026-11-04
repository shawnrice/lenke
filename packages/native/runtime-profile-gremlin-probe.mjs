/**
 * Find UNPRICED hot code in the TS GREMLIN engine, mechanically. The Gremlin twin of
 * `runtime-profile-probe.mjs`, and it exists because that probe is GQL-ONLY.
 *
 * Item 921 built the unpriced-frame screen over five GQL shapes and reported "the next TS win is
 * unlikely to come from profiling the runtime path". Item 1358 found that verdict was partly an
 * artifact of the analyzer laundering unnameable frames into "already recorded" — and, separately,
 * that the probe it ran imports only `@lenke/core` and `@lenke/gql`. So **the Gremlin runtime path
 * has never been through this screen at all**, despite the standing instruction covering both
 * surfaces and despite `bench:gremlin`'s multi-hop count being the largest row in either suite.
 *
 * ONE SHAPE PER PROCESS (item 762): the shape comes from argv, so no other traversal shape pollutes
 * the dispatch sites of the one being measured.
 *
 *     node --cpu-prof --cpu-prof-dir=<dir> --cpu-prof-name=g-<shape>.cpuprofile \
 *          runtime-profile-gremlin-probe.mjs <shape> <reps>
 *
 * ⚠️ `toArray` takes (plan, graph) IN THAT ORDER. Item 1349 lost a round to calling it (graph, plan),
 * which throws nothing useful — it just measures the wrong thing.
 *
 * ⚠️ `@lenke/gremlin` is a BUILT DIST. A source edit reaches this probe only after `bun run build`.
 */
import { Graph } from '@lenke/core';
import {
  V,
  count,
  dedupe,
  groupCount,
  gt,
  has,
  hasLabel,
  order,
  out,
  toArray,
  traversal,
  values,
} from '@lenke/gremlin';

import { profileWindow } from './windowed-profile.mjs';

const SHAPE = process.argv[2] ?? 'hopcount3';
const REPS = Number(process.argv[3] ?? 200);
/** ⚠️ See the size note in `runtime-profile-probe.mjs`: 20,000 is the CACHE-RESIDENT regime only. */
const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);

/**
 * One fixture for every shape, so a difference between shapes is the shape and not the data.
 * Deliberately the GQL probe's node count with a 5:1 edge ratio — CLAUDE.md's "match the fixture to
 * the claim": one edge per node is sparse, and per-edge costs scale with the edge:node ratio.
 */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    g.addEdge({
      id: `e${k}`,
      from: g.getVertexById(`v${(k * 7919) % NODES}`),
      to: g.getVertexById(`v${(k * 104_729) % NODES}`),
      labels: ['E'],
      properties: { w: k % 13 },
    });
  }

  return g;
};

const SHAPES = {
  // The CONTROL: answered by an O(1) bucket read, so none of the traverser machinery runs. A frame
  // that is hot here is fixture build or harness, not the engine's query path.
  control: traversal(V(), count()),
  // The largest row in `bench:gremlin` — the per-vertex multiplicity walk in `hopChainCount`.
  hopcount3: traversal(V(), hasLabel('P'), out('E'), out('E'), out('E'), count()),
  // Two hops, which the DEGREE INNER PRODUCT answers without an edge walk (item 590). Kept as the
  // reference for the row above: a change that moves both is in shared code.
  hopcount2: traversal(V(), hasLabel('P'), out('E'), out('E'), count()),
  // A row-RETURNING hop, so no count shortcut can claim it.
  hopbare: traversal(V(), out('E')),
  // The ORDER path, the Gremlin twin of GQL's `sortedpage` — item 1358's biggest GQL find.
  hoporder: traversal(V(), out('E'), values('k'), order()),
  // Grouping, the twin of GQL's `grouped`, which item 1358 found is 66% of its shape.
  grouped: traversal(V(), groupCount({ by: 'k' })),
  // A filter chain (item 537's shape), where the label is VACUOUS so it excludes nothing.
  filterchain: traversal(V(), hasLabel('P'), has('k', gt(44)), count()),
  // De-duplication over a hop, which materializes a set per traversal.
  hopdedupe: traversal(V(), out('E'), dedupe(), count()),
};

const plan = SHAPES[SHAPE];

if (plan === undefined) {
  throw new Error(`unknown shape ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

const g = build();
let sink = 0;
const t0 = performance.now();

await profileWindow(process.env.PROF_OUT, () => {
  for (let i = 0; i < REPS; i += 1) {
    const rows = toArray(plan, g);

    sink += Array.isArray(rows) ? rows.length : 1;
  }

  return sink;
});

const ms = performance.now() - t0;

// Asserted, not printed and ignored: a shape that silently returned nothing would profile the error
// path and look like a result.
if (sink === 0) {
  throw new Error(
    `${SHAPE} produced NO rows across ${REPS} runs — the profile would be of nothing`,
  );
}

console.log(JSON.stringify({ shape: SHAPE, reps: REPS, ms: Number(ms.toFixed(1)), sink }));
