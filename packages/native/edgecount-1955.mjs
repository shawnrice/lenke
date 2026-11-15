// Item 1955 — the edge-PREDICATE family's three GENERIC rows, priced. The walk already exists.
//
// Item 1882 built `edgeFilteredHopValues` for `V().outE(T).has(k, pred).inV().values(j)` and the
// route screen confirms it fuses (0 `applyStep` calls). Three siblings in the same family did NOT
// get a route and still run the full generator chain:
//
//     generic   edgef: outE has inV count       4 applyStep calls
//     generic   edgef: outE has count           3
//     generic   edgef: outE has values          3
//     SHORTCUT  edgef: outE has inV values      0   ⬅ the rung item 1882 built
//
// 🔑 THE TERMINAL IS THE ONLY DIFFERENCE for the first two, and a COUNT needs strictly less than a
// values projection — no cell, no row object, no stream of results. So if `...inV().values(j)` is
// fused and `...inV().count()` is generic, the count is paying a full generator chain to compute
// something cheaper than what the fused arm already computes.
//
// ⚠️ THE DENOMINATOR IS EDGE VISITS, NOT ROWS. All four shapes visit the same 1,000,000 `E` edges;
// the filter keeps 3 of 7, and a count returns ONE row. A per-row ratio would be meaningless (item
// 1882's own note, and item 1858 declined a target for exactly that mistake), so every number here
// is ns per EDGE VISITED.
//
//     bun edgecount-1955.mjs
import { Graph } from '@lenke/core';
import { count, gt, has, inV, outE, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const THRESH = 3;
const EDGES = NODES * FANOUT;

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 12 } });
}

for (let e = 0; e < EDGES; e += 1) {
  const i = e % NODES;
  // Split on the REPEAT INDEX — the generator trap CLAUDE.md records.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: { w: e % 7 },
  });
}

/** The order-preserving hand ceiling: per-vertex adjacency, matching the engine's stream order. */
const handCount = () => {
  let n = 0;

  for (const v of g.verticesByLabel.get('T') ?? []) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (edge.properties.w > THRESH) {
        n += 1;
      }
    }
  }

  return [n];
};

const handEdgeValues = () => {
  const out = [];

  for (const v of g.verticesByLabel.get('T') ?? []) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (edge.properties.w > THRESH) {
        out.push(edge.properties.w ?? null);
      }
    }
  }

  return out;
};

const SHAPES = {
  'outE has inV values  (FUSED)': () =>
    toArray(traversal(V(), outE('E'), has('w', gt(THRESH)), inV(), values('n')), g),
  'outE has inV count   (generic)': () =>
    toArray(traversal(V(), outE('E'), has('w', gt(THRESH)), inV(), count()), g),
  'outE has count       (generic)': () =>
    toArray(traversal(V(), outE('E'), has('w', gt(THRESH)), count()), g),
  'outE has values      (generic)': () =>
    toArray(traversal(V(), outE('E'), has('w', gt(THRESH)), values('w')), g),
  'HAND count           (ceiling)': handCount,
  'HAND edge values     (ceiling)': handEdgeValues,
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const time = (fn) => {
  const ts = [];
  let rows = 0;
  let first;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = fn();

    ts.push(performance.now() - t0);

    if (r === 0) {
      rows = got.length;
      [first] = got;
    }
  }

  return { ms: med(ts), rows, first };
};

console.log(
  `NODES=${String(NODES)} FANOUT=${String(FANOUT)} |E|=${String(EDGES)} REPS=${String(REPS)} median`,
);
console.log(`# ns/visit is per EDGE VISITED (${String(EDGES)}), never per row\n`);
console.log('shape                             ms    ns/visit     rows   first');

for (const [name, fn] of Object.entries(SHAPES)) {
  const r = time(fn);

  console.log(
    `${name.padEnd(32)} ${r.ms.toFixed(1).padStart(6)}  ${((r.ms * 1e6) / EDGES).toFixed(0).padStart(8)}  ${String(r.rows).padStart(7)}   ${String(r.first)}`,
  );
}
