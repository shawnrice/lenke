/**
 * ⚠️⚠️ **THE GREMLIN SURFACE HAS NEVER BEEN TIMED AGAINST THE NATIVE ENGINE (item 2241).**
 * `bench-gremlin.ts` is TS-only, so every Gremlin number this session trusted was TS-vs-a-hand-rolled-floor.
 * Item 2240 left the question of whether a FAIR comparison is even constructible open; `gremlin-fuzz.test.ts`
 * settles it — **`planToGremlin` renders a programmatic plan to text**, so one plan can drive both engines.
 *
 * 🔑 **THREE THINGS THIS INSTRUMENT DOES THAT THE GQL BENCH DOES NOT (item 2236):**
 *
 * 1. **IT COMPARES THE ANSWERS.** `bench.ts` discards every result (`void e.query(...)`), so none of its
 *    ratios prove the engines did the same work. Here a mismatch is printed loudly and counted.
 * 2. **IT PRICES THE NATIVE ARM'S HANDICAP.** The TS arm runs a plan; the native arm must PARSE rendered
 *    text first. That is not a like-for-like step, so `g.V().count()` is timed as a parse/fixed-cost floor
 *    and reported alongside — a ratio smaller than that floor is not a measurement.
 * 3. **IT SWEEPS THE SIZE.** Item 2236 found the GQL ratio growing 3.1x -> 16.1x purely because the native
 *    fixed cost amortizes. A one-size Gremlin ratio would mislead the same way.
 *
 * ⚠️ Row ORDER is not compared — unordered order is unspecified, and comparing it would be a false alarm.
 */
import { Graph as TsGraph } from '@lenke/core';
import {
  V,
  count,
  groupCount,
  has,
  hasLabel,
  out,
  planToGremlin,
  toArray,
  traversal,
  values,
  type Plan,
} from '@lenke/gremlin';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './src/backend-ffi-engine.js';

const N = Number(process.env.N ?? 20000);
const REPS = Number(process.env.REPS ?? 7);

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB = new URL(
  `../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXTENSIONS[process.platform] ?? 'so'}`,
  import.meta.url,
).pathname;

/* ⚠️ FANOUT > 1 must split on the REPEAT INDEX or one vertex's whole fan-out lands on ONE target and every
 * degree check still looks perfect (the recorded generator defect). */
const doc = (() => {
  const lines = Array.from(
    { length: N },
    (_, i) =>
      `{"type":"node","id":"v${i}","labels":["User"],"properties":{"team":${i % 97},"age":${i % 90}}}`,
  );
  let id = 0;

  for (let d = 0; d < 4; d += 1) {
    for (let i = 0; i < N; i += 1) {
      lines.push(
        `{"type":"edge","id":"e${id++}","labels":["E"],"from":"v${i}","to":"v${(i * 7 + 3 + d * 104_729) % N}","properties":{}}`,
      );
    }
  }

  return lines.join('\n');
})();

/*
 * ⚠️⚠️ **A LARGE RESULT SET MAKES THIS A MARSHALLING BENCHMARK, NOT AN ENGINE ONE.** The native arm
 * serializes every row to JSON and this side parses it back, so `values hop hop` (320,000 values) priced
 * the FFI boundary and reported TS "winning" 0.42x. That is not an engine comparison, so such rows are
 * marked `[BOUNDARY]` and must not be read as one. Only small-result shapes (the counts, a groupCount over
 * few groups) compare the engines.
 */
const SHAPES: Array<[string, Plan]> = [
  ['parse floor V().count()', traversal(V(), count())],
  ['count hop', traversal(V(), hasLabel('User'), out('E'), count())],
  ['count hop + far has', traversal(V(), hasLabel('User'), out('E'), has('team', 7), count())],
  ['values groupCount', traversal(V(), hasLabel('User'), values('team'), groupCount())],
  /*
   * 🔑🔑 **REAL WORK, ONE ROW — WHERE AN ENGINE COMPARISON ACTUALLY LIVES (item 2242).** The rows above
   * are engine-bound but TINY in absolute terms: `count hop` is a DEGREE-SUM CLOSED FORM at ~10 us, so its
   * 5.25x is ~8 us of difference and means nothing. The `[BOUNDARY]` rows below have real work but their
   * result set prices the FFI boundary instead. ⚠️ **Both failure modes are avoided by a shape that walks a
   * lot and returns ONE row** — a filtered multi-hop count. These are the finder's own heavy shapes.
   */
  ['count hop hop', traversal(V(), hasLabel('User'), out('E'), out('E'), count())],
  [
    'count hop hop + trailing has',
    traversal(V(), hasLabel('User'), out('E'), out('E'), has('team', 7), count()),
  ],
  [
    'count hop + mid has + hop',
    traversal(V(), hasLabel('User'), out('E'), has('team', 7), out('E'), count()),
  ],
  ['[BOUNDARY] values hop', traversal(V(), hasLabel('User'), out('E'), values('team'))],
  [
    '[BOUNDARY] values hop hop',
    traversal(V(), hasLabel('User'), out('E'), out('E'), values('team')),
  ],
];

/**
 * Row count plus an order-insensitive hash — enough to catch a decline or a wrong answer.
 *
 * ⚠️⚠️ **`JSON.stringify` IS NOT ENOUGH, AND THIS INSTRUMENT GOT IT WRONG ON ITS FIRST RUN.**
 * `JSON.stringify(new Map([[0, 2]]))` is `"{}"`, so every `groupCount()` row hashed to the SAME value and
 * the checker reported a DIVERGENCE that did not exist (ts `Map(3){0=>2,1=>2,2=>2}` against ffi
 * `{"0":2,"1":2,"2":2}` — the same answer). A blind spot of exactly the kind the checker exists to catch.
 *
 * 🔑 So Maps are walked explicitly, and an ELEMENT used as a group key is reduced to its id: keying
 * `groupCount()` on vertices renders as `Vertex (v0) {}` in TS and as the id in the native engine — the two
 * format elements differently BY DESIGN (`gremlin-fuzz.test.ts` says so), and that is not a divergence.
 */
const entries = (pairs: Array<[unknown, unknown]>): string =>
  `{${pairs
    .map(
      ([k, n]) =>
        `${k instanceof Map || (k !== null && typeof k === 'object') ? canon(k) : String(k)}=>${canon(n)}`,
    )
    .sort()
    .join(',')}}`;

const canon = (v: unknown): string => {
  if (v instanceof Map) {
    return entries([...v]);
  }

  if (v !== null && typeof v === 'object' && 'id' in v) {
    return `el(${String(v.id)})`;
  }

  /*
   * ⚠️ A GROUP MAP CROSSES THE FFI AS A PLAIN JSON OBJECT, SO ITS KEYS ARE STRINGS. A `Map` keyed on the
   * NUMBER 0 and an object keyed on `"0"` are the same answer; comparing their renderings is not. Keys are
   * therefore stringified on BOTH sides — the second false divergence this checker reported, after
   * `JSON.stringify(Map)` being `"{}"`.
   */
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return entries(Object.entries(v as Record<string, unknown>));
  }

  return JSON.stringify(v) ?? 'null';
};

const summarize = (rows: unknown[]): string => {
  const parts = rows.map(canon).sort();
  let h = 0;

  for (const s of parts) {
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }

  return `n=${String(rows.length).padStart(7)} h=${String(h).padStart(12)}`;
};

/** Median of the post-warm-up reps — `min` estimates a plateau-plus-rare-fast-rep path differently. */
const timeIt = (fn: () => void): number => {
  const series: number[] = [];

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    fn();
    series.push(performance.now() - t);
  }

  const warm = series.slice(2).sort((a, b) => a - b);

  return warm[Math.floor(warm.length / 2)] ?? 0;
};

const backend = createFfiEngineBackend(LIB);
const tsGraph = tsDeserialize(doc, 'ndjson', new TsGraph());
const handle = backend.graphFromNdjson(new TextEncoder().encode(doc));
const decoder = new TextDecoder();

console.log(`  N=${N} vertices, ${N * 4} edges, REPS=${REPS}\n`);
console.log(
  `  ${'shape'.padEnd(26)} ${'ts ms'.padStart(9)} ${'ffi ms'.padStart(9)}  ratio  answers`,
);

let diverged = 0;

for (const [name, plan] of SHAPES) {
  const text = planToGremlin(plan);
  const runTs = (): unknown[] => toArray(plan, tsGraph);
  const runFfi = (): unknown[] =>
    JSON.parse(decoder.decode(backend.gremlinJson(handle, text))) as unknown[];

  const a = summarize(runTs());
  const b = summarize(runFfi());
  const same = a === b;

  if (!same) {
    diverged += 1;
  }

  const ts = timeIt(() => void runTs());
  const ffi = timeIt(() => void runFfi());

  console.log(
    `  ${name.padEnd(26)} ${ts.toFixed(2).padStart(9)} ${ffi.toFixed(2).padStart(9)}  ${(ts / ffi).toFixed(2)}x  ${same ? 'AGREE' : `*** DIVERGE *** ts ${a} | ffi ${b}`}`,
  );
}

backend.graphFree(handle);
console.log(`\n  divergences: ${diverged}`);
