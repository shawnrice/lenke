// Deliberate source reach-in, and the only way to ask this question: `tokenize` is NOT part of
// `@lenke/gql`'s public entry point and should not become so for a probe's sake. Both halves must
// also come from ONE compilation to be comparable — taking `parse` from the built package and
// `tokenize` from source would measure the difference between two builds instead.
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- see above
import { tokenize } from '../gql/src/lexer.ts';
/**
 * Item 887: of the TS parser's 35.9 ns a character, how much is the TOKENIZER and how much is the
 * recursive descent above it?
 *
 * Items 885 and 886 both changed the tokenizer, on the reasoning that per-character cost must live
 * in a per-character loop. Both won (1.46x, then 1.18-1.22x), but neither measured how much of the
 * total the tokenizer IS — so "keep going in the tokenizer" has been an assumption for two ticks.
 * Item 886 left the remaining ~13 ns/char over native explicitly unpriced. This splits it.
 *
 * TWO NOTES ON WHAT THESE NUMBERS MAY BE COMPARED WITH.
 *
 * 1. `tokenize` is NOT exported from `@lenke/gql`, so both halves are imported from `src` rather
 *    than the built `dist` that `parseplan-cost-probe.ts` uses. A src build and a bundled build are
 *    not the same compilation, so **these figures are comparable with EACH OTHER and not with that
 *    probe's**. The ratio between the two arms here is the finding; the absolute us/op is not.
 * 2. `parseFull` CONTAINS `tokenizeOnly` — it tokenizes and then parses. So the parser's own share
 *    is the DIFFERENCE, and a prefix of a pipeline is not a cost floor for it (item 880).
 *
 * The control is `textOnly`: it builds the same string and touches neither half.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- same compilation as the lexer import above
import { parse } from '../gql/src/parser.ts';

const REPS = 14;
const DROP = 3;
const OPS = Number(process.env.A_OPS ?? 20_000);

// The same three sizes items 884-886 used, plus the string-heavy shape item 886 added, so the
// split can be read per shape rather than assumed uniform.
const TEXTS: Record<string, (i: number) => string> = {
  tiny: (i) => `MATCH (n) RETURN n /*${i}*/`,
  insert: (i) => `INSERT (:Event {name: 'ev${i}', score: ${i % 100}, seq: ${i}})`,
  big: (i) =>
    `MATCH (a:User)-[:KNOWS]->(b:User) WHERE a.score > ${i % 50} AND b.name <> 'x${i}' ` +
    `AND a.seq >= ${i % 7} RETURN a.name AS an, b.name AS bn, a.score AS s ORDER BY s DESC LIMIT 10`,
  strheavy: (i) =>
    `MATCH (p:Person) WHERE p.name = 'Alexandra Whitfield${i}' OR p.city = 'San Francisco Bay Area' ` +
    `OR p.title = 'Senior Staff Software Engineer' RETURN p.name AS n`,
};

type Arm = (text: (i: number) => string, n: number) => number;

const ARMS: Record<string, Arm> = {
  tokenizeOnly: (text, n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      sink += tokenize(text(i)).length;
    }

    return sink;
  },
  parseFull: (text, n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      sink += parse(text(i)) === undefined ? 0 : 1;
    }

    return sink;
  },
  textOnly: (text, n) => {
    let sink = 0;

    for (let i = 0; i < n; i += 1) {
      sink += text(i).length;
    }

    return sink;
  },
};

// Item 884's estimator rule for the TS per-row path: the general path plateaus high and emits a
// rare fast rep, so `min` estimates the two arms differently. 14 reps, drop the first three as
// visible JIT warm-up, take the MEDIAN of the rest.
const measure = (arm: Arm, text: (i: number) => string): { us: number; sink: number } => {
  const series: number[] = [];
  let sink = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    sink += arm(text, OPS);
    series.push(performance.now() - t0);
  }

  const plateau = series.slice(DROP).sort((a, b) => a - b);

  return { us: (plateau[Math.floor(plateau.length / 2)] * 1000) / OPS, sink };
};

const shape = process.env.A_SHAPE ?? 'big';
const text = TEXTS[shape];

if (text === undefined) {
  throw new Error(`unknown A_SHAPE ${shape}; have ${Object.keys(TEXTS).join(',')}`);
}

const chars = text(1).length;
// THE DENOMINATOR THAT ACTUALLY HOLDS (item 887). Reported in ns/TOKEN as well as ns/char,
// because across these four shapes ns/char spans 2.7x (21.6 to 58.3) while ns/token is flat at
// 106.6-116.2 for every shape big enough that fixed setup is not the whole story. Characters
// inside a string literal are now nearly free (item 886 made them one slice) but each identifier
// or punctuation character becomes a TOKEN, so two texts of the same length cost very differently.
const toks = tokenize(text(1)).length;

console.log(
  `# item 887 — tokenizer vs parser share, shape=${shape} (${chars} chars), median of ${REPS - DROP}\n`,
);

const results: Record<string, number> = {};

// ALTERNATED within the process, and each arm reports its sink so an arm that did nothing shows.
for (const name of ['tokenizeOnly', 'parseFull', 'textOnly', 'parseFull', 'tokenizeOnly']) {
  const { us, sink } = measure(ARMS[name], text);
  const prev = results[name];

  results[name] = prev === undefined ? us : Math.min(prev, us);
  console.log(
    `${name.padEnd(13)} ${us.toFixed(3).padStart(8)} us/op   ${sink > 0 ? 'ok' : 'ZERO'}`,
  );
}

const tok = results.tokenizeOnly;
const full = results.parseFull;
const descent = full - tok;

const row = (label: string, us: number, pct: string): string =>
  `${label.padEnd(13)} ${us.toFixed(3).padStart(8)} us  ${pct.padStart(6)}  ${((us * 1000) / chars).toFixed(1).padStart(5)} ns/char  ${((us * 1000) / toks).toFixed(1).padStart(6)} ns/token`;

console.log(`\n(${chars} chars, ${toks} tokens)`);
console.log(row('tokenize', tok, `${((tok / full) * 100).toFixed(1)}%`));
console.log(row('descent', descent, `${((descent / full) * 100).toFixed(1)}%`));
console.log(row('parse (total)', full, '100%'));
console.log(
  `control       ${results.textOnly.toFixed(3).padStart(8)} us  (builds the text, parses nothing)`,
);
