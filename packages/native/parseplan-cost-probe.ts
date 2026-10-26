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

// ITEM 884: is the parse cost FIXED or proportional to the input? `parse()` allocates 96 closures
// (counted) before it consumes a token, so a tiny statement should cost nearly what a big one does
// if that fixed setup dominates. Three sizes, each parsed with a FRESH text so no cache can serve
// it, and the per-CHARACTER figure printed alongside.
const TINY = 'MATCH (n) RETURN n';
const big = (i: number): string =>
  `MATCH (a:User)-[:KNOWS]->(b:User) WHERE a.score > ${i % 50} AND b.name <> 'x${i}' ` +
  `AND a.seq >= ${i % 7} RETURN a.name AS an, b.name AS bn, a.score AS s ORDER BY s DESC LIMIT 10`;

ARMS.parseTiny = (n) => {
  let sink = 0;

  for (let i = 0; i < n; i += 1) {
    // a fresh text of the SAME length, so this is a miss of a short statement
    sink += parse(`MATCH (n) RETURN n /*${i}*/`) === undefined ? 0 : 1;
  }

  return sink;
};
ARMS.parseTinyFixed = (n) => {
  let sink = 0;

  for (let i = 0; i < n; i += 1) {
    sink += parse(TINY) === undefined ? 0 : 1;
  }

  return sink;
};
ARMS.parseBig = (n) => {
  let sink = 0;

  for (let i = 0; i < n; i += 1) {
    sink += parse(big(i)) === undefined ? 0 : 1;
  }

  return sink;
};
// ITEM 885: the fix the slope pointed at, measured on these arms. The tokenizer declared its
// two operator tables (8 keys and 20 keys) as object literals INSIDE the per-character loop, so
// it allocated two objects for every character of query text, and it built a 2-character
// lookahead string for every character whether or not one could start a multi-char token.
// Hoisting the tables to module scope and gating the lookahead on the six characters that can
// begin a multi-character token, min of three ORDER-ALTERNATED rounds, 20k ops:
//
//     arm         chars     pre      post     ratio
//     parseTiny      24    1.781    1.546     1.15x
//     parseOnly      47    3.393    2.433     1.39x
//     parseBig      158   10.547    7.230     1.46x
//     textOnly        -    0.023    0.023     flat  (the control: it never calls parse)
//
// The win GROWS with input size, which is the signature of a per-character fix and is why the
// slope was worth measuring first. Refitting: 64.2 -> 42.4 ns/char marginal, so the gap to
// native's 22.4 closes from 2.9x to 1.9x. The remaining 20 ns a character is still the target.
//
// Each arm asserted itself two ways before running: the source's TWO_CHAR count (pre 0, post 4)
// and the built bundle's sha256, which had to DIFFER between arms and match within one —
// identifiers are minified, so the source grep alone cannot see whether the build picked it up.
// ITEM 886: a STRING-HEAVY arm. The census in lexer-census-probe.ts puts string-literal
// characters at 3-12% of the arms above but 49.7% of ordinary application query text, so a change
// to the string scanner is invisible here without a fixture that actually contains strings. This
// is that fixture, and it doubles as the arm the identifier change reaches LEAST (32.9% ident
// against big's 60%), so the two arms move for different reasons.
ARMS.parseStrHeavy = (n) => {
  let sink = 0;

  for (let i = 0; i < n; i += 1) {
    sink +=
      parse(
        `MATCH (p:Person) WHERE p.name = 'Alexandra Whitfield${i}' OR p.city = 'San Francisco Bay Area' ` +
          `OR p.title = 'Senior Staff Software Engineer' RETURN p.name AS n`,
      ) === undefined
        ? 0
        : 1;
  }

  return sink;
};

// ITEM 886 RESULT, measured on these arms, min of three ORDER-ALTERNATED rounds at 20k ops.
// Two changes with deliberately different reach — identifier scanning moved to `charCodeAt`, and
// a string literal with no escape in it is now one `slice` instead of a per-character append:
//
//     arm             ident%  str%      pre     post    ratio
//     parseTiny           52     0    1.578    1.415    1.12x
//     parseOnly           46    12    2.432    2.196    1.11x
//     parseBig            60   3.1    7.337    6.232    1.18x
//     parseStrHeavy       33  49.7    4.071    3.332    1.22x
//     textOnly             -     -    0.022    0.022    1.00x  (the control)
//
// The two arms move for DIFFERENT reasons, which is what makes this two findings and not one:
// `parseStrHeavy` has the LEAST identifier share and gains the MOST, so that is the string
// change; `parseBig` is 60% identifier characters and 3% string, so its 1.18x is the scanner.
// Slope refits 42.4 -> 35.9 ns/char, and cumulatively since item 884, 64.2 -> 35.9 (parseBig
// 10.547 -> 6.232, 1.69x). The gap to native's 22.4 ns/char is now 1.6x, from 2.9x.
// ITEM 888 RESULT. Keywords now resolve WITHOUT normalizing every identifier: an identifier with
// no uppercase letter already is its own lowercasing, so one set lookup settles it; an all-caps
// one is settled by a map lookup; only a mixed-case word normalizes. Min of three
// ORDER-ALTERNATED rounds:
//
//     arm                  pre     post    ratio
//     parseTiny          1.514    1.329    1.14x
//     parseOnly          2.279    2.108    1.08x
//     parseBig           6.301    5.712    1.10x
//     parseStrHeavy      3.334    2.999    1.11x
//     textOnly           0.022    0.022    1.00x  (the control)
//
// The target was chosen by a CEILING ABLATION first: replacing `toLowerCase()` with the identity
// (deliberately wrong — lowercase keywords stop being recognized) bounded the whole idea at
// 1.24-1.26x of the tokenizer, and the same ablation priced the token object at only 1.03-1.07x,
// which killed that second idea without an implementation being written. On the tokenizer's own
// instrument this change captured roughly half the ablation's ceiling.
ARMS.sizes = () => {
  console.log(
    `  lengths: tiny=${TINY.length} insert=${freshText(1).length} big=${big(1).length} chars`,
  );

  return 1;
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
