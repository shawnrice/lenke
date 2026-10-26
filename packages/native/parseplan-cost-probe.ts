/**
 * Item 883: what does a parse+plan CACHE MISS cost the TS engine?
 *
 * `bun run bench:usage` has two spellings of one write, and the gap between them is a cache miss
 * per operation — the unparameterized row interpolates `i` into the query text, so every call is a
 * new string (the bench's own note, item 662). Per operation:
 *
 *   TS   `INSERT (:Event {name: 'ev123', ...})`   7.66 us    (130.6k ops/s) — misses every time
 *   TS   `INSERT (:Event {name: $n, ...})`        1.73       (579.1k)       — hits
 *   native, either spelling                       2.18-2.24  (446-459k)     — FLAT
 *
 * So TS pays ~5.9 us for a miss where native's is invisible, and TS with a HIT is faster than
 * native. Dynamically-built query text is ordinary application code, so the miss is worth pricing
 * rather than dismissing as a benchmark artifact.
 *
 * The arms separate parse from plan from execute, all on the same statement:
 *   parseOnly    — `parse(text)` with a FRESH text each call, so the cache cannot serve it
 *   parseOneText  — `parse(text)` with ONE text. Written as "parseCached" expecting the cache to
 *                   serve it; it does not, because the exported `parse` bypasses the cache — which
 *                   is itself a finding and is why the arm keeps its corrected name.
 *   compileOnly  — parse + `compile`, the planning half on top
 *   fullMiss     — `query()` end to end with a fresh text: the bench's slow row
 *   fullHit      — `query()` with params and one text: the bench's fast row
 *
 * Every arm reports ROWS or a sink so an arm that silently did nothing is visible.
 */
import { Graph } from '@lenke/core';
import { compile, parse, query } from '@lenke/gql';

const REPS = 9;
const DROP = 2;
const OPS = Number(process.env.A_OPS ?? 20_000);

const g = new Graph();

for (let i = 0; i < 2_000; i += 1) {
  g.addVertex({ id: `u${i}`, labels: ['User'], properties: { name: `n${i}`, score: i % 100 } });
}

// A fresh text per call is the whole point of the miss arms: the cache is keyed on the text.
const freshText = (i: number): string =>
  `INSERT (:Event {name: 'ev${i}', score: ${i % 100}, seq: ${i}})`;
const ONE_TEXT = "INSERT (:Event {name: 'evFIXED', score: 7, seq: 1})";
const PARAM_TEXT = 'INSERT (:Event {name: $n, score: $s, seq: $q})';

const ARMS: Record<string, (n: number) => number> = {
  parseOnly: (n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      sink += parse(freshText(i)) === undefined ? 0 : 1;
    }

    return sink;
  },
  // MISNAMED WHEN WRITTEN, and the measurement is what corrected it: the exported `parse()` does
  // NOT consult the cache — that lives inside `query()` — so this arm costs the same as a fresh
  // text (2.969 against 3.486 us) and is a ONE-TEXT raw parse, not a cached one. Kept under the
  // honest name.
  parseOneText: (n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      sink += parse(ONE_TEXT) === undefined ? 0 : 1;
    }

    return sink;
  },
  compileOnly: (n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      // `parse` returns a `Statement` and `compile` takes a `Query`; for this INSERT they are
      // the same node and the cast is the probe admitting it rather than reaching for a
      // different entry point that would measure something else.
      sink += compile(parse(freshText(i)) as never) === undefined ? 0 : 1;
    }

    return sink;
  },
  // The two bench rows, reproduced here so the decomposition and the thing being decomposed are
  // measured by one instrument.
  fullMiss: (n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      sink += [...query(g, freshText(i))].length + 1;
    }

    return sink;
  },
  fullHit: (n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      sink += [...query(g, PARAM_TEXT, { n: `evp${i}`, s: i % 100, q: i })].length + 1;
    }

    return sink;
  },
  // A text-building control: the interpolation itself, with no engine work at all. If this is
  // large the miss arms are measuring string formatting rather than the parser.
  textOnly: (n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      sink += freshText(i).length;
    }

    return sink;
  },
};

const arm = process.env.A_ARM ?? 'parseOnly';
const fn = ARMS[arm];

if (fn === undefined) {
  throw new Error(`unknown A_ARM ${arm}; have ${Object.keys(ARMS).join(',')}`);
}

const series: number[] = [];
let sink = 0;

for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();

  sink += fn(OPS);
  series.push(performance.now() - t0);
}

const plateau = series.slice(DROP).sort((a, b) => a - b);
const median = plateau[Math.floor(plateau.length / 2)];

console.log(
  `${arm.padEnd(12)} ${((median * 1000) / OPS).toFixed(3).padStart(9)} us/op  ${median.toFixed(1).padStart(8)} ms  ${sink > 0 ? 'ok' : 'ZERO'}`,
);
