/**
 * THE GREMLIN SCREEN, WITH A NATIVE REFERENCE AND THE SCAN FLOOR SUBTRACTED (item 2168).
 *
 * 🔑 Two methods that each earned themselves on the GQL side, applied to Gremlin for the first time:
 *
 *  1. **A NATIVE reference.** Item 2160 screened features against a TS-INTERNAL reference and both its
 *     flags evaporated against the cross-engine column — `nodes(p)` "24x" was 2.02x, and `labels()` was
 *     0.77x (TS FASTER). A TS-internal ratio nominates only WHICH RUNG serves a shape, never headroom.
 *  2. ⚠️⚠️ **THE SCAN FLOOR SUBTRACTED.** Item 2167 measured TS reading 200,000 properties in 4.29 ms
 *     against native's 0.09 — **48x** — and showed that single floor explains most GQL ratios: a top-10
 *     adds +1.10 ms against native's +0.94 (1.2x), `min`/`max` add +0.14 against +0.02, a full sort is
 *     1.0-1.1x. **So a raw ratio mostly measures the floor.** This screen prints the MARGINAL cost over
 *     the cheapest step that touches the same data.
 *
 * ⚠️ The Gremlin bench already compares TS against native, but item 2156 found its top rows sitting at
 * the SHARED adjacency floor — `V().out().has().count()` is 22x native and its GQL twin costs the same,
 * so it is not a Gremlin gap. This screen is built to separate those two cases by construction.
 *
 *     cd packages/native && bun run gremlin-floor-screen-2168.ts
 *     SCREEN_N=50000 bun run gremlin-floor-screen-2168.ts
 */
import { Graph as TsGraph } from '@lenke/core';
import {
  V,
  both,
  count,
  dedupe,
  fold,
  groupCount,
  gt,
  has,
  hasLabel,
  id,
  in_,
  limit,
  max,
  order,
  out,
  outE,
  path,
  planToGremlin,
  simplePath,
  sum,
  toArray,
  traversal,
  valueMap,
  values,
} from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';
import { graphFromNdjson } from './src/graph.js';

const N = Number(process.env.SCREEN_N ?? 200_000);
/*
 * ⚠️⚠️ **`MIXED=1`: THE REALISTIC-SCHEMA MODE, and without it every row measures an arm a real schema
 * cannot reach** (item 1943's design, applied to this screen at item 2188). The GQL fast-path layer gates
 * 43 elisions on a VACUOUS label — one that matches every vertex — and a homogeneous fixture makes that
 * vacuous by construction.
 *
 * 🔑 The flag appends ONE ISOLATED off-label vertex: no edges, a label nothing matches. So every shape's
 * ANSWER is unchanged and only `vertexCount` moves, which is exactly what the vacuity check compares
 * against. ⚠️ Item 1935's first attempt RELABELLED a vertex instead, which changed the match count AND the
 * edge set and produced 1221x ratios that were two different questions.
 *
 * ⚠️ **BOTH ARMS MUST RUN ON THE SAME BUILD** — item 1943's note, because diffing against a stale
 * homogeneous baseline credits the flag with whatever shipped in between.
 */
/*
 * ⚠️⚠️ **DEFAULT ON since item 2190, because item 2189 established the MIXED number is the one to price
 * against.** A homogeneous fixture makes every label VACUOUS by construction, which unlocks 43+ GQL
 * elisions a real schema cannot reach: the two-hop count reads **0.19 ms homogeneous against 15.55 on a
 * genuinely mixed schema — 82x** — and the realistic number is the one item 2087 already optimized.
 *
 * 🔑 `MIXED=0` restores the old homogeneous arm, which is useful ONLY for measuring the gate's own cost.
 * **A nomination taken from it is a nomination against an arm no application reaches.**
 */
const MIXED = process.env.MIXED !== '0';

const FANOUT = Number(process.env.SCREEN_FANOUT ?? 3);
const REPS = Number(process.env.SCREEN_REPS ?? 13);
/*
 * ⚠️⚠️ **SIX dropped, not three.** Item 2167's 1.3x "inversion" was warmup inside a 2-dropped window, and
 * item 2172 then measured how deep it actually runs: a GQL row read 44.0 15.8 10.3 27.3 12.1 41.9 before
 * settling at ~7.4, so SIX reps are warmup and a 3-dropped window still reports the tail of it. That
 * screen nominated a 5.2x phantom on a 2-dropped window.
 */
const WARMUP = Number(process.env.SCREEN_WARMUP ?? 6);

const doc = (() => {
  const lines: string[] = [];

  for (let i = 0; i < N; i += 1) {
    lines.push(
      `{"type":"node","id":"v${i}","labels":${i % 3 === 0 ? '["Person","Admin"]' : '["Person"]'},"properties":{"age":${i % 90},"k":${i % 97},"name":"person${i}"}}`,
    );
  }

  let id2 = 0;

  /* ⚠️ The repeat index is load-bearing: `(a*k + b) % N` is invariant under `k -> k + N`, so a flat loop
   * sends one vertex's whole fan-out to the SAME target (items 1516/1518). */
  for (let d = 0; d < FANOUT; d += 1) {
    for (let i = 0; i < N; i += 2) {
      lines.push(
        `{"type":"edge","id":"e${id2++}","labels":["KNOWS"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{"w":${i % 7}}}`,
      );
    }
  }

  if (MIXED) {
    lines.push('{"type":"node","id":"offlabel","labels":["NoSuchLabel"],"properties":{}}');
  }

  return lines.join('\n');
})();

const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${process.platform === 'darwin' ? 'dylib' : 'so'}`,
  import.meta.url,
).pathname;

const tsGraph = tsDeserialize(doc, 'ndjson', new TsGraph());
const natGraph = graphFromNdjson(createFfiEngineBackend(LIB), doc) as {
  gremlin: (text: string) => unknown;
  free: () => void;
};

/** Each row: a name, the plan, and whether it is the FLOOR its siblings are measured against. */
const ROWS: ReadonlyArray<readonly [string, Plan, boolean]> = [
  // ── The floor: the cheapest step that still touches every vertex's property ───────────────────
  ['FLOOR V().values(k).count()', traversal(V(), values('k'), count()), true],
  // ── Vertex-side steps, measured against that floor ────────────────────────────────────────────
  ['V().has(k, gt).count()', traversal(V(), has('k', gt(50)), count()), false],
  ['V().hasLabel().count()', traversal(V(), hasLabel('Admin'), count()), false],
  ['V().values(k).dedupe().count()', traversal(V(), values('k'), dedupe(), count()), false],
  ['V().values(k).order()', traversal(V(), values('k'), order()), false],
  ['V().id().count()', traversal(V(), id(), count()), false],
  // ── Edge-side steps. ⚠️ Their own floor is the untyped hop, not the vertex scan ───────────────
  /*
   * ⚠️⚠️ **`V().out().count()` IS NOT A VALID FLOOR AND WAS MY FIRST CHOICE** (and the `id()` floor that
   * replaced it was retired by item 2170 — see the note on FLOOR2 below). It reads 0.00 ms in BOTH
   * engines because a counter rung answers it without touching a single edge — so subtracting it leaves
   * the RAW time and the three edge-side rows below all "flagged" on their scan cost. 🔑 The floor has to
   * be the cheapest step that touches the SAME data: `id()` enumerates every edge's endpoint without
   * reading a property.
   */
  /*
   * ⚠️⚠️⚠️ **THE EDGE GROUP HAS NO VALID FLOOR AND IS REPORTED RAW. THREE CANDIDATES HAVE NOW FAILED.**
   *
   * ```text
   *     V().out().count()          0.00 ms BOTH engines   a counter rung, touches no edge
   *     V().out().id().count()     0.00 ms in TS          item 2170 made it a counter read too
   *     V().out().has(k).count()   24.95 ts / 0.27 nat    native elides the endpoint read entirely
   * ```
   *
   * 🔑 The first two are the SAME defect by different routes — a floor is only valid while it still
   * touches the data, and **optimizing the engine can retire a floor**, which is what item 2170 did here.
   * ⚠️ The third fails for item 2168's other reason: native answers these without reading any endpoint
   * property, so every floor yields NEGATIVE native marginals. **When the two engines elide different
   * work, no subtraction makes the rows comparable** — so these rows are printed RAW and never flagged,
   * and a reader must price them against a native column that is doing less work, not less of the same
   * work.
   *
   * 🔑 Worth a future item on its own terms: `V().out().values(k).count()` reads **41.37 ms in TS**.
   * Whatever native elides, 300,000 endpoint property reads costing 41 ms is a TS-side question.
   */
  ['RAW V().out().has(k).count()', traversal(V(), out('KNOWS'), has('k', gt(-1)), count()), false],
  ['RAW V().out().values(k).count()', traversal(V(), out('KNOWS'), values('k'), count()), false],
  [
    'RAW V().out().has(k, gt).count()',
    traversal(V(), out('KNOWS'), has('k', gt(50)), count()),
    false,
  ],
  ['RAW V().out().dedupe().count()', traversal(V(), out('KNOWS'), dedupe(), count()), false],
  /*
   * ── ROWS ADDED AT ITEM 2187 ───────────────────────────────────────────────────────────────────
   *
   * 🔑 The nine rows above are exhausted: items 2169/2170 took both vertex-side flags and item 2171
   * CLOSED the big edge row as refuted ground (`degreeOfTypes`, three ways). ⚠️ That is the same state
   * the GQL screen reached at item 2175 — and item 2176 showed what it actually meant: **a screen at
   * parity may have narrow COVERAGE, not a healthy engine.** Widening the GQL one found a +593 ms gap on
   * the first run.
   *
   * ⚠️ So these cover what the Gremlin screen never measured: the OTHER directions (`in`, `both`), path
   * and repeat, grouping, set operations, selection, and the scalar aggregates. **`out()` was the only
   * traversal step in the whole file.**
   *
   * ⚠️⚠️ **NO WRITE ROWS HERE, DELIBERATELY.** A write row must be idempotent because the harness times
   * 13 reps against ONE fixture (item 2176's note): `addV`/`addE` grow the graph 13x and would measure a
   * different graph every rep. They need a per-rep rebuild, which is a different instrument.
   */
  // ── Directions other than `out`, which was the only one measured ──────────────────────────────
  ['V().in().count()', traversal(V(), in_('KNOWS'), count()), false],
  ['V().both().count()', traversal(V(), both('KNOWS'), count()), false],
  ['V().outE().count()', traversal(V(), outE('KNOWS'), count()), false],
  // ── Paths and repetition ──────────────────────────────────────────────────────────────────────
  ['V().out().out().count()', traversal(V(), out('KNOWS'), out('KNOWS'), count()), false],
  ['V().out().simplePath().count()', traversal(V(), out('KNOWS'), simplePath(), count()), false],
  ['V().out().path().count()', traversal(V(), out('KNOWS'), path(), count()), false],
  // ── Grouping and set operations ───────────────────────────────────────────────────────────────
  ['V().groupCount().by(k)', traversal(V(), values('k'), groupCount()), false],
  ['V().out().dedupe().fold()', traversal(V(), out('KNOWS'), dedupe(), fold()), false],
  // ── Scalar aggregates over a scan ─────────────────────────────────────────────────────────────
  ['V().values(k).sum()', traversal(V(), values('k'), sum()), false],
  ['V().values(k).max()', traversal(V(), values('k'), max()), false],
  // ── Projection shapes ─────────────────────────────────────────────────────────────────────────
  ['V().valueMap().count()', traversal(V(), valueMap(), count()), false],
  ['V().limit(10).count()', traversal(V(), limit(10), count()), false],
];

const median = (xs: number[]): number => {
  const k = [...xs].sort((a, b) => a - b);

  return k[Math.floor(k.length / 2)];
};

const time = (fn: () => unknown): { ms: number; answer: string } => {
  const series: number[] = [];
  let answer = '';

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = fn();

    series.push(performance.now() - t0);
    answer = JSON.stringify(got).slice(0, 36);
  }

  return { ms: median(series.slice(WARMUP)), answer };
};

console.log(`\n  ${N} nodes / fanout ${FANOUT}, median of reps ${WARMUP + 1}-${REPS}\n`);
console.log(
  `  ${'step'.padEnd(32)} ${'ts'.padStart(7)} ${'native'.padStart(7)} ${'ratio'.padStart(7)}  ${'marginal ts/native'.padStart(20)}`,
);

let floor = { ts: 0, nat: 0 };

for (const [name, plan, isFloor] of ROWS) {
  const t = time(() => toArray(plan, tsGraph));
  const n = time(() => natGraph.gremlin(planToGremlin(plan)));

  if (isFloor) {
    floor = { ts: t.ms, nat: n.ms };
  }

  /* ⚠️ A `RAW ` row has no valid floor (see the edge-group note above): print no marginal at all rather
   * than a subtraction that would mislead. */
  const unfloored = name.startsWith('RAW ');
  const marginal =
    isFloor || unfloored
      ? ''
      : `+${(t.ms - floor.ts).toFixed(2)} / +${(n.ms - floor.nat).toFixed(2)}`;
  /*
   * ⚠️⚠️ **THE FLAG IS ON THE MARGINAL RATIO, NOT THE RAW ONE.** Item 2167 is why: TS's 48x property-scan
   * floor makes almost every raw ratio read 5x or worse while the step itself is at parity. A step is only
   * nominated when ITS OWN cost is over 3x native's and over 2 ms in absolute terms.
   */
  const mTs = t.ms - floor.ts;
  const mNat = n.ms - floor.nat;
  const flag = !isFloor && !unfloored && mTs > 2 && mNat > 0.05 && mTs / mNat > 3;

  console.log(
    `  ${name.padEnd(32)} ${t.ms.toFixed(2).padStart(7)} ${n.ms.toFixed(2).padStart(7)} ${`${(t.ms / Math.max(n.ms, 0.001)).toFixed(1)}x`.padStart(7)}  ${marginal.padStart(20)}${flag ? '  <-- FLAG' : ''}`,
  );
}

natGraph.free();
console.log(
  `\n  ⚠️ THE RAW RATIO IS MOSTLY THE SCAN FLOOR (item 2167: 4.29 ms against 0.09, 48x). A FLAG means the\n` +
    `  STEP's own marginal cost is over 3x native's and over 2 ms — that is what a change can reach.\n`,
);
