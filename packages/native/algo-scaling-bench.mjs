/**
 * THE TS ALGORITHMS LIBRARY HAD NO BENCH ROW AT ALL — twelve procedures, ~2,200 lines, reachable
 * from BOTH surfaces (Gremlin's OLAP steps and GQL's `CALL`), and nothing in the probe corpus
 * touched them. Items 1462-1463 found 33-56x by asking "which shipped surface has no bench row?";
 * this asks it of `runAlgorithmSync`, which is the exact entry point both engines dispatch through.
 *
 * WHY THIS GROUND, SPECIFICALLY. Item 1466 declined a 3.3x walk because any edit to
 * `hop-values.ts` / `hop-projection.ts` moves unrelated rows up to ~16% in an arbitrary direction
 * (items 1413/1415/1440/1442/1462). `packages/core/src/algorithms/` is not those files and is not on
 * any query's row path, so a change here cannot pay that toll. The perturbation term is a reason to
 * move the search, not to stop it.
 *
 * WHAT IT MEASURES. Each algorithm at two sizes a 4x step apart, so the RATIO is the reading:
 * **4.0x is linear in V**, and a procedure whose cost is O(V·E) on a fixed-degree fixture should show
 * ~16x. Anything above its own expected exponent is the find. Item 1464's lesson is enforced in the
 * output rather than left to the reader: a two-point ratio makes a ratio, not a trend, so a row that
 * exceeds its expectation prints a note telling you to re-run it at `SIZES=4` before believing it.
 *
 * ⚠️ EACH ALGORITHM HAS ITS OWN SIZE SCALE, and it is not a convenience — it is a correctness
 * requirement for the fixture. `betweenness` and `closeness` are Brandes/BFS from EVERY vertex
 * (O(V·E)), so the 40,000-vertex fixture the hop benches use would run for hours and the row would
 * never be collected. Each carries a `div`: its size is `NODES / div`. The ratio stays comparable
 * because both of its points are divided equally; the absolute ms are NOT comparable across rows
 * with different `div`, and the output prints each row's actual V so that cannot be misread.
 *
 * The answer digest is checked across the two sizes for SHAPE (row count and column name), not
 * value — the values legitimately differ with V. A row whose count is not V is flagged, because
 * every one of these twelve returns one row per vertex.
 *
 *   node algo-scaling-bench.mjs                      # the sweep
 *   ALGO=pagerank NODES=200000 REPS=5 node algo-scaling-bench.mjs
 *   SIZES=4 ALGO=betweenness node algo-scaling-bench.mjs    # a trend, not a ratio
 *   PROF_OUT=/tmp/x.cpuprofile ALGO=labelPropagation node algo-scaling-bench.mjs
 *
 * ONE ALGORITHM PER PROCESS when a reading is load-bearing (item 762). The sweep shares a process
 * because these are twelve independent functions rather than one polymorphic dispatch site, but
 * `ALGO=` exists so any row that matters can be re-read on its own.
 */
import { Graph, runAlgorithmSync } from '@lenke/core';

import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 40_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 5);
const DROP = Number(process.env.DROP ?? 1);
const SIZES = Number(process.env.SIZES ?? 2);
const MULTILABEL = Number(process.env.MULTILABEL ?? 0);
const { ALGO } = process.env;
const FEATWIDTH = Number(process.env.FEATWIDTH ?? 4);

/**
 * `div` divides NODES for this row; `exp` is the ratio a 4x size step SHOULD produce given the
 * algorithm's complexity on a fixed-degree fixture. A row printing materially above its `exp` is the
 * only thing in this file worth acting on.
 */
const SPECS = [
  { name: 'degree', div: 1, exp: 4, config: { direction: 'both' } },
  { name: 'connectedComponents', div: 1, exp: 4, config: {} },
  { name: 'stronglyConnectedComponents', div: 1, exp: 4, config: {} },
  { name: 'onCycle', div: 1, exp: 4, config: {} },
  { name: 'labelPropagation', div: 1, exp: 4, config: { iterations: 10 } },
  { name: 'peerPressure', div: 1, exp: 4, config: { iterations: 10 } },
  { name: 'pagerank', div: 1, exp: 4, config: { iterations: 20 } },
  { name: 'personalizedPagerank', div: 1, exp: 4, config: { iterations: 20, sourceNodes: ['v0'] } },
  { name: 'shortestPath', div: 1, exp: 4, config: { source: 'v0' } },
  // ⚠️ A SEPARATE ROW BECAUSE IT IS A DIFFERENT ROUTE, not a variation of one. Unweighted
  // `shortestPath` takes the BFS arm; supplying `weightProperty` takes the Dijkstra heap. The row
  // above measured only the BFS arm, so until item 1470 the whole weighted path was unbenched.
  {
    name: 'shortestPath',
    label: 'shortestPathWeighted',
    div: 1,
    exp: 4,
    config: { source: 'v0', weightProperty: 'w' },
  },
  { name: 'neighborAggregate', div: 1, exp: 4, config: { feature: 'feat', op: 'mean' } },
  // O(V·E): a 4x size step is ~16x, and at div=1 these would not finish.
  { name: 'betweenness', div: 40, exp: 16, config: {} },
  { name: 'closeness', div: 40, exp: 16, config: {} },
];

/** The row's display + selection key: two specs can share an algorithm NAME but differ in config
 *  (`shortestPath` has a BFS arm and a Dijkstra arm), so the label is what keys a row. */
const keyOf = (s) => s.label ?? s.name;

if (ALGO !== undefined && !SPECS.some((s) => keyOf(s) === ALGO)) {
  throw new Error(`unknown ALGO ${ALGO}; have ${SPECS.map(keyOf).join(',')}`);
}

const build = (n) => {
  const g = new Graph();
  const vs = [];
  const feat = [];

  for (let j = 0; j < FEATWIDTH; j += 1) {
    feat.push(j);
  }

  for (let i = 0; i < n; i += 1) {
    vs.push(
      g.addVertex({
        id: `v${i}`,
        labels: ['P'],
        // `feat` is rebuilt per vertex: neighborAggregate reads the list, and sharing one array
        // across every vertex would let an aliasing bug read as a correct answer.
        properties: { k: i % 97, n: i, feat: feat.map((x) => x + (i % 5)) },
      }),
    );
  }

  for (let e = 0; e < n * FANOUT; e += 1) {
    const i = e % n;
    const hop = Math.floor(e / n);

    g.addEdge({
      id: `e${e}`,
      from: vs[i],
      to: vs[(i * 7 + 3 + hop * 2_654_435_761) % n],
      labels: MULTILABEL > 0 && e % MULTILABEL === 0 ? ['E', 'F'] : ['E'],
      properties: { w: (e % 13) + 1 },
    });
  }

  return g;
};

/** Row count + column name — the SHAPE, which must not change with V. */
const shapeOf = (rows) => {
  if (rows.length === 0) {
    return 'empty';
  }

  const cols = Object.keys(rows[0])
    .filter((c) => c !== 'node')
    .join('+');

  return `n=${rows.length} col=${cols}`;
};

const time = (fn) => {
  const t0 = performance.now();
  const out = fn();

  return { ms: performance.now() - t0, out };
};

/** Median of the kept reps — item 1456: `min` is the wrong estimator on a plateau-with-outlier. */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const runOne = (spec, n, g) => {
  const reps = [];
  let shape = '';

  for (let r = 0; r < REPS; r += 1) {
    const { ms, out } = time(() => runAlgorithmSync(spec.name, spec.config, g));

    reps.push(ms);

    if (r === 0) {
      shape = shapeOf(out);
    }
  }

  return { ms: median(reps.slice(DROP)), shape, reps };
};

/**
 * ⚠️ ONE FIXTURE PER (div, size), SHARED BY EVERY ALGORITHM AT THAT SCALE — and this is a
 * requirement, not a tidy-up. A mutated `Graph` is retained IN FULL by its own pending
 * `drainMutations` microtask, and this bench's body is synchronous, so the queue never drains and
 * **no graph it builds is ever collected**. The first version built one fixture per algorithm per
 * size (24 of them) and died at 4,087 MB; a heap snapshot gave the retaining path as
 * `(Micro tasks) -> drainMutations closure -> Context -> Graph -> verticesById -> Vertex`, and an
 * `await setTimeout(0)` between rounds flattened the staircase from +48 MB/round to 0.
 *
 * The body CANNOT simply become async: `profileWindow` does `result = body()` without awaiting, so
 * an async body would stop the profiler immediately and every `PROF_OUT` capture would be empty —
 * a silent instrument failure of exactly the kind this corpus keeps recording. Building 4 fixtures
 * instead of 24 fixes it within a synchronous body.
 *
 * None of these algorithms mutates the graph here (no `writeProperty` is set), so sharing a fixture
 * cannot let one row's writes reach another's answer.
 */
const measure = () => {
  const specs = ALGO === undefined ? SPECS : SPECS.filter((s) => keyOf(s) === ALGO);
  const steps = [];

  for (let s = 0; s < SIZES; s += 1) {
    steps.push(4 ** s);
  }

  const rows = new Map(specs.map((s) => [keyOf(s), { name: keyOf(s), exp: s.exp, points: [] }]));
  const divs = [...new Set(specs.map((s) => s.div))];

  for (const div of divs) {
    for (const mult of steps) {
      const n = Math.max(2, Math.floor((NODES * mult) / div));
      const g = build(n);

      for (const spec of specs.filter((s) => s.div === div)) {
        // Progress to stderr, so a row that OOMs or times out NAMES ITSELF. The first run of this
        // bench died anonymously at 4,087 MB and nothing in the output said which row held the heap.
        process.stderr.write(`[algo] ${keyOf(spec)} V=${n} …`);

        const { ms, shape } = runOne(spec, n, g);

        process.stderr.write(
          ` ${ms.toFixed(1)} ms, heap ${(process.memoryUsage().heapUsed / 1048576).toFixed(0)} MB\n`,
        );

        rows.get(keyOf(spec)).points.push({ n, ms, shape, perV: (ms * 1e6) / n });
      }
    }
  }

  return specs.map((s) => rows.get(keyOf(s)));
};

const results = await profileWindow(process.env.PROF_OUT, measure);

console.log(
  `\nTS ALGORITHMS SCALING — NODES=${NODES} FANOUT=${FANOUT} REPS=${REPS} DROP=${DROP} SIZES=${SIZES} MULTILABEL=${MULTILABEL}\n`,
);

const head = ['algorithm', 'V', 'ms', 'ns/V', 'V', 'ms', 'ns/V', 'ratio', 'exp', 'verdict'];

console.log(head.map((h, i) => (i === 0 ? h.padEnd(28) : h.padStart(10))).join(''));

for (const row of results) {
  const [a] = row.points;
  const b = row.points[row.points.length - 1];
  const ratio = row.points.length > 1 ? b.ms / a.ms : undefined;
  const over = ratio !== undefined && ratio > row.exp * 1.6;
  const cells = [
    row.name.padEnd(28),
    String(a.n).padStart(10),
    a.ms.toFixed(2).padStart(10),
    a.perV.toFixed(0).padStart(10),
  ];

  if (row.points.length > 1) {
    cells.push(
      String(b.n).padStart(10),
      b.ms.toFixed(2).padStart(10),
      b.perV.toFixed(0).padStart(10),
      `${ratio.toFixed(2)}x`.padStart(10),
      `${row.exp}x`.padStart(10),
      (over ? 'ABOVE' : 'ok').padStart(10),
    );
  }

  console.log(cells.join(''));

  for (const p of row.points) {
    if (!p.shape.startsWith(`n=${p.n} `)) {
      console.log(`  ⚠️ ${row.name} at V=${p.n} returned ${p.shape} — expected one row per vertex`);
    }
  }

  if (row.points.length > 1 && row.points[0].shape.split(' ')[1] !== b.shape.split(' ')[1]) {
    console.log(`  ⚠️ ${row.name} changed COLUMN between sizes — ${a.shape} vs ${b.shape}`);
  }

  if (over) {
    console.log(
      `  ⚠️ ${row.name}: ${ratio.toFixed(2)}x against an expected ${row.exp}x. A two-point ratio is a ratio, not a trend (item 1464) — re-run SIZES=4 ALGO=${row.name} before believing it.`,
    );
  }
}

console.log();
