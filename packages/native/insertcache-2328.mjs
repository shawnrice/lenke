/**
 * ⚠️⚠️ **WHY IS A LITERAL `INSERT` 2.17x SLOWER THAN A PARAMETERIZED ONE? (item 2328)**
 *
 * `bun run bench:usage` reports `write: append node` at 345.7k ops/s and `write: append node [params]` at
 * 750.6k. 🔑 The literal row interpolates `i` into the query TEXT, so every call has a different text; the
 * params row reuses one text. **But `normalizeLiterals` exists exactly so a literal-bearing text can still
 * hit the parse cache** (item 2271 raised `PARSE_CACHE_CAP` to 512 for 3-4x on multi-statement sessions).
 *
 * ✅ So there are two possibilities and `parseCacheStats()` distinguishes them directly rather than by
 * inference: **either the cache is MISSING on every literal call** (normalization is not reached on this
 * path), **or it is HITTING and the 2.17x is the normalization work itself.** Those have opposite fixes, so
 * guessing would be the expensive path — mechanism guesses have been punished repeatedly this session.
 */
import { Graph } from '@lenke/core';
import { parseCacheStats, query } from '@lenke/gql';

const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 60);
const ROUNDS = Number(process.env.ROUNDS ?? 7);
const ARM = process.env.ARM ?? 'literal';

/*
 * ⚠️ A FRESH GRAPH PER TIMED BLOCK, because every arm GROWS the graph — `grows: true` in the bench row.
 * Reusing one graph would make later reps insert into a larger graph than earlier ones and confound the
 * arm with |V|.
 */
let seq = 0;

const ARMS = {
  /* ⚠️ A DIFFERENT TEXT EVERY CALL — the bench's literal row. */
  literal: (g, i) => {
    /*
     * ⚠️ THE INTERPOLATION IS THE SUBJECT OF THIS PROBE, so the rule has to be suppressed here — and it
     * is worth recording that **the repo already lints against this pattern**: `lenke/no-raw-interpolation`
     * forbids it for INJECTION reasons, and it happens to prevent the 2.02x cache cost too. The bench row
     * being reproduced predates the rule.
     */
    // eslint-disable-next-line lenke/no-raw-interpolation -- this probe exists to measure the interpolated form
    query(g, `INSERT (:Event {name: 'ev${i}', score: ${i % 100}, seq: ${i}})`);
  },
  /* ✅ ONE text, values bound — the bench's params row. */
  params: (g, i) => {
    query(g, 'INSERT (:Event {name: $n, score: $s, seq: $q})', {
      n: `evp${i}`,
      s: i % 100,
      q: i,
    });
  },
  /*
   * ✅ THE DISCRIMINATING ARM: one FIXED literal text, repeated. If the literal cost were normalization
   * work, this would be as slow as `literal`; if it is cache misses, this is as fast as `params`.
   */
  fixedLiteral: (g) => {
    query(g, "INSERT (:Event {name: 'fixed', score: 7, seq: 1})");
  },
};

/*
 * ⚠️⚠️ **THE EVICTION HARM IS THE REAL QUESTION, AND IT NEEDS A MIXED WORKLOAD (item 2328).** A new text
 * MUST be parsed — that cost is unavoidable and no admission policy recovers it. 🔑 What an admission
 * filter recovers is what the single-use STORE does to OTHER queries' entries: 2000 stores into a
 * 512-entry cache wipe it four times over. ✅ So the measurement that matters is a HOT query's cost alone
 * versus the same query interleaved with literal spam. The Rust engine already ships a "second sighting"
 * filter for this hazard (it had made a cache 1.16x WORSE on an all-miss path); whether the TS side needs
 * one is this measurement, not an argument from the Rust item.
 */
ARMS.hotAlone = (g, i) => {
  query(g, 'MATCH (e:Event) WHERE e.seq = $q RETURN count(*) AS c', { q: i % 97 });
};

ARMS.hotWithSpam = (g, i) => {
  query(g, 'MATCH (e:Event) WHERE e.seq = $q RETURN count(*) AS c', { q: i % 97 });
  /* ⚠️ One single-use text per hot query — a caller interpolating a value into its text. */
  // eslint-disable-next-line lenke/no-raw-interpolation -- the single-use text is what this arm measures
  query(g, `MATCH (e:Event) WHERE e.seq = ${i} RETURN count(*) AS c`);
};

/*
 * ⚠️⚠️ **THE WORK CONTROL, AND IT IS THE WHOLE COMPARISON.** `hotWithSpam` issues TWO queries an op and
 * `hotAlone` ONE, so comparing them directly measures mostly the second query — the arm-length error item
 * 2326 corrected one tick earlier. ✅ `hotWithFixed` issues TWO queries an op where BOTH texts are
 * cacheable, so `hotWithSpam` against `hotWithFixed` isolates exactly what a SINGLE-USE text costs: its
 * parse, its store, and whatever its store does to the other entry.
 */
ARMS.hotWithFixed = (g, i) => {
  query(g, 'MATCH (e:Event) WHERE e.seq = $q RETURN count(*) AS c', { q: i % 97 });
  /*
   * ⚠️ **THE SECOND TEXT MUST DO THE SAME WORK, NOT MERELY BE A SECOND TEXT.** The first version seeked
   * `e.score`, which is NOT indexed in this fixture — so it scanned 20,000 rows and the "control" came
   * out 50x SLOWER than the arm it was controlling for. ✅ Seeking the SAME indexed key with a different
   * ALIAS gives a distinct cacheable text and identical work, which is the only fair comparison.
   */
  query(g, 'MATCH (e:Event) WHERE e.seq = $q RETURN count(*) AS n', { q: i % 97 });
};

const arm = ARMS[ARM];

/*
 * ⚠️ THE HOT ARMS READ, so they need a POPULATED graph — a fresh empty one per block would measure a
 * seek over nothing. The write arms still get a fresh graph because they GROW it.
 */
const seeded = (() => {
  const g = new Graph();

  for (let i = 0; i < 20_000; i += 1) {
    g.addVertex({ id: `s${i}`, labels: ['Event'], properties: { seq: i % 97, score: i % 100 } });
  }

  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['seq'] });

  return g;
})();

const block = (n) => {
  const g = ARM.startsWith('hot') ? seeded : new Graph();

  for (let i = 0; i < n; i += 1) {
    arm(g, seq++);
  }
};

block(500);

const before = parseCacheStats();

block(2000);

const after = parseCacheStats();
const delta = {};

for (const k of Object.keys(after)) {
  delta[k] = typeof after[k] === 'number' ? after[k] - (before[k] ?? 0) : after[k];
}

let inner = 64;

for (;;) {
  const t0 = performance.now();

  block(inner);

  if (performance.now() - t0 >= SAMPLE_MS || inner >= 100_000) {
    break;
  }

  inner *= 2;
}

const ts = [];

for (let r = 0; r < ROUNDS; r += 1) {
  const t0 = performance.now();

  block(inner);

  ts.push((performance.now() - t0) / inner);
}

const sorted = [...ts].sort((a, b) => a - b);
const med = sorted[Math.floor(sorted.length / 2)];

console.log(
  `  ARM=${ARM.padEnd(13)} ${(med * 1000).toFixed(0).padStart(6)} ns/op  ops/s=${Math.round(
    1000 / med,
  )
    .toLocaleString()
    .padStart(11)}  cacheDelta over 2000 ops: ${JSON.stringify(delta)}`,
);
