/**
 * IS THE GQL ONE-HOP PROJECTION DELEGATION OR LAYOUT? (item 1895)
 *
 * ⚠️ THE `handSet` METHOD FROM ITEM 1893, APPLIED TO THE OTHER ENGINE. That item found the Gremlin
 * edge rung was **2.08x its own hand-written walk over the identical data** — so the structure was
 * never the first problem — and the fix was a twenty-line eager fill. A profile cannot separate
 * delegation from layout (the cost is spread across `pick`, the walk, the getters); a hand arm over
 * the SAME structure can, and that is all this file is.
 *
 * The GQL shape, isolated at 200,000 vertices (`count-depth-floor-1890.mjs`, FANOUT 1):
 *
 * ```text
 *   MATCH (a0:P)-[:E]->(a1:P) RETURN a1.k AS k    39.23 ms   200,000 rows   196 ns a row
 * ```
 *
 * where Gremlin's `V().out(E).values(n)` is **53 ns a row** after item 1889. The two are not the
 * same work — GQL must build a `{k: …}` ROW OBJECT per row where Gremlin emits a bare value — so
 * this file prices that difference rather than assuming it.
 *
 * The arms, each over the SAME graph and returning the SAME rows:
 *
 *   engine        the shipped rung (`detectHopProjection`'s far-driven walk)
 *   handFar       the same far-driven walk by hand: iterate vertices, read the in-bucket, project
 *                 ONCE and clone per edge — the engine's own strategy, written out
 *   handArr       the same over a PREBUILT flat array of (far, degree) pairs — what a CSR reaches
 *   handLit       the same, building each row as a fresh `{ k: v }` LITERAL instead of cloning a
 *                 template — prices the object spread the engine uses
 *   handBare      bare values, no row objects at all — the Gremlin comparison, to price the row
 *
 * ⚠️ FANOUT IS A PARAMETER AND THE DEFAULT IS 5, not the grid's 1: the engine's strategy is "project
 * once per far vertex, clone per edge", so at fanout 1 the clone loop never runs and the arm that
 * matters most is invisible. The grid uses 1 deliberately for its own reason (every depth returns
 * the same rows); this file is about the per-row cost.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const ARM = process.env.ARM ?? 'engine';

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({ id: `v${String(i)}`, labels: ['P'], properties: { k: i % 997 } });
}

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  g.addEdge({
    id: `e${String(e)}`,
    // The repeat index is in the expression — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy.
    from: g.getVertexById(`v${String(i)}`),
    to: g.getVertexById(`v${String((i * 7 + 3 + hop * 2_654_435_761) % N)}`),
    labels: ['E'],
  });
}

{
  const seen = new Set();

  for (let hop = 0; hop < FANOUT; hop += 1) {
    seen.add((3 + hop * 2_654_435_761) % N);
  }

  if (FANOUT > 1 && seen.size < 2) {
    throw new Error(`fixture is FUNCTIONAL: v0 reaches ${String(seen.size)} distinct targets`);
  }
}

const TEXT = 'MATCH (a:P)-[:E]->(b:P) RETURN b.k AS k';

const engine = () => query(g, TEXT).length;

/** The engine's own strategy, by hand: project once per far vertex, clone per incoming edge. */
const handFar = () => {
  const rows = [];

  for (const far of g.verticesById.values()) {
    const bucket = far.adjTo?.get('E');

    if (bucket === undefined || bucket.size === 0) {
      continue;
    }

    const template = { k: far.properties.k };

    rows.push(template);

    for (let n = bucket.size - 1; n > 0; n -= 1) {
      rows.push({ ...template });
    }
  }

  return rows.length;
};

/** The same, over a prebuilt flat (far, degree) index — what a CSR reaches. */
const index = (() => {
  const far = [];
  const deg = [];

  for (const v of g.verticesById.values()) {
    const bucket = v.adjTo?.get('E');

    if (bucket !== undefined && bucket.size > 0) {
      far.push(v);
      deg.push(bucket.size);
    }
  }

  return { far, deg };
})();

const handArr = () => {
  const { far, deg } = index;
  const rows = [];

  for (let i = 0; i < far.length; i += 1) {
    const template = { k: far[i].properties.k };

    rows.push(template);

    for (let n = deg[i] - 1; n > 0; n -= 1) {
      rows.push({ ...template });
    }
  }

  return rows.length;
};

/** The same, with each row a fresh LITERAL rather than a spread of a template. */
const handLit = () => {
  const { far, deg } = index;
  const rows = [];

  for (let i = 0; i < far.length; i += 1) {
    const value = far[i].properties.k;

    for (let n = deg[i]; n > 0; n -= 1) {
      rows.push({ k: value });
    }
  }

  return rows.length;
};

/** Bare values, no row objects — the Gremlin comparison, pricing the row itself. */
const handBare = () => {
  const { far, deg } = index;
  const rows = [];

  for (let i = 0; i < far.length; i += 1) {
    const value = far[i].properties.k;

    for (let n = deg[i]; n > 0; n -= 1) {
      rows.push(value);
    }
  }

  return rows.length;
};

const ARMS = { engine, handFar, handArr, handLit, handBare };
const arm = ARMS[ARM];
const series = [];
// ⚠️ THE COLD REPS ARE REPORTED, not just dropped: a cached CSR's build is paid on rep 1 and
// invisible afterwards, and item 1889 found a lever whose whole risk lived there.
const cold = [];
let rows = 0;

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();

  rows = arm();

  const ms = performance.now() - t0;

  if (r >= 2) {
    series.push(ms);
  } else {
    cold.push(ms);
  }
}

series.sort((a, b) => a - b);

const ms = series[series.length >> 1];

console.log(
  `${ARM.padEnd(9)} ${ms.toFixed(2).padStart(8)} ms  ${String(rows).padStart(8)} rows  ` +
    `${((ms * 1e6) / Math.max(rows, 1)).toFixed(0).padStart(4)} ns/row   ` +
    `cold ${cold.map((x) => x.toFixed(0)).join('/')}`,
);
