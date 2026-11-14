/**
 * WHAT DOES `optional(out(T))` COST OVER A FUSED HOP, AND WHAT IS ITS FLOOR? (item 1884)
 *
 * Item 1883's rung took the Gremlin workload screen's top shape, and the screen's new top shape is
 * `optional: hop` at **10.11 ms for 80,000 rows** against `hop1: values`' 3.49 ms for the SAME
 * 80,000 rows.
 *
 * ⚠️ AND `optional` IS ALREADY FUSED AT THE STEP LEVEL, which is what makes this worth measuring
 * rather than assuming. `optional-hop.ts` (items 1480/1483/1628) replaced `optionalStep`'s
 * per-traverser sub-plan — a one-element array, a 103-arm dispatch and a generator per step — with
 * one loop, and took the bucket directly for a directed single type. So whatever is left is NOT the
 * sub-plan wrapper that item 1480 removed.
 *
 * ⚠️ ON THIS FIXTURE EVERY VERTEX HAS AN OUT-EDGE, so `optional` NEVER takes its empty branch and
 * the two shapes return the same row count over the same walk. That is deliberate: it isolates the
 * per-row cost from the left-join semantics. The `sparse` arm exists for the other half — there a
 * vertex with no `E` edge emits ITSELF, which is the thing `out(T)` cannot do and the reason the
 * shapes are not interchangeable in general.
 *
 *     for s in optional hop optional_id sparse_optional sparse_hop; do \
 *       SHAPE=$s bun optional-hop-floor-1884.mjs; done
 */
import { Graph } from '@lenke/core';
import { V, groupCount, id, optional, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? 'optional';

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];

/** `sparse` gives only a third of the vertices an `E` out-edge, so the empty branch is exercised. */
const sparse = SHAPE.startsWith('sparse');
const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: N_POOL[i % N_POOL.length] },
  });
}

let edges = 0;

for (let e = 0; e < N * FANOUT; e += 1) {
  const i = e % N;
  const hop = Math.floor(e / N);

  // In the sparse arm only every third vertex emits, so two thirds take `optional`'s empty branch.
  if (sparse && i % 3 !== 0) {
    continue;
  }

  edges += 1;
  g.addEdge({
    id: `e${e}`,
    // The repeat index is in the expression — CLAUDE.md's fix for the `(a*k+b) % N` degeneracy.
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % N) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
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

const SHAPES = {
  optional: () => traversal(V(), optional(traversal(out('E'))), values('n')),
  hop: () => traversal(V(), out('E'), values('n')),
  optional_id: () => traversal(V(), optional(traversal(out('E'))), id()),
  sparse_optional: () => traversal(V(), optional(traversal(out('E'))), values('n')),
  sparse_hop: () => traversal(V(), out('E'), values('n')),
  // The CHAIN arm (item 1887), beside the two-hop walk that bounds it.
  opt2: () => traversal(V(), optional(traversal(out('E'), out('E'))), values('n')),
  hop2: () => traversal(V(), out('E'), out('E'), values('n')),
  // Item 1892: the grouped count over a hop, which had its OWN copy of the rung chain.
  group: () => traversal(V(), out('E'), groupCount().by('n')),
  group2: () => traversal(V(), out('E'), out('E'), groupCount().by('n')),
};

const plan = SHAPES[SHAPE]();
const series = [];
let rows = 0;

/**
 * ⚠️ EVERY REP IS RECORDED AND THE WARM-UPS ARE REPORTED SEPARATELY, because rep 1 is where a
 * one-shot query's costs live — including item 1888's CSR build, which is cached per graph per
 * `topologyVersion` and so is invisible from rep 2 onwards. Item 1695's criterion for an arm like
 * that is "safe iff the walk costs more than the rebuild", and only the cold rep can say.
 */
const cold = [];

for (let r = 0; r < REPS + 2; r += 1) {
  const t0 = performance.now();

  rows = toArray(plan, g).length;

  const ms = performance.now() - t0;

  if (r >= 2) {
    series.push(ms);
  } else {
    cold.push(ms);
  }
}

if (process.env.SERIES === '1') {
  console.log(
    `# ${SHAPE} COLD reps (dropped from the median): ${cold.map((x) => x.toFixed(1)).join(' ')}`,
  );
}

// ⚠️ THE SERIES IS PRINTABLE AND THAT IS NOT A CONVENIENCE. CLAUDE.md: "for the TS per-row path,
// `min`-of-N is the wrong estimator, and it can hide the win. Print the per-rep series before
// trusting any summary of it." This file's first 9-rep run read the `optional` arm at 116 ns a row
// where a 150-rep profile of the SAME shape read 70.3 — a whole verdict's worth of warm-up.
if (process.env.SERIES === '1') {
  console.log(`# ${SHAPE} series: ${series.map((x) => x.toFixed(1)).join(' ')}`);
}

series.sort((a, b) => a - b);

const ms = series[series.length >> 1];

console.log(
  `${SHAPE.padEnd(16)} ${ms.toFixed(2).padStart(8)} ms  ${String(rows).padStart(8)} rows  ` +
    `${((ms * 1e6) / Math.max(rows, 1)).toFixed(0).padStart(5)} ns/row   (${String(edges)} edges)`,
);
