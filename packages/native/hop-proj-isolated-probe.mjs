/**
 * IS `V().out(T).id()` REALLY SLOWER THAN `V().out(T).out(T).id()`? (item 1769)
 *
 * `bun run bench:gremlin` reports the one-hop `.id()` at 208.4 ms and the TWO-hop at 132.1 — a
 * two-hop beating its own prefix, on a fixture where the second hop multiplies the rows. That is
 * either a missing fusion on the one-hop arm or an artefact of the sweep.
 *
 * ⚠️ ONE SHAPE PER PROCESS, which is item 1640's lesson (it found "1.9-2.0x engine-vs-floor gaps"
 * to be SUBSTANTIALLY the instrument) and item 737's before it. A sweep NOMINATES; it does not
 * price, because rows interfere and arms that run minutes apart are compared across whatever the
 * machine did in between.
 *
 * ⚠️ AND THE ROWS ARE COUNTED AND ASSERTED, per CLAUDE.md's fixture rule. A per-row conclusion
 * drawn from two shapes whose row counts were assumed rather than measured is worthless — and the
 * whole question here IS per-row cost.
 *
 *     SHAPE=hop1id node hop-proj-isolated-probe.mjs
 */
import { Graph } from '@lenke/core';
import { id, out, toArray, traversal, V, values } from '@lenke/gremlin';

import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const N = Number(process.env.N ?? 5);
const SHAPE = process.env.SHAPE ?? 'hop1id';

const g = new Graph();
// Kept so the edge loop does not pay a lookup per edge; `addEdge` takes the vertices, not ids.
const verts = [];

for (let i = 0; i < NODES; i += 1) {
  verts.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: 20 + (i % 60) } }));
}

/**
 * ⚠️ THE REPEAT INDEX IS IN THE TARGET, not just `k`. CLAUDE.md records this as the defect that
 * survived 800 audit items: `to = (a * k + b) % N` is INVARIANT under `k -> k + N`, so a loop over
 * `k < NODES * FANOUT` gives one vertex's whole fan-out the SAME target. Out-degree looks perfect
 * and the graph is FUNCTIONAL, so any k-hop count is `F^k * N` by construction.
 */
for (let rep = 0; rep < FANOUT; rep += 1) {
  for (let i = 0; i < NODES; i += 1) {
    const to = (i * 7 + rep * 104_729 + 1) % NODES;

    g.addEdge({ id: `e${rep}-${i}`, from: verts[i], to: verts[to], labels: ['KNOWS'] });
  }
}

// The fixture's own statistic, not its output: how many DISTINCT targets does one vertex reach?
// An answer invariant to the thing being varied cannot validate the fixture.
const branchesOf = (vid) => new Set(toArray(traversal(V(vid), out('KNOWS'), id()), g)).size;
const sample = [0, 1, 7, 1000, NODES - 1].map((i) => branchesOf(`v${i}`));

if (sample.some((b) => b !== FANOUT)) {
  throw new Error(
    `fixture is degenerate: distinct out-targets per vertex ${JSON.stringify(sample)}, want ${FANOUT} — the generator collapsed`,
  );
}

const PLANS = {
  hop1id: traversal(V(), out('KNOWS'), id()),
  hop2id: traversal(V(), out('KNOWS'), out('KNOWS'), id()),
  hop1values: traversal(V(), out('KNOWS'), values('age')),
  hop2values: traversal(V(), out('KNOWS'), out('KNOWS'), values('age')),
};

const plan = PLANS[SHAPE];

if (plan === undefined) {
  throw new Error(`unknown SHAPE ${SHAPE}; have ${Object.keys(PLANS).join(',')}`);
}

const series = [];
let rows = 0;

for (let r = 0; r < N; r += 1) {
  const t = performance.now();

  await profileWindow(r === N - 1 ? process.env.PROF_OUT : undefined, () => {
    rows = toArray(plan, g).length;

    return rows;
  });

  series.push(performance.now() - t);
}

// Asserted: the per-row number is the whole point, so an arm that silently returned fewer rows
// would read as a win. `hop2` must be FANOUT times `hop1`, which is what makes them comparable.
const want = SHAPE.startsWith('hop1') ? NODES * FANOUT : NODES * FANOUT * FANOUT;

if (rows !== want) {
  throw new Error(`${SHAPE} returned ${rows} rows, expected ${want} — not the shape it claims`);
}

const kept = [...series].sort((a, b) => a - b);

console.log(
  JSON.stringify({
    shape: SHAPE,
    rows,
    minMs: Number(kept[0].toFixed(1)),
    medianMs: Number(kept[Math.floor(kept.length / 2)].toFixed(1)),
    nsPerRow: Number(((kept[0] * 1e6) / rows).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(1))),
  }),
);
