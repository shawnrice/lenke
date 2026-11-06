/**
 * The Gremlin WRITE path, which had NO coverage at all (item 1577).
 *
 * `grep -c 'addV\\|addE\\|property\\|drop'` over every Gremlin probe in this directory returns 0, and
 * the 32-shape profile probe is reads only. Item 1554 found and closed the same gap on the GQL side,
 * so this is its twin.
 *
 * ⚠️ THE LOOKUP KEY IS INDEXED, and that is the whole lesson of item 1554. Its first run measured a
 * `SET` at 695 us/op and read it as write cost; the real figure was 4.61 us and the other 690 was a
 * 20,000-vertex SCAN inside the `MATCH`, counted once in the floor arm and once in each write.
 * `INDEXED=0` reproduces the mistake deliberately.
 *
 * ⚠️ PER-OPERATION, NOT BULK. `ts-ingest-is-constant-factor` already closed bulk ingest. The open
 * question is the SERVING shape: one small write at a time against a graph that already holds data.
 *
 * Each arm gets a FRESH graph, so no arm inherits another's mutations and per-operation cost is
 * measured against a constant starting size.
 */
import { Graph } from '@lenke/core';
import { V, addE, addV, drop, property, toArray, traversal } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 20_000);
const OPS = Number(process.env.OPS ?? 2_000);
const REPS = Number(process.env.REPS ?? 5);

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
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

  if (process.env.INDEXED !== '0') {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });
  }

  return g;
};

/** Each arm: (graph, i) => runs ONE operation. */
const ARMS = {
  'addV label': (g) => toArray(traversal(addV('Q')), g),
  'addV + 2 props': (g, i) =>
    toArray(traversal(addV('Q'), property('k', i % 97), property('n', i)), g),
  'property on V(id)': (g, i) => toArray(traversal(V(`v${i}`), property('k', i + 1)), g),
  'addE between ids': (g, i) =>
    toArray(
      traversal(
        addE('F')
          .from(V(`v${i}`))
          .to(V(`v${(i + 1) % NODES}`)),
      ),
      g,
    ),
  'drop V(id)': (g, i) => toArray(traversal(V(`v${i}`), drop()), g),
  // The READ each write does first, as the floor: no arm above can be cheaper.
  '[floor] V(id)': (g, i) => toArray(traversal(V(`v${i}`)), g),
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

    // Warm the plan/route caches before timing.
    op(g, 0);
    op(g, 1);

    const t0 = performance.now();

    for (let i = 2; i < OPS; i += 1) {
      op(g, i);
    }

    series.push(performance.now() - t0);
  }

  // Drop the first rep and take the min of the rest, as `gql-write-probe.mjs` does.
  const kept = series.slice(1).sort((a, b) => a - b);

  rows.push({ name, ms: kept[0], perOp: (kept[0] * 1000) / (OPS - 2) });
}

console.log(
  `Gremlin write path — NODES=${NODES} OPS=${OPS} REPS=${REPS} ` +
    `INDEXED=${process.env.INDEXED === '0' ? 'no' : 'yes'} (min of kept)\n`,
);

for (const r of rows) {
  console.log(
    `${r.name.padEnd(20)} ${r.ms.toFixed(1).padStart(9)} ms   ${r.perOp.toFixed(2).padStart(8)} us/op`,
  );
}
