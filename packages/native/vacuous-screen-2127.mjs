/**
 * THE VACUOUS-PREDICATE SCREEN: which filtered rungs throw their selectivity away? (item 2127)
 *
 * 🔑 ITEM 2126 FOUND ITS 1.81-5.65x WITH ONE CONTROL, AND THIS GENERALIZES IT. A predicate that rejects
 * NOTHING cannot be cheaper than one that rejects half — but it must not be DEARER-or-equal either. When
 * the real predicate and its vacuous twin cost the same, the expensive work is happening BEFORE the
 * filter, so selectivity buys nothing and the cost is the ROUTE (item 570's instrument, generalized).
 *
 * ```text
 *     item 2126, before:  real 31.9 ms   vacuous 32.4   ratio 0.98   <- the defect
 *     item 2126, after:   real 17.9      vacuous 30.0   ratio 0.60   <- fixed
 * ```
 *
 * ⚠️ SO THE SIGNAL IS `real / vacuous` NEAR 1.0, AND THE FIX MOVES IT DOWN. A rung that filters early
 * should land near its pass fraction; one that filters late lands at 1.0 whatever the selectivity.
 *
 * 🔑 THREE SELECTIVITIES PER SHAPE, not two, because a single pair cannot tell "filters late" from
 * "the filter is most of the work": `vacuous` (100% pass), `half` (~50%) and `sharp` (~4%). A healthy
 * rung's times should SEPARATE across those; a defective one is flat.
 *
 * ⚠️ THIS IS A SCREEN, NOT A RESULT. A flat row says "look here", and the look is an A/B of the real rung
 * — this loop's own history is explicit that a micro-probe mispriced it twice (item 591's inlined probe
 * read 18.29 ms against the row's 42.2; item 2125 repeated the mistake). Absolute times here are for
 * ranking only.
 */
import { Graph } from '@lenke/core';
import { V, count, gt, has, hasLabel, out, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);

const graph = new Graph();

for (let i = 0; i < N; i += 1) {
  graph.addVertex({
    id: `v${i}`,
    labels: i % 3 === 0 ? ['Person', 'Admin'] : ['Person'],
    properties: { age: i % 90, name: `p${i}`, n: i % 7 },
  });
}

let e = 0;

/*
 * ⚠️ SPLIT ON THE REPEAT INDEX. `to = (a*k + b) % N` is invariant under `k -> k + N`, so a flat
 * `for (k = 0; k < N*FANOUT; k++)` loop sends one vertex's whole fan-out to the SAME target — degrees
 * look perfect and the graph is FUNCTIONAL (items 1516/1518).
 */
for (let d = 0; d < FANOUT; d += 1) {
  for (let i = 0; i < N; i += 1) {
    graph.addEdge({
      id: `e${e}`,
      from: graph.getVertexById(`v${i}`),
      to: graph.getVertexById(`v${(i * 7 + 3 + d * 104_729) % N}`),
      labels: ['KNOWS'],
      properties: {},
    });
    e += 1;
  }
}

/* 🔑 COUNT DISTINCT ENDPOINTS — every degree check passes on a degenerate generator. */
const targets = new Set();

for (const edge of graph.getVertexById('v0').adjFrom?.get('KNOWS') ?? []) {
  targets.add(edge.to.id);
}

if (targets.size !== FANOUT) {
  throw new Error(`fixture is degenerate: v0 reaches ${targets.size} targets, want ${FANOUT}`);
}

/*
 * Each shape as a function of the threshold, so the three selectivities are the SAME route with a
 * different constant — the only way the comparison means anything.
 */
const SHAPES = {
  'out.has.count': (t) => traversal(V(), out('KNOWS'), has('age', gt(t)), count()),
  'has.count': (t) => traversal(V(), has('age', gt(t)), count()),
  'has.has.count': (t) => traversal(V(), has('age', gt(t)), has('n', gt(-1)), count()),
  'hasLabel.has.count': (t) => traversal(V(), hasLabel('Person'), has('age', gt(t)), count()),
  'has.out.count': (t) => traversal(V(), has('age', gt(t)), out('KNOWS'), count()),
  'out.has.values': (t) => traversal(V(), out('KNOWS'), has('age', gt(t)), values('age')),
  'has.values': (t) => traversal(V(), has('age', gt(t)), values('age')),
  'out.out.has.count': (t) =>
    traversal(V(), out('KNOWS'), out('KNOWS'), has('age', gt(t)), count()),
};

/* `gt(-1)` passes every age (0..89); `gt(44)` about half; `gt(85)` about 4.4%. */
const LEVELS = [
  ['vacuous', -1],
  ['half', 44],
  ['sharp', 85],
];

/*
 * The cost of iterating the vertices ONCE, times a 4x margin: below this a shape has no room to win no
 * matter what its ratio says. Measured at ~4.5 ns a vertex for a bare `for…of` over `graph.vertices`.
 */
const SCAN_FLOOR_MS = N * 4.5e-6 * 4;

const timeIt = (plan) => {
  const series = [];
  let rows = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = toArray(plan, graph);

    series.push(performance.now() - t0);
    rows = got.length;
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  return { ms: kept[Math.floor(kept.length / 2)], rows };
};

console.log(`\n  ${N} vertices / ${e} edges, median of ${REPS}\n`);
console.log(
  `  ${'shape'.padEnd(20)} ${'vacuous'.padStart(9)} ${'half'.padStart(9)} ${'sharp'.padStart(9)}  ${'sharp/vac'.padStart(10)}`,
);

for (const [name, build] of Object.entries(SHAPES)) {
  const got = LEVELS.map(([, t]) => timeIt(build(t)));
  const [vac, , sharp] = got;
  const ratio = sharp.ms / vac.ms;
  /*
   * ⚠️⚠️ **TWO CONDITIONS, AND THE SECOND IS WHAT KEEPS THIS FROM CRYING WOLF.** A flat ratio alone is
   * NOT a defect: where the predicate IS the whole work — `V().has(p).count()` must test every vertex —
   * selectivity cannot help, and flat is the correct reading.
   *
   * 🔑 Item 2127 checked both flagged rows against a HAND-WRITTEN scan and the engine was FASTER:
   *
   * ```text
   *     hand-written scan + predicate            2.58 ms
   *     engine V().has(age,gt(85)).count()       1.44      <- 1.8x FASTER than the naive loop
   *     engine V().hasLabel().has(...).count()   1.34
   *     bare scan, no predicate                  0.90      <- the iteration floor
   * ```
   *
   * ⚠️ So a row is only a candidate when selectivity buys nothing AND the shape costs materially more
   * than scanning the vertices once. `SCAN_FLOOR_MS` is that gate, scaled from the measured ~4.5 ns a
   * vertex for a bare iteration with a generous 4x margin — a shape under it has no room to win.
   */
  const flag = ratio > 0.8 && vac.ms > SCAN_FLOOR_MS ? '  ⚠️ SELECTIVITY BUYS NOTHING' : '';

  console.log(
    `  ${name.padEnd(20)} ${got.map((x) => x.ms.toFixed(2).padStart(9)).join(' ')}  ${ratio.toFixed(2).padStart(9)}x${flag}`,
  );
}
