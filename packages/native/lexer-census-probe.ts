/**
 * Item 886: WHICH of the tokenizer's scanners carries the characters?
 *
 * Item 885 removed the per-character allocations that ran for EVERY character and took the TS
 * parser from 64.2 to 42.4 ns/char. The remaining ~20 ns over native's 22.4 is inside the
 * individual scanners, and they are not equal: a change to the string-literal scanner is worth
 * nothing if query text is 2% string literals.
 *
 * So this censuses the characters of the real fixture texts by the scanner that consumes them,
 * which is the "price the variants before picking one" step. It is a static count, not a timing —
 * the point is to choose the target, and the cost per character inside each scanner is then the
 * separate question.
 *
 * The classes mirror `tokenize`'s dispatch order:
 *   ws        — the whitespace fast path, 1 comparison chain, no allocation
 *   ident     — `isIdentStart` then a loop of `isIdentPart`, then a `slice` and a keyword lookup
 *   digit     — the number scanner
 *   strlit    — inside a quoted string: built with `str += src[i]`, ONE CHARACTER AT A TIME
 *   punct     — the SINGLE table, one lookup
 *   multi     — a 2- or 3-char operator, now gated by `startsMulti`
 */
const TEXTS: ReadonlyArray<readonly [string, string]> = [
  ['tiny', 'MATCH (n) RETURN n /*42*/'],
  ['insert', "INSERT (:Event {name: 'ev42', score: 42, seq: 42})"],
  [
    'big',
    `MATCH (a:User)-[:KNOWS]->(b:User) WHERE a.score > 25 AND b.name <> 'x42' ` +
      `AND a.seq >= 3 RETURN a.name AS an, b.name AS bn, a.score AS s ORDER BY s DESC LIMIT 10`,
  ],
  // A string-heavy shape, to show the strlit class is fixture-dependent and not negligible in
  // general: this is ordinary application query text.
  [
    'strheavy',
    `MATCH (p:Person) WHERE p.name = 'Alexandra Whitfield' OR p.city = 'San Francisco Bay Area' ` +
      `OR p.title = 'Senior Staff Software Engineer' RETURN p.name AS n`,
  ],
];

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

type Census = {
  ws: number;
  ident: number;
  digit: number;
  strlit: number;
  punct: number;
  multi: number;
  comment: number;
};

const census = (src: string): Census => {
  const out: Census = { ws: 0, ident: 0, digit: 0, strlit: 0, punct: 0, multi: 0, comment: 0 };
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      out.ws += 1;
      i += 1;
      continue;
    }

    const two = src.slice(i, i + 2);

    if (two === '//' || two === '--') {
      while (i < src.length && src[i] !== '\n') {
        out.comment += 1;
        i += 1;
      }

      continue;
    }

    if (two === '/*') {
      const start = i;

      i += 2;

      while (i < src.length && src.slice(i, i + 2) !== '*/') {
        i += 1;
      }

      i += 2;
      out.comment += i - start;
      continue;
    }

    if (c === "'" || c === '"') {
      const start = i;

      i += 1;

      while (i < src.length && src[i] !== c) {
        i += 1;
      }

      i += 1;
      out.strlit += i - start;
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;

      while (i < src.length && isIdentPart(src[i])) {
        i += 1;
      }

      out.ident += i - start;
      continue;
    }

    if (isDigit(c)) {
      const start = i;

      while (i < src.length && (isDigit(src[i]) || src[i] === '.')) {
        i += 1;
      }

      out.digit += i - start;
      continue;
    }

    // `<->`, then the two-char table's first characters, else single punctuation.
    if (src.slice(i, i + 3) === '<->') {
      out.multi += 3;
      i += 3;
      continue;
    }

    if (['->', '<-', '<~', '~>', '<>', '<=', '>=', '||'].includes(two)) {
      out.multi += 2;
      i += 2;
      continue;
    }

    out.punct += 1;
    i += 1;
  }

  return out;
};

const KEYS = ['ident', 'strlit', 'ws', 'punct', 'digit', 'multi', 'comment'] as const;

console.log('# item 886 — tokenizer character census, by consuming scanner\n');
console.log(
  `${'text'.padEnd(10)} ${'chars'.padStart(6)}  ${KEYS.map((k) => k.padStart(8)).join(' ')}`,
);

for (const [name, src] of TEXTS) {
  const c = census(src);
  const total = KEYS.reduce((a, k) => a + c[k], 0);

  if (total !== src.length) {
    throw new Error(`census lost characters for ${name}: ${total} vs ${src.length}`);
  }

  const pct = KEYS.map((k) => `${((c[k] / src.length) * 100).toFixed(1).padStart(7)}%`).join(' ');

  console.log(`${name.padEnd(10)} ${String(src.length).padStart(6)}  ${pct}`);
}

console.log('\n(every row re-sums to its own length, so no class is double-counted or dropped)');
