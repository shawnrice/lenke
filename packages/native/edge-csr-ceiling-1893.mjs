/**
 * WHAT WOULD AN EDGE-INDEXED CSR BUY THE EDGE-FILTER RUNG? A HAND FLOOR, BEFORE BUILDING ONE
 * (item 1893).
 *
 * Items 1891 and 1892 both ended by naming `V().outE(T).has(k, p).inV().values(j)` as the Gremlin
 * screen's top shape at scale and saying it "wants an edge-indexed CSR". This file prices that claim
 * before anything is built — items 1693/1694's method, where a `handCsr` arm priced the vertex CSR
 * at 6.00x warm and 0.83x cold and that pair of numbers was the whole decision.
 *
 * Measured first, isolated at 200,000 vertices / 1,000,000 edges (`edge-filter-floor-1882.mjs`):
 *
 * ```text
 *   V().outE(E).has(w, gt 3).inV().values(n)   125.38 ms   457,142 rows   157 ns an edge visit
 *   V().outE(E).inV().values(n)                 43.04      800,000         54
 * ```
 *
 * AND THE UNFILTERED TWIN IS NOT THE FLOOR FOR THIS SHAPE, which is the trap this file avoids:
 * `outE(T).inV()` is REWRITTEN to `out(T)` before the planner sees it (the spelling probe's
 * "hop: out(T) vs outE(T).inV()" group is plan-identical, item 1812), so it rides item 1889's
 * vertex CSR and never touches an edge. The filtered spelling cannot be rewritten — the predicate
 * sits between the two halves — so it must visit EDGES, and the question is what visiting them
 * costs at best.
 *
 * THE PROFILE SAYS THE ITERATION IS NOT THE BILL. At 200,000 (query 50% of the process):
 *
 * ```text
 *   pick (the far vertex's property)      14.3%
 *   the walk itself                       12.7%
 *   the edge gate                          7.1%
 *   get properties (Edge)                  6.7%
 *   get properties (Vertex)                5.1%
 * ```
 *
 * A CSR replaces the `Map.get` + `Set` iteration — the walk frame — and leaves both property reads
 * and the predicate exactly where they are. So the arms below are the honest comparison:
 *
 *   engine     the shipped rung
 *   handSet    the same walk by hand over `adjFrom.get(T)` — the delegation floor
 *   handArr    the same walk over a PREBUILT array of edges per vertex — what a CSR can reach
 *   handArrB   the same, with the property bags hoisted into parallel arrays — the ceiling if the
 *              getters went away too, which no CSR achieves and which prices them
 *
 * `handArr`'s build is OUTSIDE the timed region, exactly as a cached CSR's would be after the first
 * query; `handArr + build` is reported separately because item 1694's whole finding was that the
 * build is what decides.
 */
import { Graph } from '@lenke/core';
import { V, gt, has, inV, outE, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const W_POOL = [1, 2, 3, 4, 5, 7, 9];

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: N_POOL[i % N_POOL.length] },
  });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
    properties: { w: W_POOL[e % W_POOL.length] },
  });
}

{
  const seen = new Set();

  for (let hop = 0; hop < FANOUT; hop += 1) {
    seen.add((3 + hop * 2_654_435_761) % N);
  }

  if (FANOUT > 1 && seen.size < 2) {
    throw new Error(`fixture is FUNCTIONAL: v1 reaches ${String(seen.size)} distinct targets`);
  }
}

const plan = traversal(V(), outE('E'), has('w', gt(3)), inV(), values('n'));

/** The engine, through its own rung. */
const engine = () => toArray(plan, g).length;

/** The same walk by hand over the per-vertex bucket — the delegation floor. */
const handSet = () => {
  const out = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (edge.properties.w > 3) {
        const value = edge.to.properties.n;

        if (value !== undefined) {
          out.push(value);
        }
      }
    }
  }

  return out.length;
};

/** The adjacency FLATTENED: one array of edges, with per-vertex offsets. A CSR's reach. */
const buildArr = () => {
  const off = new Int32Array(N + 1);
  const flat = [];
  let slot = 0;

  for (const v of g.vertices) {
    off[slot] = flat.length;

    const bucket = v.adjFrom?.get('E');

    if (bucket !== undefined) {
      for (const edge of bucket) {
        flat.push(edge);
      }
    }

    slot += 1;
  }

  off[slot] = flat.length;

  return { off, flat };
};

const arr = buildArr();

const handArr = () => {
  const { off, flat } = arr;
  const out = [];

  for (let slot = 0; slot < N; slot += 1) {
    const to = off[slot + 1];

    for (let i = off[slot]; i < to; i += 1) {
      const edge = flat[i];

      if (edge.properties.w > 3) {
        const value = edge.to.properties.n;

        if (value !== undefined) {
          out.push(value);
        }
      }
    }
  }

  return out.length;
};

/**
 * The same walk with BOTH property bags hoisted into parallel arrays — so the only per-row work is
 * two array reads, a comparison and a push.
 *
 * NO CSR CAN REACH THIS, and that is why it is here: it prices the two `properties` getters,
 * which the profile puts at ~12% together. If `handArr` lands near `handArrB`, the getters are not
 * the bill; if it lands near `handSet`, the iteration is not.
 */
const bags = (() => {
  const { flat } = arr;
  const w = new Float64Array(flat.length);
  const far = new Float64Array(flat.length);

  for (let i = 0; i < flat.length; i += 1) {
    w[i] = flat[i].properties.w;
    far[i] = flat[i].to.properties.n;
  }

  return { w, far };
})();

const handArrB = () => {
  const { off } = arr;
  const { w, far } = bags;
  const out = [];

  for (let slot = 0; slot < N; slot += 1) {
    const to = off[slot + 1];

    for (let i = off[slot]; i < to; i += 1) {
      if (w[i] > 3) {
        out.push(far[i]);
      }
    }
  }

  return out.length;
};

const ARMS = { engine, handSet, handArr, handArrB };
const name = process.env.ARM ?? 'engine';
const arm = ARMS[name];
const series = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();

  rows = arm();

  const ms = performance.now() - t0;

  if (r >= 2) {
    series.push(ms);
  }
}

series.sort((a, b) => a - b);

// The build is timed separately, because item 1694's finding was that the build decides.
const t0 = performance.now();

buildArr();

const build = performance.now() - t0;

console.log(
  `${name.padEnd(9)} ${series[series.length >> 1].toFixed(2).padStart(8)} ms  ${String(rows).padStart(7)} rows   ` +
    `(a rebuild of the flat index costs ${build.toFixed(0)} ms)`,
);
