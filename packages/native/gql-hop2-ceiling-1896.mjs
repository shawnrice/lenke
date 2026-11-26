/**
 * WHY DOES ONE MORE HOP COST 9.5x AT THE SAME ROW COUNT? (item 1896)
 *
 * FANOUT 1 IS WHAT MAKES THE QUESTION SHARP, and it is the grid's own fixture: with one out-edge
 * per vertex every depth returns exactly N rows, so a cost difference across depth is about the
 * ROUTE and not about how many rows came back (item 1815). Isolated, 200,000 vertices, after item
 * 1895 gave the one-hop projection its CSR arm (`count-depth-floor-1890.mjs`):
 *
 * ```text
 *   MATCH (a0:P)-[:E]->(a1:P) RETURN a1.k AS k                     8.22 ms   200,000 rows
 *   MATCH (a0:P)-[:E]->(a1:P)-[:E]->(a2:P) RETURN a2.k AS k       78.38      200,000
 * ```
 *
 * The second hop adds 70 ms for the SAME 200,000 rows. The hand arms below say whether that is
 * delegation (item 1893's Gremlin finding) or per-vertex `Map` work (item 1895's GQL one), because a
 * profile cannot separate the two and both items were decided by exactly this probe shape:
 *
 *   engine     the shipped `hop2Projection` rung
 *   handWalk   the same two-hop walk by hand, start-driven over `adjFrom.get(T)`
 *   handCsr    the same over two CSR levels — flat `Int32Array` runs, no `Map` in the loop
 *   handBare   the same, pushing bare values instead of `{k: …}` rows — prices the row object
 *
 * The CSR build is OUTSIDE the timed region, as a cached one would be after the first query, and is
 * reported separately — item 1694's finding was that the build is what decides.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 1);
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
    from: g.getVertexById(`v${String(i)}`),
    to: g.getVertexById(`v${String((i * 7 + 3 + hop * 2_654_435_761) % N)}`),
    labels: ['E'],
  });
}

const TEXT = 'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P) RETURN c.k AS k';

const engine = () => query(g, TEXT).length;

/** The same two-hop walk by hand, start-driven over the per-vertex buckets. */
const handWalk = () => {
  const rows = [];

  for (const a of g.verticesById.values()) {
    const first = a.adjFrom?.get('E');

    if (first === undefined) {
      continue;
    }

    for (const e1 of first) {
      const second = e1.to.adjFrom?.get('E');

      if (second === undefined) {
        continue;
      }

      for (const e2 of second) {
        rows.push({ k: e2.to.properties.k });
      }
    }
  }

  return rows.length;
};

/** Two CSR levels: `order`/`off`/`nbr` as flat arrays, no `Map` in the loop. */
const buildCsr = () => {
  const order = [...g.verticesById.values()];
  const idx = new Map();

  for (let s = 0; s < order.length; s += 1) {
    idx.set(order[s], s);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(N * FANOUT);
  let w = 0;

  for (let s = 0; s < order.length; s += 1) {
    off[s] = w;

    const bucket = order[s].adjFrom?.get('E');

    if (bucket !== undefined) {
      for (const e of bucket) {
        nbr[w] = idx.get(e.to);
        w += 1;
      }
    }
  }

  off[order.length] = w;

  return { order, off, nbr };
};

const csr = buildCsr();

const handCsr = () => {
  const { order, off, nbr } = csr;
  const rows = [];

  for (let s = 0; s < order.length; s += 1) {
    const end1 = off[s + 1];

    for (let i = off[s]; i < end1; i += 1) {
      const mid = nbr[i];
      const end2 = off[mid + 1];

      for (let j = off[mid]; j < end2; j += 1) {
        rows.push({ k: order[nbr[j]].properties.k });
      }
    }
  }

  return rows.length;
};

/** The same, pushing bare values — prices the row object itself. */
const handBare = () => {
  const { order, off, nbr } = csr;
  const rows = [];

  for (let s = 0; s < order.length; s += 1) {
    const end1 = off[s + 1];

    for (let i = off[s]; i < end1; i += 1) {
      const mid = nbr[i];
      const end2 = off[mid + 1];

      for (let j = off[mid]; j < end2; j += 1) {
        rows.push(order[nbr[j]].properties.k);
      }
    }
  }

  return rows.length;
};

/**
 * The hand walk PLUS the per-row work the engine does and `handWalk` does not: three label tests, a
 * binding per position, and a row built through a key list rather than a literal.
 *
 * IT EXISTS TO SPLIT THE 1.55x, because "delegation" is not a target — the individual costs are.
 * `matchesLabel(x, undefined)` is what a VACUOUS label compiles to, which is the grid's own query
 * and most real ones.
 */
const matchesLabelLike = (v, label) => label === undefined || v.labels.has(label.name);

const handWalkEngineish = () => {
  const rows = [];
  const binding = new Map();

  for (const a of g.verticesById.values()) {
    if (!matchesLabelLike(a, undefined)) {
      continue;
    }

    const first = a.adjFrom?.get('E');

    if (first === undefined) {
      continue;
    }

    binding.set('a', a);

    for (const e1 of first) {
      const b = e1.to;

      if (!matchesLabelLike(b, undefined)) {
        continue;
      }

      const second = b.adjFrom?.get('E');

      if (second === undefined) {
        continue;
      }

      binding.set('b', b);

      for (const e2 of second) {
        const c = e2.to;

        if (!matchesLabelLike(c, undefined)) {
          continue;
        }

        binding.set('c', c);
        rows.push({ k: c.properties.k });
      }
    }
  }

  return rows.length;
};

const ARMS = { engine, handWalk, handWalkEngineish, handCsr, handBare };
const arm = ARMS[ARM];
const series = [];
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

const t0 = performance.now();

buildCsr();

const build = performance.now() - t0;

console.log(
  `${ARM.padEnd(9)} ${series[series.length >> 1].toFixed(2).padStart(8)} ms  ${String(rows).padStart(8)} rows   ` +
    `cold ${cold.map((x) => x.toFixed(0)).join('/')}   (a CSR rebuild costs ${build.toFixed(0)} ms)`,
);
