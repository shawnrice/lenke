/**
 * Item 889: what is case-normalization during PARSE worth? Answer: not enough. This probe is the
 * evidence for a rejected optimization, kept so it is not re-attempted.
 *
 * Item 888 removed `toLowerCase()` from the lexer's keyword lookup for 1.08-1.14x, and the same
 * pattern is all over the parser — `peek().value.toLowerCase() === word` in several predicates,
 * and `isReserved`, which is `RESERVED.has(word.toLowerCase())`. Attributing the calls made by one
 * `big` parse (a stub that records its caller) says where they come from:
 *
 *     15  isReserved (lexer.ts)
 *      7  parser.ts:2177
 *      7  parser.ts:2318
 *      7  parser.ts:512   (valueSubqueryAhead)
 *      3  tokenize        (the mixed/all-caps non-keyword identifiers item 888 left paying)
 *      1  parser.ts:2553
 *     40  total, 37 of them in the descent
 *
 * So the shape repeats and the call count is comparable to the lexer's. The ceiling says the COST
 * does not repeat.
 *
 * THE INSTRUMENT'S ONE IDEA. A stubbed prototype method is slower than the intrinsic, so comparing
 * "stubbed identity" against "no stub" would charge the ablated arm for the stub and understate the
 * win. BOTH arms therefore install a stub of the same shape and the same call cost — `through`
 * calls the original, `identity` returns the receiver — so the call overhead cancels and the only
 * difference is whether the lowercasing work happens. `identity` is DELIBERATELY WRONG (every
 * case-insensitive comparison becomes case-sensitive); it is an upper bound, not a candidate.
 *
 * A DOSE-RESPONSE LADDER instead of one arm plus one control, because an effect this small is
 * easier to believe when it scales with the dose. Three shapes making 0, 9 and 40 calls: the
 * 0-call shape is a true control the ablation cannot reach, and if it moves the instrument is
 * lying. Call counts are PRINTED, not assumed — the first version of this probe claimed a shape
 * made zero calls when it made nine.
 */
import { parse } from '@lenke/gql';

const REPS = 14;
const DROP = 3;
const OPS = Number(process.env.A_OPS ?? 20_000);

const SHAPES: Array<[string, (i: number) => string]> = [
  // Zero normalization calls: the control.
  ['zero', (i) => `RETURN ${i % 97}`],
  ['nine', (i) => `match (n) where n.k > ${i % 9} return n`],
  [
    'forty',
    (i) =>
      `MATCH (a:User)-[:KNOWS]->(b:User) WHERE a.score > ${i % 50} AND b.name <> 'x${i}' ` +
      `AND a.seq >= ${i % 7} RETURN a.name AS an, b.name AS bn, a.score AS s ORDER BY s DESC LIMIT 10`,
  ],
];

// Captured EAGERLY as a function value. Item 888: wrapping this in an arrow that dereferences
// `String.prototype.toLowerCase` at call time reads back the stub installed below and recurses
// forever.
// eslint-disable-next-line typescript/unbound-method -- always invoked via .call with an explicit receiver
const ORIGINAL = String.prototype.toLowerCase;

const countCalls = (text: (i: number) => string): number => {
  let calls = 0;

  // eslint-disable-next-line func-names, no-extend-native -- restored in the finally
  String.prototype.toLowerCase = function (this: string): string {
    calls += 1;

    return ORIGINAL.call(this);
  };

  try {
    parse(text(1));
  } finally {
    // eslint-disable-next-line no-extend-native -- restoring the line above
    String.prototype.toLowerCase = ORIGINAL;
  }

  return calls;
};

const run = (text: (i: number) => string, mode: 'through' | 'identity'): number => {
  const stub =
    mode === 'through'
      ? // eslint-disable-next-line func-names
        function (this: string): string {
          return ORIGINAL.call(this);
        }
      : // eslint-disable-next-line func-names
        function (this: string): string {
          return this;
        };

  // eslint-disable-next-line no-extend-native -- restored in the finally
  String.prototype.toLowerCase = stub;

  const series: number[] = [];
  let sink = 0;

  try {
    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();

      for (let i = 0; i < OPS; i += 1) {
        sink += parse(text(i)) === undefined ? 0 : 1;
      }

      series.push(performance.now() - t0);
    }
  } finally {
    // eslint-disable-next-line no-extend-native -- restoring the line above
    String.prototype.toLowerCase = ORIGINAL;
  }

  if (sink === 0) {
    throw new Error(`arm ${mode} parsed nothing — do not read this as fast`);
  }

  const plateau = series.slice(DROP).sort((a, b) => a - b);

  return (plateau[Math.floor(plateau.length / 2)] * 1000) / OPS;
};

console.log(`# item 889 — the normalization ceiling during parse, median of ${REPS - DROP}\n`);

const counts = new Map(SHAPES.map(([name, text]) => [name, countCalls(text)]));

for (const [name, text] of SHAPES) {
  console.log(
    `${name.padEnd(6)} ${String(counts.get(name)).padStart(3)} toLowerCase calls per parse  (${text(1).length} chars)`,
  );
}

const out: Record<string, number> = {};

for (const pass of [0, 1]) {
  const modes: Array<'through' | 'identity'> =
    pass === 0 ? ['through', 'identity'] : ['identity', 'through'];

  for (const mode of modes) {
    for (const [name, text] of SHAPES) {
      const key = `${name}:${mode}`;
      const us = run(text, mode);

      out[key] = out[key] === undefined ? us : Math.min(out[key], us);
    }
  }
}

console.log('');

for (const [name] of SHAPES) {
  const t = out[`${name}:through`];
  const id = out[`${name}:identity`];

  console.log(
    `${name.padEnd(6)} calls ${String(counts.get(name)).padStart(3)}  through ${t.toFixed(3).padStart(8)}  identity ${id.toFixed(3).padStart(8)}  ceiling ${(t / id).toFixed(3)}x`,
  );
}
