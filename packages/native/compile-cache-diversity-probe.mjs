/**
 * WHAT DOES THE ENGINE COST WHEN THE QUERY TEXT IS NEVER THE SAME TWICE? (item 1839)
 *
 * EVERY PROBE IN THIS DIRECTORY RUNS ONE TEXT IN A LOOP, so the parse+plan caches (items
 * 228/229) hit on every rep after the first and their cost is divided away by the rep count. A real
 * application issues hundreds of DISTINCT texts; if those caches are small, or keyed in a way a
 * diverse workload defeats, the compile cost is paid per query and no instrument here would show
 * it. That is a hole in the screen rather than a known-good result.
 *
 * THE COMPARISON IS THE SAME TEXTS TWICE, NOT TWO DIFFERENT WORKLOADS. Comparing "500 distinct
 * queries" against "one query 500 times" would compare different WORK — the texts do different
 * things — and the difference would be mostly execution. Running the identical list twice holds the
 * work exactly fixed and varies only the cache state, so the gap between pass 1 and pass 2 IS the
 * compile cost (plus whatever else is cold on first sight of a text).
 *
 * THE CORPUS IS ITEM 1817's WORKLOAD GENERATOR, for the reason that item exists: it is the one
 * list here of queries a user would plausibly write that was NOT assembled by someone hunting a
 * particular lever. Hand-writing 500 texts would bias the diversity toward whatever I happened to
 * think of.
 *
 * **ITS RESOLUTION, STATED BEFORE ITS NUMBERS — THIS PROBE CANNOT ANSWER ITS OWN QUESTION BY
 * SUBTRACTION, AND ITS FIRST RUN PROVED IT.** The cold/warm delta on 500 texts read 244.2 ms, which
 * looks like 488 us a text — but the later warm/warm rounds, which by construction should be
 * EQUAL, read deltas of 48.9, 87.5, **-178.6** and 13.2 ms. A noise band of +-180 ms cannot resolve
 * a 244 ms signal. The guard line at the bottom of the output says exactly this, and it is there
 * because the number above it is otherwise quotable.
 *
 * SO THE DIRECT COUNTERS ARE THE INSTRUMENT, NOT THIS SUBTRACTION. `parseCacheStats()` reports
 * `size`, `seen`, `cap`, `liftHits` and `liftStores` — what the cache actually did, with no timing
 * involved. This probe is kept for the CORPUS it drives (item 1817's generator is the only
 * non-circular source of realistic query texts here) and for the resolution lesson above; read the
 * counters for the mechanism.
 *
 *     bun compile-cache-diversity-probe.mjs
 *     TEXTS=2000 NODES=20000 bun compile-cache-diversity-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { WORKLOAD_FAMILIES } from './src/workload-queries.js';

/**
 * A SMALL GRAPH ON PURPOSE, AND THE FIRST RUN PROVED BOTH HALVES OF WHY. At 5,000 vertices this
 * probe died to the cgroup OOM killer (exit 137): the corpus includes the comma-join family, whose
 * `MATCH (a:T), (b:T)` is 25,000,000 rows there — item 1820 hit exactly this and solved it with one
 * child process per family.
 *
 * The fix here is the opposite and better suited: make the graph SMALL. This probe is measuring
 * COMPILE cost, and execution is the noise it has to see through — at 400 vertices every query in
 * the corpus runs in microseconds, so the pass-1/pass-2 delta is almost entirely the caches. A
 * large graph would bury a per-text compile cost under the row work it is trying to separate from.
 */
const NODES = Number(process.env.NODES ?? 400);
const FANOUT = Number(process.env.FANOUT ?? 5);
const TEXTS = Number(process.env.TEXTS ?? 500);
const ROUNDS = Number(process.env.ROUNDS ?? 5);
const SEED = Number(process.env.SEED ?? 20_261_114);

const mulberry32 = (seed) => {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b_79f5) >>> 0;
    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** The fuzzer fixture's schema at scale, so the generated literals stay selective. */
const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];
const X_POOL = [-1, 0, 2, 3, 4, 5];
const S_POOL = ['a', 'z', 'm', '', 'nope'];
const DATES = ['1999-12-31', '2024-01-02', '2024-01-03', '2031-11-30'];

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    const properties = {
      n: N_POOL[i % N_POOL.length],
      x: X_POOL[i % X_POOL.length],
      s: S_POOL[i % S_POOL.length],
      nu: i % 3 === 1 ? null : (i % 9) + 1,
      d: { '@date': DATES[i % DATES.length] },
      m: { k: i % 7, j: `q${i % 5}` },
    };

    if (i % 3 === 0) {
      properties.st = `p${i % 11}`;
    }

    g.addVertex({ id: String(i + 1), labels: i % 6 === 2 ? ['T', 'U'] : ['T'], properties });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: hop % 4 === 3 ? ['F'] : ['E'],
      properties: { w: [1, 2, 3, 4, 5, 7, 9][e % 7] },
    });
  }

  return g;
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;

  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const g = build();
const r = mulberry32(SEED);
const workloads = [];
const seen = new Set();

/**
 * DISTINCT TEXTS, ASSERTED. The generator draws from a finite set of templates, so asking for
 * more texts than it can produce would silently give a list with repeats — and repeats are exactly
 * what this probe is measuring the absence of. It collects until it has `TEXTS` distinct ones or
 * runs out of patience, then reports what it actually got.
 */
for (let i = 0; i < TEXTS * 200 && workloads.length < TEXTS; i += 1) {
  const w = WORKLOAD_FAMILIES[Math.floor(r() * WORKLOAD_FAMILIES.length)](r);

  if (!seen.has(w.text)) {
    seen.add(w.text);
    workloads.push(w);
  }
}

console.log(`# compile-cache-diversity-probe NODES=${NODES} FANOUT=${FANOUT} rounds=${ROUNDS}`);
console.log(`# vertices=${g.vertexCount} edges=${g.edgeCount}`);
console.log(`# asked for ${TEXTS} DISTINCT texts, got ${workloads.length}\n`);

if (workloads.length < TEXTS / 2) {
  throw new Error(
    `only ${workloads.length} distinct texts of ${TEXTS} — the generator cannot supply this diversity`,
  );
}

const pass = () => {
  const t0 = performance.now();
  let rows = 0;

  for (const w of workloads) {
    try {
      rows += query(g, w.text, w.params).length;
    } catch {
      // Counted by the caller's digest check, not swallowed silently — see below.
    }
  }

  return { ms: performance.now() - t0, rows };
};

const cold = [];
const warm = [];
let digest = -1;

for (let round = 0; round < ROUNDS; round += 1) {
  // A FRESH PROCESS IS THE ONLY TRUE COLD, and this is not one — the caches persist across
  // rounds, so only ROUND 0's first pass is genuinely cold. Later rounds measure a WARM/WARM pair
  // and are reported separately rather than averaged in, because averaging them would dilute the
  // one measurement that answers the question.
  const a = pass();
  const b = pass();

  if (digest === -1) {
    digest = a.rows;
  } else if (a.rows !== digest || b.rows !== digest) {
    throw new Error(`row count moved between passes (${a.rows}/${b.rows} vs ${digest})`);
  }

  cold.push(a.ms);
  warm.push(b.ms);
  console.log(
    `  round ${round}  first ${a.ms.toFixed(1).padStart(8)} ms   second ${b.ms
      .toFixed(1)
      .padStart(8)} ms   delta ${(a.ms - b.ms).toFixed(1).padStart(7)} ms`,
  );
}

const [firstCold] = cold;
const [firstWarm] = warm;

console.log(`\n# ROUND 0 is the only genuinely cold pass (the caches persist across rounds).`);
console.log(
  `#   cold ${firstCold.toFixed(1)} ms   warm ${firstWarm.toFixed(1)} ms   ` +
    `delta ${(firstCold - firstWarm).toFixed(1)} ms over ${workloads.length} texts = ` +
    `${(((firstCold - firstWarm) * 1000) / workloads.length).toFixed(1)} us/text`,
);
console.log(
  `#   later rounds (warm/warm): median first ${median(cold.slice(1)).toFixed(1)} ms, ` +
    `median second ${median(warm.slice(1)).toFixed(1)} ms — these should be EQUAL, and a gap here ` +
    `means something other than the cache is warming up`,
);
