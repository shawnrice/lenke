/*
 * Item 2091 — IS `getVertexById` / `getEdgeById` ACTUALLY O(1)? A standing requirement, never measured.
 *
 * `getVertexById` appears in EVERY profile taken this session at 5-16%, and by-id access is the one
 * complexity guarantee this work is held to. A `Map` lookup is O(1) amortized, but the engine wraps it
 * — and a degraded id read would be invisible to every screen here, because the fixture BUILD calls it
 * heavily and so it shows up as a hot frame either way.
 *
 * THE INSTRUMENT: per-call cost at four sizes spanning the transition CLAUDE.md names ("cache-
 * resident and not are different questions; the transition is between 200k and 1M elements"). O(1)
 * means the per-call figure is FLAT in N apart from cache effects; anything trending with N is a
 * different complexity class.
 *
 * THE IDS ARE DRAWN SCATTERED, not in insertion order. A sequential sweep is cache-friendly in a
 * way no real id lookup is, and would hide exactly the regime that matters — the same reason item
 * 2085's label probe scattered its candidates.
 *
 * THE LOOKUP COUNT IS HELD CONSTANT across sizes, so only the working set varies. A probe doing N
 * lookups at each N measures N × (per-call cost) and cannot separate the two.
 */
import { Graph } from '@lenke/core';

const REPS = Number(process.env.REPS ?? 9);
const LOOKUPS = Number(process.env.LOOKUPS ?? 200000);
const SIZES = (process.env.SIZES ?? '25000,100000,400000').split(',').map(Number);

/** Median of the post-warm-up reps — item 2080's rule: `min` hides a bimodal path. */
const medianOf = (series) => {
  const kept = series.slice(3).sort((a, b) => a - b);

  return kept[Math.floor(kept.length / 2)];
};

const measure = (n) => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${i}`, labels: ['T'], properties: { k: i } });
  }

  for (let i = 0; i < n; i += 1) {
    g.addEdge({
      id: `e${i}`,
      from: g.getVertexById(`v${i}`),
      to: g.getVertexById(`v${(i * 7 + 3) % n}`),
      labels: ['E'],
      properties: {},
    });
  }

  // Scattered probe ids, precomputed so string building is not in the timed loop.
  const vIds = new Array(LOOKUPS);
  const eIds = new Array(LOOKUPS);

  for (let i = 0; i < LOOKUPS; i += 1) {
    const slot = (i * 104729) % n;

    vIds[i] = `v${slot}`;
    eIds[i] = `e${slot}`;
  }

  const runV = () => {
    let seen = 0;

    for (let i = 0; i < LOOKUPS; i += 1) {
      if (g.getVertexById(vIds[i]) !== undefined) {
        seen += 1;
      }
    }

    return seen;
  };

  const runE = () => {
    let seen = 0;

    for (let i = 0; i < LOOKUPS; i += 1) {
      if (g.getEdgeById(eIds[i]) !== undefined) {
        seen += 1;
      }
    }

    return seen;
  };

  /*
   * **THE CONTROL, AND WITHOUT IT THIS PROBE PROVES NOTHING.** A string-keyed `Map` is O(1) and
   * STILL gets slower with N: more entries means more cache and TLB misses, and the ids themselves
   * grow longer (`v399999` hashes more than `v24999`). So a raw `Map.get` over the SAME keys at the
   * SAME sizes is the floor — if the engine tracks it, the growth is inherent to the data structure
   * and the engine's wrapper adds nothing. [[floor-arm-must-take-same-route]].
   */
  const raw = new Map();

  for (let i = 0; i < n; i += 1) {
    raw.set(`v${i}`, i);
  }

  const runRaw = () => {
    let seen = 0;

    for (let i = 0; i < LOOKUPS; i += 1) {
      if (raw.get(vIds[i]) !== undefined) {
        seen += 1;
      }
    }

    return seen;
  };

  runV();
  runE();
  runRaw();

  const vs = [];
  const es = [];
  const rs = [];

  for (let r = 0; r < REPS; r += 1) {
    let t0 = performance.now();
    const gotV = runV();

    vs.push(performance.now() - t0);
    t0 = performance.now();

    const gotE = runE();

    es.push(performance.now() - t0);
    t0 = performance.now();

    const gotR = runRaw();

    rs.push(performance.now() - t0);

    if (gotR !== LOOKUPS) {
      throw new Error(`n=${n}: the raw Map control missed ${LOOKUPS - gotR} keys`);
    }

    // EVERY LOOKUP MUST HIT. A probe whose ids miss measures the MISS path, which is a different
    // question and is also faster — so a silent miss would read as a win.
    if (gotV !== LOOKUPS || gotE !== LOOKUPS) {
      throw new Error(
        `n=${n}: ${gotV}/${gotE} hits of ${LOOKUPS} — the probe ids do not all exist`,
      );
    }
  }

  return {
    v: (medianOf(vs) * 1e6) / LOOKUPS,
    e: (medianOf(es) * 1e6) / LOOKUPS,
    r: (medianOf(rs) * 1e6) / LOOKUPS,
  };
};

console.log(
  `  ${LOOKUPS} lookups per rep, median of ${REPS}, scattered ids, all asserted to HIT\n`,
);
console.log(
  `  ${'N'.padStart(9)}  ${'vertex'.padStart(9)}  ${'edge'.padStart(9)}  ${'raw Map'.padStart(9)}  ${'vertex/raw'.padStart(10)}`,
);

const first = {};

for (const n of SIZES) {
  const { v, e, r } = measure(n);

  first.v ??= v;
  first.e ??= e;
  first.r ??= r;
  console.log(
    `  ${String(n).padStart(9)}  ${v.toFixed(2).padStart(9)}  ${e.toFixed(2).padStart(9)}  ` +
      `${r.toFixed(2).padStart(9)}  ${(v / r).toFixed(2).padStart(10)}x` +
      `   (growth vs smallest: vertex x${(v / first.v).toFixed(2)}, raw x${(r / first.r).toFixed(2)})`,
  );
}
