// Item 2036 — DOES THE GREMLIN SIDE HAVE A LABEL-VACUITY CLIFF? The GQL side's was 7.47x-184x.
//
// 🔑 THE NOMINATION CAME FROM A ROUTE CENSUS, NOT A TIMING. `gremlin-route-screen.mjs` gained a
// `MIXED=1` mode (one ISOLATED off-label vertex — no edges, so no answer changes) and exactly ONE of
// its 98 rows changed route:
//
//     scan: hasLabel values    SHORTCUT  ->  generic
//
// Gremlin's mechanism differs from GQL's: `dropVacuousLabels` REMOVES a vacuous `hasLabel` step from
// the plan, so one vertex lacking the label makes the step SURVIVE, and the rung whose gate expects
// the exact `V() + values` shape then declines. 97 of 98 rows are route-identical, so the cliff is
// NARROW — but `V().hasLabel(X)` is one of the most common shapes in the language.
//
// ⚠️ NO GREMLIN FIXTURE IN THIS REPO HAD EVER BEEN LABEL-MIXED, which is the same blindness that hid
// the GQL cliff until item 2032. The workload screen's own `scan: hasLabel count` row uses `U`, which
// is ALREADY selective (1 vertex in 6) — so it measures the step-survives arm and never the cliff.
//
// ⚠️ A CONTROL THE CHANGE CANNOT REACH: `V().values(k)` has no label step at all, so `MIXED` must not
// move it. If it does, the fixture is the variable rather than the route.
//
//     bun gremlin-label-cliff-2036.mjs
//     N=200000 REPS=9 bun gremlin-label-cliff-2036.mjs
import { Graph } from '@lenke/core';
import { count, hasLabel, toArray, traversal, V, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 50000);
const REPS = Number(process.env.REPS ?? 7);
const OPS = Number(process.env.OPS ?? 20);

const build = (mixed) => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i % 7, s: `s${i % 7}` } });
  }

  if (mixed) {
    // ISOLATED and off-label: `vacuous` is an exact size test against the vertex count, so this one
    // vertex flips it permanently while leaving every answer over `T` untouched.
    g.addVertex({ id: 'vOFF', labels: ['Q'], properties: { k: -1, s: 'off' } });
  }

  for (let i = 0; i < N; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3) % N}`),
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }

  return g;
};

const SHAPES = {
  'hasLabel values': () => traversal(V(), hasLabel('T'), values('k')),
  'hasLabel count': () => traversal(V(), hasLabel('T'), count()),
  // ⚠️ CONTROLS: no label step, so no vacuity gate can reach them.
  'values (control)': () => traversal(V(), values('k')),
  'count (control)': () => traversal(V(), count()),
};

const graphs = { vacuous: build(false), mixed: build(true) };
const results = {};

for (const [name, mk] of Object.entries(SHAPES)) {
  for (const [mode, g] of Object.entries(graphs)) {
    /*
     * ⚠️ ANSWER-EQUIVALENCE ACROSS MODES IS THE PRECONDITION: the off-label vertex is isolated and
     * carries no `T`, so every `hasLabel('T')` answer must be identical, and the unlabelled controls
     * must differ by exactly the one extra vertex. Asserted, because a route comparison between two
     * different questions is meaningless.
     */
    const rows = toArray(mk(), g);
    const got = Array.isArray(rows) ? rows.length : 1;
    /*
     * A labelled shape answers over `T` only, so the off-label vertex is invisible to it; an
     * UNLABELLED control sees the one extra vertex. A function rather than nested ternaries, which
     * `no-nested-ternary` rejects.
     */
    const expectedRows = () => {
      if (name.includes('count')) {
        return 1;
      }

      return name.includes('control') && mode === 'mixed' ? N + 1 : N;
    };
    const expectRows = expectedRows();

    if (got !== expectRows) {
      throw new Error(`${name}/${mode} returned ${got} rows, expected ${expectRows}`);
    }

    const series = [];

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();

      for (let o = 0; o < OPS; o += 1) {
        toArray(mk(), g);
      }

      series.push(performance.now() - t0);
    }

    // Median of the plateau: the TS paths tier up over the first reps, and `min` reports a mode the
    // arm does not hold (CLAUDE.md's estimator note).
    const plateau = series.slice(2).sort((a, b) => a - b);

    results[`${name}|${mode}`] = plateau[Math.floor(plateau.length / 2)];
  }
}

console.log(
  `\n  ${N} vertices, ${N} edges, ${OPS} ops per rep, median of the plateau over ${REPS}\n`,
);

for (const name of Object.keys(SHAPES)) {
  const a = results[`${name}|vacuous`];
  const b = results[`${name}|mixed`];

  console.log(
    `  ${name.padEnd(20)} vacuous ${a.toFixed(1).padStart(8)}   mixed ${b.toFixed(1).padStart(8)}   ${(b / a).toFixed(2)}x`,
  );
}
