/**
 * IS A TS WRITE'S COST THE QUERY LAYER OR THE CORE? — a hand floor for writes (item 1457).
 *
 * `write-gap-probe.ts` screens TS against native and reports `DELETE edges` at **25.5x** and
 * `SET on an edge` at **16.2x**. Those are cross-engine ratios, and the repo's own lesson is that a
 * big one is often DATA LAYOUT rather than overhead — item 234 built a per-shape floor and it
 * retracted two of three targets on exactly that basis. So a ratio against native cannot say whether
 * there is anything to remove; a floor against the SAME core can.
 *
 * The arms run the identical mutation three ways, on a freshly built graph each rep:
 *
 *   engine     the GQL query, `MATCH (a:P)-[e:E]->(b) DELETE e` / `… SET e.w = 42`
 *   floor      a hand loop: walk the adjacency, collect the edges, call the CORE method per edge
 *   floorPre   the same loop with the edge list COLLECTED OUTSIDE the timed window
 *
 * `floorPre` is the one that separates the two halves. `floor` still pays to FIND the edges, so
 * `engine - floor` is the query layer's overhead on top of the same core calls, while
 * `floor - floorPre` is what finding them costs. A target in the query layer and a target in
 * `Graph.removeEdge` are different items with different owners.
 *
 * ⚠️ A WRITE IS NOT IDEMPOTENT, so every rep rebuilds the graph and the BUILD IS OUTSIDE the timed
 * window — the same discipline `write-gap-probe` uses, and the reason that probe exists separately
 * from the read screen. The verification is a count AFTER the mutation, asserted per rep: a delete
 * that deleted nothing would otherwise be the fastest arm.
 *
 *   OP=delete ARM=engine NODES=20000 REPS=7 node write-floor-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

/**
 * ⚠️ DELETE ONLY, deliberately. The `SET` floor needs `@lenke/core`'s actual edge-property write path
 * and there is no `setEdgeProperty` on `Graph` — its edge surface is `addEdge`, `removeEdge`,
 * `addLabelToEdge`, `reindexEdgeProperty`, … so a hand floor for `SET e.w = 42` would be a guess at
 * which of those the executor composes. Guessing it would produce a floor that is not the engine's
 * own work, which is item 1450's error (an ablation the implementation cannot reproduce). Identify
 * the path first, then add the arm.
 */
const OP = process.env.OP ?? 'delete';
const ARM = process.env.ARM ?? 'engine';
const NODES = Number(process.env.NODES ?? 20_000);
const DEG = Number(process.env.DEG ?? 2);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);

if (OP !== 'delete') {
  throw new Error(`OP must be delete (see the note above); got ${OP}`);
}

if (!['engine', 'floor', 'floorPre'].includes(ARM)) {
  throw new Error(`ARM must be engine, floor or floorPre; got ${ARM}`);
}

/** The same fixture shape `write-gap-probe` uses: one node in ten is `:P`, so `:P` selects 10%. */
const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: i % 10 === 0 ? ['P', 'Univ'] : ['Univ'],
        properties: { k: i % 7, u: `u${i}` },
      }),
    );
  }

  let e = 0;

  for (let i = 0; i < NODES; i += 1) {
    for (let d = 0; d < DEG; d += 1) {
      g.addEdge({
        id: `e${e}`,
        from: vs[i],
        to: vs[(i * 7 + 3 + d) % NODES],
        labels: ['E'],
        properties: { w: e % 13 },
      });
      e += 1;
    }
  }

  return g;
};

/** Every `E` edge out of a `:P` vertex — what `MATCH (a:P)-[e:E]->(b)` selects. */
const targets = (g) => {
  const out = [];

  for (const v of g.vertices) {
    // `labels` is a `Set`, not an array — the probe's first run died on `.includes` here, which is
    // the kind of thing a floor built from assumption gets wrong before it gets anything right.
    if (!v.labels.has('P')) {
      continue;
    }

    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      out.push(edge);
    }
  }

  return out;
};

const DELETE_Q = 'MATCH (a:P)-[e:E]->(b) DELETE e';
const VERIFY_DELETE = 'MATCH (a)-[:E]->(b) RETURN count(*) AS c';

const series = [];
let touched = 0;
let after = 0;

/**
 * ⚠️ A WRITE PROBE CANNOT WINDOW ONE REP, and the first attempt here proved it twice over. Profiled
 * without a window the top frames were all fixture construction (`indexEdgeLabel` 11.71%, `build`
 * 6.00%, `insertEdge` 3.74%, `addVertex` 3.35%) because a write is not idempotent so the graph is
 * rebuilt every rep. Profiled with the window around a SINGLE mutation, the profile had ~11 samples
 * — every share a multiple of 1/11 — and `profileWindow` inflated the median from 14.70 ms to 66.08,
 * a 4.5x perturbation on a 15 ms window.
 *
 * So: build EVERY fixture first, then put one window around all the mutations. The builds cost
 * `REPS` graphs of memory at once, which is why `NODES` stays modest here, and the per-rep timings
 * are still taken individually inside the window so `median` means what it did before.
 */
const graphs = [];
const pres = [];

for (let r = 0; r < REPS; r += 1) {
  const g = build();

  graphs.push(g);
  pres.push(ARM === 'floorPre' ? targets(g) : undefined);
}

const mutateAll = () => {
  for (let r = 0; r < REPS; r += 1) {
    const g = graphs[r];
    const pre = pres[r];
    const t0 = performance.now();

    if (ARM === 'engine') {
      query(g, DELETE_Q);
    } else {
      const edges = pre ?? targets(g);

      for (const e of edges) {
        g.removeEdge(e);
      }

      touched = edges.length;
    }

    series.push(performance.now() - t0);
  }
};

await profileWindow(process.env.PROF_OUT, mutateAll);

// ASSERTED FOR EVERY REP, after the window: a mutation that mutated nothing would be the fastest arm.
const want = NODES * DEG - (NODES / 10) * DEG;

for (let r = 0; r < REPS; r += 1) {
  after = query(graphs[r], VERIFY_DELETE)[0]['c'];

  if (after !== want) {
    throw new Error(`${ARM}/${OP} rep ${r}: verify got ${after}, expected ${want}`);
  }
}

const kept = series.slice(DROP).sort((a, b) => a - b);
const at = (f) => kept[Math.min(kept.length - 1, Math.floor(f * kept.length))];

console.log(
  JSON.stringify({
    op: OP,
    arm: ARM,
    nodes: NODES,
    deg: DEG,
    reps: REPS,
    touched,
    verified: after,
    median: Number(at(0.5).toFixed(3)),
    p25: Number(at(0.25).toFixed(3)),
    min: Number(kept[0].toFixed(3)),
    max: Number(kept[kept.length - 1].toFixed(3)),
    series: series.map((x) => Number(x.toFixed(2))),
  }),
);
