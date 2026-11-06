/**
 * The GQL WRITE path, which this session had not measured at all (item 1554).
 *
 * Everything from items 1508-1553 was a READ: counts, hops, projections, label elisions. The brief
 * is the whole TS engine, so this is the other half — `INSERT`, `SET`, `REMOVE`, `DELETE` and the
 * `_MERGE` extension, each per operation against a warm graph.
 *
 * ⚠️ PER-OPERATION, NOT BULK. `ts-ingest-is-constant-factor` already closed bulk ingest (the 4x
 * against native is `JSON.parse` + alloc + freeze, and `addVertex` was WITHDRAWN at 7.4%). The open
 * question is the SERVING shape: one small write at a time on a graph that already holds data,
 * which is what `bun run bench:usage` exists for and what an application actually does.
 *
 * Each arm gets a FRESH graph of `NODES` vertices, so no arm inherits another's mutations and the
 * per-operation cost is measured against a constant starting size.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const OPS = Number(process.env.OPS ?? 2_000);
const REPS = Number(process.env.REPS ?? 5);

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(
      g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i, s: `s${i % 50}` } }),
    );
  }

  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: vs[i],
      to: vs[(i * 7 + 3) % NODES],
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }

  // ⚠️ An INDEX on `n`, so the per-operation cost is the WRITE rather than a 20,000-vertex scan.
  // `INDEXED=0` turns it off, which is what the first run of this probe measured by accident.
  if (process.env.INDEXED !== '0') {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });
  }

  return g;
};

/** Each arm: (graph, i) => runs ONE operation. */
const ARMS = {
  // ⚠️ THE INTERPOLATION IS THE POINT OF THIS ARM, and the repo's own `lenke/no-raw-interpolation`
  // rule is right to flag it everywhere else: splicing a value into query text is an injection
  // risk, and the rule's advice (a tagged template or a `$name` param) is what the arm below
  // measures against. Here the spliced values are loop integers in a benchmark, and the whole
  // purpose is to price what an interpolating caller pays — 4.17 against the parameterised 2.15
  // us/op, which is items 1540/1541's all-miss lift cost.
  // oxlint-disable-next-line lenke/no-raw-interpolation
  'INSERT node': (g, i) => query(g, `INSERT (:P {k: ${i % 97}, n: ${i}})`),
  'INSERT node, param': (g, i) => query(g, 'INSERT (:P {k: $k, n: $n})', { k: i % 97, n: i }),
  'SET one prop': (g, i) => query(g, 'MATCH (a) WHERE a.n = $n SET a.k = $v', { n: i, v: i + 1 }),
  'SET two props': (g, i) =>
    query(g, 'MATCH (a) WHERE a.n = $n SET a.k = $v, a.s = $s', { n: i, v: i + 1, s: 'x' }),
  'REMOVE one prop': (g, i) => query(g, 'MATCH (a) WHERE a.n = $n REMOVE a.s', { n: i }),
  'DELETE node': (g, i) => query(g, 'MATCH (a) WHERE a.n = $n DETACH DELETE a', { n: i }),
  // The read that each write has to do first, as the floor: none of the arms above can be cheaper.
  '[floor] MATCH only': (g, i) => query(g, 'MATCH (a) WHERE a.n = $n RETURN a.n AS n', { n: i }),
};

const only = process.env.ONLY;
const rows = [];

for (const [name, op] of Object.entries(ARMS)) {
  if (only !== undefined && !name.includes(only)) {
    continue;
  }

  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const g = build();

    // Warm the parse cache (admitted on the SECOND sighting) before timing.
    op(g, 0);
    op(g, 1);

    const t0 = performance.now();

    for (let i = 0; i < OPS; i += 1) {
      op(g, i);
    }

    series.push(performance.now() - t0);
  }

  const kept = series.slice(1).sort((a, b) => a - b);

  rows.push({ name, ms: kept[0], perOp: (kept[0] * 1000) / OPS });
}

console.log(`GQL write path — NODES=${NODES} OPS=${OPS} REPS=${REPS} (min of kept)\n`);

for (const r of rows) {
  console.log(
    `${r.name.padEnd(22)} ${r.ms.toFixed(1).padStart(9)} ms   ${r.perOp.toFixed(2).padStart(8)} us/op`,
  );
}
