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
 *     PROF_OUT=<dir>/w-<shape>.cpuprofile node runtime-profile-write-probe.mjs <shape> <reps>
 *     node runtime-profile-write-probe.mjs <shape> <reps>        # timing only, no profile
 *
 * ⚠️ Writes ALLOCATE, so every rep gets a FRESH fixture and the reps are sized per shape. Run it
 * under the cgroup cap: `timeout 600 systemd-run --user --scope -q -p MemoryMax=16G
 * -p MemorySwapMax=0 …` — item 1357's `withEdges` arm was OOM-killed (exit -9) for exactly this.
 *
 * ⚠️ SETUP IS SEPARATED FROM THE MEASURED PHASE, and it was not until item 1396. Four of the six
 * shapes built their fixture INSIDE the function being profiled and timed:
 *
 *   - `addEdgeOnly`'s own doc said "edges onto a prebuilt vertex set, so the measured work is
 *     `addEdge`" — and the 20,000 `addVertex` calls were in the same call;
 *   - `setProps` and `removeVertices` likewise built the vertices they then wrote or deleted;
 *   - `pointLookups`, the O(1)-by-id control the standing instruction names, built N vertices and
 *     then did 10xN lookups in one measured call. Item 1395 measured a by-id lookup at ~5 ns hot
 *     against ~1 us for an `addVertex`, so that shape was MOSTLY CONSTRUCTION at any N.
 *
 * There was also no profile windowing, which items 1391 and 1392 gave to the two isolated benches
 * while this third instrument was missed. Both are fixed here: each shape is a `setup` that builds
 * one fixture per rep OUTSIDE the window and a `run` that does only the operation under test, and
 * the profile and the timer cover the `run` loop alone. **Item 1360's write screen was taken on the
 * old instrument**, so its numbers — `drainMutations` at 3.2%, declined — are re-read against this
 * one rather than assumed to survive.
 *
 * For the two pure-ingest shapes the build IS the operation, so their `setup` is empty and nothing
 * about them changes; the restructuring is what makes that distinction explicit rather than
 * accidental.
 */
import { Graph } from '@lenke/core';

import { profileWindow } from './windowed-profile.mjs';

const SHAPE = process.argv[2] ?? 'addVertexProps';
const N = Number(process.env.N ?? 20_000);
const FANOUT = 5;

/** Vertices with `n` properties, the fixture the non-ingest shapes write to or read from. */
const buildVertices = (props) => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < N; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: props(i) }));
  }

  return { g, vs };
};

/**
 * Each shape is `{ reps, setup, run }`. `setup` runs once per rep OUTSIDE the profile and the
 * timer; `run` is the only thing measured. A shape whose `setup` is absent is one where building IS
 * the operation under test.
 */
const SHAPES = {
  /** Vertices only, one label, no properties — the THINNEST write, so per-vertex constants dominate. */
  addVertexBare: {
    reps: 10,
    run: () => {
      const g = new Graph();

      for (let i = 0; i < N; i += 1) {
        g.addVertex({ id: `v${i}`, labels: ['P'] });
      }

      return g.vertexCount;
    },
  },

  /** Three properties, the shape real ingest has (item 312's withdrawal was measured on this). */
  addVertexProps: {
    reps: 10,
    run: () => {
      const g = new Graph();

      for (let i = 0; i < N; i += 1) {
        g.addVertex({
          id: `v${i}`,
          labels: ['P'],
          properties: { k: i % 97, s: `s${i % 1000}`, n: i },
        });
      }

      return g.vertexCount;
    },
  },

  /** `addEdge` and its label indexing, on a vertex set built OUTSIDE the measured phase. */
  addEdgeOnly: {
    reps: 6,
    setup: () => buildVertices(() => ({})),
    run: ({ g, vs }) => {
      for (let k = 0; k < N * FANOUT; k += 1) {
        g.addEdge({
          id: `e${k}`,
          from: vs[(k * 7919) % N],
          to: vs[((k % N) * 104_729 + Math.floor(k / N) * 977) % N],
          labels: ['E'],
          properties: { w: k % 13 },
        });
      }

      return g.edgeCount;
    },
  },

  /** Property UPDATES on a warm graph — `ts-set-is-o-width` says this makes three O(K) passes. */
  setProps: {
    reps: 10,
    setup: () => buildVertices((i) => ({ k: i, s: 'x' })),
    run: ({ g, vs }) => {
      for (let i = 0; i < N; i += 1) {
        vs[i].properties = { k: i + 1, s: 'y' };
      }

      return g.vertexCount;
    },
  },

  /** DELETES, which item 1357 flagged as the unmeasured half of the ordinal question. */
  removeVertices: {
    reps: 10,
    setup: () => buildVertices((i) => ({ k: i })),
    run: ({ g, vs }) => {
      for (let i = 0; i < N; i += 1) {
        g.removeVertex(vs[i]);
      }

      return g.vertexCount === 0 ? 1 : 0;
    },
  },

  /**
   * The O(1)-BY-ID CONTROL, which the standing instruction names explicitly.
   *
   * ⚠️ The ids are PRE-BUILT, because item 1395 measured that constructing `` `v${i}` `` per lookup
   * costs ~45-56 ns against ~5 ns for the lookup — ten times the thing being measured — and drifts
   * with id length on its own. `id-lookup-hotset-probe.mjs` is the instrument for the invariant;
   * this is only the write screen's control, and it should not re-introduce that confound.
   */
  pointLookups: {
    reps: 10,
    setup: () => {
      const { g } = buildVertices(() => ({}));
      const ids = Array.from({ length: N }, (_, i) => `v${i}`);

      return { g, ids };
    },
    run: ({ g, ids }) => {
      let hits = 0;

      for (let r = 0; r < 10; r += 1) {
        for (let i = 0; i < N; i += 1) {
          if (g.getVertexById(ids[i]) !== undefined) {
            hits += 1;
          }
        }
      }

      return hits;
    },
  },
};

const shape = SHAPES[SHAPE];

if (shape === undefined) {
  throw new Error(`unknown shape ${SHAPE}; have ${Object.keys(SHAPES).join(',')}`);
}

const REPS = Number(process.argv[3] ?? shape.reps);

// BUILT FIRST, ALL OF THEM, and deliberately: the alternative is to build inside the measured loop,
// which is the defect this probe had. One fixture per rep because writes mutate — reusing one would
// measure `addEdge` onto a graph that already has the edges, or `removeVertex` on an empty graph.
const states = [];

for (let i = 0; i < REPS; i += 1) {
  states.push(shape.setup === undefined ? undefined : shape.setup());
}

let sink = 0;

const t0 = performance.now();

await profileWindow(process.env.PROF_OUT, () => {
  for (let i = 0; i < REPS; i += 1) {
    sink += shape.run(states[i]);
  }

  return sink;
});

const ms = performance.now() - t0;

// Asserted, not printed and ignored: a shape that silently did nothing would profile the error path
// and look like a result.
if (sink === 0) {
  throw new Error(
    `${SHAPE} produced NOTHING across ${REPS} runs — the profile would be of nothing`,
  );
}

console.log(
  JSON.stringify({
    shape: SHAPE,
    reps: REPS,
    n: N,
    setupExcluded: shape.setup !== undefined,
    ms: Number(ms.toFixed(1)),
    msPerRep: Number((ms / REPS).toFixed(2)),
    sink,
  }),
);
